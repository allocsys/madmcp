import { describe, it, expect, vi, beforeEach } from "vitest";

// Covers the QStash worker endpoint itself
// (connectors/gemini/agent_worker.js): signature verification
// (fail-closed), idempotency (stepsDone/afterStep mismatch -> no-op),
// re-chaining on a successful-but-unfinished step, and dead-lettering after
// repeated same-step failures. Mirrors
// test/agent-delegate-async-checkpoint.test.js's fake-Redis approach so
// checkpoint state is exercised for real rather than mocked away.

function makeFakeRedis() {
  const lists = new Map();
  const strings = new Map();
  return {
    async rpush(key, ...vals) {
      const list = lists.get(key) || [];
      list.push(...vals);
      lists.set(key, list);
      return list.length;
    },
    async expire() { return 1; },
    async set(key, val) { strings.set(key, val); return "OK"; },
    async get(key) { return strings.has(key) ? strings.get(key) : null; },
    async lrange(key) { return lists.get(key) || []; },
    async del(key) { lists.delete(key); strings.delete(key); return 1; },
  };
}

const fakeRedis = makeFakeRedis();
vi.mock("../connectors/shared/cooldown.js", () => ({
  getRedis: () => fakeRedis,
  isRedisConfigured: () => true,
}));

const mockVerify = vi.fn();
const mockPublish = vi.fn();
vi.mock("../connectors/gemini/qstash_client.js", () => ({
  verifyQStashSignature: (...args) => mockVerify(...args),
  publishAgentStep: (...args) => mockPublish(...args),
}));

const mockProviderChat = vi.fn();
vi.mock("../connectors/llm/router.js", () => ({
  providerChat: mockProviderChat,
}));

const mockGithubRequest = vi.fn();
vi.mock("../connectors/github/client.js", () => ({
  githubRequest: mockGithubRequest,
}));

function makeReqRes({ body, signature = "sig", rawBody } = {}) {
  const req = {
    body,
    rawBody: rawBody ? Buffer.from(rawBody) : Buffer.from(JSON.stringify(body || {})),
    get: (name) => (name === "Upstash-Signature" ? signature : undefined),
  };
  const res = {
    statusCode: null,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
  return { req, res };
}

describe("agent_worker.js — handleAgentWorker", () => {
  let handleAgentWorker, seedRun, loadCheckpoint;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockVerify.mockResolvedValue(true);
    mockPublish.mockResolvedValue();
    ({ handleAgentWorker } = await import("../connectors/gemini/agent_worker.js"));
    ({ seedRun } = await import("../connectors/gemini/agent_delegate.js"));
    ({ loadCheckpoint } = await import("../connectors/gemini/agent_checkpoint.js"));
  });

  it("rejects a request with an invalid/missing QStash signature before touching any checkpoint", async () => {
    mockVerify.mockResolvedValue(false);
    const { req, res } = makeReqRes({ body: { runId: "does-not-matter", afterStep: 0 } });
    await handleAgentWorker(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockProviderChat).not.toHaveBeenCalled();
  });

  it("rejects a request missing runId", async () => {
    const { req, res } = makeReqRes({ body: { afterStep: 0 } });
    await handleAgentWorker(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("no-ops on a checkpoint that no longer exists (expired/unknown runId)", async () => {
    const { req, res } = makeReqRes({ body: { runId: "nonexistent-run", afterStep: 0 } });
    await handleAgentWorker(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
  });

  it("no-ops when afterStep no longer matches the live checkpoint's stepsDone (idempotent redelivery guard)", async () => {
    const runId = await seedRun({ task: "some task", provider: "gemini" });
    // Simulate the checkpoint having already advanced past what this
    // (stale/duplicate) message expects.
    mockGithubRequest.mockResolvedValue({ names: [] });
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
      finishReason: "STOP",
    });
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    await runInvestigation({ resume_run_id: runId, max_steps: 1, provider: "gemini" });

    const { req, res } = makeReqRes({ body: { runId, afterStep: 0 } }); // stale -- real stepsDone is now 1
    await handleAgentWorker(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
    // No re-chain should have been published for a no-op.
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("heartbeat write in agent_worker.js only happens inside the idempotency guard: a duplicate/late-arriving message with a stale afterStep does not update stepStartedAt", async () => {
    const runId = await seedRun({ task: "idempotency heartbeat test", provider: "gemini" });

    // Advance stepsDone to 1 so afterStep: 0 is stale
    mockGithubRequest.mockResolvedValue({ names: [] });
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
      finishReason: "STOP",
    });
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    await runInvestigation({ resume_run_id: runId, max_steps: 1, provider: "gemini" });

    const cpAdvanced = await loadCheckpoint(runId);
    expect(cpAdvanced.stepsDone).toBe(1);

    // Send late message with stale afterStep: 0
    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 } });
    await handleAgentWorker(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");

    const cpAfter = await loadCheckpoint(runId);
    // stepStartedAt should remain null/unset (not overwritten by the stale message)
    expect(cpAfter.stepStartedAt).toBeNull();
  });

  it("takes one step and re-chains (publishes the next message) when the run isn't finished yet", async () => {
    const runId = await seedRun({ task: "multi-step task", provider: "gemini" });
    mockGithubRequest.mockResolvedValue({ names: [] });
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
      finishReason: "STOP",
    });

    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 } });
    await handleAgentWorker(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("chained");
    expect(mockPublish).toHaveBeenCalledWith({ runId, afterStep: 1, retryCount: 0 });

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("running");
    expect(cp.stepsDone).toBe(1);
  });

  it("does NOT re-chain once the run completes with a final answer", async () => {
    const runId = await seedRun({ task: "one-step task", provider: "gemini" });
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ text: "final answer" }] },
      finishReason: "STOP",
    });

    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 } });
    await handleAgentWorker(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("done");
    expect(mockPublish).not.toHaveBeenCalled();

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("done");
    expect(cp.finalAnswer).toBe("final answer");
  });

  it("dead-letters after AGENT_WORKER_MAX_CONSECUTIVE_FAILURES consecutive same-step failures instead of re-chaining forever", async () => {
    const runId = await seedRun({ task: "always fails", provider: "gemini" });
    // Every providerChat call throws a non-transient error -- runInvestigation's
    // own per-step catch turns this into a `{ failed: true }` result without
    // advancing stepsDone.
    mockProviderChat.mockRejectedValue(new Error("bad request -- not transient"));

    let retryCount = 0;
    for (let i = 0; i < 5; i++) {
      const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount } });
      await handleAgentWorker(req, res);
      if (res.jsonBody.status === "dead-lettered") {
        expect(i).toBe(4); // 5th consecutive failure (0-indexed) hits the default cap of 5
        break;
      }
      expect(res.jsonBody.status).toBe("chained");
      retryCount += 1;
      expect(mockPublish).toHaveBeenLastCalledWith({ runId, afterStep: 0, retryCount });
    }

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("failed");
    expect(cp.finalAnswer).toMatch(/consecutive failures/);
  });
});
