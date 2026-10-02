// ---------------------------------------------------------------------------
// connectors/notion/markdown.js
//
// Thin layer over Notion's page-markdown endpoints (GET/PATCH
// /pages/{id}/markdown, Notion-Version 2026-03-11). Unlike the block API these
// see nested blocks (toggles, columns, tables, code, callouts), keep formatting,
// and support true substring search/replace.
//
// Only notionRequest is imported from client.js, so tests that mock client.js
// keep working: anything unexpected from the mock is treated as "markdown API
// unavailable" and callers fall back to the block API.
// ---------------------------------------------------------------------------

import { NOTION_MARKDOWN_VERSION } from "../../config.js";
import { sleep } from "../shared/rate-limit.js";
import { notionRequest } from "./client.js";

export const ENTITY_LINE_PREFIX = "\u{1F511} entity_id:";
export const STATUS_LINE_PREFIX = "\u{1F3F7}\uFE0F status:";
export const RELATION_LINE_PREFIX = "\u{1F517} ";
export const CHANGELOG_LINE_PREFIX = "\u{1F4DC} ";

// Reads a page (or a block subtree, e.g. an id from unknown_block_ids) as
// markdown. Returns null when the response isn't a markdown payload at all.
export async function fetchPageMarkdown(id, { includeTranscript = false } = {}) {
  const qs = includeTranscript ? "?include_transcript=true" : "";
  const data = await notionRequest(`/pages/${id}/markdown${qs}`, { version: NOTION_MARKDOWN_VERSION });
  if (!data || typeof data.markdown !== "string") return null;
  return {
    markdown: data.markdown,
    truncated: data.truncated === true,
    unknownBlockIds: Array.isArray(data.unknown_block_ids) ? data.unknown_block_ids : [],
  };
}

const ASYNC_MAX_POLLS = 30;

// PATCH /pages/{id}/markdown with one command. The sync response is the whole
// page as markdown; if Notion hands back an async_task instead, poll it.
export async function patchPageMarkdown(id, command) {
  let data = await notionRequest(`/pages/${id}/markdown`, {
    method: "PATCH", body: command, version: NOTION_MARKDOWN_VERSION,
  });
  for (let i = 0; data?.object === "async_task" && i < ASYNC_MAX_POLLS; i++) {
    if (data.status === "failed") {
      throw new Error(`Notion API error (${data.error?.status ?? 400}): ${data.error?.message || "async markdown update failed"}`);
    }
    if (data.status === "succeeded") { data = data.result; break; }
    const wait = Number(data.poll_after_seconds);
    await sleep((Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 10) : 2) * 1000);
    data = await notionRequest(`/async_tasks/${data.id}`, { version: NOTION_MARKDOWN_VERSION });
  }
  if (data?.object === "async_task") throw new Error("Notion markdown update is still running after polling; check the page before retrying.");
  return {
    truncated: data?.truncated === true,
    length: typeof data?.markdown === "string" ? data.markdown.length : null,
  };
}

// Yields [line, insideCodeFence] so marker/changelog lines quoted in a code
// block are never mistaken for real ones.
function* scanLines(markdown) {
  let fence = null;
  for (const line of String(markdown).split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) { fence = m[1][0]; yield [line, true]; continue; }
      if (m[1][0] === fence) { fence = null; yield [line, true]; continue; }
    }
    yield [line, fence !== null];
  }
}

// Marker lines (entity_id, status, relations) that the dedup index and
// notion_read depend on. notion_update's replace_content re-attaches them.
export function extractMarkerLines(markdown) {
  const out = [];
  for (const [line, inCode] of scanLines(markdown)) {
    if (inCode) continue;
    if (line.startsWith(ENTITY_LINE_PREFIX) || line.startsWith(STATUS_LINE_PREFIX) || line.startsWith(RELATION_LINE_PREFIX)) out.push(line);
  }
  return out;
}

export function parseMarkdownMarkers(markdown) {
  const result = { entity_id: null, status: null, relations: [] };
  for (const [line, inCode] of scanLines(markdown)) {
    if (inCode) continue;
    if (line.startsWith(ENTITY_LINE_PREFIX) && !result.entity_id) result.entity_id = line.slice(ENTITY_LINE_PREFIX.length).trim();
    else if (line.startsWith(STATUS_LINE_PREFIX) && !result.status) result.status = line.slice(STATUS_LINE_PREFIX.length).trim();
    else if (line.startsWith(RELATION_LINE_PREFIX)) {
      const rest = line.slice(RELATION_LINE_PREFIX.length);
      const i = rest.indexOf(" -> ");
      if (i !== -1) result.relations.push({ relation: rest.slice(0, i).trim(), to_entity_id: rest.slice(i + 4).trim() });
    }
  }
  return result;
}

// Splits changelog paragraphs out of the body so reads stay clean.
export function splitChangelog(markdown) {
  const body = [];
  const history = [];
  for (const [line, inCode] of scanLines(markdown)) {
    if (!inCode && line.startsWith(CHANGELOG_LINE_PREFIX)) history.push(line);
    else body.push(line);
  }
  return { body: body.join("\n"), history };
}

// Prepends any marker lines the new content doesn't already carry.
export function withPreservedMarkers(newContent, currentMarkdown) {
  const present = new Set(extractMarkerLines(newContent));
  const hasPrefix = (p) => [...present].some((l) => l.startsWith(p));
  const keep = extractMarkerLines(currentMarkdown).filter((l) => {
    if (present.has(l)) return false;
    if (l.startsWith(ENTITY_LINE_PREFIX)) return !hasPrefix(ENTITY_LINE_PREFIX);
    if (l.startsWith(STATUS_LINE_PREFIX)) return !hasPrefix(STATUS_LINE_PREFIX);
    return true;
  });
  return keep.length ? `${keep.join("\n")}\n${newContent}` : newContent;
}
