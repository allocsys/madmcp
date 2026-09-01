import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted config mock, mirroring test/glm-client.test.js's pattern.
const mockConfig = vi.hoisted(() => ({
  GROQ_API_KEYS: ["key-a", "key-b"],
  GROQ_API: "https://api.groq.com/openai/v1/chat/completions",
  GROQ_MODEL: "openai/gpt-oss-120b",
  GROQ_FALLBACK_MODELS: ["qwen/qwen3.6-27b"],
  GROQ_REQUEST_TIMEOUT_MS: 55000,
}));

vi.mock("../config.js", () => mockConfig);

// Mock the cooldown module (shared with Gemini/GLM, see
// connectors/shared/cooldown.js) rather than @upstash/redis directly --
// groq/client.js only ever talks to cooldown.js's exported functions.
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

describe("Groq Connector - Client and cascade logic (client.js)", () => {
  let clientModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfig.GROQ_API_KEYS = ["key-a", "key-b"];
    mockConfig.GROQ_MODEL = "openai/gpt-oss-120b";
    mockConfig.GROQ_FALLBACK_MODELS = ["qwen/qwen3.6-27b"];
    mockIsModelCoolingDown.mockResolvedValue(false);
    process.env = { ...originalEnv };
    clientModule = await import("../connectors/groq/client.js");
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("throws if GROQ_API_KEYS is empty", async () => {
    mockConfig.GROQ_API_KEYS = [];
    await expect(clientModule.groqChat([{ role: "user", content: "hi" }])).rejects.toThrow("GROQ_API_KEYS is not set");
  });

  it("succeeds on the first key/model and returns the raw OpenAI choice", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      }),
    });

    const choice = await clientModule.groqChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("Hello!");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer key-a");
    expect(JSON.parse(init.body).model).toBe("openai/gpt-oss-120b");
  });

  it("omits tools from the request body entirely when not provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.groqChat([{ role: "user", content: "hi" }]);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it("sends max_tokens when maxOutputTokens is provided", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    });
    await clientModule.groqChat([{ role: "user", content: "hi" }], { maxOutputTokens: 4096 });
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
    await expect(clientModule.groqChat([{ role: "user", content: "hi" }])).rejects.toThrow("Groq API error (400): Invalid request");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a network/abort failure to a transient error", async () => {
    global.fetch = vi.fn().mockRejectedValue({ name: "AbortError", message: "aborted" });
    await expect(clientModule.groqChat([{ role: "user", content: "hi" }])).rejects.toThrow("Groq request timed out after 55000ms");
  });

  it("cascades through the model list on 429/503 within the same key before switching keys", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Rate limited. retry in 5s." } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "fallback model won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.groqChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("fallback model won");
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(firstBody.model).toBe("openai/gpt-oss-120b");
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");
    const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondBody.model).toBe("qwen/qwen3.6-27b");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-a");

    expect(mockSetModelCooldown).toHaveBeenCalledWith("openai/gpt-oss-120b", 5, "groq:0");
  });

  it("rotates to the next key on 401/403 without exhausting the model cascade on the bad key", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "Invalid API key" } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "key-b won" }, finish_reason: "stop" }] }) });

    const choice = await clientModule.groqChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("key-b won");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer key-a");
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer key-b");
    const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondBody.model).toBe("openai/gpt-oss-120b");
  });

  it("skips a model/key pair recorded as cooling down", async () => {
    mockIsModelCoolingDown.mockImplementation(async (model, namespace) => model === "openai/gpt-oss-120b" && namespace === "groq:0");

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "used fallback model" }, finish_reason: "stop" }] }),
    });

    const choice = await clientModule.groqChat([{ role: "user", content: "hi" }]);
    expect(choice.message.content).toBe("used fallback model");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe("qwen/qwen3.6-27b");
  });

  it("throws the last error once every key/model pair is exhausted", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "down" });
    await expect(clientModule.groqChat([{ role: "user", content: "hi" }])).rejects.toThrow("Groq API error (503)");
    // 2 keys x 2 models each = 4 attempts.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("honors an explicitly requested model with no fallback cascade (but key rotation still applies)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Exhausted" } }),
    });
    await expect(
      clientModule.groqChat([{ role: "user", content: "hi" }], { model: "qwen/qwen3.6-27b" })
    ).rejects.toThrow();
    // With no fallback cascade, only 1 attempt per key -> 2 total for 2 keys.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const call of global.fetch.mock.calls) {
      expect(JSON.parse(call[1].body).model).toBe("qwen/qwen3.6-27b");
    }
  });

  it("throws if Groq returns no choices", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({}) });
    await expect(clientModule.groqChat([{ role: "user", content: "hi" }])).rejects.toThrow("Groq returned no choices.");
  });
});
