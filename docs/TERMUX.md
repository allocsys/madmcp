# Termux connector

Lets Claude (or any MCP client connected to madmcp) run commands and use
Termux:API features on your Android phone.

## How it works

Your phone is behind mobile NAT, so madmcp can't call it. Instead the phone
**polls madmcp** (outbound HTTPS only, no tunnel, no open ports):

1. A tool call (`termux_exec`, `termux_api`) puts a job in Redis.
2. The agent in Termux (`scripts/termux-agent.mjs`) polls `POST /api/termux/poll`, picks the job up, runs it, and posts the output to `POST /api/termux/result/:id`.
3. The tool waits a few seconds for the result and returns it. If the phone is slow or offline it returns a `job_id`; collect it later with `termux_result`.

## Tools

| Tool | What it does |
|---|---|
| `termux_exec` | Run a shell command (`sh -c`) in Termux; returns stdout, stderr, exit code. |
| `termux_api` | `battery`, `location`, `clipboard_get`, `clipboard_set`, `notify`, `toast`, `vibrate`, `wifi_info`. Fixed argv on the phone, no shell. |
| `termux_result` | Fetch the output of a job that was still queued/running. |

SMS, calls, contacts, camera and microphone are deliberately not in
`termux_api`.

## Setup

### 1. Server (madmcp)

Redis must be configured (`UPSTASH_REDIS_REST_URL`/`TOKEN` or the `KV_REST_API_*` pair). Then set:

```
TERMUX_AGENT_SECRET=<long random string, e.g. openssl rand -hex 32>
```

The connector is **on by default**; set `TERMUX_ENABLED=false` to turn it off. Until `TERMUX_AGENT_SECRET` is set it does nothing: the agent routes return 401 and `termux_exec` refuses to queue.

Keep `MCP_SHARED_KEY` set too. `TERMUX_AGENT_SECRET` is a *different* secret on purpose: it can only poll and post results, it cannot call MCP tools.

### 2. Phone (Termux)

Install Termux and Termux:API from the **same source** (F-Droid recommended; mixing sources breaks Termux:API). Then in Termux:

```sh
pkg update
pkg install nodejs termux-api
```

**Quick start** -- one script installs what's missing, asks for your server URL and secret once, downloads the agent and runs it:

```sh
pkg install -y curl
curl -fsSL -o termux-start.sh https://raw.githubusercontent.com/allocsys/madmcp/main/scripts/termux-start.sh
bash termux-start.sh        # foreground
bash termux-start.sh bg     # or: detached in tmux
```

If the repo is private, add `-H "Authorization: token $GITHUB_TOKEN"` to the `curl` and `export GITHUB_TOKEN=...` before running the script. Other commands: `stop`, `config` (re-enter URL/secret), `update` (re-download the agent). Config is stored in `~/madmcp-agent/env` (chmod 600).

**Manual alternative** -- copy `scripts/termux-agent.mjs` to the phone (clone the repo, or download the raw file), then:

```sh
export MADMCP_URL=https://<your-madmcp-host>
export TERMUX_AGENT_SECRET=<same value as on the server>
termux-wake-lock        # stop Android suspending Termux
node termux-agent.mjs
```

To keep it running: start it inside `tmux`, disable battery optimisation for Termux in Android settings, and optionally use the Termux:Boot app to start it on boot.

### 3. Check it

Ask Claude to run `termux_exec` with `echo hello`. The first command after the agent has been idle can take up to ~10 seconds to be noticed.

## Security

