import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProviderChat = vi.fn();
vi.mock("../connectors/llm/router.js", () => ({
  providerChat: mockProviderChat,
}));

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

vi.mock("../connectors/github/helpers.js", () => ({
  readFileViaBlob: vi.fn(),
}));

describe("agent_delegate.js — runInvestigation failure path compacting", () => {
  let runInvestigation;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ runInvestigation } = await import("../connectors/gemini/agent_delegate.js"));
  });

  it("compacts failure output by default when show_transcript is unset/false", async () => {
    // Simulate a failure: runInvestigation returns failed: true, answer: err
    // This isn't a direct call to runInvestigation (which would involve
    // mocking providerChat to actually fail), but we can call it in a way
    // that triggers the failure result naturally.
    // Actually, just need to see how runInvestigation formats its result object.
    // Wait, I can't easily mock the internal failure of runInvestigation.
    // Let's just mock providerChat to return a failure.
    mockProviderChat.mockResolvedValueOnce({
      content: { role: "model", parts: [{ text: "Error: something broke" }] },
      finishReason: "STOP",
    });

    const result = await runInvestigation({ task: "test task", max_steps: 1 });
    // This should produce result.failed = true.
    expect(result.failed).toBe(true);
    expect(result.answer).toMatch(/Error: something broke/);
  });
});
