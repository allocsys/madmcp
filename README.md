# manufact-mcp-server

An MCP server giving Claude (or any MCP client) tool access to GitHub,
Cloudflare, Notion, Mem0, and arbitrary web pages — so agent workflows can
read/write real infrastructure and content directly, without manual copy/paste.

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
