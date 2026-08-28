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

describe("delegate_agent failure path compacting", () => {
  let runInvestigation;
  let register;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ runInvestigation } = await import("../connectors/gemini/agent_delegate.js"));
    ({ register } = await import("../connectors/gemini/agent_tools.js"));
  });

  it("returns compact summary on failure when show_transcript is false", async () => {
    // Mock runInvestigation failure
    vi.spyOn(import("../connectors/gemini/agent_delegate.js"), 'runInvestigation').mockResolvedValue({
      failed: true,
      answer: "API Error: connection refused",
      steps: 3,
      runId: "run-123",
      transcript: ["step 1 call", "step 2 call", "step 3 call"],
      task: "test task"
    });

    const server = { tool: vi.fn() };
    register(server);
    const tool = server.tool.mock.calls[0][2];
    
    const result = await tool({ task: "test task", show_transcript: false });
    
    expect(result.content[0].text).toMatch(/Investigation failed or partial after 3 step\(s\)\./);
    expect(result.content[0].text).toMatch(/Reason\/Error: API Error: connection refused/);
    expect(result.content[0].text).toMatch(/Resumable: resume_run_id: "run-123"/);
    expect(result.content[0].text).not.toMatch(/step 1 call/);
  });

  it("includes full transcript on failure when show_transcript is true", async () => {
    vi.spyOn(import("../connectors/gemini/agent_delegate.js"), 'runInvestigation').mockResolvedValue({
      failed: true,
      answer: "API Error: connection refused",
      steps: 3,
      runId: "run-123",
      transcript: ["step 1 call", "step 2 call", "step 3 call"],
      task: "test task"
    });

    const server = { tool: vi.fn() };
    register(server);
    const tool = server.tool.mock.calls[0][2];
    
    const result = await tool({ task: "test task", show_transcript: true });
    
    expect(result.content[0].text).toMatch(/Tool calls completed before failure:/);
    expect(result.content[0].text).toMatch(/step 1 call/);
    expect(result.content[0].text).toMatch(/step 2 call/);
  });
});
