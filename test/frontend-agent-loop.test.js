// ---------------------------------------------------------------------------
// test/frontend-agent-loop.test.js
//
// Integration coverage for connectors/frontend/agent.js's runDesignAgent
// loop (delegate_designer v2, issue #61) -- specifically steps 3 ("checkpoint
// migration") and 4 ("conflict-handling validation: reproduce the #59
// scenario ... against the new write_file") from the Notion design doc.
//
// Step 1's test/frontend-agent-tools.test.js already covers write_file's 409
// -> `.conflict = true` relabeling in isolation. What that test can't cover
// is the specific #59 shape: a run that reads a file, gets interrupted
// (checkpointed), resumes, and only THEN tries to write -- proving the sha
// captured at read time survives the checkpoint/resume round-trip unchanged
// (not silently re-fetched/refreshed on resume) and that a stale-sha
// rejection at that point surfaces as a normal, reactable tool error rather
// than a thrown exception that kills the run or a silent overwrite.
//
// geminiChat, the three tool functions, the checkpoint module, and
// isRedisConfigured are all mocked -- this is a loop-logic test, not a live
// Gemini/GitHub/Redis test (same boundary as delegate.js has no dedicated
// test of its own; this fills the equivalent gap for the write-capable v2
// loop specifically because of the #59 history behind it).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/gemini/client.js", () => ({
  geminiChat: vi.fn(),
}));

vi.mock("../connectors/frontend/agent_tools.js", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("../connectors/gemini/cooldown.js", () => ({
  isRedisConfigured: vi.fn(() => true),
}));

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(async () => ({ default_branch: "main" })),
}));

// In-memory fake standing in for Redis -- same {save,load,delete} contract
// as connectors/frontend/agent_checkpoint.js, just backed by a Map instead
// of an actual Upstash client, so the test can drive an interrupt+resume
// cycle deterministically without a real Redis.
// vi.hoisted is required here (not a plain top-level const): vi.mock
// factories run at module-eval time, which is BEFORE a regular top-level
// `const` statement below this point would have executed -- referencing
// fakeCheckpoints directly from the factory without vi.hoisted would hit
// the temporal dead zone.
const fakeCheckpoints = vi.hoisted(() => new Map());
vi.mock("../connectors/frontend/agent_checkpoint.js", () => ({
  saveCheckpoint: vi.fn(async (runId, state) => { fakeCheckpoints.set(runId, state); }),
  loadCheckpoint: vi.fn(async (runId) => fakeCheckpoints.get(runId) ?? null),
  deleteCheckpoint: vi.fn(async (runId) => { fakeCheckpoints.delete(runId); }),
}));

import { geminiChat } from "../connectors/gemini/client.js";
import { readFile, writeFile } from "../connectors/frontend/agent_tools.js";
import { runDesignAgent } from "../connectors/frontend/agent.js";

const OWNER = "allocsys";
const REPO = "madmcp";
const BRANCH = "feature-branch";

function functionCallCandidate(name, args, id = `${name}-1`) {
  return { content: { role: "model", parts: [{ functionCall: { name, args, id } }] } };
}

