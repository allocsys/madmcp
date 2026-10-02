// ---------------------------------------------------------------------------
// test/notion-markdown.test.js -- markdown read/edit path for Notion pages
// (connectors/notion/markdown.js + notion_read / notion_update in tools.js).
// Only notionRequest (the I/O boundary) is mocked.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doUpdatePage, register } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import {
  extractMarkerLines, parseMarkdownMarkers, splitChangelog, withPreservedMarkers,
} from "../connectors/notion/markdown.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = vi.fn();
  actual.clientInternals.notionRequest = mocked;
  return { ...actual, notionRequest: mocked };
});
vi.mock("../connectors/notion/embed_client.js", () => ({ triggerNotionEmbed: vi.fn(async () => {}) }));
vi.mock("../connectors/notion/embed_queries.js", () => ({
  findSimilarPages: vi.fn(async () => []), rerankByQuery: vi.fn(async (_q, c) => c),
}));
vi.mock("../connectors/repomap/embed.js", () => ({ embedQuery: vi.fn() }));

const PAGE = {
  id: "p1", url: "https://notion.so/p1", created_time: "2026-01-01T00:00:00Z", last_edited_time: "2026-01-02T00:00:00Z",
  properties: { title: { type: "title", title: [{ plain_text: "Big page" }] } },
};

function fakeServer() {
  const tools = {};
  return { tool: (name, _d, _s, handler) => { tools[name] = handler; }, tools };
}

function route(handlers) {
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    for (const [re, fn] of handlers) if (re.test(`${opts.method || "GET"} ${path}`)) return fn(path, opts);
    throw new Error(`Notion API error (404): no mock for ${opts.method || "GET"} ${path}`);
  });
}

beforeEach(() => { vi.resetAllMocks(); });

describe("markdown helpers", () => {
  const md = [
    "\u{1F511} entity_id: plan-x", "\u{1F3F7}\uFE0F status: open", "\u{1F517} blocks -> other-thing",
    "# Title", "```", "\u{1F511} entity_id: fake-in-code", "\u{1F4DC} not-a-changelog", "```",
    "body", "\u{1F4DC} 2026-01-01 12:00 UTC \u2014 Updated",
  ].join("\n");

  it("parses markers and ignores lines inside code fences", () => {
    expect(parseMarkdownMarkers(md)).toEqual({
      entity_id: "plan-x", status: "open", relations: [{ relation: "blocks", to_entity_id: "other-thing" }],
    });
  });

  it("splits changelog lines out of the body but keeps fenced ones", () => {
    const { body, history } = splitChangelog(md);
    expect(history).toEqual(["\u{1F4DC} 2026-01-01 12:00 UTC \u2014 Updated"]);
    expect(body).toContain("not-a-changelog");
    expect(body).not.toContain("Updated");
  });

  it("re-attaches only the marker lines the new content lacks", () => {
    expect(withPreservedMarkers("# New", md)).toBe(`${extractMarkerLines(md).join("\n")}\n# New`);
    const out = withPreservedMarkers("\u{1F511} entity_id: other\nhello", md);
    expect(out).not.toContain("plan-x");
    expect(out).toContain("status: open");
  });
});

describe("notion_read (markdown)", () => {
  async function read(args) {
    const server = fakeServer();
    register(server);
    return server.tools.notion_read(args);
  }

  it("returns whole-page markdown, hides changelog, parses markers, sends the 2026 version header", async () => {
    route([
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/pages\/p1\/markdown$/, () => ({ object: "page_markdown", id: "p1", truncated: false, unknown_block_ids: [],
        markdown: "\u{1F511} entity_id: e1\n<details>\n<summary>T</summary>\n\tnested text\n</details>\n\u{1F4DC} 2026-01-01 12:00 UTC \u2014 x" })],
    ]);
    const res = await read({ id: "p1" });
    const text = res.content[0].text;
    expect(res.isError).toBeUndefined();
    expect(text).toContain("# Big page");
    expect(text).toContain("Entity ID: e1");
    expect(text).toContain("nested text");
    expect(text).toContain("1 changelog entry");
    expect(text).not.toContain("12:00 UTC");
    const mdCall = client.notionRequest.mock.calls.find(([p]) => p.endsWith("/markdown"));
    expect(mdCall[1]).toMatchObject({ version: "2026-03-11" });
  });

  it("pages a long page by offset and tells the caller where to continue", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    route([
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/pages\/p1\/markdown$/, () => ({ markdown: long, truncated: false, unknown_block_ids: [] })],
    ]);
    const first = (await read({ id: "p1", max_chars: 500 })).content[0].text;
    expect(first).toContain("Call again with offset=500");
    const second = (await read({ id: "p1", max_chars: 500, offset: 500 })).content[0].text;
    expect(second).toContain("showing characters 500-1000");
  });

  it("lists unknown block ids when Notion truncates a huge page", async () => {
    route([
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/pages\/p1\/markdown$/, () => ({ markdown: "# a", truncated: true, unknown_block_ids: ["blk-1", "blk-2"] })],
    ]);
    const text = (await read({ id: "p1" })).content[0].text;
    expect(text).toContain("truncated");
    expect(text).toContain("blk-1, blk-2");
  });

  it("reads a block subtree when the id is not a page", async () => {
    route([
      [/^GET \/pages\/blk-1$/, () => { throw new Error("Notion API error (404): not a page"); }],
      [/^GET \/pages\/blk-1\/markdown$/, () => ({ markdown: "subtree text", truncated: false, unknown_block_ids: [] })],
    ]);
    const text = (await read({ id: "blk-1" })).content[0].text;
    expect(text).toContain("# Block subtree");
    expect(text).toContain("subtree text");
  });

  it("falls back to the block view, with a note, when the markdown API is refused", async () => {
    route([
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/pages\/p1\/markdown$/, () => { throw new Error("Notion API error (403): restricted_resource"); }],
      [/^GET \/blocks\/p1\/children/, () => ({ results: [{ id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "legacy text" }] } }], has_more: false })],
    ]);
    const text = (await read({ id: "p1" })).content[0].text;
    expect(text).toContain("legacy text");
    expect(text).toContain("markdown read unavailable");
  });

  it("format: 'blocks' skips the markdown endpoint entirely", async () => {
    route([
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/blocks\/p1\/children/, () => ({ results: [], has_more: false })],
    ]);
    await read({ id: "p1", format: "blocks" });
    expect(client.notionRequest.mock.calls.some(([p]) => p.endsWith("/markdown"))).toBe(false);
  });
});

