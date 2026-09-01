import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  BAI_API_KEYS: ["key-a", "key-b"],
  BAI_API: "https://api.b.ai/v1/chat/completions",
  BAI_MODEL: "glm-5.3-flash",
  BAI_REQUEST_TIMEOUT_MS: 55000,
}));

vi.mock("../config.js", () => mockConfig);

const mockIsModelCoolingDown = vi.fn();
const mockSetModelCooldown = vi.fn();
const mockParseRetryDelaySeconds = vi.fn((message) => {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || "");
  return match ? Math.ceil(parseFloat(match[1])) : null;
});
vi.mock("../connectors/shared/cooldown.js", () => ({
  isModelCoolingDown: mockIsModelCoolingDown,
  setModelCooldown: mockSetModelCooldown,
  parseRetryDelaySeconds: mockParseRetryDelaySeconds,
}));

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describe("B.AI Connector - Client and key rotation logic (client.js)", () => {
  let clientModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfig.BAI_API_KEYS = ["key-a", "key-b"];
    mockConfig.BAI_MODEL = "glm-5.3-flash";
    mockIsModelCoolingDown.mockResolvedValue(false);
    process.env = { ...originalEnv };
    clientModule = await import("../connectors/bai/client.js");
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("throws if BAI_API_KEYS is empty", async () => {
    mockConfig.BAI_API_KEYS = [];
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("BAI_API_KEYS is not set");
  });

  it("succeeds on the first key and returns the raw OpenAI choice", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello from B.AI!" }, finish_reason: "stop" }],
      }),
    });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("Hello from B.AI!");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.b.ai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer key-a");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("glm-5.3-flash");
  });

  it("omits tools from the request body entirely when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.baiChat([{ role: "user", content: "hi" }]);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it("sends max_tokens when maxOutputTokens is provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.baiChat([{ role: "user", content: "hi" }], { maxOutputTokens: 4096 });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
  });

  it("throws immediately on a non-retryable status (400)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: { message: "Invalid request" } }),
    });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI API error (400): Invalid request");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a network/abort failure to a transient error", async () => {
    global.fetch = vi.fn().mockRejectedValue({ name: "AbortError", message: "aborted" });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI request timed out after 55000ms");
  });

  it("rotates to the next key on 429 and records cooldown, with NO second model attempted (key-rotation-only cascade)", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    // Exactly 2 attempts (key-a 429 -> key-b success). No model fallback cascade was attempted.
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(firstBody.model).toBe("glm-5.3-flash");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");

    const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondBody.model).toBe("glm-5.3-flash");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-b");

    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", 5, "bai:0");
  });

  it("rotates to the next key on 401/403", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Unauthorized" } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-b");
  });

  it("skips a key recorded as cooling down", async () => {
    mockIsModelCoolingDown.mockImplementation(async (model, namespace) => model === "glm-5.3-flash" && namespace === "bai:0");

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won via cooldown skip" }, finish_reason: "stop" }] }),
    });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won via cooldown skip");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-b");
  });

  it("throws the last error once all keys are exhausted", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI API error (503)");
    // 2 passes x 2 keys = 4 attempts (both keys keep failing transiently, so a second pass is attempted).
    expect(global.fetch).toHaveBeenCalledTimes(4);
    // Regression coverage for commit 27449d5: a 503 must record a cooldown
    // for BOTH keys, same as a 429 would -- previously this test exercised
    // the 503 path without ever checking cooldown behavior, which is how
    // the original gap (503s never cooling down) went uncaught.
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:0");
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:1");
  });

  it("rotates to the next key on 503 and records a cooldown (fallback default duration, no Retry-After hint available)", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // undefined seconds -- setModelCooldown() itself falls back to
    // DEFAULT_COOLDOWN_SECONDS since a 503 has no Retry-After-style hint to parse.
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:0");
    expect(mockSetModelCooldown).not.toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:1");
  });

  it("rotates to the next key on a network/timeout failure and records a cooldown", async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce({ name: "AbortError", message: "aborted" })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.baiChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockSetModelCooldown).toHaveBeenCalledWith("glm-5.3-flash", undefined, "bai:0");
  });

  it("tags the all-keys-exhausted error as .transient when every key failed with a transient status (429)", async () => {
    // Reproduces the plan.md-diagnosed scenario: all configured BAI_API_KEYS
    // rate-limited simultaneously. isTransientGeminiError() in
    // agent_delegate.js reads err.transient to decide whether a resume is
    // worth suggesting -- this must be true here, not just the message text.
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) });
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain("all 2 configured keys");
    expect(caught.transient).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("tags the all-keys-exhausted error as .transient when every key failed with a mix of transient statuses (429, 503)", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" });
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.transient).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("does NOT tag the all-keys-exhausted error as .transient when at least one key failed for a permanent reason (401)", async () => {
    // A mixed failure (one key genuinely rate-limited, another simply bad/
    // revoked) should not be advertised as "just retry me" -- the bad key
    // will fail identically on a resume regardless of the rate limit clearing.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Unauthorized" } }) })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) });
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.transient).not.toBe(true);
  });

  it("tags the all-keys-exhausted error as .transient when every key is a recorded cooldown skip", async () => {
    mockIsModelCoolingDown.mockResolvedValue(true);
    global.fetch = vi.fn();
    let caught;
    try {
      await clientModule.baiChat([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain("recorded cooldown");
    expect(caught.transient).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws if B.AI returns no choices", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({}) });
    await expect(clientModule.baiChat([{ role: "user", content: "hi" }])).rejects.toThrow("B.AI returned no choices.");
  });
});
