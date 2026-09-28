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
// rev 2 — storage/write-side only, see madmcp-mem0-relations-plan):
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
// NOTE on metadata_patch/metadata_delete_keys (2026-07-13, closes the Part 5
// tooling gap found during a live consolidation pass): mem0_update
// previously had no way to touch metadata beyond status/relations — it
// could merge in a new status or replace the whole relations array, both
// additive/replace operations on specific known fields, but nothing generic.
// That meant a memory flagged possible_duplicate_of at add-time (Tier 2)
// stayed flagged forever once reviewed, even when the flag turned out to be
// a false positive (candidate was topically related but not actually
// duplicate content) or referenced a candidate ID that had since been
// deleted — both observed on the same flagged memory during the first real
// Part 5 pass. Rather than bolt on a single-purpose boolean for just that
// one field, metadata_patch (shallow-merge arbitrary keys) and
// metadata_delete_keys (remove arbitrary keys) generalize this the same way
// mem0_add's own `metadata` param already does on write — so any future
// custom field can be fixed or cleared without a new tool param each time.
// clear_duplicate_flag is kept as a thin convenience alias (shorthand for
// metadata_delete_keys: ['possible_duplicate_of']) since it was the
// motivating case and reads more clearly for that specific action. Both
// patch and delete use the same fetch-merge-PUT pattern as status/relations
// (patch applied first, then deletes, so a key could theoretically be
// patched and deleted in the same call, though that's not a real use case).
//
// NOTE on relations traversal/read-side (2026-07-13, completes
// madmcp-mem0-relations-plan's relational-info step):
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
import { register as registerDelete } from "./delete.js";
import { register as registerWrite } from "./write.js";

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

// REGRESSION FIX (2026-07-13, see madmcp-mem0-relations-plan): the
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
// REGRESSION FIX (2026-07-13, see madmcp-mem0-relations-plan and the note
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

