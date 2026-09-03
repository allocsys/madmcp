import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for plan.md #3: connectors/gemini/agent_tools.js's
// async fresh-start branch used to call
//   seedRun({ task, provider, model, maxOutputTokens })
// -- omitting max_steps entirely -- so seedRun's own default
// (`max_steps = 20`) silently became the seeded checkpoint's
// overallMaxSteps regardless of what the delegate_agent caller actually
// requested. Every subsequent worker-driven singleStep resume reads its
// step ceiling from that checkpoint's overallMaxSteps, not from anything
// the original caller passed, so the run proceeded against a ceiling of
// 20 no matter what.
//
// This file tests seedRun's own contract directly (given an explicit
// max_steps, does the persisted checkpoint's overallMaxSteps match it?),
// independent of whether agent_tools.js's call site happens to pass it
// through correctly -- that call-site wiring is covered separately (and
// was the actual location of the bug) in test/agent-tools-async.test.js.
//
// Uses the same tiny in-memory fake Redis as
// test/agent-delegate-async-checkpoint.test.js so this exercises a real
// save/load round trip through agent_checkpoint.js, not a mocked stub.
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
vi.mock("../connectors/shared/cooldown.js", () => ({
  getRedis: () => fakeRedis,
  isRedisConfigured: () => true,
}));

describe("agent_delegate.js — seedRun pins overallMaxSteps to the caller's requested value", () => {
  let seedRun, loadCheckpoint;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ seedRun } = await import("../connectors/delegate/agent/agent_delegate.js"));
    ({ loadCheckpoint } = await import("../connectors/delegate/agent/agent_checkpoint.js"));
  });

  it("an explicit max_steps below the default (20) is NOT overridden by seedRun's own default", async () => {
    const runId = await seedRun({ task: "small task", provider: "bai", max_steps: 3 });
    const checkpoint = await loadCheckpoint(runId);

    expect(checkpoint).not.toBeNull();
    expect(checkpoint.status).toBe("running");
    expect(checkpoint.stepsDone).toBe(0);
    // The specific assertion this test exists for: this used to silently
    // read 20 (seedRun's own default) whenever the caller's max_steps
    // never actually reached seedRun -- exactly what happened via
    // agent_tools.js's async fresh-start branch before the fix.
    expect(checkpoint.overallMaxSteps).toBe(3);
  });

  it("an explicit max_steps above the default (20) is honored, not silently capped down to it", async () => {
    const runId = await seedRun({ task: "big task", provider: "gemini", max_steps: 25 });
    const checkpoint = await loadCheckpoint(runId);

    expect(checkpoint.overallMaxSteps).toBe(25);
  });

  it("max_steps above HARD_MAX_STEPS (30) is clamped down to 30, not passed through raw", async () => {
    const runId = await seedRun({ task: "huge task", provider: "gemini", max_steps: 999 });
    const checkpoint = await loadCheckpoint(runId);

    expect(checkpoint.overallMaxSteps).toBe(30);
  });

  it("omitting max_steps entirely still falls back to seedRun's own documented default of 20 (this is the ONE place 20 should ever come from)", async () => {
    const runId = await seedRun({ task: "no max_steps given", provider: "gemini" });
    const checkpoint = await loadCheckpoint(runId);

    expect(checkpoint.overallMaxSteps).toBe(20);
  });
});
