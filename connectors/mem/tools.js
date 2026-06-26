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

export function register(server) {

  // ── List memories ────────────────────────────────────────────────────────
  server.tool(
    "mem0_list",
    "List recent memories from your Mem0 workspace.",
    {
      user_id: z.string().optional().describe(`Mem0 user ID to scope memories (default: ${MEM0_USER_ID})`),
      limit:   z.number().optional().describe("Number of memories to return (default: 20)"),
      page:    z.number().optional().describe("Page number for pagination (default: 1)"),
    },
    async ({ user_id = MEM0_USER_ID, limit = 20, page = 1 }) => {
      // POST /v3/memories/ with filters
      const data = await mem0Request("/v3/memories/", {
        method: "POST",
        body: { filters: { user_id }, page, page_size: limit },
      });
      const memories = data.results || data.memories || data || [];
      if (!memories.length) return { content: [{ type: "text", text: "No memories found." }] };
      const lines = memories.map((m) => {
        const preview = (m.memory || m.text || "").slice(0, 100).replace(/\n/g, " ");
        return `ID: ${m.id}\n  ${preview}${preview.length >= 100 ? "…" : ""}\n  Created: ${m.created_at?.slice(0, 10) || "unknown"}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
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
      const text =
        `ID: ${m.id}\n` +
        `Created: ${m.created_at?.slice(0, 10) || "unknown"} | Updated: ${m.updated_at?.slice(0, 10) || "unknown"}\n\n` +
        (m.memory || m.text || "(no content)");
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Add memory ───────────────────────────────────────────────────────────
  server.tool(
    "mem0_add",
    "Add a new memory to your Mem0 workspace. Mem0 uses LLM extraction to store facts from your message.",
    {
      content: z.string().describe("The text or fact to remember (markdown supported)"),
      user_id: z.string().optional().describe(`Mem0 user ID to scope the memory (default: ${MEM0_USER_ID})`),
    },
    async ({ content, user_id = MEM0_USER_ID }) => {
      const messages = [{ role: "user", content }];
      const data = await mem0Request("/v3/memories/add/", {
        method: "POST",
        body: { messages, user_id },
      });
      // v3/memories/add returns an event_id for async processing
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

  // ── Search memories ──────────────────────────────────────────────────────
  server.tool(
    "mem0_search",
    "Search memories in your Mem0 workspace using hybrid semantic + keyword retrieval.",
    {
      query:   z.string().describe("Search query string"),
      user_id: z.string().optional().describe(`Mem0 user ID to scope search (default: ${MEM0_USER_ID})`),
      limit:   z.number().optional().describe("Number of results to return (default: 10)"),
    },
    async ({ query, user_id = MEM0_USER_ID, limit = 10 }) => {
      const data = await mem0Request("/v3/memories/search/", {
        method: "POST",
        body: { query, filters: { user_id }, top_k: limit },
      });
      const memories = data.results || data.memories || data || [];
      if (!memories.length) return { content: [{ type: "text", text: "No memories found matching your query." }] };
      const lines = memories.map((m) => {
        const preview = (m.memory || m.text || "").slice(0, 120).replace(/\n/g, " ");
        return `ID: ${m.id}\n  ${preview}${preview.length >= 120 ? "…" : ""}\n  Score: ${m.score?.toFixed(3) || "n/a"}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
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
        body: { memory: content },
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
