// ---------------------------------------------------------------------------
// connectors/notion/client.js
// ---------------------------------------------------------------------------

import { NOTION_TOKEN, NOTION_API, NOTION_VERSION, NOTION_INDEX_DATABASE_ID } from "../../config.js";

export async function notionRequest(path, { method = "GET", body } = {}) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN is not set. Add it as an environment variable on the Manufact server.");
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
  if (!res.ok) {
    const message = (data && (data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`Notion API error (${res.status}): ${message}`);
  }
  return data;
}

export function notionRichTextToString(richText = []) {
  return richText.map((t) => t.plain_text || "").join("");
}

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
// guaranteed exact-match index -- see findPageByEntityId in tools.js.
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

// Index-entry marker format for the dedicated dedup index page (see
// NOTION_INDEX_PAGE_ID in config.js). One paragraph block per tracked
// entity_id: "📇 entity_id | page_id | url". Kept separate from the
// entity/status marker convention above (those live ON the tracked page
// itself; this lives on the one central index page).
const INDEX_ENTRY_PREFIX = "📇 ";
const INDEX_TAGS_PREFIX  = "tags:";

// tags param is optional -- omitted entirely (no 4th segment) for entries
// that have no tags, rather than writing an empty "tags:" segment, so old
// entries and untagged entries look identical on the page.
export function buildIndexEntryText({ entity_id, page_id, url, tags }) {
  const base = `${INDEX_ENTRY_PREFIX}${entity_id} | ${page_id} | ${url || ""}`;
  if (!tags || !tags.length) return base;
  return `${base} | ${INDEX_TAGS_PREFIX}${tags.join(",")}`;
}

// Backward compatible with the original 3-field format (entity_id | page_id
// | url) -- a 4th "tags:..." segment is read if present, otherwise tags
// comes back as an empty array rather than the parse failing.
export function parseIndexEntryText(text) {
  if (!text || !text.startsWith(INDEX_ENTRY_PREFIX)) return null;
  const rest = text.slice(INDEX_ENTRY_PREFIX.length);
  const parts = rest.split("|").map((s) => (s || "").trim());
  const [entity_id, page_id, url, tagsField] = parts;
  if (!entity_id || !page_id) return null;
  const tags = (tagsField || "").startsWith(INDEX_TAGS_PREFIX)
    ? tagsField.slice(INDEX_TAGS_PREFIX.length).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  return { entity_id, page_id, url, tags };
}

// ---------------------------------------------------------------------------
// Reads every row of the Entity Index database (NOTION_INDEX_DATABASE_ID),
// paginated. Added 2026-07-24 alongside the page->database dedup-index
// migration (see config.js's NOTION_INDEX_DATABASE_ID comment) to give
// callers that need the FULL set of tracked entities -- not a single
// entity_id lookup (that's findPageByEntityId in tools.js) -- a supported
// way to read it. Before this, linking.js's findTagOverlapCandidates and
// sync/mem0_notion.js's readSyncedIndexEntries both kept reading raw blocks
// off the old page-based index directly instead, which silently stopped
// reflecting reality the moment writes moved to the database: new entries
// were never appended to the old page, so both call sites were scanning an
// index that could only shrink (relative to ground truth) over time, and
// broke outright once that old page was archived. Same 10-page/100-row-
// per-page ceiling as listAllMemories in mem0_notion.js.
export async function queryAllIndexEntries() {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const entries = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { page_size: PAGE_SIZE };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(`/databases/${NOTION_INDEX_DATABASE_ID}/query`, { method: "POST", body });
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
// Synced-range marker convention (2026-07-18, mem0->Notion Sync Tool spec --
// see mem0 entity_id: mem0-notion-sync-tool-spec, "PROTECTING MANUAL EDITS"
// section, the one piece this spec flagged as needing real design work
// since nothing else in this file solves "replace this whole block range"
// -- doUpdatePage's `replacements` only does single-block exact-text swaps).
//
// Content written by the sync tool lives between two literal marker blocks:
//   ⬇️ SYNCED FROM MEM0 (mem0_synced_at: <ISO timestamp>) — DO NOT EDIT BELOW, WILL BE OVERWRITTEN ⬇️
//   ...synced content blocks...
//   ⬆️ END SYNCED CONTENT ⬆️
// Sync logic (replaceSyncedRange, notion/tools.js) only ever touches blocks
// strictly BETWEEN these two markers -- anything a person adds above the
// start marker, below the end marker, or as a genuinely separate block
// elsewhere on the page, is never read or written by the sync tool and
// survives every future run. The timestamp lives ON the start marker itself
// (not a separate block) so a re-sync can read the current value and skip
// the write entirely when the source memory's updated_at hasn't changed --
// avoiding the no-op rewrite + changelog spam the spec calls out.
const SYNC_START_PREFIX = "⬇️ SYNCED FROM MEM0 (mem0_synced_at: ";
const SYNC_START_SUFFIX = ") — DO NOT EDIT BELOW, WILL BE OVERWRITTEN ⬇️";
const SYNC_END_TEXT     = "⬆️ END SYNCED CONTENT ⬆️";

export function buildSyncStartText(synced_at) {
  return `${SYNC_START_PREFIX}${synced_at}${SYNC_START_SUFFIX}`;
}

function parseSyncStartText(text) {
  if (!text || !text.startsWith(SYNC_START_PREFIX) || !text.endsWith(SYNC_START_SUFFIX)) return null;
  return text.slice(SYNC_START_PREFIX.length, text.length - SYNC_START_SUFFIX.length);
}

export function isSyncEndText(text) {
  return text === SYNC_END_TEXT;
}

// Builds the full [start marker, ...content blocks, end marker] block list
// for a brand-new synced range (page has none yet). contentLines is split
// into one paragraph block per non-empty line, same convention as every
// other plain-text content writer in this file.
export function buildSyncRangeBlocks({ synced_at, contentLines }) {
  const contentBlocks = (contentLines || []).filter(Boolean).map(textBlock);
  return [textBlock(buildSyncStartText(synced_at)), ...contentBlocks, textBlock(SYNC_END_TEXT)];
}

// Scans a page's top-level blocks (same 100-block-page caveat as
// parseMarkers/parseRelationBlocks above) for an existing synced range.
// Returns null if no start marker is found, or a match with block IDs so
// callers can delete/insert around the range without re-searching by text.
// A start marker with no matching end marker (page edited unexpectedly, or
// truncated by the 100-block read) is treated as not-found -- safer to
// append a fresh range than to guess where an unterminated one ends and
// risk deleting content past it.
export function findSyncRange(blocks = []) {
  let startIdx = -1;
  let synced_at = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph") continue;
    const text = notionRichTextToString(b.paragraph?.rich_text || []);
    const parsed = parseSyncStartText(text);
    if (parsed !== null) { startIdx = i; synced_at = parsed; break; }
  }
  if (startIdx === -1) return null;
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph") continue;
    const text = notionRichTextToString(b.paragraph?.rich_text || []);
    if (isSyncEndText(text)) {
      return {
        synced_at,
        startBlockId: blocks[startIdx].id,
        endBlockId: blocks[i].id,
        // Blocks strictly between start and end -- exactly what a re-sync
        // is allowed to delete/replace.
        innerBlockIds: blocks.slice(startIdx + 1, i).map((bb) => bb.id),
      };
    }
  }
  return null; // start with no matching end -- treat as not-found, see above
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
