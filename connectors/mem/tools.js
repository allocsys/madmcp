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
//
// NOTE on "categories" (2026-07-07):
// Mem0's /v3/memories/add/ endpoint does NOT accept a per-call `categories`
// or `custom_categories` field — it's not in the documented request schema
// (messages, user_id, agent_id, run_id, app_id, metadata, infer,
// expiration_date only). `custom_categories` from the SDK examples is a
// PROJECT-LEVEL setting (client.project.update(custom_categories=[...])),
// applied once for the whole project's classifier going forward — it can't
// tag a single memory at add-time. Sending either field to /v3/memories/add/
// is silently ignored; Mem0 falls back to its own default classifier
// (personal_details, technology, milestones, etc.) regardless.
//
// So our `categories` tool param is implemented as a client-side tag: it's
// stored under `metadata.tags` (a field /v3/memories/add/ *does* support),
// and mem0_list/mem0_search filter on it by fetching normally and checking
// each result's metadata.tags for overlap with the requested list, since
// Mem0's server-side metadata-filter operators (eq/contains/ne, top-level
// keys only) aren't documented to reliably match inside an array field.
//
// NOTE on entity_id upsert (2026-07-07, Tier 1 of the anti-bloat plan):
// mem0_add accepts an optional `entity_id` (e.g. "bug-4"), stored under
// metadata.entity_id, same mechanism as tags. If a memory already exists
// for that entity_id (checked via a client-side scan, same reasoning as
// tags — metadata array/field filtering isn't reliably documented),
// mem0_add refuses to create a duplicate. It does NOT attempt an automatic
// text merge itself: merging old + new content correctly (keep everything
// not explicitly contradicted) is a judgment call that needs an LLM in the
// loop, and this server has no LLM call of its own. Instead it returns the
// existing memory's id + full content back to the caller, who is expected
// to merge and then call mem0_update. This is the deterministic/Tier-1 path
// from the plan.
//
// NOTE on status field (2026-07-07, Part 3 of the anti-bloat plan):
// mem0_add/mem0_update accept an optional `status` (open/resolved/
// superseded), stored under metadata.status — same "store in metadata,
// filter client-side" mechanism as tags/entity_id, for the same reason
// (Mem0's own fields can't be repurposed for this, and metadata-array/field
// filter operators aren't reliably documented). mem0_list/mem0_search
// exclude status="superseded" by default; pass status_filter to override
// (either to explicitly include "superseded", or to narrow to a specific
// status like "open"). Memories with no status set are always shown by
// default — the exclusion only applies to memories explicitly marked
// superseded. mem0_update can update metadata.status without touching
// content by fetching the current record first (Mem0's PUT replaces the
// whole metadata object, so we merge client-side before writing back to
// avoid clobbering tags/entity_id set at add-time).
//
// NOTE on version history (2026-07-07, Part 4 of the anti-bloat plan):
// mem0_get_history is a thin wrapper around Mem0's own
// GET /v1/memories/{id}/history/ endpoint, which already maintains an
// audit trail (event type ADD/UPDATE/DELETE, old/new value, timestamp) for
// every memory. No custom versioning was built — Mem0's native history
// already satisfies the "don't destructively overwrite" requirement, so
// this just surfaces it in the same compact format as the other tools.
//
// NOTE on Tier 2 duplicate flagging (2026-07-07, Part 2 of the anti-bloat plan):
// mem0_add/mem0_add_batch, when NOT given an entity_id (entity_id already
// gets exact-match handling via findByEntityId/Tier 1), run a similarity
// check via Mem0's own /v3/memories/search/ (with rerank:true for
// precision) against the new content, scoped the same way the add is.
// Deliberately non-blocking: unlike a true duplicate this can't be known
// for certain without an LLM merge judgment (same reasoning as Tier 1), so
// the memory is still added, but any candidate scoring at or above
// duplicate_threshold (default 0.75, tunable per call) is recorded under
// metadata.possible_duplicate_of (array of candidate IDs) and surfaced as a
// warning in the tool response. Callers can skip the extra search call
// entirely via skip_duplicate_check (e.g. for bulk/import scenarios where
// latency matters more). mem0_list gained flagged_duplicates_only to
// surface these for the Part 5 periodic consolidation pass; mem0_get and
// compactLine both show a "⚠dup" indicator when the flag is present.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { mem0Request } from "./client.js";
import { MEM0_USER_ID } from "../../config.js";

