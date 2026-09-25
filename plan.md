# madmcp — Optimization & Upgrade Plan

_Generated 2026-09-25, revised same day after verification against npm and the actual source files._

## ⚠️ Revision note
An initial automated review (via delegate_agent/Gemini) flagged several issues that turned out to be **false positives** once checked against real data — its knowledge of current package versions was stale. Verified findings below.

## Verified findings

### 1. Notion ID fallback drift risk (config.js) — ✅ FIXED (branch `fix/plan-md-findings`)
`NOTION_INDEX_DATABASE_ID`, `NOTION_SYNC_PARENT_PAGE_ID`, and `GEMINI_NOTION_ROOT_PAGE_ID` hardcode fallback UUIDs. This is a real, demonstrated risk — `NOTION_SYNC_PARENT_PAGE_ID`'s default page already went 404 once in production (deleted/unshared 2026-08-01) and had to be manually patched.
- [x] Add monitoring/alerting for Notion 404s tied to these IDs so drift is caught automatically instead of by manual discovery. `connectors/notion/client.js`'s `notionRequest` now calls `maybeAlertOnFallbackId404`, which emits a distinct `ALERT: Notion 404 on hardcoded fallback ID ...` line via `console.error` whenever a 404's request path contains one of the three IDs, before the normal error is thrown. Point a log-based alert (Vercel log drain, Render alert rule, etc.) at the `ALERT:` prefix. Purely observational — does not change what `notionRequest` returns/throws.

### 2. Eager module-level `McpServer` singleton doubles construction cost (server.js) — ✅ FIXED (branch `fix/plan-md-findings`)
`const mcpServer = createMcpServer();` runs unconditionally at module load, building a full `McpServer` with all 13 connectors registered. In production `handleMcp` never uses it — it always builds its own fresh per-request instance (required, since Vercel reuses warm containers across requests and `connect()` throws if called twice on one instance). So every cold start pays for constructing **two** full server instances: the per-request one that's actually used, plus this unused singleton. It exists for `test/mcp-integration.test.js` and anything else importing `{ mcpServer }` directly — not just tests, but its only real consumers are test/single-connect use, not the request path.
- [x] Stop building the singleton eagerly at import time. `server.js` now exports `createMcpServer` itself (no module-level `mcpServer` singleton at all); `test/mcp-integration.test.js`'s `beforeAll` calls `createMcpServer()` directly.
- [x] Verify nothing outside tests imports `{ mcpServer }` before removing/gating it. Confirmed via repo-wide search — `test/mcp-integration.test.js` was the only consumer.

### 3. Path-based shared key (`/mcp/:key`) leaks into logs — OAuth migration planned
Update 2026-09-25: Claude.ai's dashboard now shows OAuth as a supported auth method for custom connectors (the "no header auth" assumption behind `requireMcpKey`'s path-based fallback is outdated). Decision: **do not** build key-rotation tooling — the shared key is being replaced outright, not hardened. Until the OAuth work below ships, rotate `MCP_SHARED_KEY` manually (update the env var in Vercel + the URL saved in the Claude.ai connector settings) if the key is ever suspected to have leaked.

**Plan: replace shared-key auth with OAuth 2.1**

MCP's spec-recommended auth model is OAuth 2.1 with the server acting as its own Authorization Server (or delegating to one). For a single-tenant server like this (one Claude.ai org as the only client), the minimal compliant shape is:

