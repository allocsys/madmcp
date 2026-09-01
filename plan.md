# Plan: delegate_agent reliability & quota fixes

## Status (2026-09-01)

| Item | State |
|---|---|
| History compaction (bai token-bloat) | Done — PR #119, merged `main`@`e0a8ee3` |
| `resultCache` not persisted on resume | Fixed — PR #120, merged `main`@`b48e57f` |
| Async poll could silently drive 20 steps | Fixed — PR #121, merged `main` |
| Heartbeat / in-flight step tracking | Done — PR #123, merged `main`@`95e83a7`, live-validated 2026-09-01 |
| `deleteCheckpoint` GC never called in prod path | Open, undecided |
| Visible reasoning text not compacted | Fixed — PR #126, merged `main`@`31ad09a`, live-validated 2026-09-01 |
| B.AI rate-limit exhaustion misclassified as permanent error | Fixed — `main`@`8eaf2d1` (+ tests @`3cd20e6`/@`3e4b699`), CI green |
| Manual token-count validation vs baseline | Not completed |

## Resolved: Heartbeat / in-flight step tracking

### Problem

`agent_tools.js`'s poll-freshness check only reads `lastStepAt`, the
timestamp of the last *completed* step. A step that is merely slow (bai
key-rotation retries up to 55s per key, QStash delivery lag, Redis round
trips) is indistinguishable from a genuinely broken worker chain. PR
#121 stopped a stale poll from silently driving up to 20 real steps, but
it didn't close this detection gap — a poll now correctly *reports* a
stall, but the report itself can be wrong.

Live repro (2026-09-01): a real `bai` run reported "stalled" at 101s
idle after step 19; resuming with `max_steps: 21` completed step 20
immediately with a valid final answer. Not dead, just slow — plausibly
one bai key-rotation retry (~55s) plus normal step time.

### Approach

1. `agent_worker.js` writes `stepStartedAt` to the checkpoint *before*
   calling `runInvestigation({ singleStep: true })`, not just after it
   returns.
