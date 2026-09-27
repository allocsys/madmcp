// ---------------------------------------------------------------------------
// connectors/notion/client.js
// ---------------------------------------------------------------------------

import { NOTION_TOKEN, NOTION_API, NOTION_VERSION, NOTION_INDEX_DATABASE_ID, NOTION_SYNC_PARENT_PAGE_ID, GEMINI_NOTION_ROOT_PAGE_ID, NOTION_MIN_REQUEST_INTERVAL_MS, NOTION_MAX_RETRIES, NOTION_RETRY_BASE_MS } from "../../config.js";

import { createThrottle, sleep, defaultRetryDelayMs } from "../shared/rate-limit.js";

// --- Throttle + retry (fix #3, 2026-07-27) ----------------------------------
// One shared queue for the whole process -- see createThrottle's own header
// for why a fresh throttle per call would be pointless. Spaces out every
// outgoing Notion request (even ones issued concurrently, e.g. several
// Notion calls in the same parallelized delegate_agent step) by at least
// NOTION_MIN_REQUEST_INTERVAL_MS, and retries 429/transient-5xx responses
// with backoff instead of throwing on the first hit. Mirrors
// connectors/github/client.js's scheduleThrottled + retry loop, which Notion
// (and Mem0, see connectors/mem/client.js) previously had no equivalent of.
const scheduleThrottled = createThrottle(NOTION_MIN_REQUEST_INTERVAL_MS);

// 429 is Notion's documented rate-limit response. 502/503/504 are treated as
// transient upstream/proxy hiccups worth one retry, same spirit as GitHub's
// isRetryable -- anything else (400 malformed request, 401/403 auth, 404
// unknown resource) is a real error and should surface immediately,
// unretried.
function isRetryableNotion(res) {
  return res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
}

