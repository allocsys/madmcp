// ---------------------------------------------------------------------------
// connectors/github/client.js
// ---------------------------------------------------------------------------

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
      "GITHUB_TOKEN is not set. Add it as an environment variable on the Manufact server."
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
function isRetryable(res, data) {
  if (res.status === 429) return true;
  if (res.status === 403) {
    const msg = (data && (data.message || JSON.stringify(data))) || "";
    if (/secondary rate limit/i.test(msg)) return true;
    if (res.headers.get("x-ratelimit-remaining") === "0") return true;
  }
  return false;
}

function retryDelayMs(res, attempt) {
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
      "User-Agent": "manufact-mcp-server",
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
        "User-Agent": "manufact-mcp-server",
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

export function toBase64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

export function fromBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf-8");
}
