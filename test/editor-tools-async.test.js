// ---------------------------------------------------------------------------
// test/editor-tools-async.test.js
//
// Covers connectors/github/editor_tools.js's async branching logic (plan.md
// Step 7): test/editor-worker.test.js and
// test/editor-delegate-async-checkpoint.test.js cover the worker endpoint
// and the underlying runEditorAgent resume mechanics respectively, but
// neither exercises editor_tools.js's delegate_editor handler itself --
// the branching (fresh start / poll-fresh / poll-stale-fallback / done /
// failed), gated by EDITOR_AGENT_ASYNC + isEditorQStashConfigured().
//
// Mirrors test/agent-tools-async.test.js's approach almost exactly: mocks
// editor_delegate.js/editor_checkpoint.js/qstash_client.js directly (a
// handler-level unit test of the branching logic itself), not another pass
// at the checkpoint mechanics the other two files already cover end to end.
//
// config.js is mocked per-test (via vi.doMock + vi.resetModules(), not a
// single top-level vi.mock) specifically because EDITOR_AGENT_ASYNC's value
// is exactly what's under test here -- some cases need "qstash", others the
// "sync" default -- and a static hoisted vi.mock can't vary per test. Every
// config export editor_tools.js reads (including the ones only used to
// build the tool description, e.g. EDITOR_ALLOWED_EXTENSIONS) must be
// present in the mock or register() will throw before a handler is ever
// obtained.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal fake MCP server: just captures the handler function for the
// registered tool name so tests can call it directly (same pattern as
// test/agent-tools-async.test.js / test/github-clone-token.test.js).
function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

const mockRunEditorAgent = vi.fn();
const mockSeedEditorRun = vi.fn();
const mockLoadCheckpoint = vi.fn();
const mockPublishEditorStep = vi.fn();
const mockIsEditorQStashConfigured = vi.fn();

async function setup({ editorAgentAsync = "sync", pollFreshSeconds = 60, stepDeadSeconds = 120 } = {}) {
  vi.resetModules();
  vi.clearAllMocks();

  vi.doMock("../config.js", () => ({
    DEFAULT_OWNER: "allocsys",
    EDITOR_ALLOWED_EXTENSIONS: [".js", ".md"],
    EDITOR_ALLOWED_PATH_PREFIXES: [],
    EDITOR_DEFAULT_STEPS: 15,
    EDITOR_HARD_MAX_STEPS: 24,
    EDITOR_MAX_FILES_PER_RUN: 15,
    EDITOR_MAX_WRITES_PER_FILE: 5,
    EDITOR_AGENT_ENABLED: true,
    EDITOR_AGENT_ASYNC: editorAgentAsync,
    EDITOR_ASYNC_POLL_FRESH_SECONDS: pollFreshSeconds,
    EDITOR_ASYNC_STEP_DEAD_SECONDS: stepDeadSeconds,
  }));
  vi.doMock("../connectors/github/editor_delegate.js", () => ({
    runEditorAgent: mockRunEditorAgent,
    seedEditorRun: mockSeedEditorRun,
  }));
  vi.doMock("../connectors/github/editor_checkpoint.js", () => ({
    loadCheckpoint: mockLoadCheckpoint,
  }));
  vi.doMock("../connectors/delegate/qstash_client.js", () => ({
    publishEditorStep: mockPublishEditorStep,
    isEditorQStashConfigured: mockIsEditorQStashConfigured,
  }));

  const { register } = await import("../connectors/github/editor_tools.js");
  const server = makeFakeServer();
  register(server);
  return server.tools.delegate_editor;
}

