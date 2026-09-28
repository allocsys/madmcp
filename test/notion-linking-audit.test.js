// ---------------------------------------------------------------------------
// test/notion-linking-audit.test.js -- coverage for the 2026-09-28 audit fixes
// in connectors/notion/linking.js (PR #245):
//   A5  bodyMentionsId matches whole identifiers only (repo#24 != repo#244,
//       repo#24 != myrepo#24)
//   A6  findTagOverlapCandidates applies the 7-day window BEFORE limiting to
//       8 candidates (bounded by a 24-page-read attempt cap)
//
// Mocking strategy: only the I/O boundary (notionRequest, queryAllIndexEntries)
// is mocked; the real scoring / candidate logic runs.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { notionRequest, queryAllIndexEntries } from "../connectors/notion/client.js";
import { scoreCandidate, findTagOverlapCandidates } from "../connectors/notion/linking.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, notionRequest: vi.fn(), queryAllIndexEntries: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
});

const NOW = "2026-09-28T12:00:00.000Z";
const FRESH = "2026-09-27T12:00:00.000Z"; // 1 day before NOW  -> inside the 7-day window
const STALE = "2026-01-01T00:00:00.000Z"; // months before NOW -> outside it

describe("A5: cross-reference matching uses whole identifiers", () => {
  // Titles share no tokens, and tags are empty, so only Signals 1/2 can fire.
  const base = { title: "Alpha rollout", content: "Tracking repo#24", tags: new Set(), createdAt: NOW };
  const cand = (content) => ({ title: "Zebra migration", content, createdAt: FRESH });

  it("repo#24 does NOT match a body that only mentions repo-244", () => {
    const result = scoreCandidate(base, cand("Related to repo-244"));
    expect(result.tier).toBeNull();
  });

  it("repo#24 does NOT match a body that only mentions repo#244", () => {
    const result = scoreCandidate(base, cand("Related to repo#244"));
    expect(result.tier).toBeNull();
  });

  it("repo#24 does NOT match myrepo#24 (repo name must not be a suffix of a longer name)", () => {
    const result = scoreCandidate(base, cand("Related to myrepo#24"));
    expect(result.tier).toBeNull();
  });

  it("repo#24 DOES match the short dash form repo-24 in the candidate body (strong)", () => {
    const result = scoreCandidate(base, cand("Duplicate of repo-24"));
    expect(result.tier).toBe("strong");
    expect(result.reason).toBe("candidate body references repo#24");
  });

  it("still matches when the reference is wrapped in punctuation", () => {
    expect(scoreCandidate(base, cand("(see repo-24)")).tier).toBe("strong");
    expect(scoreCandidate(base, cand("see repo-24, thanks")).tier).toBe("strong");
    expect(scoreCandidate(base, cand("see repo-24.")).tier).toBe("strong");
  });

  it("adjacent numbers in the same repo are still strong via the identifier-overlap signal", () => {
    const result = scoreCandidate(base, cand("Also repo#25"));
    expect(result.tier).toBe("strong");
    expect(result.reason).toContain("identifier overlap");
  });

  it("different repos with the same number are not linked", () => {
    const result = scoreCandidate(base, cand("Also other#24"));
    expect(result.tier).toBeNull();
  });
});

describe("A6: findTagOverlapCandidates windows before it limits", () => {
  const tags = new Set(["a", "b"]);
  const entry = (n, entryTags = ["a", "b"]) => ({
    entity_id: `e${n}`,
    page_id: `p${n}`,
    url: `https://notion.so/p${n}`,
    tags: entryTags,
  });
  const pageFor = (id, created_time) => ({
    id,
    url: `https://notion.so/${id}`,
    created_time,
    properties: { title: { type: "title", title: [{ plain_text: `Page ${id}` }] } },
  });
  // notionRequest impl: pages whose number is in `freshNumbers` are fresh, all others stale.
  const pagesWhere = (isFresh) => async (path) => {
    const m = /^\/pages\/p(\d+)$/.exec(path);
    if (!m) throw new Error(`Unexpected notionRequest call: ${path}`);
    return pageFor(`p${m[1]}`, isFresh(Number(m[1])) ? FRESH : STALE);
  };

  it("finds a fresh candidate that sits behind 8 stale ones (the old slice-then-filter bug)", async () => {
    queryAllIndexEntries.mockResolvedValue(Array.from({ length: 9 }, (_, i) => entry(i + 1)));
    notionRequest.mockImplementation(pagesWhere((n) => n === 9));

    const result = await findTagOverlapCandidates({ tags, createdAt: NOW });

    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe("p9");
    expect(result[0].entity_id).toBe("e9");
    expect(result[0].reason).toContain("shared tags [a, b]");
    expect(notionRequest).toHaveBeenCalledTimes(9);
  });

  it("stops once 8 candidates have passed the window", async () => {
    queryAllIndexEntries.mockResolvedValue(Array.from({ length: 12 }, (_, i) => entry(i + 1)));
    notionRequest.mockImplementation(pagesWhere(() => true));

    const result = await findTagOverlapCandidates({ tags, createdAt: NOW });

    expect(result.map((c) => c.pageId)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    expect(notionRequest).toHaveBeenCalledTimes(8);
  });

  it("caps page reads at 24 attempts when nothing passes the window", async () => {
    queryAllIndexEntries.mockResolvedValue(Array.from({ length: 40 }, (_, i) => entry(i + 1)));
    notionRequest.mockImplementation(pagesWhere(() => false));

    const result = await findTagOverlapCandidates({ tags, createdAt: NOW });

    expect(result).toEqual([]);
    expect(notionRequest).toHaveBeenCalledTimes(24);
  });

  it("skips index entries whose page can't be read and keeps looking", async () => {
    queryAllIndexEntries.mockResolvedValue([entry(1), entry(2)]);
    notionRequest.mockImplementation(async (path) => {
      if (path === "/pages/p1") throw new Error("Notion API error (404): gone");
      return pageFor("p2", FRESH);
    });

    const result = await findTagOverlapCandidates({ tags, createdAt: NOW });

    expect(result.map((c) => c.pageId)).toEqual(["p2"]);
  });

  it("requires at least 2 shared tags before reading any page", async () => {
    queryAllIndexEntries.mockResolvedValue([entry(1, ["a"]), entry(2, ["a", "c"]), entry(3, [])]);

    const result = await findTagOverlapCandidates({ tags, createdAt: NOW });

    expect(result).toEqual([]);
    expect(notionRequest).not.toHaveBeenCalled();
  });

  it("returns [] without touching the index when the new page has no tags", async () => {
    const result = await findTagOverlapCandidates({ tags: new Set(), createdAt: NOW });

    expect(result).toEqual([]);
    expect(queryAllIndexEntries).not.toHaveBeenCalled();
  });

  it("returns [] (best-effort) when the index can't be read", async () => {
    queryAllIndexEntries.mockRejectedValue(new Error("Notion API error (500): boom"));

    expect(await findTagOverlapCandidates({ tags, createdAt: NOW })).toEqual([]);
  });

  it("applies no window filter when createdAt is not given", async () => {
    queryAllIndexEntries.mockResolvedValue([entry(1)]);
    notionRequest.mockImplementation(pagesWhere(() => false));

    const result = await findTagOverlapCandidates({ tags });

    expect(result.map((c) => c.pageId)).toEqual(["p1"]);
  });
});