- `termux_exec` is arbitrary code execution on your phone, as the Termux app user (Termux's home, plus shared storage if you ran `termux-setup-storage`). Anyone who can call your MCP endpoint can use it, so keep `MCP_SHARED_KEY` and the IP allowlist on. The agent also asks for your approval on the phone before running anything that is not plainly read-only (see **Approval on the phone** below).
- On by default, but inert until `TERMUX_AGENT_SECRET` is set. With `TERMUX_ENABLED=false` no tool is registered and the `/api/termux/*` routes are not mounted.
- The agent endpoints fail closed (401) without the exact bearer token and have their own rate limit.
- Jobs expire from Redis after `TERMUX_JOB_TTL_SECONDS` (default 600), output is capped (`TERMUX_MAX_OUTPUT_CHARS`, default 50000), commands are killed at their timeout, and the queue refuses more than `TERMUX_MAX_QUEUE_DEPTH` (default 20) waiting jobs.
- To revoke access: stop the agent, rotate or unset `TERMUX_AGENT_SECRET`, or set `TERMUX_ENABLED=false`.

## Approval on the phone

The check runs **in the agent on your phone**, not on the server, so a leaked `MCP_SHARED_KEY` or a compromised server can't skip it. When a job needs approval the agent shows a Termux notification with the command and **Approve** / **Deny** buttons, and waits. Only an explicit Approve runs it. Deny, swiping the notification away, no answer within the timeout, or a notification that can't be shown all mean the job is **not run**, and Claude gets a `Not run: ...` error.

This needs the Termux:API app and the `termux-api` package (the same ones `termux_api` uses). If Android hides notifications from Termux:API, risky commands are refused rather than run.

| Mode (`TERMUX_APPROVAL`) | Behaviour |
|---|---|
| `smart` (default) | Auto-runs simple read-only commands (`ls`, `pwd`, `cat`, `git status`, `ps`, `grep`, ...). Everything else asks. `termux_api` `location` and `clipboard_get` also ask. |
| `all` | Every job asks, including read-only ones. |
| `off` | Never asks (the old behaviour). |

`smart` is an allowlist: it only recognises a small set of plain commands, and anything it doesn't understand asks. Commands with substitution (`$(...)`, backticks, `$VAR`), redirects to files, background jobs, subshells, or globs on file readers always ask, as does anything that mentions secret paths such as `.ssh`, `.gnupg`, `.git-credentials` or `.env`. Commands over 800 characters are refused because they're too long to review on a notification. Read the notification before you tap Approve.

Set these on the phone, for example in `~/madmcp-agent/env` (the start script loads it):

```sh
export TERMUX_APPROVAL=smart
export TERMUX_APPROVAL_TIMEOUT_S=60
```

| Variable | Default | Meaning |
|---|---|---|
| `TERMUX_APPROVAL` | `smart` | `smart`, `all` or `off`. An unknown value falls back to `smart`. |
| `TERMUX_APPROVAL_TIMEOUT_S` | `60` | Seconds to wait for a tap before refusing. |
| `TERMUX_APPROVAL_DIR` | `~/.madmcp-approvals` | Where the notification buttons drop their marker files. |

While a job waits for approval the agent doesn't poll for new jobs, and the calling tool may return a `job_id` to collect later with `termux_result`.

## Redis cost

An idle agent makes one poll per `POLL_IDLE_MS` (default 10s), each costing about one Redis command, i.e. roughly 260k commands/month. It speeds up to `POLL_ACTIVE_MS` (default 1s) for `ACTIVE_WINDOW_MS` (default 2 min) after a job. Raise `POLL_IDLE_MS` on the phone if you're on a small Upstash plan.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TERMUX_ENABLED` | on | Set to exactly `false` to unregister the tools and not mount the agent routes. |
| `TERMUX_AGENT_SECRET` | none | Bearer token the phone agent presents. Required. |
| `TERMUX_JOB_TTL_SECONDS` | `600` | How long a job record lives in Redis. |
| `TERMUX_DEFAULT_TIMEOUT_SECONDS` | `60` | Command timeout when the caller doesn't set one. |
| `TERMUX_MAX_TIMEOUT_SECONDS` | `300` | Upper bound on a command timeout. |
| `TERMUX_MAX_OUTPUT_CHARS` | `50000` | stdout/stderr cap, each. |
| `TERMUX_MAX_QUEUE_DEPTH` | `20` | Max jobs waiting at once. |
| `TERMUX_DEFAULT_WAIT_SECONDS` | `20` | How long a tool waits for the phone before returning a job_id. |
| `TERMUX_MAX_WAIT_SECONDS` | `45` | Upper bound on that wait (Vercel's function limit is 60s). |
| `TERMUX_WAIT_POLL_MS` | `1000` | How often a waiting tool re-checks Redis. |
