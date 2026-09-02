import { describe, it, expect, vi } from "vitest";

// Minimal in-memory fake of the @upstash/redis surface agent_checkpoint.js
// uses -- same shape as test/agent-oversized-step-cap.test.js's makeFakeRedis.
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
  isRedisConfigured: () => true,
}));

describe("agent_delegate.js -- bai-only, forced-final-step-only reasoningEffort gating (plan.md Section 4/25 fix)", () => {
  it("passes reasoningEffort: 'low' on bai's forced-final step (max_steps: 1)", async () => {
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    let capturedOpts = null;
    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    providerChatMock.mockImplementationOnce(async (_contents, opts) => {
      capturedOpts = opts;
      return { content: { parts: [{ text: "Final answer." }] }, finishReason: "STOP" };
    });

    await runInvestigation({
      task: "trivial one-step task",
      max_steps: 1, // step 1 === effectiveOverallMaxSteps -> isFinalStep on the very first (and only) step
      provider: "bai",
    });

    expect(capturedOpts.provider).toBe("bai");
    expect(capturedOpts.reasoningEffort).toBe("low");

    providerChatMock.mockRestore();
  });

  it("does NOT set reasoningEffort on an earlier bai step that still has tools available", async () => {
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    const capturedOptsPerCall = [];
    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    // Step 1 (not final -- max_steps: 2): a real tool call, so the loop
    // continues to step 2 instead of returning immediately.
    providerChatMock.mockImplementationOnce(async (_contents, opts) => {
      capturedOptsPerCall.push(opts);
      return {
        content: { parts: [{ functionCall: { name: "github_get_repo_topics", args: { repo: "madmcp" }, id: "call_1" } }] },
        finishReason: "STOP",
      };
    });
    // Step 2 (final): a plain text answer.
    providerChatMock.mockImplementationOnce(async (_contents, opts) => {
      capturedOptsPerCall.push(opts);
      return { content: { parts: [{ text: "Final answer." }] }, finishReason: "STOP" };
    });

    await runInvestigation({
      task: "two-step task",
      max_steps: 2,
      provider: "bai",
    });

    expect(capturedOptsPerCall).toHaveLength(2);
    // Step 1: not the final step -- reasoningEffort must be undefined.
    expect(capturedOptsPerCall[0].reasoningEffort).toBeUndefined();
    // Step 2: the forced-final step -- reasoningEffort must be "low".
    expect(capturedOptsPerCall[1].reasoningEffort).toBe("low");

    providerChatMock.mockRestore();
  });

  it("does NOT set reasoningEffort for a non-bai provider's forced-final step (gemini)", async () => {
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    let capturedOpts = null;
    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    providerChatMock.mockImplementationOnce(async (_contents, opts) => {
      capturedOpts = opts;
      return { content: { parts: [{ text: "Final answer." }] }, finishReason: "STOP" };
    });

    await runInvestigation({
      task: "trivial one-step task",
      max_steps: 1,
      provider: "gemini",
    });

    expect(capturedOpts.provider).toBe("gemini");
    expect(capturedOpts.reasoningEffort).toBeUndefined();

    providerChatMock.mockRestore();
  });

  it("does NOT set reasoningEffort on a stuck-loop-forced (non-final) withheld-tools turn -- gating is isFinalStep specifically, not the broader withholdTools", async () => {
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    const capturedOptsPerCall = [];
    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    const sameCall = () => ({
      content: { parts: [{ functionCall: { name: "github_get_repo_topics", args: { repo: "madmcp" }, id: `call_${capturedOptsPerCall.length}` } }] },
      finishReason: "STOP",
    });
    // consecutiveAllRepeatSteps only increments on a step whose calls are
    // ALL repeats -- step 1's call is the FIRST occurrence of this exact
    // signature (not a repeat, by definition), so 4 identical calls are
    // needed to get 3 CONSECUTIVE all-repeat steps (steps 2, 3, 4 are each
    // entirely repeats of step 1's signature) and trip stuckLoopForce on
    // step 5 -- forcing withholdTools WITHOUT isFinalStep being true
    // (max_steps is generous here so the final step is never reached).
    providerChatMock.mockImplementationOnce(async (_contents, opts) => { capturedOptsPerCall.push(opts); return sameCall(); });
    providerChatMock.mockImplementationOnce(async (_contents, opts) => { capturedOptsPerCall.push(opts); return sameCall(); });
    providerChatMock.mockImplementationOnce(async (_contents, opts) => { capturedOptsPerCall.push(opts); return sameCall(); });
    providerChatMock.mockImplementationOnce(async (_contents, opts) => { capturedOptsPerCall.push(opts); return sameCall(); });
    // Step 5: stuckLoopForce withholds tools, but this is NOT the final step.
    providerChatMock.mockImplementationOnce(async (_contents, opts) => {
      capturedOptsPerCall.push(opts);
      return { content: { parts: [{ text: "Giving up after repeats." }] }, finishReason: "STOP" };
    });

    await runInvestigation({
      task: "repeat the same call over and over",
      max_steps: 10, // generous -- step 5's stuckLoopForce fires well before isFinalStep ever would
      provider: "bai",
    });

    expect(capturedOptsPerCall.length).toBeGreaterThanOrEqual(5);
    // Step 5 is the stuck-loop-forced no-tools turn -- confirm it actually
    // withheld tools (sanity check this test reached the intended state)...
    // tools is passed as undefined by the caller when withholdTools is true.
    expect(capturedOptsPerCall[4].tools).toBeUndefined();
    // ...but reasoningEffort must still be undefined, since this is
    // stuckLoopForce, not isFinalStep.
    expect(capturedOptsPerCall[4].reasoningEffort).toBeUndefined();

    providerChatMock.mockRestore();
  });
});
