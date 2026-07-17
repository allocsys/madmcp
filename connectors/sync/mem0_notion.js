// ---------------------------------------------------------------------------
// connectors/sync/mem0_notion.js  —  one-way mem0 -> Notion sync
// See: SPEC: mem0 -> Notion Sync Tool (Notion entity_id: mem0-notion-sync-tool-spec)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { mem0Request } from "../mem/client.js";
import { notionRequest, parseIndexEntryText, notionRichTextToString, parseRelationBlocks } from "../notion/client.js";
import { findPageByEntityId, doCreatePage, doUpdatePage, replaceSyncedRange } from "../notion/tools.js";
import { MEM0_USER_ID, NOTION_INDEX_PAGE_ID, NOTION_SYNC_PARENT_PAGE_ID } from "../../config.js";

const MEM0_ENTITY_PREFIX = "mem0:";

function notionEntityIdFor(memory) {
  return `${MEM0_ENTITY_PREFIX}${memory.metadata?.entity_id || memory.id}`;
}

function titleFor(memory) {
  const text = (memory.memory || memory.text || "").trim();
  const firstLine = text.split("\n")[0];
  return (firstLine.slice(0, 60) || "(mem0 memory)") + (firstLine.length > 60 ? "…" : "");
}

function contentLinesFor(memory) {
  const lines = (memory.memory || memory.text || "(no content)").split("\n").filter(Boolean);
  const tags = Array.isArray(memory.metadata?.tags) ? memory.metadata.tags : [];
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  return lines;
}

// mem0 status values line up 1:1 with Notion's -- see spec's TAG / STATUS /
// RELATION MAPPING section.
function statusFor(memory) {
  return memory.metadata?.status || undefined;
}

// DANGLING RELATIONS: to_entity_id is passed through with the mem0: prefix
// without pre-checking it resolves. Notion's own relation resolution
// (findPageByEntityId, used by notion_get_page) already reports "not found
// -- dangling reference" for anything unresolvable, so a second check here
// would just duplicate that at sync time for no real benefit -- the spec
// left this as an open "skip vs note" decision; passing through is the
// simpler of the two and defers to machinery that already exists.
function relationsFor(memory) {
  const relations = Array.isArray(memory.metadata?.relations) ? memory.metadata.relations : [];
  return relations.map((r) => ({ to_entity_id: `${MEM0_ENTITY_PREFIX}${r.to_entity_id}`, relation: r.relation }));
}

function relationsEqual(a = [], b = []) {
  const norm = (list) => list.map((r) => `${r.to_entity_id}::${r.relation}`).sort().join("|");
  return norm(a) === norm(b);
}

// Paginates the full set of memories in scope, same 100/page * up-to-10-page
// ceiling as findByEntityId/mem0_list elsewhere in this codebase. Optional
// entity_ids filters to specific mem0 entity_ids (not the mem0:-prefixed
// Notion form) after fetching, same client-side-filter tradeoff mem0_list
// already makes for tags/status.
async function listAllMemories({ user_id, entity_ids }) {
  const filters = { user_id };
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await mem0Request("/v3/memories/", { method: "POST", body: { filters, page, page_size: PAGE_SIZE } });
    const memories = data.results || data.memories || data || [];
    all.push(...memories);
    if (memories.length < PAGE_SIZE) break;
  }
  if (entity_ids?.length) {
    const wanted = new Set(entity_ids);
    return all.filter((m) => m.metadata?.entity_id && wanted.has(m.metadata.entity_id));
  }
  return all;
}

