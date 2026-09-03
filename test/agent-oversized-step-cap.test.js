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
// raising the mock content size alone (40,000 -> 90,000 chars/file, first
// attempt at this fix) was NOT the real bottleneck and still failed CI
// (run #1589, 150810 chars actual vs >299000 expected). The actual cause:
// github_read_file's execute() slices through sliceFileContentForModel,
// which -- when a call's args carry no explicit char_offset/char_limit,
// exactly what the second test below was sending -- defaults to returning
// only the FIRST 30,000 chars of any file regardless of how large the
// underlying mock content is (see agent_delegate.js's
// sliceFileContentForModel: the no-offset/no-limit branch is hardcoded to
// 30000). 5 calls x ~30,150 chars (30000 + header overhead) = ~150,810 --
// exactly the observed CI number -- well under a 300,000 cap no matter how
// large the mock content is. Real fix: the second test now passes an
// explicit char_limit in each call's args, which routes into
// sliceFileContentForModel's offset/limit branch instead -- that branch's
// own ceiling is Math.min(char_limit, 100000), i.e. 100,000 chars is the
// most any single call can return no matter what's requested. Content here
// is kept comfortably above that per-call ceiling (150,000 chars/file)
// purely so it's never itself the limiting factor.
const readFileViaBlobMock = vi.fn(async (_owner, _repo, path) => `CONTENT_FOR_${path}_`.padEnd(150000, "x"));
vi.mock("../connectors/github/helpers.js", () => ({
  readFileViaBlob: (...args) => readFileViaBlobMock(...args),
}));

describe("oversized-step guardrails (plan.md Section 9 root-cause fix)", () => {
  it("caps the number of tool calls executed in a single step and defers the rest", async () => {
    const { runInvestigation, MAX_TOOL_CALLS_PER_STEP } = await import("../connectors/delegate/agent/agent_delegate.js");
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
    const { runInvestigation, MAX_TOOL_CALLS_PER_STEP, MAX_STEP_RESULT_CHARS } = await import("../connectors/delegate/agent/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    // Fewer calls than MAX_TOOL_CALLS_PER_STEP (so the count cap doesn't
    // interfere). Each call explicitly requests PER_CALL_CHAR_LIMIT chars --
    // sliceFileContentForModel's own ceiling caps any single call's return
    // at 100,000 chars regardless of what's requested (Math.min(char_limit,
    // 100000)), so PER_CALL_CHAR_LIMIT is pinned at that ceiling to
    // maximize per-call payload. callCount * PER_CALL_CHAR_LIMIT must clear
    // MAX_STEP_RESULT_CHARS with real margin for the aggregate cap to
    // genuinely engage (not just barely graze it) -- checked below rather
    // than assumed, so a future MAX_STEP_RESULT_CHARS raise that outgrows
    // what (MAX_TOOL_CALLS_PER_STEP - 1) * 100000 chars can cover fails
    // loudly here instead of silently degrading into a no-op test like the
    // one CI caught on this branch (run #1589).
    const PER_CALL_CHAR_LIMIT = 100000;
    const callCount = Math.max(2, MAX_TOOL_CALLS_PER_STEP - 3);
    if (callCount * PER_CALL_CHAR_LIMIT < MAX_STEP_RESULT_CHARS * 1.2) {
      throw new Error(
        `Test fixture can no longer produce enough aggregate payload to exercise MAX_STEP_RESULT_CHARS=${MAX_STEP_RESULT_CHARS}: ` +
        `callCount (${callCount}) x PER_CALL_CHAR_LIMIT (${PER_CALL_CHAR_LIMIT}) = ${callCount * PER_CALL_CHAR_LIMIT}, ` +
        `no longer clears the cap with margin. Increase callCount (bounded by MAX_TOOL_CALLS_PER_STEP - 1) or ` +
        `restructure this test -- do not just raise PER_CALL_CHAR_LIMIT, it is already pinned at ` +
        `sliceFileContentForModel's own 100000-char per-call ceiling.`
      );
    }
    const batchedCalls = Array.from({ length: callCount }, (_, i) => ({
      functionCall: {
        name: "github_read_file",
        args: { repo: "madmcp", path: `big${i}.js`, char_limit: PER_CALL_CHAR_LIMIT },
        id: `call_${i}`,
      },
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

    // Without the cap this would be callCount * PER_CALL_CHAR_LIMIT (well
    // over the MAX_STEP_RESULT_CHARS cap in effect at test time, checked
    // above) -- with it, bounded at MAX_STEP_RESULT_CHARS plus
    // truncation-notice overhead (one withheld notice per call cut off by
    // the cap, so allow generously for that rather than pinning an exact
    // byte count this test shouldn't care about).
    expect(totalResultChars).toBeLessThan(MAX_STEP_RESULT_CHARS + 2000);
    expect(totalResultChars).toBeGreaterThan(MAX_STEP_RESULT_CHARS - 1000);

    providerChatMock.mockRestore();
  });
});
