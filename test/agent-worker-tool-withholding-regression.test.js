import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression test for a production bug: isFinalStep was derived from
// cappedSteps (this call's own loop bound), which the QStash worker's
// per-invocation call shrinks to the current step number on every
// single-step resume -- so isFinalStep was true on every worker step and
// tools were withheld from the entire async path, permanently.
//
// test/agent-delegate-async-checkpoint.test.js and test/agent-worker.test.js
// both mock providerChat with mockResolvedValueOnce(...), which returns its
// canned value regardless of what `tools` argument it was actually called
// with -- neither test asserts on that argument, which is exactly why this
// bug shipped to production despite both files passing. THIS file asserts
// directly on providerChat's second argument (`tools`) across a multi-step
// singleStep resume chain -- the real agent_worker.js call shape (see
// agent_worker.js's own comment: "this MUST be singleStep: true, not
// max_steps: stepsDone + 1") -- so a reintroduction of the cappedSteps/
// effectiveOverallMaxSteps conflation fails this test even though the
// model's canned responses would otherwise make it "pass".
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

describe("agent_worker.js singleStep resume — tools must not be withheld before the run's real last step", () => {
  let runInvestigation, seedRun, loadCheckpoint;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ runInvestigation, seedRun } = await import("../connectors/delegate/agent/agent_delegate.js"));
    ({ loadCheckpoint } = await import("../connectors/delegate/agent/agent_checkpoint.js"));
  });

  it("keeps tools available on every worker-driven singleStep resume except the run's genuine final step", async () => {
    mockGithubRequest.mockResolvedValue({ names: [] });
    // 3 tool-call steps, then a final text answer on step 4.
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_1" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_2" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_3" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "final answer text" }] },
        finishReason: "STOP",
      });

    // Real agent_worker.js flow: seedRun() establishes the run's true
    // overall ceiling (4), then each worker invocation resumes with
    // singleStep: true -- NOT max_steps: stepsDone + 1.
    const runId = await seedRun({ task: "investigate something", provider: "gemini", max_steps: 4 });

    let guard = 0;
    while (true) {
      const cp = await loadCheckpoint(runId);
      if (cp.status === "done") break;
      await runInvestigation({ resume_run_id: runId, singleStep: true, provider: "gemini" });
      if (guard++ > 6) throw new Error("worker loop did not converge -- test bug or regression");
    }

    expect(mockProviderChat).toHaveBeenCalledTimes(4);

    const toolsArgPerCall = mockProviderChat.mock.calls.map(([, options]) => options.tools);

    // Steps 1-3 are NOT the run's real final step (overallMaxSteps: 4) --
    // tools must be present. This is exactly the assertion the shipped
    // tests were missing; on the pre-fix code every one of these would be
    // undefined because cappedSteps === the current step on every call.
    expect(toolsArgPerCall[0]).toBeDefined();
    expect(toolsArgPerCall[1]).toBeDefined();
    expect(toolsArgPerCall[2]).toBeDefined();

    // Step 4 IS the run's genuine final step -- tools correctly withheld.
    expect(toolsArgPerCall[3]).toBeUndefined();

    const finalCheckpoint = await loadCheckpoint(runId);
    expect(finalCheckpoint.status).toBe("done");
    expect(finalCheckpoint.finalAnswer).toBe("final answer text");
  });
});
