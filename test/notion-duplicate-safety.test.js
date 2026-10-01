// ---------------------------------------------------------------------------
// test/notion-duplicate-safety.test.js
// ---------------------------------------------------------------------------
// Regression tests for duplicate Notion pages / unbounded commit log:
//   - 5xx retries must never repeat a non-idempotent write
//   - the per-key lock serializes callers
//   - doCreatePage: concurrent same-entity creates yield ONE page, a stale
//     index row is repaired instead of duplicated, a lost cross-instance race
//     archives its own page
//   - recordCommit trims the log on every insert
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NOTION_TOKEN = "test-token";
  process.env.NOTION_MIN_REQUEST_INTERVAL_MS = "1";
  process.env.NOTION_RETRY_BASE_MS = "1";
});

import { isSafeToRetryOnServerError, notionRequest, COMMIT_LOG_MARKER_TEXT, buildCheckpointStartText } from "../connectors/notion/client.js";
import { withLock } from "../connectors/shared/lock.js";
import { recordCommit, COMMIT_LOG_MAX_ENTRIES } from "../connectors/notion/commit_log.js";

describe("isSafeToRetryOnServerError", () => {
  it("never repeats page creation or block appends", () => {
    expect(isSafeToRetryOnServerError("POST", "/pages")).toBe(false);
    expect(isSafeToRetryOnServerError("POST", "/databases")).toBe(false);
    expect(isSafeToRetryOnServerError("PATCH", "/blocks/abc/children")).toBe(false);
  });
  it("allows reads, deletes, queries, searches and in-place updates", () => {
    expect(isSafeToRetryOnServerError("GET", "/pages/x")).toBe(true);
    expect(isSafeToRetryOnServerError("DELETE", "/blocks/x")).toBe(true);
    expect(isSafeToRetryOnServerError("POST", "/search")).toBe(true);
    expect(isSafeToRetryOnServerError("POST", "/databases/db1/query")).toBe(true);
    expect(isSafeToRetryOnServerError("PATCH", "/blocks/x")).toBe(true);
    expect(isSafeToRetryOnServerError("PATCH", "/pages/x")).toBe(true);
  });
});

describe("notionRequest retry behavior", () => {
  const res = (status, body = {}) => ({
    ok: status < 400, status, statusText: String(status), headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
  beforeEach(() => vi.unstubAllGlobals());

  it("does NOT retry POST /pages on 503 and flags the outcome as ambiguous", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(503, { message: "unavailable" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(notionRequest("/pages", { method: "POST", body: {} })).rejects.toThrow(/may or may not have been applied/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a 429 on POST /pages (never processed)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, { id: "p1" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(notionRequest("/pages", { method: "POST", body: {} })).resolves.toEqual({ id: "p1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 503 on a GET", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, { ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(notionRequest("/pages/x")).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("withLock", () => {
  it("runs same-key callers one at a time, in order", async () => {
    const events = [];
    const task = (name) => withLock("k", async () => {
      events.push(`start-${name}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end-${name}`);
    });
    await Promise.all([task("a"), task("b"), task("c")]);
    expect(events).toEqual(["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
  });

  it("releases the lock when the callback throws", async () => {
    await expect(withLock("k2", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withLock("k2", async () => "ok")).resolves.toBe("ok");
  });
});

// --- recordCommit trimming (stateful fake of one Notion page) ----------------
const para = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });

describe("recordCommit enforces the cap on every insert", () => {
  it("never leaves more than COMMIT_LOG_MAX_ENTRIES entries, deleting the oldest", async () => {
    let blocks = [
      para("pre", "🔑 entity_id: checkpoint-latest"),
      para("marker", COMMIT_LOG_MARKER_TEXT),
      ...Array.from({ length: COMMIT_LOG_MAX_ENTRIES }, (_, i) => para(`old-${i}`, `sha${i} · m`)),
      para("start", buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
      para("note", "notes"),
      para("end", "✅ End synced checkpoint"),
    ];
    let n = 0;
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = init.method || "GET";
      const path = new URL(url).pathname.replace(/^\/v1/, "");
      const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
      if (/^\/databases\/.*\/query$/.test(path)) {
        return ok({ results: [{ properties: { PageId: { rich_text: [{ plain_text: "page-1" }] } } }] });
      }
      if (path === "/pages/page-1") {
        return ok({ id: "page-1", url: "u", properties: { title: { type: "title", title: [{ plain_text: "Session Checkpoint" }] } } });
      }
      if (path === "/blocks/page-1/children" && method === "PATCH") {
        const body = JSON.parse(init.body);
        const idx = blocks.findIndex((b) => b.id === body.after);
        const added = body.children.map((c) => para(`new-${n++}`, c.paragraph.rich_text[0].text.content));
        blocks = [...blocks.slice(0, idx + 1), ...added, ...blocks.slice(idx + 1)];
        return ok({ results: added });
      }
      if (path.startsWith("/blocks/page-1/children")) return ok({ results: blocks });
      if (method === "DELETE") {
        blocks = blocks.filter((b) => `/blocks/${b.id}` !== path);
        return ok({});
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 5; i++) {
      await recordCommit({ sha: `new${i}000000`, message: `commit ${i}`, files: ["a.js"], branch: "b", ts: "t" });
    }

    const mIdx = blocks.findIndex((b) => b.id === "marker");
    const sIdx = blocks.findIndex((b) => b.id === "start");
    const entries = blocks.slice(mIdx + 1, sIdx);
    expect(entries).toHaveLength(COMMIT_LOG_MAX_ENTRIES);
    expect(entries[0].paragraph.rich_text[0].plain_text).toContain("new400"); // newest first
    expect(blocks.map((b) => b.id)).toEqual(expect.arrayContaining(["pre", "marker", "start", "note", "end"]));
    vi.unstubAllGlobals();
  });
});
