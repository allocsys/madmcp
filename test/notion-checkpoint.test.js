// ---------------------------------------------------------------------------
// test/notion-checkpoint.test.js
// ---------------------------------------------------------------------------
// NOTE on mocking strategy: an earlier version of this file mocked
// connectors/notion/tools.js itself (vi.mock + `import * as tools`) and
// expected doCheckpoint's internal calls to findPageByEntityId/doCreatePage/
// replaceCheckpointRange to route through those mocks. That doesn't work in
// real ESM: a function calling a sibling export FROM THE SAME MODULE binds
// directly to the local declaration, never through the module's exported
// namespace object -- vi.mock only intercepts what OTHER modules import, not
// intra-module references. The mocks were silently never called, the real
// functions ran instead, hit a real (unmocked) Notion API call, and CI failed
// with "Cannot read properties of undefined (reading 'results')".
//
// Fix: mock only notionRequest, the one true I/O boundary in client.js, and
// let doCheckpoint/findPageByEntityId/doCreatePage/replaceCheckpointRange run
// for real -- driving them purely through canned notionRequest responses, the
// same way the real Notion API would.
//
// 2026-09-04: updated to the dedicated checkpoint marker convention
// (buildCheckpointStartText/buildCheckpointEndText/findCheckpointRange) --
// doCheckpoint no longer touches the mem0 sync markers at all (see
// client.js's "Checkpoint marker convention" comment), so these tests need
// to seed/assert against checkpoint markers instead of sync markers or they
// never actually exercise the real code path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { buildCheckpointStartText, buildCheckpointEndText } from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notionRequest: vi.fn(),
  };
});

const INDEX_QUERY_RE = /^\/databases\/.*\/query$/;

// Pulls the plain text a caller sent for a given outgoing block (the shape
// textBlock() builds: { paragraph: { rich_text: [{ text: { content } }] } }).
function blockText(block) {
  return block.paragraph.rich_text.map((t) => t.text.content).join("");
}

describe("Notion checkpoint tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("save creates a new page when none exists, seeding the checkpoint range directly (no separate patch)", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      const method = opts.method || "GET";

      // Both doCheckpoint's own lookup and doCreatePage's internal dedup
      // lookup ask this same question -- nothing tracked yet, either time.
      if (INDEX_QUERY_RE.test(path)) return { results: [] };

      if (path === "/pages" && method === "POST") {
        if (opts.body?.parent?.database_id) {
          return { id: "index-row-1" }; // Entity Index row for the new page
        }
        return { id: "page-123", url: "https://notion.so/page-123" }; // the actual page
      }

      throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
    });

    const result = await doCheckpoint({ action: "save", notes: "Working on checkpoint feature" });

    expect(result).toContain("Checkpoint saved successfully");
    expect(result).toContain("https://notion.so/page-123");

    const createCall = client.notionRequest.mock.calls.find(
      ([path, opts]) => path === "/pages" && !opts?.body?.parent?.database_id
    );
    expect(createCall).toBeTruthy();
    const childTexts = createCall[1].body.children.map(blockText);
    expect(childTexts.some((t) => t.includes("Working on checkpoint feature"))).toBe(true);
    expect(childTexts.some((t) => t.startsWith("✅ Checkpoint saved with MCP tool call"))).toBe(true);
    expect(childTexts.some((t) => t === buildCheckpointEndText())).toBe(true);

    // No follow-up patch to any /blocks/.../children path -- confirms the
    // range was seeded in the create call, not added afterward.
    const blocksChildrenPatches = client.notionRequest.mock.calls.filter(
      ([path]) => /^\/blocks\/.*\/children/.test(path)
    );
    expect(blocksChildrenPatches.length).toBe(0);
  });

  it("save overwrites/replaces the checkpoint range on an existing page without creating a new page", async () => {
    const oldUpdatedAt = "2026-01-01T00:00:00.000Z";
    const startBlock = { id: "start-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: buildCheckpointStartText(oldUpdatedAt) }] } };
    const oldNoteBlock = { id: "note-old", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Old handoff notes" }] } };
    const endBlock = { id: "end-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: buildCheckpointEndText() }] } };

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
        if (method === "PATCH") return {}; // insert new content after the start marker
        if (path.includes("page_size=20")) return { results: [] }; // marker scan
        if (path.includes("page_size=100")) return { results: [startBlock, oldNoteBlock, endBlock] };
      }
      if (/^\/blocks\/[\w-]+$/.test(path) && (method === "DELETE" || method === "PATCH")) {
        return {};
      }

      throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
    });

    const result = await doCheckpoint({ action: "save", notes: "Updated handoff notes" });

    expect(result).toContain("Checkpoint saved successfully");
    expect(result).toContain("https://notion.so/page-123");

    // No new page (or index row) was created for this save.
    const pageCreateCall = client.notionRequest.mock.calls.find(
      ([path, opts]) => path === "/pages" && (opts?.method || "GET") === "POST"
    );
    expect(pageCreateCall).toBeUndefined();

    // The stale inner block was deleted...
    expect(client.notionRequest).toHaveBeenCalledWith("/blocks/note-old", { method: "DELETE" });

    // ...and replaced with the new note content, inserted right after the
    // start marker (not appended at the end / not a fresh range).
    const insertCall = client.notionRequest.mock.calls.find(
      ([path, opts]) => path === "/blocks/page-123/children" && opts?.method === "PATCH" && opts?.body?.after === "start-1"
    );
    expect(insertCall).toBeTruthy();
    const insertedText = insertCall[1].body.children.map(blockText).join(" ");
    expect(insertedText).toContain("Updated handoff notes");

    // The start marker's own timestamp was rewritten in place, not replaced
    // wholesale (same block id, new text).
    expect(client.notionRequest).toHaveBeenCalledWith(
      "/blocks/start-1",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("load returns the current notes when a page exists", async () => {
    const startBlock = { id: "start-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: buildCheckpointStartText("2026-01-01T00:00:00.000Z") }] } };
    const noteBlock = { id: "note-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Here are my notes" }] } };
    const endBlock = { id: "end-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: buildCheckpointEndText() }] } };

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
        if (path.includes("page_size=20")) return { results: [] }; // marker scan
        if (path.includes("page_size=100")) return { results: [startBlock, noteBlock, endBlock] };
      }

      throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
    });

    const result = await doCheckpoint({ action: "load" });

    expect(result).toBe("Here are my notes");
  });

  it("load returns a clear not-found message when no page exists yet", async () => {
    client.notionRequest.mockImplementation(async (path) => {
      if (INDEX_QUERY_RE.test(path)) return { results: [] };
      throw new Error(`Unexpected notionRequest call in this test: GET ${path}`);
    });

    const result = await doCheckpoint({ action: "load" });

    expect(result).toBe("No checkpoint found.");
  });
});
