// ---------------------------------------------------------------------------
// connectors/notion/commit_log.js
// ---------------------------------------------------------------------------

import { COMMIT_LOG_ENABLED } from "../../config.js";
import { notionRequest, findPageByEntityId, isCommitLogMarkerText } from "./client.js";

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

export async function recordCommit({ sha, message, files, branch, ts }) {
  if (!COMMIT_LOG_ENABLED) return;
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
  } catch (err) {
    console.warn(`[commit-log] Failed to record commit: ${err.message}`);
  }
}
