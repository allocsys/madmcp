// ---------------------------------------------------------------------------
// test/editor-delegate-diff-flag.test.js
//
// Loop-level coverage for how editor_delegate.js's write_file execute()
// decides whether to ask writeFile() to build a unified diff.
//
// The diff is NEVER shown to the model (write_file returns a one-line
// "Wrote ..." string). Its only consumer is the TypeSafe scoreEditRisk call,
// which runs only when TYPESAFE_ENABLED. So:
//   - TYPESAFE off -> includeDiff is left undefined (writeFile's own
//     EDITOR_INCLUDE_DIFF env gate decides; default off)
//   - TYPESAFE on  -> includeDiff: true, and scoreEditRisk receives the diff
//
// Separate file from editor-delegate.test.js because it needs config.js's
// TYPESAFE_ENABLED and the typesafe client mocked, which the main loop test
// deliberately leaves real.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const flags = vi.hoisted(() => ({ typesafe: false }));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get TYPESAFE_ENABLED() { return flags.typesafe; },
  };
});

vi.mock("../connectors/typesafe/client.js", () => ({
  scoreTaskComplexity: vi.fn(async () => ({ complexity: null, confidence: 0 })),
  scoreEditRisk: vi.fn(async () => ({ matchesTask: "yes", risk: 0.1, confidence: 0.9 })),
  stepBudgetForComplexity: vi.fn(() => null),
}));

vi.mock("../connectors/llm/router.js", () => ({
  providerChat: vi.fn(),
}));

vi.mock("../connectors/github/editor_tool_functions.js", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  assertNotDefaultBranch: vi.fn(async () => ({ default_branch: "main" })),
}));

vi.mock("../connectors/github/editor_validate.js", () => ({
  validateByExtension: vi.fn(async () => ({ valid: true })),
}));

vi.mock("../connectors/shared/cooldown.js", () => ({
  isRedisConfigured: vi.fn(() => true),
}));

const fakeCheckpoints = vi.hoisted(() => new Map());
vi.mock("../connectors/delegate/editor/editor_checkpoint.js", () => ({
  saveCheckpoint: vi.fn(async (runId, state) => { fakeCheckpoints.set(runId, state); }),
  loadCheckpoint: vi.fn(async (runId) => fakeCheckpoints.get(runId) ?? null),
  deleteCheckpoint: vi.fn(async (runId) => { fakeCheckpoints.delete(runId); }),
}));

import { providerChat } from "../connectors/llm/router.js";
import { writeFile } from "../connectors/github/editor_tool_functions.js";
import { scoreEditRisk } from "../connectors/typesafe/client.js";
import { runEditorAgent } from "../connectors/delegate/editor/editor_delegate.js";

const OWNER = "allocsys";
const REPO = "madmcp";
const BRANCH = "feature-branch";
const TASK = "change x to 2";

function functionCallCandidate(calls) {
  return { content: { role: "model", parts: calls.map(({ name, args }, i) => ({ functionCall: { name, args, id: `${name}-${i}` } })) } };
}

function textCandidate(text) {
  return { content: { role: "model", parts: [{ text }] } };
}

// One write_file step, then a final answer (plus the single-fire
// verification round that a draft answer with tools/budget left triggers).
function queueOneWriteRun() {
  providerChat.mockResolvedValueOnce(
    functionCallCandidate([{ name: "write_file", args: { path: "a.js", replacements: [{ find: "x = 1", replace: "x = 2" }] } }])
  );
  providerChat.mockResolvedValueOnce(textCandidate("Updated a.js."));
  providerChat.mockResolvedValueOnce(textCandidate("Confirmed -- updated a.js."));
  writeFile.mockResolvedValueOnce({
    path: "a.js", content: "const x = 2;", sha: "s", commitSha: "c1234567",
    diff: "--- a.js (before)\n+++ a.js (after)\n-const x = 1;\n+const x = 2;",
    created: false, noop: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeCheckpoints.clear();
  flags.typesafe = false;
});

describe("editor_delegate write_file -- diff opt-in", () => {
  it("does not request a diff from writeFile when TypeSafe risk scoring is off, and never scores", async () => {
    flags.typesafe = false;
    queueOneWriteRun();

    const result = await runEditorAgent({ owner: OWNER, repo: REPO, branch: BRANCH, task: TASK, max_steps: 5 });

    expect(result.writtenFiles).toEqual(["a.js"]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const options = writeFile.mock.calls[0][3];
    expect(options.includeDiff).toBeUndefined();
    expect(scoreEditRisk).not.toHaveBeenCalled();
  });

  it("requests a diff from writeFile and feeds it to scoreEditRisk when TypeSafe risk scoring is on", async () => {
    flags.typesafe = true;
    queueOneWriteRun();

    const result = await runEditorAgent({ owner: OWNER, repo: REPO, branch: BRANCH, task: TASK, max_steps: 5 });

    expect(result.writtenFiles).toEqual(["a.js"]);
    const options = writeFile.mock.calls[0][3];
    expect(options.includeDiff).toBe(true);
    expect(scoreEditRisk).toHaveBeenCalledTimes(1);
    expect(scoreEditRisk.mock.calls[0][0]).toBe(TASK);
    expect(scoreEditRisk.mock.calls[0][1]).toContain("+const x = 2;");
  });

  it("never puts the diff in the tool response the model sees, in either mode", async () => {
    flags.typesafe = true;
    queueOneWriteRun();

    await runEditorAgent({ owner: OWNER, repo: REPO, branch: BRANCH, task: TASK, max_steps: 5 });

    // providerChat's 2nd call carries the write_file functionResponse.
    const secondCallContents = providerChat.mock.calls[1][0];
    const serialized = JSON.stringify(secondCallContents);
    expect(serialized).toMatch(/Wrote a\.js \(commit c123456/);
    expect(serialized).not.toContain("(before)");
    expect(serialized).not.toContain("+const x = 2;");
  });
});
