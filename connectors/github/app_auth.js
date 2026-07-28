// ---------------------------------------------------------------------------
// connectors/github/app_auth.js — GitHub App auth for scoped, short-lived
// PRIVATE-repo clone tokens (2026-07-28 plan, see Notion entity_id
// madmcp-github-app-scoped-clone-token-plan).
//
// WHY THIS EXISTS: the old download_repo tool returned full file contents
// as a JSON payload straight into the calling model's context — expensive,
// and overkill for a repo the model just needs to run/test/lint (not read).
// It has since been removed (2026-07-28) now that this module covers its
// run/test/lint use case via a real `git clone` into the model's own
// sandbox. Public repos already support that today (github.com/
// codeload.github.com/raw.githubusercontent.com are on the sandbox's own
// network allowlist, no token needed). Private repos can't, since a clone
// needs credentials and the sandbox has none. This module supplies those
// credentials in the narrowest, shortest-lived form practical:
//   - a GitHub App (NOT the broad, long-lived GITHUB_TOKEN used everywhere
//     else in this connector), scoped to contents:read only
//   - installed only on the specific repo(s) that need this
//   - minted as a per-repo installation token, ~1hr TTL (GitHub's own max)
//   - revoked server-side a short grace period after minting (see below) --
//     the actual single-use guarantee, independent of GitHub's own TTL
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
// which runs `git clone` with it in its own sandbox.
//
// ONE-TIME-USE (2026-07-28 update): the token used to be cached server-side
// (Redis) and reused across repeat calls for the same repo within its ~1hr
// GitHub-issued TTL. That's cheap on mint calls but means a token that
// leaked/lingered anywhere (logs, shell history, a second unintended clone)
// stayed valid for up to an hour. Caching has been REMOVED: every call now
// mints a genuinely fresh token, and getCloneToken() schedules a server-side
// revoke via GitHub's `DELETE /installation/token` endpoint
// GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS after minting -- comfortably long
// enough for a `git clone` to finish, short enough that the token is dead
// well before GitHub's own ~1hr TTL would otherwise expire it. This is
// enforced server-side (GitHub kills the token outright), not merely
// "please don't reuse this" guidance to the calling model. The tradeoff:
// repeat clones of the same repo now always cost a fresh mint call (cheap;
// contents:read, single repo) instead of reusing a cached one.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { GITHUB_API } from "../../config.js";
import {
  GITHUB_APP_ID,
  GITHUB_APP_INSTALLATION_ID,
  GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS,
} from "../../config.js";

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
// installation token is minted/revoked).
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
// only. Always hits GitHub's API -- there is no cache to check anymore (see
// ONE-TIME-USE note above), so every call to getCloneToken() below results
// in exactly one of these.
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

// Revokes an installation token early via GitHub's own revoke endpoint,
// authenticated with the token itself (no App JWT needed for this call).
// Best-effort: a failure here just means the token lives out its remaining
// ~1hr GitHub-issued TTL instead of dying early -- never thrown, never
// surfaced to the tool caller, since this always runs on a timer well after
// the tool response has already been returned.
async function revokeInstallationToken(token) {
  try {
    const res = await fetch(`${GITHUB_API}/installation/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    // 401/404 here just means it's already invalid (expired naturally, or
    // revoked some other way) -- not worth logging as an error.
    if (!res.ok && res.status !== 401 && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      console.error(`[app_auth] Failed to revoke clone token (${res.status}): ${detail || "(no response body)"}`);
    }
  } catch (err) {
    console.error(`[app_auth] Error revoking clone token: ${err.message}`);
  }
}

// Returns { token, expiresAt } for cloning owner/repo -- always a freshly
// minted token (see ONE-TIME-USE note above; no server-side cache/reuse).
// Schedules that token's revocation GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS
// from now, so it stops working shortly after being handed off regardless
// of GitHub's own ~1hr TTL. The timer is unref()'d so it never keeps the
// process alive on its own.
export async function getCloneToken(owner, repo) {
  const minted = await mintInstallationToken(owner, repo);

  const revokeTimer = setTimeout(() => {
    revokeInstallationToken(minted.token);
  }, GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS * 1000);
  revokeTimer.unref();

  return { token: minted.token, expiresAt: minted.expiresAt };
}
