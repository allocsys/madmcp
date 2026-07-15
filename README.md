# manufact-mcp-server

An MCP server giving Claude (or any MCP client) tool access to GitHub,
Cloudflare, Notion, Mem0, and arbitrary web pages — so agent workflows can
read/write real infrastructure and content directly, without manual copy/paste.

## Live demo

[**View the live protocol trace →**](https://dumbCodesOnly.github.io/madmcp/demo.html)

An illustrative six-step walkthrough of a mock incident response — finding a
slow endpoint, checking latency metrics, shipping and reviewing a fix, and
logging it to memory — touching all five connectors in one flow (including a
deeper look at Mem0's semantic dedup and relation-graph tools). Sample data
throughout, not a live call. (If GitHub Pages isn't enabled for this repo
yet, open `demo.html` directly.)

## Deploy & connect (quickstart)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dumbCodesOnly/madmcp)

Get tokens, deploy, connect to Claude — in that order.

**1. Deploy it.** Click the button above — Render reads `render.yaml`,
generates `MCP_SHARED_KEY` for you automatically, and prompts you for
whichever connector tokens you have (leave the rest blank, see step 2). No
CLI, no Dockerfile, nothing to configure by hand. Note: Render's free plan
spins down after 15 minutes idle, so the first request after a quiet period
will be slow (~30s cold start) — fine for testing, upgrade to a paid plan if
you want Claude's calls to stay fast.

Prefer another host, or running it yourself? It's a plain Node/Express app —
`npm install && npm start`, listens on `$PORT` (default `8080`) — so any
Node-friendly host (Railway, Fly.io, etc.) or your own server works too,
just without the auto-filled `MCP_SHARED_KEY`.

**2. Collect tokens for the connectors you want.** Each is independent —
skip any you don't need, its tools just fail at call time instead of
blocking the rest.

| Connector | Where to get it |
|---|---|
| GitHub | github.com/settings/tokens → fine-grained PAT, scoped to specific repos |
| Notion | notion.so/my-integrations → create an integration, then share the relevant pages/databases with it |
| Mem0 | app.mem0.ai → API keys |
| Cloudflare | dash.cloudflare.com → My Profile → API Tokens, plus your Account ID from the dashboard sidebar |

**3. Set two security env vars — don't skip these.**
- `MCP_SHARED_KEY` — any long random string. Unset = `/mcp` is open to
  anyone who has your server's URL, tokens and all.
- `IP_ALLOWLIST_ENABLED` — on by default, pre-set to Claude's published
  connector IP range, so leave it alone if you're only ever connecting from
  Claude.ai. Set it to `false` temporarily to test with curl/Postman from
  your own machine first.

**4. Deploy, then verify.** `GET /health` returns `{"status":"ok"}`, no auth
needed. `GET /` (needs your `x-manufact-key` header — this endpoint doesn't
support the path-key variant) reports which connectors are configured, so
you can confirm your tokens landed.

**5. Add it to Claude.** Settings → Connectors → Add custom connector, using:

```
https://<your-host>/mcp/<your MCP_SHARED_KEY>
```

(Path-based, since Claude.ai's connector UI doesn't currently support
header-based auth for MCP servers.)

See **Configuration** below for the full variable reference.

## Connectors & tools

### GitHub
File/repo ops: `read_file`, `read_file_chunked`, `get_file_at_commit`, `list_directory`,
`get_file_tree`, `create_or_update_file`, `push_files`, `str_replace_file`, `rename_file`,
`delete_file`, `diff_files`, `download_repo`

Branches & commits: `list_branches`, `create_branch`, `list_commits`, `get_commit`, `list_contributors`

Issues & PRs: `list_issues`, `create_issue`, `update_issue`, `add_issue_comment`,
`get_pull_requests`, `create_pull_request`, `review_pull_request`, `merge_pull_request`

Releases & tags: `list_releases`, `create_release`, `list_tags`

Repo management: `list_repos`, `get_repo`, `create_repo`, `delete_repo`, `get_repo_topics`

Actions & search: `list_workflow_runs`, `get_workflow_run_logs`, `search_code`

### Cloudflare
D1: `cf_d1_databases_list`, `cf_d1_database_get`, `cf_d1_database_create`, `cf_d1_database_delete`, `cf_d1_database_query`

KV: `cf_kv_namespaces_list`, `cf_kv_namespace_get/create/update/delete`

R2: `cf_r2_buckets_list`, `cf_r2_bucket_get/create/delete`

Hyperdrive: `cf_hyperdrive_configs_list`, `cf_hyperdrive_config_get/edit/delete`

Workers: `cf_workers_list`, `cf_workers_get_worker`, `cf_workers_get_worker_code`

Observability: `cf_workers_observability_query/keys/values/compare`

### Notion
`notion_search`, `notion_get_page`, `notion_create_page`, `notion_update_page`

### Mem0
`mem0_add`, `mem0_add_batch`, `mem0_get`, `mem0_get_history`, `mem0_list`, `mem0_search`,
`mem0_update`, `mem0_delete`, `mem0_delete_batch`, `mem0_delete_all`

### Fetch
`web_fetch` — fetch a public URL and return text/JSON/stripped HTML

## Configuration

All tokens are optional independently — a connector's tools fail at call time
(not startup) if its token is missing.

| Variable | Required for |
|---|---|
| `GITHUB_TOKEN` | GitHub tools |
| `NOTION_TOKEN` | Notion tools |
| `MEM0_API_KEY` | Mem0 tools (`MEM0_USER_ID` optional, defaults to `default`) |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Cloudflare tools |
| `DEFAULT_OWNER` | Default GitHub owner when omitted from a call (defaults to `dumbCodesOnly`) |
| `MCP_SHARED_KEY` | Shared-secret auth for `/mcp`. Unset = endpoint is open to anyone with the URL — set this in any real deployment. |
| `IP_ALLOWLIST_ENABLED` | Set `false` to disable the IP allowlist (default: enabled) |
| `ALLOWED_IP_RANGES` | Comma-separated CIDR ranges allowed to call `/mcp` (defaults to Anthropic's published connector range) |

## Security notes

- Requests to `/mcp` are restricted by IP allowlist and rate-limited (30 requests/min).
- Scope `GITHUB_TOKEN` as narrowly as possible (ideally fine-grained, limited
  to specific repos). This server can create/delete repos and files, merge
  PRs, and delete Cloudflare resources — treat every configured token as
  live write access.
- `GET /` reports which connectors are configured; `GET /health` stays open
  and info-free for uptime checks.
- Rotate any token if you ever suspect it's been exposed.

## Running locally

```bash
export GITHUB_TOKEN=ghp_yourtokenhere
npm install
npm start
```

Server listens on `PORT` (default `8080`). MCP endpoint: `POST /mcp`.
Health check: `GET /health`.