async function doNotionFetch(path, { method, body }) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization:    `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type":   "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { res, data };
}

export const NOTION_FALLBACK_ID_ALERTS = {
  NOTION_INDEX_DATABASE_ID: NOTION_INDEX_DATABASE_ID,
  NOTION_SYNC_PARENT_PAGE_ID: NOTION_SYNC_PARENT_PAGE_ID,
  GEMINI_NOTION_ROOT_PAGE_ID: GEMINI_NOTION_ROOT_PAGE_ID,
};

function maybeAlertOnFallbackId404(status, path) {
  if (status !== 404) return;
  for (const name of Object.keys(NOTION_FALLBACK_ID_ALERTS)) {
    const id = NOTION_FALLBACK_ID_ALERTS[name];
    if (id && path.includes(id)) {
      console.error('ALERT: Notion 404 on hardcoded fallback ID ' + name + ' (' + id + '), path=' + path + '. The underlying Notion page/database may have been deleted, unshared, or moved -- see config.js for the recovery/override steps.');
    }
  }
}

export async function notionRequest(path, { method = "GET", body } = {}) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN is not set. Add it as an environment variable on the madmcp server.");

  let lastErr;
  for (let attempt = 0; attempt <= NOTION_MAX_RETRIES; attempt++) {
    const { res, data } = await scheduleThrottled(() => doNotionFetch(path, { method, body }));

    if (res.ok) return data;

    maybeAlertOnFallbackId404(res.status, path);

    if (isRetryableNotion(res) && attempt < NOTION_MAX_RETRIES) {
      await sleep(defaultRetryDelayMs(res, attempt, NOTION_RETRY_BASE_MS));
      lastErr = res;
      continue;
    }

    const message = (data && (data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`Notion API error (${res.status}): ${message}`);
  }

  // Exhausted retries.
  throw new Error(`Notion API error (${lastErr ? lastErr.status : 429}): rate limited -- exhausted ${NOTION_MAX_RETRIES} retries`);
}

export function notionRichTextToString(richText = []) {
  return richText.map((t) => t.plain_text || "").join("");
}

// ---------------------------------------------------------------------------
// Intra-module call indirection (2026-09-27, Phase 1C -- see
// test/notion-checkpoint.test.js's header comment for the full ESM mocking
// limitation this works around).
//
// vi.mock("./client.js") replaces this module's notionRequest EXPORT for
// every OTHER module that imports it -- that's how tools.js's calls get
// mocked in tests today. But a function defined IN THIS FILE that calls the
// local `notionRequest` declaration directly binds to it at parse time; that
// reference is never routed through the exported/mocked namespace object, so
// vi.mock can't intercept it. Any function in this file that calls
// notionRequest should go through `clientInternals.notionRequest(...)`
// instead of the bare name -- that's a property lookup resolved at CALL
// time, which a test's mock factory CAN override (see
// notion-checkpoint.test.js, which replaces clientInternals.notionRequest
// with the same vi.fn() used for the notionRequest export, so both stay in
// sync and existing `client.notionRequest.mockImplementation(...)` calls
// keep working unchanged).
export const clientInternals = { notionRequest };


// ---------------------------------------------------------------------------
// Rich-text chunking (2026-07-18, bug found via live sync_mem0_to_notion
// test -- a 2217-char mem0 memory line was sent as a single rich_text
// segment and rejected outright by Notion's API, which caps
// rich_text[].text.content at 2000 chars PER SEGMENT). Every paragraph-block
// builder in this file that wraps arbitrary-length text (mem0 content,
// append_content, direct notion_create_page content) must go through this
// instead of building a single {text:{content}} segment, since none of
// those inputs have a length guarantee. Multiple segments in one rich_text
// array render as one continuous paragraph, so this doesn't change how the
// content looks -- it just avoids the hard API rejection.
const RICH_TEXT_MAX = 2000;

export function chunkRichText(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > RICH_TEXT_MAX) {
    // Prefer breaking at the last space within the limit so words aren't
    // split mid-word; fall back to a hard cut if there's no space at all
    // (e.g. a single unbroken token longer than the limit).
    let cut = rest.lastIndexOf(" ", RICH_TEXT_MAX);
    if (cut <= 0) cut = RICH_TEXT_MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  chunks.push(rest);
  return chunks.map((c) => ({ type: "text", text: { content: c } }));
}

// Shared paragraph-block builder using the chunking above. Every spot in
// this file and tools.js that was building `{ object: "block", type:
// "paragraph", paragraph: { rich_text: [{ type: "text", text: { content:
// text } }] } }` for arbitrary-length input now goes through this instead.
export function textBlock(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: chunkRichText(text) } };
}

export function notionPageTitle(page) {
  const titleProp = Object.values(page.properties || {}).find((p) => p.type === "title");
  return titleProp ? notionRichTextToString(titleProp.title) : "(untitled)";
}

// Databases carry their title directly on the object (a top-level `title`
// rich-text array), not nested inside `properties` like pages -- so this
// can't reuse notionPageTitle().
export function notionDatabaseTitle(database) {
  return notionRichTextToString(database.title) || "(untitled)";
}

// ---------------------------------------------------------------------------
// Entity marker convention (2026-07-17, notion connector gap-closing plan --
// see mem0 entity_id: madmcp-notion-connector-gaps-roadmap, gaps #1/#2/#3).
// Notion pages outside a database only have a single built-in property
// (title) -- there's no way to attach a real entity_id/status field the way
// mem0's metadata object does. Instead both are stored as plain,
// human-readable marker paragraph blocks at the very top of a page's
// content:
//   🔑 entity_id: some-stable-key
//   🏷️ status: open|resolved|superseded
// This is a convention, not a Notion API feature -- visible to humans
// browsing the page (unlike hiding it in a code block), and searchable via
// notion_search's normal query mechanism, though (same caveat mem0's own
// tags/entity_id-in-metadata carries) that search is best-effort, not a
// guaranteed exact-match index -- see findPageByEntityId below.
const ENTITY_MARKER_PREFIX = "🔑 entity_id:";
const STATUS_MARKER_PREFIX = "🏷️ status:";

