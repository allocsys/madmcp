// ---------------------------------------------------------------------------
// test/notion-checkpoint-title.test.js
// ---------------------------------------------------------------------------
// A new checkpoint page is titled with its key, so several checkpoints are
// told apart in the Notion sidebar without opening each one.
// Same mocking strategy as test/notion-checkpoint-append.test.js: only
// notionRequest (the I/O boundary) is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";

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

// No checkpoint exists for any key: every index query comes back empty, so a
// save has to create a new page.
function mockEmptyWorkspace() {
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";
    if (INDEX_QUERY_RE.test(path)) return { results: [] };
    if (path === "/pages" && method === "POST") {
      if (opts.body?.parent?.database_id) return { id: "index-row-new" };
      return { id: "page-new", url: "https://notion.so/page-new" };
    }
    if (/^\/pages\/[\w-]+$/.test(path) && method === "PATCH") return {};
    if (/^\/blocks\/[\w-]+\/children/.test(path) && method === "PATCH") return {};
    throw new Error(`Unexpected notionRequest call in this test: ${method} ${path}`);
  });
}

// The title the new checkpoint page was created with.
function createdTitle() {
  const call = client.notionRequest.mock.calls.find(
    ([path, opts]) => path === "/pages" && opts?.method === "POST" && !opts?.body?.parent?.database_id
  );
  expect(call).toBeTruthy();
  return call[1].body.properties.title.title.map((t) => t.text.content).join("");
}

describe("Notion checkpoint page title", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("titles a new page with its key", async () => {
    mockEmptyWorkspace();

    const result = await doCheckpoint({ action: "save", key: "mahpari", notes: "some notes" });

    expect(result).toContain("Checkpoint saved successfully");
    expect(createdTitle()).toBe("mahpari");
  });

  it("titles the default checkpoint with its default key", async () => {
    mockEmptyWorkspace();

    await doCheckpoint({ action: "save", notes: "some notes" });

    expect(createdTitle()).toBe("checkpoint-latest");
  });
});
