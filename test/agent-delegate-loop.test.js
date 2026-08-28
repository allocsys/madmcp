import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal fake MCP server: captures the registered tool's handler function
// (4th argument to server.tool(name, description, schema, handler)) so
// tests can call it directly -- same pattern as
// test/agent-tools-async.test.js's makeFakeServer / test/github-clone-token.test.js.
function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

// vi.spyOn on a dynamic import()'s namespace object doesn't work for ESM --
// import() returns a fresh Promise each call and namespace exports are
// non-configurable, so spyOn silently fails to attach ("The property
// ... is not defined on the object"). Mock the module directly instead,
// same as every other agent_tools.js test in this repo
// (test/agent-tools-async.test.js).
const mockRunInvestigation = vi.fn();
const mockSeedRun = vi.fn();

vi.mock("../connectors/gemini/agent_delegate.js", () => ({
  runInvestigation: mockRunInvestigation,
  seedRun: mockSeedRun,
}));
vi.mock("../connectors/gemini/agent_checkpoint.js", () => ({
  loadCheckpoint: vi.fn(),
}));
vi.mock("../connectors/gemini/qstash_client.js", () => ({
  publishAgentStep: vi.fn(),
  isQStashConfigured: vi.fn(() => false),
}));
vi.mock("../connectors/notion/tools.js", () => ({
  doCreatePage: vi.fn(),
}));

describe("delegate_agent failure path compacting", () => {
  let register;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ register } = await import("../connectors/gemini/agent_tools.js"));
  });

  it("returns compact summary on failure when show_transcript is false", async () => {
    mockRunInvestigation.mockResolvedValue({
      failed: true,
      answer: "API Error: connection refused",
      steps: 3,
      runId: "run-123",
      transcript: ["step 1 call", "step 2 call", "step 3 call"],
      task: "test task",
    });

    const server = makeFakeServer();
    register(server);

    const result = await server.tools.delegate_agent({ task: "test task", show_transcript: false });

    expect(result.content[0].text).toMatch(/Investigation failed or partial after 3 step\(s\)\./);
    expect(result.content[0].text).toMatch(/Reason\/Error: API Error: connection refused/);
    expect(result.content[0].text).toMatch(/Resumable: resume_run_id: "run-123"/);
    expect(result.content[0].text).not.toMatch(/step 1 call/);
  });

  it("includes full transcript on failure when show_transcript is true", async () => {
    mockRunInvestigation.mockResolvedValue({
      failed: true,
      answer: "API Error: connection refused",
      steps: 3,
      runId: "run-123",
      transcript: ["step 1 call", "step 2 call", "step 3 call"],
      task: "test task",
    });

    const server = makeFakeServer();
    register(server);

    const result = await server.tools.delegate_agent({ task: "test task", show_transcript: true });

    expect(result.content[0].text).toMatch(/Tool calls completed before failure:/);
    expect(result.content[0].text).toMatch(/step 1 call/);
    expect(result.content[0].text).toMatch(/step 2 call/);
  });
});
