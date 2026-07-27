import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("parseRetryDelaySeconds", () => {
  it("parses 'try again in Ns.' phrasing", async () => {
    const { parseRetryDelaySeconds } = await import("../connectors/openai/cooldown.js");
    expect(parseRetryDelaySeconds("Rate limited. Please try again in 20s.")).toBe(20);
  });

  it("parses 'retry after Ns' phrasing", async () => {
    const { parseRetryDelaySeconds } = await import("../connectors/openai/cooldown.js");
    expect(parseRetryDelaySeconds("Too many requests, retry after 1.234s")).toBe(2);
  });

  it("parses 'retry Ns' without the word 'after'", async () => {
    const { parseRetryDelaySeconds } = await import("../connectors/openai/cooldown.js");
    expect(parseRetryDelaySeconds("please retry 5s from now")).toBe(5);
  });

  it("returns null when no pattern matches", async () => {
    const { parseRetryDelaySeconds } = await import("../connectors/openai/cooldown.js");
    expect(parseRetryDelaySeconds("Rate limit exceeded, no idea when.")).toBeNull();
  });

  it("returns null for undefined/empty input rather than throwing", async () => {
    const { parseRetryDelaySeconds } = await import("../connectors/openai/cooldown.js");
    expect(parseRetryDelaySeconds(undefined)).toBeNull();
    expect(parseRetryDelaySeconds("")).toBeNull();
  });
});

describe("cooldown storage — Redis not configured (fails open)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("isRedisConfigured() is false when no env vars are set", async () => {
    const { isRedisConfigured } = await import("../connectors/openai/cooldown.js");
    expect(isRedisConfigured()).toBe(false);
  });

  it("isCombinationCoolingDown() resolves false without throwing", async () => {
    const { isCombinationCoolingDown } = await import("../connectors/openai/cooldown.js");
    await expect(isCombinationCoolingDown("gpt-5.4-mini", 0)).resolves.toBe(false);
  });

  it("setCombinationCooldown() resolves (no-op) without throwing", async () => {
    const { setCombinationCooldown } = await import("../connectors/openai/cooldown.js");
    await expect(setCombinationCooldown("gpt-5.4-mini", 0, 30)).resolves.toBeUndefined();
  });
});

describe("cooldown storage — Redis configured (mocked client)", () => {
  const ORIGINAL_ENV = { ...process.env };
  let store;
  let redisCtorArgs;

  beforeEach(() => {
    vi.resetModules();
    store = new Map();
    redisCtorArgs = null;
    process.env.UPSTASH_REDIS_REST_URL = "https://example-upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;

    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        constructor(args) {
          redisCtorArgs = args;
        }
        async get(key) {
          return store.has(key) ? store.get(key).value : null;
        }
        async set(key, value, opts) {
          store.set(key, { value, ttl: opts?.ex });
          return "OK";
        }
      },
    }));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock("@upstash/redis");
  });

  it("constructs the Redis client from UPSTASH_* env vars", async () => {
    const { isRedisConfigured } = await import("../connectors/openai/cooldown.js");
    expect(isRedisConfigured()).toBe(true);
    expect(redisCtorArgs).toEqual({ url: "https://example-upstash.io", token: "test-token" });
  });

  it("falls back to KV_REST_API_* naming when UPSTASH_* is absent", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = "https://kv-example.io";
    process.env.KV_REST_API_TOKEN = "kv-token";

    const { isRedisConfigured } = await import("../connectors/openai/cooldown.js");
    expect(isRedisConfigured()).toBe(true);
    expect(redisCtorArgs).toEqual({ url: "https://kv-example.io", token: "kv-token" });
  });

  it("namespaces cooldown keys by model AND key index, not model alone", async () => {
    const { setCombinationCooldown, isCombinationCoolingDown } = await import("../connectors/openai/cooldown.js");
    await setCombinationCooldown("gpt-5.4-mini", 0, 60);

    expect(await isCombinationCoolingDown("gpt-5.4-mini", 0)).toBe(true);
    // Same model, different key index -- must NOT be considered cooling down.
    expect(await isCombinationCoolingDown("gpt-5.4-mini", 1)).toBe(false);
    // Different model, same key index -- must NOT be considered cooling down.
    expect(await isCombinationCoolingDown("gpt-5.4-nano", 0)).toBe(false);
  });

  it("uses the provided seconds as the Redis TTL", async () => {
    const { setCombinationCooldown } = await import("../connectors/openai/cooldown.js");
    await setCombinationCooldown("gpt-5.4-mini", 2, 45);
    const entry = [...store.values()][0];
    expect(entry.ttl).toBe(45);
  });

  it("falls back to the default cooldown when seconds is missing/invalid", async () => {
    const { setCombinationCooldown } = await import("../connectors/openai/cooldown.js");
    await setCombinationCooldown("gpt-5.4-mini", 0, undefined);
    await setCombinationCooldown("gpt-5.4-mini", 1, -5);
    for (const entry of store.values()) {
      expect(entry.ttl).toBe(60);
    }
  });

  it("never puts the raw API key into the Redis key name (namespaced by index only)", async () => {
    const { setCombinationCooldown } = await import("../connectors/openai/cooldown.js");
    await setCombinationCooldown("gpt-5.4-mini", 0, 30);
    const keys = [...store.keys()];
    expect(keys[0]).toBe("openai:cooldown:gpt-5.4-mini:0");
  });
});

describe("cooldown storage — Redis throws at construction or call time", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.UPSTASH_REDIS_REST_URL = "https://example-upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock("@upstash/redis");
  });

  it("treats Redis as unconfigured if the constructor throws", async () => {
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        constructor() {
          throw new Error("bad credentials");
        }
      },
    }));
    const { isRedisConfigured, isCombinationCoolingDown } = await import("../connectors/openai/cooldown.js");
    expect(isRedisConfigured()).toBe(false);
    await expect(isCombinationCoolingDown("gpt-5.4-mini", 0)).resolves.toBe(false);
  });

  it("fails open (returns false / no-op) if a call to Redis rejects", async () => {
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        async get() {
          throw new Error("network blip");
        }
        async set() {
          throw new Error("network blip");
        }
      },
    }));
    const { isCombinationCoolingDown, setCombinationCooldown } = await import("../connectors/openai/cooldown.js");
    await expect(isCombinationCoolingDown("gpt-5.4-mini", 0)).resolves.toBe(false);
    await expect(setCombinationCooldown("gpt-5.4-mini", 0, 30)).resolves.toBeUndefined();
  });
});
