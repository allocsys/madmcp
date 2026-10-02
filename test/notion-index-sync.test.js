// ---------------------------------------------------------------------------
// test/notion-index-sync.test.js -- Entity Index stays in sync with page
// archive/restore, an archived page no longer blocks re-creating its
// entity_id, and index Tags are read as multi_select.
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

import { doCreatePage, doUpdatePage } from "../connectors/notion/tools.js";
import { queryAllIndexEntries } from "../connectors/notion/client.js";

const marker = (entity_id) => {
  const text = `\u{1F511} entity_id: ${entity_id}`;
  return { id: `blk-${entity_id}`, type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: text, text: { content: text } }] } };
};

// Small in-memory Notion: pages, Entity Index rows (queried by EntityId or
// PageId, archived rows disappear from queries like in real Notion) and
// per-page blocks.
function makeFakeNotion({ rows = [], pages = {}, blocks = {} } = {}) {
  const state = { rows: rows.map((r) => ({ ...r })), pages: JSON.parse(JSON.stringify(pages)), blocks, created: 0, archivedRows: [], archivedPages: [] };
  let rowSeq = 0;
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const notFound = () => ({ ok: false, status: 404, statusText: "nf", headers: { get: () => null }, text: async () => JSON.stringify({ message: "not found" }) });
  const rowToApi = (r) => ({
    id: r.rowId,
    properties: {
      EntityId: { rich_text: [{ plain_text: r.entity_id }] },
      PageId: { rich_text: [{ plain_text: r.page_id }] },
      Tags: { multi_select: (r.tags || []).map((name) => ({ name })) },
    },
  });
  const pageToApi = (p) => ({ id: p.id, url: p.url, archived: p.archived, properties: { title: { type: "title", title: [{ plain_text: p.title }] } } });

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (/^\/databases\/.*\/query$/.test(path)) {
      const { property, rich_text } = body?.filter || {};
      const key = property === "PageId" ? "page_id" : "entity_id";
      const found = state.rows.filter((r) => r[key] === rich_text?.equals);
      return ok({ results: found.slice(0, body.page_size || 100).map(rowToApi) });
    }
    if (path === "/pages" && method === "POST") {
      if (body.parent.database_id) {
        const props = body.properties;
        const row = {
          rowId: `row-new-${++rowSeq}`,
          entity_id: props.EntityId.rich_text[0].text.content,
          page_id: props.PageId.rich_text[0].text.content,
          tags: (props.Tags?.multi_select || []).map((t) => t.name),
        };
        state.rows.push(row);
        return ok({ id: row.rowId });
      }
      const id = `page-new-${++state.created}`;
      state.pages[id] = { id, url: `https://notion.so/${id}`, archived: false, title: body.properties.title.title[0].text.content };
      return ok({ id, url: state.pages[id].url });
    }
    const pageMatch = path.match(/^\/pages\/([\w-]+)$/);
    if (pageMatch) {
      const id = pageMatch[1];
      if (method === "PATCH") {
        const rowIdx = state.rows.findIndex((r) => r.rowId === id);
        if (rowIdx !== -1) {
          if (body.archived) { state.archivedRows.push(id); state.rows.splice(rowIdx, 1); }
          else if (body.properties?.PageId) {
            state.rows[rowIdx].page_id = body.properties.PageId.rich_text[0].text.content;
          }
          return ok({ id });
        }
        const p = state.pages[id];
        if (!p) return notFound();
        if (body.archived === true) { p.archived = true; state.archivedPages.push(id); }
        if (body.archived === false) p.archived = false;
        return ok(pageToApi(p));
      }
      const p = state.pages[id];
      if (!p) return notFound();
      return ok(pageToApi(p));
    }
    const blockMatch = path.match(/^\/blocks\/([\w-]+)\/children/);
    if (blockMatch) {
      if (method === "PATCH") return ok({ results: [] });
      return ok({ results: state.blocks[blockMatch[1]] || [] });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { state, fetchMock };
}

const livePage = (id, title = "T") => ({ id, url: `https://notion.so/${id}`, archived: false, title });
const archivedPage = (id, title = "T") => ({ ...livePage(id, title), archived: true });

describe("archiving a page archives its Entity Index row", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("archives the row that points at the page", async () => {
    const { state, fetchMock } = makeFakeNotion({
      rows: [{ rowId: "row-1", entity_id: "ent-1", page_id: "page-1" }, { rowId: "row-2", entity_id: "ent-2", page_id: "page-2" }],
      pages: { "page-1": livePage("page-1"), "page-2": livePage("page-2") },
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await doUpdatePage({ page_id: "page-1", archived: true });
    expect(state.pages["page-1"].archived).toBe(true);
    expect(state.archivedRows).toEqual(["row-1"]);
    expect(state.rows.map((r) => r.rowId)).toEqual(["row-2"]);
    expect(results.join(" ")).toMatch(/Archived 1 index row/);
  });

  it("leaves the index alone for a page that was never tracked", async () => {
    const { state, fetchMock } = makeFakeNotion({
      rows: [{ rowId: "row-2", entity_id: "ent-2", page_id: "page-2" }],
      pages: { "page-9": livePage("page-9"), "page-2": livePage("page-2") },
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await doUpdatePage({ page_id: "page-9", archived: true });
    expect(state.archivedRows).toEqual([]);
    expect(state.rows).toHaveLength(1);
    expect(results.join(" ")).not.toMatch(/index row/);
  });

  it("still archives the page and reports a warning if the index cleanup fails", async () => {
    const { state, fetchMock } = makeFakeNotion({ pages: { "page-1": livePage("page-1") } });
    const wrapped = vi.fn(async (url, init) => {
      if (/\/databases\/.*\/query$/.test(new URL(url).pathname)) {
        return { ok: false, status: 400, statusText: "bad", headers: { get: () => null }, text: async () => JSON.stringify({ message: "boom" }) };
      }
      return fetchMock(url, init);
    });
    vi.stubGlobal("fetch", wrapped);
    const results = await doUpdatePage({ page_id: "page-1", archived: true });
    expect(state.pages["page-1"].archived).toBe(true);
    expect(results.join(" ")).toMatch(/index row not archived/);
  });
});

describe("an archived page no longer blocks re-creating its entity_id", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("creates a new page and repoints the stale row in place", async () => {
    const { state, fetchMock } = makeFakeNotion({
      rows: [{ rowId: "row-1", entity_id: "ent-1", page_id: "page-old" }],
      pages: { "page-old": archivedPage("page-old") },
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await doCreatePage({ parent_id: "parent", parent_type: "page", title: "New", content: "hi", entity_id: "ent-1" });
    expect(r.skipped).toBe(false);
    expect(state.created).toBe(1);
    expect(state.archivedPages).toEqual([]); // the new page is NOT archived by the race check
    const rows = state.rows.filter((x) => x.entity_id === "ent-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].page_id).toBe(r.id);
  });

  it("still dedups against a LIVE page", async () => {
    const { state, fetchMock } = makeFakeNotion({
      rows: [{ rowId: "row-1", entity_id: "ent-1", page_id: "page-live" }],
      pages: { "page-live": livePage("page-live") },
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await doCreatePage({ parent_id: "parent", parent_type: "page", title: "New", content: "hi", entity_id: "ent-1" });
    expect(r.skipped).toBe(true);
    expect(r.existingId).toBe("page-live");
    expect(state.created).toBe(0);
  });
});

describe("restoring an archived page restores its index row", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("re-creates the row from the entity_id marker", async () => {
    const { state, fetchMock } = makeFakeNotion({
      pages: { "page-1": archivedPage("page-1") },
      blocks: { "page-1": [marker("ent-1")] },
    });
    vi.stubGlobal("fetch", fetchMock);
    await doUpdatePage({ page_id: "page-1", archived: false });
    expect(state.pages["page-1"].archived).toBe(false);
    const rows = state.rows.filter((r) => r.entity_id === "ent-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].page_id).toBe("page-1");
  });

  it("does not take over an entity_id that a different live page owns", async () => {
    const { state, fetchMock } = makeFakeNotion({
      rows: [{ rowId: "row-1", entity_id: "ent-1", page_id: "page-live" }],
      pages: { "page-old": archivedPage("page-old"), "page-live": livePage("page-live") },
      blocks: { "page-old": [marker("ent-1")] },
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await doUpdatePage({ page_id: "page-old", archived: false });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].page_id).toBe("page-live");
    expect(results.join(" ")).toMatch(/now belongs to another live page/);
  });

  it("does nothing for a page without an entity_id marker", async () => {
    const { state, fetchMock } = makeFakeNotion({ pages: { "page-1": archivedPage("page-1") } });
    vi.stubGlobal("fetch", fetchMock);
    await doUpdatePage({ page_id: "page-1", archived: false });
    expect(state.rows).toHaveLength(0);
  });
});

describe("queryAllIndexEntries reads Tags as multi_select", () => {
  beforeEach(() => vi.unstubAllGlobals());

  const stubRows = (results) => vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ results, has_more: false }),
  })));

  it("returns lowercased tag names from a multi_select column", async () => {
    stubRows([{
      id: "r1",
      properties: {
        EntityId: { rich_text: [{ plain_text: "ent-1" }] },
        PageId: { rich_text: [{ plain_text: "page-1" }] },
        Url: { url: "https://notion.so/page-1" },
        Tags: { multi_select: [{ name: "Job-Lead" }, { name: "laborx" }] },
      },
    }]);
    const entries = await queryAllIndexEntries();
    expect(entries).toEqual([{ entity_id: "ent-1", page_id: "page-1", url: "https://notion.so/page-1", tags: ["job-lead", "laborx"] }]);
  });

  it("falls back to comma-separated rich_text, and to [] when Tags is empty", async () => {
    stubRows([
      { id: "r1", properties: { EntityId: { rich_text: [{ plain_text: "a" }] }, PageId: { rich_text: [{ plain_text: "pa" }] }, Tags: { rich_text: [{ plain_text: "X, y" }] } } },
      { id: "r2", properties: { EntityId: { rich_text: [{ plain_text: "b" }] }, PageId: { rich_text: [{ plain_text: "pb" }] }, Tags: { multi_select: [] } } },
    ]);
    const entries = await queryAllIndexEntries();
    expect(entries.map((e) => e.tags)).toEqual([["x", "y"], []]);
  });
});
