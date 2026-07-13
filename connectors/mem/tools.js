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
// NOTE on Tier 2 duplicate flagging (2026-07-07, Part 2 of the anti-bloat plan;
// revised 2026-07-13 to also cover new/non-matching entity_ids):
// mem0_add/mem0_add_batch run a similarity check via Mem0's own
// /v3/memories/search/ (with rerank:true for precision) against the new
// content, scoped the same way the add is, whenever the call did NOT already
// hit an exact entity_id match (an exact match short-circuits before this —
// see findByEntityId/Tier 1 above, it refuses to add at all in that case).
// Originally this was skipped whenever entity_id was given at all, on the
// theory entity_id already gets exact-match protection — but a *new*
// entity_id (one that doesn't match anything existing) got zero duplicate
// protection under that scheme, since exact-match by definition can't catch
// a semantic duplicate filed under a different key. That gap let a caller
// invent a fresh entity_id for content that was really an update to an
// existing entity, silently forking the record. Tier 2 now always runs
// unless skip_duplicate_check is set, entity_id or not.
// Deliberately non-blocking: unlike a true duplicate this can't be known
// for certain without an LLM merge judgment (same reasoning as Tier 1), so
// the memory is still added, but any candidate scoring at or above
// duplicate_threshold (default 0.75, tunable per call) is recorded under
// metadata.possible_duplicate_of (array of candidate IDs) and surfaced as a
// warning in the tool response — check it before assuming a new entity_id
// add didn't collide with something. Callers can skip the extra search call
// entirely via skip_duplicate_check (e.g. for bulk/import scenarios where
// latency matters more). mem0_list gained flagged_duplicates_only to
// surface these for the Part 5 periodic consolidation pass; mem0_get and
// compactLine both show a "⚠dup" indicator when the flag is present.
//
// REVISED 2026-07-13 (insert-reliability step of the anti-bloat plan rev 2):
// "deliberately non-blocking" above is now only true in the 0.75–0.92 range.
// A candidate scoring >= BLOCKING_DUPLICATE_THRESHOLD (0.92) is treated as a
// near-certain duplicate and hard-blocks the add, the same way an exact
// entity_id match does — the caller gets the existing memory's id + content
// back and is expected to merge + mem0_update instead. This applies in both
// mem0_add and mem0_add_batch. skip_duplicate_check still bypasses Tier 2
// entirely (including this block), for callers who've already judged the
// content distinct.
//
// NOTE on relations (2026-07-13, relational-info step of the anti-bloat plan
// rev 2 — storage/write-side only, see manufact-mem0-relations-plan):
// mem0_add/mem0_add_batch/mem0_update accept an optional `relations` array
// of {to_entity_id, relation}, stored under metadata.relations — same
// "store in metadata, resolve client-side" mechanism as tags/entity_id/
// status. Relation strings are canonicalized via a small static lookup map
// (case/phrasing variants only; unrecognized strings pass through
// unchanged — no hard enum, per the plan's explicit rejection of a rigid
// schema). Self-loops (to_entity_id === this memory's own entity_id) are
// dropped with a warning rather than blocking the whole add/update.
// Dangling to_entity_id values (no matching entity_id found yet in scope)
// are flagged non-blocking at write time, same reasoning as the existing
// dangling-ref-on-add behavior. mem0_update's relations param is a REPLACE
// of the whole array, not a merge — matching the plan's decided semantics.
// NOT included in this step: findReferencingEntities, multi-hop traversal,
// or surfacing relations on mem0_get/mem0_search/mem0_list — that's the
// read/resolution side, still to be built per the plan.
//
// NOTE on relations traversal/read-side (2026-07-13, completes
// manufact-mem0-relations-plan's relational-info step):
// Adds findReferencingEntities (reverse lookup — who points AT this
// entity_id, since relations are stored one-directional on the source
// memory only), a resolveRelationTarget helper that distinguishes three
// cases for an unresolved to_entity_id instead of a blank/not-found result
// (never_existed / deleted / wrong_scope — see resolveRelationTarget's own
// comment for how "deleted" is detected without proactive tracking), and
// traverseRelations, a cycle-safe BFS walking both outgoing and incoming
// edges up to a depth (default 3, per the plan's 3-hop minimum). Surfaced
// in mem0_get (always, when the memory has an entity_id) and in
// mem0_search/mem0_list (opt-in via include_relations, fully resolved only
// for the top RELATION_RESOLVE_LIMIT results to avoid token blowup at
// 3-hop depth — remaining results show an outgoing-relation COUNT only).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { mem0Request } from "./client.js";
import { MEM0_USER_ID } from "../../config.js";

