// ---------------------------------------------------------------------------
// connectors/notion/tools.js
// ---------------------------------------------------------------------------

import { z } from "zod";
import { NOTION_INDEX_PAGE_ID } from "../../config.js";
import {
  notionRequest, notionPageTitle, notionDatabaseTitle, notionRichTextToString,
  notionBlocksToText, buildMarkerBlocks, statusMarkerBlock, notionBlockPlainText, parseMarkers,
  buildIndexEntryText, parseIndexEntryText, buildChangelogEntryText, isChangelogEntryText,
  buildRelationBlocks, parseRelationBlocks,
  buildSyncStartText, buildSyncRangeBlocks, findSyncRange, textBlock,
} from "./client.js";

const STATUS_VALUES = ["open", "resolved", "superseded"];

// ---------------------------------------------------------------------------
// Dedup/upsert lookup (2026-07-17, gap #1 -- see mem0 entity_id:
// madmcp-notion-connector-gaps-roadmap).
//
// REAL FIX 2026-07-17: the original implementation leaned on notion_search
// to find candidate pages by entity_id text. Live testing confirmed that's
// fundamentally broken -- Notion's search index has real lag, and searching
// for an entity_id string immediately after creating that page (the most
// common dedup scenario -- "just created something, now checking if it
// exists") reliably returns zero results. The dedup check was coded
// correctly but the data source it depended on couldn't answer fast enough,
// so duplicates were still created.
//
// Fix: maintain a dedicated index page (NOTION_INDEX_PAGE_ID, config.js)
// whose blocks are plain "entity_id | page_id | url" paragraph entries.
// Reading a page's own blocks via /blocks/{id}/children is a direct,
// uncached read -- not subject to search-indexing lag -- so this is
// immediately consistent even right after an entry is appended. Mirrors how
// mem0 itself does real indexed lookups rather than full-text search.
export async function findPageByEntityId(entity_id) {
  let indexBlocks;
  try {
    const data = await notionRequest(`/blocks/${NOTION_INDEX_PAGE_ID}/children?page_size=100`);
    indexBlocks = data.results || [];
  } catch (err) {
    // Fail loudly rather than silently falling back to nothing found --
    // silently treating "index unreachable" as "no duplicate exists" would
    // just reintroduce the exact bug this fix is for.
    throw new Error(`Notion entity index page (${NOTION_INDEX_PAGE_ID}) is unreachable, so entity_id dedup can't be verified: ${err.message}. Fix NOTION_INDEX_PAGE_ID / the index page's sharing settings before creating entity-tracked pages.`);
  }
  for (const b of indexBlocks) {
    if (b.type !== "paragraph") continue;
    const entry = parseIndexEntryText(notionRichTextToString(b.paragraph?.rich_text || []));
    if (!entry || entry.entity_id !== entity_id) continue;
    try {
      const page = await notionRequest(`/pages/${entry.page_id}`);
      const blocksData = await notionRequest(`/blocks/${entry.page_id}/children?page_size=20`);
      const markers = parseMarkers(blocksData.results || []);
      return { pageId: entry.page_id, title: notionPageTitle(page), url: page.url, markers };
    } catch {
      // Stale index entry (target page deleted/archived outside these
      // tools) -- treat as not-found so a fresh page can be created, rather
      // than erroring out on a dangling reference.
      continue;
    }
  }
  return null;
}

// Records a new entity_id -> page_id mapping on the index page. Best-effort:
// if this fails, the page itself was still created successfully, so we
// don't throw -- but the caller surfaces the failure in its response text
// since it means the NEXT dedup check for this entity_id won't find it.
// NOTE: like notion_get_page, this index page is capped at reading/writing
// within Notion's block-children pagination -- same first-100 limitation as
// gap #8, not yet fixed here.
async function appendIndexEntry({ entity_id, page_id, url }) {
  try {
    await notionRequest(`/blocks/${NOTION_INDEX_PAGE_ID}/children`, {
      method: "PATCH",
      body: { children: [{
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: buildIndexEntryText({ entity_id, page_id, url }) } }] },
      }] },
    });
    return null;
  } catch (err) {
    return err.message;
  }
}

