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
// (test/agent-tools-async.test.js). Named top-level vars (rather than
// inline arrow functions in the mock factories) so different describe
// blocks below can configure return values independently.
const mockRunInvestigation = vi.fn();
const mockSeedRun = vi.fn();
const mockLoadCheckpoint = vi.fn();
const mockPublishAgentStep = vi.fn();
const mockIsQStashConfigured = vi.fn(() => false);
const mockDoCreatePage = vi.fn();

vi.mock("../connectors/delegate/agent/agent_delegate.js", () => ({
  runInvestigation: mockRunInvestigation,
  seedRun: mockSeedRun,
}));
vi.mock("../connectors/delegate/agent/agent_checkpoint.js", () => ({
  loadCheckpoint: mockLoadCheckpoint,
}));
vi.mock("../connectors/gemini/qstash_client.js", () => ({
  publishAgentStep: mockPublishAgentStep,
  isQStashConfigured: mockIsQStashConfigured,
}));
vi.mock("../connectors/notion/tools.js", () => ({
  doCreatePage: mockDoCreatePage,
}));

describe("delegate_agent failure path compacting", () => {
  let register;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockIsQStashConfigured.mockReturnValue(false); // this describe's real config.js defaults DELEGATE_AGENT_ASYNC to "sync" anyway, but keep it explicit
    ({ register } = await import("../connectors/delegate/agent/agent_tools.js"));
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

  it("renders 'not resumable' when a failed result has no runId", async () => {
    mockRunInvestigation.mockResolvedValue({
      failed: true,
      answer: "Gemini API Error: 500 internal error",
      steps: 1,
      runId: undefined,
      transcript: [],
      task: "test task",
    });

    const server = makeFakeServer();
    register(server);

    const result = await server.tools.delegate_agent({ task: "test task" });

    expect(result.content[0].text).toMatch(/Resumable: not resumable/);
    expect(result.content[0].text).not.toMatch(/resume_run_id:/);
  });
});

// Regression coverage for the scope-creep bug found while landing the
// compact-failure-response fix above: an earlier commit on this branch
// (since reverted) accidentally gated the async "still running" poll
// branch's transcript on show_transcript too, even though that branch was
// never part of the documented failed/partial-run bug and broke
// test/agent-tools-async.test.js's existing "poll with a fresh checkpoint"
// case. These tests pin the poll branch's transcript to stay unconditional
// so that gate can't silently come back. Needs DELEGATE_AGENT_ASYNC set to
// "qstash" (the outer describe block above relies on real config.js's
// "sync" default, which never reaches this branch at all), so config.js is
// mocked per-test here via vi.doMock + vi.resetModules, same technique
// test/agent-tools-async.test.js uses for the same reason.
describe("delegate_agent poll-branch transcript (regression guard)", () => {
  let register;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("../config.js", () => ({
      GEMINI_NOTION_ROOT_PAGE_ID: "root-page-id",
      DELEGATE_AGENT_ASYNC: "qstash",
      AGENT_ASYNC_POLL_FRESH_SECONDS: 25,
    }));
    mockIsQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 2,
      lastStepAt: Date.now() - 3000, // 3s ago, well inside the 25s fresh window
      transcript: ["github_get_repo_topics(a, b)"],
    });
    ({ register } = await import("../connectors/delegate/agent/agent_tools.js"));
  });

  it("includes the transcript on a fresh poll when show_transcript is omitted (default false)", async () => {
    const server = makeFakeServer();
    register(server);

    const result = await server.tools.delegate_agent({ resume_run_id: "run-poll-1" });

    expect(mockRunInvestigation).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/Still running/);
    expect(result.content[0].text).toContain("github_get_repo_topics(a, b)");
  });

  it("still includes the transcript on a fresh poll when show_transcript is explicitly false", async () => {
    const server = makeFakeServer();
    register(server);

    const result = await server.tools.delegate_agent({ resume_run_id: "run-poll-1", show_transcript: false });

    expect(mockRunInvestigation).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/Still running/);
    expect(result.content[0].text).toContain("github_get_repo_topics(a, b)");
  });
});
