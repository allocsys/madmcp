// ---------------------------------------------------------------------------
// test/notion-phase2-wiring.test.js — integration-style coverage for the
// Phase 2 semantic dedup/rerank call sites inside connectors/notion/tools.js
// (doCreatePage's fuzzy-dedup check, and notion_find's search-mode rerank).
// Unlike test/notion-embed-queries.test.js (which tests embed_queries.js's
// own logic in isolation), this file tests that tools.js WIRES those
// functions in correctly: calls them at the right point, handles their
// results/failures the right way, and doesn't let a failure there block the
// underlying create/search operation.
//
// Mocking strategy: mock connectors/notion/embed_client.js and
// connectors/notion/embed_queries.js directly (they're plain utility modules
// imported by tools.js from a DIFFERENT file, so vi.mock works normally here
// -- unlike client.js's intra-module-reference hazard described in
// test/notion-checkpoint.test.js's header comment, which doesn't apply to
// cross-module imports like this). notionRequest is mocked the same way
// notion-checkpoint.test.js does it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { doCreatePage, register } from "../connectors/notion/tools.js";
import * as client from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return { ...actual, notionRequest: mockedNotionRequest };
});

vi.mock("../connectors/notion/embed_client.js", () => ({
  triggerNotionEmbed: vi.fn(),
}));
vi.mock("../connectors/notion/embed_queries.js", () => ({
  findSimilarPages: vi.fn(),
  getEmbeddingsForPageIds: vi.fn(),
  cosineDistance: vi.fn(),
  rerankByQuery: vi.fn(),
}));
vi.mock("../connectors/repomap/embed.js", () => ({
  embedQuery: vi.fn(),
}));

const INDEX_QUERY_RE = /^\/databases\/.*\/query$/;

