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
import { doCreatePage } from "../connectors/notion/tools.js";
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
}));
vi.mock("../connectors/repomap/embed.js", () => ({
  embedQuery: vi.fn(),
}));

const INDEX_QUERY_RE = /^\/databases\/.*\/query$/;

describe("Phase 2 semantic wiring in connectors/notion/tools.js", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("doCreatePage fuzzy dedup", () => {
    it("surfaces findSimilarPages results as possibleDuplicates on a successful, non-blocking basis", async () => {
      const { findSimilarPages } = await import("../connectors/notion/embed_client.js").then(() => import("../connectors/notion/embed_queries.js"));
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
});
