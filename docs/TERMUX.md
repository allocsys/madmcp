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
TERMUX_ENABLED=true
TERMUX_AGENT_SECRET=<long random string, e.g. openssl rand -hex 32>
```

Keep `MCP_SHARED_KEY` set too. `TERMUX_AGENT_SECRET` is a *different* secret on purpose: it can only poll and post results, it cannot call MCP tools.

### 2. Phone (Termux)

Install Termux and Termux:API from the **same source** (F-Droid recommended; mixing sources breaks Termux:API). Then in Termux:

```sh
pkg update
pkg install nodejs termux-api
```

Copy `scripts/termux-agent.mjs` to the phone (clone the repo, or download the raw file), then:

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

- `termux_exec` is arbitrary code execution on your phone, as the Termux app user (Termux's home, plus shared storage if you ran `termux-setup-storage`). Anyone who can call your MCP endpoint can use it, so keep `MCP_SHARED_KEY` and the IP allowlist on.
- Off by default: with `TERMUX_ENABLED` unset no tool is registered and the `/api/termux/*` routes are not mounted.
- The agent endpoints fail closed (401) without the exact bearer token and have their own rate limit.
- Jobs expire from Redis after `TERMUX_JOB_TTL_SECONDS` (default 600), output is capped (`TERMUX_MAX_OUTPUT_CHARS`, default 50000), commands are killed at their timeout, and the queue refuses more than `TERMUX_MAX_QUEUE_DEPTH` (default 20) waiting jobs.
- To revoke access: stop the agent, rotate `TERMUX_AGENT_SECRET`, or unset `TERMUX_ENABLED`.

## Redis cost

An idle agent makes one poll per `POLL_IDLE_MS` (default 10s), each costing about one Redis command, i.e. roughly 260k commands/month. It speeds up to `POLL_ACTIVE_MS` (default 1s) for `ACTIVE_WINDOW_MS` (default 2 min) after a job. Raise `POLL_IDLE_MS` on the phone if you're on a small Upstash plan.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TERMUX_ENABLED` | off | Must be exactly `true` to register the tools and mount the agent routes. |
| `TERMUX_AGENT_SECRET` | none | Bearer token the phone agent presents. Required. |
| `TERMUX_JOB_TTL_SECONDS` | `600` | How long a job record lives in Redis. |
| `TERMUX_DEFAULT_TIMEOUT_SECONDS` | `60` | Command timeout when the caller doesn't set one. |
| `TERMUX_MAX_TIMEOUT_SECONDS` | `300` | Upper bound on a command timeout. |
| `TERMUX_MAX_OUTPUT_CHARS` | `50000` | stdout/stderr cap, each. |
| `TERMUX_MAX_QUEUE_DEPTH` | `20` | Max jobs waiting at once. |
| `TERMUX_DEFAULT_WAIT_SECONDS` | `20` | How long a tool waits for the phone before returning a job_id. |
| `TERMUX_MAX_WAIT_SECONDS` | `45` | Upper bound on that wait (Vercel's function limit is 60s). |
| `TERMUX_WAIT_POLL_MS` | `1000` | How often a waiting tool re-checks Redis. |
