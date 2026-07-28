// ---------------------------------------------------------------------------
// connectors/github/app_auth.js — GitHub App auth for scoped, short-lived
// PRIVATE-repo clone tokens (2026-07-28 plan, see Notion entity_id
// madmcp-github-app-scoped-clone-token-plan).
//
// WHY THIS EXISTS: download_repo (./download.js) returns full file contents
// as a JSON payload straight into the calling model's context — expensive
// and, for a repo the model just needs to run/test/lint (not read), overkill
// compared to a real `git clone` into the model's own sandbox. Public repos
// already support that today (github.com/codeload.github.com/
// raw.githubusercontent.com are on the sandbox's own network allowlist, no
// token needed). Private repos can't, since a clone needs credentials and
// the sandbox has none. This module supplies those credentials in the
// narrowest, shortest-lived form practical:
//   - a GitHub App (NOT the broad, long-lived GITHUB_TOKEN used everywhere
//     else in this connector), scoped to contents:read only
//   - installed only on the specific repo(s) that need this
//   - minted as a per-repo installation token, ~1hr TTL (GitHub's own max)
//
// WHY THE TOKEN PASSES THROUGH THE CALLING MODEL AT ALL (2026-07-28 decision):
// the original plan assumed the calling model's bash sandbox could reach a
// mint endpoint on THIS server directly, the same way it already reaches
// github.com. That's false — the sandbox's network allowlist is a fixed,
// separate Anthropic-side environment setting that does not include this
// server's domain, and nothing in this codebase can add to it. So "mint
// server-side, clone server-side, token never touches the calling model" —
// the original goal — isn't achievable without either (a) an allowlist
// change outside this repo, or (b) doing the clone/run entirely on THIS
// server instead of the model's sandbox (considered, rejected for this pass
// since the actual want was local sandbox file access, not command-output-
// only). So: the token is minted here and returned to the calling model,
// which runs `git clone` with it in its own sandbox. Still narrow — single
// repo, read-only, ~1hr TTL, never written to a file/env var, cache-backed
// so repeat clones of the same repo don't mint a fresh one every time — just
// not zero-exposure the way the original design intended.
//
// CACHING: mint calls hit GitHub's API and cost a real round-trip, and a
// fresh session/agent asking to clone the same repo minutes after another
// session already did so has no reason to mint again. getCloneToken() checks
// a Redis-backed cache (same Redis as connectors/gemini/cooldown.js — see
// getRedis() there) keyed per owner/repo before minting, and reuses a cached
// token as long as GITHUB_APP_TOKEN_CACHE_BUFFER_SECONDS of validity remain.
// This is SERVER-SIDE reuse only — it has nothing to do with, and doesn't
// change, the fact that each individual clone still needs the token handed
// to the calling model to run the clone itself. Fails open to "always mint
// fresh" if Redis isn't configured/reachable, same convention as
// cooldown.js.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { GITHUB_API } from "../../config.js";
import {
  GITHUB_APP_ID,
  GITHUB_APP_INSTALLATION_ID,
  GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_TOKEN_CACHE_BUFFER_SECONDS,
} from "../../config.js";
import { getRedis } from "../gemini/cooldown.js";

const TOKEN_CACHE_KEY_PREFIX = "github-app:clone-token:";

// GitHub rejects App JWTs older than 10 minutes; keep comfortably under that
// to absorb clock skew between this server and GitHub's.
const JWT_TTL_SECONDS = 540;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signRs256(signingInput, privateKeyPem) {
  return crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKeyPem, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Builds a GitHub App JWT (iss = App ID), used only to authenticate the
// single "mint an installation token" call below -- never returned to a
// caller, never cached (cheap to build fresh each time; only the resulting
// installation token is cached).
function buildAppJwt() {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error(
      "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not configured -- private-repo clone tokens are unavailable. " +
      "See connectors/github/app_auth.js and config.js for setup."
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s -- standard GitHub App auth guidance, absorbs clock
  // skew where GitHub's clock is slightly ahead of this server's.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + JWT_TTL_SECONDS, iss: GITHUB_APP_ID }));
  const signingInput = `${header}.${payload}`;
  // Support both a literal PEM (real newlines) and an escaped one (\n) --
  // some env var tooling can't store literal newlines, so accept either.
  const privateKey = GITHUB_APP_PRIVATE_KEY.includes("\\n")
    ? GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n")
    : GITHUB_APP_PRIVATE_KEY;
  return `${signingInput}.${signRs256(signingInput, privateKey)}`;
}

// Mints a FRESH installation token scoped to exactly one repo, contents:read
// only. Always hits GitHub's API -- callers wanting cache-aware reuse should
// call getCloneToken() below instead of this directly.
async function mintInstallationToken(owner, repo) {
  if (!GITHUB_APP_INSTALLATION_ID) {
    throw new Error(
      "GITHUB_APP_INSTALLATION_ID not configured -- private-repo clone tokens are unavailable. " +
      "See connectors/github/app_auth.js and config.js for setup."
    );
  }
  const jwt = buildAppJwt();
  const res = await fetch(`${GITHUB_API}/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repositories: [repo],
      permissions: { contents: "read" },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to mint installation token for ${owner}/${repo} (${res.status}): ${detail || "(no response body)"}. ` +
      `Common causes: the App isn't installed on this repo, or the installation ID is wrong.`
    );
  }
  const data = await res.json();
  return { token: data.token, expiresAt: data.expires_at }; // expires_at: ISO 8601 string
}

function cacheKey(owner, repo) {
  return `${TOKEN_CACHE_KEY_PREFIX}${owner}/${repo}`;
}

// Returns { token, expiresAt, cached } for cloning owner/repo -- reuses a
// still-valid, server-side-cached token (with at least
// GITHUB_APP_TOKEN_CACHE_BUFFER_SECONDS remaining) when one exists, mints a
// fresh one otherwise. `cached` tells the caller which happened, purely for
// an informative response message -- behavior is identical either way from
// the caller's perspective.
export async function getCloneToken(owner, repo) {
  const key = cacheKey(owner, repo);
  const redis = getRedis();

  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const remainingMs = new Date(parsed.expiresAt).getTime() - Date.now();
        if (remainingMs > GITHUB_APP_TOKEN_CACHE_BUFFER_SECONDS * 1000) {
          return { token: parsed.token, expiresAt: parsed.expiresAt, cached: true };
        }
      }
    } catch {
      // Best-effort cache read -- fall through to minting fresh, same
      // fail-open convention as cooldown.js.
    }
  }

  const minted = await mintInstallationToken(owner, repo);

  if (redis) {
    try {
      const ttlSeconds = Math.max(
        60,
        Math.floor((new Date(minted.expiresAt).getTime() - Date.now()) / 1000) - GITHUB_APP_TOKEN_CACHE_BUFFER_SECONDS
      );
      await redis.set(key, JSON.stringify(minted), { ex: ttlSeconds });
    } catch {
      // Best-effort cache write -- the freshly minted token is still
      // returned below even if caching it fails.
    }
  }

  return { ...minted, cached: false };
}