export function buildMarkerBlocks({ entity_id, status } = {}) {
  const blocks = [];
  if (entity_id) {
    blocks.push({
      object: "block", type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: `${ENTITY_MARKER_PREFIX} ${entity_id}` } }] },
    });
  }
  if (status) {
    blocks.push({
      object: "block", type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: `${STATUS_MARKER_PREFIX} ${status}` } }] },
    });
  }
  return blocks;
}

export function statusMarkerBlock(status) {
  return {
    object: "block", type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: `${STATUS_MARKER_PREFIX} ${status}` } }] },
  };
}

// Same pattern as statusMarkerBlock -- lets a caller PATCH the entity_id
// marker block in place (notion_update_page's new entity_id param, bug fix
// 2026-08-07: see notion_create_page's findPageByEntityId comment). Needed
// so that correcting an entity_id post-creation goes through the SAME
// marker-block text this file's own parseMarkers reads, instead of a caller
// hand-building the marker text via generic `replacements` (which edits the
// visible block but has no way to also touch the dedup index -- that
// disconnect was the root cause of relation targets resolving as "dangling"
// even after the visible marker was corrected).
export function entityMarkerBlock(entity_id) {
  return {
    object: "block", type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: `${ENTITY_MARKER_PREFIX} ${entity_id}` } }] },
  };
}

// Generic plain-text extractor for any block type -- used by both marker
// parsing below and the replacements find/replace matching in
// notion_update_page, so all three features see block text consistently.
// Returns raw unprefixed text (not the "# " / "• " display formatting
// notionBlocksToText adds), since this is for exact-match comparison, not
// rendering.
export function notionBlockPlainText(b) {
  const type  = b.type;
  const block = b[type];
  if (!block) return "";
  if (type === "child_page" || type === "child_database") return block.title || "";
  return notionRichTextToString(block.rich_text || []);
}

