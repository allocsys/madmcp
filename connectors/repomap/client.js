// ---------------------------------------------------------------------------
// connectors/repomap/client.js — map (index+query) talks to the
// repo_map worker (worker/, deployed separately on Railway) over HTTP,
// auth'd with a shared-secret bearer token (worker/src/auth.js). Scanning a
// repo requires a clone token minted via GitHub App auth (same mechanism as
// the get_repo_clone_token MCP tool), since the worker needs to clone the
// target repo itself.
//
// The query/read path (search/graph) queries Neon directly (queries.js) --
// no worker hop needed, since neither semantic search nor graph traversal
// require anything the worker uniquely provides (the worker's job is the
// scan: clone + parse + chunk + embed + write). See queries.js/db.js for
// why this uses a separate, read-only DB credential from the worker's.
// ---------------------------------------------------------------------------

import { REPO_MAP_WORKER_URL, REPO_MAP_SHARED_SECRET, DEFAULT_OWNER } from "../../config.js";
import { getCloneToken } from "../github/app_auth.js";
import { githubRequest } from "../github/client.js";
import { queryChunksDb, queryGraphDb, getRepoRow } from "./queries.js";

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
  let cloneToken;
  try {
    ({ token: cloneToken } = await getCloneToken(owner, repo));
  } catch (err) {
    // The GitHub App is only installed on a narrow set of repos. Minting
    // fails for any repo outside that set -- expected for public repos the
    // App was never installed on, not a real error. Fall back to a
    // tokenless clone; the worker already supports that for public repos
    // (worker/src/scan/clone.js). Anything else (missing config, genuine
    // auth failure) still throws.
    //
    // Prefer the actual HTTP status (set in app_auth.js) over matching
    // GitHub's error wording -- that wording isn't a stable contract and
    // has already drifted once. Status check first; the string match is
    // kept only as a fallback for an error object that predates err.status
    // being set, and covers a couple of phrasings GitHub has used for this.
    const notInstalled = err.status === 404 || err.status === 422 ||
      /not accessible to the parent installation|resource not accessible by integration/i.test(err.message);
    if (!notInstalled) {
      throw err;
    }
  }
  return workerRequest("/scan", {
    method: "POST",
    body: { owner, repo, ref, cloneToken },
  });
}

export async function getScanStatus(jobId) {
  return workerRequest(`/status/${encodeURIComponent(jobId)}`);
}

// Pure freshness check (no side effects): compares the repo's current HEAD
// sha (for `ref`, or the repo's own default_ref if `ref` is omitted) against
// repos.last_scanned_commit. Exported so callers (the `map` tool) can decide
// what to do about staleness themselves -- block and show progress, queue a
// background scan, just report status, etc -- rather than this module
// always making that call for them.
//
// Deliberately reports {scanned:false} rather than throwing when the repo
// has never been scanned (not this function's problem -- callers already
// have a "never scanned" message to show). Errors fetching the HEAD sha
// (transient GitHub API hiccup) do propagate here, since callers that
// explicitly asked for a freshness check want to know it failed, unlike the
// old fire-and-forget path below which needs to fail soft.
export async function getFreshness({ owner = DEFAULT_OWNER, repo, ref }) {
  const repoRow = await getRepoRow(owner, repo);
  if (!repoRow) return { scanned: false };
  const branch = ref || repoRow.default_ref;
  const { object } = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = object?.sha;
  return {
    scanned: true,
    fresh: !!headSha && headSha === repoRow.last_scanned_commit,
    headSha,
    lastScannedCommit: repoRow.last_scanned_commit,
    branch,
  };
}

// Fire-and-forget staleness check, fired and NOT awaited to completion, so
// this never adds scan latency to the read that triggered it -- that read
// still answers from whatever's currently indexed; the *next* read sees the
// fresh data once the background scan lands. Kept for searchChunks/
// queryGraph below so any lower-level caller of those (not going through the
// `map` tool's explicit blocking gate) still gets this self-healing
// behavior. Failures here are swallowed -- a staleness check should never
// break the read path itself.
async function ensureFresh({ owner = DEFAULT_OWNER, repo, ref }) {
  try {
    const status = await getFreshness({ owner, repo, ref });
    if (!status.scanned || status.fresh) return; // never scanned (not our problem) or already fresh
    await startScan({ owner, repo, ref: status.branch });
  } catch {
    // Staleness check itself failing is not the caller's problem -- fall
    // through and let the read answer from whatever's currently indexed.
  }
}

// Semantic search over embedded chunks (functions/classes) in a scanned repo.
// Queries Neon directly -- see queries.js. Returns the same { results } shape
// the worker's HTTP endpoint used to, so tools.js needed no changes.
export async function searchChunks({ owner = DEFAULT_OWNER, repo, query, topK }) {
  await ensureFresh({ owner, repo });
  const results = await queryChunksDb({ owner, repo, query, topK });
  return { results };
}

// Graph traversal: callers/callees of a symbol, or importers/imports of a file.
// Queries Neon directly -- see queries.js.
export async function queryGraph({ owner = DEFAULT_OWNER, repo, symbol, file, direction, depth }) {
  await ensureFresh({ owner, repo });
  const results = await queryGraphDb({ owner, repo, symbol, file, direction, depth });
  return { results };
}