2. `agent_tools.js`'s freshness check uses `max(lastStepAt,
   stepStartedAt)` instead of `lastStepAt` alone — an in-flight step
   counts as fresh even before it completes.
3. Add a second, independent, *longer* ceiling on `stepStartedAt` itself
   (well past worst-case retry time) so a step that looks fresh only
   because the worker crashed mid-step (wrote `stepStartedAt`, never
   returned) still eventually reads as dead. This needs its own
   constant — not the same value as `AGENT_ASYNC_POLL_FRESH_SECONDS`.

### Constraints / caveats

- **Crash blind spot**: without step 3 above, a heartbeat alone trades
  false-stalled for false-alive on worker crash. Both ceilings are
  required, not either/or.
- **Clock source**: `stepStartedAt`/`lastStepAt` must share one
  consistent time source (Redis/store time, not per-caller `Date.now()`)
  or skew reintroduces false readings.
- **Idempotency interplay**: `agent_worker.js` already guards duplicate
  QStash deliveries via `afterStep`/`stepsDone` — the heartbeat write
  must sit inside that same guarded path, or a redelivered message could
  stomp a fresher `stepStartedAt` from the real in-flight attempt.
- **Doesn't diagnose root cause** — a heartbeat tells you "still
  running," not *why* it's slow (bai retry vs. QStash vs. Redis). If
  pinning that down matters later, that needs separate per-hop
  timestamps, not part of this fix.

### Implementation steps

1. [x] Add `stepStartedAt` write in `agent_worker.js`, inside the
   existing `afterStep`/`stepsDone` guard.
2. [x] Update `agent_tools.js`'s freshness check to `max(lastStepAt,
   stepStartedAt)`.
3. [x] Add a separate long-ceiling constant + check for a stuck
   `stepStartedAt` (crash case).
4. [x] Tests: fresh via `stepStartedAt` alone (no completed step yet);
   stale via the new long ceiling despite a fresh-looking
   `stepStartedAt`; duplicate-delivery race doesn't clobber a real
   in-flight heartbeat.
5. [x] Live validation: reproduce the 2026-09-01 101s-gap scenario again
   with the fix in place and confirm no false "stalled" report.

Merged via PR #123 (`main`@`95e83a7`). Full suite passing at merge:
473/473 tests. Live-validated 2026-09-01: a real `bai`-provider
delegate_agent run (run_id `7131e62e-acbe-45a5-a6f4-e799298d1489`) hit
a 40+s idle gap between steps 4 and 5 (bai key-rotation/latency, the
same class of gap as the original 101s repro) — polled repeatedly
through the gap and every poll correctly reported "still running" via
the `stepStartedAt` heartbeat, never a false "stalled." Run completed
normally (5 steps, ~104s wall clock) with a valid final answer. All
five implementation steps now closed.

## Condensed changelog (resolved)

- **History compaction (PR #119)**: replaces stored text of large tool
  results with a pointer once aged past `HISTORY_FULL_DETAIL_STEPS = 3`,
  gated to providers in `HISTORY_COMPACTION_PROVIDERS` (default `"bai"`
  only). Pre-compaction text preserved in a Redis side-store
  (`precompact:{runId}:{id}`) for `findUnverifiedClaims`/
  `lineIsVerbatimInToolResults`, never deleted. 468/468 tests passing at
  merge.
- **resultCache not persisted on resume (PR #120)**: `resultCache` was
  reinitialized empty on every resumed invocation (i.e. every step,
  under `agent_worker.js`'s per-step resume pattern) while
  `repeatCounts` correctly persisted — repeat calls silently
  re-executed instead of being served from cache. Fixed with the same
  side-store pattern as compaction (`resultcache:{runId}:{signature}`).
  Live-validated across a resume boundary and end-to-end.
- **Async poll could drive real steps (PR #121)**: a stale-checkpoint
  poll with no explicit `max_steps` used to fall through to a
  synchronous run capped at a default of 20 steps. Now a poll without
  explicit `max_steps` stays poll-only and reports the stall instead.
- **Visible reasoning text not compacted (PR #126)**: `compactHistoryInPlace`
  only ever rewrites `"user"`-role `functionResponse` turns -- it never
  touched `"model"`-role text, which is where a provider's inline
  chain-of-thought shows up when it isn't cleanly separated into the
  dedicated `reasoning_content` field (that field itself was never the
  issue -- `fromOpenAIChoice` in `connectors/openai_shape/adapter.js`
  only ever reads `message.content`/`message.tool_calls`, so
  `reasoning_content` was already excluded from resend regardless of
  this fix). Per the plan, tried the prompt-level fix first rather than
  extending compaction: added an explicit instruction to
  `SYSTEM_PREAMBLE` in `connectors/gemini/agent_delegate.js` telling the
  model not to narrate reasoning/plans in visible turn text -- no
  explanation alongside a function call, no walkthrough before the
  final answer. Merged `main`@`31ad09a`. Live-validated 2026-09-01: a
  `bai`-provider run (run_id `6b5787a2-5722-45ab-9cf5-63a19d48c6ce`,
  task: explain 401/403 vs 429 handling in `connectors/bai/client.js`)
  completed in 2 steps -- step 1 went straight to `github_read_file`
  with no narration, and the final answer led directly with the answer
  itself, no restated reasoning. Answer was also verified correct
  against the source file. Compaction of assistant turns (reasoning
  portion only, never the concluding answer, per the plan's original
  constraint) remains the documented fallback if this prompt fix is
  later found to be unreliable in practice -- not needed so far.

  **Not yet covered by this fix**: `delegate_editor`
  (`connectors/github/editor_delegate.js`) and `delegate_designer`
  (`connectors/frontend/designer_delegate.js`) each build their own,
  separate system-preamble text and don't share `agent_delegate.js`'s
  `SYSTEM_PREAMBLE` constant -- this fix does not apply to them.
  Separately, `delegate_editor`'s `runEditorAgent` doesn't even accept
  or forward a `provider` argument to `providerChat()`, so it cannot
  currently be routed to `bai` at all (always runs on the default
  `"gemini"` provider) -- not in scope for this fix, flagged here for a
  future item.

## Open items (not started, no active work)

- **New (2026-09-01): genuine QStash worker-chain stall observed live,
  then self-recovered — root cause still unknown.**
  A second `bai`-provider audit run (run_id
  `7a9a3942-e4f0-4063-a39f-af1ebbff109e`, a full `connectors/` directory
  audit) completed 19 steps normally, then went silent for 154s (past
  the 120s `AGENT_ASYNC_STEP_DEAD_SECONDS` ceiling) and was correctly
  reported as stalled rather than "still running" forever — this is the
  crash-detection half of PR #123 working as designed, a good real-world
  validation of that path specifically (distinct from the false-stall
  fix, which was validated separately same day).
  A later poll (no `max_steps` passed, pure read) showed the run still
  at 19 steps but with time-since-heartbeat down to 59s — **not** 154s+
  as it would be if one step had simply kept running the whole time.
  A dropping heartbeat age means a *new* `stepStartedAt` got written in
  between the two polls, i.e. something re-triggered mid-stall. Two
  candidate explanations, not distinguishable from polling alone:
    1. The original attempt genuinely died, and QStash's own
       delivery-retry mechanism fired a fresh invocation for the same
       step; it passed the idempotency guard (since `stepsDone` still
       equalled `afterStep`, nothing had advanced) and started a new
       attempt with a fresh heartbeat.
    2. A **concurrent duplicate** landed while the first attempt was
       still alive. `agent_worker.js`'s idempotency guard only blocks a
       redelivery once `stepsDone` has moved past `afterStep` — it does
       NOT stop two invocations with the *same*, not-yet-advanced
       `afterStep` both passing the guard and both calling
       `runInvestigation` concurrently. This is a distinct gap from what
       PR #123's tests cover (those test a *stale* afterStep after
       `stepsDone` advanced, not two simultaneous invocations at the
       same `afterStep`). If this is what happened, two heartbeat writes
       and two `runInvestigation` calls could race on the same step,
       possibly double-billing an LLM call or corrupting checkpoint
       state on whichever write lands last.
  All 13 connector subfolders had already been read by step 19, so the
  run was close to done regardless. Not yet resumed/diagnosed further.
  **How to actually pinpoint this:**
  - [x] **Per-attempt logging in `agent_worker.js`** — DONE, commit
    `2aad526` on `main` (log-only, no behavior change; 473/473 tests
    still passing after). A fresh `randomUUID()` invocationId is now
    generated at handler entry and logged at every entry/exit point of
    `handleAgentWorker`, including right where the `stepStartedAt`
    heartbeat is written (the exact point two concurrent invocations on
    the same `runId`+`afterStep` would race). Next occurrence: two log
    lines with different invocation ids but the same `runId`+`afterStep`
    overlapping in time confirms (2) concurrent duplicate; one
    invocation id with a gap between entry and a much-later exit (or an
    entry with no matching exit followed by a fresh entry later)
    confirms (1) dead-and-QStash-retried. **Instrumentation is live but
    unused so far — needs the stall to recur to actually read anything.**
  - [ ] **Cloudflare/Vercel function invocation logs** for this specific
    runId's timeframe — not yet checked. `cf_workers_observability_query`/
    `cf_workers_get_worker` style tooling already exists in this repo
    (`connectors/cloudflare/observability.js`) and could be pointed at
    whatever Worker/Function hosts `/api/agent-worker` to check for
    overlapping invocations or a crash/restart in that window, without
    adding new code.
  - [ ] **QStash's own dashboard/API** (Upstash) for delivery attempts
    against this runId's message — not yet checked. Would directly show
    whether QStash redelivered (supporting (1)) or whether only one
    delivery was ever made (which would instead implicate something
    else entirely, e.g. a Redis race on `saveCheckpoint`).
  Root cause is still open; only the logging groundwork is done. Next
  step is waiting for (or deliberately reproducing) another stall and
  reading the new `agent-worker[<id>]:` log lines.

  **Update (2026-09-01, later same day): stall reproduced, but the log
  read couldn't happen -- host is Vercel, not Cloudflare.** Re-ran the
  same repro shape (full `connectors/` audit, provider `bai`, run_id
  `87ff9356-56a5-4d4a-aaf3-bbaba0f213bd`). It stalled again at **step
  19** -- same step number as the original incident, which is itself
  mildly suggestive (13 connector subfolders means step 19 is roughly
  where a `bai`-provider audit naturally runs out of easy/cheap tool
  calls and starts hitting heavier files/retries, not obviously a fixed
  off-by-one, but worth keeping in mind if a third occurrence lands on
  the same step again).

  Two planned diagnostic avenues turned out to be unavailable in this
  environment:
  - `cf_workers_observability_query` (`connectors/cloudflare/observability.js`)
    was checked, but `cf_workers_list` only returned two Workers
    (`peak-plastic-4567`, `restless-manager-6789`) unrelated to this
    project -- **the actual deployment is on Vercel, not Cloudflare**,
    confirmed directly. No Vercel-equivalent logs/observability tool
    exists in this toolset, so the `agent-worker[<id>]:` invocation-id
    log lines from commit `2aad526` could not actually be read this
    time either. This blocks a direct confirmation either way on the
    concurrent-duplicate-vs-dead-retry question.
  - No QStash dashboard/API tool exists in this toolset -- delivery-attempt
    history for the stalled message remains unchecked, as noted below.

  However, resuming the stalled run (`resume_run_id` with explicit
  `max_steps: 21`) surfaced a concrete, mundane error instead of another
  silent gap: **all 3 configured `BAI_API_KEYS` were rate-limited (429)
  at step 19 simultaneously** -- two returned "model service busy,
  reduce request frequency," one returned an account-level rate-limit
  message. This is a real, well-supported alternative explanation worth
  weighing alongside the original two hypotheses:
    3. **Sustained B.AI rate-limiting driving the existing retry/re-chain
       path -- not a bug, the designed behavior working as intended.**
       `agent_worker.js` already re-publishes to QStash with a fresh
       heartbeat on any failed-but-under-`AGENT_WORKER_MAX_CONSECUTIVE_FAILURES`
       step (see its "Still running and under the retry cap" branch). If
       B.AI's 429s are the actual bottleneck on a long `bai`-provider
       audit, each retry attempt legitimately writes a fresh
       `stepStartedAt` before failing again -- producing exactly the
       "154s idle, then a later poll shows 59s" heartbeat-drop signature
       from the original incident, with **no QStash redelivery bug and
       no concurrent-duplicate race required.** This doesn't retroactively
       prove the original incident was this and not (1) or (2) -- without
       the invocation-id logs there's no way to fully distinguish them --
       but it's a plausible, simpler explanation that fits the observed
       symptom just as well, and is consistent with `bai` being the
       provider on both occurrences (free-tier GLM-5.3-Flash, only 3 keys,
       no model-fallback cascade -- see `connectors/bai/client.js`,
       `config.js`'s `BAI_API_KEYS` section).
  **Update (2026-09-01, later still: Vercel MCP added, mid-investigation)
  -- DIAGNOSED. Root cause is (3), sustained B.AI rate-limiting driving
  the existing retry/re-chain path exactly as designed, not a
  concurrent-duplicate idempotency bug.**

  A Vercel MCP connector became available mid-investigation, giving
  direct access to `Vercel:get_runtime_logs` against the actual host
  (project `madmcp`, team `allocsys`) -- the Cloudflare tooling had been
  a dead end (see above; this project runs on Vercel, not Cloudflare).
  Pulling logs for `/api/agent-worker` across both incidents showed:

  - **Both runs dead-lettered identically.** The original incident,
    run_id `7a9a3942-e4f0-4063-a39f-af1ebbff109e`, dead-lettered at
    22:41:07 with `agent-worker: runId ... dead-lettered after 5
    consecutive failures on step 20`. Today's reproduction, run_id
    `87ff9356-56a5-4d4a-aaf3-bbaba0f213bd`, dead-lettered at 23:03:13
    with the identical message, also on step 20. Same step, same
    `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES` (5) exhausted, same outcome,
    on two independent occurrences of the same repro shape
    (full `connectors/` audit, provider `bai`).
  - **Timing is serial, not concurrent.** The `/api/agent-worker` POSTs
    for each run's retry sequence are spaced by single- to double-digit-
    second gaps, steadily increasing, no genuinely overlapping distinct
    invocation bursts -- consistent with one retry chain re-publishing
    after each failed attempt, not two invocations racing on the same
    `runId`+`afterStep`.
  - **The invocation-id log bodies themselves (commit `2aad526`)
    couldn't be directly read.** `Vercel:get_runtime_logs` only surfaces
    message body text for `error`/`warn`-level entries in this tool's
    output; `info`-level `console.log` lines (which is what the
    `agent-worker[<id>]: entry/exit ...` instrumentation uses) show only
    the request-summary line (timestamp/status/deployment), not stdout
    content, regardless of query text tried (`agent-worker[`, "entry",
    "heartbeat written", the full run_id as a query string, etc. all
    returned either the summary-only rows or nothing). This appears to
    be a limitation of what this tool surfaces for info-level logs on
    this project, not evidence the instrumentation isn't firing --
    combined with the earlier confirmation that commit `2aad526` is live
    on `main` and unit-tested, the simplest explanation is the logging
    is running but its body text isn't retrievable through this
    particular tool/view.
  - **Resuming the stalled run surfaced the actual proximate cause
    directly** (see the entry above this one): all 3 `BAI_API_KEYS`
    rate-limited (429) simultaneously at the failing step.

  Taken together -- identical dead-letter-after-5-failures pattern on
  both occurrences, serial (non-overlapping) retry timing, a confirmed
  sustained B.AI 429 as the trigger, and `agent_worker.js`'s own
  documented re-chain-with-fresh-heartbeat behavior on every
  failed-but-under-cap attempt -- this is now diagnosed with reasonable
  confidence as **hypothesis (3): the existing retry/re-chain mechanism
  working exactly as designed under sustained rate-limit pressure**, not
  (1) QStash-redelivery-after-death or (2) a concurrent-duplicate
  idempotency-guard gap. The original "self-recovery" (heartbeat age
  154s -> 59s) was never a recovery in the sense of the run succeeding --
  it was the retry chain continuing (each attempt resetting the
  heartbeat) right up until it exhausted the 5-attempt cap and finalized
  as `failed`. No evidence surfaced anywhere in this investigation of
  two invocation ids overlapping in time on the same `runId`+`afterStep`,
  which is what would be required to confirm (2). This is not a
  from-first-principles proof (the invocation-id body text remains
  unread), but it is enough to close this out as diagnosed rather than
  leave it open pending a tool that may not surface that detail anyway.

  **No code fix needed for the idempotency guard** -- (2) is not
  confirmed to be happening, so there's nothing there to patch. The
  B.AI-rate-limit angle is a separate, real operational concern (a
  long `bai`-provider audit can apparently exhaust all 3 rotation keys),
  but is out of scope for this ticket; noted as a candidate follow-up
  below rather than fixed here.

  **Follow-up: B.AI rate-limit resilience.** Two candidates were flagged
  for a separate look; the first is now resolved:
  - **RESOLVED (2026-09-01, `main`@`8eaf2d1`).** Confirmed the
    miscategorization was real, not hypothetical: `bai/client.js`'s
    `callChatCompletion` cascades through `BAI_API_KEYS` correctly
    per-attempt (each individual error keeps its real `.status`), but
    once every key is exhausted it threw a fresh aggregate
    `new Error(...)` with neither `.status` nor `.transient` set.
    `agent_delegate.js`'s `isTransientGeminiError()` reads exactly those
    two fields, so a run that died from all-keys-429'd (precisely the
    scenario diagnosed above) was told on resume "this does not look
    like a transient error ... check the underlying cause" -- actively
    wrong guidance for a wait-and-retry situation. Also confirmed the
    existing test suite didn't catch this: its one exhaustion test
    (`test/bai-client.test.js`, "throws the last error once all keys
    are exhausted") only asserted a `.message` substring, never
    inspected `.status`/`.transient`.
    Fix: each per-key attempt (including a `isModelCoolingDown` skip,
    itself always rate-limit-caused) is now tracked as transient or not
    (429/503/network-transient/cooldown-skip = transient; 401/403 =
    not), and the aggregate error is tagged `.transient = true` only if
    EVERY contributing attempt was transient -- a mixed failure (one
    key genuinely rate-limited, another simply bad/revoked) stays
    untagged, since a resume won't fix a bad key regardless of the rate
    limit clearing. New tests: all-429, mixed 429/503, mixed
    permanent+transient (asserts NOT tagged), all-cooldown-skip.
    First test-only commit (`3cd20e6`) briefly broke CI (`#1412`,
    `TypeError: [Function fetch] is not a spy or a call to a spy!` --
    the new cooldown-skip test asserted `global.fetch` was never called
    without first mocking it, so vitest correctly rejected the
    assertion once `afterEach` restored the real `fetch`); fixed by
    adding `global.fetch = vi.fn()` to that test (`3e4b699`), same
    pattern every other test in the file already uses. CI green on the
    client fix (`#1411`) and the corrected test commit (`#1413`).
  - Still open: whether `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES` (5) or
    the re-chain backoff spacing should account for B.AI's specific
    rate-limit behavior on long audits, given this reproduced twice on
    the same task shape. Not addressed by the fix above -- that only
    corrects the resume-worthiness signal, not the retry/backoff
    policy itself.

  **Gating the invocation-id logging: DONE.** Diagnosis criterion is
  met, so per the original plan the `console.log` calls in
  `agent_worker.js` are now wrapped behind a `DEBUG_AGENT_WORKER` env
  var (default off, same `!== "false"`-style pattern as
  `EDITOR_AGENT_ENABLED` in `config.js`) rather than left unconditional
  or deleted -- see `config.js` and `agent_worker.js` for the change.
  Kept rather than removed so it can be flipped back on quickly if a
  similar stall resurfaces and a future investigation gets access to a
  tool that can actually read the body text this time.
- `deleteCheckpoint`'s side-store GC is correct in isolation but never
  called anywhere in the production path (`agent_delegate.js`,
  `agent_worker.js`, `qstash_client.js`, `agent_tools.js`) — cleanup
  relies entirely on the 1hr Redis TTL. Undecided whether something
  should call it after a caller retrieves the final answer.
- Manual token-count validation of compaction vs. an uncompacted
  baseline still hasn't completed a run that survives long enough to
  produce a real comparison.

## Design constraints (apply to any future change in this area)

- Gemini/OpenAI-shaped chat APIs require strict role alternation and
  every `functionCall` paired with a `functionResponse` — never delete
  or reorder whole turns in `contents`; only edit part *content* in
  place.
- No mid-run eviction of verification data (`preCompactionResults` or
  equivalent) — a prior eviction attempt (`2eea726`) was reverted
  (`2e3bf54`) after it broke claim verification above a 200-entry cap.
  Don't reintroduce a cap.
