# Plan: Fire-and-forget delegate_agent (Scenario B — QStash self-chaining)

Status: in progress -- steps 1-8 done (step 5 with a noted deviation);
step 4's dashboard-side half (QStash provisioning + the four env vars in
production) is now CONFIRMED SET (see progress log) -- step 4 is fully
done. Step 9 is partially done: agent_tools.js's own branching logic now
has dedicated test coverage (test/agent-tools-async.test.js), but a real
network round trip against live QStash is still unexercised (see progress
log for why that's a staging-verification item, not a unit test). Step 10
(flipping DELEGATE_AGENT_ASYNC=qstash in production) remains open --
ready to attempt now that step 4 is confirmed, but not yet done.
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

## Progress log

**2026-08-28, step 5 (with a deviation from the literal instruction) --
commits b556001, f439668, 4da4728, c104125, 32eb0f0.**

Step 5 as written says to physically extract the per-step body into a
standalone function shared by the existing loop and the new worker. That
turned out to be avoidable: the existing loop, called with
`resume_run_id` + `max_steps: stepsDone + 1`, already takes exactly one
step and returns -- which is the QStash worker's exact call shape --
WITHOUT needing the loop body itself pulled apart. Reusing the whole loop
one call at a time is lower-risk than extracting from it (this file's own
comments document a long list of hard-won, interacting fixes -- repeat
detection, verification passes, structural line-quote checks -- that a
manual extraction could easily disturb).

That reuse only works once two checkpoint-lifecycle bugs are fixed, both
found by actually trying it and running the real test suite rather than
assumed:

1. Hitting a caller-supplied `max_steps` below `HARD_MAX_STEPS` used to
   unconditionally delete the checkpoint -- silently discarding a
   resumable run the moment a caller under-budgeted a call. This wasn't
   only a Scenario B blocker; it's a pre-existing gap in today's
   synchronous resume story too. Fixed: only the genuine `HARD_MAX_STEPS`
   ceiling now finalizes/deletes-equivalent; anything below that leaves
   the checkpoint alone (already `status: "running"` with a fresh
   `lastStepAt` from the per-step save).
2. Genuine completion also used to delete the checkpoint immediately, so
   a `status: "done"` could never actually be polled -- there was no
   window in which it existed. Fixed: completion now persists a
   `status: "done"` checkpoint with a new `finalAnswer` field instead of
   deleting, and `runInvestigation` short-circuits on `resume_run_id` +
   `status === "done"` by returning the stored answer directly rather than
   re-entering the loop. This is exactly the poll behavior the "Tool
   behavior change" section below specifies for the done case.

Two supporting bugs surfaced while wiring this up and testing it for real
(agent_checkpoint.js, commit f439668): `saveCheckpoint`'s destructured
params didn't include `finalAnswer` at all, so it was silently dropped on
every save (same class of bug as the pre-existing `structuralRecheckUsed`
regression this file already documents); and `loadCheckpoint` required a
non-empty `contents` list to consider a checkpoint valid, which is no
longer true for a done checkpoint (deliberately skips re-pushing contents)
or a task answered directly on step 1 with zero tool calls.

Verified via a full local clone + `npx vitest run` (367 -> 374 tests
passing), including a new test
(test/agent-delegate-async-checkpoint.test.js) that literally drives a run
to completion one step at a time via the worker's exact call pattern
against a real (fake-Redis-backed) checkpoint store, and confirms polling
a done run doesn't re-invoke the model.

**2026-08-28, steps 4/6/7/8/10 -- commits 6ea2d17, b98412b, 4e43a77,
fb3cd5d, c766e1d, 5db7af9, 909dfa9, 7e93a60.**

All five remaining code items landed together since they're tightly
interdependent (the worker needs the tool handler's seed path to have
something to chain from, and vice versa):

- **Step 4 (worker endpoint + signature verification):**
  `connectors/gemini/qstash_client.js` (new) wraps `@upstash/qstash`'s
  `Client` (publish) and `Receiver` (inbound signature verification) --
  deliberately an ASYMMETRIC fail-open contract, unlike every other
  optional-infra file in this connector (cooldown.js, agent_checkpoint.js):
  publishing fails open (caller checks `isQStashConfigured()` and falls
  back to sync), but `verifyQStashSignature` fails CLOSED, since this
  endpoint is publicly reachable and an unverifiable request must never be
  treated as legitimate. `connectors/gemini/agent_worker.js` (new) is the
  actual `/api/agent-worker` handler, registered in server.js OUTSIDE the
  `/mcp` middleware stack (no requireMcpKey/requireAllowedIp/mcpLimiter --
  auth here is entirely the QStash signature). server.js's `express.json()`
  now also captures `req.rawBody` (a `verify` callback) specifically so the
  signature can be checked against the exact bytes QStash signed, not a
  re-serialized (and potentially non-byte-identical) `req.body`.
  **Genuinely still open:** the env vars this code reads
  (`QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`,
  `AGENT_WORKER_URL`) are not yet set anywhere -- step 1's "provision
  QStash" was a dashboard action, not a commit, and still needs a human
  with Upstash/Vercel access to (a) create the QStash product, (b) deploy
  this branch so a real `AGENT_WORKER_URL` exists to point at, then (c) set
  all four env vars. Until then `isQStashConfigured()` returns false and
  everything below stays inert regardless of `DELEGATE_AGENT_ASYNC`.
- **Step 6 (re-chain wiring):** confirmed the deviation noted under step 5
  above -- `agent_worker.js` calls `runInvestigation({ resume_run_id,
  max_steps: stepsDone + 1 })` (the existing loop, one call = one step) and
  `publishAgentStep`s itself again with the fresh `stepsDone` if the
  checkpoint it reloads afterward is still `status: "running"`. No bespoke
  single-step function was needed, as anticipated.
- **Step 7 (tool handler branching):** `agent_delegate.js` gained
  `seedRun()` -- writes a `status: "running"`, `stepsDone: 0` checkpoint
  (the initial SYSTEM_PREAMBLE/task turn, zero steps taken) WITHOUT
  entering the loop at all, specifically so a fresh async call can return a
  `run_id` immediately rather than blocking on step 1. `agent_tools.js`'s
  delegate_agent handler now branches on `DELEGATE_AGENT_ASYNC === "qstash"
  && isQStashConfigured()`: fresh call -> `seedRun` + one `publishAgentStep`
  + immediate return; resume with a fresh `lastStepAt` -> poll-only (read
  the checkpoint, touch nothing); resume with a stale `lastStepAt` -> fall
  through to today's synchronous `runInvestigation` call (the
  never-silently-stranded guarantee); resume on a `status: "done"` or
  missing checkpoint -> also falls through, since `runInvestigation`
  already handles both correctly on its own (cheap stored-answer read, or
  its existing clear error). A `status: "failed"` checkpoint (step 8's
  dead-letter outcome) is handled explicitly here rather than falling
  through, since resuming a deliberately-given-up-on run isn't the same
  case as a stale-chain fallback.
