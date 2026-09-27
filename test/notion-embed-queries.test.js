// ---------------------------------------------------------------------------
// test/notion-embed-queries.test.js — unit tests for
// connectors/notion/embed_queries.js, the read-side of Phase 2's Notion
// semantic layer (reranking + fuzzy dedup).
// Covers:
//   - getEmbeddingsForPageIds: dedupes/filters input ids, parses pgvector rows
//     into a Map of {embedding, updatedAt}, empty-input short-circuit
//   - findSimilarPages: embeds the query text, passes maxDistance/limit through, empty-text short-circuit
//   - cosineDistance: identical/orthogonal/opposite vectors, degenerate zero-vector guard
//   - rerankByQuery: scores candidates with embeddings, carries updatedAt through, leaves unscored candidates in original order at the end
// Mocks connectors/repomap/db.js and connectors/repomap/embed.js, same
// pattern as test/repomap-queries.test.js (embed_queries.js reuses both
// directly rather than duplicating the read-only Neon connection or the
// Gemini query-embed call).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../connectors/repomap/db.js", () => ({
  query: vi.fn(),
}));
vi.mock("../connectors/repomap/embed.js", () => ({
  embedQuery: vi.fn(),
}));

describe("connectors/notion/embed_queries.js", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getEmbeddingsForPageIds", () => {
    it("returns an empty Map without querying when given no ids", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      const { getEmbeddingsForPageIds } = await import("../connectors/notion/embed_queries.js");

      const result = await getEmbeddingsForPageIds([]);

      expect(result).toEqual(new Map());
      expect(query).not.toHaveBeenCalled();
    });

    it("dedupes and filters falsy ids before querying, and parses pgvector rows into a Map of {embedding, updatedAt}", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      // pgvector.fromSql parses the Postgres vector text form '[1,2,3]'
      query.mockResolvedValueOnce({
        rows: [
          { page_id: "a", embedding: "[1,2,3]", updated_at: "2026-09-01T00:00:00.000Z" },
          { page_id: "b", embedding: "[4,5,6]", updated_at: "2026-09-02T00:00:00.000Z" },
        ],
      });

      const { getEmbeddingsForPageIds } = await import("../connectors/notion/embed_queries.js");
      const result = await getEmbeddingsForPageIds(["a", "a", null, "b", undefined]);

      expect(query.mock.calls[0][1]).toEqual([["a", "b"]]);
      expect(result.get("a")).toEqual({ embedding: [1, 2, 3], updatedAt: "2026-09-01T00:00:00.000Z" });
      expect(result.get("b")).toEqual({ embedding: [4, 5, 6], updatedAt: "2026-09-02T00:00:00.000Z" });
      expect(result.size).toBe(2);
    });

    it("omits ids with no row from the returned Map (never embedded)", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockResolvedValueOnce({ rows: [{ page_id: "a", embedding: "[1,1]" }] });

      const { getEmbeddingsForPageIds } = await import("../connectors/notion/embed_queries.js");
      const result = await getEmbeddingsForPageIds(["a", "never-embedded"]);

      expect(result.has("a")).toBe(true);
      expect(result.has("never-embedded")).toBe(false);
      expect(result.get("a").embedding).toEqual([1, 1]);
    });
  });

  describe("findSimilarPages", () => {
    it("returns [] immediately for empty text without embedding or querying", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      const { embedQuery } = await import("../connectors/repomap/embed.js");
      const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");

      const result = await findSimilarPages("");

      expect(result).toEqual([]);
      expect(embedQuery).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it("embeds the text and passes maxDistance/limit through to the query, returning pageId+distance pairs", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      const { embedQuery } = await import("../connectors/repomap/embed.js");
      embedQuery.mockResolvedValueOnce([0.1, 0.2]);
      query.mockResolvedValueOnce({
        rows: [
          { page_id: "dup-1", distance: 0.05 },
          { page_id: "dup-2", distance: 0.12 },
        ],
      });

      const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");
      const result = await findSimilarPages("Job Requirement: Liliana Model", { maxDistance: 0.2, limit: 5 });

      expect(embedQuery).toHaveBeenCalledWith("Job Requirement: Liliana Model");
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/FROM notion_page_embeddings/);
      expect(params[1]).toBe(0.2); // maxDistance
      expect(params[2]).toBe(5); // limit
      expect(result).toEqual([
        { pageId: "dup-1", distance: 0.05 },
        { pageId: "dup-2", distance: 0.12 },
      ]);
    });

    it("defaults to maxDistance 0.15 and limit 3 when not given", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      const { embedQuery } = await import("../connectors/repomap/embed.js");
      embedQuery.mockResolvedValueOnce([0.1]);
      query.mockResolvedValueOnce({ rows: [] });

      const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");
      await findSimilarPages("some text");

      const [, params] = query.mock.calls[0];
      expect(params[1]).toBe(0.15);
      expect(params[2]).toBe(3);
    });
  });

  describe("cosineDistance", () => {
    it("returns 0 for identical vectors", async () => {
      const { cosineDistance } = await import("../connectors/notion/embed_queries.js");
      expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 10);
    });

    it("returns 1 for orthogonal vectors", async () => {
      const { cosineDistance } = await import("../connectors/notion/embed_queries.js");
      expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
    });

    it("returns 2 for opposite vectors", async () => {
      const { cosineDistance } = await import("../connectors/notion/embed_queries.js");
      expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 10);
    });

    it("returns 2 (maximally dissimilar) for a degenerate zero-length vector instead of dividing by zero", async () => {
      const { cosineDistance } = await import("../connectors/notion/embed_queries.js");
      expect(cosineDistance([0, 0, 0], [1, 2, 3])).toBe(2);
      expect(Number.isNaN(cosineDistance([0, 0], [0, 0]))).toBe(false);
    });
  });

  describe("rerankByQuery", () => {
    it("returns the candidates array unchanged (same reference behavior) when empty", async () => {
      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      const result = await rerankByQuery("query", []);
      expect(result).toEqual([]);
    });

    it("orders scored candidates by ascending cosine distance, with unscored candidates after them in original order", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      const { embedQuery } = await import("../connectors/repomap/embed.js");
      // query embedding points along [1,0]
      embedQuery.mockResolvedValueOnce([1, 0]);
      // page "far" is orthogonal (distance 1), page "close" is identical (distance 0)
      query.mockResolvedValueOnce({
        rows: [
          { page_id: "far", embedding: "[0,1]" },
          { page_id: "close", embedding: "[1,0]" },
        ],
      });

      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      const candidates = [
        { pageId: "far", title: "Far page" },
        { pageId: "never-embedded", title: "Unembedded page" },
        { pageId: "close", title: "Close page" },
      ];

      const result = await rerankByQuery("some query", candidates);

      // "close" (distance 0) sorts before "far" (distance 1); unscored falls to the end.
      expect(result.map((c) => c.pageId)).toEqual(["close", "far", "never-embedded"]);
      expect(result[0].distance).toBeCloseTo(0, 10);
      expect(result[1].distance).toBeCloseTo(1, 10);
      expect(result[2].distance).toBeUndefined();
    });

    it("carries each scored candidate's stored updatedAt through onto the result (Finding #5.3 staleness check)", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      const { embedQuery } = await import("../connectors/repomap/embed.js");
      embedQuery.mockResolvedValueOnce([1, 0]);
      query.mockResolvedValueOnce({
        rows: [{ page_id: "p1", embedding: "[1,0]", updated_at: "2026-09-01T00:00:00.000Z" }],
      });

      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      const result = await rerankByQuery("q", [{ pageId: "p1" }]);

      expect(result[0].updatedAt).toBe("2026-09-01T00:00:00.000Z");
    });
  });
});
