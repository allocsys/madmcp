import { describe, it, expect, vi, beforeEach } from "vitest";

// Covers async delegate_agent groundwork: unlike
// test/agent-delegate-loop.test.js (which deliberately leaves Redis
// unconfigured so checkpoint.js/cooldown.js fail open), THIS file wires up a
// real fake Redis (same tiny in-memory fake as test/agent-checkpoint.test.js)
// so it can exercise actual save/resume/done round trips end to end -- the
// thing a QStash worker calling runInvestigation({ resume_run_id, max_steps:
// stepsDone + 1 }) once per invocation actually depends on.
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

const mockProviderChat = vi.fn();
vi.mock("../connectors/llm/router.js", () => ({
  providerChat: mockProviderChat,
}));

const mockGithubRequest = vi.fn();
vi.mock("../connectors/github/client.js", () => ({
  githubRequest: mockGithubRequest,
}));

describe("agent_delegate.js — single-step resume chaining (async delegate_agent groundwork)", () => {
  let runInvestigation, loadCheckpoint;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ runInvestigation } = await import("../connectors/gemini/agent_delegate.js"));
    ({ loadCheckpoint } = await import("../connectors/gemini/agent_checkpoint.js"));
  });

  it("preserves (does not delete) the checkpoint when a caller's max_steps is exhausted below HARD_MAX_STEPS, and it can still be resumed", async () => {
    mockProviderChat.mockResolvedValue({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
      finishReason: "STOP",
    });
    mockGithubRequest.mockResolvedValue({ names: ["topic1"] });

    const first = await runInvestigation({ task: "investigate something", max_steps: 1, provider: "gemini" });
    expect(first.failed).toBe(true);
    expect(first.answer).toMatch(/checkpoint has NOT been discarded/);

    const checkpoint = await loadCheckpoint(first.runId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint.status).toBe("running");
    expect(checkpoint.stepsDone).toBe(1);

    // Resuming with a higher ceiling picks back up rather than starting over
    // -- providerChat was called exactly once so far (the first step); a
    // second call here proves the SAME conversation is being continued, not
    // discarded and restarted.
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ text: "final answer text" }] },
      finishReason: "STOP",
    });
    const resumed = await runInvestigation({ resume_run_id: first.runId, max_steps: 2, provider: "gemini" });
    expect(resumed.steps).toBe(2);
    expect(resumed.answer).toBe("final answer text");
    expect(mockProviderChat).toHaveBeenCalledTimes(2);
  });

  it("drives a run to completion one step at a time via resume_run_id + max_steps: stepsDone + 1 (the QStash worker's exact call pattern), then short-circuits on a done checkpoint without re-invoking the model", async () => {
    mockGithubRequest.mockResolvedValue({ names: [] });
    // Step 1: a tool call. Step 2: a final answer (no function calls).
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "done answer" }] },
        finishReason: "STOP",
      });

    // Start: seed the run and take step 1 only.
    let result = await runInvestigation({ task: "worker-driven task", max_steps: 1, provider: "gemini" });
    const runId = result.runId;
    expect(result.failed).toBe(true);

    // Worker loop: load checkpoint, take exactly one more step, repeat until done.
    let guard = 0;
    while (true) {
      const cp = await loadCheckpoint(runId);
      if (cp.status === "done") break;
      result = await runInvestigation({ resume_run_id: runId, max_steps: cp.stepsDone + 1, provider: "gemini" });
      if (guard++ > 5) throw new Error("worker loop did not converge -- test bug or regression");
    }

    const finalCheckpoint = await loadCheckpoint(runId);
    expect(finalCheckpoint.status).toBe("done");
    expect(finalCheckpoint.finalAnswer).toBe("done answer");
    expect(mockProviderChat).toHaveBeenCalledTimes(2);

    // Polling a finished run (same shape as delegate_agent's poll path)
    // returns the stored answer directly and does NOT re-invoke the model.
    const polled = await runInvestigation({ resume_run_id: runId, provider: "gemini" });
    expect(polled.answer).toBe("done answer");
    expect(mockProviderChat).toHaveBeenCalledTimes(2);
  });

  it("still deletes nothing prematurely but DOES finalize as done when the HARD_MAX_STEPS ceiling itself is hit (no further resume is meaningful)", async () => {
    mockGithubRequest.mockResolvedValue({ names: [] });
    mockProviderChat.mockResolvedValue({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_never_ends" } }] },
      finishReason: "STOP",
    });

    const result = await runInvestigation({ task: "never finishes", max_steps: 30, provider: "gemini" });
    expect(result.answer).toMatch(/hard step cap of 30/);
    expect(result.failed).toBeUndefined();

    const checkpoint = await loadCheckpoint(result.runId);
    expect(checkpoint.status).toBe("done");
    expect(checkpoint.finalAnswer).toBe(result.answer);
  });
});
