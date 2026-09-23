// ---------------------------------------------------------------------------
// connectors/repomap/client.js — repo_map_scan (write path) talks to the
// repo_map worker (worker/, deployed separately on Railway) over HTTP,
// auth'd with a shared-secret bearer token (worker/src/auth.js). Scanning a
// repo requires a clone token minted via GitHub App auth (same mechanism as
// the get_repo_clone_token MCP tool), since the worker needs to clone the
// target repo itself.
//
// repo_map's search/graph (read path) query Neon directly (queries.js) --
// no worker hop needed, since neither semantic search nor graph traversal
// require anything the worker uniquely provides (the worker's job is the
// scan: clone + parse + chunk + embed + write). See queries.js/db.js for
// why this uses a separate, read-only DB credential from the worker's.
// ---------------------------------------------------------------------------

import { REPO_MAP_WORKER_URL, REPO_MAP_SHARED_SECRET, DEFAULT_OWNER } from "../../config.js";
import { getCloneToken } from "../github/app_auth.js";
import { queryChunksDb, queryGraphDb } from "./queries.js";

function assertConfigured() {
  if (!REPO_MAP_WORKER_URL) throw new Error("REPO_MAP_WORKER_URL is not set -- the repo_map worker hasn't been deployed/configured yet.");
  if (!REPO_MAP_SHARED_SECRET) throw new Error("REPO_MAP_SHARED_SECRET is not set -- required to authenticate to the repo_map worker.");
}

async function workerRequest(path, { method = "GET", body } = {}) {
  assertConfigured();
  const res = await fetch(`${REPO_MAP_WORKER_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${REPO_MAP_SHARED_SECRET}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = (data && (data.error || JSON.stringify(data))) || res.statusText;
    throw new Error(`repo_map worker error (${res.status}): ${message}`);
  }
  return data;
}

// Kicks off (or enqueues) a scan for a repo. Mints a fresh single-repo clone
// token so the worker can clone it, same credential the get_repo_clone_token
// MCP tool hands to the calling model directly -- here it goes straight to
// the worker over the server-to-server request instead, so it's never
// exposed to the model/user. Returns { jobId, status } immediately; the scan
// runs in the background on the worker.
export async function startScan({ owner = DEFAULT_OWNER, repo, ref }) {
  const { token } = await getCloneToken(owner, repo);
  return workerRequest("/scan", {
    method: "POST",
    body: { owner, repo, ref, cloneToken: token },
  });
}

export async function getScanStatus(jobId) {
  return workerRequest(`/status/${encodeURIComponent(jobId)}`);
}

// Semantic search over embedded chunks (functions/classes) in a scanned repo.
// Queries Neon directly -- see queries.js. Returns the same { results } shape
// the worker's HTTP endpoint used to, so tools.js needed no changes.
export async function searchChunks({ owner = DEFAULT_OWNER, repo, query, topK }) {
  const results = await queryChunksDb({ owner, repo, query, topK });
  return { results };
}

// Graph traversal: callers/callees of a symbol, or importers/imports of a file.
// Queries Neon directly -- see queries.js.
export async function queryGraph({ owner = DEFAULT_OWNER, repo, symbol, file, direction, depth }) {
  const results = await queryGraphDb({ owner, repo, symbol, file, direction, depth });
  return { results };
}
