// ---------------------------------------------------------------------------
// test/notion-linking-parallel.test.js -- findLinkCandidates reads candidate
// blocks concurrently and merges identifier hits before tag matches.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ inflight: 0, maxInflight: 0, tagCalled: false }));

vi.mock("../connectors/notion/client.js", () => ({
  notionPageTitle: (p) => p.title || "",
  notionBlocksToText: () => "",
  parseMarkers: () => ({ entity_id: null }),
  queryAllIndexEntries: vi.fn(async () => { h.tagCalled = true; return []; }),
  notionRequest: vi.fn(async (path) => {
    if (path === "/search") {
      return { results: [1, 2, 3, 4].map((n) => ({ object: "page", id: `p${n}`, title: `repo thing ${n}`, url: `u${n}`, created_time: new Date().toISOString() })) };
    }
    if (/^\/blocks\//.test(path)) {
      h.inflight++;
      h.maxInflight = Math.max(h.maxInflight, h.inflight);
      await new Promise((r) => setTimeout(r, 5));
      h.inflight--;
      return { results: [] };
    }
    throw new Error(`unexpected ${path}`);
  }),
}));

import { findLinkCandidates } from "../connectors/notion/linking.js";

describe("findLinkCandidates concurrency", () => {
  beforeEach(() => { h.inflight = 0; h.maxInflight = 0; h.tagCalled = false; });

  it("reads candidate blocks in parallel", async () => {
    await findLinkCandidates({ title: "Fix repo#10", content: "body" });
    expect(h.maxInflight).toBeGreaterThan(1);
  });

  it("still runs the tag-overlap path when there are tags", async () => {
    const r = await findLinkCandidates({ title: "Fix repo#10", content: "Tags: a, b" });
    expect(h.tagCalled).toBe(true);
    expect(r).toEqual({ strong: expect.any(Array), medium: expect.any(Array) });
  });

  it("returns nothing for a title with no identifiers or tags", async () => {
    expect(await findLinkCandidates({ title: "plain words", content: "" })).toEqual({ strong: [], medium: [] });
  });
});