describe("editor_tools.js — delegate_editor async branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("EDITOR_AGENT_ASYNC unset/sync (default): always calls runEditorAgent synchronously, even with no resume_run_id, and never touches seedEditorRun/publishEditorStep", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "sync" });
    mockIsEditorQStashConfigured.mockReturnValue(true); // configured, but the flag itself is what gates this
    mockRunEditorAgent.mockResolvedValue({ answer: "sync answer", steps: 3, transcript: [], runId: "r1", writtenFiles: [] });

    const result = await delegate_editor({ repo: "madmcp", branch: "feat/x", task: "do a thing" });

    expect(mockSeedEditorRun).not.toHaveBeenCalled();
    expect(mockPublishEditorStep).not.toHaveBeenCalled();
    expect(mockRunEditorAgent).toHaveBeenCalledWith(
      expect.objectContaining({ task: "do a thing", branch: "feat/x" })
    );
    expect(result.content[0].text).toContain("sync answer");
  });

  it("EDITOR_AGENT_ASYNC=qstash but isEditorQStashConfigured() is false: falls straight through to synchronous runEditorAgent, same as sync mode", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash" });
    mockIsEditorQStashConfigured.mockReturnValue(false);
    mockRunEditorAgent.mockResolvedValue({ answer: "fell through", steps: 1, transcript: [], runId: "r2", writtenFiles: [] });

    const result = await delegate_editor({ repo: "madmcp", branch: "feat/x", task: "edit something" });

    expect(mockSeedEditorRun).not.toHaveBeenCalled();
    expect(mockRunEditorAgent).toHaveBeenCalled();
    expect(result.content[0].text).toContain("fell through");
  });

  it("fresh async start (qstash configured, no resume_run_id): seeds the run, publishes step 0, and returns run_id immediately WITHOUT calling runEditorAgent", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash" });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockSeedEditorRun.mockResolvedValue("run-abc-123");
    mockPublishEditorStep.mockResolvedValue();

    const result = await delegate_editor({ repo: "madmcp", branch: "feat/x", task: "long edit job", max_steps: 10 });

    expect(mockSeedEditorRun).toHaveBeenCalledWith(
      expect.objectContaining({ task: "long edit job", branch: "feat/x", max_steps: 10 })
    );
    expect(mockPublishEditorStep).toHaveBeenCalledWith({ runId: "run-abc-123", afterStep: 0 });
    expect(mockRunEditorAgent).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("run-abc-123");
    expect(result.content[0].text).toMatch(/resume_run_id/);
  });

  it("fresh async start: a seedEditorRun/publish failure returns a clear error result instead of throwing", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash" });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockSeedEditorRun.mockResolvedValue("run-xyz");
    mockPublishEditorStep.mockRejectedValue(new Error("QSTASH_TOKEN is not set"));

    const result = await delegate_editor({ repo: "madmcp", branch: "feat/x", task: "will fail to start" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to start async run/);
    expect(result.content[0].text).toMatch(/QSTASH_TOKEN is not set/);
    expect(mockRunEditorAgent).not.toHaveBeenCalled();
  });

  it("poll with a fresh checkpoint (status running, lastStepAt within the fresh window): reports progress WITHOUT calling runEditorAgent", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash", pollFreshSeconds: 25 });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 3,
      lastStepAt: Date.now() - 5000, // 5s ago, well inside the 25s fresh window
      writtenFiles: ["a.md"],
    });

    const result = await delegate_editor({ resume_run_id: "run-poll-1" });

    expect(mockRunEditorAgent).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Still running/);
    expect(result.content[0].text).toContain("3 step(s)");
    expect(result.content[0].text).toContain("a.md");
  });

  it("poll with a checkpoint fresh via stepStartedAt alone (with no newly-completed step): is NOT reported as stalled", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash", pollFreshSeconds: 25, stepDeadSeconds: 120 });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 2,
      lastStepAt: Date.now() - 120000, // 2 minutes ago (stale if lastStepAt alone)
      stepStartedAt: Date.now() - 10000, // 10s ago, step in-flight and fresh
      writtenFiles: [],
    });

    const result = await delegate_editor({ resume_run_id: "run-poll-started" });

    expect(mockRunEditorAgent).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Still running/);
    expect(result.content[0].text).toContain("2 step(s)");
  });

  it("poll with a checkpoint whose stepStartedAt is older than the long-ceiling constant (EDITOR_ASYNC_STEP_DEAD_SECONDS): IS reported as stalled even though stepStartedAt is set", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash", pollFreshSeconds: 25, stepDeadSeconds: 50 });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 2,
      lastStepAt: Date.now() - 200000,
      stepStartedAt: Date.now() - 70000, // 70s ago, older than 50s dead ceiling (stuck worker crash case)
      writtenFiles: [],
    });

    const result = await delegate_editor({ resume_run_id: "run-poll-stuck" });

    expect(mockRunEditorAgent).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/stalled/);
    expect(result.content[0].text).toMatch(/explicit max_steps/);
  });

  it("poll with a stale checkpoint AND no max_steps passed: stays poll-only, reports the stall instead of falling through to runEditorAgent (never triggers an unintended write)", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash", pollFreshSeconds: 25 });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 3,
      lastStepAt: Date.now() - 60000, // 60s ago, past the 25s fresh window
      writtenFiles: ["a.md"],
    });

    const result = await delegate_editor({ resume_run_id: "run-poll-2" });

    expect(mockRunEditorAgent).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/stalled/);
    expect(result.content[0].text).toContain("3 step(s)");
    expect(result.content[0].text).toMatch(/explicit max_steps/);
    expect(result.content[0].text).toContain("a.md");
  });

  it("poll with a stale checkpoint AND an explicit max_steps: falls through to synchronous runEditorAgent, pushing the run forward (can make further writes)", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash", pollFreshSeconds: 25 });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 3,
      lastStepAt: Date.now() - 60000, // 60s ago, past the 25s fresh window
      writtenFiles: [],
    });
    mockRunEditorAgent.mockResolvedValue({ answer: "resumed synchronously", steps: 4, transcript: [], runId: "run-poll-2", writtenFiles: [] });

    const result = await delegate_editor({ resume_run_id: "run-poll-2", max_steps: 10 });

    expect(mockRunEditorAgent).toHaveBeenCalledWith(
      expect.objectContaining({ resume_run_id: "run-poll-2", max_steps: 10 })
    );
    expect(result.content[0].text).toContain("resumed synchronously");
  });

  it("poll on a checkpoint with status 'failed' (dead-lettered): returns the permanent-failure message directly, without calling runEditorAgent", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash" });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "failed",
      finalAnswer: "bad request -- not transient",
      writtenFiles: ["a.md"],
    });

    const result = await delegate_editor({ resume_run_id: "run-dead" });

    expect(mockRunEditorAgent).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/failed permanently/);
    expect(result.content[0].text).toContain("bad request -- not transient");
    expect(result.content[0].text).toContain("a.md");
  });

  it("poll on a checkpoint with status 'done': falls through to runEditorAgent (which returns the stored answer without re-executing)", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash" });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({ status: "done", finalAnswer: "the stored answer", writtenFiles: [] });
    mockRunEditorAgent.mockResolvedValue({ answer: "the stored answer", steps: 7, transcript: [], runId: "run-done", writtenFiles: [] });

    const result = await delegate_editor({ resume_run_id: "run-done" });

    expect(mockRunEditorAgent).toHaveBeenCalledWith(
      expect.objectContaining({ resume_run_id: "run-done" })
    );
    expect(result.content[0].text).toContain("the stored answer");
  });

  it("poll on a missing/expired checkpoint: falls through to runEditorAgent, which surfaces its own error", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash" });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue(null);
    mockRunEditorAgent.mockRejectedValue(new Error("No checkpoint found for run-missing"));

    const result = await delegate_editor({ resume_run_id: "run-missing" });

    expect(mockRunEditorAgent).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No checkpoint found/);
  });

  it("async poll path never calls loadCheckpoint on a fresh start (no resume_run_id) -- start and poll are mutually exclusive branches", async () => {
    const delegate_editor = await setup({ editorAgentAsync: "qstash" });
    mockIsEditorQStashConfigured.mockReturnValue(true);
    mockSeedEditorRun.mockResolvedValue("run-fresh");
    mockPublishEditorStep.mockResolvedValue();

    await delegate_editor({ repo: "madmcp", branch: "feat/x", task: "fresh task" });

    expect(mockLoadCheckpoint).not.toHaveBeenCalled();
  });
});
