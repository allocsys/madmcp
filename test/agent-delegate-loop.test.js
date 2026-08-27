import { describe, it, expect, vi, beforeEach } from "vitest";

// Net-new test file (plan.md step 8): nothing in test/ previously exercised
// runInvestigation/agent_delegate.js's loop itself (stuck-loop detection,
// step-budget nudges, checkpoint resume) -- only client.js/cooldown.js were
// covered (test/gemini-client.test.js). Parametrized against BOTH providers
// via a mocked providerChat, since these loop behaviors must be
// provider-invariant by construction (agent_delegate.js never branches on
// provider itself -- see plan.md step 6).
//
// Redis is deliberately left unconfigured (no UPSTASH_*/KV_* env vars set)
// so checkpoint.js/cooldown.js fail open exactly as they do in any
// environment without Redis provisioned -- no need to mock them, and this
// also lets the "resume with no live checkpoint" error path be exercised
// for real rather than through a mock.

const mockProviderChat = vi.fn();
vi.mock("../connectors/llm/router.js", () => ({
  providerChat: mockProviderChat,
}));

// github_get_repo_topics's execute() calls githubRequest -- mocked here so
// the "executes a function call" test below doesn't make a real network
// request. Every FUNCTIONS[].execute() is already wrapped in its own
// try/catch by agent_delegate.js's loop (a thrown error becomes a result
// string, not a loop failure), so this is only needed to keep the test
// hermetic, not to avoid a crash.
const mockGithubRequest = vi.fn();
vi.mock("../connectors/github/client.js", () => ({
  githubRequest: mockGithubRequest,
}));

const originalEnv = { ...process.env };

describe.each(["gemini", "glm", "groq"])("agent_delegate.js — runInvestigation (provider: %s)", (provider) => {
  let runInvestigation;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    ({ runInvestigation } = await import("../connectors/gemini/agent_delegate.js"));
  });

  it("returns a plain-text answer on the first step with no function calls, threading the provider through", async () => {
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ text: "The answer is 42." }] },
      finishReason: "STOP",
    });

    const result = await runInvestigation({ task: "what is the answer", max_steps: 5, provider });

    expect(result.answer).toBe("The answer is 42.");
    expect(result.steps).toBe(1);
    expect(result.failed).toBeUndefined();
    expect(mockProviderChat).toHaveBeenCalledTimes(1);
    const [, opts] = mockProviderChat.mock.calls[0];
    expect(opts.provider).toBe(provider);
  });

  it("executes a function call, feeds the result back, and returns the final answer on the next step", async () => {
    mockProviderChat
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "allocsys", repo: "madmcp" }, id: "call_1" } }] },
        finishReason: "STOP",
      })
      .mockResolvedValueOnce({
        content: { role: "model", parts: [{ text: "Topics: mcp, ai" }] },
        finishReason: "STOP",
      });

    mockGithubRequest.mockResolvedValueOnce({ names: ["mcp", "ai"] });

    const result = await runInvestigation({ task: "list topics", max_steps: 5, provider });

    expect(result.answer).toBe("Topics: mcp, ai");
    expect(result.steps).toBe(2);
    expect(mockProviderChat).toHaveBeenCalledTimes(2);
    // Both steps used the same provider throughout a single run.
    expect(mockProviderChat.mock.calls[0][1].provider).toBe(provider);
    expect(mockProviderChat.mock.calls[1][1].provider).toBe(provider);
    // The transcript recorded the call, whatever its result (error or not).
    expect(result.transcript[0]).toMatch(/^\[step 1\] github_get_repo_topics/);
  });

  it("withholds tools on the final allowed step", async () => {
    mockProviderChat.mockResolvedValue({
      content: { role: "model", parts: [{ text: "final answer" }] },
      finishReason: "STOP",
    });

    await runInvestigation({ task: "one step only", max_steps: 1, provider });

    expect(mockProviderChat).toHaveBeenCalledTimes(1);
    const [, opts] = mockProviderChat.mock.calls[0];
    expect(opts.tools).toBeUndefined();
  });

  it("forces a text-only answer after 3 consecutive all-repeat steps (stuck-loop guard)", async () => {
    const repeatedCall = {
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_x" } }] },
      finishReason: "STOP",
    };
    mockProviderChat
      .mockResolvedValueOnce(repeatedCall) // step 1
      .mockResolvedValueOnce(repeatedCall) // step 2 (1st repeat)
      .mockResolvedValueOnce(repeatedCall) // step 3 (2nd repeat)
      .mockResolvedValueOnce(repeatedCall) // step 4 (3rd repeat -> next step forced text-only)
      .mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "giving up, here's what I found" }] }, finishReason: "STOP" }); // step 5

    const result = await runInvestigation({ task: "keep repeating", max_steps: 10, provider });

    expect(result.answer).toBe("giving up, here's what I found");
    // Step 5 (index 4) must have been called with tools withheld.
    const step5Opts = mockProviderChat.mock.calls[4][1];
    expect(step5Opts.tools).toBeUndefined();
  });

  it("stops after the hard step cap without a final answer", async () => {
    mockProviderChat.mockResolvedValue({
      content: { role: "model", parts: [{ functionCall: { name: "github_get_repo_topics", args: { owner: "a", repo: "b" }, id: "call_never_ends" } }] },
      finishReason: "STOP",
    });

    const result = await runInvestigation({ task: "never finishes", max_steps: 2, provider });

    expect(result.answer).toMatch(/reaching the step cap of 2/);
    expect(result.steps).toBe(2);
  });

  it("returns a resumable failure (with runId) when providerChat throws a transient error", async () => {
    const transientErr = new Error("API error (503): overloaded");
    transientErr.status = 503;
    mockProviderChat.mockRejectedValueOnce(transientErr);

    const result = await runInvestigation({ task: "will fail", max_steps: 5, provider });

    expect(result.failed).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(result.answer).toMatch(/call failed on step 1/);
  });

  it("throws a clear error when resume_run_id has no live checkpoint and no task is given", async () => {
    await expect(runInvestigation({ resume_run_id: "nonexistent-run-id", provider })).rejects.toThrow(/has no live checkpoint/);
  });

  it("falls through to a fresh run when resume_run_id's checkpoint is missing but a task is supplied", async () => {
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ text: "fresh run answer" }] },
      finishReason: "STOP",
    });

    const result = await runInvestigation({ task: "fallback task", resume_run_id: "nonexistent-run-id", max_steps: 5, provider });

    expect(result.answer).toBe("fresh run answer");
    // A fresh run gets its own new runId, not the (nonexistent) resume target.
    expect(result.runId).not.toBe("nonexistent-run-id");
  });
});
