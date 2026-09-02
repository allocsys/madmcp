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

function makeReqRes({ body, signature = "sig", rawBody, upstashRetried } = {}) {
  const req = {
    body,
    rawBody: rawBody ? Buffer.from(rawBody) : Buffer.from(JSON.stringify(body || {})),
    get: (name) => {
      if (name === "Upstash-Signature") return signature;
      if (name === "Upstash-Retried") return upstashRetried === undefined ? undefined : String(upstashRetried);
      return undefined;
    },
  };
  const res = {
    statusCode: null,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
  return { req, res };
}

// Builds a fake request/response pair shaped like QStash's failure-callback
// POST body (plan.md Section 13) -- distinct from makeReqRes above, which
// shapes the ORIGINAL {runId, afterStep, retryCount} worker-invocation body.
// The failure callback's own top-level fields (retried/maxRetries) are
// QStash's own bookkeeping; the actual {runId, afterStep} this app cares
// about is base64-encoded under `sourceBody`, mirroring exactly what QStash
// sends (see handleAgentWorkerFailure's own header comment).
function makeFailureReqRes({ sourceBody, retried = 3, maxRetries = 3, signature = "sig", rawSourceBody } = {}) {
  const body = {
    retried,
    maxRetries,
    sourceBody: rawSourceBody !== undefined ? rawSourceBody : Buffer.from(JSON.stringify(sourceBody || {})).toString("base64"),
  };
  const req = {
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
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
  let handleAgentWorker, handleAgentWorkerFailure, seedRun, loadCheckpoint;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockVerify.mockResolvedValue(true);
    mockPublish.mockResolvedValue();
    ({ handleAgentWorker, handleAgentWorkerFailure } = await import("../connectors/gemini/agent_worker.js"));
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

  // Regression coverage for plan.md Section 9, priority #3: the dead-letter
  // blind spot when a platform timeout kills the function before this
  // repo's own retryCount can ever be incremented. Simulates that exact
  // scenario -- body.retryCount stuck at 0 (as it would be on a message
  // that was published once, after which every delivery attempt hard-timed
  // out before reaching the re-chain code) while Upstash-Retried climbs on
  // each simulated redelivery.
  it("dead-letters via Upstash-Retried header even when body.retryCount never advanced (simulated platform-timeout blind spot)", async () => {
    const runId = await seedRun({ task: "oversized step that always platform-times-out", provider: "gemini" });

    // Every attempt below sends body.retryCount: 0 -- simulating the exact
    // blind spot: a platform timeout kills the function before the re-chain
    // code (the only place that ever persists an updated retryCount) runs,
    // so QStash keeps redelivering the SAME original message, whose body is
    // frozen at whatever it was when first published. Only Upstash-Retried
    // (the header) actually climbs across these redeliveries. If dead-
    // lettering only looked at body.retryCount, this would loop forever;
    // the fix makes effectiveRetryCount = max(body.retryCount, header)
    // catch it via the header instead.
    mockProviderChat.mockRejectedValue(new Error("simulated slow call"));

    // Attempts at header values 0, 1, 2, 3 all stay under the default
    // AGENT_WORKER_MAX_CONSECUTIVE_FAILURES (5) threshold once the post-
    // attempt failure is counted (effectiveRetryCount + 1), so none of
    // these should dead-letter yet.
    for (let retried = 0; retried <= 3; retried++) {
      const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 }, upstashRetried: retried });
      await handleAgentWorker(req, res);
      expect(res.jsonBody.status).toBe("chained");
    }

    // At header value 4, effectiveRetryCount (4) + 1 = 5 reaches the
    // threshold -- dead-letters via the ordinary post-attempt path, driven
    // by the header since body.retryCount is still frozen at 0.
    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 }, upstashRetried: 4 });
    await handleAgentWorker(req, res);
    expect(res.jsonBody.status).toBe("dead-lettered");

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("failed");
    expect(cp.finalAnswer).toMatch(/consecutive failures/);
  });

  it("dead-letters IMMEDIATELY (skipping the attempt entirely) when Upstash-Retried alone already meets the threshold on entry", async () => {
    const runId = await seedRun({ task: "already redelivered many times before we ever see it", provider: "gemini" });
    mockProviderChat.mockRejectedValue(new Error("should never be called"));

    // A single request whose header ALONE already meets the threshold
    // (body.retryCount: 0, as if this were the very first message this
    // repo's own code has ever seen for this run, but QStash's own
    // perspective is that it's already redelivered this exact message 5
    // times -- i.e. every prior attempt hard-timed-out before even reaching
    // the heartbeat write). This must dead-letter WITHOUT attempting
    // runInvestigation again.
    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 }, upstashRetried: 5 });
    await handleAgentWorker(req, res);

    expect(res.jsonBody.status).toBe("dead-lettered");
    expect(res.jsonBody.reason).toBe("qstash-retried-threshold");
    expect(mockProviderChat).not.toHaveBeenCalled();

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("failed");
    expect(cp.finalAnswer).toMatch(/Upstash-Retried/);
  });

  it("does not dead-letter prematurely when Upstash-Retried is present but still below the threshold", async () => {
    const runId = await seedRun({ task: "healthy-ish task", provider: "gemini" });
    mockGithubRequest.mockResolvedValue({ names: [] });
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
      finishReason: "STOP",
    });

    // A low, healthy Upstash-Retried value (e.g. 1 -- ordinary first retry
    // after a blip) must not trip the new early dead-letter check.
    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 }, upstashRetried: 1 });
    await handleAgentWorker(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("chained");
  });
});

