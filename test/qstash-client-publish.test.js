import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for plan.md Section 13: publishAgentStep/
// publishEditorStep (connectors/gemini/qstash_client.js) must actually pass
// `retries` and `failureCallback` through to the underlying
// @upstash/qstash Client.publishJSON call -- previously neither was set,
// which let a deterministically-timing-out step exhaust QStash's own
// default retry budget (3 retries, ~40min worst case) with no notification
// back to this app once that budget was exhausted (the live blind spot
// confirmed against runId 223d6b08-... in plan.md Section 12).
//
// Mocks @upstash/qstash ITSELF (not qstash_client.js, unlike
// test/agent-worker.test.js and test/editor-worker.test.js, which mock the
// whole qstash_client.js module) so the real publishAgentStep/
// publishEditorStep code actually runs and we can inspect exactly what it
// handed to publishJSON -- this is the one thing style-mocking
// qstash_client.js entirely (as the worker tests do) can never catch.
//
// config.js's AGENT_WORKER_URL/EDITOR_WORKER_URL/QSTASH_STEP_RETRIES/
// *_FAILURE_URL are all computed ONCE at module-evaluation time from
// process.env, so every test here sets process.env BEFORE a fresh dynamic
// import (after vi.resetModules()) rather than mutating already-exported
// constants, which wouldn't take effect.

const mockPublishJSON = vi.fn();
vi.mock("@upstash/qstash", () => ({
  Client: vi.fn().mockImplementation(() => ({
    publishJSON: mockPublishJSON,
  })),
  Receiver: vi.fn().mockImplementation(() => ({
    verify: vi.fn(),
  })),
}));

const ORIGINAL_ENV = { ...process.env };

describe("qstash_client.js — publishJSON call shape (plan.md Section 13)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockPublishJSON.mockResolvedValue();
    process.env = { ...ORIGINAL_ENV };
    process.env.QSTASH_TOKEN = "test-token";
    process.env.AGENT_WORKER_URL = "https://example.com/api/agent-worker";
    delete process.env.EDITOR_WORKER_URL;
    delete process.env.QSTASH_STEP_RETRIES;
    delete process.env.AGENT_WORKER_FAILURE_URL;
    delete process.env.EDITOR_WORKER_FAILURE_URL;
  });

  it("publishAgentStep passes retries: 0 (default QSTASH_STEP_RETRIES) and a derived failureCallback", async () => {
    const { publishAgentStep } = await import("../connectors/gemini/qstash_client.js");
    await publishAgentStep({ runId: "run-1", afterStep: 2, retryCount: 1 });

    expect(mockPublishJSON).toHaveBeenCalledTimes(1);
    const call = mockPublishJSON.mock.calls[0][0];
    expect(call.url).toBe("https://example.com/api/agent-worker");
    expect(call.body).toEqual({ runId: "run-1", afterStep: 2, retryCount: 1 });
    expect(call.retries).toBe(0);
    expect(call.failureCallback).toBe("https://example.com/api/agent-worker-failure");
  });

  it("publishEditorStep passes retries: 0 and a derived failureCallback targeting the editor-worker-failure route", async () => {
    const { publishEditorStep } = await import("../connectors/gemini/qstash_client.js");
    await publishEditorStep({ runId: "run-2", afterStep: 0, retryCount: 0 });

    expect(mockPublishJSON).toHaveBeenCalledTimes(1);
    const call = mockPublishJSON.mock.calls[0][0];
    // EDITOR_WORKER_URL derives from AGENT_WORKER_URL by swapping the path
    // suffix when EDITOR_WORKER_URL isn't explicitly set (config.js's
    // deriveEditorWorkerUrl) -- same pattern EDITOR_WORKER_FAILURE_URL
    // reuses via deriveFailureUrl.
    expect(call.url).toBe("https://example.com/api/editor-worker");
    expect(call.body).toEqual({ runId: "run-2", afterStep: 0, retryCount: 0 });
    expect(call.retries).toBe(0);
    expect(call.failureCallback).toBe("https://example.com/api/editor-worker-failure");
  });

  it("respects a QSTASH_STEP_RETRIES env override instead of hardcoding 0", async () => {
    process.env.QSTASH_STEP_RETRIES = "2";
    const { publishAgentStep } = await import("../connectors/gemini/qstash_client.js");
    await publishAgentStep({ runId: "run-3", afterStep: 0 });

    const call = mockPublishJSON.mock.calls[0][0];
    expect(call.retries).toBe(2);
  });

  it("omits failureCallback entirely (not sent as an undefined/broken key) when no failure URL is derivable", async () => {
    // AGENT_WORKER_URL that doesn't contain "/api/agent-worker" -- deriveFailureUrl
    // (config.js) has no safe substring to swap and returns undefined rather
    // than guessing at a made-up callback URL.
    process.env.AGENT_WORKER_URL = "https://example.com/some-other-path";
    const { publishAgentStep } = await import("../connectors/gemini/qstash_client.js");
    await publishAgentStep({ runId: "run-4", afterStep: 0 });

    const call = mockPublishJSON.mock.calls[0][0];
    expect(call.retries).toBe(0);
    expect("failureCallback" in call).toBe(false);
  });

  it("respects an explicit AGENT_WORKER_FAILURE_URL override instead of the derived one", async () => {
    process.env.AGENT_WORKER_FAILURE_URL = "https://override.example.com/custom-failure-path";
    const { publishAgentStep } = await import("../connectors/gemini/qstash_client.js");
    await publishAgentStep({ runId: "run-5", afterStep: 0 });

    const call = mockPublishJSON.mock.calls[0][0];
    expect(call.failureCallback).toBe("https://override.example.com/custom-failure-path");
  });
});
