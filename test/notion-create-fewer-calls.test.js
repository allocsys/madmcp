// ---------------------------------------------------------------------------
// test/notion-create-fewer-calls.test.js -- doCreatePage request count and
// concurrency (perf): fuzzy-dedup and link-candidate lookups overlap, and the
// post-create index writes reuse one index query.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NOTION_TOKEN = "test-token";
  process.env.NOTION_MIN_REQUEST_INTERVAL_MS = "1";
});

const gates = vi.hoisted(() => ({ started: [], release: null }));

vi.mock("../connectors/notion/linking.js", () => ({
  findLinkCandidates: vi.fn(async () => {
    gates.started.push("links");
    await gates.release;
    return { strong: [], medium: [] };
  }),
  extractTags: vi.fn(() => []),
}));
vi.mock("../connectors/notion/embed_client.js", () => ({ triggerNotionEmbed: vi.fn(async () => {}), triggerEmbedForPage: vi.fn(async () => {}) }));
vi.mock("../connectors/notion/embed_queries.js", () => ({
  findSimilarPages: vi.fn(async () => {
    gates.started.push("similar");
    await gates.release;
    return [];
  }),
  rerankByQuery: vi.fn(async (x) => x),
}));

import { doCreatePage } from "../connectors/notion/tools.js";

function makeFakeNotion({ rows = [] } = {}) {
  const state = { rows: [...rows], created: 0, queries: 0, pageGets: 0, rowPatches: 0 };
  let rowSeq = 0;
  const pages = {};
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const notFound = () => ({ ok: false, status: 404, statusText: "nf", headers: { get: () => null }, text: async () => JSON.stringify({ message: "not found" }) });
  const rowToApi = (r) => ({ id: r.rowId, created_time: r.createdAt, properties: { EntityId: { rich_text: [{ plain_text: r.entity_id }] }, PageId: { rich_text: [{ plain_text: r.page_id }] } } });

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (/^\/databases\/.*\/query$/.test(path)) {
      state.queries++;
      const eq = body?.filter?.rich_text?.equals;
      const found = state.rows.filter((r) => r.entity_id === eq).sort((a, b) => a.createdAt - b.createdAt);
      return ok({ results: found.slice(0, body.page_size || 100).map(rowToApi) });
    }
    if (path === "/pages" && method === "POST") {
      if (body.parent.database_id) {
        const props = body.properties;
        const row = { rowId: `row-${++rowSeq}`, entity_id: props.EntityId.rich_text[0].text.content, page_id: props.PageId.rich_text[0].text.content, createdAt: Date.now() + rowSeq };
        state.rows.push(row);
        return ok({ id: row.rowId });
      }
      const id = `page-${++state.created}`;
      pages[id] = { id, url: `https://notion.so/${id}`, archived: false, title: body.properties.title.title[0].text.content };
      return ok({ id, url: pages[id].url });
    }
    const pageMatch = path.match(/^\/pages\/([\w-]+)$/);
    if (pageMatch) {
      const id = pageMatch[1];
      if (method === "PATCH") {
        if (body.properties?.PageId) {
          state.rowPatches++;
          const r = state.rows.find((x) => x.rowId === id);
          if (r) r.page_id = body.properties.PageId.rich_text[0].text.content;
        }
        return ok({});
      }
      state.pageGets++;
      const p = pages[id];
      if (!p) return notFound();
      return ok({ id, url: p.url, archived: p.archived, properties: { title: { type: "title", title: [{ plain_text: p.title }] } } });
    }
    if (/^\/blocks\/[\w-]+\/children/.test(path)) return ok({ results: [] });
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { state, fetchMock };
}

const args = (extra = {}) => ({ parent_id: "parent", parent_type: "page", title: "My Page", content: "hi", entity_id: "ent-1", ...extra });

describe("doCreatePage request count and overlap", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    gates.started = [];
    gates.release = Promise.resolve();
  });

  it("starts fuzzy-dedup and link-candidate lookups together", async () => {
    let open;
    gates.release = new Promise((r) => { open = r; });
    const { fetchMock } = makeFakeNotion();
    vi.stubGlobal("fetch", fetchMock);
    const p = doCreatePage(args());
    // Both must start while neither has finished.
    await vi.waitFor(() => expect([...gates.started].sort()).toEqual(["links", "similar"]));
    open();
    const r = await p;
    expect(r.skipped).toBe(false);
  });

  it("fresh create: 3 index queries, no index-row lookup repeated, no extra page GET", async () => {
    const { state, fetchMock } = makeFakeNotion();
    vi.stubGlobal("fetch", fetchMock);
    const r = await doCreatePage(args());
    expect(r.skipped).toBe(false);
    expect(r.indexError).toBeNull();
    // first dedup check + pre-write winner check + reconcile
    expect(state.queries).toBe(3);
    expect(state.pageGets).toBe(0);
    expect(state.rows.filter((x) => x.entity_id === "ent-1")).toHaveLength(1);
  });

  it("stale row for the entity_id: repointed in place using the row id already fetched", async () => {
    const { state, fetchMock } = makeFakeNotion({ rows: [{ rowId: "row-stale", entity_id: "ent-1", page_id: "gone", createdAt: 1 }] });
    vi.stubGlobal("fetch", fetchMock);
    const r = await doCreatePage(args());
    expect(r.skipped).toBe(false);
    const rows = state.rows.filter((x) => x.entity_id === "ent-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].page_id).toBe("page-1");
    expect(state.rowPatches).toBe(1);
  });

  it("link/dup lookup failures do not block the create", async () => {
    const { findLinkCandidates } = await import("../connectors/notion/linking.js");
    const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");
    findLinkCandidates.mockImplementationOnce(async () => { throw new Error("search down"); });
    findSimilarPages.mockImplementationOnce(async () => { throw new Error("neon down"); });
    const { fetchMock } = makeFakeNotion();
    vi.stubGlobal("fetch", fetchMock);
    const r = await doCreatePage(args());
    expect(r.skipped).toBe(false);
    expect(r.possibleDuplicates).toEqual([]);
    expect(r.linkCandidates).toEqual({ strong: [], medium: [] });
  });
});
