// ---------------------------------------------------------------------------
// test/notion-checkpoint-append.test.js
// ---------------------------------------------------------------------------
// Covers the append action of doCheckpoint (connectors/notion/tools.js).
// Same mocking strategy as test/notion-checkpoint-edit.test.js: only
// notionRequest (the I/O boundary) is mocked; doCheckpoint,
// findPageByEntityId and replaceCheckpointRange run for real against canned
// Notion responses. See test/notion-checkpoint.test.js for why clientInternals
// is mutated in place.
//
// append reads the saved notes, adds the new text on the end, and writes the
// result back through the normal save path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { buildCheckpointStartText, buildCheckpointEndText } from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return {
    ...actual,
    notionRequest: mockedNotionRequest,
  };
});

const INDEX_QUERY_RE = /^\/databases\/.*\/query$/;

const para = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });

// A page's block list: start marker, one paragraph per note line, end marker.
function notesPage(prefix, ...lines) {
  return [
    para(`start-${prefix}`, buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
    ...lines.map((line, i) => para(`note-${prefix}-${i}`, line)),
    para(`end-${prefix}`, buildCheckpointEndText()),
  ];
}

const indexRow = (pageId) => ({
  id: `row-${pageId}`,
  properties: {
    PageId: { rich_text: [{ plain_text: pageId }] },
    EntityId: { rich_text: [{ plain_text: "" }] },
  },
});

function pageGet(id) {
  return {
    id,
    url: `https://notion.so/${id}`,
    properties: { title: { type: "title", title: [{ plain_text: "Session Checkpoint" }] } },
  };
}

function blockText(block) {
  return block.paragraph.rich_text.map((t) => t.text.content).join("");
}

// Routes blocks/pages by page id. `pages` = { "page-x": [blocks] }.
// `indexResults` is consumed one entry per index query, in call order (a page
// id string = one row pointing at that page); once exhausted, further queries
// return no results.
function mockNotion({ pages, indexResults }) {
  const queue = [...indexResults];
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";

    if (INDEX_QUERY_RE.test(path)) {
      const next = queue.shift();
      return { results: next ? [indexRow(next)] : [] };
    }
    if (path === "/pages" && method === "POST") {
      if (opts.body?.parent?.database_id) return { id: "index-row-new" };
      return { id: "page-new", url: "https://notion.so/page-new" };
    }
    const pageMatch = path.match(/^\/pages\/([\w-]+)$/);
    if (pageMatch && method === "GET" && pages[pageMatch[1]]) return pageGet(pageMatch[1]);
    if (pageMatch && method === "PATCH") return {};

    const blocksMatch = path.match(/^\/blocks\/([\w-]+)\/children/);
    if (blocksMatch && pages[blocksMatch[1]]) {
      if (method === "PATCH") return {};
      if (path.includes("page_size=20")) return { results: [] }; // marker scan
      if (path.includes("page_size=100")) return { results: pages[blocksMatch[1]] };
    }
    if (/^\/blocks\/[\w-]+$/.test(path) && (method === "DELETE" || method === "PATCH")) return {};

    throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
  });
}

// Every call that would change something on the page.
const writeCalls = () =>
  client.notionRequest.mock.calls.filter(([, opts]) => opts?.method === "DELETE" || opts?.method === "PATCH");
const pageCreateCalls = () =>
  client.notionRequest.mock.calls.filter(
    ([path, opts]) => path === "/pages" && opts?.method === "POST" && !opts?.body?.parent?.database_id
  );

// The note blocks inserted right after the start marker, as plain strings.
function insertedTexts(pageId = "page-active", prefix = "active") {
  const call = client.notionRequest.mock.calls.find(
    ([path, opts]) => path === `/blocks/${pageId}/children` && opts?.method === "PATCH" && opts?.body?.after === `start-${prefix}`
  );
  expect(call).toBeTruthy();
  return call[1].body.children.map(blockText);
}

describe("Notion checkpoint append", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a line to the end of the saved notes", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "line one") },
      // 1 = append's read, 2 = the save's lookup.
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({ action: "append", notes: "line two" });

    expect(result).toContain('Appended 1 line to "checkpoint-latest"');
    expect(result).toContain("Checkpoint saved successfully");
    expect(result).toContain("https://notion.so/page-active");
    // Old notes stay first, new line goes last.
    expect(insertedTexts()).toEqual(["line one", "line two"]);
    expect(pageCreateCalls().length).toBe(0);
  });

  it("adds several lines at once, keeping their order", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "first", "second") },
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({ action: "append", notes: "third\nfourth" });

    expect(result).toContain("Appended 2 lines");
    expect(insertedTexts()).toEqual(["first", "second", "third", "fourth"]);
  });

  it("does not count blank lines in the appended text", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "first") },
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({ action: "append", notes: "second\n\nthird" });

    expect(result).toContain("Appended 2 lines");
    // Blank lines are dropped by save, same as for any other write.
    expect(insertedTexts()).toEqual(["first", "second", "third"]);
  });

  it("starts the notes with the new text when the checkpoint is blank", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active") },
      indexResults: ["page-active", "page-active"],
    });

    await doCheckpoint({ action: "append", notes: "new line" });

    expect(insertedTexts()).toEqual(["new line"]);
  });

  it("appends to a non-default key and leaves other pages alone", async () => {
    mockNotion({
      pages: { "page-src": notesPage("src", "News notes") },
      indexResults: ["page-src", "page-src"],
    });

    const result = await doCheckpoint({ action: "append", key: "checkpoint-news", notes: "More news" });

    expect(result).toContain('Appended 1 line to "checkpoint-news"');
    expect(insertedTexts("page-src", "src")).toEqual(["News notes", "More news"]);
    expect(pageCreateCalls().length).toBe(0);
  });

  it("requires non-empty 'notes' and touches nothing without it", async () => {
    await expect(doCheckpoint({ action: "append" })).rejects.toThrow(/requires 'notes'/);
    await expect(doCheckpoint({ action: "append", notes: "" })).rejects.toThrow(/requires 'notes'/);
    await expect(doCheckpoint({ action: "append", notes: "  \n " })).rejects.toThrow(/requires 'notes'/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("reports a clear message and creates nothing when the key has no checkpoint", async () => {
    mockNotion({ pages: {}, indexResults: [] });

    const result = await doCheckpoint({ action: "append", notes: "orphan line" });

    expect(result).toContain("No checkpoint found");
    expect(result).toContain("nothing appended");
    expect(writeCalls().length).toBe(0);
    expect(pageCreateCalls().length).toBe(0);
  });

  it("refuses to round-trip notes that contain non-paragraph blocks", async () => {
    const blocks = notesPage("active", "plain line");
    // A hand-added heading inside the checkpoint range, before the end marker.
    blocks.splice(2, 0, {
      id: "note-active-heading",
      type: "heading_2",
      heading_2: { rich_text: [{ plain_text: "A heading" }] },
    });
    mockNotion({ pages: { "page-active": blocks }, indexResults: ["page-active", "page-active"] });

    await expect(doCheckpoint({ action: "append", notes: "extra" })).rejects.toThrow(/other than plain paragraphs/);
    expect(writeCalls().length).toBe(0);
  });
});
