# madmcp — Optimization & Upgrade Plan

_Generated 2026-09-25, revised same day after verification against npm and the actual source files._

## ⚠️ Revision note
An initial automated review (via delegate_agent/Gemini) flagged several issues that turned out to be **false positives** once checked against real data — its knowledge of current package versions was stale. Verified findings below.

## Verified findings

### 1. Notion ID fallback drift risk (config.js)
`NOTION_INDEX_DATABASE_ID`, `NOTION_SYNC_PARENT_PAGE_ID`, and `GEMINI_NOTION_ROOT_PAGE_ID` hardcode fallback UUIDs. This is a real, demonstrated risk — `NOTION_SYNC_PARENT_PAGE_ID`'s default page already went 404 once in production (deleted/unshared 2026-08-01) and had to be manually patched.
- [ ] Add monitoring/alerting for Notion 404s tied to these IDs so drift is caught automatically instead of by manual discovery.

### 2. Path-based shared key (`/mcp/:key`) leaks into logs
Necessary today because Claude.ai's custom connector UI doesn't yet support header-based auth for MCP servers, so it can't simply be removed. Still leaks the shared key into access/reverse-proxy logs and browser history.
- [ ] Track Claude.ai's connector auth support and drop the path-based route once header auth is available.
- [ ] In the meantime, consider treating the key as rotatable/short-lived to limit blast radius from log exposure.

## Findings from the initial pass that were REJECTED on verification
- ~~`@babel/parser ^8.0.6`, `eslint ^10.11.0`, `zod ^4.6.5` are unreleased/nonexistent versions~~ — **false**. All three are real, current stable releases as of Sept 2026 (Babel 8.0.0: June 2026; ESLint 10.0.0: Feb 2026, v9 EOL Aug 2026; Zod 4.0.0: July 2025). No dependency action needed.
- ~~Dual `createMcpServer()` instantiation is confusing duplication~~ — **intentional, documented**: per-request instances avoid a Vercel warm-container reconnect crash; the module-level singleton exists only for tests.
- ~~Global `req.rawBody` capture adds meaningful overhead~~ — **already justified in-code** as a cheap buffer reference needed for QStash signature verification.
- ~~Missing rate limiting on `/api/agent-worker` etc. is a gap~~ — **deliberate**: these rely on QStash's own signature verification (fails closed), and a limiter sized for MCP bursts would break legitimate long step-chains.
- ~~IP allowlist / proxy header risk~~ — **already handled**: `TRUST_PROXY_HOPS` is configurable and documented.

## Next steps
- Decide on a monitoring approach for the Notion fallback IDs (e.g. alert on repeated 404s from Notion connector calls).
- No dependency PRs needed — package.json is fine as-is.