const STATUS_VALUES = ["open", "resolved", "superseded"];

// Compact one-line formatter shared by list/search to keep token usage low.
function compactLine(m, { showScore = false } = {}) {
  const preview = (m.memory || m.text || "").slice(0, 90).replace(/\n/g, " ");
  const date = (m.created_at || "").slice(0, 10) || "?";
  const tags = Array.isArray(m.metadata?.tags) && m.metadata.tags.length ? ` [${m.metadata.tags.join(",")}]` : "";
  const eid = m.metadata?.entity_id ? ` {${m.metadata.entity_id}}` : "";
  const status = m.metadata?.status ? ` (${m.metadata.status})` : "";
  const dup = Array.isArray(m.metadata?.possible_duplicate_of) && m.metadata.possible_duplicate_of.length ? " ⚠dup" : "";
  const score = showScore && typeof m.score === "number" ? ` (${m.score.toFixed(2)})` : "";
  return `${m.id} | ${date}${tags}${eid}${status}${dup}${score} | ${preview}${preview.length >= 90 ? "…" : ""}`;
}

// Keep only memories whose metadata.tags intersects the requested categories.
function filterByTags(memories, categories) {
  if (!categories?.length) return memories;
  const wanted = new Set(categories);
  return memories.filter((m) => Array.isArray(m.metadata?.tags) && m.metadata.tags.some((t) => wanted.has(t)));
}

// Default: hide memories explicitly marked superseded. If status_filter is
// given, narrow to exactly those statuses instead (this is how you'd
// explicitly ask for superseded ones, or for e.g. only "open").
// Memories with no status set are never hidden by the default behavior.
function filterByStatus(memories, status_filter) {
  if (status_filter?.length) {
    const wanted = new Set(status_filter);
    return memories.filter((m) => wanted.has(m.metadata?.status));
  }
  return memories.filter((m) => m.metadata?.status !== "superseded");
}

// Keep only memories flagged at add-time as possible duplicates of another
// memory (metadata.possible_duplicate_of non-empty) — see mem0_list's
// flagged_duplicates_only param, meant for a periodic consolidation pass.
function filterFlaggedDuplicates(memories, flaggedOnly) {
  if (!flaggedOnly) return memories;
  return memories.filter((m) => Array.isArray(m.metadata?.possible_duplicate_of) && m.metadata.possible_duplicate_of.length);
}

// Look for an existing memory tagged with this entity_id, scoped the same
// way the add call would be. Scans up to 100 most recent memories in scope —
// good enough for a per-project/per-bug entity_id namespace; not a substitute
// for a real indexed lookup if this scope ever gets huge.
async function findByEntityId({ user_id, agent_id, run_id, entity_id }) {
  const filters = { user_id };
  if (agent_id) filters.agent_id = agent_id;
  if (run_id) filters.run_id = run_id;
  const data = await mem0Request("/v3/memories/", { method: "POST", body: { filters, page: 1, page_size: 100 } });
  const memories = data.results || data.memories || data || [];
  return memories.find((m) => m.metadata?.entity_id === entity_id) || null;
}

// Tier 2: search for existing memories similar to new content (used when no
// entity_id was given, since entity_id already gets exact-match handling
// above). Uses Mem0's own hybrid search with reranking for precision rather
// than any custom similarity logic — this server has no LLM/embedding call
// of its own, so it leans on Mem0's engine the same way mem0_search does.
// Excludes superseded memories from candidacy (a superseded memory being
// similar to a new one isn't useful to flag).
async function findPossibleDuplicates({ user_id, agent_id, run_id, content, threshold, limit = 3 }) {
  const filters = { user_id };
  if (agent_id) filters.agent_id = agent_id;
  if (run_id) filters.run_id = run_id;
  const data = await mem0Request("/v3/memories/search/", { method: "POST", body: { query: content, filters, top_k: limit, rerank: true } });
  let memories = data.results || data.memories || data || [];
  memories = filterByStatus(memories, undefined);
  return memories.filter((m) => typeof m.score === "number" && m.score >= threshold);
}

