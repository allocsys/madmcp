// ---------------------------------------------------------------------------
// connectors/github/client.js
// ---------------------------------------------------------------------------

import https from "node:https";
import { URL } from "node:url";
import {
  GITHUB_TOKEN,
  GITHUB_API,
  GITHUB_MIN_REQUEST_INTERVAL_MS,
  GITHUB_MAX_RETRIES,
  GITHUB_RETRY_BASE_MS,
} from "../../config.js";

function assertConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it as an environment variable on the madmcp server."
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Throttle (fix #2) -----------------------------------------------------
// GitHub's secondary rate limit is triggered by request burstiness /
// concurrency, independent of remaining hourly quota. A single shared
// promise chain serializes all outgoing requests and enforces a minimum gap
// between them, so bursts of tool calls (even concurrent ones) get spaced
// out automatically instead of hammering the API back-to-back.
let throttleChain = Promise.resolve();
let lastRequestAt = 0;

function scheduleThrottled(fn) {
  const run = async () => {
    const wait = lastRequestAt + GITHUB_MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  };
  // Chain onto the shared queue regardless of whether prior requests
  // succeeded or failed, so one failure doesn't jam the whole queue.
  const result = throttleChain.then(run, run);
  // Keep the chain alive without leaking rejections into unrelated callers.
  throttleChain = result.then(() => {}, () => {});
  return result;
}

// --- Retry with backoff (fix #1) -------------------------------------------
// Only retries responses that indicate pacing problems (secondary rate
// limit, primary quota exhaustion, or a plain 429) -- any other 4xx/5xx is a
// real error and is thrown immediately, unretried.
// Exported (previously module-private) so it's directly unit-testable --
// see test/github-client.test.js.
export function isRetryable(res, data) {
  if (res.status === 429) return true;
  if (res.status === 403) {
    const msg = (data && (data.message || JSON.stringify(data))) || "";
    if (/secondary rate limit/i.test(msg)) return true;
    if (res.headers.get("x-ratelimit-remaining") === "0") return true;
  }
  return false;
}

// Exported (previously module-private) so it's directly unit-testable --
// see test/github-client.test.js.
export function retryDelayMs(res, attempt) {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && !Number.isNaN(Number(retryAfter))) {
    return Number(retryAfter) * 1000;
  }
  const resetAt = res.headers.get("x-ratelimit-reset");
  if (resetAt) {
    const ms = Number(resetAt) * 1000 - Date.now();
    if (ms > 0 && ms < 15 * 60 * 1000) return ms; // sanity cap: don't wait >15min
  }
  // Exponential backoff with jitter as a fallback.
  const jitter = Math.random() * 250;
  return GITHUB_RETRY_BASE_MS * 2 ** attempt + jitter;
}

async function doFetch(path, { method, body, accept }) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "madmcp-server",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { res, data };
}

export async function githubRequest(path, { method = "GET", body, accept } = {}) {
  assertConfigured();

  let lastErr;
  for (let attempt = 0; attempt <= GITHUB_MAX_RETRIES; attempt++) {
    const { res, data } = await scheduleThrottled(() => doFetch(path, { method, body, accept }));

    if (res.ok) return data;

    if (isRetryable(res, data) && attempt < GITHUB_MAX_RETRIES) {
      await sleep(retryDelayMs(res, attempt));
      lastErr = res;
      continue;
    }

    const message = (data && (data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`GitHub API error (${res.status}): ${message}`);
  }

  // Exhausted retries.
  const message = lastErr ? lastErr.statusText : "rate limited";
  throw new Error(`GitHub API error (${lastErr ? lastErr.status : 429}): ${message} -- exhausted ${GITHUB_MAX_RETRIES} retries`);
}

// GitHub's REST API has no endpoint to convert a draft PR to ready-for-review
// -- that action only exists as the markPullRequestReadyForReview GraphQL
// mutation. Reuses the same throttle queue as REST requests so it doesn't
// bypass the burstiness protection above.
export async function githubGraphQL(query, variables = {}) {
  assertConfigured();

  const doGraphQL = async () => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "madmcp-server",
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { res, data };
  };

  const { res, data } = await scheduleThrottled(doGraphQL);

  if (!res.ok || (data && data.errors)) {
    const message = data && data.errors
      ? data.errors.map((e) => e.message).join("; ")
      : res.statusText;
    throw new Error(`GitHub GraphQL error: ${message}`);
  }

  return data.data;
}

// --- Binary tarball fetch (fix #4, 2026-07-28) -----------------------------
// search.js's private-repo search_code fallback used to fetch one blob per
// file through githubRequest -- up to 500 sequential, individually-throttled
// requests for a single search. This replaces that with ONE request for the
// whole repo via GitHub's tarball endpoint, which search.js decompresses and
// greps locally instead.
//
// Deliberately uses node:https instead of the global fetch() used elsewhere
// in this file: the tarball endpoint responds with a 302 to codeload.
// github.com carrying the actual archive, and fetch()'s redirect: "manual"
// mode returns a spec-mandated "opaqueredirect" filtered response (status 0,
// empty headers, null body) -- there is no way to read the Location header
// off it to follow the redirect ourselves. http.request has no such
// filtering, so we can read the real status/headers and re-issue the
// request to codeload.github.com directly.
//
// The Authorization header is re-attached on the codeload hop on purpose --
// private-repo tarball downloads require it there too (public repos ignore
// it harmlessly). NOTE: this hasn't been exercised against a live private
// repo from this environment (github.com/codeload.github.com aren't in this
// sandbox's egress allowlist) -- worth a real smoke test against a private
// repo before relying on it, in case codeload's auth handling has changed.
function httpGetBuffer(url, headers, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers }, (res) => {
      const status = res.statusCode;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // discard the (empty) redirect body
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        resolve(httpGetBuffer(nextUrl, headers, redirectsLeft - 1));
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`GitHub tarball fetch error (${status}) for ${url}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// Fetches a repo's full contents as a gzipped tarball (raw bytes -- caller
// gunzips/parses). Shares the same throttleChain as githubRequest so it's
// paced consistently with every other GitHub call this server makes, but
// only occupies ONE slot for the whole repo instead of one per file.
export async function githubFetchTarball(owner, repo, ref) {
  assertConfigured();
  return scheduleThrottled(() =>
    httpGetBuffer(`${GITHUB_API}/repos/${owner}/${repo}/tarball/${ref}`, {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "madmcp-server",
    })
  );
}

export function toBase64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

export function fromBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf-8");
}
