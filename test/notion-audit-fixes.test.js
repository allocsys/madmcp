// ---------------------------------------------------------------------------
// test/notion-audit-fixes.test.js -- coverage for the 2026-09-28 Notion audit
// fixes in connectors/notion/tools.js (PR #243): N1 index-row upsert, N3
// notion_read fallback, N4 >100-block pagination/batching, N5 rich_text
// chunking, N6 batch isError, N7 page_size clamp.
//
// Mocking strategy: same as test/notion-checkpoint.test.js -- only
// notionRequest (the I/O boundary) is mocked; the real tools.js/client.js
// logic runs against canned responses.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint, doUpdatePage, register } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { buildCheckpointStartText, buildCheckpointEndText } from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return { ...actual, notionRequest: mockedNotionRequest };
});

vi.mock("../connectors/notion/embed_client.js", () => ({
  triggerNotionEmbed: vi.fn(),
}));
vi.mock("../connectors/notion/embed_queries.js", () => ({
  findSimilarPages: vi.fn(),
  getEmbeddingsForPageIds: vi.fn(),
  cosineDistance: vi.fn(),
  rerankByQuery: vi.fn(),
}));
vi.mock("../connectors/repomap/embed.js", () => ({
  embedQuery: vi.fn(),
}));

const INDEX_QUERY_RE = /^\/databases\/.*\/query$/;

function makeFakeServer() {
  const tools = {};
  return { tool: (name, _d, _s, handler) => { tools[name] = handler; }, tools };
}

function blockText(block) {
  return block.paragraph.rich_text.map((t) => t.text.content).join("");
}

function para(id, text) {
  return { id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

const checkpointPageRow = { results: [{ properties: { PageId: { rich_text: [{ plain_text: "page-123" }] } } }] };
const checkpointPage = {
  id: "page-123",
  url: "https://notion.so/page-123",
  properties: { title: { type: "title", title: [{ plain_text: "Session Checkpoint" }] } },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("N4: >100 blocks", () => {
  it("checkpoint load follows has_more/next_cursor to find the end marker on a later page", async () => {
    const start = para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z"));
    const note = para("note-1", "Here are my notes");
    const end = para("end-1", buildCheckpointEndText());

    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (INDEX_QUERY_RE.test(path)) return checkpointPageRow;
      if (path === "/pages/page-123" && method === "GET") return checkpointPage;
      if (path.startsWith("/blocks/page-123/children")) {
        if (path.includes("start_cursor=cur-1")) return { results: [end], has_more: false };
        if (path.includes("page_size=20")) return { results: [] };
        if (path.includes("page_size=100")) return { results: [start, note], has_more: true, next_cursor: "cur-1" };
      }
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    });

    const result = await doCheckpoint({ action: "load" });

    expect(result).toBe("Here are my notes");
    expect(client.notionRequest.mock.calls.some(([p]) => p.includes("start_cursor=cur-1"))).toBe(true);
  });

  it("checkpoint save inserts >100 lines in batches of <=100, sent last-to-first, all anchored after the start marker", async () => {
    const start = para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z"));
    const end = para("end-1", buildCheckpointEndText());

    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (INDEX_QUERY_RE.test(path)) return checkpointPageRow;
      if (path === "/pages/page-123" && method === "GET") return checkpointPage;
      if (path.startsWith("/blocks/page-123/children")) {
        if (method === "PATCH") return {};
        if (path.includes("page_size=20")) return { results: [] };
        if (path.includes("page_size=100")) return { results: [start, end] };
      }
      if (/^\/blocks\/[\w-]+$/.test(path) && method === "PATCH") return {};
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    });

    const notes = Array.from({ length: 250 }, (_, i) => `line-${i}`).join("\n");
    await doCheckpoint({ action: "save", notes });

    const inserts = client.notionRequest.mock.calls.filter(
      ([p, o]) => p === "/blocks/page-123/children" && o?.method === "PATCH" && o?.body?.after === "start-1"
    );
    expect(inserts.map(([, o]) => o.body.children.length)).toEqual([50, 100, 100]);
    // last chunk goes first, first chunk goes last, so final order is preserved
    expect(blockText(inserts[0][1].body.children[0])).toBe("line-200");
    expect(blockText(inserts[2][1].body.children[0])).toBe("line-0");
  });

  it("notion_update replacements finds a block that sits past the first 100 blocks", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (path.startsWith("/blocks/p1/children") && method === "GET") {
        if (path.includes("start_cursor=c2")) return { results: [para("far-block", "target text")], has_more: false };
        return { results: [para("b0", "first")], has_more: true, next_cursor: "c2" };
      }
      if (path === "/blocks/far-block" && method === "PATCH") return {};
      if (path === "/blocks/p1/children" && method === "PATCH") return {}; // changelog
      if (path === "/pages/p1") return { id: "p1", properties: {} };
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    });

    const results = await doUpdatePage({ page_id: "p1", replacements: [{ find: "target text", replace: "new text" }] });

    expect(results[0]).toContain("Replaced block");
    expect(client.notionRequest).toHaveBeenCalledWith("/blocks/far-block", expect.objectContaining({ method: "PATCH" }));
  });

  it("notion_update append_content batches >100 paragraphs into multiple PATCH calls in order", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (path === "/blocks/p1/children" && method === "PATCH") return {};
      if (path === "/pages/p1") return { id: "p1", properties: {} };
      if (path.startsWith("/blocks/p1/children")) return { results: [] };
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    });

    const content = Array.from({ length: 130 }, (_, i) => `p-${i}`).join("\n");
    await doUpdatePage({ page_id: "p1", append_content: content });

    const appends = client.notionRequest.mock.calls.filter(
      ([p, o]) => p === "/blocks/p1/children" && o?.method === "PATCH" && o.body.children.length > 1
    );
    expect(appends.map(([, o]) => o.body.children.length)).toEqual([100, 30]);
    expect(blockText(appends[0][1].body.children[0])).toBe("p-0");
    expect(blockText(appends[1][1].body.children[0])).toBe("p-100");
  });
});

