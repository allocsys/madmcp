// ---------------------------------------------------------------------------
// test/notion-create-dedup.test.js -- doCreatePage duplicate protection,
// against a small in-memory fake of Notion (pages + Entity Index database).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NOTION_TOKEN = "test-token";
  process.env.NOTION_MIN_REQUEST_INTERVAL_MS = "1";
});

vi.mock("../connectors/notion/linking.js", () => ({
  findLinkCandidates: vi.fn(async () => ({ strong: [], medium: [] })),
  extractTags: vi.fn(() => []),
}));
vi.mock("../connectors/notion/embed_client.js", () => ({ triggerNotionEmbed: vi.fn(async () => {}), triggerEmbedForPage: vi.fn(async () => {}) }));
vi.mock("../connectors/notion/embed_queries.js", () => ({ findSimilarPages: vi.fn(async () => []), rerankByQuery: vi.fn(async (x) => x) }));

import { doCreatePage } from "../connectors/notion/tools.js";

function makeFakeNotion({ rows = [], pages = {}, hideRowsFromQueryUntil = 0 } = {}) {
  const state = { rows: [...rows], pages: { ...pages }, created: 0, queries: 0, archived: [] };
  let rowSeq = 0;
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const notFound = () => ({ ok: false, status: 404, statusText: "nf", headers: { get: () => null }, text: async () => JSON.stringify({ message: "not found" }) });
  const rowToApi = (r) => ({ id: r.rowId, created_time: r.createdAt, properties: { EntityId: { rich_text: [{ plain_text: r.entity_id }] }, PageId: { rich_text: [{ plain_text: r.page_id }] } } });

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    await new Promise((r) => setTimeout(r, 2)); // let concurrent callers interleave

    if (/^\/databases\/.*\/query$/.test(path)) {
      state.queries++;
      const eq = body?.filter?.rich_text?.equals;
      let found = state.rows.filter((r) => r.entity_id === eq);
      found = [...found].sort((a, b) => a.createdAt - b.createdAt);
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
      state.pages[id] = { id, url: `https://notion.so/${id}`, archived: false, title: body.properties.title.title[0].text.content };
      return ok({ id, url: state.pages[id].url });
    }
    const pageMatch = path.match(/^\/pages\/([\w-]+)$/);
    if (pageMatch) {
      const id = pageMatch[1];
      if (method === "PATCH") {
        if (body.archived) { state.archived.push(id); if (state.pages[id]) state.pages[id].archived = true; state.rows = state.rows.filter((r) => r.rowId !== id); }
        if (body.properties?.PageId) { const r = state.rows.find((x) => x.rowId === id); if (r) r.page_id = body.properties.PageId.rich_text[0].text.content; }
        return ok({});
      }
      const p = state.pages[id];
      if (!p) return notFound();
      return ok({ id, url: p.url, archived: p.archived, properties: { title: { type: "title", title: [{ plain_text: p.title }] } } });
    }
    if (/^\/blocks\/[\w-]+\/children/.test(path)) return ok({ results: [] });
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { state, fetchMock };
}

const args = (extra = {}) => ({ parent_id: "parent", parent_type: "page", title: "My Page", content: "hi", entity_id: "ent-1", ...extra });

describe("doCreatePage duplicate protection", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("concurrent creates for the same entity_id produce exactly one page", async () => {
    const { state, fetchMock } = makeFakeNotion();
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all([doCreatePage(args()), doCreatePage(args()), doCreatePage(args())]);
    expect(state.created).toBe(1);
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(state.rows.filter((r) => r.entity_id === "ent-1")).toHaveLength(1);
  });

  it("repairs a stale index row (deleted page) instead of adding a second row", async () => {
    const { state, fetchMock } = makeFakeNotion({ rows: [{ rowId: "row-stale", entity_id: "ent-1", page_id: "gone", createdAt: 1 }] });
    vi.stubGlobal("fetch", fetchMock);
    const r = await doCreatePage(args());
    expect(r.skipped).toBe(false);
    const rows = state.rows.filter((x) => x.entity_id === "ent-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].page_id).toBe(r.id);
    // and the next call now dedups
    const again = await doCreatePage(args());
    expect(again.skipped).toBe(true);
    expect(state.created).toBe(1);
  });

  it("a create that lost a cross-instance race archives its own page and reports the winner", async () => {
    // Another instance already wrote an OLDER row for a page this instance's
    // dedup check couldn't see yet (simulated by hiding it from the first query).
    const { state, fetchMock } = makeFakeNotion({
      pages: { "page-winner": { id: "page-winner", url: "https://notion.so/page-winner", archived: false, title: "My Page" } },
    });
    let first = true;
    const wrapped = vi.fn(async (url, init) => {
      const path = new URL(url).pathname;
      if (first && /\/databases\/.*\/query$/.test(path)) {
        first = false; // dedup check sees nothing
        state.rows.push({ rowId: "row-winner", entity_id: "ent-1", page_id: "page-winner", createdAt: 0 });
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ results: [] }) };
      }
      return fetchMock(url, init);
    });
    vi.stubGlobal("fetch", wrapped);

    const r = await doCreatePage(args());
    expect(r.skipped).toBe(true);
    expect(r.existingId).toBe("page-winner");
    expect(state.archived).toContain("page-1"); // our page
    expect(state.rows.filter((x) => x.entity_id === "ent-1").map((x) => x.page_id)).toEqual(["page-winner"]);
  });

  it("an ambiguous 5xx on page creation is NOT retried (no second page)", async () => {
    const { state, fetchMock } = makeFakeNotion();
    const wrapped = vi.fn(async (url, init = {}) => {
      if (new URL(url).pathname === "/v1/pages" && init.method === "POST" && !JSON.parse(init.body).parent.database_id) {
        state.created++; // the write landed...
        return { ok: false, status: 504, statusText: "timeout", headers: { get: () => null }, text: async () => "{}" }; // ...but the response was lost
      }
      return fetchMock(url, init);
    });
    vi.stubGlobal("fetch", wrapped);
    await expect(doCreatePage(args())).rejects.toThrow(/may or may not have been applied/);
    expect(state.created).toBe(1);
  });
});
