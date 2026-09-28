// ---------------------------------------------------------------------------
// test/notion-client-audit.test.js -- coverage for the 2026-09-28 audit fixes
// in connectors/notion/client.js (PR #245):
//   A2  findPageByEntityId reports `archived`
//   A3  findPageByEntityId only treats a 404 as "page gone"; other errors throw
//   A4  chunkRichText is lossless (keeps the split space, no surrogate split)
//   A6  queryAllIndexEntries sorts newest-first and paginates
//
// Mocking strategy: client.js functions call clientInternals.notionRequest at
// call time, so replacing that one property is enough -- the real
// findPageByEntityId / queryAllIndexEntries logic runs against canned
// responses.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  chunkRichText,
  findPageByEntityId,
  queryAllIndexEntries,
  buildMarkerBlocks,
  clientInternals,
} from "../connectors/notion/client.js";

const QUERY_RE = /^\/databases\/.+\/query$/;

beforeEach(() => {
  clientInternals.notionRequest = vi.fn();
});

const indexRow = (pageId) => ({ properties: { PageId: { rich_text: pageId ? [{ plain_text: pageId }] : [] } } });

// Marker blocks as Notion returns them (plain_text), built from the real
// marker builders so the test tracks the real marker format.
function markerBlocksAsRead({ entity_id, status }) {
  return buildMarkerBlocks({ entity_id, status }).map((b, i) => ({
    id: `mb-${i}`,
    type: "paragraph",
    paragraph: { rich_text: [{ plain_text: b.paragraph.rich_text[0].text.content }] },
  }));
}

// Routes the three request shapes findPageByEntityId issues. Each of rows /
// page / blocks may be an Error, which is thrown instead of returned.
function route({
  rows = [indexRow("page-1")],
  page = { id: "page-1", url: "https://notion.so/page-1", properties: {} },
  blocks = { results: [] },
} = {}) {
  const respond = (v) => { if (v instanceof Error) throw v; return v; };
  return async (path) => {
    if (QUERY_RE.test(path)) return respond(rows instanceof Error ? rows : { results: rows });
    if (path === "/pages/page-1") return respond(page);
    if (path.startsWith("/blocks/page-1/children")) return respond(blocks);
    throw new Error(`Unexpected notionRequest call: ${path}`);
  };
}

describe("findPageByEntityId: lookup + A2 archived flag", () => {
  it("returns null when the index has no row", async () => {
    clientInternals.notionRequest.mockImplementation(route({ rows: [] }));
    expect(await findPageByEntityId("e1")).toBeNull();
  });

  it("returns null when the index row has an empty PageId", async () => {
    clientInternals.notionRequest.mockImplementation(route({ rows: [indexRow("")] }));
    expect(await findPageByEntityId("e1")).toBeNull();
  });

  it("returns pageId, url, parsed markers and archived:false for a live page", async () => {
    clientInternals.notionRequest.mockImplementation(route({
      blocks: { results: markerBlocksAsRead({ entity_id: "e1", status: "open" }) },
    }));

    const found = await findPageByEntityId("e1");

    expect(found.pageId).toBe("page-1");
    expect(found.url).toBe("https://notion.so/page-1");
    expect(found.markers.entity_id).toBe("e1");
    expect(found.markers.status).toBe("open");
    expect(found.archived).toBe(false);
  });

  it("A2: reports archived:true when the page is archived", async () => {
    clientInternals.notionRequest.mockImplementation(route({
      page: { id: "page-1", url: "u", archived: true, properties: {} },
    }));
    expect((await findPageByEntityId("e1")).archived).toBe(true);
  });

  it("A2: reports archived:true when the page is in the trash", async () => {
    clientInternals.notionRequest.mockImplementation(route({
      page: { id: "page-1", url: "u", in_trash: true, properties: {} },
    }));
    expect((await findPageByEntityId("e1")).archived).toBe(true);
  });

  it("A2: an archived page whose block read fails still resolves, with empty markers", async () => {
    clientInternals.notionRequest.mockImplementation(route({
      page: { id: "page-1", url: "u", archived: true, properties: {} },
      blocks: new Error("Notion API error (400): Can't edit block that is archived"),
    }));

    const found = await findPageByEntityId("e1");

    expect(found.archived).toBe(true);
    expect(found.markers.entity_id).toBeNull();
    expect(found.markers.status).toBeNull();
  });
});

