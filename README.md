<div align="center">

# 🔌 madmcp

**An MCP server built around Gemini-powered delegation — hand Claude an open-ended, multi-step investigation instead of chaining 5-10 manual tool calls — plus direct tool access to GitHub, Cloudflare, Notion, Mem0, Context7, Jules, and the web. Reflexive by construction: a connected agent has write access to this very repo, so it can read its own source, diagnose a gap, and patch it through the same connection.**

[![CI](https://github.com/allocsys/madmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/allocsys/madmcp/actions/workflows/ci.yml)
[![Protocol](https://img.shields.io/badge/protocol-MCP-E8A33D?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-6FBF8B?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Connectors](https://img.shields.io/badge/connectors-GitHub%20%C2%B7%20Cloudflare%20%C2%B7%20Notion%20%C2%B7%20Mem0%20%C2%B7%20Context7%20%C2%B7%20Gemini%20%C2%B7%20Jules%20%C2%B7%20Fetch-7CA6D6?style=flat-square)](#connectors--tools)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

<a href="https://allocsys.github.io/madmcp/demo.html">
  <img src="https://readme-typing-svg.demolab.com?font=IBM+Plex+Mono&size=15&duration=2600&pause=900&color=E8A33D&center=true&vCenter=true&width=580&lines=%E2%86%92+tool_call+search_code(%7B+query%3A+%22legacyPricingService%22+%7D);%E2%9C%93+200+%C2%B7+118ms+%C2%B7+1+match%2C+no+timeout+set;%E2%86%92+tool_call+create_pull_request(%7B+title%3A+%22Add+timeout+guard%22+%7D);%E2%9C%93+PR+%23482+opened+against+main;%E2%86%92+tool_call+mem0_add(%7B+entity_id%3A+%22edge-router-incident%22+%7D)" alt="typing animation of a madmcp tool-call trace" />
</a>

**[▶ Watch the live protocol trace](https://allocsys.github.io/madmcp/demo.html)**

</div>

---

## What this is

`madmcp`'s core idea is **delegation**: instead of an agent making 5-10
manual tool calls to run an investigation itself, it can hand an open-ended,
read-only investigation (or a single page + question) to Gemini, which runs
its own tool-use loop server-side and returns one synthesized answer. This
is split across two tools along a security boundary: `delegate_agent`
covers GitHub, Cloudflare, and Notion (no web access), while
`delegate_research` covers the live web (a precision single-page mode, or
a single-shot wide research mode via Exa's `/answer` endpoint) with no
access to those internal systems. Both are described first under Connectors & tools below.

On top of that, the server also gives an AI agent direct tool-level access
to real infrastructure — GitHub, Cloudflare, Notion, Mem0, Context7, and
arbitrary web pages — so agent workflows can read and write directly instead
of relying on manual copy/paste between tabs.

### Agent-driven self-modification

`DEFAULT_OWNER` defaults to `your forked repo`, and the GitHub connector exposes
full read/write/PR tooling (`read_file`, `edit_file`,
`create_pull_request`, `merge_pull_request`, etc.) — not a read-only subset.
That combination means an agent connected to this server has direct write
access to this very repo: it can read its own source, diagnose a bug or a
gap in the docs, and commit the fix — or open a PR against itself — through
the same connection it's already using, with no separate deploy step or
out-of-band access required. This isn't a hypothetical: this README, and the
portfolio page describing this project, have both been edited exactly this
way. Worth being precise about what this is *not*: the server doesn't
modify itself unprompted on some schedule — every change still starts with
an agent invoked by a person. What's notable is that there's no separate
admin path or special-cased self-access; a connected agent uses the exact
same `edit_file`/`create_pull_request` tools on this repo as on any
other repo it has a token for.

## Live demo

An illustrative six-step walkthrough of a mock incident response — finding a
slow endpoint, checking latency metrics, shipping and reviewing a fix, and
logging it to memory — touching all five connectors in one flow (including a
deeper look at Mem0's semantic dedup and relation-graph tools), with a synced
status panel and live call/latency stats alongside the trace. Sample data
throughout, not a live call. (If GitHub Pages isn't enabled for this repo
yet, open `demo.html` directly.)

## Deploy & connect (quickstart)

[![Deploy to Render](https://img.shields.io/badge/Deploy%20to-Render-46E3B7?style=flat-square&logo=render&logoColor=white)](https://render.com/deploy?repo=https://github.com/allocsys/madmcp)
[![Deploy with Vercel](https://img.shields.io/badge/Deploy%20with-Vercel-000000?style=flat-square&logo=vercel&logoColor=white)](https://vercel.com/new/clone?repository-url=https://github.com/allocsys/madmcp&env=MCP_SHARED_KEY,GITHUB_TOKEN,NOTION_TOKEN,MEM0_API_KEY,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID&envDescription=Generate+a+long+random+string+yourself+for+MCP_SHARED_KEY+(Vercel+can%27t+auto-generate+it).+Leave+any+connector+token+blank+to+skip+it.&envLink=https://github.com/allocsys/madmcp%23configuration&project-name=madmcp-server&repository-name=madmcp-server)

Need connector tokens first? **[→ Get API keys](./docs/API_KEYS.md)** — one-click links to each provider's key-creation page, or use the env bundler below to collect them all and copy out a single `.env` block:

[![Env Bundler](https://img.shields.io/badge/Env-Bundler-ECD53F?style=flat-square&logo=dotenv&logoColor=333333)](https://allocsys.github.io/madmcp/env.html)
[![GitHub Token](https://img.shields.io/badge/GitHub-Token-181717?style=flat-square&logo=github)](https://github.com/settings/tokens/new)
[![Cloudflare Token](https://img.shields.io/badge/Cloudflare-Token-F38020?style=flat-square&logo=cloudflare)](https://dash.cloudflare.com/profile/api-tokens)
[![Notion Integration](https://img.shields.io/badge/Notion-Integration-000000?style=flat-square&logo=notion)](https://www.notion.so/my-integrations)
[![Mem0 Key](https://img.shields.io/badge/Mem0-API_Key-6E56CF?style=flat-square)](https://app.mem0.ai/dashboard/api-keys)
[![Gemini Key](https://img.shields.io/badge/Gemini-API_Key-4285F4?style=flat-square&logo=googlegemini)](https://aistudio.google.com/apikey)
[![Jules Key](https://img.shields.io/badge/Jules-API_Key-4285F4?style=flat-square&logo=googlegemini)](https://jules.google.com/settings#api)
[![Exa Key](https://img.shields.io/badge/Exa-API_Key-000000?style=flat-square)](https://dashboard.exa.ai/api-keys)
[![OpenRouter Key](https://img.shields.io/badge/OpenRouter-API_Key-6467F2?style=flat-square)](https://openrouter.ai/keys)
[![Groq Key](https://img.shields.io/badge/Groq-API_Key-F55036?style=flat-square)](https://console.groq.com/keys)
[![Upstash Redis](https://img.shields.io/badge/Upstash-Redis-00E9A3?style=flat-square)](https://console.upstash.com/redis)
[![Generate Secret](https://img.shields.io/badge/Generate-MCP__SHARED__KEY-333333?style=flat-square)](https://generate-secret.vercel.app/32)

Get tokens, deploy, connect to Claude — in that order.

**1. Deploy it — pick a host.** Both buttons above deploy this repo as-is,
no Dockerfile or CLI needed, but they're not identical:

- **Render** reads `render.yaml` and generates `MCP_SHARED_KEY` for you
  automatically — one less thing to get wrong. Trade-off: the free plan
  spins down after 15 minutes idle, so the first request after a quiet
  period is slow (~30s cold start). Fine for testing; upgrade to a paid plan
  if you want Claude's calls to stay consistently fast.
- **Vercel** deploys with zero config (this repo's `server.js` already
  matches what Vercel expects) and its Fluid compute avoids Render's
  cold-start spin-down. Trade-off: you have to generate `MCP_SHARED_KEY`
  yourself — any long random string, e.g. via a password generator or
  `openssl rand -hex 32` — and paste it into the form; Vercel's button
  can't auto-fill it the way Render's blueprint does.

- **[Manufact Cloud](https://manufact.com/cloud)** is purpose-built for hosting
  MCP servers (this one included — the default IP allowlist already carries a
  comment about Manufact's own deploy-time health check). It doesn't have a
  one-click button with a public URL scheme the way Render/Vercel do; instead
  sign in, **New Server → Import from GitHub →** pick this repo, add your env
  vars on the **Configure Deployment** screen (or paste a `.env`), then
  **Deploy**. Node.js is auto-detected from `package.json`, no Dockerfile
  needed. Free tier scales to zero like Render's free tier (cold starts);
  paid plans offer "Prevent Scale to Zero." Manufact's gateway URL pattern is
  `https://<slug>.run.mcp-use.com/mcp` — the `/mcp/<key>` path-auth variant
  this repo uses does survive that gateway routing (confirmed: it's the exact
  pattern in use), so the same `https://<slug>.run.mcp-use.com/mcp/<your
  MCP_SHARED_KEY>` URL from step 5 below works here too.

Prefer another host, or running it yourself? It's a plain Node/Express app —
`npm install && npm start`, listens on `$PORT` (default `8080`) — so any
Node-friendly host (Railway, Fly.io, etc.) or your own server works too,
just without any platform's auto-fill.

*A note on IP allowlisting across hosts:* the allowlist trusts one
reverse-proxy hop by default (`TRUST_PROXY_HOPS`, default `1`), which
matches Render and most single-CDN-hop platforms. If Claude's calls get
unexpectedly 403'd on a different platform, that hop count is the first
thing to check — adjust `TRUST_PROXY_HOPS`, or temporarily set
`IP_ALLOWLIST_ENABLED=false` to confirm that's the cause before tightening
it back up.

**2. Collect tokens for the connectors you want.** Each is independent —
skip any you don't need, its tools just fail at call time instead of
blocking the rest.

| Connector | Where to get it |
|---|---|
| GitHub | github.com/settings/tokens → fine-grained PAT, scoped to specific repos |
| Notion | notion.so/my-integrations → create an integration, then share the relevant pages/databases with it |
| Mem0 | app.mem0.ai → API keys |
| Cloudflare | dash.cloudflare.com → My Profile → API Tokens, plus your Account ID from the dashboard sidebar |
| Jules | jules.google.com/settings#api → API key (max 3 per account, no unauthenticated tier) |

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

### ⭐ Gemini (delegation) — the flagship feature
The two delegation tools split along a security boundary: `delegate_agent`
has no web access, `delegate_research` has no access to GitHub/Notion/
Cloudflare. This means a malicious page or search result encountered
mid-research can influence at most that run's own answer — it has no
internal-system data to exfiltrate, because that loop never has access to
any in the first place.

`delegate_agent` — hand an open-ended, multi-step, read-only investigation
(e.g. "why is CI failing on PR #42", "summarize what changed in this repo over
the last week") to Gemini (default), GLM, or Groq instead of making 5-10
separate manual tool calls. The model runs its own loop server-side across
GitHub, Cloudflare, and Notion (bounded by `max_steps`, default 6, hard cap
20) and returns one synthesized answer. Falls through an ordered model
cascade (`GEMINI_MODEL` → `GEMINI_FALLBACK_MODELS`, `GLM_MODEL` →
`GLM_FALLBACK_MODELS` across every key in `OPENROUTER_API_KEYS`, or
`GROQ_MODEL` → `GROQ_FALLBACK_MODELS` across every key in `GROQ_API_KEYS`)
on rate limits, with Redis-backed per-model cooldown so already-limited
models are skipped rather than retried. An explicit
`provider: "gemini" | "glm" | "groq"` arg picks which one backs a given
call (default: `DEFAULT_LLM_PROVIDER`, itself defaulting to `"gemini"`) —
all three are interchangeable in capability, not just cost/speed; try
`"glm"` or `"groq"` if Gemini's output has been unreliable for a given
task. GLM (via OpenRouter) is currently non-functional on a zero-credit
account — see `docs/API_KEYS.md` — so Groq is the practical free-tier
alternative to Gemini for now (request/token-rate-limited rather than
credit-balance-gated, no card required). Ignored on a resume (the provider
that started the run is always reused, so a checkpointed conversation
can't be corrupted by resuming it on a different provider's wire format).

`delegate_research` — web research, in one of two mutually-exclusive modes
selected by which args are passed:
- **Precision mode** (`url` + `question`): fetch a single URL and get back
  Gemini's answer to a specific question about its content, without
  returning the raw page. Use this instead of `web_fetch` when you need a
  distilled answer rather than exact wording to copy.
- **Wide mode** (`task`): a single-shot call to Exa's `/answer` endpoint,
  which does its own web search + synthesis server-side and returns one
  answer with sources. No multi-step loop, no effect from `max_steps`, and
  nothing to resume via `resume_run_id` (that Gemini-loop architecture was
  retired 2026-07-27).

Progress on `delegate_agent` runs is checkpointed to Redis after every
completed step. If the underlying Gemini API call fails partway through
(429/503/network blip), the response includes a `resume_run_id` and
everything gathered so far instead of losing the run outright — pass that
id back on a follow-up call to continue from the last completed step
(checkpoint TTL: 1 hour) rather than re-running, and re-paying for, steps
already done. Wide-mode `delegate_research` is a single Exa call with no
steps to checkpoint — a failure just returns an error, and `resume_run_id`
is accepted only for parameter compatibility with `delegate_agent`.

Both tools can optionally log their task/question, step-by-step tool calls,
and final answer to a Notion page under a fixed Gemini root page
(`log_to_notion`, default `false`).

### GitHub
File/repo ops: `read_file` (accepts optional `char_offset`/`char_limit` to page through large files), `get_file_at_commit`, `list_directory`,
`get_file_tree`, `create_repo_file`, `edit_file`, `overwrite_files`, `rename_file`,
`delete_file`, `diff_files`

Branches & commits: `list_branches`, `create_branch`, `list_commits`, `get_commit`, `list_contributors`

Issues & PRs: `list_issues`, `get_issue`, `create_issue`, `update_issue`, `add_issue_comment`,
`get_pull_requests`, `create_pull_request`, `update_pull_request`, `get_pr_activity`,
`review_pull_request`, `merge_pull_request`

Releases & tags: `list_releases`, `create_release`, `list_tags`

Repo management: `list_repos`, `get_repo`, `create_repo`, `delete_repo`, `get_repo_topics`, `fork_repo`, `sync_fork`

Actions & search: `list_workflow_runs`, `get_workflow_run_logs`, `get_job_logs`, `search_code`, `search_issues`

CI control: `trigger_workflow`, `rerun_workflow`, `cancel_workflow_run`, `get_check_runs`, `get_combined_status`

Review control: `request_reviewers`, `remove_requested_reviewers`, `get_pr_mergeability`, `add_review_comment`, `get_branch_protection`, `list_notifications`

Codespaces: `list_codespaces`, `get_codespace`, `list_codespace_machines`, `create_codespace`, `start_codespace`, `stop_codespace`, `delete_codespace` (requires the `codespace` PAT scope on `GITHUB_TOKEN` — see [API_KEYS.md](./docs/API_KEYS.md)). **Runtime requirement:** `exec_in_codespace` requires the GitHub CLI (`gh`) to be installed and authenticated on the server running this MCP instance.

### Cloudflare
D1: `cf_d1_database` (list/get), `cf_d1_database_create`, `cf_d1_database_delete`, `cf_d1_database_query`

KV: `cf_kv_namespace` (list/get), `cf_kv_namespace_create/update/delete`

R2: `cf_r2_bucket` (list/get), `cf_r2_bucket_create/delete`

Hyperdrive: `cf_hyperdrive_config` (list/get), `cf_hyperdrive_config_create/update/delete`

Workers: `cf_workers_list`, `cf_workers_get_worker`, `cf_workers_get_worker_code`

Observability: `cf_workers_observability_query/keys/values/compare`

### Notion
`notion_search`, `notion_list`, `notion_get_page`, `notion_get_page_history`, `notion_create_page`,
`notion_create_pages_batch`, `notion_create_database`, `notion_get_database`, `notion_query_database`,
`notion_update_page`, `notion_update_pages_batch`, `notion_update_database`, `notion_sync_content`

### Mem0
`mem0_add`, `mem0_add_batch`, `mem0_get`, `mem0_get_history`, `mem0_list`, `mem0_search`,
`mem0_update`, `mem0_delete`, `mem0_delete_batch`, `mem0_delete_all`

### Context7
`search_library`, `get_library_docs` — resolve a library/framework name to a Context7 ID, then fetch
up-to-date, version-specific docs and code examples for it. Works without an API key at low rate
limits; `CONTEXT7_API_KEY` is optional.

### Sync
`sync_mem0_to_notion` — one-way sync from Mem0 into a Notion "Memory Index": creates/updates a
Notion page per Mem0 memory, archives pages for superseded or hard-deleted memories, and leaves any
manual edits on those pages untouched.

### Jules
`jules_list_sources`, `jules_create_session`, `jules_list_sessions`, `jules_get_session`, `jules_get_activities` — hand off a coding task to Google's Jules agent, fire-and-forget: it works in its own sandboxed VM against a connected GitHub repo and (by default, via `automation_mode: AUTO_CREATE_PR`) opens a PR when done, with plans auto-approved. Distinct from `delegate_agent`/`delegate_designer` in this repo: those are synchronous read-only (or frontend-fenced) loops returning one answer per call; a Jules session is asynchronous and can write arbitrary code across a whole repo over several minutes, independent of this server's request lifecycle — create it, then poll `jules_get_session`/`jules_get_activities` later. Alpha API (Google's own designation), no unauthenticated tier.

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
| `CONTEXT7_API_KEY` | Context7 tools (optional — works unauthenticated at low rate limits) |
| `JULES_API_KEY` | Jules tools (`jules_*`) — required, no unauthenticated tier |
| `GEMINI_API_KEYS` | Gemini tools (`delegate_agent`, `delegate_research`) — comma-separated, multi-key cascade; required (or legacy singular `GEMINI_API_KEY`), throws if unset |
| `GEMINI_MODEL` | Primary Gemini model for delegation (default `gemini-flash-latest`) |
| `GEMINI_FALLBACK_MODELS` | Comma-separated fallback model list used on 429s (default `gemini-3.5-flash-lite,gemini-3.1-flash-lite`) |
| `GEMINI_NOTION_ROOT_PAGE_ID` | Notion page under which Gemini tool outputs are logged (has a working default) |
| `OPENROUTER_API_KEYS` | Comma-separated OpenRouter API key(s) — required for `delegate_agent`'s `provider: "glm"` mode, unused otherwise |
| `GLM_MODEL` | Primary GLM model (via OpenRouter) for `provider: "glm"` delegation (default `z-ai/glm-4.5-air:free`) |
| `GLM_FALLBACK_MODELS` | Comma-separated fallback model list used on 429s, cascaded per `OPENROUTER_API_KEYS` key (default: none configured) |
| `GLM_REQUEST_TIMEOUT_MS` | Defensive ceiling on a single GLM/OpenRouter call (default `55000`) |
| `GROQ_API_KEYS` | Comma-separated Groq API key(s) — required for `delegate_agent`'s `provider: "groq"` mode, unused otherwise; free-tier is request/token-rate-limited, not credit-balance-gated like OpenRouter/GLM |
| `GROQ_MODEL` | Primary Groq model for `provider: "groq"` delegation (default `openai/gpt-oss-120b`, a production model) |
| `GROQ_FALLBACK_MODELS` | Comma-separated fallback model list used on 429s, cascaded per `GROQ_API_KEYS` key (default `qwen/qwen3.6-27b` — stronger on benchmarks but a Groq **preview** model, kept as fallback rather than primary for availability reasons) |
| `GROQ_REQUEST_TIMEOUT_MS` | Defensive ceiling on a single Groq call (default `55000`) |
| `DEFAULT_LLM_PROVIDER` | Which provider `delegate_agent` uses when a call omits `provider` (default `gemini`) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` + `KV_REST_API_TOKEN`) | Optional — persists per-model rate-limit cooldowns and `delegate_agent` resume checkpoints across invocations; fails open if neither pair is set. Either naming works — the raw Upstash Marketplace integration names them `UPSTASH_REDIS_REST_*`, Vercel's own "KV" product (also Upstash-backed) names them `KV_REST_API_*`. |
| `DEFAULT_OWNER` | Default GitHub owner when omitted from a call (defaults to `allocsys`) |
| `GITHUB_MIN_REQUEST_INTERVAL_MS` | Minimum spacing between outgoing GitHub REST requests, to avoid secondary rate limits (default `300`) |
| `GITHUB_MAX_RETRIES` | Max retries on GitHub secondary-rate-limit/429 responses (default `3`) |
| `GITHUB_RETRY_BASE_MS` | Fallback backoff base when GitHub omits `Retry-After` (default `1500`, doubles per retry) |
| `NOTION_INDEX_DATABASE_ID` | Database used for entity_id → page_id dedup lookups. **Set this yourself** if you're self-hosting — the default points to a database in the original deployer's own Notion workspace, which your integration won't have access to. Create a database in your workspace, share it with your integration (notion.so/my-integrations), and use its ID (the 32-char segment in its URL). |
| `NOTION_SYNC_PARENT_PAGE_ID` | Parent page for pages created by `sync_mem0_to_notion`. **Set this yourself** if you're self-hosting, same reason as above — the default points to a page in the original deployer's workspace. Share a page in your own workspace with your integration and use its page ID. |
| `MCP_SHARED_KEY` | Shared-secret auth for `/mcp`. Unset = endpoint is open to anyone with the URL — set this in any real deployment. |
| `IP_ALLOWLIST_ENABLED` | Set `false` to disable the IP allowlist (default: enabled) |
| `ALLOWED_IP_RANGES` | Comma-separated CIDR ranges allowed to call `/mcp` (defaults to Anthropic's published connector range) |
| `TRUST_PROXY_HOPS` | Number of reverse-proxy hops to trust for client-IP detection (default `1`, matches Render). Adjust if deploying behind a different proxy chain. |

## Security notes

- Requests to `/mcp` are restricted by IP allowlist and rate-limited (30 requests/min).
- Scope `GITHUB_TOKEN` as narrowly as possible (ideally fine-grained, limited
  to specific repos). This server can create/delete repos and files, merge
  PRs, and delete Cloudflare resources — treat every configured token as
  live write access.
- `GET /` reports which connectors are configured; `GET /health` stays open
  and info-free for uptime checks.
- Rotate any token if you ever suspect it's been exposed.

## License

Licensed under **AGPL-3.0** with the **Commons Clause**. In plain terms:

- You can use, run, modify, and self-host this server, including for internal
  business use — for free.
- If you modify it and let others interact with your version over a network
  (e.g. host it as a service), you must publish the source of your changes
  (AGPL-3.0's network-copyleft requirement).
- You may **not** sell it — the Commons Clause blocks offering a paid
  product or service whose value comes substantially from this software's
  functionality, including paid hosting of it, without a separate agreement
  with the licensor.

See [`LICENSE`](./LICENSE) for the full, binding text. This summary is for
convenience only and isn't a substitute for reading it (and isn't legal
advice).

## Running locally

```bash
export GITHUB_TOKEN=ghp_yourtokenhere
npm install
npm start
```

Server listens on `PORT` (default `8080`). MCP endpoint: `POST /mcp`.
Health check: `GET /health`.

## Testing

```bash
npm install
npm test
```

Runs the unit tests (vitest) covering the IP-allowlist/auth helpers
(`connectors/security.js`), the GitHub client's retry/backoff logic
(`connectors/github/client.js`), and the Jules client/tools
(`connectors/jules/`). CI (`.github/workflows/ci.yml`) runs these
same tests on every push and PR, plus a syntax check and a boot/`GET /health`
smoke test, as a merge gate — it does not deploy; Render and Vercel already
auto-deploy on push via their own GitHub integrations.
