// ---------------------------------------------------------------------------
// test/notion-checkpoint-block.test.js
// ---------------------------------------------------------------------------
// Covers replace_block / delete_block of doCheckpoint and block_edits of
// doUpdatePage (connectors/notion/tools.js). Same mocking strategy as
// test/notion-checkpoint-edit.test.js: only notionRequest is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint, doUpdatePage } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { finalNoteTexts } from "./_notion-notes-sim.js";
import { buildCheckpointStartText, buildCheckpointEndText, buildMarkerBlocks, buildChangelogEntryText } from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return { ...actual, notionRequest: mockedNotionRequest };
});

const INDEX_QUERY_RE = /^\/databases\/.*\/query$/;
const para = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });
const blockText = (block) => block.paragraph.rich_text.map((t) => t.text.content).join("");
const indexRow = (pageId) => ({
  id: `row-${pageId}`,
  properties: { PageId: { rich_text: [{ plain_text: pageId }] }, EntityId: { rich_text: [{ plain_text: "" }] } },
});
const pageGet = (id) => ({ id, url: `https://notion.so/${id}`, properties: { title: { type: "title", title: [{ plain_text: "T" }] } } });

function notesPage(prefix, ...lines) {
  return [
    para(`start-${prefix}`, buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
    ...lines.map((line, i) => para(`note-${prefix}-${i}`, line)),
    para(`end-${prefix}`, buildCheckpointEndText()),
  ];
}

let lastPages = {};
function mockNotion({ pages, indexResults = [] }) {
  lastPages = pages;
  const queue = [...indexResults];
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";
    if (INDEX_QUERY_RE.test(path)) {
      const next = queue.shift();
      return { results: next ? [indexRow(next)] : [] };
    }
    const pageMatch = path.match(/^\/pages\/([\w-]+)$/);
    if (pageMatch && method === "GET" && pages[pageMatch[1]]) return pageGet(pageMatch[1]);
    if (pageMatch && method === "PATCH") return {};
    const blocksMatch = path.match(/^\/blocks\/([\w-]+)\/children/);
    if (blocksMatch && pages[blocksMatch[1]]) {
      if (method === "PATCH") return {};
      if (path.includes("page_size=20")) return { results: [] };
      if (path.includes("page_size=100")) return { results: pages[blocksMatch[1]] };
    }
    if (/^\/blocks\/[\w-]+$/.test(path) && (method === "DELETE" || method === "PATCH")) return {};
    throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
  });
}

const callsWhere = (pred) => client.notionRequest.mock.calls.filter(([path, opts]) => pred(path, opts || {}));
const deletedIds = () => callsWhere((p, o) => o.method === "DELETE").map(([p]) => p.replace("/blocks/", ""));
const insertCalls = () => callsWhere((p, o) => /\/children$/.test(p) && o.method === "PATCH" && o.body?.after);
// Note lines on the active page after replaying every write call.
const finalNotes = () => finalNoteTexts(client.notionRequest.mock.calls, "page-active", lastPages["page-active"]);
const writeCalls = () => callsWhere((p, o) => o.method === "DELETE" || o.method === "PATCH");

describe("checkpoint replace_block / delete_block", () => {
  beforeEach(() => vi.clearAllMocks());

  const NOTES = ["REPO: demo", "- Item A", "- Item B", "NEXT", "1. one", "NOTES: tail"];
  const setup = () => mockNotion({ pages: { "page-active": notesPage("active", ...NOTES) }, indexResults: ["page-active", "page-active"] });

  it("deletes a range by prefix anchors without quoting the text", async () => {
    setup();
    const result = await doCheckpoint({ action: "delete_block", start: "NEXT", end: "1. one" });
    expect(result).toMatch(/Deleted lines 4-5/);
    expect(finalNotes()).toEqual(["REPO: demo", "- Item A", "- Item B", "NOTES: tail"]);
    // Unchanged head/tail were left alone: only the 2 removed lines were deleted.
    expect(deletedIds()).toEqual(["note-active-3", "note-active-4"]);
  });

  it("overwrites a range by line number with new notes", async () => {
    setup();
    const result = await doCheckpoint({ action: "replace_block", start: 2, end: 3, notes: "- Item X" });
    expect(result).toMatch(/Replaced lines 2-3 .*1 added/);
    expect(finalNotes()).toEqual(["REPO: demo", "- Item X", "NEXT", "1. one", "NOTES: tail"]);
  });

  it("replaces a single line when end is omitted", async () => {
    setup();
    const result = await doCheckpoint({ action: "replace_block", start: "REPO", notes: "REPO: other" });
    expect(result).toMatch(/Replaced line 1 /);
    expect(finalNotes()[0]).toBe("REPO: other");
  });

  it("aborts without writing on an ambiguous prefix", async () => {
    setup();
    await expect(doCheckpoint({ action: "delete_block", start: "- Item" })).rejects.toThrow(/nothing written.*starts 2 lines \(2, 3\)/);
    expect(writeCalls()).toHaveLength(0);
  });

  it("aborts without writing on a missing prefix or out-of-range number", async () => {
    setup();
    await expect(doCheckpoint({ action: "delete_block", start: "ZZZ" })).rejects.toThrow(/does not start any line/);
    await expect(doCheckpoint({ action: "delete_block", start: 99 })).rejects.toThrow(/out of range/);
    expect(writeCalls()).toHaveLength(0);
  });

  it("requires start, and notes for replace_block", async () => {
    await expect(doCheckpoint({ action: "delete_block" })).rejects.toThrow(/requires 'start'/);
    await expect(doCheckpoint({ action: "replace_block", start: 1 })).rejects.toThrow(/requires 'notes'/);
  });

  it("refuses when the range holds non-paragraph blocks", async () => {
    const blocks = notesPage("active", "a", "b");
    blocks[1] = { id: "h", type: "heading_1", heading_1: { rich_text: [{ plain_text: "a" }] } };
    mockNotion({ pages: { "page-active": blocks }, indexResults: ["page-active"] });
    await expect(doCheckpoint({ action: "delete_block", start: 1 })).rejects.toThrow(/other than plain paragraphs/);
    expect(writeCalls()).toHaveLength(0);
  });

  it("reports a missing checkpoint", async () => {
    mockNotion({ pages: {}, indexResults: [] });
    expect(await doCheckpoint({ action: "delete_block", start: 1, key: "nope" })).toMatch(/No checkpoint found/);
  });
});

