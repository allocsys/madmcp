import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal in-memory fake of the @upstash/redis surface agent_checkpoint.js
// actually uses (rpush/expire/set/get/lrange/del) -- enough to exercise a
// real save -> load round trip, which no existing test does (see file
// header comment). Not a mock of call arguments; a real (if tiny) key-value
// + list store, so this test is checking actual persisted shape, not just
// "was the right method called."
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
  };
}

const fakeRedis = makeFakeRedis();
vi.mock("../connectors/gemini/cooldown.js", () => ({
  getRedis: () => fakeRedis,
}));

describe("agent_checkpoint.js — saveCheckpoint/loadCheckpoint round trip", () => {
  let saveCheckpoint, loadCheckpoint, deleteCheckpoint;

  beforeEach(async () => {
    vi.resetModules();
    ({ saveCheckpoint, loadCheckpoint, deleteCheckpoint } = await import("../connectors/gemini/agent_checkpoint.js"));
  });

  it("persists structuralRecheckUsed through a save/load round trip (regression -- was previously silently dropped)", async () => {
    const runId = "test-run-structural-recheck";
    await saveCheckpoint(runId, {
      newContents: [{ role: "user", parts: [{ text: "hi" }] }],
      transcript: ["[step 1] did a thing"],
      stepsDone: 3,
      task: "some task",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "gemini",
      pendingVerification: true,
      structuralRecheckUsed: true,
    });

    const loaded = await loadCheckpoint(runId);

    expect(loaded).not.toBeNull();
    expect(loaded.pendingVerification).toBe(true);
    // This is the field that was previously lost: prior to the fix,
    // saveCheckpoint's destructured params and meta blob didn't include
    // structuralRecheckUsed at all, so it always came back undefined here
    // regardless of what was saved -- masking the bug because
    // agent_delegate.js's own restore line (`checkpoint.structuralRecheckUsed
    // || false`) can't tell "never saved" apart from "saved as false".
    expect(loaded.structuralRecheckUsed).toBe(true);

    await deleteCheckpoint(runId);
  });

  it("defaults structuralRecheckUsed to undefined (not an error) when omitted, for pre-existing-checkpoint compatibility", async () => {
    const runId = "test-run-no-structural-field";
    await saveCheckpoint(runId, {
      newContents: [{ role: "user", parts: [{ text: "hi" }] }],
      transcript: [],
      stepsDone: 1,
      task: "some task",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "gemini",
      pendingVerification: false,
      // structuralRecheckUsed intentionally omitted, simulating a
      // checkpoint written before this field existed.
    });

    const loaded = await loadCheckpoint(runId);

    expect(loaded).not.toBeNull();
    expect(loaded.structuralRecheckUsed).toBeUndefined();
    // agent_delegate.js's own restore line defaults this the rest of the
    // way to false -- this test only needs to confirm the checkpoint layer
    // doesn't throw or coerce it to something unexpected on a missing field.

    await deleteCheckpoint(runId);
  });

  it("round-trips a full realistic meta payload (transcript, repeatCounts, all flags) unchanged", async () => {
    const runId = "test-run-full-payload";
    const payload = {
      newContents: [
        { role: "user", parts: [{ text: "task text" }] },
        { role: "model", parts: [{ functionCall: { name: "github_read_file", args: { repo: "x" } } }] },
      ],
      transcript: ["[step 1] github_read_file(...)"],
      stepsDone: 2,
      task: "investigate something",
      repeatCounts: { "github_read_file:{}": 1 },
      consecutiveAllRepeatSteps: 0,
      provider: "gemini",
      model: "gemini-flash-latest",
      maxOutputTokens: 4096,
      pendingVerification: true,
      structuralRecheckUsed: false,
    };
    await saveCheckpoint(runId, payload);

    const loaded = await loadCheckpoint(runId);

    expect(loaded.contents).toEqual(payload.newContents);
    expect(loaded.transcript).toEqual(payload.transcript);
    expect(loaded.stepsDone).toBe(2);
    expect(loaded.task).toBe("investigate something");
    expect(loaded.repeatCounts).toEqual(payload.repeatCounts);
    expect(loaded.provider).toBe("gemini");
    expect(loaded.model).toBe("gemini-flash-latest");
    expect(loaded.maxOutputTokens).toBe(4096);
    expect(loaded.pendingVerification).toBe(true);
    expect(loaded.structuralRecheckUsed).toBe(false);

    await deleteCheckpoint(runId);
  });

  it("appends newContents across two saveCheckpoint calls (append-delta, not overwrite)", async () => {
    const runId = "test-run-append-delta";
    await saveCheckpoint(runId, {
      newContents: [{ role: "user", parts: [{ text: "first" }] }],
      transcript: [],
      stepsDone: 1,
      task: "t",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "gemini",
      pendingVerification: false,
      structuralRecheckUsed: false,
    });
    await saveCheckpoint(runId, {
      newContents: [{ role: "model", parts: [{ text: "second" }] }],
      transcript: ["[step 1] done"],
      stepsDone: 2,
      task: "t",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "gemini",
      pendingVerification: true,
      structuralRecheckUsed: false,
    });

    const loaded = await loadCheckpoint(runId);

    expect(loaded.contents).toHaveLength(2);
    expect(loaded.contents[0].parts[0].text).toBe("first");
    expect(loaded.contents[1].parts[0].text).toBe("second");
    // Meta (a full overwrite each call, not append-delta -- see file
    // header) reflects the LATEST save, not the first.
    expect(loaded.stepsDone).toBe(2);
    expect(loaded.pendingVerification).toBe(true);

    await deleteCheckpoint(runId);
  });

  it("returns null after deleteCheckpoint", async () => {
    const runId = "test-run-delete";
    await saveCheckpoint(runId, {
      newContents: [{ role: "user", parts: [{ text: "x" }] }],
      transcript: [],
      stepsDone: 1,
      task: "t",
      repeatCounts: {},
      consecutiveAllRepeatSteps: 0,
      provider: "gemini",
      pendingVerification: false,
      structuralRecheckUsed: false,
    });
    await deleteCheckpoint(runId);

    const loaded = await loadCheckpoint(runId);
    expect(loaded).toBeNull();
  });
});
