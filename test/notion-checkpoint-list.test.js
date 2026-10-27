// ---------------------------------------------------------------------------
// test/notion-checkpoint-list.test.js
// ---------------------------------------------------------------------------
// Covers the list action of doCheckpoint (connectors/notion/tools.js).
// Same mocking strategy as test/notion-checkpoint-append.test.js: only
// notionRequest (the I/O boundary) is mocked.
//
// list reads the child pages of the checkpoint parent page and keeps the ones
// that hold a checkpoint start marker, showing each as name (key) and page ID.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { buildCheckpointStartText, buildCheckpointEndText } from "../connectors/notion/client.js";
import { NOTION_SYNC_PARENT_PAGE_ID } from "../config.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return {
    ...actual,
    notionRequest: mockedNotionRequest,
  };
});

const para = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });
const childPage = (id) => ({ id, type: "child_page", child_page: { title: "whatever" } });

// A checkpoint page's first blocks: entity_id marker, start marker, a note, end marker.
function checkpointBlocks(key) {
  return [
    para(`e-${key}`, `\u{1F511} entity_id: ${key}`),
    para(`s-${key}`, buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
    para(`n-${key}`, "some notes"),
    para(`x-${key}`, buildCheckpointEndText()),
  ];
}

// `parentChildren` = blocks under the parent page; `pages` = { id: [blocks] | Error }.
function mockNotion({ parentChildren, pages }) {
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";
    if (method !== "GET") throw new Error(`list must not write: ${method} ${path}`);
    if (path.startsWith(`/blocks/${NOTION_SYNC_PARENT_PAGE_ID}/children`)) return { results: parentChildren };
    const m = path.match(/^\/blocks\/([\w-]+)\/children/);
    if (m && m[1] in pages) {
      if (pages[m[1]] instanceof Error) throw pages[m[1]];
      return { results: pages[m[1]] };
    }
    throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
  });
}

describe("Notion checkpoint list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists each checkpoint as name and page ID, default checkpoint first, then by name", async () => {
    mockNotion({
      parentChildren: [childPage("page-termux"), childPage("page-latest"), childPage("page-mahpari")],
      pages: {
        "page-termux": checkpointBlocks("termux"),
        "page-latest": checkpointBlocks("checkpoint-latest"),
        "page-mahpari": checkpointBlocks("mahpari"),
      },
    });

    const result = await doCheckpoint({ action: "list" });

    expect(result).toBe(
      "Checkpoints (3):\n" +
        "checkpoint-latest \u2014 page-latest\n" +
        "mahpari \u2014 page-mahpari\n" +
        "termux \u2014 page-termux"
    );
  });

  it("ignores pages that are not checkpoints and blocks that are not pages", async () => {
    mockNotion({
      parentChildren: [
        childPage("page-plain"),
        { id: "db-1", type: "child_database", child_database: { title: "Tasks" } },
        childPage("page-opus"),
      ],
      pages: {
        "page-plain": [para("p1", "just a normal page")],
        "page-opus": checkpointBlocks("opus"),
      },
    });

    const result = await doCheckpoint({ action: "list" });

    expect(result).toBe("Checkpoints (1):\nopus \u2014 page-opus");
  });

  it("skips a page that cannot be read and says so", async () => {
    mockNotion({
      parentChildren: [childPage("page-ok"), childPage("page-bad")],
      pages: {
        "page-ok": checkpointBlocks("opus"),
        "page-bad": new Error("Notion API error (500): boom"),
      },
    });

    const result = await doCheckpoint({ action: "list" });

    expect(result).toContain("Checkpoints (1):\nopus \u2014 page-ok");
    expect(result).toContain("1 page could not be read and was skipped");
  });

  it("says so when there are no checkpoints", async () => {
    mockNotion({ parentChildren: [childPage("page-plain")], pages: { "page-plain": [para("p1", "nothing here")] } });

    const result = await doCheckpoint({ action: "list" });

    expect(result).toBe("No checkpoints found.");
  });
});
