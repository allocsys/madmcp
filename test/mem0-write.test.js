import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// verifyLanded waits 3s before its single check, so any add path that reaches
// it needs the fake timers flushed while the handler promise is pending.
async function run(promiseFn) {
  const p = promiseFn();
  await vi.runAllTimersAsync();
  return p;
}

describe("Mem0 connector - write tools (add / add_batch / update)", () => {
  let server;
  // Thin wrappers so the consolidation retargets only these three lines.
  const addMemory = (args) => server.tools.mem0_add(args);
  const addBatch = (args) => server.tools.mem0_add_batch(args);
  const updateMemory = (args) => server.tools.mem0_update(args);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    server = makeFakeServer();
    registerMem0(server);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the write tools", () => {
    for (const n of ["mem0_add", "mem0_add_batch", "mem0_update"]) {
      expect(server.names.filter((x) => x === n)).toHaveLength(1);
    }
  });

  describe("add", () => {
    it("sends the default add request then verifies with a single list call", async () => {
      mem0Request
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [{ id: "m1", memory: "hello" }] });
      const result = await run(() => addMemory({ content: "hello", skip_duplicate_check: true }));
      expect(mem0Request).toHaveBeenCalledTimes(2);
      expect(mem0Request).toHaveBeenNthCalledWith(1, "/v3/memories/add/", {
        method: "POST",
        body: { messages: [{ role: "user", content: "hello" }], user_id: MEM0_USER_ID, infer: false },
      });
      expect(mem0Request).toHaveBeenNthCalledWith(2, "/v3/memories/", {
        method: "POST",
        body: { filters: { user_id: MEM0_USER_ID }, page: 1, page_size: 20 },
      });
      expect(result.content[0].text).toBe("Memory extraction started (event_id: ev1). Confirmed landed (id: m1).");
    });

    it("passes scope, infer and composes metadata from categories/entity_id/status/metadata", async () => {
      mem0Request
        .mockResolvedValueOnce({ results: [] }) // findByEntityId
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [{ id: "m1", metadata: { entity_id: "e1" } }] });
      const result = await run(() =>
        addMemory({
          content: "c",
          user_id: "u1",
          agent_id: "a1",
          run_id: "r1",
          categories: ["t1", "t2"],
          entity_id: "e1",
          status: "open",
          metadata: { project: "p" },
          infer: true,
          skip_duplicate_check: true,
        })
      );
      expect(mem0Request).toHaveBeenNthCalledWith(1, "/v3/memories/", {
        method: "POST",
        body: { filters: { user_id: "u1", agent_id: "a1", run_id: "r1" }, page: 1, page_size: 100 },
      });
      expect(mem0Request).toHaveBeenNthCalledWith(2, "/v3/memories/add/", {
        method: "POST",
        body: {
          messages: [{ role: "user", content: "c" }],
          user_id: "u1",
          infer: true,
          agent_id: "a1",
          run_id: "r1",
          metadata: { project: "p", tags: ["t1", "t2"], entity_id: "e1", status: "open" },
        },
      });
      expect(mem0Request).toHaveBeenNthCalledWith(3, "/v3/memories/", {
        method: "POST",
        body: { filters: { user_id: "u1", agent_id: "a1", run_id: "r1" }, page: 1, page_size: 20 },
      });
      expect(result.content[0].text).toContain("Confirmed landed (id: m1).");
    });

    it("refuses to add when the entity_id already exists and returns the existing content", async () => {
      mem0Request
        .mockResolvedValueOnce({ results: [{ id: "m9", metadata: { entity_id: "bug-4" } }] })
        .mockResolvedValueOnce({ id: "m9", memory: "existing text", metadata: { entity_id: "bug-4" } });
      const result = await run(() => addMemory({ content: "new text", entity_id: "bug-4" }));
      expect(mem0Request).toHaveBeenCalledTimes(2);
      expect(mem0Request).toHaveBeenNthCalledWith(2, "/v1/memories/m9/");
      const text = result.content[0].text;
      expect(result.isError).toBeUndefined();
      expect(text).toContain('Not adding — a memory already exists for entity_id "bug-4" (id: m9). No duplicate was created.');
      expect(text).toContain("Existing content:\nexisting text");
      expect(text).toContain("New content you were about to add:\nnew text");
      expect(text).toContain('memory_id="m9"');
    });

    it("reports unconfirmed landing when the verify check finds nothing", async () => {
      mem0Request
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [] });
      const result = await run(() => addMemory({ content: "hello", skip_duplicate_check: true }));
      const text = result.content[0].text;
      expect(text).toContain("Memory extraction started (event_id: ev1).");
      expect(text).toContain("Could not confirm this memory landed after several verification attempts");
      expect(text).not.toContain("Confirmed landed");
    });

    it("falls back to 'Memory added: <json>' when the API returns no event id", async () => {
      mem0Request
        .mockResolvedValueOnce({ status: "ok" })
        .mockResolvedValueOnce({ results: [] });
      const result = await run(() => addMemory({ content: "hello", skip_duplicate_check: true }));
      expect(result.content[0].text.startsWith('Memory added: {"status":"ok"}')).toBe(true);
    });

    it("hard-blocks near-identical content (score >= 0.92) without adding", async () => {
      mem0Request.mockResolvedValueOnce({ results: [{ id: "s1", memory: "existing text", score: 0.95 }] });
      const result = await run(() => addMemory({ content: "hello" }));
      expect(mem0Request).toHaveBeenCalledTimes(1);
      expect(mem0Request).toHaveBeenCalledWith("/v3/memories/search/", {
        method: "POST",
        body: { query: "hello", filters: { user_id: MEM0_USER_ID }, top_k: 3, rerank: true },
      });
      const text = result.content[0].text;
      expect(text).toContain("Not adding — content is near-identical (score 0.95 >= 0.92) to existing memory s1.");
      expect(text).toContain("Existing content:\nexisting text");
      expect(text).toContain("New content you were about to add:\nhello");
      expect(text).toContain("skip_duplicate_check:true");
    });

    it("flags (but still adds) candidates between the threshold and the blocking score", async () => {
      mem0Request
        .mockResolvedValueOnce({ results: [{ id: "s1", memory: "existing text", score: 0.8 }] })
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [{ id: "m1", memory: "hello" }] });
      const result = await run(() => addMemory({ content: "hello" }));
      expect(mem0Request).toHaveBeenNthCalledWith(2, "/v3/memories/add/", {
        method: "POST",
        body: {
          messages: [{ role: "user", content: "hello" }],
          user_id: MEM0_USER_ID,
          infer: false,
          metadata: { possible_duplicate_of: ["s1"] },
        },
      });
      const text = result.content[0].text;
      expect(text).toContain("Memory extraction started (event_id: ev1). Confirmed landed (id: m1).");
      expect(text).toContain("⚠ Possible duplicate(s) found — added anyway (not blocked), flagged for review:");
      expect(text).toContain("  s1 (score 0.80): existing text");
    });

    it("ignores candidates below duplicate_threshold and honours a custom threshold", async () => {
      mem0Request
        .mockResolvedValueOnce({ results: [{ id: "s1", memory: "x", score: 0.6 }] })
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [{ id: "m1", memory: "hello" }] });
      await run(() => addMemory({ content: "hello" }));
      expect(mem0Request.mock.calls[1][1].body.metadata).toBeUndefined();

      vi.resetAllMocks();
      mem0Request
        .mockResolvedValueOnce({ results: [{ id: "s1", memory: "x", score: 0.6 }] })
        .mockResolvedValueOnce({ event_id: "ev2" })
        .mockResolvedValueOnce({ results: [{ id: "m1", memory: "hello" }] });
      await run(() => addMemory({ content: "hello", duplicate_threshold: 0.5 }));
      expect(mem0Request.mock.calls[1][1].body.metadata).toEqual({ possible_duplicate_of: ["s1"] });
    });

    it("cleans relations (canonicalize, drop self-loops and in-call duplicates) and warns on dangling targets", async () => {
      mem0Request
        .mockResolvedValueOnce({ results: [] }) // findByEntityId e1
        .mockResolvedValueOnce({ results: [] }) // relation target lookup e2
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [{ id: "m1", metadata: { entity_id: "e1" } }] });
      const result = await run(() =>
        addMemory({
          content: "c",
          entity_id: "e1",
          skip_duplicate_check: true,
          relations: [
            { to_entity_id: "E2", relation: "Blocking" },
            { to_entity_id: "e2", relation: "is blocking" },
            { to_entity_id: "e1", relation: "blocks" },
          ],
        })
      );
      expect(mem0Request).toHaveBeenNthCalledWith(3, "/v3/memories/add/", {
        method: "POST",
        body: {
          messages: [{ role: "user", content: "c" }],
          user_id: MEM0_USER_ID,
          infer: false,
          metadata: {
            entity_id: "e1",
            relations: [{ to_entity_id: "e2", relation: "blocks", resolved_at_write: false }],
          },
        },
      });
      const text = result.content[0].text;
      expect(text).toContain("Confirmed landed (id: m1).");
      expect(text).toContain("⚠ Relations:");
      expect(text).toContain('Relation "blocks" -> "E2" flagged dangling-ref');
      expect(text).toContain('Relation "blocks" -> "e2" skipped — duplicate within this call.');
      expect(text).toContain('Relation "blocks" -> "e1" skipped — self-loop (entity can\'t relate to itself).');
    });

    it("lets API errors throw", async () => {
      mem0Request.mockRejectedValueOnce(new Error("500 boom"));
      await expect(addMemory({ content: "hello", skip_duplicate_check: true })).rejects.toThrow("500 boom");
    });
  });

  describe("add_batch", () => {
    it("reports per-item results: skipped by entity_id, added + confirmed, and failed", async () => {
      mem0Request.mockImplementation(async (path, opts) => {
        if (path === "/v3/memories/" && opts?.body?.page_size === 20) {
          return { results: [{ id: "landedB", memory: "B content" }] };
        }
        if (path === "/v3/memories/") return { results: [{ id: "mExisting", metadata: { entity_id: "eA" } }] };
        if (path === "/v1/memories/mExisting/") return { id: "mExisting", memory: "existing text", metadata: { entity_id: "eA" } };
        if (path === "/v3/memories/add/") {
          if (opts.body.messages[0].content === "C content") throw new Error("boom");
          return { event_id: "evB" };
        }
        throw new Error(`unexpected path ${path}`);
      });
      const result = await run(() =>
        addBatch({
          items: [
            { content: "A content", entity_id: "eA", skip_duplicate_check: true },
            { content: "B content", skip_duplicate_check: true },
            { content: "C content", skip_duplicate_check: true },
          ],
        })
      );
      const lines = result.content[0].text.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('⏭ [0] "A content" — skipped, entity_id "eA" already exists (id: mExisting).');
      expect(lines[1]).toBe('✓ [1] "B content" — event_id: evB — confirmed landed (id: landedB)');
      expect(lines[2]).toBe('✗ [2] "C content" — error: boom');
    });

    it("blocks near-identical items (score >= 0.92) and reports them", async () => {
      mem0Request.mockResolvedValueOnce({ results: [{ id: "s1", memory: "existing text", score: 0.95 }] });
      const result = await run(() => addBatch({ items: [{ content: "x" }] }));
      expect(mem0Request).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain(
        '⛔ [0] "x" — blocked, near-identical (score 0.95) to existing memory (id: s1). No duplicate created.'
      );
    });

    it("flags possible duplicates, stores them in metadata and notes an unconfirmed landing", async () => {
      mem0Request
        .mockResolvedValueOnce({ results: [{ id: "s1", memory: "existing text", score: 0.8 }] })
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [] });
      const result = await run(() => addBatch({ items: [{ content: "x", agent_id: "a1", categories: ["t"], status: "open" }] }));
      expect(mem0Request).toHaveBeenNthCalledWith(2, "/v3/memories/add/", {
        method: "POST",
        body: {
          messages: [{ role: "user", content: "x" }],
          user_id: MEM0_USER_ID,
          infer: false,
          agent_id: "a1",
          metadata: { tags: ["t"], status: "open", possible_duplicate_of: ["s1"] },
        },
      });
      expect(result.content[0].text).toBe(
        '✓ [0] "x" — event_id: ev1 ⚠ flagged as possible duplicate of s1 — ⚠ could not confirm this landed, check manually'
      );
    });

    it("falls back to event id 'ok' when the API returns none", async () => {
      mem0Request
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ results: [{ id: "m1", memory: "x" }] });
      const result = await run(() => addBatch({ items: [{ content: "x", skip_duplicate_check: true }] }));
      expect(result.content[0].text).toBe('✓ [0] "x" — event_id: ok — confirmed landed (id: m1)');
    });

    it("surfaces relation warnings per item", async () => {
      mem0Request
        .mockResolvedValueOnce({ results: [] }) // relation target lookup
        .mockResolvedValueOnce({ event_id: "ev1" })
        .mockResolvedValueOnce({ results: [{ id: "m1", memory: "x" }] });
      const result = await run(() =>
        addBatch({ items: [{ content: "x", skip_duplicate_check: true, relations: [{ to_entity_id: "e2", relation: "relates to" }] }] })
      );
      expect(result.content[0].text).toContain('⚠ relations: Relation "relates_to" -> "e2" flagged dangling-ref');
    });
  });

  describe("update", () => {
    const current = (over = {}) => ({
      id: "m1",
      memory: "foo bar baz",
      user_id: "u1",
      metadata: { tags: ["a"], entity_id: "e1" },
      ...over,
    });
    const routeUpdate = (cur, put = { id: "m1", updated_at: "2026-01-02T00:00:00Z" }, extra = {}) =>
      mem0Request.mockImplementation(async (path, opts) => {
        if (path === "/v1/memories/m1/" && opts?.method === "PUT") return put;
        if (path === "/v1/memories/m1/") return cur;
        if (extra[path]) return extra[path](opts);
        throw new Error(`unexpected path ${path}`);
      });
    const putCall = () => mem0Request.mock.calls.find(([, o]) => o?.method === "PUT");

    it("errors when nothing to update is given", async () => {
      const result = await updateMemory({ memory_id: "m1" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Nothing to update");
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("errors when content and replacements are both given", async () => {
      const result = await updateMemory({ memory_id: "m1", content: "x", replacements: [{ find: "a", replace: "b" }] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not both");
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("replaces content in full and preserves existing metadata", async () => {
      routeUpdate(current());
      const result = await updateMemory({ memory_id: "m1", content: "new" });
      expect(putCall()).toEqual(["/v1/memories/m1/", { method: "PUT", body: { text: "new", metadata: { tags: ["a"], entity_id: "e1" } } }]);
      expect(result.content[0].text).toBe("Updated memory (ID: m1) — content replaced in full.\nUpdated: 2026-01-02");
    });

    it("omits metadata from the PUT body when there is none", async () => {
      routeUpdate(current({ metadata: undefined }));
      await updateMemory({ memory_id: "m1", content: "new" });
      expect(putCall()[1].body).toEqual({ text: "new" });
    });

    it("applies replacements sequentially against the current text", async () => {
      routeUpdate(current());
      const result = await updateMemory({
        memory_id: "m1",
        replacements: [{ find: "foo", replace: "x" }, { find: "baz", replace: "y" }],
      });
      expect(putCall()[1].body.text).toBe("x bar y");
      expect(result.content[0].text).toContain("2 targeted edits applied");

      vi.resetAllMocks();
      routeUpdate(current());
      const single = await updateMemory({ memory_id: "m1", replacements: [{ find: "foo", replace: "x" }] });
      expect(single.content[0].text).toContain("1 targeted edit applied");
    });

    it("aborts without writing when a find is missing or ambiguous", async () => {
      routeUpdate(current({ memory: "dup dup" }));
      const missing = await updateMemory({ memory_id: "m1", replacements: [{ find: "nope", replace: "x" }] });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain('Update aborted, nothing written — "nope" was not found');
      const ambiguous = await updateMemory({ memory_id: "m1", replacements: [{ find: "dup", replace: "x" }] });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.content[0].text).toContain('"dup" appears 2 times');
      expect(putCall()).toBeUndefined();
    });

    it("merges a status change into existing metadata", async () => {
      routeUpdate(current());
      const result = await updateMemory({ memory_id: "m1", status: "resolved" });
      expect(putCall()[1].body).toEqual({ text: "foo bar baz", metadata: { tags: ["a"], entity_id: "e1", status: "resolved" } });
      expect(result.content[0].text).toContain('status set to "resolved"');
    });

    it("patches, deletes keys and honours clear_duplicate_flag", async () => {
      routeUpdate(current({ metadata: { tags: ["a"], possible_duplicate_of: ["x"], k: "1", z: "2" } }));
      const result = await updateMemory({
        memory_id: "m1",
        metadata_patch: { k: "2", n: "3" },
        metadata_delete_keys: ["z"],
        clear_duplicate_flag: true,
      });
      expect(putCall()[1].body.metadata).toEqual({ tags: ["a"], k: "2", n: "3" });
      expect(result.content[0].text).toContain("metadata patched (k, n), metadata keys removed (z, possible_duplicate_of)");
    });

    it("replaces relations whole, canonicalizing and resolving targets", async () => {
      routeUpdate(current(), undefined, {
        "/v3/memories/": () => ({ results: [{ id: "m2", metadata: { entity_id: "e2" } }] }),
        "/v1/memories/m2/": () => ({ id: "m2", memory: "t", metadata: { entity_id: "e2" } }),
      });
      const result = await updateMemory({ memory_id: "m1", relations: [{ to_entity_id: "e2", relation: "Depends on" }] });
      expect(putCall()[1].body.metadata).toEqual({
        tags: ["a"],
        entity_id: "e1",
        relations: [{ to_entity_id: "e2", relation: "depends_on", resolved_at_write: true }],
      });
      expect(result.content[0].text).toBe("Updated memory (ID: m1) — relations replaced (1 stored).\nUpdated: 2026-01-02");
    });

    it("clears relations with an empty array", async () => {
      routeUpdate(current());
      const result = await updateMemory({ memory_id: "m1", relations: [] });
      expect(putCall()[1].body.metadata).toEqual({ tags: ["a"], entity_id: "e1", relations: [] });
      expect(result.content[0].text).toContain("relations replaced (0 stored)");
    });

    it("lets API errors throw", async () => {
      mem0Request.mockRejectedValueOnce(new Error("404 gone"));
      await expect(updateMemory({ memory_id: "m1", content: "x" })).rejects.toThrow("404 gone");
    });
  });
});
