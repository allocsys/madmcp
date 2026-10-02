// ---------------------------------------------------------------------------
// test/notion-range-swap.test.js
// Insert-before-delete ordering and failure behavior of the marker-range
// replace used by notion_sync_content and the checkpoint tool.
// Only notionRequest (the I/O boundary) is mocked, same as notion-checkpoint.test.js.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { replaceCheckpointRange, replaceSyncedRange } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";
import { buildCheckpointStartText, buildCheckpointEndText, buildSyncStartText, buildSyncEndText } from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return { ...actual, notionRequest: mockedNotionRequest };
});

const para = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });

function seedCheckpointPage(innerIds, handler = () => undefined) {
  const blocks = [
    para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
    ...innerIds.map((id) => para(id, `old ${id}`)),
    para("end-1", buildCheckpointEndText()),
  ];
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const method = opts.method || "GET";
    const custom = handler(path, method, opts);
    if (custom !== undefined) return custom;
    if (path.startsWith("/blocks/page-1/children") && method === "GET") return { results: blocks };
    return {};
  });
}

const callsOf = () => client.notionRequest.mock.calls.map(([path, opts]) => `${opts?.method || "GET"} ${path}`);

describe("marker range replace: insert before delete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts the new content first, deletes old blocks next, bumps the start marker last", async () => {
    seedCheckpointPage(["old-a", "old-b"]);
    const res = await replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "2026-02-02T00:00:00.000Z" });
    expect(res).toMatchObject({ action: "updated", removed: 2, added: 1 });

    const calls = callsOf();
    const insertIdx = calls.indexOf("PATCH /blocks/page-1/children");
    const delA = calls.indexOf("DELETE /blocks/old-a");
    const delB = calls.indexOf("DELETE /blocks/old-b");
    const markerIdx = calls.indexOf("PATCH /blocks/start-1");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(delA).toBeGreaterThan(insertIdx);
    expect(delB).toBeGreaterThan(insertIdx);
    expect(markerIdx).toBeGreaterThan(Math.max(delA, delB));
  });

  it("does not delete anything or touch the marker when the insert fails", async () => {
    seedCheckpointPage(["old-a"], (path, method) => {
      if (path === "/blocks/page-1/children" && method === "PATCH") throw new Error("Notion API error (500): boom");
    });
    await expect(replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "t" })).rejects.toThrow(/boom/);
    const calls = callsOf();
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(calls).not.toContain("PATCH /blocks/start-1");
  });

  it("throws and leaves the timestamp untouched when an old block can't be deleted", async () => {
    seedCheckpointPage(["old-a", "old-b"], (path, method) => {
      if (path === "/blocks/old-b" && method === "DELETE") throw new Error("Notion API error (500): nope");
    });
    await expect(replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "t" })).rejects.toThrow(/1 of 2 old block/);
    expect(callsOf()).not.toContain("PATCH /blocks/start-1");
  });

  it("treats an already-deleted (404) old block as success", async () => {
    seedCheckpointPage(["old-a"], (path, method) => {
      if (path === "/blocks/old-a" && method === "DELETE") throw new Error("Notion API error (404): not found");
    });
    const res = await replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "t" });
    expect(res.action).toBe("updated");
    expect(callsOf()).toContain("PATCH /blocks/start-1");
  });

  it("sync range uses the same ordering and still skips an unchanged timestamp", async () => {
    const ts = "2026-03-03T00:00:00.000Z";
    const blocks = [para("s", buildSyncStartText(ts)), para("old", "x"), para("e", buildSyncEndText())];
    const impl = async (path, opts = {}) => {
      if (path.startsWith("/blocks/page-1/children") && !opts.method) return { results: blocks };
      return {};
    };
    client.notionRequest.mockImplementation(impl);
    const skipped = await replaceSyncedRange({ page_id: "page-1", contentLines: ["n"], synced_at: ts });
    expect(skipped.action).toBe("skipped");
    expect(callsOf().some((c) => c.startsWith("DELETE"))).toBe(false);

    vi.clearAllMocks();
    client.notionRequest.mockImplementation(impl);
    const updated = await replaceSyncedRange({ page_id: "page-1", contentLines: ["n"], synced_at: "2026-04-04T00:00:00.000Z" });
    expect(updated).toMatchObject({ action: "updated", previousSyncedAt: ts });
    const calls = callsOf();
    expect(calls.indexOf("PATCH /blocks/page-1/children")).toBeLessThan(calls.indexOf("DELETE /blocks/old"));
  });
});
