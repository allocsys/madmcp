// ---------------------------------------------------------------------------
// test/notion-checkpoint-edit.test.js
// ---------------------------------------------------------------------------
// Covers the edit action of doCheckpoint (connectors/notion/tools.js).
// Same mocking strategy as test/notion-checkpoint-park.test.js: only
// notionRequest (the I/O boundary) is mocked; doCheckpoint,
// findPageByEntityId and replaceCheckpointRange run for real against canned
// Notion responses. See test/notion-checkpoint.test.js for why clientInternals
// is mutated in place.
//
// edit applies literal find/replace edits to the saved notes in memory
// (all-or-nothing) and then writes the result back through the normal save
// path. An empty/omitted `replace` deletes the matched text.

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
const deleteCalls = () => client.notionRequest.mock.calls.filter(([, opts]) => opts?.method === "DELETE");
const pageCreateCalls = () =>
  client.notionRequest.mock.calls.filter(
    ([path, opts]) => path === "/pages" && opts?.method === "POST" && !opts?.body?.parent?.database_id
  );

// The new note blocks inserted right after the start marker, as plain strings.
function insertedTexts(pageId = "page-active", prefix = "active") {
  const call = client.notionRequest.mock.calls.find(
    ([path, opts]) => path === `/blocks/${pageId}/children` && opts?.method === "PATCH" && opts?.body?.after === `start-${prefix}`
  );
  expect(call).toBeTruthy();
  return call[1].body.children.map(blockText);
}

describe("Notion checkpoint edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces text inside the saved notes and writes the result back", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "Next step: write tests") },
      // 1 = edit's read, 2 = the save's lookup.
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({
      action: "edit",
      edits: [{ find: "write tests", replace: "open the PR" }],
    });

    expect(result).toContain('Edited "checkpoint-latest": 1 replacement, 0 deletions');
    expect(result).toContain("Checkpoint saved successfully");
    expect(result).toContain("https://notion.so/page-active");

    const inserted = insertedTexts().join("\n");
    expect(inserted).toContain("Next step: open the PR");
    expect(inserted).not.toContain("write tests");
    // The old note block was replaced in place; no new page was created.
    expect(deleteCalls().map(([path]) => path)).toEqual(["/blocks/note-active-0"]);
    expect(pageCreateCalls().length).toBe(0);
  });

  it("deletes a line when 'replace' is empty or omitted", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "line one", "line two", "line three") },
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({ action: "edit", edits: [{ find: "line two" }] });

    expect(result).toContain("0 replacements, 1 deletion.");
    const inserted = insertedTexts();
    expect(inserted).toContain("line one");
    expect(inserted).toContain("line three");
    expect(inserted.join("\n")).not.toContain("line two");
    // The emptied line is dropped, not saved as a blank paragraph.
    expect(inserted.every((t) => t.length > 0)).toBe(true);
  });

  it("applies several edits in order, later edits seeing earlier results", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "status: draft", "owner: nobody") },
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({
      action: "edit",
      edits: [
        { find: "status: draft", replace: "status: review" },
        { find: "status: review", replace: "status: done" },
        { find: "owner: nobody", replace: "" },
      ],
    });

    expect(result).toContain("2 replacements, 1 deletion.");
    const inserted = insertedTexts().join("\n");
    expect(inserted).toContain("status: done");
    expect(inserted).not.toContain("draft");
    expect(inserted).not.toContain("owner");
  });

  it("replace_all changes every match", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "foo bar foo") },
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({
      action: "edit",
      edits: [{ find: "foo", replace: "baz", replace_all: true }],
    });

    expect(result).toContain("2 replacements");
    expect(insertedTexts().join("\n")).toContain("baz bar baz");
  });

  it("keeps '$' patterns in the replacement literal", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "price: TBD") },
      indexResults: ["page-active", "page-active"],
    });

    await doCheckpoint({ action: "edit", edits: [{ find: "TBD", replace: "$& and $1" }] });

    expect(insertedTexts().join("\n")).toContain("price: $& and $1");
  });

  it("aborts without writing when 'find' matches more than once", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "todo: a", "todo: b") },
      indexResults: ["page-active", "page-active"],
    });

    await expect(
      doCheckpoint({ action: "edit", edits: [{ find: "todo", replace: "done" }] })
    ).rejects.toThrow(/matches 2 places/);
    expect(writeCalls().length).toBe(0);
  });

  it("aborts without writing when 'find' is not in the notes", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "some notes") },
      indexResults: ["page-active", "page-active"],
    });

    await expect(
      doCheckpoint({ action: "edit", edits: [{ find: "missing", replace: "x" }] })
    ).rejects.toThrow(/was not found/);
    expect(writeCalls().length).toBe(0);
  });

  it("is all-or-nothing: a failing later edit means the earlier ones are not written either", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "alpha beta") },
      indexResults: ["page-active", "page-active"],
    });

    await expect(
      doCheckpoint({
        action: "edit",
        edits: [
          { find: "alpha", replace: "A" },
          { find: "missing", replace: "B" },
        ],
      })
    ).rejects.toThrow(/edit #2/);
    expect(writeCalls().length).toBe(0);
  });

  it("writes nothing when the edits leave the notes unchanged", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "same text") },
      indexResults: ["page-active", "page-active"],
    });

    const result = await doCheckpoint({ action: "edit", edits: [{ find: "same", replace: "same" }] });

    expect(result).toContain("no change");
    expect(writeCalls().length).toBe(0);
  });

  it("edits a non-default key and leaves other pages alone", async () => {
    mockNotion({
      pages: { "page-src": notesPage("src", "News notes v1") },
      indexResults: ["page-src", "page-src"],
    });

    const result = await doCheckpoint({
      action: "edit",
      key: "checkpoint-news",
      edits: [{ find: "v1", replace: "v2" }],
    });

    expect(result).toContain('Edited "checkpoint-news"');
    expect(insertedTexts("page-src", "src").join("\n")).toContain("News notes v2");
    expect(pageCreateCalls().length).toBe(0);
  });

  it("requires a non-empty 'edits' array", async () => {
    await expect(doCheckpoint({ action: "edit" })).rejects.toThrow(/requires 'edits'/);
    await expect(doCheckpoint({ action: "edit", edits: [] })).rejects.toThrow(/requires 'edits'/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("rejects an edit with an empty 'find' before writing anything", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "some notes") },
      indexResults: ["page-active", "page-active"],
    });

    await expect(
      doCheckpoint({ action: "edit", edits: [{ find: "", replace: "x" }] })
    ).rejects.toThrow(/non-empty string/);
    expect(writeCalls().length).toBe(0);
  });

  it("reports a clear message and writes nothing when the key has no checkpoint", async () => {
    mockNotion({ pages: {}, indexResults: [] });

    const result = await doCheckpoint({ action: "edit", edits: [{ find: "a", replace: "b" }] });

    expect(result).toContain("No checkpoint found");
    expect(result).toContain("nothing edited");
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

    await expect(
      doCheckpoint({ action: "edit", edits: [{ find: "plain", replace: "fancy" }] })
    ).rejects.toThrow(/other than plain paragraphs/);
    expect(writeCalls().length).toBe(0);
  });
});