describe("notion_update block_edits", () => {
  beforeEach(() => vi.clearAllMocks());

  const pageBlocks = () => [
    // buildMarkerBlocks writes text.content only; real Notion reads also carry plain_text.
    ...buildMarkerBlocks({ entity_id: "e1", status: "open" }).map((b, i) => ({
      ...b,
      id: `m${i}`,
      paragraph: { rich_text: b.paragraph.rich_text.map((t) => ({ ...t, plain_text: t.text.content })) },
    })),
    para("b1", "Intro"),
    para("b2", "Old plan A"),
    para("b3", "Old plan B"),
    para("b4", "Outro"),
  ];

  it("overwrites a block range by prefix: inserts after the last block, then deletes the old ones", async () => {
    mockNotion({ pages: { pg: pageBlocks() } });
    const results = await doUpdatePage({ page_id: "pg", block_edits: [{ start: "Old plan A", end: "Old plan B", content: "New plan" }] });
    expect(results[0]).toMatch(/Replaced blocks 4-5 \(2 removed, 1 added\)/);
    const ins = insertCalls().find(([p]) => p === "/blocks/pg/children");
    expect(ins[1].body.after).toBe("b3");
    expect(ins[1].body.children.map(blockText)).toEqual(["New plan"]);
    expect(deletedIds().sort()).toEqual(["b2", "b3"]);
  });

  it("deletes a block when content is omitted", async () => {
    mockNotion({ pages: { pg: pageBlocks() } });
    const results = await doUpdatePage({ page_id: "pg", block_edits: [{ start: "Outro" }] });
    expect(results[0]).toMatch(/Deleted block 6 /);
    expect(deletedIds()).toEqual(["b4"]);
    expect(insertCalls().filter(([p]) => p === "/blocks/pg/children")).toHaveLength(0);
  });

  it("refuses to touch entity_id/status markers and writes nothing", async () => {
    mockNotion({ pages: { pg: pageBlocks() } });
    await expect(doUpdatePage({ page_id: "pg", block_edits: [{ start: 1, end: 3 }] })).rejects.toThrow(/marker, relation or changelog/);
    expect(deletedIds()).toHaveLength(0);
  });

  it("refuses changelog entries", async () => {
    const blocks = [...pageBlocks(), para("cl", buildChangelogEntryText("did a thing"))];
    mockNotion({ pages: { pg: blocks } });
    await expect(doUpdatePage({ page_id: "pg", block_edits: [{ start: "Outro", end: 7 }] })).rejects.toThrow(/marker, relation or changelog/);
    expect(deletedIds()).toHaveLength(0);
  });

  it("refuses subpages", async () => {
    const blocks = [...pageBlocks(), { id: "sub", type: "child_page", child_page: { title: "Child" } }];
    mockNotion({ pages: { pg: blocks } });
    await expect(doUpdatePage({ page_id: "pg", block_edits: [{ start: "Child" }] })).rejects.toThrow(/child_page/);
    expect(deletedIds()).toHaveLength(0);
  });

  it("refuses pages that hold a checkpoint", async () => {
    mockNotion({ pages: { pg: notesPage("c", "x") } });
    await expect(doUpdatePage({ page_id: "pg", block_edits: [{ start: "x" }] })).rejects.toThrow(/checkpoint tool/);
    expect(deletedIds()).toHaveLength(0);
  });

  it("aborts on an ambiguous prefix and names the edit number", async () => {
    mockNotion({ pages: { pg: pageBlocks() } });
    await expect(doUpdatePage({ page_id: "pg", block_edits: [{ start: "Old plan" }] })).rejects.toThrow(/Block edit #1 aborted.*starts 2 lines/);
    expect(deletedIds()).toHaveLength(0);
  });
});