describe("notion_update (markdown edits)", () => {
  it("content_updates -> update_content command with the 2026 header, no block reads needed", async () => {
    route([
      [/^PATCH \/pages\/p1\/markdown$/, () => ({ object: "page_markdown", markdown: "x", truncated: false })],
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/pages\/p1\/markdown$/, () => ({ markdown: "x", truncated: false, unknown_block_ids: [] })],
      [/^PATCH \/blocks\/p1\/children$/, () => ({})],
    ]);
    const res = await doUpdatePage({
      page_id: "p1",
      content_updates: [{ old_str: "a", new_str: "b" }, { old_str: "c", new_str: "d", replace_all_matches: true }],
    });
    expect(res[0]).toBe("Applied 2 search-and-replace edit(s).");
    const call = client.notionRequest.mock.calls.find(([p, o]) => o?.method === "PATCH" && p.endsWith("/markdown"));
    expect(call[1].version).toBe("2026-03-11");
    expect(call[1].body).toEqual({
      type: "update_content",
      update_content: { content_updates: [{ old_str: "a", new_str: "b" }, { old_str: "c", new_str: "d", replace_all_matches: true }] },
    });
  });

  it("replace_content keeps entity_id/status/relation marker lines", async () => {
    route([
      [/^GET \/pages\/p1\/markdown$/, () => ({ markdown: "\u{1F511} entity_id: keep-me\n\u{1F3F7}\uFE0F status: open\nold body", truncated: false, unknown_block_ids: [] })],
      [/^PATCH \/pages\/p1\/markdown$/, () => ({ markdown: "", truncated: false })],
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^PATCH \/blocks\/p1\/children$/, () => ({})],
    ]);
    await doUpdatePage({ page_id: "p1", replace_content: "# Fresh", allow_deleting_content: true });
    const call = client.notionRequest.mock.calls.find(([p, o]) => o?.method === "PATCH" && p.endsWith("/markdown"));
    expect(call[1].body.type).toBe("replace_content");
    expect(call[1].body.replace_content.new_str).toBe("\u{1F511} entity_id: keep-me\n\u{1F3F7}\uFE0F status: open\n# Fresh");
    expect(call[1].body.replace_content.allow_deleting_content).toBe(true);
  });

  it("append_markdown uses insert_content at the end", async () => {
    route([
      [/^PATCH \/pages\/p1\/markdown$/, () => ({ markdown: "", truncated: false })],
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/pages\/p1\/markdown$/, () => ({ markdown: "", truncated: false, unknown_block_ids: [] })],
      [/^PATCH \/blocks\/p1\/children$/, () => ({})],
    ]);
    await doUpdatePage({ page_id: "p1", append_markdown: "## New\n- [ ] todo" });
    const call = client.notionRequest.mock.calls.find(([p, o]) => o?.method === "PATCH" && p.endsWith("/markdown"));
    expect(call[1].body).toEqual({ type: "insert_content", insert_content: { content: "## New\n- [ ] todo", position: { type: "end" } } });
  });

  it("polls an async_task response until it succeeds", async () => {
    let polls = 0;
    route([
      [/^PATCH \/pages\/p1\/markdown$/, () => ({ object: "async_task", id: "t1", status: "queued", poll_after_seconds: 0 })],
      [/^GET \/async_tasks\/t1$/, () => (++polls < 2
        ? { object: "async_task", id: "t1", status: "running", poll_after_seconds: 0 }
        : { object: "async_task", id: "t1", status: "succeeded", result: { markdown: "done", truncated: false } })],
      [/^GET \/pages\/p1$/, () => PAGE],
      [/^GET \/pages\/p1\/markdown$/, () => ({ markdown: "", truncated: false, unknown_block_ids: [] })],
      [/^PATCH \/blocks\/p1\/children$/, () => ({})],
    ]);
    const res = await doUpdatePage({ page_id: "p1", append_markdown: "x" });
    expect(res[0]).toContain("Appended markdown content");
    expect(polls).toBe(2);
  });

  it("reports edits already applied when a later step fails", async () => {
    route([
      [/^GET \/blocks\/p1\/children/, () => ({ results: [
        { id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "one" }] } },
      ], has_more: false })],
      [/^PATCH \/blocks\/b1$/, () => ({})],
    ]);
    await expect(doUpdatePage({
      page_id: "p1",
      replacements: [{ find: "one", replace: "uno" }, { find: "missing", replace: "x" }],
    })).rejects.toThrow(/use content_updates[\s\S]*Already applied before the failure: Replaced block \("one"/);
  });
});

describe("client: per-request version + retry safety", () => {
  it("never retries a lost PATCH .../markdown response on 5xx", () => {
    expect(client.isSafeToRetryOnServerError("PATCH", "/pages/p1/markdown")).toBe(false);
    expect(client.isSafeToRetryOnServerError("PATCH", "/pages/p1")).toBe(true);
    expect(client.isSafeToRetryOnServerError("GET", "/pages/p1/markdown")).toBe(true);
  });
});
