# Plan: Fire-and-forget delegate_agent (Scenario B — QStash self-chaining)

Status: proposed, not started
Date: 2026-08-28

## Context

`delegate_agent` (connectors/gemini/agent_delegate.js) currently runs its whole
multi-step Gemini function-calling loop synchronously inside one MCP tool
call/HTTP request, bounded by `HARD_MAX_STEPS` (30) specifically because that
request has to fit inside Vercel's function duration limit. Redis-backed
checkpointing (connectors/gemini/agent_checkpoint.js) already exists, so a
run that dies mid-way isn't lost — but recovering it today means the calling
model manually re-invoking `delegate_agent` with `resume_run_id`. That's
resumable, not fire-and-forget: the caller still blocks on every call.

Two scenarios were discussed to close that gap:

- **Scenario A** — `waitUntil` (`@vercel/functions`, already a dependency,
  already proven working in this repo for clone-token revocation in
  connectors/github/app_auth.js): return a `run_id` immediately, keep
  stepping the loop in the background after the response is sent. Still
  bounded by the function's `maxDuration`, but needs no new service.
- **Scenario B** (this doc) — self-chaining background worker via Upstash
  QStash: each invocation processes a bounded slice of the loop, checkpoints,
  and if not done, enqueues a new QStash message to continue. No single
  invocation needs to outlive normal duration limits, so it isn't capped by
  `maxDuration` at all. Higher-effort, needed only if Scenario A's ceiling
  turns out to be insufficient for real tasks.

**Sequencing note:** Scenario A should ship and be observed under real usage
first. Scenario B is only worth the added infra (new Upstash product, new
dependency, new endpoint, signature verification, retry/dead-letter
handling) if Scenario A's `waitUntil`/`maxDuration` ceiling actually gets hit
in practice. This doc is written so B can be picked up independently once
that's decided — it does not assume A's code exists, only that the decision
to proceed with B has been made.

**No new MCP tool surface either way.** Both scenarios reuse the single
`delegate_agent` tool. `resume_run_id` becomes the poll/status handle, driven
by a `status` field in checkpoint meta (`running` / `done` / `stalled`) plus
a `lastStepAt` freshness check — see "Tool behavior change" below. This
applies identically to A and B; only who's driving the background step
differs.

## Goal

`delegate_agent` returns almost immediately with a `run_id` on a fresh call,
the investigation runs to completion in the background via a self-chaining
QStash worker, and the caller polls status/result via the same tool +
`resume_run_id` — with no possibility of a run being silently stranded if
the worker chain breaks.

## Architecture

```
delegate_agent(task)                       [MCP tool, Claude-facing]
  -> writes checkpoint { status: "running", lastStepAt: now, ... }
  -> qstash.publishJSON({ url: WORKER_URL, body: { runId } })
  -> returns { run_id, status: "running" } immediately

/api/agent-worker  (new HTTP endpoint, QStash-invoked, signature-verified)
  -> loadCheckpoint(runId)
  -> run ONE Gemini turn (one step, not the whole loop)
  -> saveCheckpoint(runId, ...)     // existing function, unchanged
  -> if not done and steps < cap:
       qstash.publishJSON({ url: WORKER_URL, body: { runId } })  // re-chain
     else:
       saveCheckpoint(runId, { status: "done" | "failed", ... })

delegate_agent(resume_run_id)              [poll / fallback path]
  -> loadCheckpoint(runId)
  -> status "done"    -> return stored final answer, no re-execution
  -> status "running" + lastStepAt fresh   -> poll-only, report progress
  -> status "running" + lastStepAt stale   -> chain likely broken;
                                              resume the loop SYNCHRONOUSLY
                                              in this call as today's
                                              fallback (never strand a run)
```

## Sequenced implementation steps

These are ordered — later steps depend on earlier ones being in place and
tested.

1. **Provision QStash.** New product under the existing Upstash account (not
   a new vendor — same dashboard as the Redis DB already used via
   `@upstash/redis`). Add `QSTASH_TOKEN` (and signing keys, see step 4) as
   new env vars. No code yet.
2. **Add dependency.** `npm install @upstash/qstash`.
3. **Add `status`/`lastStepAt` to checkpoint meta.** Extend
   `saveCheckpoint`/`loadCheckpoint` in agent_checkpoint.js to read/write
   `status` (`"running" | "done" | "failed"`) and `lastStepAt` (epoch ms,
   updated every step). This is shared groundwork for A and B — do this
   regardless of which scenario ships first.