const STATUS_VALUES = ["open", "resolved", "superseded"];
// Hard-stop threshold for Tier 2 duplicate detection (2026-07-13, insert-
// reliability step of the anti-bloat plan rev 2): a candidate scoring at or
// above this is treated as a near-certain duplicate and blocks the add
// entirely, same as an exact entity_id match. Below this and down to a
// call's duplicate_threshold (default 0.75), candidates are still flagged
// but non-blocking, since that range isn't reliably a true duplicate
// without an LLM merge judgment.
const BLOCKING_DUPLICATE_THRESHOLD = 0.92;
// Default depth for relation traversal (mem0_get, include_relations on
// mem0_search/mem0_list) — matches the plan's 3-hop minimum requirement.
const RELATION_TRAVERSAL_DEPTH = 3;
// mem0_search/mem0_list with include_relations only fully resolve/traverse
// this many top results; the rest show an outgoing-relation count only, to
// avoid token blowup at 3-hop depth across a whole result page.
const RELATION_RESOLVE_LIMIT = 5;

// ---------------------------------------------------------------------------
// Relations helpers (write-side only — see NOTE above)
// ---------------------------------------------------------------------------

// Small static lookup for common phrasing/case variants of the same relation
// — applied at write time so "is blocking" / "blocking" / "Blocks" etc. don't
// fragment into separate relation types. Unrecognized strings pass through
// unchanged (no hard enum — relation vocabulary is still being discovered,
// per the plan's explicit rejection of a rigid schema).
const RELATION_CANONICALIZATION = {
  "is blocking": "blocks",
  "blocking": "blocks",
  "blocks": "blocks",
  "is blocked by": "blocked_by",
  "blocked by": "blocked_by",
  "blocked_by": "blocked_by",
  "depends": "depends_on",
  "depends on": "depends_on",
  "depends_on": "depends_on",
  "dependency of": "depends_on",
  "relates to": "relates_to",
  "related to": "relates_to",
  "relates_to": "relates_to",
};

function canonicalizeRelation(relation) {
  const key = relation.trim().toLowerCase();
  return RELATION_CANONICALIZATION[key] || relation.trim();
}

// trim+lowercase, matching the normalization the plan specifies for both
// entity_id and to_entity_id so relation lookups aren't case/whitespace
// sensitive.
function normalizeEntityId(id) {
  return (id || "").trim().toLowerCase();
}

// Clean a raw `relations` param into what actually gets stored:
//  - normalize to_entity_id
//  - canonicalize the relation string via the map above
//  - drop self-loops (to_entity_id === this memory's own entity_id) — warns
//    and drops rather than hard-failing the whole add/update over one pair
//  - dedupe on the (to_entity_id, relation) pair within this one array
//  - flag (non-blocking) any to_entity_id that doesn't resolve in scope via
//    findByEntityId, same as the existing dangling-ref-on-add behavior
// Returns { relations, warnings } — relations is the cleaned array to store
// (possibly empty), warnings is a list of strings to surface in the response.
async function processRelations(rawRelations, { ownEntityId, user_id, agent_id, run_id }) {
  const warnings = [];
  if (!rawRelations?.length) return { relations: [], warnings };
  const ownNormalized = ownEntityId ? normalizeEntityId(ownEntityId) : null;
  const seen = new Set();
  const cleaned = [];
  for (const { to_entity_id, relation } of rawRelations) {
    const toNormalized = normalizeEntityId(to_entity_id);
    const canonRelation = canonicalizeRelation(relation);
    if (ownNormalized && toNormalized === ownNormalized) {
      warnings.push(`Relation "${relation}" -> "${to_entity_id}" skipped — self-loop (entity can't relate to itself).`);
      continue;
    }
    const dedupeKey = `${toNormalized}::${canonRelation}`;
    if (seen.has(dedupeKey)) {
      warnings.push(`Relation "${canonRelation}" -> "${to_entity_id}" skipped — duplicate within this call.`);
      continue;
    }
    seen.add(dedupeKey);
    const target = await findByEntityId({ user_id, agent_id, run_id, entity_id: toNormalized });
    // resolved_at_write persists whether this target was resolvable in-scope
    // right now, at write time — the read-side resolver (resolveRelationTarget)
    // uses this later to tell "never existed" (false here) apart from
    // "deleted since" (true here, but unresolvable when traversal runs).
    cleaned.push({ to_entity_id: toNormalized, relation: canonRelation, resolved_at_write: !!target });
    if (!target) {
      warnings.push(`Relation "${canonRelation}" -> "${to_entity_id}" flagged dangling-ref — no memory with that entity_id found in scope yet. Stored anyway; this may resolve later, or may reflect a typo.`);
    }
  }
  return { relations: cleaned, warnings };
}

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