describe("N1: entity_id update upserts the index row", () => {
  function routeFor({ existingRow }) {
    return async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (INDEX_QUERY_RE.test(path)) return { results: existingRow ? [{ id: "row-1" }] : [] };
      if (path === "/pages/row-1" && method === "PATCH") return {};
      if (path === "/pages" && method === "POST") return { id: "new-row" };
      if (path === "/pages/p1" && method === "GET") return { id: "p1", url: "https://notion.so/p1", properties: {} };
      if (path === "/blocks/p1/children" && method === "PATCH") return {};
      if (path.startsWith("/blocks/p1/children")) return { results: [] };
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    };
  }

  it("PATCHes the existing row instead of POSTing a duplicate", async () => {
    client.notionRequest.mockImplementation(routeFor({ existingRow: true }));

    const results = await doUpdatePage({ page_id: "p1", entity_id: "my-entity" });

    expect(results.join(" ")).toContain('Entity ID updated to "my-entity"');
    const rowPatch = client.notionRequest.mock.calls.find(([p, o]) => p === "/pages/row-1" && o?.method === "PATCH");
    expect(rowPatch).toBeTruthy();
    expect(rowPatch[1].body.properties.PageId.rich_text[0].text.content).toBe("p1");
    const indexPosts = client.notionRequest.mock.calls.filter(
      ([p, o]) => p === "/pages" && o?.method === "POST" && o.body?.parent?.database_id
    );
    expect(indexPosts).toHaveLength(0);
  });

  it("creates a new row when none exists for the entity_id", async () => {
    client.notionRequest.mockImplementation(routeFor({ existingRow: false }));

    await doUpdatePage({ page_id: "p1", entity_id: "my-entity" });

    const indexPosts = client.notionRequest.mock.calls.filter(
      ([p, o]) => p === "/pages" && o?.method === "POST" && o.body?.parent?.database_id
    );
    expect(indexPosts).toHaveLength(1);
    expect(indexPosts[0][1].body.properties.EntityId.rich_text[0].text.content).toBe("my-entity");
  });
});