- **Discovery:** serve `/.well-known/oauth-authorization-server` (RFC 8414) so Claude.ai's connector UI can auto-discover endpoints instead of the URL-embedded key.
- **Client registration:** support RFC 7591 Dynamic Client Registration (`POST /register`) — Claude.ai registers itself as a client on first connect rather than us hand-provisioning a client ID.
- **Authorization + token endpoints:** `/authorize` (auth code + PKCE, per OAuth 2.1 — no implicit flow) and `/token` (code exchange + refresh). Given single-tenant scope, this can start as a thin layer: one authorized user (whoever holds the deploy's admin credential) approves the client once, we mint short-lived access tokens + refresh tokens.
- **Token storage:** access/refresh tokens need persistence across warm Vercel containers — reuse the existing Neon Postgres (already wired for `map.query`) rather than adding a new datastore.
- **New auth middleware:** `requireMcpBearerToken` validates `Authorization: Bearer <token>` against stored tokens (expiry + revocation check), replacing `requireMcpKey`'s header/path key check on `/mcp`.
- **Migration path:** run both auth methods side by side behind a flag (`AUTH_MODE=shared_key|oauth`) for one deploy cycle, confirm the Claude.ai connector reconnects cleanly via OAuth, then remove `requireMcpKey`, `MCP_SHARED_KEY`, and the `/mcp/:key` route entirely (closes finding #3's actual leak — no key ever appears in a URL or log line again).
- **Library choice:** evaluate `@modelcontextprotocol/sdk`'s own auth helpers first (the SDK has been adding OAuth server scaffolding) before reaching for a general-purpose OAuth library, to keep the dependency surface aligned with the rest of the server.

- [x] **Spike resolved** (confirmed against Anthropic's connector docs, claude.com/docs/connectors/building/authentication, 2026-09-25):
  - Flow is OAuth 2.1 authorization-code + PKCE (S256 mandatory), as assumed. For a single-tenant custom connector (one org, low/occasional connection volume), **DCR (`oauth_dcr`) is the right registration mechanism** — CIMD/Anthropic-held creds are only preferred over DCR for high-traffic *directory* listings, which doesn't apply here.
  - Discovery must be explicit: unauthenticated requests to `/mcp` must return `401` with `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`. Claude does not honor a `WWW-Authenticate` header on a `200` — this exact handshake is required, not optional fallback probing.
  - `/.well-known/oauth-protected-resource` (RFC 9728): `resource` field must exactly match the MCP server URL as entered in the Claude.ai connector settings; `authorization_servers` lists our issuer URL.
  - `/.well-known/oauth-authorization-server` (RFC 8414) must include a `registration_endpoint` (DCR) and advertise `"code_challenge_methods_supported": ["S256"]`.
  - Redirect URI to accept: `https://claude.ai/api/mcp/auth_callback` only — the `localhost`/`127.0.0.1` loopback variants in the spec are for Claude Code's native client, not the hosted web/mobile surface we're targeting.
  - `POST /register` (DCR) parses `application/json`; `POST /token` must parse `application/x-www-form-urlencoded` — these differ, so the two routes can't share one body-parser assumption.
  - Refresh tokens must rotate on each use (required for DCR's public-client registration) and be returned in the same response that invalidates the old one; token errors must use RFC 6749 codes (`invalid_grant`) for Claude's reactive-refresh-on-401 logic to recognize them.
  - Claude times out discovery/registration/token calls at 10s and refresh calls at 30s — `/token` must not block on slow downstream (Neon) calls.
  - Anthropic's requests originate from `160.79.104.0/21`, relevant only if anything in front of these routes does IP filtering.
- [ ] Add `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token` routes per the confirmed requirements above.

**Open decision: env vars vs. Neon for OAuth state**

Env vars are immutable at runtime — a request handler can read `process.env.X` but can't write a new value back into it, so anything that must be written mid-flow (a used auth code, a rotated refresh token) can't live there. That rules out env as a full replacement for storage, but it does remove two of the three storage needs:
- **Client registration**: single-tenant (only Claude.ai will ever call `/register`), so a fixed pre-generated `client_id`/secret in env works — `/register` just echoes it back. No DCR client table needed.
- **Access tokens**: can be a signed JWT (secret in env) carrying `client_id` + expiry + scope; `/mcp` verifies signature + expiry, no lookup needed.

What still wants a mutable store:
- **Authorization codes** (~60s TTL, single-use): could be a signed stateless token instead, but then nothing prevents the same code being redeemed twice inside that window — acceptable risk for one trusted org, not zero risk.
- **Refresh token rotation**: the docs require rotating (or sender-constraining) refresh tokens for public clients — the old token must actually become invalid when a new one issues. A pure signed token has no way to be invalidated early; this is the one piece that genuinely needs a write-able store.

Two viable paths, not yet decided:
1. Minimal Neon table for refresh tokens only (client registration + access tokens stay in env/JWT); accept single-use replay risk on auth codes, or store those too.
2. Skip persistence entirely, accept the weaker rotation guarantee, and bound exposure with shorter-lived refresh tokens instead.
- [ ] Add token persistence (Neon) + `requireMcpBearerToken` middleware.
- [ ] Dual-run behind `AUTH_MODE` flag, cut over, then delete `requireMcpKey` / `MCP_SHARED_KEY` / `/mcp/:key`.
- [ ] No manual key-rotation tooling — superseded by this migration.

## Findings from the initial pass that were REJECTED on verification
- ~~`@babel/parser ^8.0.6`, `eslint ^10.11.0`, `zod ^4.6.5` are unreleased/nonexistent versions~~ — **false**. All three are real, current stable releases as of Sept 2026 (Babel 8.0.0: June 2026; ESLint 10.0.0: Feb 2026, v9 EOL Aug 2026; Zod 4.0.0: July 2025). No dependency action needed.
- ~~Dual `createMcpServer()` instantiation is confusing duplication~~ — **partially rejected**: per-request instantiation is intentional and required (avoids a Vercel warm-container reconnect crash). But the module-level singleton being built *eagerly, unconditionally* is a real inefficiency — see verified finding #2 above.
- ~~Global `req.rawBody` capture adds meaningful overhead~~ — **already justified in-code** as a cheap buffer reference needed for QStash signature verification.
- ~~Missing rate limiting on `/api/agent-worker` etc. is a gap~~ — **deliberate**: these rely on QStash's own signature verification (fails closed), and a limiter sized for MCP bursts would break legitimate long step-chains.
- ~~IP allowlist / proxy header risk~~ — **already handled**: `TRUST_PROXY_HOPS` is configurable and documented.

## Next steps
- Findings #1 and #2 are fixed on branch `fix/plan-md-findings` (full 705-test suite + lint pass). Merge once reviewed.
- Finding #3: OAuth 2.1 migration is the agreed fix (see plan above) — no key-rotation tooling will be built. Next action is the first unchecked item: spike which OAuth flow Claude.ai's connector dashboard expects (auth code + PKCE vs. other), then implement the `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token` routes and token persistence. Manual `MCP_SHARED_KEY` rotation remains the interim mitigation only until that ships.
- No dependency PRs needed — package.json is fine as-is.
