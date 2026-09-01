# Plan: Make `delegate_editor` asynchronous (QStash-backed, like `delegate_agent`)

Goal: port `delegate_agent`'s fire-and-forget + background-worker-chain +
poll/resume pattern onto `delegate_editor`, without changing its write
guardrails (branch precondition, deny list, per-run/per-file write caps).

Reference implementation to mirror throughout: `connectors/gemini/agent_checkpoint.js`,
`connectors/gemini/qstash_client.js`, `connectors/gemini/agent_worker.js`,
`connectors/gemini/agent_tools.js`, and `seedRun`/`singleStep` in
`connectors/gemini/agent_delegate.js`.

Work sequentially, one step at a time. Each step should be its own commit
(and ideally its own `delegate_editor` run) so a broken step is easy to
isolate and revert.

---

## Step 1 — Checkpoint layer: add async status fields

**File:** `connectors/github/editor_checkpoint.js`

- Add `status` field ("running" | "done" | "failed"), defaulting to
  "running" when omitted, same as `agent_checkpoint.js`'s `saveCheckpoint`.
- Add `lastStepAt` (epoch ms, always set on every save — freshness signal
  for polling).
- Add `stepStartedAt` (epoch ms or null — heartbeat written by the worker
  right before it starts a step, used to detect a crashed-mid-step worker).
- Add `finalAnswer` (only set by completion paths, so a "done"/"failed"
  poll can return the real answer without needing the full loop state).
- Keep the existing whole-blob save shape (not the list+meta split
  `agent_checkpoint.js` uses) — `delegate_editor`'s state is small enough
  that this isn't a scaling concern, per the file's existing header
  reasoning.

**Done when:** `saveCheckpoint`/`loadCheckpoint` round-trip the four new
fields correctly; existing callers that don't pass `status` still default
to "running" (no behavior change for the current synchronous path).

---

## Step 2 — `runEditorAgent`: support `singleStep`

**File:** `connectors/github/editor_delegate.js`

- Add a `singleStep` boolean option to `runEditorAgent`.
- When `singleStep: true`: bound *this call's* loop to exactly one
  iteration, while still deriving `isFinalStep`/tool-withholding from the
  run's **true overall step ceiling** (stored on the checkpoint at seed
  time — see Step 3), not from `stepsDone + 1`. This is the exact bug
  `agent_worker.js`'s header warns about avoiding (`singleStep` vs.
  `max_steps: stepsDone + 1` are NOT equivalent).
- On completion (real answer, or hard-cap finalize), persist
  `status: "done"` and `finalAnswer` via the checkpoint — mirror
  `agent_delegate.js`'s `finishRun` closure.
- On an unrecoverable failure with no more retries left at this layer,
  leave `status: "running"` (the worker, not this function, owns
  dead-lettering — see Step 4) unless it's the final structural failure
  path.

**Done when:** a unit test can call `runEditorAgent({ resume_run_id, singleStep: true })`
against a seeded checkpoint and see it advance exactly one step, and the
existing fully-synchronous (no `singleStep`) call path is provably
unchanged (existing tests still pass).

---

## Step 3 — `seedEditorRun`

**File:** `connectors/github/editor_delegate.js`

- Add `seedEditorRun({ owner, repo, branch, task, max_steps })`, mirroring
  `agent_delegate.js`'s `seedRun`:
  - Runs `assertNotDefaultBranch` up front (same guardrail #2 check the
    synchronous path already does) — do this before ever writing a
    checkpoint, so an invalid branch never gets a `run_id` at all.
  - Generates a `runId`, builds the initial system-preamble turn, and
    saves a checkpoint with `stepsDone: 0`, `status: "running"`, and the
    run's real overall step ceiling (`Math.min(max_steps, EDITOR_HARD_MAX_STEPS)`)
    stored on the checkpoint — this is what Step 2's `singleStep` path
    reads instead of trusting a per-call `max_steps`.
  - Does **not** take any steps itself — returns `runId` immediately.

**Done when:** calling `seedEditorRun` produces a loadable checkpoint with
`stepsDone: 0` and no Gemini/LLM calls made.

---

## Step 4 — Editor worker endpoint

**New file:** `connectors/github/editor_worker.js`

Mirror `connectors/gemini/agent_worker.js` closely:

- Export `handleEditorWorker(req, res)`.
- Verify the inbound QStash signature via the **existing**
  `qstash_client.js` (`verifyQStashSignature`) — no new signing-key
  infrastructure needed, same Upstash account/product.
- Load the checkpoint; no-op (200) if missing, or if `status !== "running"`,
  or if `stepsDone !== afterStep` (idempotency guard, identical reasoning
  to `agent_worker.js`).
- Write a heartbeat (`stepStartedAt: Date.now()`) before calling into the
  loop.
- Call `runEditorAgent({ resume_run_id: runId, singleStep: true })`.
- If still running after the step: re-publish the next step via
  `publishAgentStep` (reuse as-is — it's generic over `runId`/`afterStep`/
  `retryCount`, not Gemini-specific) targeting a **new** env var
  (`EDITOR_WORKER_URL`, see Step 6) rather than `AGENT_WORKER_URL`.
- Dead-letter after `EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES` consecutive
  same-step failures, finalizing `status: "failed"` with `finalAnswer` set
  to the last error — same shape as `agent_worker.js`.

**Done when:** a signed test request against a seeded checkpoint advances
one step and either re-chains or finalizes correctly; an unsigned request
is rejected with 401 before touching any checkpoint.

---

## Step 5 — Wire the route