describe("N3: notion_read database fallback", () => {
  let notionRead;
  beforeEach(() => {
    const server = makeFakeServer();
    register(server);
    notionRead = server.tools["notion_read"];
  });

  it("does NOT fall back to the database lookup on a 401 and surfaces the real error", async () => {
    client.notionRequest.mockImplementation(async () => {
      throw new Error("Notion API error (401): API token is invalid.");
    });

    const result = await notionRead({ id: "id1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
    expect(client.notionRequest.mock.calls.some(([p]) => p.startsWith("/databases/"))).toBe(false);
  });

  it("falls back to the database lookup on a 404 from the page fetch", async () => {
    client.notionRequest.mockImplementation(async (path) => {
      if (path.startsWith("/pages/") || path.startsWith("/blocks/")) throw new Error("Notion API error (404): not a page");
      if (path === "/databases/id1") return { id: "id1", url: "https://notion.so/id1", title: [{ plain_text: "My DB" }], properties: { Name: { type: "title" } } };
      throw new Error(`Unexpected notionRequest call: ${path}`);
    });

    const result = await notionRead({ id: "id1" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("ID: id1");
    expect(result.content[0].text).toContain("Name: title");
  });

  it("reports both failures when the ID is neither a page nor a database", async () => {
    client.notionRequest.mockImplementation(async (path) => {
      if (path.startsWith("/databases/")) throw new Error("Notion API error (404): no such database");
      throw new Error("Notion API error (404): no such page");
    });

    const result = await notionRead({ id: "id1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("as a page");
    expect(result.content[0].text).toContain("as a database");
  });
});

describe("N5: long text is chunked to Notion's 2000-char rich_text limit", () => {
  it("chunks a long replacement", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (path.startsWith("/blocks/p1/children") && method === "GET") return { results: [para("b1", "old")] };
      if (path === "/blocks/b1" && method === "PATCH") return {};
      if (path === "/blocks/p1/children" && method === "PATCH") return {};
      if (path === "/pages/p1") return { id: "p1", properties: {} };
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    });

    const long = "x".repeat(4500);
    await doUpdatePage({ page_id: "p1", replacements: [{ find: "old", replace: long }] });

    const patch = client.notionRequest.mock.calls.find(([p, o]) => p === "/blocks/b1" && o?.method === "PATCH");
    const parts = patch[1].body.paragraph.rich_text;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((t) => t.text.content.length <= 2000)).toBe(true);
    expect(parts.map((t) => t.text.content).join("")).toBe(long);
  });

  it("chunks a long title", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (path === "/pages/p1" && method === "PATCH") return { id: "p1", properties: { title: { type: "title", title: [{ plain_text: "t" }] } } };
      if (path === "/blocks/p1/children" && method === "PATCH") return {};
      if (path === "/pages/p1") return { id: "p1", properties: {} };
      if (path.startsWith("/blocks/p1/children")) return { results: [] };
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    });

    const long = "t".repeat(4500);
    await doUpdatePage({ page_id: "p1", title: long });

    const patch = client.notionRequest.mock.calls.find(([p, o]) => p === "/pages/p1" && o?.method === "PATCH");
    const parts = patch[1].body.properties.title.title;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((t) => t.text.content.length <= 2000)).toBe(true);
    expect(parts.map((t) => t.text.content).join("")).toBe(long);
  });
});

describe("N6: batch results carry isError only when every item failed", () => {
  let notionUpdate;
  beforeEach(() => {
    const server = makeFakeServer();
    register(server);
    notionUpdate = server.tools["notion_update"];
  });

  it("isError when the only item fails", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      if (path.startsWith("/blocks/p1/children") && (opts.method || "GET") === "GET") return { results: [] };
      throw new Error(`Unexpected notionRequest call: ${path}`);
    });

    const result = await notionUpdate({ type: "page", items: [{ page_id: "p1", replacements: [{ find: "missing", replace: "x" }] }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("0/1 page(s) updated");
  });

  it("not an error when at least one item succeeds", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";
      if (path.startsWith("/blocks/p1/children") && method === "GET") return { results: [] };
      if (path === "/blocks/p2/children" && method === "PATCH") return {};
      if (path === "/pages/p2") return { id: "p2", properties: {} };
      if (path.startsWith("/blocks/p2/children")) return { results: [] };
      throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
    });

    const result = await notionUpdate({
      type: "page",
      items: [
        { page_id: "p1", replacements: [{ find: "missing", replace: "x" }] },
        { page_id: "p2", append_content: "hello" },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("1/2 page(s) updated");
  });

  it("notion_create database: isError when every item fails", async () => {
    const server = makeFakeServer();
    register(server);
    client.notionRequest.mockRejectedValue(new Error("Notion API error (400): bad"));

    const result = await server.tools["notion_create"]({ type: "database", items: [{ parent_page_id: "pp", title: "DB", properties: {} }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("0/1 database(s) created");
  });
});

describe("N7: page_size clamp", () => {
  it("notion_find recent clamps page_size to 100", async () => {
    const server = makeFakeServer();
    register(server);
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      if (path === "/search" && opts.method === "POST") return { results: [] };
      throw new Error(`Unexpected notionRequest call: ${path}`);
    });

    await server.tools["notion_find"]({ mode: "recent", page_size: 500 });

    const searchCall = client.notionRequest.mock.calls.find(([p]) => p === "/search");
    expect(searchCall[1].body.page_size).toBe(100);
  });

  it("notion_read clamps page_size for block reads", async () => {
    const server = makeFakeServer();
    register(server);
    client.notionRequest.mockImplementation(async (path) => {
      if (path.startsWith("/pages/")) return { id: "p1", url: "u", properties: {} };
      if (path.startsWith("/blocks/p1/children")) return { results: [] };
      throw new Error(`Unexpected notionRequest call: ${path}`);
    });

    await server.tools["notion_read"]({ id: "p1", page_size: 999 });

    expect(client.notionRequest.mock.calls.some(([p]) => p.includes("page_size=100"))).toBe(true);
    expect(client.notionRequest.mock.calls.some(([p]) => p.includes("page_size=999"))).toBe(false);
  });
});
