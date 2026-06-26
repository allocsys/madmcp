// ---------------------------------------------------------------------------
// connectors/mem/tools.js  —  Mem0 MCP tools
// API reference: https://docs.mem0.ai/api-reference
//
// Key Mem0 concepts:
//   - Memories are scoped to a user_id (and optionally agent_id / run_id)
//   - POST /v3/memories/add/   → add memories from conversation messages
//   - POST /v3/memories/search/ → hybrid search (semantic + BM25 + entity)
//   - POST /v3/memories/       → filtered listing (paginated)
//   - GET  /v1/memories/{id}/  → get single memory
//   - PUT  /v1/memories/{id}/  → update single memory
//   - DELETE /v1/memories/{id}/ → delete single memory
// ---------------------------------------------------------------------------

import { z } from "zod";
import { mem0Request } from "./client.js";
import { MEM0_USER_ID } from "../../config.js";

// Compact one-line formatter shared by list/search to keep token usage low.
function compactLine(m, { showScore = false } = {}) {
  const preview = (m.memory || m.text || "").slice(0, 90).replace(/\n/g, " ");
  const date = (m.created_at || "").slice(0, 10) || "?";
  const cats = Array.isArray(m.categories) && m.categories.length ? ` [${m.categories.join(",")}]` : "";
  const score = showScore && typeof m.score === "number" ? ` (${m.score.toFixed(2)})` : "";
  return `${m.id} | ${date}${cats}${score} | ${preview}${preview.length >= 90 ? "…" : ""}`;
}

