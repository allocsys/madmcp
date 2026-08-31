import { describe, it, expect, vi } from "vitest";
import { compactHistoryInPlace, findUnverifiedClaims, BULKY_TOOL_NAMES, lineIsVerbatimInToolResults } from "../connectors/gemini/agent_delegate.js";

// Minimal in-memory fake of the @upstash/redis surface agent_checkpoint.js
// uses, same shape as test/agent-checkpoint.test.js's makeFakeRedis --
// needed locally because vi.mock is scoped per test file in Vitest; the
// mock declared in test/agent-checkpoint.test.js does not carry over here.
function makeFakeRedis() {
  const lists = new Map();
  const strings = new Map();
  return {
    async rpush(key, ...vals) {
      const list = lists.get(key) || [];
      list.push(...vals);
      lists.set(key, list);
      return list.length;
    },
    async expire() { return 1; },
    async set(key, val) { strings.set(key, val); return "OK"; },
    async get(key) { return strings.has(key) ? strings.get(key) : null; },
    async lrange(key) { return lists.get(key) || []; },
    async del(key) { lists.delete(key); strings.delete(key); return 1; },
    async mget(...keys) { return keys.map((k) => (strings.has(k) ? strings.get(k) : null)); },
    // Test-only introspection hook (not part of the real @upstash/redis
    // surface): lets a test inspect the literal raw string written for a
    // key, rather than only what loadCheckpoint's parsed return shape
    // reflects. Used by the meta-flatness test below.
    _strings: strings,
  };
}

const fakeRedis = makeFakeRedis();
vi.mock("../connectors/gemini/cooldown.js", () => ({
  getRedis: () => fakeRedis,
}));