// REGRESSION FIX (2026-07-13, see manufact-mem0-relations-plan): the
// /v3/memories/ list endpoint does not reliably surface metadata.relations
// contents, even though it does reliably surface metadata.entity_id (which
// is why entity_id matching below still works off list results directly).
// Confirmed via live repro: a memory's relations array read correctly via
// /v1/memories/{id}/ single-get, but the same array read off a list-page
// result had undefined to_entity_id/relation fields. Any caller that needs
// to trust match.metadata.relations must re-fetch the single record.
async function fetchSingleForMetadata(listVersion) {
  try {
    return await mem0Request(`/v1/memories/${listVersion.id}/`);
  } catch {
    // Single-get failed (e.g. deleted between the list scan and this call)
    // — fall back to the list version rather than throwing, since callers
    // can still use it for id/basic fields even if relations is untrustworthy.
    return listVersion;
  }
}

// Look for an existing memory tagged with this entity_id, scoped the same
// way the add call would be. Paginates through up to 1000 most recent
// memories in scope (10 pages of 100) rather than only the first 100 —
// fixed 2026-07-13 (insert-reliability step of the anti-bloat plan rev 2)
// after the single-page version was found to miss entity_ids on older
// memories once a scope grew past 100. Still not a substitute for a real
// indexed lookup if a scope grows past ~1000 — revisit via D1/graph-DB
// migration (previously rejected, not permanently) if that ever happens.
//
// Once a match is found via the list scan, re-fetches it via single-get
// (fetchSingleForMetadata) before returning — see REGRESSION FIX note above.
// This adds one extra API call per successful lookup (not per page scanned),
// so it's cheap relative to the pagination cost already paid here.
async function findByEntityId({ user_id, agent_id, run_id, entity_id }) {
  const filters = { user_id };
  if (agent_id) filters.agent_id = agent_id;
  if (run_id) filters.run_id = run_id;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await mem0Request("/v3/memories/", { method: "POST", body: { filters, page, page_size: PAGE_SIZE } });
    const memories = data.results || data.memories || data || [];
    const match = memories.find((m) => m.metadata?.entity_id === entity_id);
    if (match) return await fetchSingleForMetadata(match);
    if (memories.length < PAGE_SIZE) break; // reached the last page
  }
  return null;
}

// Same lookup as findByEntityId but scoped to user_id only (no agent_id/
// run_id filter) — used as the cross-scope fallback when a relation target
// doesn't resolve within the caller's own agent_id/run_id scope, so a
// cross-scope relation can still be found and correctly labeled rather than
// reported as missing. Same pagination caveat as findByEntityId, and same
// single-get re-fetch on match (fetchSingleForMetadata) — see the REGRESSION
// FIX note above findByEntityId; without it, a cross-scope match's relations
// would be just as untrustworthy as an in-scope one.
async function findByEntityIdAnyScope({ user_id, entity_id }) {
  const filters = { user_id };
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await mem0Request("/v3/memories/", { method: "POST", body: { filters, page, page_size: PAGE_SIZE } });
    const memories = data.results || data.memories || data || [];
    const match = memories.find((m) => m.metadata?.entity_id === entity_id);
    if (match) return await fetchSingleForMetadata(match);
    if (memories.length < PAGE_SIZE) break;
  }
  return null;
}

// NEW helper (not a reuse of findByEntityId) — relations are stored
// one-directional on the SOURCE memory's metadata.relations array, so
// finding "who points at entity_id X" requires scanning every memory in
// scope for a relations entry whose to_entity_id matches, rather than a
// single direct lookup. Returns [{ fromEntityId, fromId, relation }, ...].
// Same ~1000-memory-per-scope pagination ceiling as findByEntityId.
//
// REGRESSION FIX (2026-07-13, see manufact-mem0-relations-plan and the note
// above findByEntityId): list-page results can't be trusted for
// metadata.relations, so every candidate in every page gets refetched via
// fetchSingleForMetadata (single-get) before its relations are inspected.
// This is a real N+1 cost — up to one /v1/memories/{id}/ call per memory
// scanned, not just per eventual match, since there's no way to tell from
// the list result alone which memories even have relations set. Fetched in
// parallel per page via Promise.all to keep it to one round of latency per
// page rather than serial. Acceptable at current scale (same ~100/page,
// ~1000/scope ceiling as everything else here); revisit if this traversal
// path becomes a real bottleneck.
async function findReferencingEntities({ user_id, agent_id, run_id, entity_id }) {
  const filters = { user_id };
  if (agent_id) filters.agent_id = agent_id;
  if (run_id) filters.run_id = run_id;
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const referencing = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await mem0Request("/v3/memories/", { method: "POST", body: { filters, page, page_size: PAGE_SIZE } });
    const memories = data.results || data.memories || data || [];
    const fullRecords = await Promise.all(memories.map((m) => fetchSingleForMetadata(m)));
    for (const m of fullRecords) {
      const rels = Array.isArray(m.metadata?.relations) ? m.metadata.relations : [];
      for (const rel of rels) {
        if (rel.to_entity_id === entity_id) {
          referencing.push({ fromEntityId: m.metadata?.entity_id || m.id, fromId: m.id, relation: rel.relation });
        }
      }
    }
    if (memories.length < PAGE_SIZE) break;
  }
  return referencing;
}