// Regression coverage for the two new failure-callback handlers added in
// plan.md Section 13 (the fix for the live dead-letter blind spot confirmed
// in Section 12: a step that hard-times-out on every single QStash delivery
// attempt previously left a run stuck at status:"running" forever, with no
// further invocation of handleAgentWorker ever arriving to run its own
// in-process dead-letter check). Mirrors the dead-letter test patterns
// above: signature-fail (401), stale/no-op (checkpoint already moved on or
// finished), and happy-path finalize (checkpoint still in the exact stalled
// state the callback describes -> "failed" with the QStash-sourced reason).
describe("agent_worker.js — handleAgentWorkerFailure", () => {
  let handleAgentWorkerFailure, seedRun, loadCheckpoint, runInvestigation;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockVerify.mockResolvedValue(true);
    mockPublish.mockResolvedValue();
    ({ handleAgentWorkerFailure } = await import("../connectors/gemini/agent_worker.js"));
    ({ seedRun, runInvestigation } = await import("../connectors/gemini/agent_delegate.js"));
    ({ loadCheckpoint } = await import("../connectors/gemini/agent_checkpoint.js"));
  });

  it("rejects a request with an invalid/missing QStash signature before touching any checkpoint", async () => {
    mockVerify.mockResolvedValue(false);
    const { req, res } = makeFailureReqRes({ sourceBody: { runId: "does-not-matter", afterStep: 0 } });
    await handleAgentWorkerFailure(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("no-ops on a missing/unparseable sourceBody instead of throwing or touching a checkpoint", async () => {
    const { req, res } = makeFailureReqRes({ rawSourceBody: "not-valid-base64-json!!!" });
    await handleAgentWorkerFailure(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
  });

  it("no-ops on a sourceBody missing runId", async () => {
    const { req, res } = makeFailureReqRes({ sourceBody: { afterStep: 0 } });
    await handleAgentWorkerFailure(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
  });

  it("no-ops (does not clobber) when the checkpoint has already advanced past the callback's afterStep -- the organic retry path recovered before QStash's own budget gave up", async () => {
    const runId = await seedRun({ task: "some task", provider: "gemini" });
    mockGithubRequest.mockResolvedValue({ names: [] });
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
      finishReason: "STOP",
    });
    await runInvestigation({ resume_run_id: runId, max_steps: 1, provider: "gemini" });

    const cpBefore = await loadCheckpoint(runId);
    expect(cpBefore.stepsDone).toBe(1);

    // Callback describes the ORIGINAL message (afterStep: 0), now stale --
    // the live checkpoint has already moved past it.
    const { req, res } = makeFailureReqRes({ sourceBody: { runId, afterStep: 0 } });
    await handleAgentWorkerFailure(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");

    const cpAfter = await loadCheckpoint(runId);
    expect(cpAfter.status).toBe("running"); // not clobbered into "failed"
    expect(cpAfter.stepsDone).toBe(1);
  });

  it("no-ops (does not overwrite the real answer) when the run already finished before the callback arrived", async () => {
    const runId = await seedRun({ task: "one-step task", provider: "gemini" });
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ text: "final answer" }] },
      finishReason: "STOP",
    });
    await runInvestigation({ resume_run_id: runId, max_steps: 1, provider: "gemini" });

    const cpBefore = await loadCheckpoint(runId);
    expect(cpBefore.status).toBe("done");

    const { req, res } = makeFailureReqRes({ sourceBody: { runId, afterStep: 0 } });
    await handleAgentWorkerFailure(req, res);

    expect(res.jsonBody.status).toBe("no-op");
    const cpAfter = await loadCheckpoint(runId);
    expect(cpAfter.status).toBe("done");
    expect(cpAfter.finalAnswer).toBe("final answer");
  });

  it("finalizes the checkpoint as failed with the QStash-sourced reason when it's still exactly in the stalled state the callback describes", async () => {
    const runId = await seedRun({ task: "oversized step that always platform-times-out", provider: "gemini" });
    // Freshly seeded: status "running", stepsDone 0 -- exactly matching a
    // failure callback for the very first message (afterStep: 0), i.e. every
    // delivery attempt of step 1 hard-timed-out and QStash gave up.
    const { req, res } = makeFailureReqRes({ sourceBody: { runId, afterStep: 0 }, retried: 0, maxRetries: 0 });
    await handleAgentWorkerFailure(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("dead-lettered");
    expect(res.jsonBody.reason).toBe("qstash-failure-callback");

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("failed");
    expect(cp.finalAnswer).toMatch(/QStash exhausted its own delivery budget/);
    expect(cp.stepStartedAt).toBeNull();
  });
});
