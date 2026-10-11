// ---------------------------------------------------------------------------
// test/notion-checkpoint-park.test.js
// ---------------------------------------------------------------------------
// Covers the park / unpark actions of doCheckpoint (connectors/notion/tools.js).
// Same mocking strategy as test/notion-checkpoint.test.js: only notionRequest
// (the I/O boundary) is mocked; doCheckpoint, findPageByEntityId, doCreatePage
// and replaceCheckpointRange run for real against canned Notion responses.
// See that file's header comment for why clientInternals is mutated in place.

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

// A page's block list: start marker, one note block, end marker.
function checkpointBlocks(prefix, noteText) {
  return [
    para(`start-${prefix}`, buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
    para(`note-${prefix}`, noteText),
    para(`end-${prefix}`, buildCheckpointEndText()),
  ];
}

const indexRow = (pageId) => ({ properties: { PageId: { rich_text: [{ plain_text: pageId }] } } });

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
// `indexResults` is consumed one entry per entity-id index query, in call
// order; once exhausted, further queries return no results.
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

const deleteCalls = () => client.notionRequest.mock.calls.filter(([, opts]) => opts?.method === "DELETE");
const pageCreateCalls = () =>
  client.notionRequest.mock.calls.filter(
    ([path, opts]) => path === "/pages" && opts?.method === "POST" && !opts?.body?.parent?.database_id
  );

describe("Notion checkpoint park / unpark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("park copies the active notes to a new key and deletes nothing", async () => {
    mockNotion({
      pages: { "page-active": checkpointBlocks("active", "MahPari notes") },
      // 1st query = source lookup; later queries (target lookup + create dedup) find nothing.
      indexResults: ["page-active"],
    });

    const result = await doCheckpoint({ action: "park", to: "checkpoint2" });

    expect(result).toContain('Parked "checkpoint-latest" -> "checkpoint2"');
    expect(result).toContain("Checkpoint saved successfully");

    // A new page was created for the target key, carrying the copied notes.
    const created = pageCreateCalls();
    expect(created.length).toBe(1);
    const childTexts = created[0][1].body.children.map(blockText);
    expect(childTexts.some((t) => t.includes("MahPari notes"))).toBe(true);
    expect(childTexts.some((t) => t.includes("checkpoint2"))).toBe(true);

    // Nothing was removed from the source (or anywhere).
    expect(deleteCalls().length).toBe(0);
  });

  it("park can read from a non-default source key", async () => {
    mockNotion({
      pages: { "page-src": checkpointBlocks("src", "News notes") },
      indexResults: ["page-src"],
    });

    const result = await doCheckpoint({ action: "park", key: "checkpoint-news-market-ai", to: "checkpoint3" });

    expect(result).toContain('Parked "checkpoint-news-market-ai" -> "checkpoint3"');
    const childTexts = pageCreateCalls()[0][1].body.children.map(blockText);
    expect(childTexts.some((t) => t.includes("News notes"))).toBe(true);
  });

  it("park does not copy the commit log, only the saved notes", async () => {
    const blocks = [
      para("log-marker", "\u{1F4DD} commit log"),
      para("log-1", "abc1234 \u00b7 some commit"),
      ...checkpointBlocks("active", "Only these notes"),
    ];
    mockNotion({ pages: { "page-active": blocks }, indexResults: ["page-active"] });

    await doCheckpoint({ action: "park", to: "checkpoint2" });

    const childTexts = pageCreateCalls()[0][1].body.children.map(blockText);
    expect(childTexts.some((t) => t.includes("Only these notes"))).toBe(true);
    expect(childTexts.some((t) => t.includes("abc1234"))).toBe(false);
  });

  it("park requires 'to'", async () => {
    await expect(doCheckpoint({ action: "park" })).rejects.toThrow(/requires 'to'/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("park rejects when 'to' equals the source key", async () => {
    await expect(doCheckpoint({ action: "park", key: "checkpoint2", to: "checkpoint2" })).rejects.toThrow(/must differ/);
    await expect(doCheckpoint({ action: "park", to: "checkpoint-latest" })).rejects.toThrow(/must differ/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("park reports a clear message and writes nothing when the source has no checkpoint", async () => {
    mockNotion({ pages: {}, indexResults: [] });

    const result = await doCheckpoint({ action: "park", to: "checkpoint2" });

    expect(result).toContain("No checkpoint found");
    expect(result).toContain("nothing parked");
    expect(pageCreateCalls().length).toBe(0);
  });

  it("unpark requires a non-default key", async () => {
    await expect(doCheckpoint({ action: "unpark" })).rejects.toThrow(/requires 'key'/);
    await expect(doCheckpoint({ action: "unpark", key: "checkpoint-latest" })).rejects.toThrow(/requires 'key'/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("unpark copies the parked notes into checkpoint-latest and leaves the parked page untouched", async () => {
    mockNotion({
      pages: {
        "page-parked": checkpointBlocks("parked", "Parked MahPari notes"),
        "page-active": checkpointBlocks("active", "Current active notes"),
      },
      // 1st query = parked key lookup; 2nd = checkpoint-latest lookup.
      indexResults: ["page-parked", "page-active"],
    });

    const result = await doCheckpoint({ action: "unpark", key: "checkpoint2" });

    expect(result).toContain('Unparked "checkpoint2" -> "checkpoint-latest"');
    expect(result).toContain("https://notion.so/page-active");

    // The active page's old note was replaced, new content inserted after its start marker.
    expect(client.notionRequest).toHaveBeenCalledWith("/blocks/note-active", { method: "DELETE" });
    const insertCall = client.notionRequest.mock.calls.find(
      ([path, opts]) => path === "/blocks/page-active/children" && opts?.method === "PATCH" && opts?.body?.after === "start-active"
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall[1].body.children.map(blockText).join(" ")).toContain("Parked MahPari notes");

    // The parked page was only read, never modified or deleted.
    const touchedParked = client.notionRequest.mock.calls.filter(
      ([path, opts]) => /parked/.test(path) && opts?.method && opts.method !== "GET"
    );
    expect(touchedParked.length).toBe(0);
    expect(client.notionRequest).not.toHaveBeenCalledWith("/blocks/note-parked", expect.anything());
    expect(pageCreateCalls().length).toBe(0);
  });

  it("unpark reports a clear message and changes nothing when the parked key has no checkpoint", async () => {
    mockNotion({ pages: {}, indexResults: [] });

    const result = await doCheckpoint({ action: "unpark", key: "checkpoint9" });

    expect(result).toContain("No checkpoint found");
    expect(result).toContain("nothing restored");
    expect(deleteCalls().length).toBe(0);
    expect(pageCreateCalls().length).toBe(0);
  });
});