**File:** `server.js`

- Register `POST /api/editor-worker` → `handleEditorWorker`, same pattern
  as the existing `/api/agent-worker` registration (including whatever
  raw-body-capture middleware config that route relies on for signature
  verification — `agent_worker.js`'s header explains why `req.rawBody`
  matters here).

**Done when:** hitting the new route locally (with a valid QStash
signature, or via QStash's own test-publish tooling) reaches
`handleEditorWorker`.

---

## Step 6 — Config flags

**File:** `config.js`

Add, mirroring the existing `DELEGATE_AGENT_ASYNC`/`AGENT_*` block:

- `EDITOR_WORKER_URL` (process.env, no default — analogous to `AGENT_WORKER_URL`)
- `EDITOR_AGENT_ASYNC` (process.env, default `"sync"` — analogous to `DELEGATE_AGENT_ASYNC`)
- `EDITOR_ASYNC_POLL_FRESH_SECONDS` (default 60, can literally reuse
  `AGENT_ASYNC_POLL_FRESH_SECONDS`'s default)
- `EDITOR_ASYNC_STEP_DEAD_SECONDS` (default 120)
- `EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES` (default 5)

Keep these as their own editor-specific flags rather than reusing the
`AGENT_*` ones directly — `delegate_editor`'s rollout should be
independently toggleable from `delegate_agent`'s, same way
`EDITOR_AGENT_ENABLED` is already independent of anything gating
`delegate_agent`.

**Done when:** all five are exported with sensible defaults and no
existing config export is disturbed.

---

## Step 7 — Async branching in `editor_tools.js`

**File:** `connectors/github/editor_tools.js`

Mirror `agent_tools.js`'s branching almost exactly:

- Compute `asyncEnabled = EDITOR_AGENT_ASYNC === "qstash" && isQStashConfigured()`.
  (Reuse `isQStashConfigured()` as-is — it only checks `QSTASH_TOKEN` +
  `AGENT_WORKER_URL` today, so it'll need a second look: either generalize
  it to accept which worker-URL env var to check, or add a small
  `isEditorQStashConfigured()` wrapper that checks `EDITOR_WORKER_URL`
  instead. Decide during implementation, not in this plan.)
- **Fresh call + async enabled:** call `seedEditorRun`, then
  `publishAgentStep({ runId, afterStep: 0 })` targeting `EDITOR_WORKER_URL`,
  return the `run_id` message immediately (same wording pattern as
  `delegate_agent`'s).
- **Resume + async enabled + no `max_steps`:** poll-only — check
  `status` ("failed" → return the stored error; "running" → freshness
  check against `lastStepAt`/`stepStartedAt` using the new
  `EDITOR_ASYNC_*_SECONDS` constants; "done" → fall through to the normal
  synchronous-read path, which already handles a completed checkpoint
  cheaply).
- **Resume + async enabled + explicit `max_steps`:** fall through to a
  synchronous `runEditorAgent` call, exactly like today.
- **Async disabled:** entirely unchanged current behavior.

**Done when:** with `EDITOR_AGENT_ASYNC` unset, `delegate_editor` behaves
byte-for-byte as it does today (regression check). With it set to
`"qstash"` and QStash configured, a fresh call returns a `run_id`
immediately and polling advances/reports correctly.

---

## Step 8 — Tests

Add editor equivalents of the existing async test coverage for
`delegate_agent`:

- `test/editor-worker.test.js` (mirror `agent-worker.test.js`) — signature
  rejection, idempotency no-op, re-chain, dead-letter.
- `test/editor-delegate-async-checkpoint.test.js` (mirror
  `agent-delegate-async-checkpoint.test.js`) — `singleStep` correctness,
  especially the `singleStep` vs. `max_steps: stepsDone + 1` distinction
  called out in Step 2.
- `test/editor-tools-async.test.js` (mirror `agent-tools-async.test.js`) —
  the branching logic in Step 7, gated by `EDITOR_AGENT_ASYNC` +
  `isQStashConfigured()`-equivalent.
- Regression run of existing `test/editor-tools.test.js` and
  `test/editor-delegate-*.test.js` to confirm the synchronous path is
  untouched when async is disabled.

**Done when:** full suite green, including a manual smoke test end-to-end
(seed → worker chain advances → poll reports "done" → final diff reviewed
on the branch) before flipping `EDITOR_AGENT_ENABLED`/`EDITOR_AGENT_ASYNC`
on anywhere real.

---

## Notes / risks carried over from `delegate_agent`'s own history

- **Publicly reachable endpoint:** `editor_worker.js` must fail CLOSED on
  signature verification, exactly like `agent_worker.js` — this is a
  write-capable loop, so an unverified request here is a strictly worse
  risk than the read-only `agent_worker.js` case.
- **Per-run/per-file write caps** (`EDITOR_MAX_FILES_PER_RUN`,
  `EDITOR_MAX_WRITES_PER_FILE`) live in `writtenFiles`/`writesPerFile`,
  already checkpointed — confirm Step 2's `singleStep` path restores and
  persists these correctly across worker invocations, not just
  `stepsDone`/`transcript`.
- **Stuck-loop / dead-letter interaction:** `editor_delegate.js` already
  has its own stuck-loop detection (`consecutiveAllRepeatSteps`,
  independent of the worker's `retryCount`-based dead-letter in Step 4).
  Keep these two mechanisms distinct, same as `agent_delegate.js` and
  `agent_worker.js` do — don't conflate a same-step failure with a
  stuck-but-succeeding loop.
