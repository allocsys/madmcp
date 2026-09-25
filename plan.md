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

- [ ] Spike: confirm exactly which OAuth flow Claude.ai's connector dashboard expects (auth code + PKCE vs. something else) — check the dashboard's setup instructions for the specific redirect URI / discovery requirements it validates against.
- [ ] Add `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token` routes.
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