- **Step 8 (dead-letter/idempotency):** `agent_worker.js` no-ops (does not
  re-execute) whenever the live checkpoint's `stepsDone` no longer matches
  the `afterStep` a message was published with -- the redelivery-safety
  property QStash's automatic retries need. A `retryCount` travels inside
  each published message (not stored server-side -- separate QStash-invoked
  processes share no memory) and increments only when a step completes
  without advancing `stepsDone`; after `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES`
  (new config, default 5) such failures in a row, the chain stops
  re-publishing and finalizes the checkpoint as `status: "failed"` with the
  last error as `finalAnswer`, instead of retrying indefinitely at QStash's
  (and Gemini quota's) expense.
- **Step 10 (rollout flag):** `DELEGATE_AGENT_ASYNC` (new config, default
  `"sync"`) gates ALL of the above at once in `agent_tools.js` -- unset or
  any value other than `"qstash"` reproduces today's fully-synchronous
  behavior with zero code-path change, matching the "disable without a
  revert" requirement.

Verified via a full local clone + `npx vitest run` (374 -> 381 tests
passing, no regressions) and `npx eslint .` (clean, one pre-existing
unrelated warning), including a new `test/agent-worker.test.js` covering:
signature rejection, missing-runId rejection, no-op on an expired/unknown
checkpoint, no-op on an `afterStep`/`stepsDone` mismatch (idempotent
redelivery), a normal re-chain on an unfinished step, no re-chain once a
run completes, and dead-lettering after 5 consecutive same-step failures.

**Still open:** the dashboard-side half of step 4 (see above -- provision
QStash, deploy, set the four env vars), step 9's broader test coverage
(this batch's own tests cover the worker endpoint itself; the
agent_tools.js branching logic and a true end-to-end QStash round trip
remain unexercised), and step 10's actual flip (`DELEGATE_AGENT_ASYNC=qstash`
in production), which should only happen after step 4's provisioning is
confirmed working and per the "Sequencing note" at the top of this doc --
this is new infra, not yet observed under any real traffic.

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
