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

export function notionBlocksToText(blocks = []) {
  return blocks
    .map((b) => {
      const type  = b.type;
      const block = b[type];
      if (!block) return "";
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