4. **New worker endpoint** (`/api/agent-worker` or equivalent under
   server.js's routing). Must verify the QStash request signature
   (`@upstash/qstash`'s `Receiver`) before doing anything — this endpoint is
   publicly reachable, unlike the MCP tool surface which sits behind the
   existing MCP auth. Reject unsigned/invalid requests outright.
5. **Extract a single-step function from `agent_delegate.js`'s loop.** The
   existing loop runs steps 1..N in one process; the worker needs to run
   exactly one step, checkpoint, and return. Refactor the per-step body
   (function-call dispatch + Gemini turn) into a standalone function callable
   both from the existing synchronous loop (kept for the stale-fallback path)
   and from the new worker. Avoid duplicating this logic — the fallback path
   in step 7 depends on it staying in one place.
6. **Wire the re-chain call.** After a successful step in the worker, if the
   run isn't finished and hasn't hit `HARD_MAX_STEPS`, `publishJSON` a new
   message to itself with the same `runId`. On completion (final answer or
   step cap), write `status: "done"` and stop the chain.
7. **Update the `delegate_agent` tool handler** (agent_tools.js) per the
   "Tool behavior change" section below — start/poll/stale-fallback
   branching on checkpoint `status` + `lastStepAt`. The stale-fallback branch
   reuses the step function from step 5 in the existing synchronous loop
   shape, so it must land after step 5.
8. **Dead-letter / retry handling.** QStash retries failed deliveries
   automatically (see pricing doc: a retried message is billed again, so
   this also affects the cost math in "Cost" below). Confirm the worker
   endpoint is idempotent per step — re-delivery of the same `runId` at the
   same step should not double-execute a Gemini turn. Cheapest guard: the
   worker checks `lastStepAt`/step count on entry and no-ops if another
   invocation already advanced the checkpoint past what this message expects.
9. **Test.** Add a test alongside the existing `test/agent-delegate-loop.test.js`
   / `test/agent-checkpoint.test.js` covering: fresh start returns
   immediately with `status: running`; poll while fresh returns progress
   without re-executing; poll while stale falls back to synchronous resume;
   worker rejects unsigned requests.
10. **Rollout.** Ship behind an env flag (e.g. `DELEGATE_AGENT_ASYNC=qstash`)
    so it can be disabled back to today's fully-synchronous behavior without
    a revert if the chain misbehaves in production.

## Tool behavior change (delegate_agent, no new tool)

- `task` given, no `resume_run_id` → start a new run, checkpoint
  `status: "running"`, publish first QStash message, return immediately with
  `run_id`.
- `resume_run_id` given, checkpoint `status: "running"`, `lastStepAt` fresh
  (e.g. within ~20–30s) → poll-only, return current progress, do not touch
  the loop.
- `resume_run_id` given, checkpoint `status: "running"`, `lastStepAt` stale
  → assume the QStash chain broke; fall back to resuming the loop
  synchronously in this call, same as today's behavior. This is what
  guarantees a run can never be silently stranded.
- `resume_run_id` given, checkpoint `status: "done"` → return the stored
  final answer directly.

## Cost

QStash free tier: 1,000 messages/day, no credit card. Each step ≈ one
message (plus any retries from step 8's handling, each retry billed as an
additional message). At ~20 steps/run that's ~50 runs/day free; beyond that,
pay-as-you-go is $1 per 100K messages — negligible even at heavy internal
usage. Confirm actual step-to-message ratio once step 9's tests are running
against real tasks, since parallel function calls within a single Gemini
turn may or may not map 1:1 to worker invocations depending on how step 5's
extraction is shaped.

## Open questions

- Does a single Gemini turn that issues multiple parallel function calls
  become one worker invocation (all calls resolved before re-chaining) or
  one per call? Affects both latency and the cost math above. Resolve during
  step 5.
- `HARD_MAX_STEPS` (30) was originally sized around a single request's
  duration budget. Once B removes that constraint, is 30 still the right
  ceiling, or should it be revisited now that step count no longer trades
  directly against timeout risk?
- Should `log_to_notion` fire once per finished run (as today) or is a
  progress log per worker step useful for debugging broken chains? Leaning
  toward keeping it as-is (final only) to avoid Notion rate-limit pressure
  (see config.js's Notion throttle comment) from a long chain.