describe("findPageByEntityId: A3 only a 404 means the page is gone", () => {
  it("returns null when the page fetch is a 404 (stale index row)", async () => {
    clientInternals.notionRequest.mockImplementation(route({ page: new Error("Notion API error (404): Could not find page") }));
    expect(await findPageByEntityId("e1")).toBeNull();
  });

  it("rethrows a 429 (retries exhausted) with the original error as cause, instead of returning null", async () => {
    clientInternals.notionRequest.mockImplementation(route({
      page: new Error("Notion API error (429): rate limited -- exhausted 3 retries"),
    }));

    const err = await findPageByEntityId("e1").then(() => null, (e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Could not read Notion page page-1");
    expect(err.message).toContain('entity_id "e1"');
    expect(err.cause.message).toContain("(429)");
  });

  it("rethrows a 5xx from the page fetch", async () => {
    clientInternals.notionRequest.mockImplementation(route({ page: new Error("Notion API error (500): boom") }));
    await expect(findPageByEntityId("e1")).rejects.toThrow(/Could not read Notion page/);
  });

  it("rethrows a network-level failure from the page fetch", async () => {
    clientInternals.notionRequest.mockImplementation(route({ page: new Error("fetch failed") }));
    await expect(findPageByEntityId("e1")).rejects.toThrow(/Could not read Notion page/);
  });

  it("returns null when the block read is a 404", async () => {
    clientInternals.notionRequest.mockImplementation(route({ blocks: new Error("Notion API error (404): gone") }));
    expect(await findPageByEntityId("e1")).toBeNull();
  });

  it("rethrows a 503 from the block read of a live page, with cause", async () => {
    clientInternals.notionRequest.mockImplementation(route({ blocks: new Error("Notion API error (503): unavailable") }));

    const err = await findPageByEntityId("e1").then(() => null, (e) => e);

    expect(err.message).toContain("Could not read blocks of Notion page page-1");
    expect(err.cause.message).toContain("(503)");
  });

  it("still fails loudly (with cause) when the index database itself is unreachable", async () => {
    clientInternals.notionRequest.mockImplementation(route({ rows: new Error("Notion API error (401): invalid token") }));

    const err = await findPageByEntityId("e1").then(() => null, (e) => e);

    expect(err.message).toContain("unreachable");
    expect(err.cause.message).toContain("(401)");
  });
});

describe("A4: chunkRichText", () => {
  const joined = (chunks) => chunks.map((c) => c.text.content).join("");
  const parts = (chunks) => chunks.map((c) => c.text.content);

  it("returns a single segment for short text", () => {
    expect(parts(chunkRichText("hello world"))).toEqual(["hello world"]);
  });

  it("keeps exactly-2000-char text in one segment and splits 2001", () => {
    expect(chunkRichText("x".repeat(2000))).toHaveLength(1);
    expect(chunkRichText("x".repeat(2001))).toHaveLength(2);
  });

  it("produces text/text segments in Notion's shape", () => {
    const [seg] = chunkRichText("hi");
    expect(seg).toEqual({ type: "text", text: { content: "hi" } });
  });

  it("is lossless for long prose: joining the segments reproduces the input, every segment <= 2000", () => {
    const words = Array.from({ length: 2500 }, (_, i) => `word${i}`);
    const text = words.join(" "); // ~17k chars
    const chunks = chunkRichText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.content.length <= 2000)).toBe(true);
    expect(joined(chunks)).toBe(text);
  });

  it("A4: keeps the space at the split point, so words are never glued together", () => {
    const text = "a ".repeat(1500).trimEnd(); // spaces at every odd index
    const chunks = parts(chunkRichText(text));

    expect(chunks.length).toBeGreaterThan(1);
    // every non-final segment ends with the split space
    for (const c of chunks.slice(0, -1)) expect(c.endsWith(" ")).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("does not break inside a word when a space is available", () => {
    const text = `${"a".repeat(1990)} ${"b".repeat(50)}`; // space at index 1990, word crosses 2000
    const chunks = parts(chunkRichText(text));

    expect(chunks[0]).toBe(`${"a".repeat(1990)} `);
    expect(chunks[1]).toBe("b".repeat(50));
  });

  it("hard-cuts an unbroken token at 2000 and stays lossless", () => {
    const text = "x".repeat(4500);
    const chunks = parts(chunkRichText(text));

    expect(chunks.map((c) => c.length)).toEqual([2000, 2000, 500]);
    expect(chunks.join("")).toBe(text);
  });

  it("A4: never splits a surrogate pair on a hard cut", () => {
    // index 1999 is the high surrogate of the emoji; a naive 2000-char cut
    // would strand it at the end of the first segment
    const text = `${"x".repeat(1999)}\u{1F600}${"y".repeat(100)}`;
    const chunks = parts(chunkRichText(text));

    expect(chunks.length).toBe(2);
    expect(/[\ud800-\udbff]$/.test(chunks[0])).toBe(false);
    expect(chunks[1].startsWith("\u{1F600}")).toBe(true);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("A6: queryAllIndexEntries", () => {
  const entryRow = (entity, page, tags = "", url = "") => ({
    properties: {
      EntityId: { rich_text: [{ plain_text: entity }] },
      PageId: { rich_text: page ? [{ plain_text: page }] : [] },
      Url: { url },
      Tags: { rich_text: tags ? [{ plain_text: tags }] : [] },
    },
  });
  const SORTS = [{ timestamp: "created_time", direction: "descending" }];

  it("sorts newest first on every page and follows the cursor", async () => {
    clientInternals.notionRequest
      .mockResolvedValueOnce({ results: [entryRow("e1", "p1")], has_more: true, next_cursor: "cur-1" })
      .mockResolvedValueOnce({ results: [entryRow("e2", "p2")], has_more: false });

    const entries = await queryAllIndexEntries();

    expect(entries.map((e) => e.entity_id)).toEqual(["e1", "e2"]);
    const calls = clientInternals.notionRequest.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].body.sorts).toEqual(SORTS);
    expect(calls[0][1].body.start_cursor).toBeUndefined();
    expect(calls[1][1].body.sorts).toEqual(SORTS);
    expect(calls[1][1].body.start_cursor).toBe("cur-1");
  });

  it("parses tags (trimmed, lowercased, blanks dropped) and url, and skips rows without a PageId", async () => {
    clientInternals.notionRequest.mockResolvedValueOnce({
      results: [
        entryRow("e1", "p1", "Alpha, beta ,, GAMMA", "https://notion.so/p1"),
        entryRow("e2", ""),
      ],
      has_more: false,
    });

    const entries = await queryAllIndexEntries();

    expect(entries).toEqual([
      { entity_id: "e1", page_id: "p1", url: "https://notion.so/p1", tags: ["alpha", "beta", "gamma"] },
    ]);
  });

  it("stops after 10 pages even if Notion keeps saying has_more", async () => {
    clientInternals.notionRequest.mockResolvedValue({ results: [], has_more: true, next_cursor: "more" });

    await queryAllIndexEntries();

    expect(clientInternals.notionRequest).toHaveBeenCalledTimes(10);
  });
});
