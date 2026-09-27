// ---------------------------------------------------------------------------
// test/notion-embed-client.test.js — unit tests for
// connectors/notion/embed_client.js's triggerNotionEmbed().
// Covers:
//   - silent no-op when REPO_MAP_WORKER_URL/REPO_MAP_SHARED_SECRET aren't configured
//   - correct URL, Authorization header, and JSON body on a real call
//   - fire-and-forget contract: never throws, even on a network error or a non-ok response
// Mocks ../config.js the same way test/repomap-embed.test.js does, since
// embed_client.js reads its worker URL/secret from there.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";

describe("connectors/notion/embed_client.js", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.resetModules();
  });

  it("does nothing and does not call fetch when REPO_MAP_WORKER_URL is unset", async () => {
    global.fetch = vi.fn();
    vi.doMock("../config.js", () => ({
      REPO_MAP_WORKER_URL: undefined,
      REPO_MAP_SHARED_SECRET: "secret",
    }));

    const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
    triggerNotionEmbed({ page_id: "p1", content: "hello" });
    // fire-and-forget: give any accidental async call a tick to fire
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does nothing when REPO_MAP_SHARED_SECRET is unset", async () => {
    global.fetch = vi.fn();
    vi.doMock("../config.js", () => ({
      REPO_MAP_WORKER_URL: "https://worker.example.com",
      REPO_MAP_SHARED_SECRET: undefined,
    }));

    const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
    triggerNotionEmbed({ page_id: "p1", content: "hello" });
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("POSTs to <worker>/notion/embed with the correct auth header and JSON body when configured", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ skipped: false }) });
    vi.doMock("../config.js", () => ({
      REPO_MAP_WORKER_URL: "https://worker.example.com",
      REPO_MAP_SHARED_SECRET: "top-secret",
    }));

    const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
    triggerNotionEmbed({ page_id: "page-42", content: "title\nbody text" });
    await new Promise((r) => setTimeout(r, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://worker.example.com/notion/embed");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer top-secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ page_id: "page-42", content: "title\nbody text" });
  });

  it("is not awaited by the caller — returns before the fetch promise settles", async () => {
    let resolveFetch;
    global.fetch = vi.fn().mockImplementation(() => new Promise((r) => { resolveFetch = r; }));
    vi.doMock("../config.js", () => ({
      REPO_MAP_WORKER_URL: "https://worker.example.com",
      REPO_MAP_SHARED_SECRET: "secret",
    }));

    const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
    const returnValue = triggerNotionEmbed({ page_id: "p1", content: "c" });

    expect(returnValue).toBeUndefined();
    resolveFetch({ ok: true, json: async () => ({}) });
  });

  it("swallows a network error (fetch rejection) without throwing", async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.doMock("../config.js", () => ({
      REPO_MAP_WORKER_URL: "https://worker.example.com",
      REPO_MAP_SHARED_SECRET: "secret",
    }));

    const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
    expect(() => triggerNotionEmbed({ page_id: "p1", content: "c" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the rejection be caught internally
  });

  it("does not throw on a non-ok worker response (e.g. 500) -- fetch itself resolves, .catch is a no-op", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    vi.doMock("../config.js", () => ({
      REPO_MAP_WORKER_URL: "https://worker.example.com",
      REPO_MAP_SHARED_SECRET: "secret",
    }));

    const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
    expect(() => triggerNotionEmbed({ page_id: "p1", content: "c" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
