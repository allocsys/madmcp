import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/mem/client.js", () => ({
  mem0Request: vi.fn(),
}));

import { mem0Request } from "../connectors/mem/client.js";
import { MEM0_USER_ID } from "../config.js";
import { register as registerMem0 } from "../connectors/mem/tools.js";

function makeFakeServer() {
  const tools = {};
  const names = [];
  return {
    tool: (name, _description, _schema, handler) => {
      names.push(name);
      tools[name] = handler;
    },
    tools,
    names,
  };
}

describe("Mem0 connector - consolidated mem0_find (list/search)", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerMem0(server);
  });

  it("registers mem0_find once and no longer registers mem0_list / mem0_search", () => {
    expect(server.names.filter((n) => n === "mem0_find")).toHaveLength(1);
    expect(server.names).not.toContain("mem0_list");
    expect(server.names).not.toContain("mem0_search");
    for (const n of ["mem0_inspect", "mem0_write", "mem0_delete"]) {
      expect(server.names).toContain(n);
    }
  });

  describe("action 'list'", () => {
    it("sends the default request (page 1, over-fetch 2x, user scope only)", async () => {
      mem0Request.mockResolvedValueOnce({ results: [] });
      const result = await server.tools.mem0_find({ action: "list" });
      expect(mem0Request).toHaveBeenCalledWith("/v3/memories/", {
        method: "POST",
        body: { filters: { user_id: MEM0_USER_ID }, page: 1, page_size: 40 },
      });
      expect(result.content[0].text).toBe("No memories found.");
    });

    it("over-fetches limit+20 for small limits and passes page + a metadata-augmented fields projection", async () => {
      mem0Request.mockResolvedValueOnce({ results: [] });
      await server.tools.mem0_find({ action: "list", limit: 5, page: 3, fields: ["id", "memory"], user_id: "u1" });
      expect(mem0Request).toHaveBeenCalledWith("/v3/memories/", {
        method: "POST",
        body: { filters: { user_id: "u1" }, page: 3, page_size: 25, fields: ["id", "memory", "metadata"] },
      });
    });

    it("formats compact lines with tags, entity_id, status and duplicate flag", async () => {
      mem0Request.mockResolvedValueOnce({
        results: [
          {
            id: "m1",
            created_at: "2026-01-02T00:00:00Z",
            memory: "hello",
            metadata: { tags: ["a"], entity_id: "e1", status: "open", possible_duplicate_of: ["x"] },
          },
          { id: "m2", memory: "y".repeat(100) },
        ],
      });
      const result = await server.tools.mem0_find({ action: "list" });
      expect(result.content[0].text).toBe(
        `m1 | 2026-01-02 [a] {e1} (open) ⚠dup | hello\nm2 | ? | ${"y".repeat(90)}…`
      );
    });

    it("hides superseded memories by default but keeps ones with no status", async () => {
      mem0Request.mockResolvedValue({
        results: [
          { id: "a", memory: "no status" },
          { id: "b", memory: "old", metadata: { status: "superseded" } },
          { id: "c", memory: "open one", metadata: { status: "open" } },
        ],
      });
      const byDefault = await server.tools.mem0_find({ action: "list" });
      expect(byDefault.content[0].text.split("\n").map((l) => l.split(" | ")[0])).toEqual(["a", "c"]);

      const superseded = await server.tools.mem0_find({ action: "list", status_filter: ["superseded"] });
      expect(superseded.content[0].text.split("\n").map((l) => l.split(" | ")[0])).toEqual(["b"]);
    });

    it("filters by tag overlap and flagged duplicates, then applies limit", async () => {
      mem0Request.mockResolvedValue({
        results: [
          { id: "a", memory: "1", metadata: { tags: ["x"] } },
          { id: "b", memory: "2", metadata: { tags: ["y"], possible_duplicate_of: ["a"] } },
          { id: "c", memory: "3", metadata: { tags: ["x"], possible_duplicate_of: ["a"] } },
          { id: "d", memory: "4", metadata: { tags: ["x"], possible_duplicate_of: ["a"] } },
        ],
      });
      const tagged = await server.tools.mem0_find({ action: "list", categories: ["x"], limit: 2 });
      expect(tagged.content[0].text.split("\n").map((l) => l.split(" | ")[0])).toEqual(["a", "c"]);

      const flagged = await server.tools.mem0_find({ action: "list", flagged_duplicates_only: true });
      expect(flagged.content[0].text.split("\n").map((l) => l.split(" | ")[0])).toEqual(["b", "c", "d"]);
    });

    it("appends related entities when include_relations is set", async () => {
      const m1 = {
        id: "m1",
        memory: "content",
        metadata: { entity_id: "e1", relations: [{ to_entity_id: "e2", relation: "blocks", resolved_at_write: true }] },
      };
      mem0Request.mockImplementation(async (path) => {
        if (path === "/v3/memories/") return { results: [m1] };
        if (path === "/v1/memories/m1/") return m1;
        throw new Error(`unexpected path ${path}`);
      });
      const result = await server.tools.mem0_find({ action: "list", include_relations: true });
      expect(result.content[0].text).toBe(
        "m1 | ? {e1} | content\nRelated entities (up to 3 hops):\n  [hop 1] blocks → e2 (deleted)"
      );
    });

    it("lets API errors throw", async () => {
      mem0Request.mockRejectedValueOnce(new Error("500 boom"));
      await expect(server.tools.mem0_find({ action: "list" })).rejects.toThrow("500 boom");
    });
  });

  describe("action 'search'", () => {
    it("requires query", async () => {
      const result = await server.tools.mem0_find({ action: "search" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires query");
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("sends the default request (rerank on, threshold 0.35, top_k 3x)", async () => {
      mem0Request.mockResolvedValueOnce({ results: [] });
      const result = await server.tools.mem0_find({ action: "search", query: "auth flow" });
      expect(mem0Request).toHaveBeenCalledWith("/v3/memories/search/", {
        method: "POST",
        body: { query: "auth flow", filters: { user_id: MEM0_USER_ID }, top_k: 60, rerank: true, threshold: 0.35 },
      });
      expect(result.content[0].text).toBe("No memories found matching your query.");
    });

    it("scopes by agent_id/run_id and honours rerank:false, threshold:0 and small-limit over-fetch", async () => {
      mem0Request.mockResolvedValueOnce({ results: [] });
      await server.tools.mem0_find({
        action: "search",
        query: "q",
        user_id: "u1",
        agent_id: "a1",
        run_id: "r1",
        limit: 5,
        rerank: false,
        threshold: 0,
      });
      expect(mem0Request).toHaveBeenCalledWith("/v3/memories/search/", {
        method: "POST",
        body: { query: "q", filters: { user_id: "u1", agent_id: "a1", run_id: "r1" }, top_k: 25 },
      });
    });

    it("shows scores, hides superseded by default, filters tags and applies limit", async () => {
      mem0Request.mockResolvedValue({
        results: [
          { id: "m1", created_at: "2026-01-02T00:00:00Z", score: 0.874, memory: "hi", metadata: { tags: ["x"] } },
          { id: "m2", score: 0.8, memory: "old", metadata: { tags: ["x"], status: "superseded" } },
          { id: "m3", score: 0.7, memory: "other", metadata: { tags: ["y"] } },
          { id: "m4", score: 0.6, memory: "last", metadata: { tags: ["x"] } },
        ],
      });
      const all = await server.tools.mem0_find({ action: "search", query: "q", limit: 2 });
      expect(all.content[0].text).toBe("m1 | 2026-01-02 [x] (0.87) | hi\nm3 | ? [y] (0.70) | other");

      const tagged = await server.tools.mem0_find({ action: "search", query: "q", categories: ["x"] });
      expect(tagged.content[0].text.split("\n").map((l) => l.split(" | ")[0])).toEqual(["m1", "m4"]);
    });

    it("accepts a bare array response", async () => {
      mem0Request.mockResolvedValueOnce([{ id: "m1", score: 0.5, memory: "x" }]);
      const result = await server.tools.mem0_find({ action: "search", query: "q" });
      expect(result.content[0].text).toBe("m1 | ? (0.50) | x");
    });
  });
});
