import { describe, it, expect, vi } from "vitest";

// Minimal in-memory fake of the @upstash/redis surface agent_checkpoint.js
// uses -- same shape as test/agent-resultcache-resume.test.js /
// test/history-compaction.test.js's makeFakeRedis.
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
// wraps. Each call returns a distinct, large string so the aggregate-size
// cap has something real to bite into.
//
// Size note (2026-09-02, MAX_STEP_RESULT_CHARS 100000 -> 300000 raise):
// this used to be 40,000 chars/file, which was plenty to blow past the old
// 100,000 cap with the 5-call batch below (200,000 raw chars). It is NOT
// enough at 300,000 (200,000 < 300,000 -- the cap simply wouldn't engage,
// silently turning the second test below into a no-op that happens to pass
// for the wrong reason). Raised to 90,000 chars/file (450,000 raw chars for
// the same 5-call batch) to keep comfortable headroom above the cap. This
// value is NOT derived from the real MAX_STEP_RESULT_CHARS constant -- it's
// a hardcoded fixture size, same as it was before -- so if that constant is
// raised again in the future, re-check this margin rather than assuming it
// still holds.
const readFileViaBlobMock = vi.fn(async (_owner, _repo, path) => `CONTENT_FOR_${path}_`.padEnd(90000, "x"));
vi.mock("../connectors/github/helpers.js", () => ({
  readFileViaBlob: (...args) => readFileViaBlobMock(...args),
}));

describe("oversized-step guardrails (plan.md Section 9 root-cause fix)", () => {
  it("caps the number of tool calls executed in a single step and defers the rest", async () => {
    const { runInvestigation, MAX_TOOL_CALLS_PER_STEP } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    // Model batches MAX_TOOL_CALLS_PER_STEP + 3 calls into a single step --
    // reproduces the "13 calls batched into one step" shape from
    // plan.md Section 7, just parameterized against the real constant so
    // this test doesn't go stale if the cap value changes.
    const overBudgetCount = MAX_TOOL_CALLS_PER_STEP + 3;
    const batchedCalls = Array.from({ length: overBudgetCount }, (_, i) => ({
      functionCall: { name: "github_read_file", args: { repo: "madmcp", path: `file${i}.js` }, id: `call_${i}` },
    }));

    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    providerChatMock.mockImplementationOnce(async () => ({
      content: { parts: batchedCalls },
      finishReason: "STOP",
    }));
    providerChatMock.mockImplementationOnce(async () => ({
      content: { parts: [{ text: "Done." }] },
      finishReason: "STOP",
    }));

    const result = await runInvestigation({
      task: "read many files at once",
      max_steps: 2,
      provider: "bai",
    });

    // Only the first MAX_TOOL_CALLS_PER_STEP calls should have actually hit
    // the network -- this is the real assertion (not just a transcript
    // string match): the whole point of the cap is to bound outbound work.
    expect(readFileViaBlobMock).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_STEP);

    // Every call the model made must still be represented in the
    // transcript, including the deferred ones (each turn needs a
    // functionResponse or the next outbound call would be malformed) --
    // this asserts that contract, not just the count above.
    const deferredEntries = result.transcript.filter((line) => line.includes("[DEFERRED"));
    expect(deferredEntries.length).toBe(overBudgetCount - MAX_TOOL_CALLS_PER_STEP);

    providerChatMock.mockRestore();
  });

  it("caps the combined tool-result size appended to context in a single step", async () => {
    const { runInvestigation, MAX_TOOL_CALLS_PER_STEP, MAX_STEP_RESULT_CHARS } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    // Fewer calls than MAX_TOOL_CALLS_PER_STEP (so the count cap doesn't
    // interfere), but each one is large enough (40,000 chars) that a
    // handful together blow well past MAX_STEP_RESULT_CHARS (60,000) --
    // this isolates the size cap from the count cap.
    const callCount = Math.max(2, MAX_TOOL_CALLS_PER_STEP - 3);
    const batchedCalls = Array.from({ length: callCount }, (_, i) => ({
      functionCall: { name: "github_read_file", args: { repo: "madmcp", path: `big${i}.js` }, id: `call_${i}` },
    }));

    // Capture the actual outbound payload sent on the SECOND providerChat
    // call (i.e. the one carrying this step's results back to the model) --
    // this is the payload the fix exists to bound, not just the transcript.
    // providerChat's signature is (contents, opts) -- see the call site in
    // agent_delegate.js -- so the contents array is the first positional arg.
    let secondCallContents = null;
    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    providerChatMock.mockImplementationOnce(async () => ({
      content: { parts: batchedCalls },
      finishReason: "STOP",
    }));
    providerChatMock.mockImplementationOnce(async (contents) => {
      secondCallContents = contents;
      return { content: { parts: [{ text: "Done." }] }, finishReason: "STOP" };
    });

    await runInvestigation({
      task: "read several large files at once",
      max_steps: 2,
      provider: "bai",
    });

    expect(secondCallContents).toBeTruthy();
    const lastTurn = secondCallContents[secondCallContents.length - 1];
    const totalResultChars = lastTurn.parts
      .filter((p) => p.functionResponse)
      .reduce((sum, p) => sum + (p.functionResponse.response.result?.length || 0), 0);

    // Without the cap this would be callCount * 90000 (well over the
    // MAX_STEP_RESULT_CHARS cap in effect at test time) -- with it, bounded
    // at MAX_STEP_RESULT_CHARS plus truncation-notice overhead (one withheld
    // notice per call cut off by the cap, so allow generously for that
    // rather than pinning an exact byte count this test shouldn't care
    // about).
    expect(totalResultChars).toBeLessThan(MAX_STEP_RESULT_CHARS + 2000);
    expect(totalResultChars).toBeGreaterThan(MAX_STEP_RESULT_CHARS - 1000);

    providerChatMock.mockRestore();
  });
});
