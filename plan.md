# madmcp — Optimization & Upgrade Plan

_Generated from a codebase review on 2026-09-25._

## Priority order
1. Fix phantom dependency versions (blocks installs/CI)
2. Consolidate dual server-instance pattern in `server.js`
3. Add rate limiting to background worker endpoints
4. Remove path-based secret exposure (`/mcp/:key`)
5. Review hardcoded Notion ID fallbacks and IP allowlist defaults

## 1. Dependency versions (package.json)
- [ ] `@babel/parser: ^8.0.6` — Babel 8 isn't a released stable major (currently 7.x). Pin to a real 7.x version.
- [ ] `eslint: ^10.11.0` / `@eslint/js: ^10.0.1` — ESLint is on the 9.x cycle; v10 doesn't exist yet. Will break `npm install`/`npm run lint`.
- [ ] `zod: ^4.6.5` — Zod v4 hasn't shipped (currently 3.x).
- [ ] `pg: ^8.12.0` / `pgvector: ^0.2.0` — check for newer stable releases relative to rest of stack.

## 2. Architecture / code quality (server.js)
- [ ] **Dual server instantiation**: `createMcpServer()` builds a fresh `McpServer` per `/mcp` request (~lines 35–64), while a module-level singleton is also created at ~line 67 for tests/single-connect use. Duplicated logic — consolidate into one path.
- [ ] **Global rawBody capture**: `express.json({ verify: ... })` at ~line 119 attaches `req.rawBody` to every request, though it's only needed for QStash signature verification on the worker endpoints. Scope this middleware to just those routes.
- [ ] **Missing rate limiting on background workers**: `/api/agent-worker`, `/api/agent-worker-failure`, `/api/editor-worker`, `/api/editor-worker-failure` skip both `mcpLimiter` and `requireAllowedIp`, relying solely on QStash signature auth. Add a rate-limit backstop in case the signing secret is ever compromised.

## 3. Security hardening
- [ ] **Hardcoded Notion ID fallbacks** in `config.js` (`NOTION_INDEX_DATABASE_ID`, `NOTION_SYNC_PARENT_PAGE_ID`, `GEMINI_NOTION_ROOT_PAGE_ID`) — if these resources are deleted/unshared, failures are silent/confusing. Add explicit provisioning checks/errors.
- [ ] **IP allowlist defaults**: `IP_ALLOWLIST_ENABLED` defaults to `true` with hardcoded CIDR ranges. Verify `trust proxy` is configured correctly for the deployment target (Render/Vercel/Railway) or legitimate traffic may get 403'd.
- [ ] **Path-based secret exposure**: `/mcp/:key` leaks the shared secret into access logs, reverse-proxy logs, and browser history. Deprecate in favor of header-based `x-manufact-key` auth only.

## Next steps
- Confirm intended dependency versions with the team, then patch `package.json` and re-lock.
- Open a PR consolidating the `server.js` request path.
- Add rate limiting to worker endpoints.
- Decide on deprecation timeline for path-based auth.
