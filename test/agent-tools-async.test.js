// ---------------------------------------------------------------------------
// test/agent-tools-async.test.js
//
// Covers the agent_tools.js branching logic: test/agent-worker.test.js and
// test/agent-delegate-async-checkpoint.test.js cover the worker endpoint and
// the underlying runInvestigation resume mechanics respectively, but neither
// exercises connectors/gemini/agent_tools.js's delegate_agent handler itself
// -- the branching (fresh start / poll-fresh / poll-stale-fallback / done /
// failed), gated by DELEGATE_AGENT_ASYNC + isQStashConfigured().
//
// Unlike agent-worker.test.js and agent-delegate-async-checkpoint.test.js
// (which wire up a real fake Redis to exercise genuine checkpoint
// round-trips), this file mocks agent_delegate.js/agent_checkpoint.js/
// qstash_client.js directly -- it's a handler-level unit test of the
// branching logic itself (same style as test/github-clone-token.test.js's
// makeFakeServer approach), not another pass at the checkpoint mechanics
// those other two files already cover end to end.
//
// config.js is mocked per-test (via vi.doMock + vi.resetModules(), not a
// single top-level vi.mock) specifically because DELEGATE_AGENT_ASYNC's
// value is exactly what's under test here -- some cases need "qstash",
// others the "sync" default -- and a static hoisted vi.mock can't vary
// per test.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal fake MCP server: just captures the handler function for the
// registered tool name so tests can call it directly (same pattern as
// test/github-clone-token.test.js).
function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

const mockRunInvestigation = vi.fn();
const mockSeedRun = vi.fn();
const mockLoadCheckpoint = vi.fn();
const mockPublishAgentStep = vi.fn();
const mockIsQStashConfigured = vi.fn();
const mockDoCreatePage = vi.fn();

async function setup({ delegateAgentAsync = "sync", pollFreshSeconds = 25 } = {}) {
  vi.resetModules();
  vi.clearAllMocks();

  vi.doMock("../config.js", () => ({
    GEMINI_NOTION_ROOT_PAGE_ID: "root-page-id",
    DELEGATE_AGENT_ASYNC: delegateAgentAsync,
    AGENT_ASYNC_POLL_FRESH_SECONDS: pollFreshSeconds,
  }));
  vi.doMock("../connectors/gemini/agent_delegate.js", () => ({
    runInvestigation: mockRunInvestigation,
    seedRun: mockSeedRun,
  }));
  vi.doMock("../connectors/gemini/agent_checkpoint.js", () => ({
    loadCheckpoint: mockLoadCheckpoint,
  }));
  vi.doMock("../connectors/gemini/qstash_client.js", () => ({
    publishAgentStep: mockPublishAgentStep,
    isQStashConfigured: mockIsQStashConfigured,
  }));
  vi.doMock("../connectors/notion/tools.js", () => ({
    doCreatePage: mockDoCreatePage,
  }));

  const { register } = await import("../connectors/gemini/agent_tools.js");
  const server = makeFakeServer();
  register(server);
  return server.tools.delegate_agent;
}