export function register(server) {

  // ── List memories ────────────────────────────────────────────────────────
  server.tool(
    "mem0_list",
    "List recent memories from your Mem0 workspace.",
    {
      user_id:    z.string().optional().describe(`Mem0 user ID to scope memories (default: ${MEM0_USER_ID})`),
      limit:      z.number().optional().describe("Number of memories to return (default: 20)"),
      page:       z.number().optional().describe("Page number for pagination (default: 1)"),
      categories: z.array(z.string()).optional().describe("Optional category filters (memory must match any listed category)"),
      fields:     z.array(z.string()).optional().describe("Optional list of fields to return per memory (server-side projection to reduce payload size), e.g. ['id','memory','created_at']"),
    },
    async ({ user_id = MEM0_USER_ID, limit = 20, page = 1, categories, fields }) => {
      const filters = { user_id };
      if (categories?.length) filters.categories = { in: categories };
      const body = { filters, page, page_size: limit };
      if (fields?.length) body.fields = fields;
      const data = await mem0Request("/v3/memories/", { method: "POST", body });
      const memories = data.results || data.memories || data || [];
      if (!memories.length) return { content: [{ type: "text", text: "No memories found." }] };
      return { content: [{ type: "text", text: memories.map((m) => compactLine(m)).join("\n") }] };
    }
  );

  // ── Get single memory ────────────────────────────────────────────────────
  server.tool(
    "mem0_get",
    "Get the full content of a specific Mem0 memory by ID.",
    {
      memory_id: z.string().describe("The memory ID (from mem0_list or mem0_search)"),
    },
    async ({ memory_id }) => {
      const m = await mem0Request(`/v1/memories/${memory_id}/`);
      const cats = Array.isArray(m.categories) && m.categories.length ? `\nCategories: ${m.categories.join(", ")}` : "";
      const text =
        `ID: ${m.id}\n` +
        `Created: ${m.created_at?.slice(0, 10) || "unknown"} | Updated: ${m.updated_at?.slice(0, 10) || "unknown"}${cats}\n\n` +
        (m.memory || m.text || "(no content)");
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Add memory ───────────────────────────────────────────────────────────
  server.tool(
    "mem0_add",
    "Add a new memory to your Mem0 workspace. Mem0 uses LLM extraction to store facts from your message.",
    {
      content:    z.string().describe("The text or fact to remember (markdown supported)"),
      user_id:    z.string().optional().describe(`Mem0 user ID to scope the memory (default: ${MEM0_USER_ID})`),
      agent_id:   z.string().optional().describe("Optional agent ID for finer-grained scoping (e.g. per-project), in addition to user_id"),
      run_id:     z.string().optional().describe("Optional run/session ID for finer-grained scoping"),
      categories: z.array(z.string()).optional().describe("Optional category tags to attach to this memory (e.g. ['manager.js','decisions']) — improves filtered search later"),
      metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object to attach (e.g. {project: 'manager.js'})"),
    },
    async ({ content, user_id = MEM0_USER_ID, agent_id, run_id, categories, metadata }) => {
      const messages = [{ role: "user", content }];
      const body = { messages, user_id };
      if (agent_id) body.agent_id = agent_id;
      if (run_id) body.run_id = run_id;
      if (categories?.length) body.categories = categories;
      if (metadata) body.metadata = metadata;
      const data = await mem0Request("/v3/memories/add/", { method: "POST", body });
      const eventId = data.event_id || data.id;
      return {
        content: [{
          type: "text",
          text: eventId
            ? `Memory extraction started (event_id: ${eventId}). Mem0 will process and store the relevant facts asynchronously.`
            : `Memory added: ${JSON.stringify(data)}`,
        }],
      };
    }
  );

  // ── Add multiple memories in one call ──────────────────────────────────────
  server.tool(
    "mem0_add_batch",
    "Add multiple memories to your Mem0 workspace in a single call, to reduce round trips. Each item is submitted as its own extraction request.",
    {
      items: z.array(z.object({
        content:    z.string().describe("The text or fact to remember (markdown supported)"),
        user_id:    z.string().optional().describe(`Mem0 user ID to scope this memory (default: ${MEM0_USER_ID})`),
        agent_id:   z.string().optional().describe("Optional agent ID for finer-grained scoping"),
        run_id:     z.string().optional().describe("Optional run/session ID for finer-grained scoping"),
        categories: z.array(z.string()).optional().describe("Optional category tags for this memory"),
        metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object for this memory"),
      })).min(1).describe("List of memories to add"),
    },
    async ({ items }) => {
      const results = await Promise.allSettled(items.map(({ content, user_id = MEM0_USER_ID, agent_id, run_id, categories, metadata }) => {
        const body = { messages: [{ role: "user", content }], user_id };
        if (agent_id) body.agent_id = agent_id;
        if (run_id) body.run_id = run_id;
        if (categories?.length) body.categories = categories;
        if (metadata) body.metadata = metadata;
        return mem0Request("/v3/memories/add/", { method: "POST", body });
      }));
      const lines = results.map((r, i) => {
        const title = (items[i].content || "").split("\n")[0].slice(0, 60);
        if (r.status === "fulfilled") {
          const eventId = r.value.event_id || r.value.id || "ok";
          return `✓ [${i}] "${title}" — event_id: ${eventId}`;
        }
        return `✗ [${i}] "${title}" — error: ${r.reason?.message || r.reason}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── Search memories ──────────────────────────────────────────────────────
  server.tool(
    "mem0_search",
    "Search memories in your Mem0 workspace using hybrid semantic + keyword retrieval.",
    {
      query:      z.string().describe("Search query string"),
      user_id:    z.string().optional().describe(`Mem0 user ID to scope search (default: ${MEM0_USER_ID})`),
      limit:      z.number().optional().describe("Number of results to return (default: 10)"),
      categories: z.array(z.string()).optional().describe("Optional category filters (memory must match any listed category)"),
      rerank:     z.boolean().optional().describe("Whether to apply Mem0's relevance reranking on top of hybrid retrieval (default: false). Improves precision for ambiguous queries at some latency cost."),
      threshold:  z.number().optional().describe("Optional minimum relevance score (0-1) — results below this are dropped"),
    },
    async ({ query, user_id = MEM0_USER_ID, limit = 10, categories, rerank, threshold }) => {
      const filters = { user_id };
      if (categories?.length) filters.categories = { in: categories };
      const body = { query, filters, top_k: limit };
      if (rerank) body.rerank = true;
      if (typeof threshold === "number") body.threshold = threshold;
      const data = await mem0Request("/v3/memories/search/", { method: "POST", body });
      const memories = data.results || data.memories || data || [];
      if (!memories.length) return { content: [{ type: "text", text: "No memories found matching your query." }] };
      return { content: [{ type: "text", text: memories.map((m) => compactLine(m, { showScore: true })).join("\n") }] };
    }
  );

  // ── Update memory ────────────────────────────────────────────────────────
  server.tool(
    "mem0_update",
    "Update (overwrite) the content of an existing Mem0 memory by ID.",
    {
      memory_id: z.string().describe("The memory ID to update"),
      content:   z.string().describe("New content for the memory (replaces existing content)"),
    },
    async ({ memory_id, content }) => {
      const data = await mem0Request(`/v1/memories/${memory_id}/`, {
        method: "PUT",
        body: { text: content },
      });
      return { content: [{ type: "text", text: `Updated memory (ID: ${data.id || memory_id}).\nUpdated: ${data.updated_at?.slice(0, 10) || "unknown"}` }] };
    }
  );

  // ── Delete memory ────────────────────────────────────────────────────────
  server.tool(
    "mem0_delete",
    "Permanently delete a specific Mem0 memory by ID.",
    {
      memory_id: z.string().describe("The memory ID to delete"),
    },
    async ({ memory_id }) => {
      await mem0Request(`/v1/memories/${memory_id}/`, { method: "DELETE" });
      return { content: [{ type: "text", text: `Deleted memory (ID: ${memory_id}).` }] };
    }
  );
}