// Reads every mem0:-prefixed entry off the shared dedup index page (see
// notion/client.js's index-entry convention) -- the set of Notion pages
// this sync tool has ever created. Used only for hard-deletion detection
// (an entity_id present here but no longer in mem0's current memory set).
// Same first-100-blocks-per-page-read caveat as everywhere else this index
// is read; a workspace with >100 synced entities would need pagination
// added here to stay accurate.
async function readSyncedIndexEntries() {
  const data = await notionRequest(`/blocks/${NOTION_INDEX_PAGE_ID}/children?page_size=100`);
  const blocks = data.results || [];
  const entries = [];
  for (const b of blocks) {
    if (b.type !== "paragraph") continue;
    const entry = parseIndexEntryText(notionRichTextToString(b.paragraph?.rich_text || []));
    if (entry?.entity_id?.startsWith(MEM0_ENTITY_PREFIX)) entries.push(entry);
  }
  return entries;
}

async function syncOneMemory(memory, { dry_run }) {
  const notionEntityId = notionEntityIdFor(memory);
  const synced_at = memory.updated_at || memory.created_at || new Date().toISOString();
  const status = statusFor(memory);
  const relations = relationsFor(memory);
  const contentLines = contentLinesFor(memory);

  const existing = await findPageByEntityId(notionEntityId);

  // Superseded -> archive and stop; don't also try to write/update content
  // on a page we're archiving in the same pass.
  if (status === "superseded") {
    if (!existing) return { entity_id: notionEntityId, action: "skip-superseded-no-page" };
    if (dry_run) return { entity_id: notionEntityId, action: "would-archive", pageUrl: existing.url };
    await doUpdatePage({ page_id: existing.pageId, archived: true });
    return { entity_id: notionEntityId, action: "archived", pageUrl: existing.url };
  }

  if (!existing) {
    if (dry_run) return { entity_id: notionEntityId, action: "would-create" };
    const created = await doCreatePage({
      parent_id: NOTION_SYNC_PARENT_PAGE_ID, parent_type: "page",
      title: titleFor(memory), entity_id: notionEntityId, status, relations,
    });
    if (created.skipped) {
      // Lost a create-vs-create race against another sync run -- fall
      // through to the update path against the page that won.
      const range = await replaceSyncedRange({ page_id: created.existingId, contentLines, synced_at });
      return { entity_id: notionEntityId, action: `race-then-${range.action}`, pageUrl: created.existingUrl };
    }
    const range = await replaceSyncedRange({ page_id: created.id, contentLines, synced_at });
    return { entity_id: notionEntityId, action: `created-and-${range.action}`, pageUrl: created.url };
  }

  // Existing page: sync content (self-no-ops on unchanged synced_at), then
  // only touch status/relations if they actually differ, to avoid the same
  // needless-write/changelog-spam problem synced_at solves for content.
  if (dry_run) {
    const blocksData = await notionRequest(`/blocks/${existing.pageId}/children?page_size=100`);
    const blocks = blocksData.results || [];
    const currentRelations = parseRelationBlocks(blocks).map((r) => ({ to_entity_id: r.to_entity_id, relation: r.relation }));
    const statusChanged = (existing.markers.status || undefined) !== status;
    const relationsChanged = !relationsEqual(currentRelations, relations);
    return { entity_id: notionEntityId, action: "would-update", pageUrl: existing.url, statusChanged, relationsChanged };
  }

  const range = await replaceSyncedRange({ page_id: existing.pageId, contentLines, synced_at });

  const blocksData = await notionRequest(`/blocks/${existing.pageId}/children?page_size=100`);
  const blocks = blocksData.results || [];
  const currentRelations = parseRelationBlocks(blocks).map((r) => ({ to_entity_id: r.to_entity_id, relation: r.relation }));
  const statusChanged = (existing.markers.status || undefined) !== status;
  const relationsChanged = !relationsEqual(currentRelations, relations);
  if (statusChanged || relationsChanged) {
    await doUpdatePage({
      page_id: existing.pageId,
      status: statusChanged ? status : undefined,
      relations: relationsChanged ? relations : undefined,
    });
  }
  return { entity_id: notionEntityId, action: range.action, pageUrl: existing.url, statusChanged, relationsChanged };
}

