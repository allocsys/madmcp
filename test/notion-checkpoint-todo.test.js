// ---------------------------------------------------------------------------
// test/notion-checkpoint-todo.test.js
// ---------------------------------------------------------------------------
// Covers connectors/notion/todo.js (pure helpers) and the todo_* actions of
// doCheckpoint. Same mocking strategy as test/notion-checkpoint-append.test.js.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint } from "../connectors/notion/tools.js";
import { addTodos, setTodoState, listOpenTodos, openTodoCount, clearDoneTodos } from "../connectors/notion/todo.js";
import * as client from "../connectors/notion/client.js";
import { finalNoteTexts } from "./_notion-notes-sim.js";
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
  lastPages = pages;
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

// The note lines on the page after replaying every write call.
let lastPages = {};
function insertedTexts(pageId = "page-active") {
  return finalNoteTexts(client.notionRequest.mock.calls, pageId, lastPages[pageId]);
}


describe("todo helpers", () => {
  it("add creates the TODO heading and numbers items from 1", () => {
    const r = addTodos(["note"], ["- first", "second"]);
    expect(r.ids).toEqual([1, 2]);
    expect(r.lines).toEqual(["note", "TODO", "#1 [ ] first", "#2 [ ] second"]);
  });

  it("add continues after the highest id and inserts after the last item", () => {
    const lines = ["TODO", "#1 [x] a", "#4 [ ] b", "other"];
    const r = addTodos(lines, ["c"]);
    expect(r.ids).toEqual([5]);
    expect(r.lines).toEqual(["TODO", "#1 [x] a", "#4 [ ] b", "#5 [ ] c", "other"]);
  });

  it("add rejects empty input", () => {
    expect(() => addTodos([], ["  "])).toThrow(/requires 'notes'/);
  });

  it("setTodoState marks done/doing and reports missing ids", () => {
    const lines = ["TODO", "#1 [ ] a", "#2 [ ] b"];
    const r = setTodoState(lines, [2, 9], "doing");
    expect(r.lines[2]).toBe("#2 [~] b");
    expect(r.changed).toEqual([2]);
    expect(r.missing).toEqual([9]);
    expect(setTodoState(lines, [1], "done").lines[1]).toBe("#1 [x] a");
  });

  it("add strips a pasted item prefix instead of nesting it", () => {
    expect(addTodos([], ["#7 [ ] looks like an item", "- #3 [x] bulleted"]).lines).toEqual(["TODO", "#1 [ ] looks like an item", "#2 [ ] bulleted"]);
    expect(() => addTodos([], ["#7 [ ]"])).not.toThrow();
  });

  it("setTodoState skips items already in the state and flags reopened ones", () => {
    const lines = ["TODO", "#1 [x] a", "#2 [ ] b"];
    const again = setTodoState(lines, [1], "done");
    expect(again.changed).toEqual([]);
    expect(again.unchanged).toEqual([1]);
    expect(again.lines).toEqual(lines);
    const reopen = setTodoState(lines, [1], "doing");
    expect(reopen.reopened).toEqual([1]);
    expect(reopen.lines[1]).toBe("#1 [~] a");
    expect(setTodoState(lines, [2], "doing").reopened).toEqual([]);
  });

  it("list shows open and doing only; count matches", () => {
    const lines = ["TODO", "#1 [x] a", "#2 [~] b", "#3 [ ] c"];
    expect(listOpenTodos(lines)).toEqual(["#2 [~] b", "#3 [ ] c"]);
    expect(openTodoCount(lines)).toBe(2);
  });

  it("clear drops done items and the heading when none are left", () => {
    expect(clearDoneTodos(["TODO", "#1 [x] a", "#2 [ ] b"])).toEqual({ lines: ["TODO", "#2 [ ] b"], removed: 1 });
    expect(clearDoneTodos(["x", "TODO", "#1 [x] a"])).toEqual({ lines: ["x"], removed: 1 });
  });

  it("ids stay stable after clear (no renumbering)", () => {
    const cleared = clearDoneTodos(["TODO", "#1 [x] a", "#2 [ ] b"]).lines;
    expect(addTodos(cleared, ["c"]).ids).toEqual([3]);
  });
});

describe("Notion checkpoint todo actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("todo_add appends an item under a new TODO heading", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "line one") },
      indexResults: ["page-active", "page-active"],
    });
    const result = await doCheckpoint({ action: "todo_add", notes: "ship it" });
    expect(result).toBe("Added #1. 1 open.");
    expect(insertedTexts()).toEqual(["line one", "TODO", "#1 [ ] ship it"]);
  });

  it("todo_done ticks an item and keeps it as [x]", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "TODO", "#1 [ ] a", "#2 [ ] b") },
      indexResults: ["page-active", "page-active"],
    });
    const result = await doCheckpoint({ action: "todo_done", ids: [1] });
    expect(result).toBe("Done: #1. 1 open.");
    expect(insertedTexts()).toEqual(["TODO", "#1 [x] a", "#2 [ ] b"]);
  });

  it("todo_done with an unknown id writes nothing", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "TODO", "#1 [ ] a") },
      indexResults: ["page-active"],
    });
    await expect(doCheckpoint({ action: "todo_done", ids: [7] })).rejects.toThrow(/no todo with id #7/);
    expect(writeCalls().length).toBe(0);
  });

  it("todo_done on an already-done item says so and writes nothing", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "TODO", "#1 [x] a", "#2 [ ] b") },
      indexResults: ["page-active"],
    });
    expect(await doCheckpoint({ action: "todo_done", ids: [1] })).toBe("Already done: #1. 1 open.");
    expect(writeCalls().length).toBe(0);
  });

  it("todo_doing on a done item reports it as reopened", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "TODO", "#1 [x] a") },
      indexResults: ["page-active", "page-active"],
    });
    expect(await doCheckpoint({ action: "todo_doing", ids: [1] })).toBe("Doing: #1 (reopened). 1 open.");
    expect(insertedTexts()).toEqual(["TODO", "#1 [~] a"]);
  });

  it("todo_list returns open items only and writes nothing", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "TODO", "#1 [x] a", "#2 [ ] b") },
      indexResults: ["page-active"],
    });
    expect(await doCheckpoint({ action: "todo_list" })).toBe("#2 [ ] b");
    expect(writeCalls().length).toBe(0);
  });

  it("todo_list on a checkpoint with no todos says so", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "just notes") },
      indexResults: ["page-active"],
    });
    expect(await doCheckpoint({ action: "todo_list" })).toBe("No open todos.");
  });

  it("todo_clear removes done items", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "TODO", "#1 [x] a", "#2 [ ] b") },
      indexResults: ["page-active", "page-active"],
    });
    const result = await doCheckpoint({ action: "todo_clear" });
    expect(result).toBe("Cleared 1 done todo. 1 open.");
    expect(insertedTexts()).toEqual(["TODO", "#2 [ ] b"]);
  });

  it("load ends with the open-todo count", async () => {
    mockNotion({
      pages: { "page-active": notesPage("active", "TODO", "#1 [ ] a", "#2 [x] b") },
      indexResults: ["page-active"],
    });
    expect(await doCheckpoint({ action: "load" })).toContain("Todos: 1 open");
  });
});
