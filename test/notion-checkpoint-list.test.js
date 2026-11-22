// ---------------------------------------------------------------------------
// test/notion-checkpoint-list.test.js
// ---------------------------------------------------------------------------
// Covers the list action of doCheckpoint (connectors/notion/tools.js).
// Same mocking strategy as test/notion-checkpoint-append.test.js: only
// notionRequest (the I/O boundary) is mocked.
//
// list is ONE filtered Entity Index query (rows tagged CHECKPOINT_INDEX_TAG),
// showing each as name (key) and page ID.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint, CHECKPOINT_INDEX_TAG } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { NOTION_INDEX_DATABASE_ID } from "../config.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return {
    ...actual,
    notionRequest: mockedNotionRequest,
  };
});

const row = (key, pageId) => ({
  id: `row-${key}`,
  properties: {
    EntityId: { rich_text: [{ plain_text: key }] },
    PageId: { rich_text: [{ plain_text: pageId }] },
  },
});

// `pages` = array of result pages, each { results, has_more?, next_cursor? }.
function mockIndex(pages) {
  let call = 0;
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    if (path !== `/databases/${NOTION_INDEX_DATABASE_ID}/query` || opts.method !== "POST") {
      throw new Error(`Unexpected notionRequest call in this test: ${opts.method || "GET"} ${path}`);
    }
    return pages[Math.min(call++, pages.length - 1)];
  });
}

describe("Notion checkpoint list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists each checkpoint as name and page ID, default checkpoint first, then by name", async () => {
    mockIndex([{ results: [row("termux", "page-termux"), row("checkpoint-latest", "page-latest"), row("mahpari", "page-mahpari")] }]);

    const result = await doCheckpoint({ action: "list" });

    expect(result).toBe(
      "Checkpoints (3):\n" +
        "checkpoint-latest \u2014 page-latest\n" +
        "mahpari \u2014 page-mahpari\n" +
        "termux \u2014 page-termux"
    );
  });

  it("makes one request, filtered on the checkpoint tag", async () => {
    mockIndex([{ results: [row("opus", "page-opus")] }]);

    await doCheckpoint({ action: "list" });

    expect(client.notionRequest).toHaveBeenCalledTimes(1);
    const body = client.notionRequest.mock.calls[0][1].body;
    expect(body.filter).toEqual({ property: "Tags", multi_select: { contains: CHECKPOINT_INDEX_TAG } });
  });

  it("follows pagination", async () => {
    mockIndex([
      { results: [row("a", "pa")], has_more: true, next_cursor: "c1" },
      { results: [row("b", "pb")] },
    ]);

    const result = await doCheckpoint({ action: "list" });

    expect(result).toBe("Checkpoints (2):\na \u2014 pa\nb \u2014 pb");
    expect(client.notionRequest.mock.calls[1][1].body.start_cursor).toBe("c1");
  });

  it("ignores rows missing a key or page id", async () => {
    mockIndex([{ results: [row("opus", "page-opus"), row("", "page-x"), row("nopage", "")] }]);

    expect(await doCheckpoint({ action: "list" })).toBe("Checkpoints (1):\nopus \u2014 page-opus");
  });

  it("says so when there are no checkpoints", async () => {
    mockIndex([{ results: [] }]);

    expect(await doCheckpoint({ action: "list" })).toBe("No checkpoints found.");
  });
});