describe("History Compaction Feature & Verification (agent_delegate.js)", () => {
  it("compacts older bulky tool results and uses dedicated store", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    const preCompactionResults = new Map();
    // step 5, provider "bai"
    compactHistoryInPlace(contents, 5, preCompactionResults, { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("Earlier tool result compacted");
    expect(preCompactionResults.get("call_1")).toBe(longText);
  });

  it("ensures claims grounded in compacted tool results verify successfully via pre-compaction capture", async () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    const preCompactionResults = new Map();
    compactHistoryInPlace(contents, 5, preCompactionResults, { provider: "bai" });

    // Raw functionResponse text has now been replaced
    expect(contents[2].parts[0].functionResponse.response.result).not.toContain("SECRET_TOKEN_XYZ_123");

    // Verify claim
    const claims = ["SECRET_TOKEN_XYZ_123", "FABRICATED_CLAIM_999"];
    const unverified = await findUnverifiedClaims(claims, contents, preCompactionResults);

    expect(unverified).toEqual(["FABRICATED_CLAIM_999"]);
  });

  it("test round-trip serialization pattern for preCompactionResults", () => {
    const preCompactionResults = new Map([
        ["id1", "content1"],
        ["id2", "content2"]
    ]);

    // Save pattern
    const savedObj = Object.fromEntries(preCompactionResults);
    
    // Restore pattern
    const restoredMap = new Map(Object.entries(savedObj));

    expect(restoredMap.size).toBe(2);
    expect(restoredMap.get("id1")).toBe("content1");
    expect(restoredMap.get("id2")).toBe("content2");
  });

  it("leaves contents completely untouched when provider is gemini (default, compaction disabled)", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(contents));

    compactHistoryInPlace(contents, 10, new Map(), { provider: "gemini" });

    expect(contents).toEqual(snapshot);
  });

  it("never compacts non-bulky tool results regardless of turn age", () => {
    expect(BULKY_TOOL_NAMES.has("github_get_commit")).toBe(false);
    const longText = "COMMIT_DATA_ABC " + "B".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_get_commit", args: { repo: "foo", sha: "abc1234" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_get_commit", id: "call_1", response: { result: longText } } }] },
    ];

    compactHistoryInPlace(contents, 10, new Map(), { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("COMMIT_DATA_ABC");
    expect(result).not.toContain("Earlier tool result compacted");
  });

  it("includes the target file path argument in the compacted summary text", () => {
    const longText = "SECRET_TOKEN_XYZ_123 " + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/secret.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: longText } } }] },
    ];

    compactHistoryInPlace(contents, 5, new Map(), { provider: "bai" });

    const result = contents[2].parts[0].functionResponse.response.result;
    expect(result).toContain("Earlier tool result compacted");
    expect(result).toContain("src/secret.js");
  });

  it("Window-boundary contract test", () => {
    const contents = [];
    for (let i = 1; i <= 4; i++) {
        contents.push({ role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "file" + i }, id: "c" + i } }] });
        contents.push({ role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "c" + i, response: { result: `PAYLOAD_${i}_` + "X".repeat(600) } } }] });
    }
    
    // Call with currentStep 4 (3 completed steps) - nothing compacted (3 steps full)
    const map1 = new Map();
    compactHistoryInPlace(contents, 4, map1, { provider: "bai" });
    for (let i = 1; i <= 4; i++) {
        expect(contents[i*2-1].parts[0].functionResponse.response.result).toContain(`PAYLOAD_${i}_`);
    }

    // Call with currentStep 5 (4 completed steps) - step 1 compacted
    const map2 = new Map();
    compactHistoryInPlace(contents, 5, map2, { provider: "bai" });
    expect(contents[1].parts[0].functionResponse.response.result).toContain("Earlier tool result compacted"); // Step 1
    for (let i = 2; i <= 4; i++) {
        expect(contents[i*2-1].parts[0].functionResponse.response.result).toContain(`PAYLOAD_${i}_`);
    }
  });

  it("Id-collision safety test", () => {
    const contents = [
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "1" }, id: "call_1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: "TEXT_A" + "X".repeat(600) } } }] },
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "2" }, id: "call_1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: "TEXT_B" + "X".repeat(600) } } }] },
    ];
    const preCompactionResults = new Map();
    compactHistoryInPlace(contents, 10, preCompactionResults, { provider: "bai" });

    const values = Array.from(preCompactionResults.values());
    expect(values.length).toBe(2);
    expect(values).toContain("TEXT_A" + "X".repeat(600));
    expect(values).toContain("TEXT_B" + "X".repeat(600));
  });

  it("Checkpoint-round-trip recompaction test", () => {
    const originalText = "BULKY_TEXT_" + "X".repeat(600);
    const contents = [
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "f" }, id: "c1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "c1", response: { result: originalText } } }] },
    ];

    // Compact once
    const map1 = new Map();
    compactHistoryInPlace(contents, 10, map1, { provider: "bai" });
    expect(contents[1].parts[0].functionResponse.response.result).toContain("Earlier tool result compacted");

    // Reconstruct round-tripped
    const roundTrippedContents = JSON.parse(JSON.stringify(contents));
    // The bug: roundTrippedContents would be full text
    // Simulate what happens in Redis (the original text IS in the round-tripped version)
    // Actually, in the code, JSON.parse(JSON.stringify(contents)) results in the compacted text.
    // The requirement says: simulate what loadCheckpoint reconstructs - original, never-recompacted turn.
    const restoredContents = [
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "f" }, id: "c1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "c1", response: { result: originalText } } }] },
    ];
    
    // Compact again
    const map2 = new Map();
    compactHistoryInPlace(restoredContents, 10, map2, { provider: "bai" });
    expect(restoredContents[1].parts[0].functionResponse.response.result).toContain("Earlier tool result compacted");
    expect(map2.get("c1")).toBe(originalText);
  });

  it("lineIsVerbatimInToolResults: does not false-positive on a correct quote that has been compacted out of contents (regression)", async () => {
    const exactLine = "if (step < cappedSteps) {";
    const bulkyPayload = exactLine + "\n" + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/exact.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: bulkyPayload } } }] },
    ];

    const preCompactionResults = new Map();
    compactHistoryInPlace(contents, 5, preCompactionResults, { provider: "bai" });

    // Assert contents no longer contains the exact line (confirms it was actually compacted)
    expect(contents[2].parts[0].functionResponse.response.result).not.toContain(exactLine);

    // Assert lineIsVerbatimInToolResults returns true with preCompactionResults
    expect(await lineIsVerbatimInToolResults(exactLine, contents, preCompactionResults)).toBe(true);

    // Assert lineIsVerbatimInToolResults returns false with NO third argument (empty Map / pre-fix behavior)
    expect(await lineIsVerbatimInToolResults(exactLine, contents)).toBe(false);
  });

  it("lineIsVerbatimInToolResults: still correctly flags a fabricated quote as unverifiable after compaction (true-positive still works)", async () => {
    const exactLine = "if (step < cappedSteps) {";
    const bulkyPayload = exactLine + "\n" + "A".repeat(1000);
    const contents = [
      { role: "user", parts: [{ text: "initial prompt" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "foo", path: "src/exact.js" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: bulkyPayload } } }] },
    ];

    const preCompactionResults = new Map();
    compactHistoryInPlace(contents, 5, preCompactionResults, { provider: "bai" });

    // Assert fabricated quote is correctly flagged as false (unverifiable) even with preCompactionResults
    expect(await lineIsVerbatimInToolResults("this line was never in any tool result", contents, preCompactionResults)).toBe(false);
  });

  it("integration test: checkpoint save/load correctly round-trips contents and preCompactionResults", async () => {
    // Uses this file's own fakeRedis mock (see top of file) via the real
    // saveCheckpoint/loadCheckpoint persistence functions -- not manually
    // invoked compaction on hand-built arrays like the tests above.
    const { saveCheckpoint, loadCheckpoint, getPreCompactionResults } = await import("../connectors/gemini/agent_checkpoint.js");
    
    const originalText = "BULKY_PAYLOAD_CONTENT_" + "X".repeat(600);
    const runId = "test-integration-compaction-roundtrip";
    
    // Simulate: Step 1 (tool call) -> Step 2 (compaction) -> saveCheckpoint
    const contents = [
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "f" }, id: "c1" } }] },
        { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "c1", response: { result: originalText } } }] },
    ];
    const preCompactionResults = new Map();
    // Pass runId so compactHistoryInPlace actually persists the compacted
    // result to the side-store (savePreCompactionResult) -- without it,
    // this only populates the in-memory Map, and there'd be nothing in
    // the fake Redis for getPreCompactionResults to find below. Awaited
    // since the side-store writes are fired (not inlined) at the end of
    // compactHistoryInPlace -- see its own comment on this.
    await compactHistoryInPlace(contents, 10, preCompactionResults, { provider: "bai", runId });
    
    // Save
    await saveCheckpoint(runId, {
        newContents: contents,
        transcript: [], stepsDone: 1, task: "t", repeatCounts: {}, consecutiveAllRepeatSteps: 0,
        provider: "bai", preCompactionResults,
    });
    
    // Load
    const loaded = await loadCheckpoint(runId);
    
    // Check round-trip. `meta` only carries the compacted IDS now (plan.md
    // step 3, "Shrink meta") -- the actual text lives in the side-store,
    // written once by compactHistoryInPlace's savePreCompactionResult call
    // (step 2), and read back here via the batched getPreCompactionResults
    // fetch-on-demand helper (step 4) rather than expecting it inline on
    // the checkpoint blob.
    expect(loaded.contents).toEqual(contents);
    expect(loaded.preCompactionResultIds).toEqual([...preCompactionResults.keys()]);
    const sideStore = await getPreCompactionResults(runId, loaded.preCompactionResultIds);
    expect(sideStore.get("c1")).toBe(originalText);
  });

  it("integration test: resume -> recompaction code path in runInvestigation exercises re-compaction and populates preCompactionResults", async () => {
    // 1. Simulate a checkpoint saved BEFORE a turn was ever compacted (uncompacted full-size functionResponse in fake Redis)
    const { saveCheckpoint } = await import("../connectors/gemini/agent_checkpoint.js");
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    
    const resumeRunId = "test-resume-recompaction-integration";
    const bulkyToolResponseText = "AGED_OUT_BULKY_TOOL_RESULT_CONTENT_" + "Y".repeat(800);
    
    // Construct uncompacted history representing a past step (e.g., step 1 completed, now at step 5)
    // with an uncompacted functionResponse for an old bulky tool call.
    const uncompactedContents = [
      { role: "user", parts: [{ text: "System Preamble & Task: investigate repo" }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "src/main.js" }, id: "call_aged_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_aged_1", response: { result: bulkyToolResponseText } } }] },
    ];

    // Save the checkpoint with stepsDone: 4 (meaning next step is 5, which is past fullDetailSteps window of 3)
    await saveCheckpoint(resumeRunId, {
      newContents: uncompactedContents,
      transcript: ["[step 1] github_read_file(...) -> ..."],
      stepsDone: 4,
      task: "Investigate repo files",
      repeatCounts: {},
      preCompactionResults: {},
      consecutiveAllRepeatSteps: 0,
      provider: "bai",
    });

    // 2. Mock providerChat from ../llm/router.js so we can inspect `contents` passed into it on the resumed call
    const routerModule = await import("../connectors/llm/router.js");
    const originalProviderChat = routerModule.providerChat;
    
    let capturedContentsPassedToChat = null;
    vi.spyOn(routerModule, "providerChat").mockImplementation(async (contentsArg, options) => {
      capturedContentsPassedToChat = contentsArg;
      // Return a plain text final answer so runInvestigation completes successfully on this resumed step
      return {
        content: { parts: [{ text: "Investigation complete based on resumed recompacted history." }] },
        finishReason: "STOP",
      };
    });

    try {
      // 3. Import and call the real runInvestigation export with resume_run_id set, provider: "bai", and enough steps budget
      const result = await runInvestigation({
        task: "Investigate repo files",
        max_steps: 6,
        resume_run_id: resumeRunId,
        provider: "bai",
      });

      expect(result.failed).toBe(false);

      // 4. Assert providerChat received `contents` where the aged-out functionResponse has ALREADY been replaced with the "[Earlier tool result compacted: ...]" pointer text BEFORE providerChat is called
      expect(capturedContentsPassedToChat).toBeDefined();
      const functionResponsePart = capturedContentsPassedToChat[2].parts[0].functionResponse;
      expect(functionResponsePart.response.result).toContain("Earlier tool result compacted");
      expect(functionResponsePart.response.result).toContain("src/main.js");
      expect(functionResponsePart.response.result).not.toContain("AGED_OUT_BULKY_TOOL_RESULT_CONTENT_");

      // 5. Assert preCompactionResults ends up populated with the original full text for that compacted entry (enabling unverified claims & verbatim check support)
      // Since preCompactionResults is scoped internally inside runInvestigation, we can verify its effects via findUnverifiedClaims or lineIsVerbatimInToolResults using the captured contents + extracted/checked claims,
      // or directly verify that claims check out successfully.
      const exactSubstring = "AGED_OUT_BULKY_TOOL_RESULT_CONTENT_";
      // Even though the raw functionResponse in capturedContentsPassedToChat is compacted,
      // lineIsVerbatimInToolResults with the pre-compaction mechanics (or findUnverifiedClaims) verifies it successfully.
      // Wait, where is preCompactionResults captured? Let's check how runInvestigation uses it or how we can test it.
      // In runInvestigation, preCompactionResults is passed to compactHistoryInPlace and persisted in checkpoints.
      // Let's load the checkpoint saved after runInvestigation completed or check if we can verify via findUnverifiedClaims.
      // `meta` only carries the compacted id now (plan.md step 3) -- read
      // the actual text back via the side-store (step 2's write, step 4's
      // batched fetch), same as the round-trip test above.
      const { loadCheckpoint, getPreCompactionResults } = await import("../connectors/gemini/agent_checkpoint.js");
      const savedCheckpointAfterRun = await loadCheckpoint(resumeRunId);
      expect(savedCheckpointAfterRun.preCompactionResultIds).toContain("call_aged_1");
      const sideStore = await getPreCompactionResults(resumeRunId, savedCheckpointAfterRun.preCompactionResultIds);
      expect(sideStore.get("call_aged_1")).toBe(bulkyToolResponseText);

      // Exercises the fetch-on-demand fallback itself (plan.md step 4): an
      // EMPTY in-memory Map forces a Map miss, so this only passes if
      // lineIsVerbatimInToolResults actually falls back to the side-store
      // via runId rather than silently returning false.
      expect(await lineIsVerbatimInToolResults("AGED_OUT_BULKY_TOOL_RESULT_CONTENT_", capturedContentsPassedToChat, new Map(), resumeRunId)).toBe(true);

    } finally {
      // Restore providerChat
      vi.spyOn(routerModule, "providerChat").mockImplementation(originalProviderChat);
    }
  });

  it("deleteCheckpoint GCs precompact:{runId}:* side-store keys, not just contents/meta (plan.md step 5)", async () => {
    const { saveCheckpoint, loadCheckpoint, deleteCheckpoint, getPreCompactionResults } = await import("../connectors/gemini/agent_checkpoint.js");
    const runId = "test-gc-precompact-keys";
    const originalTextA = "GC_TEST_TEXT_A_" + "Q".repeat(600);
    const originalTextB = "GC_TEST_TEXT_B_" + "Q".repeat(600);

    const contents = [
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "a" }, id: "call_a" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_a", response: { result: originalTextA } } }] },
      { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { path: "b" }, id: "call_b" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_read_file", id: "call_b", response: { result: originalTextB } } }] },
    ];
    const preCompactionResults = new Map();
    // Persists both compacted results to the side-store via
    // savePreCompactionResult (runId passed through), same as a real run.
    await compactHistoryInPlace(contents, 10, preCompactionResults, { provider: "bai", runId });

    await saveCheckpoint(runId, {
      newContents: contents,
      transcript: [],
      stepsDone: 2,
      task: "t",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "bai",
      preCompactionResults,
    });

    const loaded = await loadCheckpoint(runId);
    const ids = loaded.preCompactionResultIds;
    expect(ids.length).toBe(2);

    // Sanity: side-store genuinely has both entries before GC runs.
    const beforeGc = await getPreCompactionResults(runId, ids);
    expect(beforeGc.size).toBe(2);
    expect(beforeGc.get("call_a")).toBe(originalTextA);
    expect(beforeGc.get("call_b")).toBe(originalTextB);

    await deleteCheckpoint(runId);

    // The checkpoint itself is gone...
    expect(await loadCheckpoint(runId)).toBeNull();
    // ...and so are the side-store entries -- deleteCheckpoint swept them up
    // rather than leaving them to expire on their own TTL.
    const afterGc = await getPreCompactionResults(runId, ids);
    expect(afterGc.size).toBe(0);
  });

  it("checkpoint meta write persists only preCompactionResult ids, not the bulky text -- write size stays flat as compacted text grows (plan.md step 6)", async () => {
    const { saveCheckpoint, loadCheckpoint } = await import("../connectors/gemini/agent_checkpoint.js");
    const runId = "test-meta-flat-size";
    const preCompactionResults = new Map();
    const BULKY_CHAR = "V";
    const ENTRY_COUNT = 20;
    const TEXT_LEN = 5000;
    for (let i = 0; i < ENTRY_COUNT; i++) {
      preCompactionResults.set(`call_${i}`, BULKY_CHAR.repeat(TEXT_LEN));
    }

    await saveCheckpoint(runId, {
      newContents: [],
      transcript: [],
      stepsDone: ENTRY_COUNT,
      task: "t",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "bai",
      preCompactionResults,
    });

    // Inspect the literal raw bytes saveCheckpoint actually wrote for the
    // meta key -- stronger than only checking loadCheckpoint's parsed
    // return shape, which confirms the round-trip but not that the bulky
    // text was never serialized into the blob in the first place.
    const rawMetaKey = [...fakeRedis._strings.keys()].find((k) => k.includes(runId) && k.endsWith(":meta"));
    expect(rawMetaKey).toBeDefined();
    const rawMeta = fakeRedis._strings.get(rawMetaKey);

    // Total original text was ENTRY_COUNT * TEXT_LEN = 100,000 chars; the
    // written meta blob should be orders of magnitude smaller -- its size
    // tracks the number of ids, not the size of what they point to.
    expect(rawMeta.length).toBeLessThan((ENTRY_COUNT * TEXT_LEN) / 10);
    expect(rawMeta).not.toContain(BULKY_CHAR.repeat(50));

    const loaded = await loadCheckpoint(runId);
    expect(loaded.preCompactionResultIds.length).toBe(ENTRY_COUNT);
    expect(loaded.preCompactionResults).toBeUndefined();
  });

  it("no preCompactionResults entry is lost mid-run even past the old 200-entry eviction threshold (regression guard against re-adding 2eea726-style eviction)", async () => {
    const { saveCheckpoint, loadCheckpoint, getPreCompactionResults, savePreCompactionResult } = await import("../connectors/gemini/agent_checkpoint.js");
    const runId = "test-no-eviction-past-200";
    const preCompactionResults = new Map();
    // Past the old MAX_PRE_COMPACTION_RESULTS_ENTRIES (200) the now-removed
    // 2eea726 eviction block used to cap at -- exactly the long-run case
    // the side-store fix (plan.md "Current outstanding issue") targets.
    const ENTRY_COUNT = 250;
    for (let i = 0; i < ENTRY_COUNT; i++) {
      const id = `call_${i}`;
      const text = `BULKY_RESULT_${i}_` + "Z".repeat(600);
      preCompactionResults.set(id, text);
      // Mirrors what compactHistoryInPlace does on first-time compaction of
      // an id -- side-store write plus in-memory Map entry.
      await savePreCompactionResult(runId, id, text);
    }

    await saveCheckpoint(runId, {
      newContents: [],
      transcript: [],
      stepsDone: ENTRY_COUNT,
      task: "t",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "bai",
      preCompactionResults,
    });

    const loaded = await loadCheckpoint(runId);
    expect(loaded.preCompactionResultIds.length).toBe(ENTRY_COUNT);

    const sideStore = await getPreCompactionResults(runId, loaded.preCompactionResultIds);
    expect(sideStore.size).toBe(ENTRY_COUNT);
    for (let i = 0; i < ENTRY_COUNT; i++) {
      expect(sideStore.get(`call_${i}`)).toBe(`BULKY_RESULT_${i}_` + "Z".repeat(600));
    }
  });
});