// ---------------------------------------------------------------------------
// Shared create-page logic (2026-07-17, gap #6 -- see mem0 entity_id:
// madmcp-notion-connector-gaps-roadmap). Extracted out of notion_create_page's
// handler so notion_create_pages_batch can reuse the exact same dedup +
// marker + index-recording behavior per item, mirroring how mem/tools.js's
// mem0_add and mem0_add_batch share logic. Returns a plain result object
// instead of an MCP content block -- callers format the response.
// 2026-07-18: NOT a hard entity_id requirement -- forcing entity_id on
// every page would pollute the index with genuine scratch/one-off content
// (test pages, quick notes) that was never meant to be deduped or tracked,
// which defeats the index's purpose and doesn't match the same tradeoff
// mem0_add already makes (entity_id optional there too, for the same
// reason). Instead: require an EXPLICIT choice. Omitting entity_id AND
// one_off is the actual failure mode worth catching -- someone forgetting
// to track a thing that should be tracked -- so that case now throws
// instead of silently creating an untracked page. Passing one_off: true is
// the deliberate opt-out for real one-offs.
export async function doCreatePage({ parent_id, parent_type, title, content, entity_id, status, relations, one_off }) {
  if (!entity_id && !one_off) {
    throw new Error(`Refusing to create "${title}" without a tracking decision -- pass either entity_id (if this represents an ongoing/stable thing that should be deduped and indexed) or one_off: true (if it's genuinely disposable, e.g. a scratch note or test page). This is a deliberate choice, not a bug -- see notion_create_page's entity_id and one_off param descriptions.`);
  }
  if (entity_id) {
    const existing = await findPageByEntityId(entity_id);
    if (existing) {
      return { skipped: true, entity_id, existingId: existing.pageId, existingTitle: existing.title, existingUrl: existing.url };
    }
  }
  const parent     = parent_type === "database" ? { database_id: parent_id } : { page_id: parent_id };
  const properties = parent_type === "database"
    ? { Name:  { title: [{ text: { content: title } }] } }
    : { title: { title: [{ text: { content: title } }] } };
  const markerBlocks   = buildMarkerBlocks({ entity_id, status });
  const relationBlocks = buildRelationBlocks(relations || []);
  const contentBlocks = content
    ? content.split("\n").filter(Boolean).map(textBlock)
    : [];
  const children = [...markerBlocks, ...relationBlocks, ...contentBlocks];
  const data = await notionRequest("/pages", {
    method: "POST",
    body: { parent, properties, children },
  });
  let indexError = null;
  if (entity_id) {
    indexError = await appendIndexEntry({ entity_id, page_id: data.id, url: data.url });
  }
  return { skipped: false, id: data.id, url: data.url, title, markerCount: markerBlocks.length, relationCount: relationBlocks.length, entity_id, status, indexError };
}

// Sequential batch runner, mimicking Promise.allSettled's per-item
// {status, value|reason} shape so callers don't need to change their
// result-formatting code. NOT run in parallel -- BUG FOUND 2026-07-17 live
// testing: notion_create_pages_batch originally used Promise.allSettled,
// which let two items sharing the same entity_id both pass
// findPageByEntityId's dedup check concurrently (neither had written its
// index entry yet when the other checked), creating two pages for one
// entity_id in a single batch call. Running strictly in order guarantees
// each item's dedup check sees every earlier item's completed index write.
// Trades batch throughput for correctness -- acceptable at this tool's
// scale (personal/small-team usage, not high-volume bulk import).
async function runSequentially(items, fn) {
  const results = [];
  for (const item of items) {
    try {
      const value = await fn(item);
      results.push({ status: "fulfilled", value });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results;
}

const EDITABLE_BLOCK_TYPES = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do"];

// ---------------------------------------------------------------------------
// Synced-range block replace (2026-07-18, mem0->Notion Sync Tool spec --
// see mem0 entity_id: mem0-notion-sync-tool-spec). See client.js's
// "Synced-range marker convention" comment for the marker format and why
// this exists (protecting manual edits from being clobbered by a re-sync).
// Same 100-block-page read limitation as findPageByEntityId/parseMarkers
// elsewhere in this file -- a range on a page with >100 total blocks may
// not be found; treated as not-found (append fresh range) rather than a
// silent corruption risk, same reasoning as findSyncRange's unterminated-
// range case.
export async function replaceSyncedRange({ page_id, contentLines, synced_at }) {
  const blocksData = await notionRequest(`/blocks/${page_id}/children?page_size=100`);
  const blocks = blocksData.results || [];
  const range = findSyncRange(blocks);

  if (!range) {
    const children = buildSyncRangeBlocks({ synced_at, contentLines });
    await notionRequest(`/blocks/${page_id}/children`, { method: "PATCH", body: { children } });
    return { action: "created", blockCount: children.length };
  }

  if (range.synced_at === synced_at) {
    return { action: "skipped", reason: `already up to date (mem0_synced_at: ${synced_at})` };
  }

  // Delete every block strictly between the markers -- never the markers
  // themselves, and never anything past the end marker.
  for (const blockId of range.innerBlockIds) {
    await notionRequest(`/blocks/${blockId}`, { method: "DELETE" });
  }

  // Insert new content right after the start marker via Notion's `after`
  // cursor, so it lands inside the range regardless of what (if anything)
  // sits below the end marker.
  const contentBlocks = (contentLines || []).filter(Boolean).map(textBlock);
  if (contentBlocks.length) {
    await notionRequest(`/blocks/${page_id}/children`, {
      method: "PATCH",
      body: { children: contentBlocks, after: range.startBlockId },
    });
  }

  // Update the start marker's own text in place with the new timestamp --
  // same single-block PATCH doUpdatePage uses for the status marker.
  await notionRequest(`/blocks/${range.startBlockId}`, {
    method: "PATCH",
    body: { paragraph: { rich_text: [{ type: "text", text: { content: buildSyncStartText(synced_at) } }] } },
  });

  return { action: "updated", removed: range.innerBlockIds.length, added: contentBlocks.length, previousSyncedAt: range.synced_at };
}

// Best-effort changelog append (gap #4) -- swallows its own errors rather
// than throwing, since a failed history write shouldn't roll back or block
// an otherwise-successful page update. Returns an error string (for the
// caller to optionally surface) or null on success.
async function appendChangelogEntry(page_id, summary) {
  try {
    await notionRequest(`/blocks/${page_id}/children`, {
      method: "PATCH",
      body: { children: [{
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: buildChangelogEntryText(summary) } }] },
      }] },
    });
    return null;
  } catch (err) {
    return err.message;
  }
}