// Resolves a stored relation's to_entity_id into one of four outcomes
// instead of a blank/not-found result:
//   "ok"            — resolves within the caller's own scope
//   "wrong_scope"   — resolves, but only outside the caller's agent_id/run_id
//                     (found via findByEntityIdAnyScope)
//   "deleted"       — does NOT resolve anywhere now, but resolved_at_write
//                     was true — i.e. it existed when this relation was
//                     written and has since been removed. Detected at
//                     resolve-time by comparing against that stored bit,
//                     not by any proactive delete-time tracking (matches
//                     the plan's decision to keep the delete path itself
//                     free of extra scans/writes).
//   "never_existed" — does NOT resolve anywhere now, and resolved_at_write
//                     was already false at write time (or absent, for
//                     relations written before this bit existed).
async function resolveRelationTarget({ to_entity_id, resolved_at_write, user_id, agent_id, run_id }) {
  const inScope = await findByEntityId({ user_id, agent_id, run_id, entity_id: to_entity_id });
  if (inScope) return { status: "ok", memory: inScope };
  const crossScope = await findByEntityIdAnyScope({ user_id, entity_id: to_entity_id });
  if (crossScope) {
    const scopeLabel = crossScope.agent_id || crossScope.run_id
      ? [crossScope.agent_id && `agent_id=${crossScope.agent_id}`, crossScope.run_id && `run_id=${crossScope.run_id}`].filter(Boolean).join(", ")
      : "different scope";
    return { status: "wrong_scope", memory: crossScope, scopeLabel };
  }
  return { status: resolved_at_write ? "deleted" : "never_existed" };
}

// Cycle-safe BFS over relations, both directions:
//   outgoing — this entity's own memory.metadata.relations
//   incoming — findReferencingEntities(this entity_id)
// Visited-set is mandatory: a cycle (A blocks B, B blocks C, C blocks A)
// would otherwise infinite-loop a traversal with no depth cap on revisits.
// Depth defaults to 3 per the plan's 3-hop minimum. Returns a flat list of
// edges: { from, to, relation, direction, hop, status, scopeLabel? }.
async function traverseRelations(startEntityId, { user_id, agent_id, run_id, depth = RELATION_TRAVERSAL_DEPTH }) {
  const start = normalizeEntityId(startEntityId);
  const visited = new Set([start]);
  const queue = [{ entityId: start, hop: 0 }];
  const edges = [];
  while (queue.length) {
    const { entityId, hop } = queue.shift();
    if (hop >= depth) continue;
    const ownMemory = await findByEntityId({ user_id, agent_id, run_id, entity_id: entityId });
    const outgoing = Array.isArray(ownMemory?.metadata?.relations) ? ownMemory.metadata.relations : [];
    for (const rel of outgoing) {
      const resolution = await resolveRelationTarget({ to_entity_id: rel.to_entity_id, resolved_at_write: rel.resolved_at_write, user_id, agent_id, run_id });
      edges.push({ from: entityId, to: rel.to_entity_id, relation: rel.relation, direction: "outgoing", hop: hop + 1, status: resolution.status, scopeLabel: resolution.scopeLabel });
      if (resolution.status === "ok" && !visited.has(rel.to_entity_id)) {
        visited.add(rel.to_entity_id);
        queue.push({ entityId: rel.to_entity_id, hop: hop + 1 });
      }
    }
    const referencing = await findReferencingEntities({ user_id, agent_id, run_id, entity_id: entityId });
    for (const ref of referencing) {
      edges.push({ from: ref.fromEntityId, to: entityId, relation: ref.relation, direction: "incoming", hop: hop + 1, status: "ok" });
      if (!visited.has(ref.fromEntityId)) {
        visited.add(ref.fromEntityId);
        queue.push({ entityId: ref.fromEntityId, hop: hop + 1 });
      }
    }
  }
  return edges;
}

// Compact renderer shared by mem0_get and mem0_search/mem0_list. Labels
// each unresolved reference with its specific reason per resolveRelationTarget
// (never_existed / deleted / wrong_scope) instead of a silent blank.
function formatRelatedEntities(edges) {
  if (!edges.length) return "";
  const lines = edges.map((e) => {
    const arrow = e.direction === "outgoing" ? "→" : "←";
    const other = e.direction === "outgoing" ? e.to : e.from;
    let suffix = "";
    if (e.status === "deleted") suffix = " (deleted)";
    else if (e.status === "never_existed") suffix = " (not found)";
    else if (e.status === "wrong_scope") suffix = ` (different scope: ${e.scopeLabel})`;
    return `  [hop ${e.hop}] ${e.relation} ${arrow} ${other}${suffix}`;
  });
  return `Related entities (up to ${RELATION_TRAVERSAL_DEPTH} hops):\n${lines.join("\n")}`;
}

