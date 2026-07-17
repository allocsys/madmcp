// ---------------------------------------------------------------------------
// connectors/notion/tools.js
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  notionRequest, notionPageTitle, notionDatabaseTitle, notionRichTextToString,
  notionBlocksToText, buildMarkerBlocks, statusMarkerBlock, notionBlockPlainText, parseMarkers,
} from "./client.js";

const STATUS_VALUES = ["open", "resolved", "superseded"];

// ---------------------------------------------------------------------------
// Dedup/upsert lookup (2026-07-17, gap #1 -- see mem0 entity_id:
// madmcp-notion-connector-gaps-roadmap). Mirrors mem/tools.js's
// findByEntityId, adapted to Notion's constraints: there's no indexed
// metadata field to filter on server-side, so this leans on Notion's own
// search (best-effort full-text, not a guaranteed exact match) to narrow
// candidates, then confirms via parseMarkers on each candidate's actual
// blocks. Bounded to the top 20 search results x first 20 blocks each --
// same kind of pragmatic ceiling mem/tools.js's own findByEntityId applies
// (there, a 1000-memory pagination cap; here, a much lower bound since each
// candidate costs a full extra API call with no cheaper server-side filter
// available).
async function findPageByEntityId(entity_id) {
  const data = await notionRequest("/search", {
    method: "POST",
    body: { query: entity_id, filter: { value: "page", property: "object" }, page_size: 20 },
  });
  for (const page of data.results || []) {
    const blocksData = await notionRequest(`/blocks/${page.id}/children?page_size=20`);
    const markers = parseMarkers(blocksData.results || []);
    if (markers.entity_id === entity_id) {
      return { pageId: page.id, title: notionPageTitle(page), url: page.url, markers };
    }
  }
  return null;
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
    },
    async ({ page_id }) => {
      const [page, blocksData] = await Promise.all([
        notionRequest(`/pages/${page_id}`),
        notionRequest(`/blocks/${page_id}/children?page_size=100`),
      ]);
      const title    = notionPageTitle(page);
      const blocks   = blocksData.results || [];
      const content  = notionBlocksToText(blocks);
      const hasMore  = blocksData.has_more ? "\n\n⚠️ Page has more blocks — only first 100 shown." : "";
      const subPages     = blocks.filter((b) => b.type === "child_page").length;
      const subDatabases = blocks.filter((b) => b.type === "child_database").length;
      const childSummary = (subPages || subDatabases)
        ? `\n\n🔗 ${subPages} subpage(s), ${subDatabases} subdatabase(s) found — use notion_get_page on their IDs above to view them.`
        : "";
      const markers      = parseMarkers(blocks);
      const markerLine   = (markers.entity_id || markers.status)
        ? `\n${markers.entity_id ? `Entity ID: ${markers.entity_id}` : ""}${markers.entity_id && markers.status ? " | " : ""}${markers.status ? `Status: ${markers.status}` : ""}`
        : "";
      const text =
        `# ${title}\n` +
        `ID: ${page.id}\n` +
        `URL: ${page.url}\n` +
        `Created: ${page.created_time?.slice(0, 10)} | Last edited: ${page.last_edited_time?.slice(0, 10)}${markerLine}\n\n` +
        (content || "(no content)") + hasMore + childSummary;
      return { content: [{ type: "text", text }] };
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
    },
    async ({ parent_id, parent_type, title, content, entity_id, status }) => {
      if (entity_id) {
        const existing = await findPageByEntityId(entity_id);
        if (existing) {
          return {
            content: [{
              type: "text",
              text:
                `Not creating — a page already exists for entity_id "${entity_id}" (id: ${existing.pageId}, title: "${existing.title}"). No duplicate was created.\n` +
                `URL: ${existing.url}\n\n` +
                `Next step: call notion_get_page on this id to review current content, then notion_update_page (append_content or replacements) to update it instead of creating a new page.`,
            }],
          };
        }
      }
      const parent     = parent_type === "database" ? { database_id: parent_id } : { page_id: parent_id };
      const properties = parent_type === "database"
        ? { Name:  { title: [{ text: { content: title } }] } }
        : { title: { title: [{ text: { content: title } }] } };
      const markerBlocks  = buildMarkerBlocks({ entity_id, status });
      const contentBlocks = content
        ? content.split("\n").filter(Boolean).map((line) => ({
            object: "block", type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
          }))
        : [];
      const children = [...markerBlocks, ...contentBlocks];
      const data = await notionRequest("/pages", {
        method: "POST",
        body: { parent, properties, children },
      });
      const markerNote = markerBlocks.length ? ` (with ${entity_id ? "entity_id" : ""}${entity_id && status ? " + " : ""}${status ? "status" : ""} marker${markerBlocks.length > 1 ? "s" : ""})` : "";
      return { content: [{ type: "text", text: `Created Notion page "${title}"${markerNote}\nID: ${data.id}\nURL: ${data.url}` }] };
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

  const EDITABLE_BLOCK_TYPES = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do"];

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
    },
    async ({ page_id, title, append_content, archived, replacements, status }) => {
      const results = [];
      if (title !== undefined || archived !== undefined) {
        const body = {};
        if (archived !== undefined) body.archived = archived;
        if (title    !== undefined) body.properties = { title: { title: [{ text: { content: title } }] } };
        const data = await notionRequest(`/pages/${page_id}`, { method: "PATCH", body });
        results.push(`Updated page "${notionPageTitle(data)}" (ID: ${data.id}).`);
      }
      if (append_content) {
        const children = append_content.split("\n").filter(Boolean).map((line) => ({
          object: "block", type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
        }));
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
            return { content: [{ type: "text", text: `Update aborted, nothing further written — "${trunc(find)}" was not found among this page's top-level blocks (first 100). It may be nested inside a toggle/column, or the page may have more than 100 blocks — re-check with notion_get_page.` }], isError: true };
          }
          if (matches.length > 1) {
            return { content: [{ type: "text", text: `Update aborted, nothing further written — "${trunc(find)}" matches ${matches.length} blocks, but must be unique. Include more surrounding context in "find" to disambiguate.` }], isError: true };
          }
          const block = matches[0];
          const type  = block.type;
          if (!EDITABLE_BLOCK_TYPES.includes(type)) {
            return { content: [{ type: "text", text: `Update aborted, nothing further written — matched block is type "${type}", which notion_update_page can't edit in place yet (supported: ${EDITABLE_BLOCK_TYPES.join(", ")}).` }], isError: true };
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
      return { content: [{ type: "text", text: results.join("\n") || "No changes made." }] };
    }
  );
}