// NOTE on add-then-verify (2026-07-10, following manufact-mem0-add-silent-
// failure-diagnostic): /v3/memories/add/ returning a 2xx with an event_id
// only means Mem0 ACCEPTED the job, not that its async extraction/indexing
// pipeline actually materialized the memory — that step has been observed
// to silently drop a memory with no error surfaced anywhere. Since this
// server has no webhook/callback for that job, the only way to check is to
// poll for the memory to actually appear. Matches on entity_id (exact,
// deterministic) when given, otherwise on exact verbatim content (reliable
// since infer:false — the default — stores content unchanged; a caller
// using infer:true won't get a reliable match here since Mem0 may have
// rephrased it, so verification is best-effort in that case).
//
// Deliberately a SINGLE check after one wait, not a bounded retry loop —
// this only ever costs one extra Mem0 API call per add (reduced 2026-07-10
// from an up-to-4-attempt loop to cut call volume). A memory that takes
// longer than the wait to materialize will report as unconfirmed even
// though it may land moments later; that's an accepted false-negative
// trade-off since the caller is already told to just re-check manually.
async function verifyLanded({ user_id, agent_id, run_id, entity_id, content }, { delayMs = 3000 } = {}) {
  const filters = { user_id };
  if (agent_id) filters.agent_id = agent_id;
  if (run_id) filters.run_id = run_id;
  await new Promise((r) => setTimeout(r, delayMs));
  const data = await mem0Request("/v3/memories/", { method: "POST", body: { filters, page: 1, page_size: 20 } });
  const memories = data.results || data.memories || data || [];
  return memories.find((m) =>
    entity_id ? m.metadata?.entity_id === entity_id : (m.memory || m.text) === content
  ) || null;
}

