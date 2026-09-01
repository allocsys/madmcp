import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Define hoisted configuration mock
const mockConfig = vi.hoisted(() => ({
  GEMINI_API_KEYS: ["dummy-api-key"],
  GEMINI_API: "https://generativelanguage.googleapis.com/v1beta",
  GEMINI_MODEL: "gemini-flash-latest",
  GEMINI_FALLBACK_MODELS: ["fallback-lite-1", "fallback-lite-2"],
  GEMINI_REQUEST_TIMEOUT_MS: 55000,
}));

vi.mock("../config.js", () => mockConfig);

// Mock @upstash/redis
const mockGet = vi.fn();
const mockSet = vi.fn();
vi.mock("@upstash/redis", () => {
  class MockRedis {
    constructor() {
      this.get = mockGet;
      this.set = mockSet;
    }
  }
  return {
    Redis: MockRedis,
  };
});

// Mock global fetch
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describe("Gemini Connector - Cooldown logic (cooldown.js)", () => {
  let cooldownModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Dynamically import to ensure module-level state (redisInitAttempted/redisClient) is reset
    cooldownModule = await import("../connectors/shared/cooldown.js");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("parseRetryDelaySeconds", () => {
    it("parses retry seconds from error message", () => {
      expect(cooldownModule.parseRetryDelaySeconds("Resource has been exhausted. Please retry in 52.395004654s.")).toBe(53);
      expect(cooldownModule.parseRetryDelaySeconds("retry in 12.5s")).toBe(13);
      expect(cooldownModule.parseRetryDelaySeconds("Some random message with retry in 5s inside.")).toBe(5);
    });

    it("returns null if no retry in pattern matches", () => {
      expect(cooldownModule.parseRetryDelaySeconds("Resource exhausted, try again later.")).toBeNull();
      expect(cooldownModule.parseRetryDelaySeconds("")).toBeNull();
      expect(cooldownModule.parseRetryDelaySeconds(null)).toBeNull();
    });
  });

  describe("Redis configuration and client initialization", () => {
    it("returns null when no env vars are configured", () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;

      expect(cooldownModule.isRedisConfigured()).toBe(false);
    });

    it("initializes successfully with UPSTASH_REDIS_REST_URL and TOKEN", () => {
      process.env.UPSTASH_REDIS_REST_URL = "https://upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "token123";

      expect(cooldownModule.isRedisConfigured()).toBe(true);
      expect(cooldownModule.getRedis()).toBeDefined();
    });

    it("initializes successfully with KV_REST_API_URL and TOKEN", () => {
      process.env.KV_REST_API_URL = "https://kv.io";
      process.env.KV_REST_API_TOKEN = "kvtoken123";

      expect(cooldownModule.isRedisConfigured()).toBe(true);
      expect(cooldownModule.getRedis()).toBeDefined();
    });
  });

  describe("isModelCoolingDown and setModelCooldown behavior", () => {
    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "token123";
    });

    it("returns false if Redis is not configured", async () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      // Re-import to trigger initialization check without env vars
      vi.resetModules();
      const freshCooldown = await import("../connectors/shared/cooldown.js");
      expect(await freshCooldown.isModelCoolingDown("some-model")).toBe(false);
    });

    it("returns false if key is not found in Redis", async () => {
      mockGet.mockResolvedValueOnce(null);
      const res = await cooldownModule.isModelCoolingDown("gemini-model-x");
      expect(res).toBe(false);
      expect(mockGet).toHaveBeenCalledWith("gemini:cooldown:gemini-model-x");
    });

    it("returns true if key is found in Redis", async () => {
      mockGet.mockResolvedValueOnce("1");
      const res = await cooldownModule.isModelCoolingDown("gemini-model-x");
      expect(res).toBe(true);
    });

    it("fails open and returns false on Redis query error", async () => {
      mockGet.mockRejectedValueOnce(new Error("Redis connection timed out"));
      const res = await cooldownModule.isModelCoolingDown("gemini-model-x");
      expect(res).toBe(false); // fails open
    });

    it("sets cooldown with specified TTL or default TTL", async () => {
      mockSet.mockResolvedValueOnce("OK");
      await cooldownModule.setModelCooldown("gemini-model-x", 30);
      expect(mockSet).toHaveBeenCalledWith("gemini:cooldown:gemini-model-x", "1", { ex: 30 });

      mockSet.mockResolvedValueOnce("OK");
      await cooldownModule.setModelCooldown("gemini-model-x", null);
      expect(mockSet).toHaveBeenCalledWith("gemini:cooldown:gemini-model-x", "1", { ex: 60 });
    });

    it("fails open and does not throw on Redis set error", async () => {
      mockSet.mockRejectedValueOnce(new Error("Redis read-only mode"));
      await expect(cooldownModule.setModelCooldown("gemini-model-x", 30)).resolves.not.toThrow();
    });
  });
});

