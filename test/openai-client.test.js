import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// connectors/openai/client.js reads its config as named imports from
// config.js and its cross-call cooldown memory from cooldown.js -- both are
// mocked per-test below so the cascade logic can be exercised deterministically
// without real network access, real env vars, or real Redis.

const CONFIG_PATH = "../config.js";
const COOLDOWN_PATH = "../connectors/openai/cooldown.js";
const CLIENT_PATH = "../connectors/openai/client.js";

function mockConfig(overrides = {}) {
  vi.doMock(CONFIG_PATH, () => ({
    OPENAI_API_KEYS: ["key-a", "key-b"],
    OPENAI_API: "https://api.openai.com/v1/responses",
    OPENAI_MODEL: "gpt-5.4-mini",
    OPENAI_FALLBACK_MODELS: ["gpt-5.4-nano"],
    OPENAI_REQUEST_TIMEOUT_MS: 5000,
    ...overrides,
  }));
}

function mockCooldown(overrides = {}) {
  vi.doMock(COOLDOWN_PATH, () => ({
    isCombinationCoolingDown: vi.fn().mockResolvedValue(false),
    setCombinationCooldown: vi.fn().mockResolvedValue(undefined),
    parseRetryDelaySeconds: vi.fn().mockReturnValue(null),
    ...overrides,
  }));
}

function jsonResponse(status, body) {
  return {
    status,
    statusText: `status ${status}`,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.doUnmock(CONFIG_PATH);
  vi.doUnmock(COOLDOWN_PATH);
  vi.unstubAllGlobals();
});

describe("openaiWebSearch — text extraction", () => {
  it("uses output_text when present", async () => {
    mockConfig();
    mockCooldown();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { output_text: "The answer." }));
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("what time is it")).resolves.toBe("The answer.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to walking the output array when output_text is absent", async () => {
    mockConfig();
    mockCooldown();
    const body = {
      output: [
        { content: [{ text: "Part one. " }, { text: "Part two." }] },
        { content: [{ notText: "ignored" }] },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).resolves.toBe("Part one. Part two.");
  });

  it("throws when neither output_text nor a walkable output array yields any text", async () => {
    mockConfig();
    mockCooldown();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).rejects.toThrow(/no text output/i);
  });
});

describe("openaiWebSearch — key/model requirements", () => {
  it("throws immediately if OPENAI_API_KEYS is empty, without calling fetch", async () => {
    mockConfig({ OPENAI_API_KEYS: [] });
    mockCooldown();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).rejects.toThrow(/OPENAI_API_KEYS is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openaiWebSearch — cascade behavior", () => {
  it("does NOT cascade on a non-retryable error (e.g. 400) -- fails immediately on the first attempt", async () => {
    mockConfig();
    mockCooldown();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: { message: "bad request" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).rejects.toThrow(/OpenAI API error \(400\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("on a 429, tries the fallback model on the SAME key before rotating keys", async () => {
    mockConfig();
    mockCooldown();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } }))
      .mockResolvedValueOnce(jsonResponse(200, { output_text: "ok from fallback model" }));
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).resolves.toBe("ok from fallback model");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.model).toBe("gpt-5.4-mini");
    expect(secondBody.model).toBe("gpt-5.4-nano");
    // Same key both times -- Authorization header shouldn't change yet.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(fetchMock.mock.calls[1][1].headers.Authorization);
  });

  it("rotates to the next key only after every model on the current key is exhausted", async () => {
    mockConfig();
    mockCooldown();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } })) // key-a, primary model
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } })) // key-a, fallback model
      .mockResolvedValueOnce(jsonResponse(200, { output_text: "ok on second key" })); // key-b, primary model
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).resolves.toBe("ok on second key");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const auth1 = fetchMock.mock.calls[0][1].headers.Authorization;
    const auth2 = fetchMock.mock.calls[1][1].headers.Authorization;
    const auth3 = fetchMock.mock.calls[2][1].headers.Authorization;
    expect(auth1).toBe(auth2); // still key-a for both models
    expect(auth3).not.toBe(auth1); // rotated to key-b
    expect(auth1).toBe("Bearer key-a");
    expect(auth3).toBe("Bearer key-b");
  });

  it("throws the last error once every (model, key) combination is exhausted", async () => {
    mockConfig();
    mockCooldown();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(429, { error: { message: "rate limited everywhere" } }))
    );

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).rejects.toThrow(/rate limited everywhere/);
  });

  it("also cascades on a network-level failure (e.g. timeout/abort), not just HTTP error statuses", async () => {
    mockConfig();
    mockCooldown();
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(jsonResponse(200, { output_text: "recovered" }));
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).resolves.toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips a (model, key) combination already recorded as cooling down, without spending a request on it", async () => {
    mockConfig();
    mockCooldown({
      isCombinationCoolingDown: vi.fn().mockImplementation(async (model) => model === "gpt-5.4-mini"),
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { output_text: "skipped straight to fallback" }));
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).resolves.toBe("skipped straight to fallback");
    // Only one real fetch -- the primary model was skipped via the cooldown check.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-5.4-nano");
  });

  it("records a cooldown via setCombinationCooldown when a 429 is hit", async () => {
    mockCooldown();
    mockConfig();
    const setCombinationCooldown = vi.fn().mockResolvedValue(undefined);
    vi.doMock(COOLDOWN_PATH, () => ({
      isCombinationCoolingDown: vi.fn().mockResolvedValue(false),
      setCombinationCooldown,
      parseRetryDelaySeconds: vi.fn().mockReturnValue(42),
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } }))
      .mockResolvedValueOnce(jsonResponse(200, { output_text: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await openaiWebSearch("q");
    expect(setCombinationCooldown).toHaveBeenCalledWith("gpt-5.4-mini", 0, 42);
  });

  it("does NOT cascade or set a cooldown on a 503 being reported as non-retryable-looking but actually is retried (overload)", async () => {
    mockConfig();
    mockCooldown();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: "overloaded" } }))
      .mockResolvedValueOnce(jsonResponse(200, { output_text: "ok after overload" }));
    vi.stubGlobal("fetch", fetchMock);

    const { openaiWebSearch } = await import(CLIENT_PATH);
    await expect(openaiWebSearch("q")).resolves.toBe("ok after overload");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
