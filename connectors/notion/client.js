// ---------------------------------------------------------------------------
// connectors/notion/client.js
// ---------------------------------------------------------------------------

import { NOTION_TOKEN, NOTION_API, NOTION_VERSION } from "../../config.js";

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

export function buildIndexEntryText({ entity_id, page_id, url }) {
  return `${INDEX_ENTRY_PREFIX}${entity_id} | ${page_id} | ${url || ""}`;
}

export function parseIndexEntryText(text) {
  if (!text || !text.startsWith(INDEX_ENTRY_PREFIX)) return null;
  const rest = text.slice(INDEX_ENTRY_PREFIX.length);
  const [entity_id, page_id, url] = rest.split("|").map((s) => (s || "").trim());
  if (!entity_id || !page_id) return null;
  return { entity_id, page_id, url };
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