// ---------------------------------------------------------------------------
// Shared update-page logic (2026-07-17, gap #6 -- mirrors doCreatePage above).
// Extracted out of notion_update_page's handler so notion_update_pages_batch
// can reuse the exact same title/append_content/archived/replacements/status
// behavior per item. Returns an array of result strings on success, or
// THROWS on any abort condition (ambiguous/missing replacement match,
// unsupported block type) -- the single-item tool catches this to preserve
// its existing isError response shape; the batch tool lets Promise.allSettled
// catch it per item, same pattern as mem/tools.js.
export async function doUpdatePage({ page_id, title, append_content, archived, replacements, status, relations }) {
  const results = [];
  if (title !== undefined || archived !== undefined) {
    const body = {};
    if (archived !== undefined) body.archived = archived;
    if (title    !== undefined) body.properties = { title: { title: [{ text: { content: title } }] } };
    const data = await notionRequest(`/pages/${page_id}`, { method: "PATCH", body });
    results.push(`Updated page "${notionPageTitle(data)}" (ID: ${data.id}).`);
  }
  if (append_content) {
    const children = append_content.split("\n").filter(Boolean).map(textBlock);
    await notionRequest(`/blocks/${page_id}/children`, { method: "PATCH", body: { children } });
    results.push(`Appended ${children.length} paragraph(s) to page.`);
  }
  if (replacements?.length) {
    const blocksData = await notionRequest(`/blocks/${page_id}/children?page_size=100`);
    const blocks = blocksData.results || [];
    for (const { find, replace } of replacements) {
      const matches = blocks.filter((b) => notionBlockPlainText(b) === find);
      const trunc = (s) => s.slice(0, 60) + (s.length > 60 ? "…" : "");
      if (matches.length === 0) {
        throw new Error(`Update aborted, nothing further written — "${trunc(find)}" was not found among this page's top-level blocks (first 100). It may be nested inside a toggle/column, or the page may have more than 100 blocks — re-check with notion_get_page.`);
      }
      if (matches.length > 1) {
        throw new Error(`Update aborted, nothing further written — "${trunc(find)}" matches ${matches.length} blocks, but must be unique. Include more surrounding context in "find" to disambiguate.`);
      }
      const block = matches[0];
      const type  = block.type;
      if (!EDITABLE_BLOCK_TYPES.includes(type)) {
        throw new Error(`Update aborted, nothing further written — matched block is type "${type}", which notion_update_page can't edit in place yet (supported: ${EDITABLE_BLOCK_TYPES.join(", ")}).`);
      }
      const patchBody = { [type]: { rich_text: [{ type: "text", text: { content: replace } }] } };
      if (type === "to_do") patchBody[type].checked = block.to_do?.checked ?? false;
      await notionRequest(`/blocks/${block.id}`, { method: "PATCH", body: patchBody });
      results.push(`Replaced block ("${trunc(find)}" → "${trunc(replace)}").`);
    }
  }
  if (status !== undefined) {
    const blocksData = await notionRequest(`/blocks/${page_id}/children?page_size=100`);
    const markers = parseMarkers(blocksData.results || []);
    if (markers.statusBlockId) {
      await notionRequest(`/blocks/${markers.statusBlockId}`, {
        method: "PATCH",
        body: statusMarkerBlock(status),
      });
      results.push(`Status updated to "${status}" (was "${markers.status}").`);
    } else {
      await notionRequest(`/blocks/${page_id}/children`, { method: "PATCH", body: { children: [statusMarkerBlock(status)] } });
      results.push(`Status marker added: "${status}" (page had none before).`);
    }
  }
  // relations REPLACES the existing set whole (not merged), same contract as
  // mem0_update's relations param. Requires reading current blocks to find
  // the existing relation blocks to remove -- reuses blocksData if a
  // replacements/status branch above already fetched it, to avoid a
  // redundant call.
  if (relations !== undefined) {
    const blocksData = await notionRequest(`/blocks/${page_id}/children?page_size=100`);
    const existingRelations = parseRelationBlocks(blocksData.results || []);
    for (const r of existingRelations) {
      await notionRequest(`/blocks/${r.blockId}`, { method: "DELETE" });
    }
    const newBlocks = buildRelationBlocks(relations);
    if (newBlocks.length) {
      await notionRequest(`/blocks/${page_id}/children`, { method: "PATCH", body: { children: newBlocks } });
    }
    results.push(`Relations replaced: ${existingRelations.length} removed, ${newBlocks.length} added.`);
  }
  // Skip the changelog write when this call archived the page -- Notion
  // rejects block edits on an already-archived page ("Can't edit block that
  // is archived"), confirmed via live testing 2026-07-17. Unarchiving
  // (archived: false) is fine since the page is editable again by then.
  if (results.length && archived !== true) {
    const changelogError = await appendChangelogEntry(page_id, results.join("; "));
    if (changelogError) results.push(`(\u26a0\ufe0f changelog entry not recorded: ${changelogError})`);
  }
  return results;
}

