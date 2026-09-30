// ---------------------------------------------------------------------------
// test/notion-checkpoint-commit-log.test.js
// ---------------------------------------------------------------------------
// Covers the commit-log parts of doCheckpoint (connectors/notion/tools.js):
// marker seeding on new pages, marker insertion on existing pages, the
// start-marker-is-first-block warning, trim-on-save, default-key-only
// behavior, and the log section returned by load.
//
// Same mocking strategy as test/notion-checkpoint.test.js (see its header for
// why): mock only notionRequest -- including client.js's clientInternals --
// and let doCheckpoint/findPageByEntityId/doCreatePage run for real.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { buildCheckpointStartText, buildCheckpointEndText, COMMIT_LOG_MARKER_TEXT } from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  // Mutate in place -- see test/notion-checkpoint.test.js for the reason.
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return { ...actual, notionRequest: mockedNotionRequest };
});

const INDEX_QUERY_RE = /^\/databases\/.*\/query$/;
const DEFAULT_KEY = "checkpoint-latest";

const para = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });
const blockText = (block) => block.paragraph.rich_text.map((t) => t.text.content).join("");

const startBlock = () => para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z"));
const noteBlock = () => para("note-1", "Old handoff notes");
const endBlock = () => para("end-1", buildCheckpointEndText());
const entityBlock = (key = DEFAULT_KEY) => para("pre-1", `🔑 entity_id: ${key}`);

// An existing page whose top-level blocks are exactly `blocks`.
function mockExistingPage(blocks) {
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";
    if (INDEX_QUERY_RE.test(path)) {
      return { results: [{ properties: { PageId: { rich_text: [{ plain_text: "page-123" }] } } }] };
    }
    if (path === "/pages/page-123" && method === "GET") {
      return {
        id: "page-123",
        url: "https://notion.so/page-123",
        properties: { title: { type: "title", title: [{ plain_text: "Session Checkpoint" }] } },
      };
    }
    if (path.startsWith("/blocks/page-123/children")) {
      if (method === "PATCH") return {};
      if (path.includes("page_size=20")) return { results: [] }; // marker scan
      if (path.includes("page_size=100")) return { results: blocks };
    }
    if (/^\/blocks\/[\w-]+$/.test(path) && (method === "DELETE" || method === "PATCH")) return {};
    throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
  });
}

// A brand-new page: nothing tracked yet; /pages POSTs succeed.
function mockNewPage() {
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";
    if (INDEX_QUERY_RE.test(path)) return { results: [] };
    if (path === "/pages" && method === "POST") {
      if (opts.body?.parent?.database_id) return { id: "index-row-1" };
      return { id: "page-123", url: "https://notion.so/page-123" };
    }
    throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
  });
}

function createdChildTexts() {
  const createCall = client.notionRequest.mock.calls.find(
    ([path, opts]) => path === "/pages" && !opts?.body?.parent?.database_id
  );
  expect(createCall).toBeTruthy();
  return createCall[1].body.children.map(blockText);
}

function markerInsertCall(afterId) {
  return client.notionRequest.mock.calls.find(
    ([path, opts]) =>
      path === "/blocks/page-123/children" &&
      opts?.method === "PATCH" &&
      opts?.body?.after === afterId &&
      opts.body.children.map(blockText).join("") === COMMIT_LOG_MARKER_TEXT
  );
}