describe("agent_tools.js — delegate_agent async branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DELEGATE_AGENT_ASYNC unset (sync default): always calls runInvestigation synchronously, even with no resume_run_id, and never touches seedRun/publishAgentStep", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "sync" });
    mockIsQStashConfigured.mockReturnValue(true); // configured, but the flag itself is what gates this
    mockRunInvestigation.mockResolvedValue({ answer: "sync answer", steps: 3, transcript: [], runId: "r1" });

    const result = await delegate_agent({ task: "do a thing" });

    expect(mockSeedRun).not.toHaveBeenCalled();
    expect(mockPublishAgentStep).not.toHaveBeenCalled();
    expect(mockRunInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ task: "do a thing" })
    );
    expect(result.content[0].text).toContain("sync answer");
  });

  it("DELEGATE_AGENT_ASYNC=qstash but isQStashConfigured() is false: falls straight through to synchronous runInvestigation, same as sync mode", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash" });
    mockIsQStashConfigured.mockReturnValue(false);
    mockRunInvestigation.mockResolvedValue({ answer: "fell through", steps: 1, transcript: [], runId: "r2" });

    const result = await delegate_agent({ task: "investigate" });

    expect(mockSeedRun).not.toHaveBeenCalled();
    expect(mockRunInvestigation).toHaveBeenCalled();
    expect(result.content[0].text).toContain("fell through");
  });

  it("fresh async start (qstash configured, no resume_run_id): seeds the run, publishes step 0, and returns run_id immediately WITHOUT calling runInvestigation", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash" });
    mockIsQStashConfigured.mockReturnValue(true);
    mockSeedRun.mockResolvedValue("run-abc-123");
    mockPublishAgentStep.mockResolvedValue();

    const result = await delegate_agent({ task: "long investigation", model: "gemini-flash-latest", maxOutputTokens: 2048 });

    expect(mockSeedRun).toHaveBeenCalledWith(
      expect.objectContaining({ task: "long investigation", model: "gemini-flash-latest", maxOutputTokens: 2048 })
    );
    expect(mockPublishAgentStep).toHaveBeenCalledWith({ runId: "run-abc-123", afterStep: 0 });
    expect(mockRunInvestigation).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("run-abc-123");
    expect(result.content[0].text).toMatch(/resume_run_id/);
  });

  it("fresh async start: a seedRun/publish failure returns a clear error result instead of throwing", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash" });
    mockIsQStashConfigured.mockReturnValue(true);
    mockSeedRun.mockResolvedValue("run-xyz");
    mockPublishAgentStep.mockRejectedValue(new Error("QSTASH_TOKEN is not set"));

    const result = await delegate_agent({ task: "will fail to start" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to start async investigation/);
    expect(result.content[0].text).toMatch(/QSTASH_TOKEN is not set/);
    expect(mockRunInvestigation).not.toHaveBeenCalled();
  });

  it("poll with a fresh checkpoint (status running, lastStepAt within the fresh window): reports progress WITHOUT calling runInvestigation", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash", pollFreshSeconds: 25 });
    mockIsQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 3,
      lastStepAt: Date.now() - 5000, // 5s ago, well inside the 25s fresh window
      transcript: ["github_get_repo_topics(a, b)"],
    });

    const result = await delegate_agent({ resume_run_id: "run-poll-1" });

    expect(mockRunInvestigation).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Still running/);
    expect(result.content[0].text).toContain("3 step(s)");
    expect(result.content[0].text).toContain("github_get_repo_topics(a, b)");
  });

  // Fix (2026-08-31): a stale checkpoint used to ALWAYS fall through to a
  // synchronous runInvestigation call regardless of caller intent -- meaning
  // a plain status check (no max_steps, exactly what "just polling" looks
  // like) could silently trigger real additional steps the moment the
  // background worker chain happened to be stale. Split into two cases below:
  // no max_steps stays poll-only even when stale (reports the stall instead),
  // an explicit max_steps still pushes the run forward as before.
  it("poll with a stale checkpoint AND no max_steps passed: stays poll-only, reports the stall instead of falling through to runInvestigation", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash", pollFreshSeconds: 25 });
    mockIsQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 3,
      lastStepAt: Date.now() - 60000, // 60s ago, past the 25s fresh window
      transcript: ["github_get_repo_topics(a, b)"],
    });

    const result = await delegate_agent({ resume_run_id: "run-poll-2" });

    expect(mockRunInvestigation).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/stalled/);
    expect(result.content[0].text).toContain("3 step(s)");
    expect(result.content[0].text).toMatch(/explicit max_steps/);
    expect(result.content[0].text).toContain("github_get_repo_topics(a, b)");
  });

  it("poll with a stale checkpoint AND an explicit max_steps: falls through to synchronous runInvestigation, pushing the run forward", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash", pollFreshSeconds: 25 });
    mockIsQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "running",
      stepsDone: 3,
      lastStepAt: Date.now() - 60000, // 60s ago, past the 25s fresh window
      transcript: [],
    });
    mockRunInvestigation.mockResolvedValue({ answer: "resumed synchronously", steps: 4, transcript: [], runId: "run-poll-2" });

    const result = await delegate_agent({ resume_run_id: "run-poll-2", max_steps: 10 });

    expect(mockRunInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ resume_run_id: "run-poll-2", max_steps: 10 })
    );
    expect(result.content[0].text).toContain("resumed synchronously");
  });

  it("poll on a checkpoint with status 'failed' (dead-lettered): returns the permanent-failure message directly, without calling runInvestigation", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash" });
    mockIsQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({
      status: "failed",
      finalAnswer: "bad request -- not transient",
    });

    const result = await delegate_agent({ resume_run_id: "run-dead" });

    expect(mockRunInvestigation).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/failed permanently/);
    expect(result.content[0].text).toContain("bad request -- not transient");
  });

  it("poll on a checkpoint with status 'done': falls through to runInvestigation (which returns the stored answer without re-executing)", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash" });
    mockIsQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue({ status: "done", finalAnswer: "the stored answer" });
    mockRunInvestigation.mockResolvedValue({ answer: "the stored answer", steps: 7, transcript: [], runId: "run-done" });

    const result = await delegate_agent({ resume_run_id: "run-done" });

    expect(mockRunInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ resume_run_id: "run-done" })
    );
    expect(result.content[0].text).toContain("the stored answer");
  });

  it("poll on a missing/expired checkpoint: falls through to runInvestigation, which surfaces its own error", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash" });
    mockIsQStashConfigured.mockReturnValue(true);
    mockLoadCheckpoint.mockResolvedValue(null);
    mockRunInvestigation.mockRejectedValue(new Error("No checkpoint found for run-missing"));

    const result = await delegate_agent({ resume_run_id: "run-missing" });

    expect(mockRunInvestigation).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No checkpoint found/);
  });

  it("async poll path never calls loadCheckpoint on a fresh start (no resume_run_id) -- start and poll are mutually exclusive branches", async () => {
    const delegate_agent = await setup({ delegateAgentAsync: "qstash" });
    mockIsQStashConfigured.mockReturnValue(true);
    mockSeedRun.mockResolvedValue("run-fresh");
    mockPublishAgentStep.mockResolvedValue();

    await delegate_agent({ task: "fresh task" });

    expect(mockLoadCheckpoint).not.toHaveBeenCalled();
  });
});
