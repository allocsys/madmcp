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
// Fire-and-forget by design, same reasoning as connectors/repomap/
// client.js's ensureFresh(): embedding a page should never add latency or a
// failure mode to the create/update/search call that triggered it. A page
// that fails to embed just stays un-reranked/un-deduped-by-similarity until
// the next successful trigger -- degraded, not broken (exact-match entity_id
// dedup and plain keyword search both still work with zero embeddings at
// all, since this is a rerank/enrichment layer on top of them).
// ---------------------------------------------------------------------------

import { REPO_MAP_WORKER_URL, REPO_MAP_SHARED_SECRET } from "../../config.js";

// Not awaited by callers -- see file header. Swallows every failure
// (missing config, network error, worker 5xx) rather than throwing, since
// nothing here should ever block or fail the Notion write/search path that
// triggered it.
export function triggerNotionEmbed({ page_id, content }) {
  if (!REPO_MAP_WORKER_URL || !REPO_MAP_SHARED_SECRET) return; // not configured -- silently skip, same as map.query's optional-connector posture
  fetch(`${REPO_MAP_WORKER_URL}/notion/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${REPO_MAP_SHARED_SECRET}`,
    },
    body: JSON.stringify({ page_id, content }),
  }).catch(() => {
    // Best-effort -- see file header. Nothing to do with a failure here;
    // the page just stays un-embedded until the next touch retries it.
  });
}