// Scans a page's top-level blocks for our marker convention. Only matches
// paragraph blocks starting with the known prefixes -- doesn't try to infer
// markers out of arbitrary user-written paragraphs that happen to look
// similar. Returns the block IDs too so callers can PATCH them directly
// instead of re-searching by text (avoids the replacements uniqueness
// requirement for what's already an unambiguous, known-location marker).
export function parseMarkers(blocks = []) {
  const result = { entity_id: null, status: null, entityBlockId: null, statusBlockId: null };
  for (const b of blocks) {
    if (b.type !== "paragraph") continue;
    const text = notionRichTextToString(b.paragraph?.rich_text || []);
    if (text.startsWith(ENTITY_MARKER_PREFIX) && !result.entity_id) {
      result.entity_id     = text.slice(ENTITY_MARKER_PREFIX.length).trim();
      result.entityBlockId = b.id;
    } else if (text.startsWith(STATUS_MARKER_PREFIX) && !result.status) {
      result.status         = text.slice(STATUS_MARKER_PREFIX.length).trim();
      result.statusBlockId  = b.id;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// (2026-09-27, Phase 1C cleanup: the old page-based index's marker-format
// reader/writer -- buildIndexEntryText/parseIndexEntryText, prefix "📇 " --
// was removed here. It was superseded by the Entity Index DATABASE on
// 2026-07-24 (see NOTION_INDEX_DATABASE_ID's comment in config.js) and
// confirmed to have zero remaining call sites anywhere in the repo via
// search_code before deletion -- nothing writes or reads that text format
// anymore, so there was no live data left to stay backward-compatible with.

// ---------------------------------------------------------------------------
// Dedup/upsert lookup (2026-07-17, gap #1; database rewrite 2026-07-24 --
// see mem0 entity_id: madmcp-notion-connector-gaps-roadmap).
//
// Lives here rather than in tools.js because it's pure client-layer logic --
// it only ever calls notionRequest against the index database, nothing
// tool-specific. Calls go through clientInternals.notionRequest (see that
// object's own comment above), not the bare notionRequest name, so this
// stays mockable the same way every other client.js function above it is.
//
// FIRST FIX 2026-07-17: the original implementation leaned on notion_search
// to find candidate pages by entity_id text. Live testing confirmed that's
// fundamentally broken -- Notion's search index has real lag, and searching
// for an entity_id string immediately after creating that page (the most
// common dedup scenario) reliably returns zero results. Fixed by reading a
// dedicated index page's own blocks directly (uncached, no search lag).
//
// SECOND FIX 2026-07-24: the page-based index inherited a new gap it
// documented at the time -- /blocks/{id}/children pagination caps a single
// page's readable blocks at 100, so an index page with more than ~100
// tracked entities would silently stop finding older entries. A real Notion
// database queried via /databases/{id}/query with a filter on EntityId is
// just as immediately-consistent (no search-index lag either way, since
// this never goes through notion_search) but isn't bound by that 100-block
// limit -- database queries paginate independently of page block counts.
export async function findPageByEntityId(entity_id) {
  let rows;
  try {
    const data = await clientInternals.notionRequest(`/databases/${NOTION_INDEX_DATABASE_ID}/query`, {
      method: "POST",
      body: { filter: { property: "EntityId", rich_text: { equals: entity_id } }, page_size: 1 },
    });
    rows = data.results || [];
  } catch (err) {
    // Fail loudly rather than silently falling back to nothing found --
    // silently treating "index unreachable" as "no duplicate exists" would
    // just reintroduce the exact bug this fix is for.
    throw new Error(`Notion entity index database (${NOTION_INDEX_DATABASE_ID}) is unreachable, so entity_id dedup can't be verified: ${err.message}. Fix NOTION_INDEX_DATABASE_ID / the database's sharing settings before creating entity-tracked pages.`, { cause: err });
  }
  if (!rows.length) return null;
  const row = rows[0];
  const page_id = notionRichTextToString(row.properties?.PageId?.rich_text || []);
  if (!page_id) return null;
  try {
    const page = await clientInternals.notionRequest(`/pages/${page_id}`);
    const blocksData = await clientInternals.notionRequest(`/blocks/${page_id}/children?page_size=20`);
    const markers = parseMarkers(blocksData.results || []);
    return { pageId: page_id, title: notionPageTitle(page), url: page.url, markers };
  } catch {
    // Stale index row (target page deleted/archived outside these tools) --
    // treat as not-found so a fresh page can be created, rather than
    // erroring out on a dangling reference.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reads every row of the Entity Index database (NOTION_INDEX_DATABASE_ID),
// paginated. Added 2026-07-24 alongside the page->database dedup-index
// migration (see config.js's NOTION_INDEX_DATABASE_ID comment) to give
// callers that need the FULL set of tracked entities -- not a single
// entity_id lookup (that's findPageByEntityId above) -- a supported way to
// read it. Before this, linking.js's findTagOverlapCandidates and
// sync/mem0_notion.js's readSyncedIndexEntries both kept reading raw blocks
// off the old page-based index directly instead, which silently stopped
// reflecting reality the moment writes moved to the database: new entries
// were never appended to the old page, so both call sites were scanning an
// index that could only shrink (relative to ground truth) over time, and
// broke outright once that old page was archived. Same 10-page/100-row-
// per-page ceiling as listAllMemories in mem0_notion.js.
// ---------------------------------------------------------------------------
export async function queryAllIndexEntries() {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const entries = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { page_size: PAGE_SIZE };
    if (cursor) body.start_cursor = cursor;
    const data = await clientInternals.notionRequest(`/databases/${NOTION_INDEX_DATABASE_ID}/query`, { method: "POST", body });
    for (const row of data.results || []) {
      const entity_id = notionRichTextToString(row.properties?.EntityId?.rich_text || []);
      const page_id   = notionRichTextToString(row.properties?.PageId?.rich_text || []);
      const url       = row.properties?.Url?.url || "";
      const tagsRaw   = notionRichTextToString(row.properties?.Tags?.rich_text || []);
      const tags      = tagsRaw ? tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
      if (entity_id && page_id) entries.push({ entity_id, page_id, url, tags });
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Changelog convention (2026-07-17, gap #4 -- see mem0 entity_id:
// madmcp-notion-connector-gaps-roadmap). Notion's API exposes no page/block
// revision-history endpoint (confirmed via docs review -- unlike mem0's
// native GET /v1/memories/{id}/history/, there's nothing to wrap here), so
// this is the FIX PLAN's documented fallback: an append-only changelog kept
// as plain paragraph blocks on the tracked page itself, one entry per
// state-changing notion_update_page call. Deliberately NOT gated to only
// entity_id-tracked pages (the original plan's suggestion) -- doing that
// gate correctly would need an extra blocks-fetch on every title-only/
// append-only update just to check for a marker, which defeats the point of
// keeping simple updates cheap. Instead this logs on every page any caller
// chooses to update via these tools; a page nobody ever calls
// notion_update_page on accumulates no changelog noise.
const CHANGELOG_PREFIX = "📜 ";

export function buildChangelogEntryText(summary) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `${CHANGELOG_PREFIX}${ts} UTC — ${summary}`;
}

export function isChangelogEntryText(text) {
  return !!text && text.startsWith(CHANGELOG_PREFIX);
}

// ---------------------------------------------------------------------------
// Relations convention (2026-07-17, gap #5 -- see mem0 entity_id:
// madmcp-notion-connector-gaps-roadmap). Mirrors mem0_add's relations param:
// a list of { relation, to_entity_id } pairs describing outgoing links from
// this page's entity to another tracked entity. Stored like the
// entity_id/status markers above -- one visible paragraph block per
// relation:
//   🔗 relation_type -> to_entity_id
// SCOPE NOTE: unlike mem0_list's include_relations (which resolves both
// outgoing AND incoming relations up to 3 hops), this only supports
// outgoing relations stored directly on the page. Incoming/reverse lookups
// ("what points TO this entity") would require scanning every tracked
// page's blocks via the index page -- a real feature in its own right, not
// implemented here.
const RELATION_MARKER_PREFIX = "🔗 ";
const RELATION_SEPARATOR = " -> ";

export function buildRelationBlocks(relations = []) {
  return relations.map(({ relation, to_entity_id }) => ({
    object: "block", type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: `${RELATION_MARKER_PREFIX}${relation}${RELATION_SEPARATOR}${to_entity_id}` } }] },
  }));
}

export function parseRelationBlocks(blocks = []) {
  const relations = [];
  for (const b of blocks) {
    if (b.type !== "paragraph") continue;
    const text = notionRichTextToString(b.paragraph?.rich_text || []);
    if (!text.startsWith(RELATION_MARKER_PREFIX)) continue;
    const rest = text.slice(RELATION_MARKER_PREFIX.length);
    const sepIdx = rest.indexOf(RELATION_SEPARATOR);
    if (sepIdx === -1) continue;
    relations.push({
      relation: rest.slice(0, sepIdx).trim(),
      to_entity_id: rest.slice(sepIdx + RELATION_SEPARATOR.length).trim(),
      blockId: b.id,
    });
  }
  return relations;
}

// ---------------------------------------------------------------------------
// Marker-range convention, generic (2026-09-27, Phase 1C dedup -- see plan
// page entity_id: plan-madmcp-notion-overhaul, "PHASE 1C" section).
//
// Two callers use the exact same "content lives between a start marker and
// an end marker, only that inner range is ever deleted/replaced on a
// re-write" mechanism, differing only in their marker TEXT:
//   - mem0->Notion sync (2026-07-18, mem0-notion-sync-tool-spec): protects
//     manual page edits from being clobbered by a re-sync (see original
//     header comment below, now folded into this one).
//   - Session checkpoint (2026-09-04 bug fix): originally reused the sync
//     markers above wholesale, which hardcoded "SYNCED FROM MEM0" text that
//     was simply wrong for a tool with nothing to do with mem0. Got its own
//     copy of every marker function instead of a parameterized one -- this
//     section is that fix, finished: one generic implementation, two call
//     sites supplying their own marker text.
//
// The generic functions below take {startPrefix, startSuffix, endText} to
// identify which convention they're reading/writing, and use "value" as the
// generic name for what previously appeared as synced_at (sync) or
// updated_at (checkpoint) -- both are just "the timestamp/version string
// embedded in the start marker", read back out on the next call so a caller
// can compare against what's already there.
export function buildRangeStartText({ startPrefix, startSuffix, value }) {
  return `${startPrefix}${value}${startSuffix}`;
}

export function parseRangeStartText(text, { startPrefix, startSuffix }) {
  if (!text || !text.startsWith(startPrefix) || !text.endsWith(startSuffix)) return null;
  return text.slice(startPrefix.length, text.length - startSuffix.length);
}

// Builds the full [start marker, ...content blocks, end marker] block list
// for a brand-new range (page has none yet). contentLines is split into one
// paragraph block per non-empty line, same convention as every other
// plain-text content writer in this file.
export function buildRangeBlocks({ startPrefix, startSuffix, endText, value, contentLines }) {
  const contentBlocks = (contentLines || []).filter(Boolean).map(textBlock);
  return [textBlock(buildRangeStartText({ startPrefix, startSuffix, value })), ...contentBlocks, textBlock(endText)];
}

// Scans a page's top-level blocks (same 100-block-page caveat as
// parseMarkers/parseRelationBlocks above) for an existing range matching
// this marker convention. Returns null if no start marker is found, or a
// match with block IDs so callers can delete/insert around the range
// without re-searching by text. A start marker with no matching end marker
// (page edited unexpectedly, or truncated by the 100-block read) is treated
// as not-found -- safer to append a fresh range than to guess where an
// unterminated one ends and risk deleting content past it.
export function findRange(blocks = [], { startPrefix, startSuffix, endText }) {
  let startIdx = -1;
  let value = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph") continue;
    const text = notionRichTextToString(b.paragraph?.rich_text || []);
    const parsed = parseRangeStartText(text, { startPrefix, startSuffix });
    if (parsed !== null) { startIdx = i; value = parsed; break; }
  }
  if (startIdx === -1) return null;
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph") continue;
    const text = notionRichTextToString(b.paragraph?.rich_text || []);
    if (text === endText) {
      return {
        value,
        startBlockId: blocks[startIdx].id,
        endBlockId: blocks[i].id,
        // Blocks strictly between start and end -- exactly what a re-write
        // is allowed to delete/replace.
        innerBlockIds: blocks.slice(startIdx + 1, i).map((bb) => bb.id),
      };
    }
  }
  return null; // start with no matching end -- treat as not-found, see above
}

// ---------------------------------------------------------------------------
// Sync marker convention (2026-07-18, mem0->Notion Sync Tool spec -- see
// mem0 entity_id: mem0-notion-sync-tool-spec, "PROTECTING MANUAL EDITS"
// section). Content written by the sync tool lives between:
//   ⬇️ SYNCED FROM MEM0 (mem0_synced_at: <ISO timestamp>) — DO NOT EDIT BELOW, WILL BE OVERWRITTEN ⬇️
//   ...synced content blocks...
//   ⬆️ END SYNCED CONTENT ⬆️
// Thin wrappers over the generic functions above, supplying this
// convention's own marker text -- see replaceSyncedRange (tools.js) for the
// caller that reads/writes this via replaceMarkerRange.
const SYNC_START_PREFIX = "⬇️ SYNCED FROM MEM0 (mem0_synced_at: ";
const SYNC_START_SUFFIX = ") — DO NOT EDIT BELOW, WILL BE OVERWRITTEN ⬇️";
const SYNC_END_TEXT     = "⬆️ END SYNCED CONTENT ⬆️";

export function buildSyncStartText(synced_at) {
  return buildRangeStartText({ startPrefix: SYNC_START_PREFIX, startSuffix: SYNC_START_SUFFIX, value: synced_at });
}

export function isSyncEndText(text) {
  return text === SYNC_END_TEXT;
}

export function buildSyncEndText() {
  return SYNC_END_TEXT;
}

export function buildSyncRangeBlocks({ synced_at, contentLines }) {
  return buildRangeBlocks({ startPrefix: SYNC_START_PREFIX, startSuffix: SYNC_START_SUFFIX, endText: SYNC_END_TEXT, value: synced_at, contentLines });
}

export function findSyncRange(blocks = []) {
  const range = findRange(blocks, { startPrefix: SYNC_START_PREFIX, startSuffix: SYNC_START_SUFFIX, endText: SYNC_END_TEXT });
  return range ? { synced_at: range.value, startBlockId: range.startBlockId, endBlockId: range.endBlockId, innerBlockIds: range.innerBlockIds } : null;
}

// ---------------------------------------------------------------------------
// Checkpoint marker convention (2026-09-04 bug fix -- the checkpoint tool
// was reusing the mem0 sync markers above, which hardcode "SYNCED FROM
// MEM0" text that's simply wrong for a tool that has nothing to do with
// mem0. Same block-range-protection mechanism as the sync markers -- that
// part of the design is sound and worth keeping -- just with wording that
// describes what actually wrote the content instead of a copy-pasted mem0
// label. Thin wrappers over the generic functions above, same pattern as
// the sync convention.
const CHECKPOINT_START_PREFIX = "\u2705 Checkpoint saved with MCP tool call, don't edit manually (updated: ";
const CHECKPOINT_START_SUFFIX = ")";
const CHECKPOINT_END_TEXT     = "\u2705 End synced checkpoint";

export function buildCheckpointStartText(updated_at) {
  return buildRangeStartText({ startPrefix: CHECKPOINT_START_PREFIX, startSuffix: CHECKPOINT_START_SUFFIX, value: updated_at });
}

export function buildCheckpointEndText() {
  return CHECKPOINT_END_TEXT;
}

export function isCheckpointEndText(text) {
  return text === CHECKPOINT_END_TEXT;
}

export function buildCheckpointRangeBlocks({ updated_at, contentLines }) {
  return buildRangeBlocks({ startPrefix: CHECKPOINT_START_PREFIX, startSuffix: CHECKPOINT_START_SUFFIX, endText: CHECKPOINT_END_TEXT, value: updated_at, contentLines });
}

export function findCheckpointRange(blocks = []) {
  const range = findRange(blocks, { startPrefix: CHECKPOINT_START_PREFIX, startSuffix: CHECKPOINT_START_SUFFIX, endText: CHECKPOINT_END_TEXT });
  return range ? { updated_at: range.value, startBlockId: range.startBlockId, endBlockId: range.endBlockId, innerBlockIds: range.innerBlockIds } : null;
}

export function notionBlocksToText(blocks = []) {
  return blocks
    .map((b) => {
      const type  = b.type;
      const block = b[type];
      if (!block) return "";
      if (type === "child_page")         return `📄 [Subpage] ${block.title || "(untitled)"} — id: ${b.id}`;
      if (type === "child_database")     return `🗄️ [Subdatabase] ${block.title || "(untitled)"} — id: ${b.id}`;
      const text = notionRichTextToString(block.rich_text || []);
      if (type === "heading_1")          return `# ${text}`;
      if (type === "heading_2")          return `## ${text}`;
      if (type === "heading_3")          return `### ${text}`;
      if (type === "bulleted_list_item") return `• ${text}`;
      if (type === "numbered_list_item") return `1. ${text}`;
      if (type === "to_do")              return `[${block.checked ? "x" : " "}] ${text}`;
      if (type === "code")               return `\`\`\`${block.language || ""}\n${text}\n\`\`\``;
      if (type === "divider")            return "---";
      return text;
    })
    .filter(Boolean)
    .join("\n");
}
