import { describe, it, expect, vi } from "vitest";

// Minimal in-memory fake of the @upstash/redis surface agent_checkpoint.js
// uses, same shape as test/history-compaction.test.js's makeFakeRedis --
// needed locally because vi.mock is scoped per test file in Vitest.
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
  };
}

const fakeRedis = makeFakeRedis();
vi.mock("../connectors/shared/cooldown.js", () => ({
  getRedis: () => fakeRedis,
}));

// readFileViaBlob is the real network call github_read_file's execute()
// wraps -- mocking it (and counting invocations) is how this test proves
// whether a repeat call was actually re-executed or served from cache,
// independent of anything the transcript's own [CACHED] tag claims.
const readFileViaBlobMock = vi.fn(async () => "FIXED_FILE_CONTENT_FOR_TEST");
vi.mock("../connectors/github/helpers.js", () => ({
  readFileViaBlob: (...args) => readFileViaBlobMock(...args),
}));

describe("resultCache survives a resume (regression -- 2026-08-31 bug: repeatCounts persisted but resultCache didn't)", () => {
  it("a call repeated across a resume is served from the side-store, not re-executed", async () => {
    const { runInvestigation } = await import("../connectors/delegate/agent/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    const sameReadCall = {
      functionCall: { name: "github_read_file", args: { repo: "madmcp", path: "foo.js" }, id: "call_1" },
    };

    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    // Step 1 (fresh run): model asks to read foo.js.
    providerChatMock.mockImplementationOnce(async () => ({
      content: { parts: [sameReadCall] },
      finishReason: "STOP",
    }));

    const firstResult = await runInvestigation({
      task: "read foo.js twice across a resume",
      max_steps: 1,
      provider: "bai",
    });

    // Loop hit its (deliberately tiny) max_steps ceiling after exactly one
    // step -- not a real failure, just this test forcing a checkpoint/resume
    // boundary between the two identical calls. Checkpoint must still be
    // live (failed: true here just means "not finished yet, resumable").
    expect(firstResult.failed).toBe(true);
    expect(firstResult.runId).toBeTruthy();
    expect(readFileViaBlobMock).toHaveBeenCalledTimes(1);

    const runId = firstResult.runId;

    // Step 2, AFTER a resume: model asks for the exact same file again --
    // repeatCounts (persisted in the checkpoint) will correctly recognize
    // this as a repeat; the question this test exists to answer is whether
    // resultCache -- reinitialized empty in this fresh runInvestigation
    // invocation, exactly like a real agent_worker.js singleStep resume --
    // actually serves it from the side-store instead of re-executing.
    providerChatMock.mockImplementationOnce(async () => ({
      content: { parts: [{ functionCall: { name: "github_read_file", args: { repo: "madmcp", path: "foo.js" }, id: "call_2" } }] },
      finishReason: "STOP",
    }));
    // Step 3: model is done.
    providerChatMock.mockImplementationOnce(async () => ({
      content: { parts: [{ text: "Done -- read foo.js." }] },
      finishReason: "STOP",
    }));

    const secondResult = await runInvestigation({
      resume_run_id: runId,
      max_steps: 3,
      provider: "bai",
    });

    expect(secondResult.failed).toBe(false);
    // The real assertion: readFileViaBlob must NOT have been called again.
    // Before the fix, this would be 2 (silently re-executed on resume,
    // resultCache.has(signature) always false in a fresh invocation even
    // though isRepeat correctly came back true).
    expect(readFileViaBlobMock).toHaveBeenCalledTimes(1);

    // Transcript should show the second call explicitly tagged as served
    // from cache, not just silently absent from a re-fetch. (Transcript
    // lines don't carry functionCall.id, only name+args+cacheNote -- see
    // the push call in agent_delegate.js's step loop -- so match on the
    // tool name + CACHED tag together, which only the second call's line
    // should have.)
    const cachedEntry = secondResult.transcript.find((line) => line.includes("github_read_file") && line.includes("CACHED"));
    expect(cachedEntry).toBeTruthy();

    providerChatMock.mockRestore();
  });
});