export function register(server) {

  // ── List memories ────────────────────────────────────────────────────────
  server.tool(
    "mem0_list",
    "List recent memories from your Mem0 workspace.",
    {
      user_id:        z.string().optional().describe(`Mem0 user ID to scope memories (default: ${MEM0_USER_ID})`),
      limit:          z.number().optional().describe("Number of memories to return (default: 20)"),
      page:           z.number().optional().describe("Page number for pagination (default: 1)"),
      categories:     z.array(z.string()).optional().describe("Optional tag filters (memory must match any listed tag; matched client-side against metadata.tags, not Mem0's built-in classifier categories)"),
      status_filter:  z.array(z.enum(STATUS_VALUES)).optional().describe("Optional status filter (memory must match one of the listed statuses). If omitted, defaults to excluding status=\"superseded\" (memories with no status set are always included). Pass e.g. [\"superseded\"] to explicitly see superseded memories, or [\"open\"] to narrow to just open ones."),
      fields:         z.array(z.string()).optional().describe("Optional list of fields to return per memory (server-side projection to reduce payload size), e.g. ['id','memory','created_at']"),
      flagged_duplicates_only: z.boolean().optional().describe("If true, only return memories flagged at add-time as possible duplicates of another memory (metadata.possible_duplicate_of non-empty) — useful for a periodic consolidation pass (Part 5 of the anti-bloat plan)."),
    },
    async ({ user_id = MEM0_USER_ID, limit = 20, page = 1, categories, status_filter, fields, flagged_duplicates_only }) => {
      const filters = { user_id };
      // Over-fetch a bit since tag/status filtering happens client-side.
      const needsClientFilter = categories?.length || status_filter?.length || flagged_duplicates_only || true; // status default-filter always applies
      const fetchSize = needsClientFilter ? Math.max(limit * 2, limit + 20) : limit;
      const body = { filters, page, page_size: fetchSize };
      if (fields?.length) body.fields = Array.from(new Set([...fields, "metadata"]));
      const data = await mem0Request("/v3/memories/", { method: "POST", body });
      let memories = data.results || data.memories || data || [];
      memories = filterByTags(memories, categories);
      memories = filterByStatus(memories, status_filter);
      memories = filterFlaggedDuplicates(memories, flagged_duplicates_only).slice(0, limit);
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
      const tags = Array.isArray(m.metadata?.tags) && m.metadata.tags.length ? `\nTags: ${m.metadata.tags.join(", ")}` : "";
      const eid = m.metadata?.entity_id ? `\nEntity ID: ${m.metadata.entity_id}` : "";
      const status = m.metadata?.status ? `\nStatus: ${m.metadata.status}` : "";
      const dup = Array.isArray(m.metadata?.possible_duplicate_of) && m.metadata.possible_duplicate_of.length ? `\nPossible duplicate of: ${m.metadata.possible_duplicate_of.join(", ")}` : "";
      const meta = m.metadata && Object.keys(m.metadata).length ? `\n\nMetadata:\n${JSON.stringify(m.metadata, null, 2)}` : "";
      const text =
        `ID: ${m.id}\n` +
        `Created: ${m.created_at?.slice(0, 10) || "unknown"} | Updated: ${m.updated_at?.slice(0, 10) || "unknown"}${cats}${tags}${eid}${status}${dup}\n\n` +
        (m.memory || m.text || "(no content)") +
        meta;
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Get memory version history ───────────────────────────────────────────
  server.tool(
    "mem0_get_history",
    "Get the version/audit history of a specific Mem0 memory by ID — every ADD/UPDATE/DELETE event recorded for it, with old/new values and timestamps. Wraps Mem0's native history endpoint.",
    {
      memory_id: z.string().describe("The memory ID (from mem0_list or mem0_search)"),
    },
    async ({ memory_id }) => {
      const data = await mem0Request(`/v1/memories/${memory_id}/history/`);
      const entries = data.results || data.history || data || [];
      if (!entries.length) return { content: [{ type: "text", text: "No history found for this memory." }] };
      const lines = entries.map((h) => {
        const date = (h.created_at || h.updated_at || "").slice(0, 10) || "?";
        const event = h.event || h.action || "?";
        const trunc = (s) => (s || "").slice(0, 70).replace(/\n/g, " ") + ((s || "").length > 70 ? "…" : "");
        const oldVal = h.prev_value ?? h.old_memory;
        const newVal = h.new_value ?? h.new_memory;
        const diff = oldVal || newVal ? ` | ${trunc(oldVal) || "(none)"} → ${trunc(newVal) || "(none)"}` : "";
        return `${date} [${event}]${diff}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
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
      categories: z.array(z.string()).optional().describe("Optional tags to attach to this memory (e.g. ['manager.js','decisions']) — stored under metadata.tags and used for later tag-filtered list/search, since Mem0's own category classifier can't be overridden per-call"),
      entity_id:  z.string().optional().describe("Optional stable identifier for the fact/entity this memory is about (e.g. 'bug-4', 'nexus-file-naming'). If a memory already exists with this entity_id, mem0_add will NOT create a duplicate — it returns the existing memory's id and content instead, so you can merge old + new content yourself (keeping everything not explicitly contradicted) and call mem0_update. Use this whenever you're recording an update to something you've stored before, rather than adding a fresh mem0_add call."),
      status:     z.enum(STATUS_VALUES).optional().describe("Optional lifecycle status for this memory (open/resolved/superseded). Left unset by default. Memories marked \"superseded\" are hidden from mem0_list/mem0_search by default."),
      metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object to attach (e.g. {project: 'manager.js'})"),
      infer:      z.boolean().optional().describe("If true, uses Mem0's LLM extraction to atomize/rephrase the content into inferred facts instead of storing it verbatim. Default: false (stores content verbatim as a 'direct import') to prevent extraction from scattering or restructuring stored memories."),
      skip_duplicate_check: z.boolean().optional().describe("If true, skip the Tier 2 similarity check against existing memories (only relevant when no entity_id is given). Default: false — the check runs automatically. Set true for bulk/import scenarios where the extra search call's latency isn't worth it."),
      duplicate_threshold:  z.number().optional().describe("Minimum relevance score (0-1) for an existing memory to be flagged as a possible duplicate of this one. Default: 0.75. Only used when entity_id is not given and skip_duplicate_check is false."),
    },
    async ({ content, user_id = MEM0_USER_ID, agent_id, run_id, categories, entity_id, status, metadata, infer = false, skip_duplicate_check = false, duplicate_threshold = 0.75 }) => {
      if (entity_id) {
        const existing = await findByEntityId({ user_id, agent_id, run_id, entity_id });
        if (existing) {
          return {
            content: [{
              type: "text",
              text:
                `Not adding — a memory already exists for entity_id "${entity_id}" (id: ${existing.id}). No duplicate was created.\n\n` +
                `Existing content:\n${existing.memory || existing.text || "(no content)"}\n\n` +
                `New content you were about to add:\n${content}\n\n` +
                `Next step: merge these two yourself — keep everything from the existing content that the new content doesn't explicitly contradict — then call mem0_update with memory_id="${existing.id}" and the merged text.`,
            }],
          };
        }
      }
      let duplicateWarning = "";
      const meta = { ...metadata };
      if (categories?.length) meta.tags = categories;
      if (entity_id) meta.entity_id = entity_id;
      if (status) meta.status = status;
      if (!entity_id && !skip_duplicate_check) {
        const candidates = await findPossibleDuplicates({ user_id, agent_id, run_id, content, threshold: duplicate_threshold });
        if (candidates.length) {
          meta.possible_duplicate_of = candidates.map((c) => c.id);
          duplicateWarning =
            `\n\n⚠ Possible duplicate(s) found — added anyway (not blocked), flagged for review:\n` +
            candidates.map((c) => `  ${c.id} (score ${c.score.toFixed(2)}): ${(c.memory || c.text || "").slice(0, 70)}`).join("\n") +
            `\nCheck with mem0_get; if it's a real duplicate, merge via mem0_update and mark the stale one status="superseded".`;
        }
      }
      const messages = [{ role: "user", content }];
      const body = { messages, user_id, infer };
      if (agent_id) body.agent_id = agent_id;
      if (run_id) body.run_id = run_id;
      if (Object.keys(meta).length) body.metadata = meta;
      const data = await mem0Request("/v3/memories/add/", { method: "POST", body });
      const eventId = data.event_id || data.id;
      const landed = await verifyLanded({ user_id, agent_id, run_id, entity_id, content });
      const landedNote = landed
        ? ` Confirmed landed (id: ${landed.id}).`
        : `\n\n⚠ Could not confirm this memory landed after several verification attempts — Mem0's async job may have silently failed (see manufact-mem0-add-silent-failure-diagnostic). Re-run mem0_search/mem0_list shortly to check, and retry mem0_add if it's still missing.`;
      return {
        content: [{
          type: "text",
          text: (eventId
            ? `Memory extraction started (event_id: ${eventId}).${landedNote}`
            : `Memory added: ${JSON.stringify(data)}`) + duplicateWarning,
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
        categories: z.array(z.string()).optional().describe("Optional tags for this memory — stored under metadata.tags (see mem0_add for why)"),
        entity_id:  z.string().optional().describe("Optional stable identifier for this fact/entity — see mem0_add. If a memory already exists for it, this item is skipped (not duplicated) and the existing id + content is reported instead."),
        status:     z.enum(STATUS_VALUES).optional().describe("Optional lifecycle status (open/resolved/superseded) — see mem0_add."),
        metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object for this memory"),
        infer:      z.boolean().optional().describe("If true, uses Mem0's LLM extraction to atomize/rephrase the content instead of storing it verbatim. Default: false."),
        skip_duplicate_check: z.boolean().optional().describe("If true, skip the Tier 2 similarity check for this item (only relevant when no entity_id is given). Default: false."),
        duplicate_threshold:  z.number().optional().describe("Minimum relevance score (0-1) to flag an existing memory as a possible duplicate of this item. Default: 0.75."),
      })).min(1).describe("List of memories to add"),
    },
    async ({ items }) => {
      const results = await Promise.allSettled(items.map(async ({ content, user_id = MEM0_USER_ID, agent_id, run_id, categories, entity_id, status, metadata, infer = false, skip_duplicate_check = false, duplicate_threshold = 0.75 }) => {
        if (entity_id) {
          const existing = await findByEntityId({ user_id, agent_id, run_id, entity_id });
          if (existing) {
            return { skipped: true, entity_id, existingId: existing.id, existingContent: existing.memory || existing.text || "(no content)" };
          }
        }
        const meta = { ...metadata };
        if (categories?.length) meta.tags = categories;
        if (entity_id) meta.entity_id = entity_id;
        if (status) meta.status = status;
        let duplicatesFlagged = null;
        if (!entity_id && !skip_duplicate_check) {
          const candidates = await findPossibleDuplicates({ user_id, agent_id, run_id, content, threshold: duplicate_threshold });
          if (candidates.length) {
            meta.possible_duplicate_of = candidates.map((c) => c.id);
            duplicatesFlagged = candidates.map((c) => c.id);
          }
        }
        const body = { messages: [{ role: "user", content }], user_id, infer };
        if (agent_id) body.agent_id = agent_id;
        if (run_id) body.run_id = run_id;
        if (Object.keys(meta).length) body.metadata = meta;
        const result = await mem0Request("/v3/memories/add/", { method: "POST", body });
        const landed = await verifyLanded({ user_id, agent_id, run_id, entity_id, content });
        return { ...result, duplicatesFlagged, landed: !!landed, landedId: landed?.id };
      }));
      const lines = results.map((r, i) => {
        const title = (items[i].content || "").split("\n")[0].slice(0, 60);
        if (r.status === "fulfilled") {
          if (r.value?.skipped) {
            return `⏭ [${i}] "${title}" — skipped, entity_id "${r.value.entity_id}" already exists (id: ${r.value.existingId}). Merge and call mem0_update yourself if this content adds anything new.`;
          }
          const eventId = r.value.event_id || r.value.id || "ok";
          const dupNote = r.value.duplicatesFlagged?.length ? ` ⚠ flagged as possible duplicate of ${r.value.duplicatesFlagged.join(", ")}` : "";
          const landedNote = r.value.landed ? ` — confirmed landed (id: ${r.value.landedId})` : ` — ⚠ could not confirm this landed, check manually`;
          return `✓ [${i}] "${title}" — event_id: ${eventId}${dupNote}${landedNote}`;
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
      query:          z.string().describe("Search query string"),
      user_id:        z.string().optional().describe(`Mem0 user ID to scope search (default: ${MEM0_USER_ID})`),
      limit:          z.number().optional().describe("Number of results to return (default: 10)"),
      categories:     z.array(z.string()).optional().describe("Optional tag filters (memory must match any listed tag; matched client-side against metadata.tags, not Mem0's built-in classifier categories)"),
      status_filter:  z.array(z.enum(STATUS_VALUES)).optional().describe("Optional status filter (memory must match one of the listed statuses). If omitted, defaults to excluding status=\"superseded\" (memories with no status set are always included). Pass e.g. [\"superseded\"] to explicitly see superseded memories."),
      rerank:         z.boolean().optional().describe("Whether to apply Mem0's relevance reranking on top of hybrid retrieval (default: false). Improves precision for ambiguous queries at some latency cost."),
      threshold:      z.number().optional().describe("Optional minimum relevance score (0-1) — results below this are dropped"),
    },
    async ({ query, user_id = MEM0_USER_ID, limit = 10, categories, status_filter, rerank, threshold }) => {
      const filters = { user_id };
      // Over-fetch since tag/status filtering happens client-side (status
      // default-exclusion of "superseded" always applies, so always over-fetch
      // a bit even with no explicit categories/status_filter given).
      const fetchLimit = Math.max(limit * 3, limit + 20);
      const body = { query, filters, top_k: fetchLimit };
      if (rerank) body.rerank = true;
      if (typeof threshold === "number") body.threshold = threshold;
      const data = await mem0Request("/v3/memories/search/", { method: "POST", body });
      let memories = data.results || data.memories || data || [];
      memories = filterByTags(memories, categories);
      memories = filterByStatus(memories, status_filter).slice(0, limit);
      if (!memories.length) return { content: [{ type: "text", text: "No memories found matching your query." }] };
      return { content: [{ type: "text", text: memories.map((m) => compactLine(m, { showScore: true })).join("\n") }] };
    }
  );

  // ── Update memory ────────────────────────────────────────────────────────
  server.tool(
    "mem0_update",
    "Update an existing Mem0 memory by ID: replace its content, change its status, or both. At least one of content/status must be given.",
    {
      memory_id: z.string().describe("The memory ID to update"),
      content:   z.string().optional().describe("New content for the memory (replaces existing content). Omit to change only the status."),
      status:    z.enum(STATUS_VALUES).optional().describe("New lifecycle status (open/resolved/superseded) for this memory. Omit to leave status unchanged. Existing tags/entity_id/other metadata are preserved regardless."),
    },
    async ({ memory_id, content, status }) => {
      if (content === undefined && status === undefined) {
        return {
          content: [{ type: "text", text: "Nothing to update — provide content, status, or both." }],
          isError: true,
        };
      }
      // Mem0's PUT replaces the whole metadata object, so fetch current
      // metadata first and merge in the status change client-side, rather
      // than risk wiping out tags/entity_id set at add-time.
      const current = await mem0Request(`/v1/memories/${memory_id}/`);
      const finalText = content !== undefined ? content : (current.memory || current.text || "");
      const finalMetadata = { ...current.metadata, ...(status !== undefined ? { status } : {}) };
      const body = { text: finalText };
      if (Object.keys(finalMetadata).length) body.metadata = finalMetadata;
      const data = await mem0Request(`/v1/memories/${memory_id}/`, { method: "PUT", body });
      const parts = [];
      if (content !== undefined) parts.push("content updated");
      if (status !== undefined) parts.push(`status set to "${status}"`);
      return { content: [{ type: "text", text: `Updated memory (ID: ${data.id || memory_id}) — ${parts.join(", ")}.\nUpdated: ${data.updated_at?.slice(0, 10) || "unknown"}` }] };
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

  // ── Bulk delete by filter (server-side, no IDs needed) ────────────────────
  server.tool(
    "mem0_delete_all",
    "Bulk-delete every memory matching the given filters in a single server-side call (Mem0's DELETE /v1/memories) — no need to list or fetch IDs first. At least one filter must resolve (defaults to your own user_id if none are given). Pass '*' as a filter value to match ALL entities of that type (e.g. user_id: '*' deletes memories for every user in the whole project) — combine all four id filters with '*' for a full project wipe. Irreversible; requires confirm: true.",
    {
      user_id:    z.string().optional().describe(`Filter by user ID. Pass '*' to delete memories for all users. Defaults to ${MEM0_USER_ID} if no filters are given at all.`),
      agent_id:   z.string().optional().describe("Filter by agent ID. Pass '*' to delete memories for all agents."),
      app_id:     z.string().optional().describe("Filter by app ID. Pass '*' to delete memories for all apps."),
      run_id:     z.string().optional().describe("Filter by run ID. Pass '*' to delete memories for all runs."),
      metadata:   z.record(z.any()).optional().describe("Filter by metadata (exact match on the given key/value pairs)."),
      confirm:    z.boolean().describe("Must be explicitly set to true to execute the deletion. Safety guard against accidental bulk wipes — the tool refuses to run without it."),
    },
    async ({ user_id, agent_id, app_id, run_id, metadata, confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text", text: "Refused: this would bulk-delete memories server-side and cannot be undone. Re-call with confirm: true to proceed." }],
          isError: true,
        };
      }
      // Mem0 itself rejects a filterless call, but fail fast with a clearer
      // message and a safe default (caller's own scope) rather than letting
      // an empty filter set fall through to an ambiguous 400 from the API.
      if (!user_id && !agent_id && !app_id && !run_id && !metadata) {
        user_id = MEM0_USER_ID;
      }
      const params = new URLSearchParams();
      if (user_id) params.set("user_id", user_id);
      if (agent_id) params.set("agent_id", agent_id);
      if (app_id) params.set("app_id", app_id);
      if (run_id) params.set("run_id", run_id);
      if (metadata) params.set("metadata", JSON.stringify(metadata));
      const data = await mem0Request(`/v1/memories/?${params.toString()}`, { method: "DELETE" });
      const wildcardScope = [user_id, agent_id, app_id, run_id].includes("*");
      const scopeDesc = [
        user_id    && `user_id=${user_id}`,
        agent_id   && `agent_id=${agent_id}`,
        app_id     && `app_id=${app_id}`,
        run_id     && `run_id=${run_id}`,
        metadata   && `metadata=${JSON.stringify(metadata)}`,
      ].filter(Boolean).join(", ");
      return {
        content: [{
          type: "text",
          text: `${data?.message || "Memories deleted."} (scope: ${scopeDesc})${wildcardScope ? " — wildcard used, this may have affected multiple entities." : ""}`,
        }],
      };
    }
  );

  // ── Delete multiple memories in one call ─────────────────────────────────
  server.tool(
    "mem0_delete_batch",
    "Permanently delete multiple Mem0 memories in a single call. Returns a per-item success/failure report.",
    {
      memory_ids: z.array(z.string()).min(1).describe("List of memory IDs to delete"),
    },
    async ({ memory_ids }) => {
      const results = await Promise.allSettled(
        memory_ids.map((id) => mem0Request(`/v1/memories/${id}/`, { method: "DELETE" }))
      );
      const lines = results.map((r, i) =>
        r.status === "fulfilled"
          ? `✓ Deleted: ${memory_ids[i]}`
          : `✗ Failed:  ${memory_ids[i]} — ${r.reason?.message || r.reason}`
      );
      const deleted = results.filter((r) => r.status === "fulfilled").length;
      return {
        content: [{
          type: "text",
          text: `${deleted}/${memory_ids.length} deleted.\n\n${lines.join("\n")}`,
        }],
      };
    }
  );
}
