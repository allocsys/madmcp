import { describe, it, expect, vi, beforeEach } from "vitest";

// Covers the QStash worker endpoint itself (connectors/delegate/editor/editor_worker.js):
// signature verification (fail-closed), idempotency (stepsDone/afterStep
// mismatch -> no-op), re-chaining on a successful-but-unfinished step, and
// dead-lettering after repeated same-step failures. Same fake-Redis approach
// as test/agent-worker.test.js so checkpoint state is exercised for real
// rather than mocked away -- EXCEPT editor_checkpoint.js is a whole-blob
// overwrite (see its own header, plan.md Step 1), not agent_checkpoint.js's
// list+meta split, so the fake here only needs get/set/del, not
// rpush/lrange/expire.
//
// Also asserts the whole-blob heartbeat/dead-letter-write regression this
// file's own header warns about: a meta-shaped write here would silently
// erase contents/writtenFiles/writesPerFile/validateCounts/owner/repo/branch
// on the very first worker invocation.

function makeFakeRedis() {
  const strings = new Map();
  return {
    async set(key, val) { strings.set(key, val); return "OK"; },
    async get(key) { return strings.has(key) ? strings.get(key) : null; },
    async del(key) { strings.delete(key); return 1; },
  };
}

const fakeRedis = makeFakeRedis();
vi.mock("../connectors/shared/cooldown.js", () => ({
  getRedis: () => fakeRedis,
  isRedisConfigured: () => true,
}));

const mockVerify = vi.fn();
const mockPublish = vi.fn();
vi.mock("../connectors/delegate/qstash_client.js", () => ({
  verifyQStashSignature: (...args) => mockVerify(...args),
  publishEditorStep: (...args) => mockPublish(...args),
}));

