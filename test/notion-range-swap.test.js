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

  it("patches changed blocks in place, deletes the surplus, bumps the start marker last", async () => {
    seedCheckpointPage(["old-a", "old-b"]);
    const res = await replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "2026-02-02T00:00:00.000Z" });
    expect(res).toMatchObject({ action: "updated", removed: 2, added: 1, diff: { kept: 0, patched: 1, appended: 0, deleted: 1 } });

    const calls = callsOf();
    const patchA = calls.indexOf("PATCH /blocks/old-a");
    const delB = calls.indexOf("DELETE /blocks/old-b");
    const markerIdx = calls.indexOf("PATCH /blocks/start-1");
    expect(calls).not.toContain("PATCH /blocks/page-1/children");
    expect(calls).not.toContain("DELETE /blocks/old-a");
    expect(patchA).toBeGreaterThan(-1);
    expect(delB).toBeGreaterThan(patchA);
    expect(markerIdx).toBeGreaterThan(delB);
    const patchBody = client.notionRequest.mock.calls.find(([path]) => path === "/blocks/old-a")[1].body;
    expect(patchBody.paragraph.rich_text[0].text.content).toBe("new");
  });

  it("an append only inserts the new lines after the last old block and bumps the marker", async () => {
    seedCheckpointPage(["old-a", "old-b"]);
    const res = await replaceCheckpointRange({ page_id: "page-1", contentLines: ["old old-a", "old old-b", "added"], updated_at: "t" });
    expect(res.diff).toEqual({ kept: 2, patched: 0, appended: 1, deleted: 0 });
    const calls = callsOf();
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("PATCH /blocks/old-"))).toEqual([]);
    const append = client.notionRequest.mock.calls.find(([path, o]) => path === "/blocks/page-1/children" && o?.method === "PATCH");
    expect(append[1].body.after).toBe("old-b");
    expect(append[1].body.children).toHaveLength(1);
    expect(calls.indexOf("PATCH /blocks/start-1")).toBeGreaterThan(calls.indexOf("PATCH /blocks/page-1/children"));
  });

  it("identical notes only bump the timestamp", async () => {
    seedCheckpointPage(["old-a", "old-b"]);
    await replaceCheckpointRange({ page_id: "page-1", contentLines: ["old old-a", "old old-b"], updated_at: "t" });
    expect(callsOf().filter((c) => !c.startsWith("GET"))).toEqual(["PATCH /blocks/start-1"]);
  });

  it("a middle change leaves the unchanged head and tail untouched", async () => {
    seedCheckpointPage(["a", "b", "c"]);
    const res = await replaceCheckpointRange({ page_id: "page-1", contentLines: ["old a", "CHANGED", "old c"], updated_at: "t" });
    expect(res.diff).toEqual({ kept: 2, patched: 1, appended: 0, deleted: 0 });
    expect(callsOf().filter((c) => !c.startsWith("GET"))).toEqual(["PATCH /blocks/b", "PATCH /blocks/start-1"]);
  });

  it("uses a prefetched block list instead of reading the page again", async () => {
    seedCheckpointPage(["a"]);
    const blocks = [
      para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
      para("a", "old a"),
      para("end-1", buildCheckpointEndText()),
    ];
    await replaceCheckpointRange({ page_id: "page-1", contentLines: ["x"], updated_at: "t", blocks });
    expect(callsOf().filter((c) => c.startsWith("GET"))).toEqual([]);
  });

  it("does not touch the marker or delete anything when the append fails", async () => {
    seedCheckpointPage(["old-a"], (path, method) => {
      if (path === "/blocks/page-1/children" && method === "PATCH") throw new Error("Notion API error (500): boom");
    });
    await expect(replaceCheckpointRange({ page_id: "page-1", contentLines: ["old old-a", "more"], updated_at: "t" })).rejects.toThrow(/boom/);
    const calls = callsOf();
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(calls).not.toContain("PATCH /blocks/start-1");
  });

  it("throws and leaves the timestamp untouched when a block can't be patched", async () => {
    seedCheckpointPage(["old-a"], (path, method) => {
      if (path === "/blocks/old-a" && method === "PATCH") throw new Error("Notion API error (500): nope");
    });
    await expect(replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "t" })).rejects.toThrow(/1 of 1 changed block/);
    expect(callsOf()).not.toContain("PATCH /blocks/start-1");
  });

  it("throws and leaves the timestamp untouched when a surplus old block can't be deleted", async () => {
    seedCheckpointPage(["old-a", "old-b"], (path, method) => {
      if (path === "/blocks/old-b" && method === "DELETE") throw new Error("Notion API error (500): nope");
    });
    await expect(replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "t" })).rejects.toThrow(/1 of 1 old block/);
    expect(callsOf()).not.toContain("PATCH /blocks/start-1");
  });

  it("treats an already-deleted (404) surplus block as success", async () => {
    seedCheckpointPage(["old-a", "old-b"], (path, method) => {
      if (path === "/blocks/old-b" && method === "DELETE") throw new Error("Notion API error (404): not found");
    });
    const res = await replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "t" });
    expect(res.action).toBe("updated");
    expect(callsOf()).toContain("PATCH /blocks/start-1");
  });

  it("falls back to insert-first full replace when the range holds a non-paragraph block", async () => {
    const blocks = [
      para("start-1", buildCheckpointStartText("2026-01-01T00:00:00.000Z")),
      { id: "h", type: "heading_2", heading_2: { rich_text: [{ plain_text: "hand edited" }] } },
      para("end-1", buildCheckpointEndText()),
    ];
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      if (path.startsWith("/blocks/page-1/children") && !opts.method) return { results: blocks };
      return {};
    });
    const res = await replaceCheckpointRange({ page_id: "page-1", contentLines: ["new"], updated_at: "t" });
    expect(res.diff).toBeUndefined();
    const calls = callsOf();
    expect(calls.indexOf("PATCH /blocks/page-1/children")).toBeGreaterThan(-1);
    expect(calls.indexOf("DELETE /blocks/h")).toBeGreaterThan(calls.indexOf("PATCH /blocks/page-1/children"));
    expect(calls.indexOf("PATCH /blocks/start-1")).toBeGreaterThan(calls.indexOf("DELETE /blocks/h"));
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
