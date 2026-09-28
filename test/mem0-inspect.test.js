import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/mem/client.js", () => ({
  mem0Request: vi.fn(),
}));

import { mem0Request } from "../connectors/mem/client.js";
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

describe("Mem0 connector - consolidated mem0_inspect (get/history/relations)", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerMem0(server);
  });

  it("registers mem0_inspect once and no longer registers the old read-by-id tools", () => {
    expect(server.names.filter((n) => n === "mem0_inspect")).toHaveLength(1);
    for (const old of ["mem0_get", "mem0_get_history", "mem0_get_relations"]) {
      expect(server.names).not.toContain(old);
    }
    for (const n of ["mem0_find", "mem0_add", "mem0_add_batch", "mem0_update", "mem0_delete"]) {
      expect(server.names).toContain(n);
    }
  });

  describe("action 'get'", () => {
    it("requires memory_id", async () => {
      const result = await server.tools.mem0_inspect({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires memory_id");
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("formats a memory with categories, tags, status and metadata", async () => {
      const metadata = { tags: ["a", "b"], status: "open" };
      mem0Request.mockResolvedValueOnce({
        id: "m1",
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
        memory: "hello",
        categories: ["c1"],
        metadata,
      });
      const result = await server.tools.mem0_inspect({ action: "get", memory_id: "m1" });
      expect(mem0Request).toHaveBeenCalledTimes(1);
      expect(mem0Request).toHaveBeenCalledWith("/v1/memories/m1/");
      expect(result.content[0].text).toBe(
        "ID: m1\n" +
        "Created: 2026-01-02 | Updated: 2026-01-03\nCategories: c1\nTags: a, b\nStatus: open\n\n" +
        "hello" +
        `\n\nMetadata:\n${JSON.stringify(metadata, null, 2)}`
      );
    });

    it("handles a memory with no content or dates", async () => {
      mem0Request.mockResolvedValueOnce({ id: "m2" });
      const result = await server.tools.mem0_inspect({ action: "get", memory_id: "m2" });
      expect(result.content[0].text).toBe("ID: m2\nCreated: unknown | Updated: unknown\n\n(no content)");
    });

    it("appends related entities when the memory has an entity_id", async () => {
      const m1 = {
        id: "m1",
        memory: "content",
        user_id: "u",
        metadata: { entity_id: "e1", relations: [{ to_entity_id: "e2", relation: "blocks", resolved_at_write: true }] },
      };
      mem0Request.mockImplementation(async (path) => {
        if (path === "/v1/memories/m1/") return m1;
        if (path === "/v3/memories/") return { results: [m1] };
        throw new Error(`unexpected path ${path}`);
      });
      const result = await server.tools.mem0_inspect({ action: "get", memory_id: "m1" });
      const text = result.content[0].text;
      expect(text).toContain("Entity ID: e1");
      expect(text).toContain("Related entities (up to 3 hops):\n  [hop 1] blocks → e2 (deleted)");
    });

    it("lets API errors throw", async () => {
      mem0Request.mockRejectedValueOnce(new Error("404 not found"));
      await expect(server.tools.mem0_inspect({ action: "get", memory_id: "nope" })).rejects.toThrow("404 not found");
    });
  });

  describe("action 'history'", () => {
    it("requires memory_id", async () => {
      const result = await server.tools.mem0_inspect({ action: "history" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires memory_id");
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("reports when there is no history", async () => {
      mem0Request.mockResolvedValueOnce([]);
      const result = await server.tools.mem0_inspect({ action: "history", memory_id: "m1" });
      expect(mem0Request).toHaveBeenCalledWith("/v1/memories/m1/history/");
      expect(result.content[0].text).toBe("No history found for this memory.");
    });

    it("formats events with old/new values (results array shape)", async () => {
      mem0Request.mockResolvedValueOnce({
        results: [
          { created_at: "2026-02-01T10:00:00Z", event: "ADD", new_memory: "first" },
          { created_at: "2026-02-02T10:00:00Z", event: "UPDATE", old_memory: "first", new_memory: "second" },
          { event: "DELETE" },
        ],
      });
      const result = await server.tools.mem0_inspect({ action: "history", memory_id: "m1" });
      expect(result.content[0].text).toBe(
        "2026-02-01 [ADD] | (none) → first\n2026-02-02 [UPDATE] | first → second\n? [DELETE]"
      );
    });

    it("supports prev_value/new_value and truncates long values at 70 chars", async () => {
      const long = "x".repeat(80);
      mem0Request.mockResolvedValueOnce({
        history: [{ updated_at: "2026-03-01", action: "UPDATE", prev_value: long, new_value: "short" }],
      });
      const result = await server.tools.mem0_inspect({ action: "history", memory_id: "m1" });
      expect(result.content[0].text).toBe(`2026-03-01 [UPDATE] | ${"x".repeat(70)}… → short`);
    });
  });

  describe("action 'relations'", () => {
    it("requires entity_id", async () => {
      const result = await server.tools.mem0_inspect({ action: "relations" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires entity_id");
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("reports when the entity does not exist and has no relations", async () => {
      mem0Request.mockImplementation(async (path) => {
        if (path === "/v3/memories/") return { results: [] };
        throw new Error(`unexpected path ${path}`);
      });
      const result = await server.tools.mem0_inspect({ action: "relations", entity_id: "ghost" });
      expect(result.content[0].text).toBe('No entity found with entity_id "ghost" and no relations recorded.');
    });

    it("shows the entity header and 'No relations found' for an isolated entity", async () => {
      const solo = { id: "m9", memory: "solo content", metadata: { entity_id: "solo" } };
      mem0Request.mockImplementation(async (path) => {
        if (path === "/v3/memories/") return { results: [solo] };
        if (path === "/v1/memories/m9/") return solo;
        throw new Error(`unexpected path ${path}`);
      });
      const result = await server.tools.mem0_inspect({ action: "relations", entity_id: "solo" });
      expect(result.content[0].text).toBe(
        "Entity: solo (memory ID: m9)\nContent preview: solo content\n\nNo relations found (up to 3 hops)."
      );
    });

    it("renders outgoing relations with their resolution status", async () => {
      const a = {
        id: "ma",
        memory: "a",
        metadata: { entity_id: "a", relations: [{ to_entity_id: "b", relation: "depends_on", resolved_at_write: false }] },
      };
      mem0Request.mockImplementation(async (path) => {
        if (path === "/v3/memories/") return { results: [a] };
        if (path === "/v1/memories/ma/") return a;
        throw new Error(`unexpected path ${path}`);
      });
      const result = await server.tools.mem0_inspect({ action: "relations", entity_id: "a" });
      expect(result.content[0].text).toBe(
        "Entity: a (memory ID: ma)\nContent preview: a\n\n" +
        "Related entities (up to 3 hops):\n  [hop 1] depends_on → b (not found)"
      );
    });
  });
});