// NOTE on add-then-verify (2026-07-10, following madmcp-mem0-add-silent-
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

  // ── Find memories (list / search) ────────────────────────────────────────
  // Consolidates the former mem0_list and mem0_search (action: list | search).
  // Requests and output are unchanged; required-ness (query for 'search')
  // moved from zod into the handler.
  server.tool(
    "mem0_find",
    "DOES: List recent memories or search them semantically in your Mem0 workspace. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'list' returns recent memories (paginated) as compact one-line entries and needs no other params. NOT a relevance query — use 'search' for that.\n" +
    "RULE: action 'search' requires query and runs hybrid semantic + keyword retrieval, returning compact one-line entries with relevance scores.\n" +
    "RULE: user_id, limit, categories and status_filter apply to both actions. page, fields, flagged_duplicates_only and include_relations apply to 'list' only; query, agent_id, run_id, rerank and threshold apply to 'search' only.\n" +
    "RULE: memories with status 'superseded' are hidden by default (memories with no status are always shown); pass status_filter to include them.",
    {
      action:         z.enum(["list", "search"]).describe("Which operation to perform"),
      query:          z.string().optional().describe("Search query string. Required for action 'search'."),
      user_id:        z.string().optional().describe(`Mem0 user ID to scope memories (default: ${MEM0_USER_ID})`),
      agent_id:       z.string().optional().describe("Optional agent ID to scope search (e.g. per-project), in addition to user_id. Scoping at query time — not just at write time — meaningfully improves precision by excluding irrelevant projects/entities from the candidate pool before ranking even starts. Used by 'search' only."),
      run_id:         z.string().optional().describe("Optional run/session ID to scope search, in addition to user_id. Used by 'search' only."),
      limit:          z.number().optional().describe("Number of memories to return (default: 20)"),
      page:           z.number().optional().describe("Page number for pagination (default: 1). Used by 'list' only."),
      categories:     z.array(z.string()).optional().describe("Optional tag filters (memory must match any listed tag; matched client-side against metadata.tags, not Mem0's built-in classifier categories)"),
      status_filter:  z.array(z.enum(STATUS_VALUES)).optional().describe("Optional status filter (memory must match one of the listed statuses). If omitted, defaults to excluding status 'superseded' (memories with no status set are always included). Pass e.g. ['superseded'] to explicitly see superseded memories, or ['open'] to narrow to just open ones."),
      fields:         z.array(z.string()).optional().describe("Optional list of fields to return per memory (server-side projection to reduce payload size), e.g. ['id','memory','created_at']. Used by 'list' only."),
      flagged_duplicates_only: z.boolean().optional().describe("If true, only return memories flagged at add-time as possible duplicates of another memory (metadata.possible_duplicate_of non-empty) — useful for a periodic consolidation pass (Part 5 of the anti-bloat plan). Used by 'list' only."),
      include_relations: z.boolean().optional().describe(`Default: false. If true, resolve and show each memory's related entities (up to ${RELATION_TRAVERSAL_DEPTH} hops, both outgoing and incoming) — but only for the top ${RELATION_RESOLVE_LIMIT} results by rank, to avoid a full multi-hop resolution cost across the whole page. Remaining results show an outgoing-relation count only. Unresolved targets are labeled deleted / not found / different scope rather than left blank. Used by 'list' only.`),
      rerank:         z.boolean().optional().describe("Whether to apply Mem0's relevance reranking on top of hybrid retrieval. Default: true — reranking meaningfully improves precision and is now the connector default rather than opt-in; pass false to skip it if latency matters more than precision for a given call. Used by 'search' only."),
      threshold:      z.number().optional().describe("Minimum relevance score (0-1) — results below this are dropped. Default: 0.35 (raised from Mem0 v3's own default of 0.1, which let through too much low-relevance noise). Pass 0 explicitly to disable filtering and see everything Mem0 returns. Used by 'search' only."),
    },
    async ({ action, query, user_id = MEM0_USER_ID, agent_id, run_id, limit = 20, page = 1, categories, status_filter, fields, flagged_duplicates_only, include_relations = false, rerank = true, threshold = 0.35 }) => {

      if (action === "list") {
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

      // action === "search"
      if (query === undefined) {
        return { content: [{ type: "text", text: "action 'search' requires query." }], isError: true };
      }
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

  // ── Inspect one memory / entity ──────────────────────────────────────────
  // Consolidates the former mem0_get, mem0_get_history and mem0_get_relations
  // (action: get | history | relations). Output and requests are unchanged;
  // required-ness moved from zod into the handler.
  server.tool(
    "mem0_inspect",
    "DOES: Inspect one Mem0 memory or entity. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'get' requires memory_id and returns the memory's full content, categories/tags/entity_id/status/duplicate flags, metadata, and (when it has an entity_id) its related entities up to 3 hops, both directions.\n" +
    "RULE: action 'history' requires memory_id and returns the version/audit trail — every ADD/UPDATE/DELETE event with old/new values and timestamps (wraps Mem0's native history endpoint).\n" +
    "RULE: action 'relations' requires entity_id and returns the complete relation graph (up to 3 hops, both outgoing and incoming) around that entity, bypassing the top-5 results cap that mem0_find's list include_relations has.\n" +
    "RULE: memory_id applies to 'get' and 'history' only; entity_id/user_id/agent_id/run_id apply to 'relations' only.",
    {
      action:    z.enum(["get", "history", "relations"]).describe("Which operation to perform"),
      memory_id: z.string().optional().describe("The memory ID (from mem0_find). Required for actions 'get' and 'history'."),
      entity_id: z.string().optional().describe("The entity_id to resolve relations for. Required for action 'relations'."),
      user_id:   z.string().optional().describe(`Mem0 user ID scoping (default: ${MEM0_USER_ID}). Used by 'relations' only.`),
      agent_id:  z.string().optional().describe("Optional agent ID scoping. Used by 'relations' only."),
      run_id:    z.string().optional().describe("Optional run/session ID scoping. Used by 'relations' only."),
    },
    async ({ action, memory_id, entity_id, user_id = MEM0_USER_ID, agent_id, run_id }) => {

      if (action === "get") {
        if (!memory_id) {
          return { content: [{ type: "text", text: "action 'get' requires memory_id." }], isError: true };
        }
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

      if (action === "history") {
        if (!memory_id) {
          return { content: [{ type: "text", text: "action 'history' requires memory_id." }], isError: true };
        }
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

      // action === "relations"
      if (!entity_id) {
        return { content: [{ type: "text", text: "action 'relations' requires entity_id." }], isError: true };
      }
      const memory = await findByEntityId({ user_id, agent_id, run_id, entity_id });
      const edges = await traverseRelations(entity_id, { user_id, agent_id, run_id });
      if (!edges.length && !memory) {
        return { content: [{ type: "text", text: `No entity found with entity_id "${entity_id}" and no relations recorded.` }] };
      }
      const rendered = formatRelatedEntities(edges);
      const memoryHeader = memory
        ? `Entity: ${entity_id} (memory ID: ${memory.id})\nContent preview: ${(memory.memory || memory.text || "").slice(0, 120)}\n\n`
        : `Entity: ${entity_id} (no memory record currently found in scope, but relations reference it)\n\n`;
      const text = memoryHeader + (rendered || "No relations found (up to 3 hops).");
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Write tools (add / add_batch / update) ────────────────────────────────────────────────────────
  // mem0_add / mem0_add_batch / mem0_update were consolidated into one
  // mem0_write tool (action: add | add_batch | update) — see ./write.js. The
  // shared helpers it relies on are passed in (not imported) to avoid a
  // circular import.
  registerWrite(server, { STATUS_VALUES, BLOCKING_DUPLICATE_THRESHOLD, findByEntityId, processRelations, findPossibleDuplicates, verifyLanded });

  // ── Delete tools ─────────────────────────────────────────────────────────
  // mem0_delete / mem0_delete_batch / mem0_delete_all were consolidated into
  // one mem0_delete tool (action: one | batch | all) — see ./delete.js.
  registerDelete(server);}
