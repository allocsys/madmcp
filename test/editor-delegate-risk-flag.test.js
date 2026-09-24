// ---------------------------------------------------------------------------
// test/editor-delegate-risk-flag.test.js
//
// Loop-level coverage for the caller-facing TypeSafe risk flag:
// EDITOR_RISK_FLAG_THRESHOLD (config.js) gates whether write_file records a
// {path, risk, matchesTask, confidence, commitSha} entry in `riskFlags` and a
// `[risk] ...` transcript line. The flag is caller-only: it must never reach
// the string write_file returns (the model's functionResponse), and it must
// survive checkpoint save/resume and appear on failed results too.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const flags = vi.hoisted(() => ({ typesafe: true, threshold: 0.7 }));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get TYPESAFE_ENABLED() { return flags.typesafe; },
    get EDITOR_RISK_FLAG_THRESHOLD() { return flags.threshold; },
  };
});

vi.mock("../connectors/typesafe/client.js", () => ({
  scoreTaskComplexity: vi.fn(async () => ({ complexity: null, confidence: 0 })),
  scoreEditRisk: vi.fn(),
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
  saveCheckpoint: vi.fn(async (runId, state) => { fakeCheckpoints.set(runId, JSON.parse(JSON.stringify(state))); }),
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

function queueWrite() {
  providerChat.mockResolvedValueOnce(
    functionCallCandidate([{ name: "write_file", args: { path: "a.js", replacements: [{ find: "x = 1", replace: "x = 2" }] } }])
  );
  writeFile.mockResolvedValueOnce({
    path: "a.js", content: "const x = 2;", sha: "s", commitSha: "c1234567890",
    diff: "--- a.js (before)\n+++ a.js (after)\n-const x = 1;\n+const x = 2;",
    created: false, noop: false,
  });
}

// One write, then a final answer (plus the single verification round a draft
// answer with tools/budget left triggers).
function queueOneWriteRun() {
  queueWrite();
  providerChat.mockResolvedValueOnce(textCandidate("Updated a.js."));
  providerChat.mockResolvedValueOnce(textCandidate("Confirmed -- updated a.js."));
}

const run = (extra = {}) => runEditorAgent({ owner: OWNER, repo: REPO, branch: BRANCH, task: TASK, max_steps: 5, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  fakeCheckpoints.clear();
  flags.typesafe = true;
  flags.threshold = 0.7;
  scoreEditRisk.mockResolvedValue({ matchesTask: "no", risk: 0.9, confidence: 0.8 });
});

describe("editor_delegate write_file -- risk flag threshold", () => {
  it("records a flag and a [risk] transcript line when risk is at or above the threshold", async () => {
    scoreEditRisk.mockResolvedValue({ matchesTask: "no", risk: 0.7, confidence: 0.8 });
    queueOneWriteRun();

    const result = await run();

    expect(result.riskFlags).toEqual([
      { path: "a.js", risk: 0.7, matchesTask: "no", confidence: 0.8, commitSha: "c1234567890" },
    ]);
    const line = result.transcript.find((l) => typeof l === "string" && l.startsWith("[risk]"));
    expect(line).toContain('"a.js"');
    expect(line).toContain("commit c123456");
    expect(line).toContain("risk=0.70");
    expect(line).toContain("confidence=0.80");
  });

  it("records nothing when risk is below the threshold", async () => {
    scoreEditRisk.mockResolvedValue({ matchesTask: "yes", risk: 0.69, confidence: 0.9 });
    queueOneWriteRun();

    const result = await run();

    expect(scoreEditRisk).toHaveBeenCalledTimes(1);
    expect(result.riskFlags).toEqual([]);
    expect(result.transcript.some((l) => typeof l === "string" && l.startsWith("[risk]"))).toBe(false);
  });

  it("flags every scored write when the threshold is 0", async () => {
    flags.threshold = 0;
    scoreEditRisk.mockResolvedValue({ matchesTask: "yes", risk: 0.01, confidence: 0.9 });
    queueOneWriteRun();

    const result = await run();

    expect(result.riskFlags).toHaveLength(1);
    expect(result.riskFlags[0].risk).toBe(0.01);
  });

  it("never flags when risk is null, even at threshold 0", async () => {
    flags.threshold = 0;
    scoreEditRisk.mockResolvedValue({ matchesTask: "yes", risk: null, confidence: 0.9 });
    queueOneWriteRun();

    const result = await run();

    expect(result.riskFlags).toEqual([]);
  });

  it("does not flag (or score) when TypeSafe is off", async () => {
    flags.typesafe = false;
    queueOneWriteRun();

    const result = await run();

    expect(scoreEditRisk).not.toHaveBeenCalled();
    expect(result.riskFlags).toEqual([]);
  });

  it("keeps the flag and a placeholder when confidence is null or missing", async () => {
    for (const confidence of [null, undefined]) {
      fakeCheckpoints.clear();
      vi.clearAllMocks();
      scoreEditRisk.mockResolvedValue({ matchesTask: "no", risk: 0.95, confidence });
      queueOneWriteRun();

      const result = await run();

      expect(result.riskFlags).toHaveLength(1);
      expect(result.riskFlags[0].risk).toBe(0.95);
      const line = result.transcript.find((l) => typeof l === "string" && l.startsWith("[risk]"));
      expect(line).toContain("confidence=n/a");
    }
  });
});

describe("editor_delegate write_file -- model isolation", () => {
  it("never shows the flag to the model, and the write_file response is identical flagged or not", async () => {
    scoreEditRisk.mockResolvedValue({ matchesTask: "no", risk: 0.99, confidence: 0.8 });
    queueOneWriteRun();
    await run();
    const flaggedContents = JSON.stringify(providerChat.mock.calls.map((c) => c[0]));

    fakeCheckpoints.clear();
    vi.clearAllMocks();
    scoreEditRisk.mockResolvedValue({ matchesTask: "yes", risk: 0.05, confidence: 0.8 });
    queueOneWriteRun();
    await run();
    const unflaggedContents = JSON.stringify(providerChat.mock.calls.map((c) => c[0]));

    expect(flaggedContents).not.toContain("[risk]");
    expect(flaggedContents).not.toContain("flagged");
    expect(flaggedContents).not.toContain("0.99");
    // Same conversation shape either way: the flag can't have altered what the model saw.
    // runId differs per run but isn't part of `contents`.
    expect(flaggedContents).toBe(unflaggedContents);
  });
});

describe("editor_delegate -- riskFlags persistence", () => {
  it("returns riskFlags on a failed result and saves them in the checkpoint", async () => {
    queueWrite();
    providerChat.mockRejectedValueOnce(new Error("provider down"));

    const result = await run();

    expect(result.failed).toBe(true);
    expect(result.riskFlags).toHaveLength(1);
    const saved = fakeCheckpoints.get(result.runId);
    expect(saved.riskFlags).toEqual(result.riskFlags);
  });

  it("restores riskFlags from the checkpoint on resume and keeps appending to them", async () => {
    queueWrite();
    providerChat.mockRejectedValueOnce(new Error("provider down"));
    const first = await run();
    expect(first.failed).toBe(true);

    // Resumed run: model finishes without further writes.
    providerChat.mockResolvedValueOnce(textCandidate("Updated a.js."));
    providerChat.mockResolvedValueOnce(textCandidate("Confirmed -- updated a.js."));
    const resumed = await runEditorAgent({ resume_run_id: first.runId, max_steps: 5 });

    expect(resumed.failed).toBe(false);
    expect(resumed.riskFlags).toEqual(first.riskFlags);
    expect(resumed.riskFlags[0].path).toBe("a.js");
  });
});