// Minimal fake MCP server: just captures the handler function for the
// registered tool name so tests can call it directly -- same pattern as
// test/repomap-tools.test.js's makeFakeServer().
function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("Phase 2 semantic wiring in connectors/notion/tools.js", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("doCreatePage fuzzy dedup", () => {
    it("surfaces findSimilarPages results as possibleDuplicates on a successful, non-blocking basis", async () => {
      const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");
      findSimilarPages.mockResolvedValueOnce([{ pageId: "dup-1", distance: 0.05 }]);

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        const method = opts.method || "GET";
        if (INDEX_QUERY_RE.test(path)) return { results: [] }; // no exact entity_id match
        if (path === "/search") return { results: [] }; // linking.js candidate search
        if (path === "/pages" && method === "POST") {
          if (opts.body?.parent?.database_id) return { id: "index-row" };
          return { id: "new-page", url: "https://notion.so/new-page" };
        }
        throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
      });

      const result = await doCreatePage({
        parent_id: "parent-1", parent_type: "page",
        title: "Job Requirement: Agentic AI Specialist - Liliana Model",
        content: "body text", entity_id: "job-req-liliana-model-2",
      });

      expect(result.skipped).toBe(false);
      expect(result.possibleDuplicates).toEqual([{ pageId: "dup-1", distance: 0.05 }]);
      expect(findSimilarPages).toHaveBeenCalledWith("Job Requirement: Agentic AI Specialist - Liliana Model\nbody text");
    });

    it("does not run the fuzzy-dedup check for one_off pages (no entity_id)", async () => {
      const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        const method = opts.method || "GET";
        if (path === "/search") return { results: [] };
        if (path === "/pages" && method === "POST") return { id: "new-page", url: "https://notion.so/new-page" };
        throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
      });

      const result = await doCreatePage({
        parent_id: "parent-1", parent_type: "page",
        title: "Scratch note", content: "disposable", one_off: true,
      });

      expect(result.skipped).toBe(false);
      expect(findSimilarPages).not.toHaveBeenCalled();
      expect(result.possibleDuplicates).toEqual([]);
    });

    it("does not block page creation when findSimilarPages throws (best-effort)", async () => {
      const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");
      findSimilarPages.mockRejectedValueOnce(new Error("Neon unreachable"));

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        const method = opts.method || "GET";
        if (INDEX_QUERY_RE.test(path)) return { results: [] };
        if (path === "/search") return { results: [] };
        if (path === "/pages" && method === "POST") {
          if (opts.body?.parent?.database_id) return { id: "index-row" };
          return { id: "new-page", url: "https://notion.so/new-page" };
        }
        throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
      });

      const result = await doCreatePage({
        parent_id: "parent-1", parent_type: "page",
        title: "Some tracked thing", content: "body", entity_id: "some-thing",
      });

      expect(result.skipped).toBe(false);
      expect(result.id).toBe("new-page");
      expect(result.possibleDuplicates).toEqual([]);
    });

    it("fires triggerNotionEmbed with the full title+content after a successful create", async () => {
      const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
      const { findSimilarPages } = await import("../connectors/notion/embed_queries.js");
      findSimilarPages.mockResolvedValueOnce([]);

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        const method = opts.method || "GET";
        if (INDEX_QUERY_RE.test(path)) return { results: [] };
        if (path === "/search") return { results: [] };
        if (path === "/pages" && method === "POST") {
          if (opts.body?.parent?.database_id) return { id: "index-row" };
          return { id: "page-99", url: "https://notion.so/page-99" };
        }
        throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
      });

      await doCreatePage({
        parent_id: "parent-1", parent_type: "page",
        title: "New tracked page", content: "body content", entity_id: "new-tracked-page",
      });

      expect(triggerNotionEmbed).toHaveBeenCalledWith({ page_id: "page-99", content: "New tracked page\nbody content" });
    });
  });

  describe("notion_find search-mode semantic rerank", () => {
    let notionFind;

    beforeEach(() => {
      const server = makeFakeServer();
      register(server);
      notionFind = server.tools["notion_find"];
    });

    it("reorders page results by ascending cosine distance to the query when embeddings exist for all page candidates", async () => {
      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");

      // tools.js delegates the scored/unscored split entirely to
      // rerankByQuery now (fix #4) -- simulate it having found embeddings for
      // both candidates and reordering them by ascending distance, the same
      // shape the real embed_queries.js implementation returns (original
      // candidate fields spread, plus a `distance` field on scored entries).
      rerankByQuery.mockImplementationOnce(async (_query, candidates) => {
        const withDistance = candidates.map((c) => ({ ...c, distance: c.pageId === "close-page" ? 0 : 1 }));
        return withDistance.sort((a, b) => a.distance - b.distance);
      });

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        if (path === "/search" && (opts.method || "GET") === "POST") {
          return {
            results: [
              { object: "page", id: "far-page", url: "https://notion.so/far-page", properties: { title: { type: "title", title: [{ plain_text: "Far Page" }] } } },
              { object: "page", id: "close-page", url: "https://notion.so/close-page", properties: { title: { type: "title", title: [{ plain_text: "Close Page" }] } } },
            ],
          };
        }
        throw new Error(`Unexpected notionRequest call: ${opts.method || "GET"} ${path}`);
      });

      const result = await notionFind({ mode: "search", query: "close match" });

      const text = result.content[0].text;
      // "Close Page" (distance 0) should be listed before "Far Page" (distance 1).
      expect(text.indexOf("Close Page")).toBeLessThan(text.indexOf("Far Page"));
      expect(rerankByQuery).toHaveBeenCalledWith("close match", [
        { pageId: "far-page", result: expect.objectContaining({ id: "far-page" }) },
        { pageId: "close-page", result: expect.objectContaining({ id: "close-page" }) },
      ]);
      expect(triggerNotionEmbed).not.toHaveBeenCalled(); // both candidates already had embeddings (distance defined on both)
    });

    it("falls back to Notion's original keyword order when no candidates have embeddings yet, and lazily backfills full title+content for each (Finding #5.1)", async () => {
      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
      // Nothing embedded yet -- real rerankByQuery leaves every candidate
      // unscored (no `distance` field) and keeps original order in that case.
      rerankByQuery.mockImplementationOnce(async (_query, candidates) => candidates);

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        const method = opts.method || "GET";
        if (path === "/search" && method === "POST") {
          return {
            results: [
              { object: "page", id: "page-a", url: "https://notion.so/page-a", properties: { title: { type: "title", title: [{ plain_text: "Page A" }] } } },
              { object: "page", id: "page-b", url: "https://notion.so/page-b", properties: { title: { type: "title", title: [{ plain_text: "Page B" }] } } },
            ],
          };
        }
        // Backfill now re-reads each unscored page (Fix #5.1) instead of
        // embedding just the title -- simulate those re-reads so we can
        // prove full title+content reaches triggerNotionEmbed.

        if (path === "/pages/page-a") return { id: "page-a", properties: { title: { type: "title", title: [{ plain_text: "Page A" }] } } };
        if (path === "/pages/page-b") return { id: "page-b", properties: { title: { type: "title", title: [{ plain_text: "Page B" }] } } };
        if (path.startsWith("/blocks/page-a/children")) return { results: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body A" }] } }] };
        if (path.startsWith("/blocks/page-b/children")) return { results: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body B" }] } }] };
        throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
      });

      const result = await notionFind({ mode: "search", query: "anything" });

      const text = result.content[0].text;
      expect(text.indexOf("Page A")).toBeLessThan(text.indexOf("Page B"));
      // Backfill is fire-and-forget, so wait for it to land.
      await vi.waitFor(() => {
        expect(triggerNotionEmbed).toHaveBeenCalledWith({ page_id: "page-a", content: "Page A\nBody A" });
        expect(triggerNotionEmbed).toHaveBeenCalledWith({ page_id: "page-b", content: "Page B\nBody B" });
      });
    });

    it("re-embeds a page whose Notion last_edited_time is newer than its stored embedding updatedAt (Finding #5.3, out-of-band UI edit)", async () => {
      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
      // Scored, but the embedding predates last_edited_time -- simulates a
      // direct Notion UI edit that skipped doUpdatePage/triggerEmbedForPage.
      rerankByQuery.mockImplementationOnce(async (_query, candidates) =>
        candidates.map((c) => ({ ...c, distance: 0.5, updatedAt: "2026-09-01T00:00:00.000Z" }))
      );

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        const method = opts.method || "GET";
        if (path === "/search" && method === "POST") {
          return {
            results: [
              { object: "page", id: "stale-page", url: "https://notion.so/stale-page", last_edited_time: "2026-09-27T00:00:00.000Z", properties: { title: { type: "title", title: [{ plain_text: "Stale Page" }] } } },
            ],
          };
        }
        if (path === "/pages/stale-page") return { id: "stale-page", properties: { title: { type: "title", title: [{ plain_text: "Stale Page" }] } } };
        if (path.startsWith("/blocks/stale-page/children")) return { results: [] };
        throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
      });

      await notionFind({ mode: "search", query: "anything" });

      await vi.waitFor(() => {
        expect(triggerNotionEmbed).toHaveBeenCalledWith({ page_id: "stale-page", content: "Stale Page" });
      });
    });

    it("does NOT re-embed a scored page whose embedding is already newer than (or equal to) its last_edited_time", async () => {
      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      const { triggerNotionEmbed } = await import("../connectors/notion/embed_client.js");
      rerankByQuery.mockImplementationOnce(async (_query, candidates) =>
        candidates.map((c) => ({ ...c, distance: 0.5, updatedAt: "2026-09-27T00:00:00.000Z" }))
      );

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        const method = opts.method || "GET";
        if (path === "/search" && method === "POST") {
          return {
            results: [
              { object: "page", id: "fresh-page", url: "https://notion.so/fresh-page", last_edited_time: "2026-09-01T00:00:00.000Z", properties: { title: { type: "title", title: [{ plain_text: "Fresh Page" }] } } },
            ],
          };
        }
        throw new Error(`Unexpected notionRequest call: ${method} ${path}`);
      });

      await notionFind({ mode: "search", query: "anything" });

      await new Promise((r) => setTimeout(r, 0)); // let any wrongly-fired backfill happen first
      expect(triggerNotionEmbed).not.toHaveBeenCalled();
    });

    it("falls back to Notion's original order (rather than erroring) when the rerank step throws", async () => {
      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");
      rerankByQuery.mockRejectedValueOnce(new Error("Neon unreachable"));

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        if (path === "/search" && (opts.method || "GET") === "POST") {
          return {
            results: [
              { object: "page", id: "page-a", url: "https://notion.so/page-a", properties: { title: { type: "title", title: [{ plain_text: "Page A" }] } } },
            ],
          };
        }
        throw new Error(`Unexpected notionRequest call: ${opts.method || "GET"} ${path}`);
      });

      const result = await notionFind({ mode: "search", query: "anything" });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Page A");
    });

    it("does not attempt to rerank for mode: recent (no query, not a semantic-search request)", async () => {
      const { rerankByQuery } = await import("../connectors/notion/embed_queries.js");

      client.notionRequest.mockImplementation(async (path, opts = {}) => {
        if (path === "/search" && (opts.method || "GET") === "POST") {
          return {
            results: [
              { object: "page", id: "page-a", url: "https://notion.so/page-a", last_edited_time: "2026-09-27T00:00:00.000Z", properties: { title: { type: "title", title: [{ plain_text: "Page A" }] } } },
            ],
          };
        }
        throw new Error(`Unexpected notionRequest call: ${opts.method || "GET"} ${path}`);
      });

      const result = await notionFind({ mode: "recent" });

      expect(result.content[0].text).toContain("Page A");
      expect(rerankByQuery).not.toHaveBeenCalled();
    });
  });
});
