// ---------------------------------------------------------------------------
// test/repomap-embed.test.js — unit tests for connectors/repomap/embed.js
// Covers:
//   - successful embedding request shape & response parsing
//   - API key rotation on 401/403/429 status codes
//   - throwing immediately on non-rotation errors (e.g. 500)
//   - input validation / configuration guard when GEMINI_API_KEYS is empty
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";

describe("connectors/repomap/embed.js", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.resetModules();
  });

  it("throws an error when GEMINI_API_KEYS is empty", async () => {
    vi.doMock("../../config.js", () => ({
      GEMINI_API_KEYS: [],
    }));

    const { embedQuery } = await import("../connectors/repomap/embed.js");
    await expect(embedQuery("test query")).rejects.toThrow(/GEMINI_API_KEYS.*is not set/);
  });

  it("successfully embeds a query with correct request shape and response parsing", async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: mockEmbedding } }),
    });

    vi.doMock("../../config.js", () => ({
      GEMINI_API_KEYS: ["key-1"],
    }));

    const { embedQuery } = await import("../connectors/repomap/embed.js");
    const result = await embedQuery("parse config");

    expect(result).toEqual(mockEmbedding);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain("gemini-embedding-001:embedContent");
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe("key-1");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "parse config" }] },
      outputDimensionality: 1536,
    });
  });

  it("rotates to the next API key on 401/403/429 errors and succeeds", async () => {
    const mockEmbedding = [0.4, 0.5];
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Quota exceeded",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: mockEmbedding } }),
      });

    vi.doMock("../../config.js", () => ({
      GEMINI_API_KEYS: ["key-exhausted", "key-fresh"],
    }));

    const { embedQuery } = await import("../connectors/repomap/embed.js");
    const result = await embedQuery("search query");

    expect(result).toEqual(mockEmbedding);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("key-exhausted");
    expect(global.fetch.mock.calls[1][1].headers["x-goog-api-key"]).toBe("key-fresh");
  });

  it("throws immediately without rotating on non-rotation errors (e.g. 500)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    vi.doMock("../../config.js", () => ({
      GEMINI_API_KEYS: ["key-1", "key-2"],
    }));

    const { embedQuery } = await import("../connectors/repomap/embed.js");
    await expect(embedQuery("test")).rejects.toThrow(/Gemini embeddings request failed \(500\)/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
