// ---------------------------------------------------------------------------
// connectors/notion/commit_log.js
// ---------------------------------------------------------------------------

import { COMMIT_LOG_ENABLED } from "../../config.js";
import { notionRequest, findPageByEntityId, isCommitLogMarkerText, findCheckpointRange, notionBlockPlainText } from "./client.js";

// Single source of truth for the commit-log cap. Both write paths use it:
// recordCommit (trims right after every insert) and doCheckpoint's save
// (backstop, in tools.js). Entries are inserted newest-first right after the
// log marker, so the OLDEST entries are the ones at the bottom of the section.
export const COMMIT_LOG_MAX_ENTRIES = 8;

// Returns the log entry blocks (paragraphs between the log marker and the
// checkpoint start marker, newest first), or null if the section can't be
// located unambiguously in `blocks` -- in which case callers must NOT delete
// anything (e.g. the start marker is beyond the fetched window).
export function findCommitLogEntries(blocks = []) {
  const range = findCheckpointRange(blocks);
  if (!range) return null;
  const startIdx = blocks.findIndex((b) => b.id === range.startBlockId);
  if (startIdx < 0) return null;
  let markerIdx = -1;
  for (let i = 0; i < startIdx; i++) {
    if (blocks[i].type === "paragraph" && isCommitLogMarkerText(notionBlockPlainText(blocks[i]))) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx === -1) return null;
  return {
    markerId: blocks[markerIdx].id,
    entries: blocks.slice(markerIdx + 1, startIdx).filter((b) => b.type === "paragraph"),
  };
}

// Deletes every entry beyond the newest `max`. Returns { removed, failed }.
// Individual delete failures are collected (not thrown) so one bad block
// can't stop the rest, and the caller can log them instead of hiding them.
export async function trimCommitLogBlocks(blocks, max = COMMIT_LOG_MAX_ENTRIES) {
  const log = findCommitLogEntries(blocks);
  if (!log || log.entries.length <= max) return { removed: 0, failed: [] };
  let removed = 0;
  const failed = [];
  for (const b of log.entries.slice(max)) {
    try {
      await notionRequest(`/blocks/${b.id}`, { method: "DELETE" });
      removed++;
    } catch (err) {
      // 404 = a concurrent trim already removed it; the goal is met.
      if (/\(404\)/.test(err.message)) { removed++; continue; }
      failed.push({ id: b.id, error: err.message });
    }
  }
  return { removed, failed };
}

function firstLineOfMessage(msg, maxLen = 100) {
  if (!msg) return "";
  const firstLine = String(msg).split(/\r?\n/)[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 1) + "…";
}

function formatFilesSummary(files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (list.length === 0) return "no files";
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} +${list.length - 3} more`;
}

// Commits recorded in the same process are applied one at a time, so two
// merges landing together can't interleave their insert/trim sequences.
let recordQueue = Promise.resolve();

export function recordCommit(entry) {
  if (!COMMIT_LOG_ENABLED) return Promise.resolve();
  const run = () => recordCommitUnqueued(entry);
  const result = recordQueue.then(run, run);
  recordQueue = result.then(() => {}, () => {});
  return result;
}

async function recordCommitUnqueued({ sha, message, files, branch, ts }) {
  try {
    const existing = await findPageByEntityId("checkpoint-latest");
    if (!existing) return;

    const page_id = existing.pageId;
    const data = await notionRequest(`/blocks/${page_id}/children?page_size=100`);
    const blocks = data.results || [];

    let logMarkerBlockId = null;
    for (const b of blocks) {
      if (b.type !== "paragraph") continue;
      const blockText = (b.paragraph?.rich_text || []).map((t) => t.plain_text || "").join("");
      if (isCommitLogMarkerText(blockText)) {
        logMarkerBlockId = b.id;
        break;
      }
    }

    if (!logMarkerBlockId) return;

    const shortSha = sha ? sha.slice(0, 7) : "unknown";
    const msgSummary = firstLineOfMessage(message, 100);
    const filesSummary = formatFilesSummary(files);
    const logText = `${shortSha} · ${msgSummary} · ${branch || "unknown"} · ${filesSummary} · ${ts || new Date().toISOString()}`;

    const paragraph = {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: logText } }]
      }
    };

    await notionRequest(`/blocks/${page_id}/children`, {
      method: "PATCH",
      body: { children: [paragraph], after: logMarkerBlockId }
    });

    // Enforce the cap on EVERY insert, not only on checkpoint save -- commits
    // can land many times between saves, and the log used to grow unbounded
    // in that window. Re-read so the trim sees the entry we just added.
    const fresh = await notionRequest(`/blocks/${page_id}/children?page_size=100`);
    const { failed } = await trimCommitLogBlocks(fresh.results || []);
    for (const f of failed) {
      console.warn(`[commit-log] Failed to trim old entry ${f.id}: ${f.error}`);
    }
  } catch (err) {
    console.warn(`[commit-log] Failed to record commit: ${err.message}`);
  }
}
