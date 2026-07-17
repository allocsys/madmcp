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
      const text =
        `# ${title}\n` +
        `ID: ${page.id}\n` +
        `URL: ${page.url}\n` +
        `Created: ${page.created_time?.slice(0, 10)} | Last edited: ${page.last_edited_time?.slice(0, 10)}\n\n` +
        (content || "(no content)") + hasMore + childSummary;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "notion_create_page",
    "Create a new Notion page inside a parent page or database.",
    {
      parent_id:   z.string().describe("ID of the parent page or database"),
      parent_type: z.enum(["page", "database"]).describe("Whether the parent is a page or a database"),
      title:       z.string().describe("Title of the new page"),
      content:     z.string().optional().describe("Plain text content to add as paragraph blocks"),
    },
    async ({ parent_id, parent_type, title, content }) => {
      const parent     = parent_type === "database" ? { database_id: parent_id } : { page_id: parent_id };
      const properties = parent_type === "database"
        ? { Name:  { title: [{ text: { content: title } }] } }
        : { title: { title: [{ text: { content: title } }] } };
      const children = content
        ? content.split("\n").filter(Boolean).map((line) => ({
            object: "block", type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
          }))
        : [];
      const data = await notionRequest("/pages", {
        method: "POST",
        body: { parent, properties, children },
      });
      return { content: [{ type: "text", text: `Created Notion page "${title}"\nID: ${data.id}\nURL: ${data.url}` }] };
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
    "Update a Notion page's title or properties, or append text content to it.",
    {
      page_id:        z.string().describe("Notion page ID to update"),
      title:          z.string().optional().describe("New title for the page"),
      append_content: z.string().optional().describe("Plain text to append as new paragraph blocks"),
      archived:       z.boolean().optional().describe("Set true to archive (trash) the page, false to restore"),
    },
    async ({ page_id, title, append_content, archived }) => {
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
      return { content: [{ type: "text", text: results.join("\n") || "No changes made." }] };
    }
  );
}