describe("doCheckpoint save -- commit log marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("new page, default key: seeds the log marker immediately BEFORE the checkpoint start marker", async () => {
    mockNewPage();
    await doCheckpoint({ action: "save", notes: "notes" });

    const texts = createdChildTexts();
    const markerIdx = texts.indexOf(COMMIT_LOG_MARKER_TEXT);
    const startIdx = texts.findIndex((t) => t.startsWith("✅ Checkpoint saved with MCP tool call"));
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBe(markerIdx + 1);
  });

  it("new page, non-default key: no log marker (recordCommit only ever logs to the default key)", async () => {
    mockNewPage();
    await doCheckpoint({ action: "save", notes: "notes", key: "other-key" });
    expect(createdChildTexts()).not.toContain(COMMIT_LOG_MARKER_TEXT);
  });

  it("existing page without a marker: inserts it right after the block preceding the start marker", async () => {
    mockExistingPage([entityBlock(), startBlock(), noteBlock(), endBlock()]);
    const result = await doCheckpoint({ action: "save", notes: "new notes" });

    expect(markerInsertCall("pre-1")).toBeTruthy();
    expect(result).toContain("Checkpoint saved successfully");
    expect(result).not.toContain("commit log unavailable");
  });

  it("existing page whose start marker is the FIRST block: skips the marker and warns", async () => {
    mockExistingPage([startBlock(), noteBlock(), endBlock()]);
    const result = await doCheckpoint({ action: "save", notes: "new notes" });

    expect(result).toContain("Checkpoint saved successfully");
    expect(result).toContain("commit log unavailable: start marker is first block");
    const anyMarkerInsert = client.notionRequest.mock.calls.some(
      ([path, opts]) =>
        path === "/blocks/page-123/children" &&
        opts?.method === "PATCH" &&
        opts.body.children.map(blockText).join("") === COMMIT_LOG_MARKER_TEXT
    );
    expect(anyMarkerInsert).toBe(false);
  });

  it("existing page that already has a marker: does not insert a second one", async () => {
    mockExistingPage([entityBlock(), para("log-marker", COMMIT_LOG_MARKER_TEXT), startBlock(), noteBlock(), endBlock()]);
    await doCheckpoint({ action: "save", notes: "new notes" });
    expect(markerInsertCall("pre-1")).toBeUndefined();
    expect(markerInsertCall("log-marker")).toBeUndefined();
  });

  it("existing page, non-default key: leaves the page alone (no marker, no warning)", async () => {
    mockExistingPage([startBlock(), noteBlock(), endBlock()]);
    const result = await doCheckpoint({ action: "save", notes: "new notes", key: "other-key" });
    expect(result).toContain("Checkpoint saved successfully");
    expect(result).not.toContain("commit log unavailable");
    const anyMarkerInsert = client.notionRequest.mock.calls.some(
      ([path, opts]) =>
        path === "/blocks/page-123/children" &&
        opts?.method === "PATCH" &&
        opts.body.children.map(blockText).join("") === COMMIT_LOG_MARKER_TEXT
    );
    expect(anyMarkerInsert).toBe(false);
  });
});

describe("doCheckpoint save -- trim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the newest 20 log lines and deletes only the oldest ones (bottom of the section)", async () => {
    // Newest first, so log-0 is newest and log-21 is oldest (right above the start marker).
    const logLines = Array.from({ length: 22 }, (_, i) => para(`log-${i}`, `sha${i} · msg ${i}`));
    mockExistingPage([entityBlock(), para("log-marker", COMMIT_LOG_MARKER_TEXT), ...logLines, startBlock(), noteBlock(), endBlock()]);

    await doCheckpoint({ action: "save", notes: "new notes" });

    const deleted = client.notionRequest.mock.calls
      .filter(([, opts]) => opts?.method === "DELETE")
      .map(([path]) => path);
    expect(deleted).toContain("/blocks/log-20");
    expect(deleted).toContain("/blocks/log-21");
    for (let i = 0; i < 20; i++) expect(deleted).not.toContain(`/blocks/log-${i}`);
    expect(deleted).not.toContain("/blocks/log-marker");
    expect(deleted).not.toContain("/blocks/pre-1");
  });

  it("does not delete anything when there are 20 or fewer log lines", async () => {
    const logLines = Array.from({ length: 20 }, (_, i) => para(`log-${i}`, `sha${i} · msg ${i}`));
    mockExistingPage([entityBlock(), para("log-marker", COMMIT_LOG_MARKER_TEXT), ...logLines, startBlock(), noteBlock(), endBlock()]);

    await doCheckpoint({ action: "save", notes: "new notes" });

    const deleted = client.notionRequest.mock.calls
      .filter(([, opts]) => opts?.method === "DELETE")
      .map(([path]) => path);
    for (let i = 0; i < 20; i++) expect(deleted).not.toContain(`/blocks/log-${i}`);
  });
});

describe("doCheckpoint load -- commit log section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prepends the log lines (newest first) to the notes", async () => {
    mockExistingPage([
      entityBlock(),
      para("log-marker", COMMIT_LOG_MARKER_TEXT),
      para("log-0", "bbbbbbb · second commit · feat/x · b.js · 2026-09-30T13:00:00.000Z"),
      para("log-1", "aaaaaaa · first commit · feat/x · a.js · 2026-09-30T12:00:00.000Z"),
      para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
      para("note-1", "Here are my notes"),
      endBlock(),
    ]);

    const result = await doCheckpoint({ action: "load" });

    expect(result.startsWith("Commit log:\n")).toBe(true);
    expect(result.indexOf("bbbbbbb")).toBeLessThan(result.indexOf("aaaaaaa"));
    expect(result.endsWith("Here are my notes")).toBe(true);
  });

  it("returns just the notes when the marker exists but the log is empty", async () => {
    mockExistingPage([
      entityBlock(),
      para("log-marker", COMMIT_LOG_MARKER_TEXT),
      para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
      para("note-1", "Here are my notes"),
      endBlock(),
    ]);
    expect(await doCheckpoint({ action: "load" })).toBe("Here are my notes");
  });

  it("returns just the notes when the page has no log marker (pre-feature pages)", async () => {
    mockExistingPage([entityBlock(), startBlock(), para("note-1", "Here are my notes"), endBlock()]);
    expect(await doCheckpoint({ action: "load" })).toBe("Here are my notes");
  });
});
