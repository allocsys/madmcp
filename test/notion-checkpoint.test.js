// ---------------------------------------------------------------------------
// test/notion-checkpoint.test.js
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCheckpoint } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import * as tools from "../connectors/notion/tools.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notionRequest: vi.fn(),
  };
});

vi.mock("../connectors/notion/tools.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findPageByEntityId: vi.fn(),
    doCreatePage: vi.fn(),
    replaceSyncedRange: vi.fn(),
    findSyncRange: vi.fn(),
  };
});

describe("Notion checkpoint tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("save creates a new page when none exists, seeding the synced range directly (no separate replaceSyncedRange call)", async () => {
    tools.findPageByEntityId.mockResolvedValueOnce(null);
    tools.doCreatePage.mockResolvedValueOnce({
      id: "page-123",
      url: "https://notion.so/page-123",
    });

    const result = await doCheckpoint({ action: "save", notes: "Working on checkpoint feature" });

    expect(tools.findPageByEntityId).toHaveBeenCalledWith("checkpoint-latest");
    expect(tools.doCreatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Session Checkpoint",
        entity_id: "checkpoint-latest",
        content: expect.stringContaining("Working on checkpoint feature"),
      })
    );
    // The created page's content already contains the full synced range
    // (start marker + notes + end marker) via doCreatePage -- no follow-up
    // patch is needed or expected.
    expect(tools.replaceSyncedRange).not.toHaveBeenCalled();
    expect(result).toContain("Checkpoint saved successfully");
    expect(result).toContain("https://notion.so/page-123");
  });

  it("save overwrites/replaces the synced range on an existing page without creating a new page", async () => {
    tools.findPageByEntityId.mockResolvedValueOnce({
      pageId: "page-123",
      title: "Session Checkpoint",
      url: "https://notion.so/page-123",
    });
    tools.replaceSyncedRange.mockResolvedValueOnce({ action: "updated", removed: 1, added: 1 });

    const result = await doCheckpoint({ action: "save", notes: "Updated handoff notes" });

    expect(tools.findPageByEntityId).toHaveBeenCalledWith("checkpoint-latest");
    expect(tools.doCreatePage).not.toHaveBeenCalled();
    expect(tools.replaceSyncedRange).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: "page-123",
        contentLines: ["Updated handoff notes"],
      })
    );
    expect(result).toContain("Checkpoint saved successfully");
  });

  it("load returns the current notes when a page exists", async () => {
    tools.findPageByEntityId.mockResolvedValueOnce({
      pageId: "page-123",
      title: "Session Checkpoint",
      url: "https://notion.so/page-123",
    });
    tools.findSyncRange.mockReturnValueOnce({
      synced_at: "2026-09-03T00:00:00.000Z",
      startBlockId: "start-1",
      endBlockId: "end-1",
      innerBlockIds: ["block-1"],
    });

    client.notionRequest.mockResolvedValueOnce({
      results: [
        { id: "start-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "start marker" }] } },
        { id: "block-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Here are my notes" }] } },
        { id: "end-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "end marker" }] } },
      ],
    });

    const result = await doCheckpoint({ action: "load" });

    expect(tools.findPageByEntityId).toHaveBeenCalledWith("checkpoint-latest");
    expect(client.notionRequest).toHaveBeenCalledWith("/blocks/page-123/children?page_size=100");
    expect(result).toBe("Here are my notes");
  });

  it("load returns a clear not-found message when no page exists yet", async () => {
    tools.findPageByEntityId.mockResolvedValueOnce(null);

    const result = await doCheckpoint({ action: "load" });

    expect(tools.findPageByEntityId).toHaveBeenCalledWith("checkpoint-latest");
    expect(result).toBe("No checkpoint found.");
  });
});