export function register(server) {

  server.tool(
    "notion_search",
    "Search pages and databases in your Notion workspace.",
    {
      query:       z.string().describe("Search query string"),
      filter_type: z.enum(["page", "database"]).optional().describe("Filter results to only pages or only databases (default: both)"),
      page_size:   z.number().optional().describe("Number of results to return (default: 10, max: 100)"),
    },
    async ({ query, filter_type, page_size = 10 }) => {
      const body = { query, page_size };
      if (filter_type) body.filter = { value: filter_type, property: "object" };
      const data = await notionRequest("/search", { method: "POST", body });
      if (!data.results?.length) return { content: [{ type: "text", text: "No results found." }] };
      const lines = data.results.map((r) => {
        const title = r.object === "page"
          ? notionPageTitle(r)
          : (notionRichTextToString(r.title) || "(untitled)");
        return `[${r.object}] ${title}\n  ID: ${r.id}\n  URL: ${r.url || ""}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "notion_get_page",
    "Get a Notion page's properties and content blocks.",
    {
      page_id: z.string().describe("Notion page ID (UUID format, e.g. from notion_search)"),
      cursor:  z.string().optional().describe("Pagination cursor from a previous call's response (see the more-blocks note) -- fetches the next page of up to 100 blocks instead of starting over. Omit for the first call."),
    },
    async ({ page_id, cursor }) => {
      const blocksPath = `/blocks/${page_id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
      const [page, blocksData] = await Promise.all([
        notionRequest(`/pages/${page_id}`),
        notionRequest(blocksPath),
      ]);
      const title     = notionPageTitle(page);
      const allBlocks = blocksData.results || [];
      // Changelog entries (gap #4) are kept out of the normal content view --
      // they're an operational log, not page content -- surfaced instead via
      // notion_get_page_history. Filtered only from what's *shown* here, not
      // from the raw block count, since they still occupy real block slots.
      const blocks = allBlocks.filter((b) => !(b.type === "paragraph" && isChangelogEntryText(notionRichTextToString(b.paragraph?.rich_text || []))));
      const changelogCount = allBlocks.length - blocks.length;
      const content  = notionBlocksToText(blocks);
      const hasMore  = blocksData.has_more
        ? `\n\n⚠️ Page has more blocks — call notion_get_page again with cursor: "${blocksData.next_cursor}" to see the next page.`
        : "";
      const subPages     = blocks.filter((b) => b.type === "child_page").length;
      const subDatabases = blocks.filter((b) => b.type === "child_database").length;
      const childSummary = (subPages || subDatabases)
        ? `\n\n🔗 ${subPages} subpage(s), ${subDatabases} subdatabase(s) found — use notion_get_page on their IDs above to view them.`
        : "";
      const changelogNote = changelogCount ? `\n📜 ${changelogCount} changelog entr${changelogCount === 1 ? "y" : "ies"} on this page (this view) — use notion_get_page_history to see them.` : "";
      const markers      = parseMarkers(allBlocks);
      const markerLine   = (markers.entity_id || markers.status)
        ? `\n${markers.entity_id ? `Entity ID: ${markers.entity_id}` : ""}${markers.entity_id && markers.status ? " | " : ""}${markers.status ? `Status: ${markers.status}` : ""}`
        : "";
      // Relations (gap #5) -- resolve up to 5 outgoing relations to their
      // target's title/url via the same dedup index lookup findPageByEntityId
      // uses, so a person reading this doesn't have to manually chase each
      // to_entity_id. Capped at 5 to bound the extra API calls this costs
      // (each resolution is a full findPageByEntityId, itself 1-2 calls);
      // remaining relations are still listed, just unresolved.
      const relations = parseRelationBlocks(allBlocks);
      let relationsBlock = "";
      if (relations.length) {
        const toResolve = relations.slice(0, 5);
        const resolved = await Promise.all(toResolve.map(async (r) => {
          try {
            const target = await findPageByEntityId(r.to_entity_id);
            return target ? `  🔗 ${r.relation} -> ${r.to_entity_id} ("${target.title}", ${target.url})` : `  🔗 ${r.relation} -> ${r.to_entity_id} (not found -- dangling reference)`;
          } catch {
            return `  🔗 ${r.relation} -> ${r.to_entity_id} (couldn't resolve -- index unreachable)`;
          }
        }));
        const remaining = relations.length - toResolve.length;
        relationsBlock = `\n\nRelations:\n${resolved.join("\n")}${remaining ? `\n  … and ${remaining} more (not resolved, showing first 5)` : ""}`;
      }
      const text =
        `# ${title}\n` +
        `ID: ${page.id}\n` +
        `URL: ${page.url}\n` +
        `Created: ${page.created_time?.slice(0, 10)} | Last edited: ${page.last_edited_time?.slice(0, 10)}${markerLine}${changelogNote}\n\n` +
        (content || "(no content)") + hasMore + childSummary + relationsBlock;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "notion_get_page_history",
    "Get the version/change history of a Notion page -- every notion_update_page call recorded against it, with a summary of what changed and when. Notion's API has no native page-revision endpoint (unlike mem0_get_history, which wraps one), so this reads back the append-only changelog blocks notion_update_page writes on every successful change. Only covers changes made through these tools, not edits made directly in the Notion UI or by other integrations.",
    {
      page_id: z.string().describe("Notion page ID (UUID format, e.g. from notion_search)"),
      cursor:  z.string().optional().describe("Pagination cursor from a previous call, to see older history beyond the first 100 blocks scanned. Omit for the first call."),
    },
    async ({ page_id, cursor }) => {
      const blocksPath = `/blocks/${page_id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
      const blocksData = await notionRequest(blocksPath);
      const blocks = blocksData.results || [];
      const entries = blocks
        .filter((b) => b.type === "paragraph")
        .map((b) => notionRichTextToString(b.paragraph?.rich_text || []))
        .filter(isChangelogEntryText);
      const hasMore = blocksData.has_more
        ? `\n\n⚠️ More blocks exist beyond this page — call again with cursor: "${blocksData.next_cursor}" to scan further (older changelog entries, if any, may be further in).`
        : "";
      if (!entries.length) {
        return { content: [{ type: "text", text: `No changelog entries found on this page (within the blocks scanned).${hasMore}` }] };
      }
      return { content: [{ type: "text", text: entries.join("\n") + hasMore }] };
    }
  );

  server.tool(
    "notion_create_page",
    "Create a new Notion page inside a parent page or database. Pass entity_id to get upsert-style dedup protection (mirrors mem0_add): if a page already carries that entity_id marker, this refuses to create a duplicate and returns the existing page instead. Recommended whenever this page represents a stable, ongoing thing (a tracked PR, an issue, a recurring report) rather than a genuine one-off.",
    {
      parent_id:   z.string().describe("ID of the parent page or database"),
      parent_type: z.enum(["page", "database"]).describe("Whether the parent is a page or a database"),
      title:       z.string().describe("Title of the new page"),
      content:     z.string().optional().describe("Plain text content to add as paragraph blocks"),
      entity_id:   z.string().optional().describe("Optional stable identifier for the thing this page represents (e.g. 'pr-workers-sdk-14714'). BEFORE inventing a new one, use notion_search for an existing page on the same topic -- entity_id dedup only catches an EXACT marker match. If a page already exists with this entity_id, notion_create_page will NOT create a duplicate -- it returns the existing page's id/url/content instead, so you can call notion_update_page (append_content or replacements) on it instead of creating a new one. Stored as a visible '🔑 entity_id: ...' marker paragraph at the top of the page, since Notion pages outside a database have no real custom-property field to use instead."),
      status:      z.enum(STATUS_VALUES).optional().describe("Optional lifecycle status (open/resolved/superseded) for this page. Stored as a visible '🏷️ status: ...' marker paragraph, same convention as entity_id."),
      relations:   z.array(z.object({
        to_entity_id: z.string().describe("The entity_id of the other tracked page this one relates to"),
        relation:     z.string().describe("The relation type, e.g. 'blocks', 'depends_on', 'relates_to' -- free text"),
      })).optional().describe("Optional list of outgoing relations from this page's entity to others, e.g. [{to_entity_id:'bug-4', relation:'blocks'}]. Stored as visible '🔗 relation -> to_entity_id' marker paragraphs. Only outgoing relations are supported -- see notion_get_page's Relations section for resolved targets."),
      one_off:     z.boolean().optional().describe("Set true to explicitly opt this page OUT of entity_id tracking -- required if entity_id is omitted. This tool refuses to create a page without either entity_id or one_off: true, so omitting entity_id by accident (rather than on purpose) is caught immediately instead of silently producing an untracked, un-deduped page. Use for genuine one-offs: scratch notes, test pages, throwaway content that will never need dedup or update-in-place."),
    },
    async ({ parent_id, parent_type, title, content, entity_id, status, relations, one_off }) => {
      let result;
      try {
        result = await doCreatePage({ parent_id, parent_type, title, content, entity_id, status, relations, one_off });
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      if (result.skipped) {
        return {
          content: [{
            type: "text",
            text:
              `Not creating — a page already exists for entity_id "${entity_id}" (id: ${result.existingId}, title: "${result.existingTitle}"). No duplicate was created.\n` +
              `URL: ${result.existingUrl}\n\n` +
              `Next step: call notion_get_page on this id to review current content, then notion_update_page (append_content or replacements) to update it instead of creating a new page.`,
          }],
        };
      }
      const indexNote = result.indexError
        ? `\n\n\u26a0\ufe0f Page created, but recording it in the dedup index failed: ${result.indexError}. Future notion_create_page calls with entity_id "${entity_id}" may not detect this page as a duplicate.`
        : "";
      const markerNote = result.markerCount ? ` (with ${entity_id ? "entity_id" : ""}${entity_id && status ? " + " : ""}${status ? "status" : ""} marker${result.markerCount > 1 ? "s" : ""})` : "";
      return { content: [{ type: "text", text: `Created Notion page "${title}"${markerNote}\nID: ${result.id}\nURL: ${result.url}${indexNote}` }] };
    }
  );

  server.tool(
    "notion_create_pages_batch",
    "Create multiple Notion pages in a single call, to reduce round trips. Each item is created independently -- entity_id dedup, marker blocks, and dedup-index recording all apply per item exactly as in notion_create_page. One item failing (e.g. bad parent_id) does not block the others.",
    {
      items: z.array(z.object({
        parent_id:   z.string().describe("ID of the parent page or database"),
        parent_type: z.enum(["page", "database"]).describe("Whether the parent is a page or a database"),
        title:       z.string().describe("Title of the new page"),
        content:     z.string().optional().describe("Plain text content to add as paragraph blocks"),
        entity_id:   z.string().optional().describe("Optional stable identifier for this page -- see notion_create_page. If a page already exists with this entity_id, this item is skipped (not duplicated) and the existing id/url is reported instead."),
        status:      z.enum(STATUS_VALUES).optional().describe("Optional lifecycle status (open/resolved/superseded) -- see notion_create_page."),
        relations:   z.array(z.object({
          to_entity_id: z.string().describe("The entity_id of the other tracked page this one relates to"),
          relation:     z.string().describe("The relation type -- see notion_create_page"),
        })).optional().describe("Optional outgoing relations for this page -- see notion_create_page."),
        one_off:     z.boolean().optional().describe("Required if entity_id is omitted -- see notion_create_page."),
      })).min(1).describe("List of pages to create"),
    },
    async ({ items }) => {
      const results = await runSequentially(items, doCreatePage);
      const lines = results.map((r, i) => {
        const label = items[i].title;
        if (r.status === "rejected") return `\u2717 [${i}] "${label}" — error: ${r.reason?.message || r.reason}`;
        const v = r.value;
        if (v.skipped) return `\u23ed [${i}] "${label}" — skipped, entity_id "${v.entity_id}" already exists (id: ${v.existingId}, title: "${v.existingTitle}").`;
        const idxNote = v.indexError ? ` \u26a0\ufe0f index record failed: ${v.indexError}` : "";
        return `\u2713 [${i}] "${label}" — id: ${v.id}${idxNote}`;
      });
      const created = results.filter((r) => r.status === "fulfilled" && !r.value.skipped).length;
      return { content: [{ type: "text", text: `${created}/${items.length} created.\n\n${lines.join("\n")}` }] };
    }
  );

  server.tool(
    "notion_create_database",
    "Create a new Notion database inside a parent page, with a given property schema. One-off/setup tool -- most workflows should use notion_create_page instead.",
    {
      parent_page_id: z.string().describe("ID of the parent page to create the database under"),
      title:          z.string().describe("Title of the new database"),
      properties:     z.record(z.any()).describe("Notion property schema object, e.g. { \"Name\": { \"title\": {} }, \"Status\": { \"select\": { \"options\": [{ \"name\": \"open\" }] } } }"),
    },
    async ({ parent_page_id, title, properties }) => {
      const data = await notionRequest("/databases", {
        method: "POST",
        body: {
          parent: { type: "page_id", page_id: parent_page_id },
          title: [{ type: "text", text: { content: title } }],
          properties,
        },
      });
      return { content: [{ type: "text", text: `Created database "${title}"\nID: ${data.id}\nURL: ${data.url}` }] };
    }
  );

  server.tool(
    "notion_update_database",
    "Update a Notion database's title, or archive/restore it. Use this instead of notion_update_page for database IDs -- databases live at a separate API endpoint from pages, so notion_update_page returns a 404 if given a database ID.",
    {
      database_id: z.string().describe("Notion database ID (UUID format, e.g. from notion_search with filter_type: 'database')"),
      title:       z.string().optional().describe("New title for the database"),
      archived:    z.boolean().optional().describe("Set true to archive (trash) the database, false to restore"),
    },
    async ({ database_id, title, archived }) => {
      const body = {};
      if (archived !== undefined) body.archived = archived;
      if (title    !== undefined) body.title    = [{ type: "text", text: { content: title } }];
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text", text: "No changes made." }] };
      }
      const data = await notionRequest(`/databases/${database_id}`, { method: "PATCH", body });
      return { content: [{ type: "text", text: `Updated database "${notionDatabaseTitle(data)}" (ID: ${data.id}).` }] };
    }
  );

  server.tool(
    "notion_update_page",
    "Update a Notion page's title or properties, append text content to it, make a targeted in-place edit to an existing block (replacements), or change its lifecycle status marker.",
    {
      page_id:        z.string().describe("Notion page ID to update"),
      title:          z.string().optional().describe("New title for the page"),
      append_content: z.string().optional().describe("Plain text to append as new paragraph blocks"),
      archived:       z.boolean().optional().describe("Set true to archive (trash) the page, false to restore"),
      replacements:   z.array(z.object({
        find:    z.string().describe("Exact plain text of an existing top-level block (paragraph, heading, list item, or to-do) -- must match exactly one block"),
        replace: z.string().describe("New plain text for that block"),
      })).optional().describe("List of find-and-replace operations for targeted in-place block edits, instead of appending new content. Each `find` must match exactly one of the page's top-level blocks (first 100) by plain text -- fails loudly (no changes made) on zero or multiple matches, same uniqueness rule as mem0_update's replacements and the github str_replace_file tool. Only text-style blocks can be edited this way (paragraph/heading/list-item/to-do); code blocks, subpages, etc. are not supported and will report an error instead of being silently skipped."),
      status:         z.enum(STATUS_VALUES).optional().describe("Set this page's lifecycle status (open/resolved/superseded). Updates the existing '🏷️ status: ...' marker block in place if one exists, or appends a new marker block if the page has none yet."),
      relations:      z.array(z.object({
        to_entity_id: z.string().describe("The entity_id of the other entity this one relates to"),
        relation:     z.string().describe("The relation type, e.g. 'blocks', 'depends_on', 'relates_to' -- free text"),
      })).optional().describe("New outgoing relations for this page -- REPLACES the existing relation set whole (not merged). Omit to leave relations unchanged. Pass an empty array to clear all relations."),
    },
    async ({ page_id, title, append_content, archived, replacements, status, relations }) => {
      try {
        const results = await doUpdatePage({ page_id, title, append_content, archived, replacements, status, relations });
        return { content: [{ type: "text", text: results.join("\n") || "No changes made." }] };
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    }
  );

  server.tool(
    "notion_sync_content",
    "Write content into a marked, machine-managed range on a Notion page, without disturbing anything a person has added elsewhere on the page. On first use, appends a new range (start marker + content + end marker) to the end of the page. On later calls with the same synced_at, does nothing (already up to date). On later calls with a different synced_at, replaces only the blocks between the markers -- content above the start marker or below the end marker is never read or touched. This is the low-level primitive behind mem0->Notion sync; call directly for testing, or to sync arbitrary external content into a page.",
    {
      page_id:     z.string().describe("Notion page ID to write the synced range onto"),
      content:     z.string().describe("Plain text content for the synced range, one paragraph block per newline-separated line"),
      synced_at:   z.string().describe("Version/timestamp identifying this content revision (e.g. an ISO timestamp or a source system's updated_at). If this matches what's already on the page, the call is a no-op."),
    },
    async ({ page_id, content, synced_at }) => {
      const contentLines = content.split("\n");
      let result;
      try {
        result = await replaceSyncedRange({ page_id, contentLines, synced_at });
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      if (result.action === "created") return { content: [{ type: "text", text: `Created new synced range (${result.blockCount} blocks) on page ${page_id}.` }] };
      if (result.action === "skipped") return { content: [{ type: "text", text: `No changes made — ${result.reason}.` }] };
      return { content: [{ type: "text", text: `Synced range updated on page ${page_id}: ${result.removed} block(s) removed, ${result.added} added (was mem0_synced_at: ${result.previousSyncedAt}, now: ${synced_at}). Content above/below the markers was left untouched.` }] };
    }
  );

  server.tool(
    "notion_update_pages_batch",
    "Update multiple Notion pages in a single call, to reduce round trips. Each item supports the same title/append_content/archived/replacements/status behavior as notion_update_page. One item failing (e.g. an ambiguous replacement match) does not block the others.",
    {
      items: z.array(z.object({
        page_id:        z.string().describe("Notion page ID to update"),
        title:          z.string().optional().describe("New title for the page"),
        append_content: z.string().optional().describe("Plain text to append as new paragraph blocks"),
        archived:       z.boolean().optional().describe("Set true to archive (trash) the page, false to restore"),
        replacements:   z.array(z.object({
          find:    z.string().describe("Exact plain text of an existing top-level block -- must match exactly one block"),
          replace: z.string().describe("New plain text for that block"),
        })).optional().describe("Targeted find/replace edits for this page -- see notion_update_page for matching rules."),
        status:         z.enum(STATUS_VALUES).optional().describe("Set this page's lifecycle status -- see notion_update_page."),
        relations:      z.array(z.object({
          to_entity_id: z.string().describe("The entity_id of the other entity this one relates to"),
          relation:     z.string().describe("The relation type -- see notion_update_page"),
        })).optional().describe("New outgoing relations for this page -- see notion_update_page (whole-set replace)."),
      })).min(1).describe("List of page updates to apply"),
    },
    async ({ items }) => {
      const results = await runSequentially(items, doUpdatePage);
      const lines = results.map((r, i) => {
        const label = items[i].page_id;
        if (r.status === "rejected") return `\u2717 [${i}] ${label} — ${r.reason?.message || r.reason}`;
        return `\u2713 [${i}] ${label} — ${r.value.join("; ") || "no changes made"}`;
      });
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      return { content: [{ type: "text", text: `${succeeded}/${items.length} updated.\n\n${lines.join("\n")}` }] };
    }
  );
}