const mockProviderChat = vi.fn();
vi.mock("../connectors/llm/router.js", () => ({
  providerChat: mockProviderChat,
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockAssertNotDefaultBranch = vi.fn(async () => ({ default_branch: "main" }));
vi.mock("../connectors/github/editor_tool_functions.js", () => ({
  readFile: (...args) => mockReadFile(...args),
  writeFile: (...args) => mockWriteFile(...args),
  assertNotDefaultBranch: (...args) => mockAssertNotDefaultBranch(...args),
}));

vi.mock("../connectors/github/editor_validate.js", () => ({
  validateByExtension: vi.fn(async () => ({ valid: true })),
}));

const OWNER = "allocsys";
const REPO = "madmcp";
const BRANCH = "feature-branch";

function functionCallCandidate(name, args, id = "call_1") {
  return {
    content: { role: "model", parts: [{ functionCall: { name, args, id } }] },
    finishReason: "STOP",
  };
}

function textCandidate(text) {
  return { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" };
}

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

// Builds a fake request/response pair shaped like QStash's failure-callback
// POST body (plan.md Section 13) -- distinct from makeReqRes above, which
// shapes the ORIGINAL {runId, afterStep, retryCount} worker-invocation body.
// The actual {runId, afterStep} this app cares about is base64-encoded
// under `sourceBody`, mirroring exactly what QStash sends. Same shape as
// test/agent-worker.test.js's makeFailureReqRes.
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

describe("editor_worker.js — handleEditorWorker", () => {
  let handleEditorWorker, seedEditorRun, loadCheckpoint;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockVerify.mockResolvedValue(true);
    mockPublish.mockResolvedValue();
    mockAssertNotDefaultBranch.mockResolvedValue({ default_branch: "main" });
    ({ handleEditorWorker } = await import("../connectors/delegate/editor/editor_worker.js"));
    ({ seedEditorRun } = await import("../connectors/delegate/editor/editor_delegate.js"));
    ({ loadCheckpoint } = await import("../connectors/delegate/editor/editor_checkpoint.js"));
  });

  it("rejects a request with an invalid/missing QStash signature before touching any checkpoint", async () => {
    mockVerify.mockResolvedValue(false);
    const { req, res } = makeReqRes({ body: { runId: "does-not-matter", afterStep: 0 } });
    await handleEditorWorker(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockProviderChat).not.toHaveBeenCalled();
  });

  it("rejects a request missing runId", async () => {
    const { req, res } = makeReqRes({ body: { afterStep: 0 } });
    await handleEditorWorker(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("no-ops on a checkpoint that no longer exists (expired/unknown runId)", async () => {
    const { req, res } = makeReqRes({ body: { runId: "nonexistent-run", afterStep: 0 } });
    await handleEditorWorker(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
  });

  it("no-ops when afterStep no longer matches the live checkpoint's stepsDone (idempotent redelivery guard), and does not re-chain", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "some task" });
    mockProviderChat.mockResolvedValueOnce(functionCallCandidate("write_file", { path: "a.md", content: "x" }));
    mockWriteFile.mockResolvedValue({ path: "a.md", sha: "s", commitSha: "c1234567", noop: false });

    const { runEditorAgent } = await import("../connectors/delegate/editor/editor_delegate.js");
    await runEditorAgent({ resume_run_id: runId, singleStep: true });

    const { req, res } = makeReqRes({ body: { runId, afterStep: 0 } }); // stale -- real stepsDone is now 1
    await handleEditorWorker(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("heartbeat write preserves the whole checkpoint blob (contents/writtenFiles/writesPerFile/validateCounts/owner/repo/branch survive)", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "heartbeat test" });
    mockProviderChat.mockResolvedValueOnce(functionCallCandidate("write_file", { path: "a.md", content: "x" }));
    mockWriteFile.mockResolvedValue({ path: "a.md", sha: "s", commitSha: "c1234567", noop: false });

    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 } });
    await handleEditorWorker(req, res);

    expect(res.statusCode).toBe(200);
    const cp = await loadCheckpoint(runId);
    expect(cp.owner).toBe(OWNER);
    expect(cp.repo).toBe(REPO);
    expect(cp.branch).toBe(BRANCH);
    expect(cp.contents).toBeDefined();
    expect(cp.contents.length).toBeGreaterThan(0);
    expect(cp.writtenFiles).toEqual(["a.md"]);
    expect(cp.writesPerFile).toEqual({ "a.md": 1 });
    expect(cp.validateCounts).toBeDefined();
  });

  it("takes one step and re-chains (publishes the next message) when the run isn't finished yet", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "multi-step task", max_steps: 5 });
    mockProviderChat.mockResolvedValueOnce(functionCallCandidate("write_file", { path: "a.md", content: "x" }));
    mockWriteFile.mockResolvedValue({ path: "a.md", sha: "s", commitSha: "c1234567", noop: false });

    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 } });
    await handleEditorWorker(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("chained");
    expect(mockPublish).toHaveBeenCalledWith({ runId, afterStep: 1, retryCount: 0 });

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("running");
    expect(cp.stepsDone).toBe(1);
  });

  it("does NOT re-chain once the run completes with a final answer", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "one-step task" });
    mockProviderChat.mockResolvedValueOnce(textCandidate("final answer"));

    const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount: 0 } });
    await handleEditorWorker(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("done");
    expect(mockPublish).not.toHaveBeenCalled();

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("done");
    expect(cp.finalAnswer).toBe("final answer");
  });

  it("dead-letters after EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES consecutive same-step failures instead of re-chaining forever", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "always fails" });
    mockProviderChat.mockRejectedValue(new Error("bad request -- not transient"));

    let retryCount = 0;
    for (let i = 0; i < 5; i++) {
      const { req, res } = makeReqRes({ body: { runId, afterStep: 0, retryCount } });
      await handleEditorWorker(req, res);
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

// Regression coverage for handleEditorWorkerFailure (plan.md Section 13) --
// editor-side mirror of test/agent-worker.test.js's
// handleAgentWorkerFailure suite. Same signature-fail/stale-no-op/
// finished-no-op/happy-path-finalize shape; only difference is
// editor_checkpoint.js's whole-blob spread (see editor_worker.js's own file
// header) rather than agent_checkpoint.js's explicit-field-list write.
describe("editor_worker.js — handleEditorWorkerFailure", () => {
  let handleEditorWorkerFailure, seedEditorRun, loadCheckpoint, runEditorAgent;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockVerify.mockResolvedValue(true);
    mockPublish.mockResolvedValue();
    mockAssertNotDefaultBranch.mockResolvedValue({ default_branch: "main" });
    ({ handleEditorWorkerFailure } = await import("../connectors/delegate/editor/editor_worker.js"));
    ({ seedEditorRun, runEditorAgent } = await import("../connectors/delegate/editor/editor_delegate.js"));
    ({ loadCheckpoint } = await import("../connectors/delegate/editor/editor_checkpoint.js"));
  });

  it("rejects a request with an invalid/missing QStash signature before touching any checkpoint", async () => {
    mockVerify.mockResolvedValue(false);
    const { req, res } = makeFailureReqRes({ sourceBody: { runId: "does-not-matter", afterStep: 0 } });
    await handleEditorWorkerFailure(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("no-ops on a missing/unparseable sourceBody instead of throwing or touching a checkpoint", async () => {
    const { req, res } = makeFailureReqRes({ rawSourceBody: "not-valid-base64-json!!!" });
    await handleEditorWorkerFailure(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
  });

  it("no-ops on a sourceBody missing runId", async () => {
    const { req, res } = makeFailureReqRes({ sourceBody: { afterStep: 0 } });
    await handleEditorWorkerFailure(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");
  });

  it("no-ops (does not clobber) when the checkpoint has already advanced past the callback's afterStep", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "some task" });
    mockProviderChat.mockResolvedValueOnce(functionCallCandidate("write_file", { path: "a.md", content: "x" }));
    mockWriteFile.mockResolvedValue({ path: "a.md", sha: "s", commitSha: "c1234567", noop: false });
    await runEditorAgent({ resume_run_id: runId, singleStep: true });

    const cpBefore = await loadCheckpoint(runId);
    expect(cpBefore.stepsDone).toBe(1);

    // Callback describes the ORIGINAL message (afterStep: 0), now stale.
    const { req, res } = makeFailureReqRes({ sourceBody: { runId, afterStep: 0 } });
    await handleEditorWorkerFailure(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("no-op");

    const cpAfter = await loadCheckpoint(runId);
    expect(cpAfter.status).toBe("running"); // not clobbered into "failed"
    expect(cpAfter.stepsDone).toBe(1);
  });

  it("no-ops (does not overwrite the real answer) when the run already finished before the callback arrived", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "one-step task" });
    mockProviderChat.mockResolvedValueOnce(textCandidate("final answer"));
    await runEditorAgent({ resume_run_id: runId, singleStep: true });

    const cpBefore = await loadCheckpoint(runId);
    expect(cpBefore.status).toBe("done");

    const { req, res } = makeFailureReqRes({ sourceBody: { runId, afterStep: 0 } });
    await handleEditorWorkerFailure(req, res);

    expect(res.jsonBody.status).toBe("no-op");
    const cpAfter = await loadCheckpoint(runId);
    expect(cpAfter.status).toBe("done");
    expect(cpAfter.finalAnswer).toBe("final answer");
  });

  it("finalizes the checkpoint as failed with the QStash-sourced reason when it's still exactly in the stalled state the callback describes, WITHOUT dropping owner/repo/branch/contents (whole-blob spread)", async () => {
    const runId = await seedEditorRun({ owner: OWNER, repo: REPO, branch: BRANCH, task: "oversized step that always platform-times-out" });
    // Freshly seeded: status "running", stepsDone 0 -- matching a failure
    // callback for the very first message (afterStep: 0).
    const { req, res } = makeFailureReqRes({ sourceBody: { runId, afterStep: 0 }, retried: 0, maxRetries: 0 });
    await handleEditorWorkerFailure(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe("dead-lettered");
    expect(res.jsonBody.reason).toBe("qstash-failure-callback");

    const cp = await loadCheckpoint(runId);
    expect(cp.status).toBe("failed");
    expect(cp.finalAnswer).toMatch(/QStash exhausted its own delivery budget/);
    expect(cp.stepStartedAt).toBeNull();
    // Whole-blob-spread regression check (this file's own header warning).
    expect(cp.owner).toBe(OWNER);
    expect(cp.repo).toBe(REPO);
    expect(cp.branch).toBe(BRANCH);
  });
});