export function register(server) {
  server.tool(
    "sync_mem0_to_notion",
    "One-way sync from mem0 into the Notion Memory Index (mem0 -> Notion only, no reverse direction) -- creates/updates a Notion page per mem0 memory, protecting any manual edits a person has added directly on those pages. Reuses the existing entity_id dedup index, marker conventions, and synced-content-range mechanism (notion_sync_content) rather than any new lookup/write logic. Skips no-op writes automatically (unchanged content isn't rewritten). Superseded mem0 memories get their Notion page archived, not deleted. Full syncs (no entity_ids filter) also detect and archive Notion pages whose source memory has been hard-deleted from mem0 entirely.",
    {
      dry_run:    z.boolean().optional().describe("If true, report what WOULD change (create/update/archive counts + per-item detail) without writing anything to Notion. Default: false."),
      entity_ids: z.array(z.string()).optional().describe("Optional filter to sync only mem0 memories with one of these mem0 entity_ids (not the mem0:-prefixed Notion form), instead of the full workspace. NOTE: using this filter disables hard-deletion detection for this run, since a partial sync can't tell 'deleted from mem0' apart from 'not in this batch'."),
    },
    async ({ dry_run = false, entity_ids }) => {
      const memories = await listAllMemories({ user_id: MEM0_USER_ID, entity_ids });
      const results = [];
      // Sequential, not Promise.all -- every item's dedup check reads the
      // same shared index page, so concurrent items can race the same way
      // notion_create_pages_batch's items did before that was fixed
      // 2026-07-17 (see runSequentially in notion/tools.js). Trades
      // throughput for correctness at this tool's expected scale.
      for (const memory of memories) {
        try {
          results.push(await syncOneMemory(memory, { dry_run }));
        } catch (err) {
          results.push({ entity_id: notionEntityIdFor(memory), action: "error", error: err.message });
        }
      }

      let deletionLines = [];
      if (!entity_ids?.length) {
        const currentEntityIds = new Set(memories.map((m) => notionEntityIdFor(m)));
        const indexEntries = await readSyncedIndexEntries();
        const orphaned = indexEntries.filter((e) => !currentEntityIds.has(e.entity_id));
        for (const entry of orphaned) {
          if (dry_run) {
            deletionLines.push(`  would-archive (source deleted from mem0): ${entry.entity_id} — ${entry.url}`);
            continue;
          }
          try {
            await doUpdatePage({ page_id: entry.page_id, archived: true });
            deletionLines.push(`  archived (source deleted from mem0): ${entry.entity_id} — ${entry.url}`);
          } catch (err) {
            // Notion rejects re-archiving a page that's already archived
            // ("Can't edit block that is archived") -- that's the correct
            // end state already reached (e.g. a prior run or a superseded-
            // status archive already handled it), not a real failure. Only
            // surface an error for anything else.
            if (/already archived|Can't edit block that is archived/i.test(err.message)) {
              deletionLines.push(`  already archived (no change needed): ${entry.entity_id} — ${entry.url}`);
            } else {
              deletionLines.push(`  ✗ failed to archive ${entry.entity_id} — ${err.message}`);
            }
          }
        }
      }

      const counts = results.reduce((acc, r) => {
        acc[r.action] = (acc[r.action] || 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(counts).map(([action, n]) => `${action}: ${n}`).join(", ");
      const lines = results.map((r) =>
        r.action === "error"
          ? `  ✗ ${r.entity_id} — ${r.error}`
          : `  ${r.action} — ${r.entity_id}${r.pageUrl ? ` (${r.pageUrl})` : ""}${r.statusChanged ? " [status changed]" : ""}${r.relationsChanged ? " [relations changed]" : ""}`
      );
      const header = `${dry_run ? "[DRY RUN] " : ""}Synced ${memories.length} memor${memories.length === 1 ? "y" : "ies"}. ${summary || "nothing to do"}.`;
      const deletionHeader = deletionLines.length ? `\n\nHard-deletion check:\n${deletionLines.join("\n")}` : (entity_ids?.length ? "\n\n(Hard-deletion check skipped — entity_ids filter was used.)" : "");
      return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}${deletionHeader}` }] };
    }
  );
}
