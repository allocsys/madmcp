// ---------------------------------------------------------------------------
// connectors/repomap/client.js — talks to the repo_map worker (worker/,
// deployed separately on Railway). Auth: shared-secret bearer token
// (worker/src/auth.js). Scanning a repo requires a clone token minted via
// GitHub App auth (same mechanism as the get_repo_clone_token MCP tool),
// since the worker needs to clone the target repo itself.
// ---------------------------------------------------------------------------

import { REPO_MAP_WORKER_URL, REPO_MAP_SHARED_SECRET, DEFAULT_OWNER } from "../../config.js";
import { getCloneToken } from "../github/app_auth.js";

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
export async function searchChunks({ owner = DEFAULT_OWNER, repo, query, topK }) {
  return workerRequest("/query/search", {
    method: "POST",
    body: { owner, repo, query, topK },
  });
}

// Graph traversal: callers/callees of a symbol, or importers/imports of a file.
export async function queryGraph({ owner = DEFAULT_OWNER, repo, symbol, file, direction, depth }) {
  return workerRequest("/query/graph", {
    method: "POST",
    body: { owner, repo, symbol, file, direction, depth },
  });
}