function textCandidate(text) {
  return { content: { role: "model", parts: [{ text }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeCheckpoints.clear();
});

describe("runDesignAgent -- #59 reproduction across an interrupt/resume cycle", () => {
  it("carries the read-time sha through a checkpoint/resume unchanged, and surfaces a stale write as a reactable error instead of a silent overwrite or a crashed run", async () => {
    // Step 1: model reads a.html, getting back sha "sha-A" -- this is the
    // sha #59 needs to survive intact all the way to the eventual write.
    readFile.mockResolvedValueOnce({ path: "a.html", content: "<div>old</div>", sha: "sha-A" });
    geminiChat.mockResolvedValueOnce(functionCallCandidate("read_file", { path: "a.html" }, "call-1"));

    // Step 2: simulate the run getting interrupted by a transient Gemini
    // error right after the read -- this is what forces a checkpoint save
    // and a resume, rather than the whole conversation staying in one
    // in-process call (the actual #59 bug only manifests across that gap).
    const transientErr = new Error("Gemini API error (429): rate limited");
    transientErr.status = 429;
    geminiChat.mockRejectedValueOnce(transientErr);

    const firstResult = await runDesignAgent({
      owner: OWNER, repo: REPO, branch: BRANCH, task: "Update a.html",
    });

    expect(firstResult.failed).toBe(true);
    expect(firstResult.runId).toBeTruthy();
    expect(fakeCheckpoints.has(firstResult.runId)).toBe(true);
    // The checkpointed conversation must still contain the original sha as
    // plain text (it was never stored/extracted separately) -- if this
    // assertion ever fails, the checkpoint schema changed in a way that
    // could drop it.
    const checkpointedText = JSON.stringify(fakeCheckpoints.get(firstResult.runId).contents);
    expect(checkpointedText).toContain("sha-A");

    // Step 3 (resumed run): the model, now seeing its own earlier read_file
    // result again from the restored conversation, tries to write back with
    // base_sha "sha-A" -- exactly what it read, not a freshly re-fetched
    // sha. Simulate that the file was changed by someone else in the
    // meantime: writeFile (already unit-tested to do this for real against
    // a genuine 409 in frontend-agent-tools.test.js) rejects with a labeled
    // conflict error.
    const conflictErr = new Error(
      'Write conflict on "a.html": the file changed on "feature-branch" since it was read (base_sha sha-A is stale). ' +
      "Re-read the file and retry instead of overwriting blindly. Original error: GitHub API error (409): sha does not match"
    );
    conflictErr.conflict = true;
    writeFile.mockRejectedValueOnce(conflictErr);
    geminiChat.mockResolvedValueOnce(functionCallCandidate(
      "write_file",
      { path: "a.html", content: "<div>new</div>", base_sha: "sha-A" },
      "call-2"
    ));
    // Step 4: after seeing the conflict as a normal tool result, the model
    // gives its final plain-text answer instead of the loop crashing.
    geminiChat.mockResolvedValueOnce(textCandidate("Write conflicted, stopping to let the human decide how to reconcile."));

    const resumedResult = await runDesignAgent({ resume_run_id: firstResult.runId });

    // The critical assertion: write_file was called with EXACTLY the sha
    // read before the interruption, proving the checkpoint/resume round-trip
    // didn't drop or silently refresh it.
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][3].baseSha).toBe("sha-A");

    // The conflict must reach the model as a normal (reactable) tool result,
    // not as a thrown exception that aborts the run.
    expect(resumedResult.failed).toBeFalsy();
    expect(resumedResult.answer).toMatch(/stopping to let the human decide/i);
    expect(resumedResult.transcript.some((line) => line.includes("write_file") && line.includes("Write conflict") && line.includes("sha-A"))).toBe(true);

    // And the checkpoint was cleaned up once the run reached a final answer.
    expect(fakeCheckpoints.has(resumedResult.runId)).toBe(false);
  });

  it("does NOT reuse stale content silently when the write succeeds cleanly (control case, no conflict)", async () => {
    readFile.mockResolvedValueOnce({ path: "b.html", content: "<p>1</p>", sha: "sha-B" });
    geminiChat.mockResolvedValueOnce(functionCallCandidate("read_file", { path: "b.html" }, "call-1"));
    writeFile.mockResolvedValueOnce({ path: "b.html", content: "<p>2</p>", sha: "sha-B2", commitSha: "commit1" });
    geminiChat.mockResolvedValueOnce(functionCallCandidate(
      "write_file",
      { path: "b.html", content: "<p>2</p>", base_sha: "sha-B" },
      "call-2"
    ));
    geminiChat.mockResolvedValueOnce(textCandidate("Done."));

    const result = await runDesignAgent({ owner: OWNER, repo: REPO, branch: BRANCH, task: "Update b.html" });

    expect(writeFile.mock.calls[0][3].baseSha).toBe("sha-B");
    expect(result.failed).toBeFalsy();
    expect(result.writtenFiles).toEqual(["b.html"]);
  });

  it("refuses to run against the default branch before ever calling a tool", async () => {
    await expect(runDesignAgent({ owner: OWNER, repo: REPO, branch: "main", task: "x" }))
      .rejects.toThrow(/default branch/i);
    expect(geminiChat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
