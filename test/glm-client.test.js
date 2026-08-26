import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted config mock, mirroring test/gemini-client.test.js's pattern.
const mockConfig = vi.hoisted(() => ({
  OPENROUTER_API_KEYS: ["key-a", "key-b"],
  OPENROUTER_API: "https://openrouter.ai/api/v1/chat/completions",
  GLM_MODEL: "z-ai/glm-4.6",
  GLM_FALLBACK_MODELS: ["z-ai/glm-4.5-air:free"],
  GLM_REQUEST_TIMEOUT_MS: 55000,
}));

vi.mock("../config.js", () => mockConfig);

// Mock the cooldown module (shared with Gemini, see connectors/gemini/cooldown.js)
// rather than @upstash/redis directly -- glm/client.js only ever talks to
// cooldown.js's exported functions, never to Redis itself.
const mockIsModelCoolingDown = vi.fn();
const mockSetModelCooldown = vi.fn();
const mockParseRetryDelaySeconds = vi.fn((message) => {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || "");
  return match ? Math.ceil(parseFloat(match[1])) : null;
});
vi.mock("../connectors/gemini/cooldown.js", () => ({
  isModelCoolingDown: mockIsModelCoolingDown,
  setModelCooldown: mockSetModelCooldown,
  parseRetryDelaySeconds: mockParseRetryDelaySeconds,
}));

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describe("GLM Connector - Client and cascade logic (client.js)", () => {
  let clientModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfig.OPENROUTER_API_KEYS = ["key-a", "key-b"];
    mockConfig.GLM_MODEL = "z-ai/glm-4.6";
    mockConfig.GLM_FALLBACK_MODELS = ["z-ai/glm-4.5-air:free"];
    mockIsModelCoolingDown.mockResolvedValue(false);
    process.env = { ...originalEnv };
    clientModule = await import("../connectors/glm/client.js");
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("throws if OPENROUTER_API_KEYS is empty", async () => {
    mockConfig.OPENROUTER_API_KEYS = [];
    await expect(clientModule.glmChat([{ role: "user", content: "hi" }])).rejects.toThrow("OPENROUTER_API_KEYS is not set");
  });

  it("succeeds on the first key/model and returns the raw OpenAI choice", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      }),
    });

    const choice = await clientModule.glmChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("Hello!");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer key-a");
    expect(JSON.parse(init.body).model).toBe("z-ai/glm-4.6");
  });

  it("omits tools from the request body entirely when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.glmChat([{ role: "user", content: "hi" }]);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it("throws immediately on a non-retryable status (400)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: { message: "Invalid request" } }),
    });
    await expect(clientModule.glmChat([{ role: "user", content: "hi" }])).rejects.toThrow("OpenRouter API error (400): Invalid request");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a network/abort failure to a transient error", async () => {
    global.fetch = vi.fn().mockRejectedValue({ name: "AbortError", message: "aborted" });
    await expect(clientModule.glmChat([{ role: "user", content: "hi" }])).rejects.toThrow("OpenRouter request timed out after 55000ms");
  });

  it("cascades through the model list on 429/503 within the same key before switching keys", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "fallback model won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.glmChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("fallback model won");
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // First call used the default model, key-a.
    const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(firstBody.model).toBe("z-ai/glm-4.6");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");
    // Second call fell back to the free model, still on key-a (401/403 is
    // what triggers a key switch, not 429/503).
    const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondBody.model).toBe("z-ai/glm-4.5-air:free");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-a");

    // Cooldown recorded under the key-scoped namespace, not the bare model name.
    expect(mockSetModelCooldown).toHaveBeenCalledWith("z-ai/glm-4.6", 5, "glm:0");
  });

  it("rotates to the next key on 401/403 without exhausting the model cascade on the bad key", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Invalid API key" } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.glmChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    // Only 2 calls: key-a's default model (401, bad key -> skip straight to
    // next key, no cascading through key-a's fallback models first), then
    // key-b's default model succeeds.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-b");
    const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondBody.model).toBe("z-ai/glm-4.6");
  });

  it("skips a model/key pair recorded as cooling down", async () => {
    // key-a's default model is cooling down; everything else is clear.
    mockIsModelCoolingDown.mockImplementation(async (model, namespace) => model === "z-ai/glm-4.6" && namespace === "glm:0");

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "used fallback model" }, finish_reason: "stop" }] }),
    });

    const choice = await clientModule.glmChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("used fallback model");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe("z-ai/glm-4.5-air:free");
  });

  it("throws the last error once every key/model pair is exhausted", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" });
    await expect(clientModule.glmChat([{ role: "user", content: "hi" }])).rejects.toThrow("OpenRouter API error (503)");
    // 2 keys x 2 models each = 4 attempts.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("honors an explicitly requested model with no fallback cascade (but key rotation still applies)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Exhausted" } }),
    });
    await expect(
      clientModule.glmChat([{ role: "user", content: "hi" }], { model: "z-ai/glm-4.5-air:free" })
    ).rejects.toThrow(); // exhausts key-a's single attempt then key-b's, no model cascade per key
    // With no fallback cascade, only 1 attempt per key -> 2 total for 2 keys.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const call of global.fetch.mock.calls) {
      expect(JSON.parse(call[1].body).model).toBe("z-ai/glm-4.5-air:free");
    }
  });

  it("throws if OpenRouter returns no choices", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({}) });
    await expect(clientModule.glmChat([{ role: "user", content: "hi" }])).rejects.toThrow("OpenRouter returned no choices.");
  });
});