describe("Gemini Connector - Client and Cascading Cascade (client.js)", () => {
  let clientModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfig.GEMINI_API_KEYS = ["dummy-api-key"];
    mockConfig.GEMINI_MODEL = "gemini-flash-latest";
    mockConfig.GEMINI_FALLBACK_MODELS = ["fallback-lite-1", "fallback-lite-2"];
    process.env = { ...originalEnv };

    clientModule = await import("../connectors/gemini/client.js");
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("throws error if GEMINI_API_KEYS is empty", async () => {
    mockConfig.GEMINI_API_KEYS = [];
    await expect(clientModule.geminiGenerate("hello")).rejects.toThrow("No Gemini API key configured");
  });

  it("succeeds when fetch returns candidate content", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{ text: "Hello response!" }],
          },
          finishReason: "STOP",
        }],
      }),
    });

    const res = await clientModule.geminiGenerate("test prompt");
    expect(res).toBe("Hello response!");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain("gemini-flash-latest:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("dummy-api-key");
  });

  it("throws error if candidate response is empty or finished with non-stop reason", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        candidates: [{
          finishReason: "SAFETY",
        }],
      }),
    });

    await expect(clientModule.geminiGenerate("dangerous content")).rejects.toThrow("Gemini returned no text output (finishReason: SAFETY)");
  });

  it("handles network timeouts and maps them to transient errors", async () => {
    global.fetch = vi.fn().mockRejectedValue({
      name: "AbortError",
      message: "The operation was aborted.",
    });

    await expect(clientModule.geminiGenerate("timeout please")).rejects.toThrow("Gemini request timed out after 55000ms");
  });

  it("handles direct API HTTP errors immediately if not 429/503", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: { message: "Invalid argument shape" } }),
    });

    await expect(clientModule.geminiGenerate("bad payload")).rejects.toThrow("Gemini API error (400): Invalid argument shape");
    expect(global.fetch).toHaveBeenCalledTimes(1); // No cascade on 400
  });

  it("cascades through fallback models on 429 and records model cooldown", async () => {
    // Enable Redis in env
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token123";
    mockGet.mockResolvedValue(null); // No models cooling down initially

    // 1st model (gemini-flash-latest) returns 429
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: "Resource exhausted. Please retry in 5s." } }),
      })
      // 2nd model (fallback-lite-1) returns 503
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "Overloaded",
      })
      // 3rd model (fallback-lite-2) succeeds
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          candidates: [{
            content: { parts: [{ text: "Fallback success!" }] },
          }],
        }),
      });

    const res = await clientModule.geminiGenerate("trigger cascades");
    expect(res).toBe("Fallback success!");
    expect(global.fetch).toHaveBeenCalledTimes(3);

    // Verify cooldown is recorded for 1st model (gemini-flash-latest) with 5 seconds TTL
    expect(mockSet).toHaveBeenCalledWith("gemini:cooldown:gemini-flash-latest", "1", { ex: 5 });
  });

  it("skips models that are currently cooling down in Redis", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token123";

    // gemini-flash-latest is cooling down, fallback-lite-1 is cooling down
    mockGet
      .mockResolvedValueOnce("1")  // for gemini-flash-latest check
      .mockResolvedValueOnce("1")  // for fallback-lite-1 check
      .mockResolvedValueOnce(null); // for fallback-lite-2 check

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "Only fallback-lite-2 was called!" }] },
        }],
      }),
    });

    const res = await clientModule.geminiGenerate("test prompt");
    expect(res).toBe("Only fallback-lite-2 was called!");
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain("fallback-lite-2:generateContent");
  });

  it("honors explicitly requested model and does NOT cascade to fallback models", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: "Exhausted" } }),
    });

    // Requesting fallback-lite-1 explicitly. Since it is not process.env.GEMINI_MODEL,
    // it should not cascade to fallback-lite-2 on 429.
    await expect(clientModule.geminiGenerate("explicit model", { model: "fallback-lite-1" })).rejects.toThrow("Gemini API error (429): Exhausted");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  describe("multi-key cascade (GEMINI_API_KEYS)", () => {
    beforeEach(() => {
      mockConfig.GEMINI_API_KEYS = ["key-0", "key-1"];
    });

    it("exhausts every fallback model on key 0 before rotating to key 1", async () => {
      global.fetch = vi.fn()
        // key-0, gemini-flash-latest -> 429
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Exhausted" } }) })
        // key-0, fallback-lite-1 -> 429
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Exhausted" } }) })
        // key-0, fallback-lite-2 -> 429 (key 0's model list now fully exhausted)
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: "Exhausted" } }) })
        // key-1, gemini-flash-latest -> succeeds
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "key 1 success" }] } }] }),
        });

      const res = await clientModule.geminiGenerate("trigger key rotation");
      expect(res).toBe("key 1 success");
      expect(global.fetch).toHaveBeenCalledTimes(4);

      // 4th call (key-1's first attempt) should use key-1's header and go
      // back to the PRIMARY model, not continue down key-0's fallback list --
      // model-first-per-key, not "keep the same model index across keys".
      const [url, init] = global.fetch.mock.calls[3];
      expect(url).toContain("gemini-flash-latest:generateContent");
      expect(init.headers["x-goog-api-key"]).toBe("key-1");
    });

    it("jumps straight to the next key on 401/403 without cascading remaining models", async () => {
      global.fetch = vi.fn()
        // key-0, gemini-flash-latest -> 403 (bad/revoked key)
        .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: async () => JSON.stringify({ error: { message: "Invalid API key" } }) })
        // key-1, gemini-flash-latest -> succeeds
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "key 1 rescued it" }] } }] }),
        });

      const res = await clientModule.geminiGenerate("bad key on key 0");
      expect(res).toBe("key 1 rescued it");
      // Only 2 calls -- fallback-lite-1/fallback-lite-2 on key-0 were never tried.
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("geminiChat (multi-turn function-calling support)", () => {
    it("successfully returns the entire candidate object", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                functionCall: { name: "get_pull_requests", args: { owner: "allocsys" } },
              }],
            },
            finishReason: "STOP",
          }],
        }),
      });

      const contents = [{ role: "user", parts: [{ text: "check PRs" }] }];
      const candidate = await clientModule.geminiChat(contents, {
        tools: [{ functionDeclarations: [] }],
      });

      expect(candidate.content.role).toBe("model");
      expect(candidate.content.parts[0].functionCall.name).toBe("get_pull_requests");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("throws error if no candidates are returned", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({}),
      });

      const contents = [{ role: "user", parts: [{ text: "hello" }] }];
      await expect(clientModule.geminiChat(contents)).rejects.toThrow("Gemini returned no candidates.");
    });
  });
});