// Shared by mem0_search/mem0_list's include_relations option. Only the top
// RELATION_RESOLVE_LIMIT results (by list position, i.e. rank) get a full
// traversal; the rest just show how many outgoing relations they have,
// unresolved, to avoid a full 3-hop resolution cost across an entire page
// of results.
async function buildRelationsSuffix(m, index, { user_id, agent_id, run_id }) {
  const entityId = m.metadata?.entity_id;
  if (!entityId) return "";
  const relCount = Array.isArray(m.metadata?.relations) ? m.metadata.relations.length : 0;
  if (index >= RELATION_RESOLVE_LIMIT) {
    return relCount ? `\n  (${relCount} outgoing relation${relCount === 1 ? "" : "s"}, unresolved — outside top ${RELATION_RESOLVE_LIMIT})` : "";
  }
  const edges = await traverseRelations(entityId, { user_id, agent_id, run_id });
  const rendered = formatRelatedEntities(edges);
  return rendered ? `\n${rendered}` : "";
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
      include_relations: z.boolean().optional().describe(`Default: false. If true, resolve and show each memory's related entities (up to ${RELATION_TRAVERSAL_DEPTH} hops, both outgoing and incoming) — but only for the top ${RELATION_RESOLVE_LIMIT} results by rank, to avoid a full multi-hop resolution cost across the whole page. Remaining results show an outgoing-relation count only. Unresolved targets are labeled deleted / not found / different scope rather than left blank.`),
    },
    async ({ user_id = MEM0_USER_ID, limit = 20, page = 1, categories, status_filter, fields, flagged_duplicates_only, include_relations = false }) => {
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
      if (!include_relations) {
        return { content: [{ type: "text", text: memories.map((m) => compactLine(m)).join("\n") }] };
      }
      const lines = [];
      for (let i = 0; i < memories.length; i++) {
        const suffix = await buildRelationsSuffix(memories[i], i, { user_id });
        lines.push(compactLine(memories[i]) + suffix);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
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
      let relatedSection = "";
      if (m.metadata?.entity_id) {
        const edges = await traverseRelations(m.metadata.entity_id, { user_id: m.user_id || MEM0_USER_ID, agent_id: m.agent_id, run_id: m.run_id });
        const rendered = formatRelatedEntities(edges);
        if (rendered) relatedSection = `\n\n${rendered}`;
      }
      const text =
        `ID: ${m.id}\n` +
        `Created: ${m.created_at?.slice(0, 10) || "unknown"} | Updated: ${m.updated_at?.slice(0, 10) || "unknown"}${cats}${tags}${eid}${status}${dup}\n\n` +
        (m.memory || m.text || "(no content)") +
        meta + relatedSection;
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
      entity_id:  z.string().optional().describe("Optional stable identifier for the fact/entity this memory is about (e.g. 'bug-4', 'nexus-file-naming'). BEFORE inventing a new one, search/list for an existing entity on the same topic — entity_id only prevents duplicates when it EXACTLY matches a string used before; a new entity_id for something that already has a different entity_id will NOT be caught by the exact-match check (though it will still get flagged by the Tier 2 similarity check below, so check the response for a possible_duplicate_of warning). If a memory already exists with this exact entity_id, mem0_add will NOT create a duplicate — it returns the existing memory's id and content instead, so you can merge old + new content yourself (keeping everything not explicitly contradicted) and call mem0_update. Use this whenever you're recording an update to something you've stored before, rather than adding a fresh mem0_add call."),
      status:     z.enum(STATUS_VALUES).optional().describe("Optional lifecycle status for this memory (open/resolved/superseded). Left unset by default. Memories marked \"superseded\" are hidden from mem0_list/mem0_search by default."),
      relations:  z.array(z.object({
        to_entity_id: z.string().describe("The entity_id of the other entity this one relates to"),
        relation: z.string().describe("The relation type, e.g. 'blocks', 'depends_on', 'relates_to' — free text; known synonyms/variants are canonicalized automatically, unrecognized strings pass through unchanged"),
      })).optional().describe("Optional list of relations from this memory's entity to others, e.g. [{to_entity_id:'bug-4', relation:'blocks'}]. Stored under metadata.relations. Requires this memory's own entity_id to be set for self-loop protection. Dangling to_entity_id values (no matching entity_id found yet) are flagged non-blocking, same as the existing dangling-ref-on-add behavior."),
      metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object to attach (e.g. {project: 'manager.js'})"),
      infer:      z.boolean().optional().describe("If true, uses Mem0's LLM extraction to atomize/rephrase the content into inferred facts instead of storing it verbatim. Default: false (stores content verbatim as a 'direct import') to prevent extraction from scattering or restructuring stored memories."),
      skip_duplicate_check: z.boolean().optional().describe("If true, skip the Tier 2 similarity check against existing memories. Default: false — the check runs automatically, including when entity_id is given but doesn't exactly match anything existing (a new entity_id gets checked too, not just untagged adds). Set true for bulk/import scenarios where the extra search call's latency isn't worth it."),
      duplicate_threshold:  z.number().optional().describe("Minimum relevance score (0-1) for an existing memory to be flagged as a possible duplicate of this one. Default: 0.75. Applies whenever skip_duplicate_check is false, regardless of entity_id. Note: regardless of this value, a candidate scoring >= 0.92 hard-blocks the add entirely (same as an exact entity_id match) rather than just flagging — see mem0_add's description."),
    },
    async ({ content, user_id = MEM0_USER_ID, agent_id, run_id, categories, entity_id, status, relations, metadata, infer = false, skip_duplicate_check = false, duplicate_threshold = 0.75 }) => {
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
      let relationWarnings = [];
      if (relations?.length) {
        const { relations: cleanedRelations, warnings } = await processRelations(relations, { ownEntityId: entity_id, user_id, agent_id, run_id });
        if (cleanedRelations.length) meta.relations = cleanedRelations;
        relationWarnings = warnings;
      }
      // Runs regardless of entity_id now — see the Tier 2 NOTE above. An
      // exact entity_id match already returned early, so reaching here with
      // entity_id set means it's a *new* entity_id, which still needs this
      // semantic check the same as an untagged add would.
      if (!skip_duplicate_check) {
        const candidates = await findPossibleDuplicates({ user_id, agent_id, run_id, content, threshold: duplicate_threshold });
        const blocking = candidates.filter((c) => c.score >= BLOCKING_DUPLICATE_THRESHOLD);
        if (blocking.length) {
          const top = blocking[0];
          return {
            content: [{
              type: "text",
              text:
                `Not adding — content is near-identical (score ${top.score.toFixed(2)} >= ${BLOCKING_DUPLICATE_THRESHOLD}) to existing memory ${top.id}. Hard-blocked, same as an exact entity_id match — no duplicate was created.\n\n` +
                `Existing content:\n${top.memory || top.text || "(no content)"}\n\n` +
                `New content you were about to add:\n${content}\n\n` +
                `Next step: merge these two yourself — keep everything from the existing content that the new content doesn't explicitly contradict — then call mem0_update with memory_id="${top.id}" and the merged text. If this really is distinct content despite the score, retry with skip_duplicate_check:true.`,
            }],
          };
        }
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
      const relationNote = relationWarnings.length ? `\n\n⚠ Relations:\n${relationWarnings.map((w) => `  ${w}`).join("\n")}` : "";
      return {
        content: [{
          type: "text",
          text: (eventId
            ? `Memory extraction started (event_id: ${eventId}).${landedNote}`
            : `Memory added: ${JSON.stringify(data)}`) + duplicateWarning + relationNote,
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
        relations:  z.array(z.object({
          to_entity_id: z.string().describe("The entity_id of the other entity this one relates to"),
          relation: z.string().describe("The relation type — see mem0_add's relations param."),
        })).optional().describe("Optional list of relations for this item — see mem0_add's relations param."),
        metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object for this memory"),
        infer:      z.boolean().optional().describe("If true, uses Mem0's LLM extraction to atomize/rephrase the content instead of storing it verbatim. Default: false."),
        skip_duplicate_check: z.boolean().optional().describe("If true, skip the Tier 2 similarity check for this item (only relevant when no entity_id is given). Default: false."),
        duplicate_threshold:  z.number().optional().describe("Minimum relevance score (0-1) to flag an existing memory as a possible duplicate of this item. Default: 0.75."),
      })).min(1).describe("List of memories to add"),
    },
    async ({ items }) => {
      const results = await Promise.allSettled(items.map(async ({ content, user_id = MEM0_USER_ID, agent_id, run_id, categories, entity_id, status, relations, metadata, infer = false, skip_duplicate_check = false, duplicate_threshold = 0.75 }) => {
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
        let relationWarnings = [];
        if (relations?.length) {
          const { relations: cleanedRelations, warnings } = await processRelations(relations, { ownEntityId: entity_id, user_id, agent_id, run_id });
          if (cleanedRelations.length) meta.relations = cleanedRelations;
          relationWarnings = warnings;
        }
        let duplicatesFlagged = null;
        // See Tier 2 NOTE above — runs regardless of entity_id, since a *new*
        // entity_id needs semantic dup protection just as much as an untagged add.
        if (!skip_duplicate_check) {
          const candidates = await findPossibleDuplicates({ user_id, agent_id, run_id, content, threshold: duplicate_threshold });
          const blocking = candidates.filter((c) => c.score >= BLOCKING_DUPLICATE_THRESHOLD);
          if (blocking.length) {
            const top = blocking[0];
            return { skipped: true, blocked: true, existingId: top.id, existingScore: top.score, existingContent: top.memory || top.text || "(no content)" };
          }
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
        return { ...result, duplicatesFlagged, relationWarnings, landed: !!landed, landedId: landed?.id };
      }));
      const lines = results.map((r, i) => {
        const title = (items[i].content || "").split("\n")[0].slice(0, 60);
        if (r.status === "fulfilled") {
          if (r.value?.skipped) {
            if (r.value.blocked) {
              return `⛔ [${i}] "${title}" — blocked, near-identical (score ${r.value.existingScore.toFixed(2)}) to existing memory (id: ${r.value.existingId}). No duplicate created. Merge and call mem0_update yourself if this content adds anything new.`;
            }
            return `⏭ [${i}] "${title}" — skipped, entity_id "${r.value.entity_id}" already exists (id: ${r.value.existingId}). Merge and call mem0_update yourself if this content adds anything new.`;
          }
          const eventId = r.value.event_id || r.value.id || "ok";
          const dupNote = r.value.duplicatesFlagged?.length ? ` ⚠ flagged as possible duplicate of ${r.value.duplicatesFlagged.join(", ")}` : "";
          const relNote = r.value.relationWarnings?.length ? ` ⚠ relations: ${r.value.relationWarnings.join("; ")}` : "";
          const landedNote = r.value.landed ? ` — confirmed landed (id: ${r.value.landedId})` : ` — ⚠ could not confirm this landed, check manually`;
          return `✓ [${i}] "${title}" — event_id: ${eventId}${dupNote}${relNote}${landedNote}`;
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
      agent_id:       z.string().optional().describe("Optional agent ID to scope search (e.g. per-project), in addition to user_id. Scoping at query time — not just at write time — meaningfully improves precision by excluding irrelevant projects/entities from the candidate pool before ranking even starts."),
      run_id:         z.string().optional().describe("Optional run/session ID to scope search, in addition to user_id."),
      limit:          z.number().optional().describe("Number of results to return (default: 10)"),
      categories:     z.array(z.string()).optional().describe("Optional tag filters (memory must match any listed tag; matched client-side against metadata.tags, not Mem0's built-in classifier categories)"),
      status_filter:  z.array(z.enum(STATUS_VALUES)).optional().describe("Optional status filter (memory must match one of the listed statuses). If omitted, defaults to excluding status=\"superseded\" (memories with no status set are always included). Pass e.g. [\"superseded\"] to explicitly see superseded memories."),
      rerank:         z.boolean().optional().describe("Whether to apply Mem0's relevance reranking on top of hybrid retrieval. Default: true — reranking meaningfully improves precision and is now the connector default rather than opt-in; pass false to skip it if latency matters more than precision for a given call."),
      threshold:      z.number().optional().describe("Minimum relevance score (0-1) — results below this are dropped. Default: 0.35 (raised from Mem0 v3's own default of 0.1, which let through too much low-relevance noise). Pass 0 explicitly to disable filtering and see everything Mem0 returns."),
    },
    async ({ query, user_id = MEM0_USER_ID, agent_id, run_id, limit = 10, categories, status_filter, rerank = true, threshold = 0.35 }) => {
      const filters = { user_id };
      if (agent_id) filters.agent_id = agent_id;
      if (run_id) filters.run_id = run_id;
      // Over-fetch since tag/status filtering happens client-side (status
      // default-exclusion of "superseded" always applies, so always over-fetch
      // a bit even with no explicit categories/status_filter given).
      const fetchLimit = Math.max(limit * 3, limit + 20);
      const body = { query, filters, top_k: fetchLimit };
      if (rerank) body.rerank = true;
      if (threshold > 0) body.threshold = threshold;
      const data = await mem0Request("/v3/memories/search/", { method: "POST", body });
      let memories = data.results || data.memories || data || [];
      memories = filterByTags(memories, categories);
      memories = filterByStatus(memories, status_filter).slice(0, limit);
      if (!memories.length) return { content: [{ type: "text", text: "No memories found matching your query." }] };
      return { content: [{ type: "text", text: memories.map((m) => compactLine(m, { showScore: true })).join("\n") }] };
    }
  );

  // ── Update memory ────────────────────────────────────────────────────────
  // NOTE on `replacements` (2026-07-13): mem0_update previously only
  // supported a full-content replace, which meant any edit — even a
  // one-clause fix — required the caller to regenerate and resend the
  // entire memory body. Mem0's own PUT /v1/memories/{id}/ endpoint is a
  // full replace with no field/substring PATCH, so a GET+PUT round trip is
  // unavoidable either way — but the *caller-side* cost of reproducing the
  // whole document was the real bottleneck, not the API call count. This
  // mirrors the github connector's str_replace_file: send only find/replace
  // pairs, apply them to the fetched current content, PUT the result. Each
  // `find` must appear exactly once in the current content (same safety
  // rule as str_replace_file) — ambiguous or missing matches fail loudly
  // rather than silently no-op'ing or replacing the wrong occurrence.
  // Mutually exclusive with `content`: pick one mode per call.
  server.tool(
    "mem0_update",
    "Update an existing Mem0 memory by ID: replace its content (in full, or via targeted find/replace edits), change its status, or both. At least one of content/replacements/status must be given. `content` and `replacements` are mutually exclusive — use `replacements` for small edits to avoid resending the whole memory body.",
    {
      memory_id: z.string().describe("The memory ID to update"),
      content:   z.string().optional().describe("New content for the memory (replaces existing content in full). Omit to change only the status, or use `replacements` for a targeted edit instead. Mutually exclusive with `replacements`."),
      replacements: z.array(z.object({
        find:    z.string().describe("Exact string to find in the current memory content — must appear exactly once"),
        replace: z.string().describe("String to replace it with"),
      })).optional().describe("List of find-and-replace operations to apply sequentially to the memory's current content, without resending the full body. Each `find` must match exactly once in the content at the time it's applied (fails loudly on zero or multiple matches, same rule as the github str_replace_file tool). Mutually exclusive with `content`."),
      status:    z.enum(STATUS_VALUES).optional().describe("New lifecycle status (open/resolved/superseded) for this memory. Omit to leave status unchanged. Existing tags/entity_id/other metadata are preserved regardless."),
      relations: z.array(z.object({
        to_entity_id: z.string().describe("The entity_id of the other entity this one relates to"),
        relation: z.string().describe("The relation type — see mem0_add's relations param."),
      })).optional().describe("New relations for this memory's entity — REPLACES the existing metadata.relations array whole (not merged). Omit to leave relations unchanged. Canonicalized the same way as mem0_add's relations param. Pass an empty array to clear all relations."),
    },
    async ({ memory_id, content, replacements, status, relations }) => {
      if (content === undefined && replacements === undefined && status === undefined) {
        return {
          content: [{ type: "text", text: "Nothing to update — provide content, replacements, status, or a combination of replacements and status." }],
          isError: true,
        };
      }
      if (content !== undefined && replacements !== undefined) {
        return {
          content: [{ type: "text", text: "Provide either content or replacements, not both — they're mutually exclusive update modes." }],
          isError: true,
        };
      }
      // Mem0's PUT replaces the whole metadata object, so fetch current
      // metadata first and merge in the status change client-side, rather
      // than risk wiping out tags/entity_id set at add-time. This fetch also
      // supplies the base text that `replacements` is applied against.
      const current = await mem0Request(`/v1/memories/${memory_id}/`);
      let finalText = current.memory || current.text || "";
      if (content !== undefined) {
        finalText = content;
      } else if (replacements !== undefined) {
        for (const { find, replace } of replacements) {
          const count = finalText.split(find).length - 1;
          if (count === 0) {
            return {
              content: [{ type: "text", text: `Update aborted, nothing written — "${find.slice(0, 60)}${find.length > 60 ? "…" : ""}" was not found in the current memory content. Content may have changed since you last read it — re-fetch with mem0_get and retry.` }],
              isError: true,
            };
          }
          if (count > 1) {
            return {
              content: [{ type: "text", text: `Update aborted, nothing written — "${find.slice(0, 60)}${find.length > 60 ? "…" : ""}" appears ${count} times in the current memory content, but must be unique. Include more surrounding context in "find" to disambiguate.` }],
              isError: true,
            };
          }
          finalText = finalText.replace(find, replace);
        }
      }
      let relationWarnings = [];
      const metadataUpdates = { ...(status !== undefined ? { status } : {}) };
      if (relations !== undefined) {
        const { relations: cleanedRelations, warnings } = await processRelations(relations, { ownEntityId: current.metadata?.entity_id, user_id: current.user_id || MEM0_USER_ID, agent_id: current.agent_id, run_id: current.run_id });
        metadataUpdates.relations = cleanedRelations;
        relationWarnings = warnings;
      }
      const finalMetadata = { ...current.metadata, ...metadataUpdates };
      const body = { text: finalText };
      if (Object.keys(finalMetadata).length) body.metadata = finalMetadata;
      const data = await mem0Request(`/v1/memories/${memory_id}/`, { method: "PUT", body });
      const parts = [];
      if (content !== undefined) parts.push("content replaced in full");
      if (replacements !== undefined) parts.push(`${replacements.length} targeted edit${replacements.length === 1 ? "" : "s"} applied`);
      if (status !== undefined) parts.push(`status set to "${status}"`);
      if (relations !== undefined) parts.push(`relations replaced (${metadataUpdates.relations.length} stored)`);
      const relationNote = relationWarnings.length ? `\n\n⚠ Relations:\n${relationWarnings.map((w) => `  ${w}`).join("\n")}` : "";
      return { content: [{ type: "text", text: `Updated memory (ID: ${data.id || memory_id}) — ${parts.join(", ")}.\nUpdated: ${data.updated_at?.slice(0, 10) || "unknown"}${relationNote}` }] };
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
