// ---------------------------------------------------------------------------
// connectors/notion/embed_client.js -- Phase 2 of the Notion connector
// overhaul (plan-madmcp-notion-overhaul on Notion). Triggers the repo-map
// worker's /notion/embed route (worker/src/server.js) to embed a Notion
// page's text and write it to notion_page_embeddings.
//
// Reuses the SAME Render deployment and shared-secret auth as map.query's
// worker (REPO_MAP_WORKER_URL / REPO_MAP_SHARED_SECRET, see
// connectors/repomap/client.js) -- this is deliberately a new route on that
// existing service, not a second service, per the 2026-09-27 Phase 2
// decision (avoids standing up a second free-tier host with its own
// sleep/cron-ping problem).
//
// Never THROWS -- every failure (missing config, network error, worker
// 5xx) is swallowed, since nothing here should ever fail the Notion
// write/search path that triggered it. A page that fails to embed just
// stays un-reranked/un-deduped-by-similarity until the next successful
// trigger -- degraded, not broken (exact-match entity_id dedup and plain
// keyword search both still work with zero embeddings at all, since this
// is a rerank/enrichment layer on top of them).
//
// Returns the underlying promise. Most callers that don't need the
// embedding to have landed yet (e.g. a search-triggered lazy backfill,
// where there's nothing later in the same call that depends on it) can
// still call this without awaiting, same fire-and-forget posture as
// before. Callers where a later step in the SAME request could race
// against this embedding landing in Neon (e.g. doCreatePage running
// findSimilarPages against a page created moments earlier in the same
// batch) should `await` it instead, to close that window -- see #2 in the
// 2026-09-27 post-merge findings on the plan-madmcp-notion-overhaul Notion
// page. Either way this never throws, so awaiting it never risks failing
// the caller's own operation.
// ---------------------------------------------------------------------------

import { REPO_MAP_WORKER_URL, REPO_MAP_SHARED_SECRET } from "../../config.js";

// Audit A7: callers await this from doCreatePage/doUpdatePage, and a cold
// (sleeping) Render worker can take far longer than a Notion write should
// wait. On timeout the fetch aborts and lands in the catch below like any
// other failure (logged, never thrown).
const EMBED_TIMEOUT_MS = 15000;

export async function triggerNotionEmbed({ page_id, content }) {
  if (!REPO_MAP_WORKER_URL || !REPO_MAP_SHARED_SECRET) return; // not configured -- silently skip, same as map.query's optional-connector posture
  try {
    const res = await fetch(`${REPO_MAP_WORKER_URL}/notion/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${REPO_MAP_SHARED_SECRET}`,
      },
      body: JSON.stringify({ page_id, content }),
      signal: globalThis.AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[notion-embed] worker returned ${res.status} for page ${page_id}: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    // Best-effort -- see file header. Nothing to do with a failure here;
    // the page just stays un-embedded until the next touch retries it. Log
    // it so a down/misbehaving worker is at least visible somewhere,
    // instead of silently degrading search quality with zero trace.
    console.error(`[notion-embed] request failed for page ${page_id}: ${err.message || err}`);
  }
}
