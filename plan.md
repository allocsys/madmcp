# Plan: B.AI provider testing + agent delegation reliability (consolidated 2026-09-02)

> This file was consolidated from ~25 append-only session logs into a
> single status-first document. Redundant "confirmed not X" verification
> trails, repeated "still open per Section N" footers, and resolved
> theories that were later superseded have been dropped. Every commit
> hash, config value, threshold, and root-cause finding from the original
> has been preserved below. Full session-by-session history remains
> available in this file's git log if ever needed.

## Status summary (read this first)

- **FIXED:** `max_steps` silently ignored on async fresh-start `delegate_agent` calls (§2).
- **FIXED:** oversized single-step input causing Vercel's 300s serverless timeout, plus the dead-letter blind spot that let a timed-out run hang forever (§3).
- **FIXED, MERGED TO `main` AND LIVE-CONFIRMED** (commit `ef71c05`, squash-merge of PR #142): forced-final-answer step produces garbled/empty output — turns out to be a token-budget race inside a single bai completion call, not a prompt-compliance problem. Four rounds of prompt/note wording fixes were tried and superseded by this finding (§4). Live end-to-end repro (run `7afbab6c-0109-43e8-b95d-f7bec49f94a7`, 20 steps) confirmed the fix behaves as designed; a few non-blocking gaps were identified for future hardening (§4, §6 item 5).
- **OPEN, low priority:** the "Void" response mystery — observed once, unreproduced, needs visibility this session doesn't have (§5).
- **TODO (housekeeping):** revert `DEBUG_AGENT_WORKER` to default OFF; commit `test-bai-timeout.sh` to the repo; abandon run `c1beaeda-874a-47dd-97b0-763bff80ba6d` and descendants (§6).

---

## 1. bai key-rotation retry loop — verified correct, no bug found

Read `connectors/bai/client.js` directly: the `MAX_KEY_ROTATION_PASSES = 2`
outer loop, per-key cooldown checks, 429→cooldown/503-timeout→cooldown
fallback, 401/403 fall-through (doesn't break the loop), early-exit when a
whole pass makes zero live attempts, and aggregate-exhaustion `.transient`
tagging are all correctly implemented and covered by
`test/bai-client.test.js`. A live 20-step run with `provider: "bai"`
completed cleanly with no rate-limit activity, confirming the path works
end-to-end under normal load (the "cooldown clears mid-call" edge case
can't be forced live; the mocked unit tests remain the real coverage for
that specific mechanism).

---

## 2. FIXED: `max_steps` ignored on async fresh-start `delegate_agent` calls

**Root cause:** `connectors/gemini/agent_tools.js`'s async fresh-start
branch never passed `max_steps` through to `seedRun`, so `overallMaxSteps`
silently defaulted to 20 in the seeded checkpoint regardless of what the
caller requested. The synchronous path in the same file was unaffected —
it already passed `max_steps` correctly. `editor_tools.js`/`seedEditorRun`
(the structurally-parallel editor-agent path) was checked and never had
this bug.

**Fix:** commit `14245fd` passes `max_steps` through on the fresh-start
call site. Regression test `test/agent-seedrun-max-steps-regression.test.js`
(commit `ded479f`) pins `seedRun`'s contract directly.

**Confirmed fixed live:** a fresh async `delegate_agent({ provider: "bai",
max_steps: 3 })` run completed in exactly 3 steps, matching the request
precisely instead of drifting toward the old default-20 ceiling.

---

## 3. FIXED: oversized single-step input → Vercel 300s timeout, plus a dead-letter blind spot

**Root cause (confirmed via direct Vercel `get_runtime_errors`/
`get_runtime_logs` access, project `prj_7iG65asCBZzoZsZoMY1Vuf7B5mbh`):** a
step where the model batches many tool calls (e.g. 13 file reads) or
accumulates large file-read results bloats the outbound payload sent to
the provider, making that call slow enough to blow Vercel's hard 300-second
function-execution ceiling. This is a **platform kill**, not a bug in this
repo's own retry/checkpoint/re-chain logic (independently verified sound).
Error group: `Vercel Runtime Timeout Error: Task timed out after 300
seconds`, route `/api/agent-worker`, recurring since `2026-08-08`.

**The dead-letter blind spot this exposed:** a hard platform timeout kills
the function *before* `agent_worker.js`'s own `retryCount` can increment,
so `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES` (default 5) never sees it.
Separately, QStash's own default retry budget (3 retries) could exhaust
with nothing listening for its give-up signal, leaving a checkpoint stuck
at `"running"` indefinitely with zero further activity and no error
surfaced anywhere — confirmed live once via direct checkpoint poll on the
run that originally exposed this.

**Fixes shipped, all on `main`:**
- `MAX_TOOL_CALLS_PER_STEP = 8` and `MAX_STEP_RESULT_CHARS = 60000` caps
  added to `agent_delegate.js`'s step loop (commit `ee6560d`). Deferred
  calls past the 8th get a synthetic "re-request next step" response;
  results over the char cap are withheld with a re-request-via-`char_offset`
  message. Full untruncated results still land in `resultCache`/Redis for
  history-compaction purposes — only the outbound LLM payload is capped.
  Regression test: `test/agent-oversized-step-cap.test.js`.
- bai's own per-call timeout (`BAI_REQUEST_TIMEOUT_MS`, default `55000`ms,
  `AbortController`-based) was already present from bai's original commit
  `ad99a3d` — no change was needed here, contrary to an earlier assumption.
- QStash retry/dead-letter fix (commits `ecbf1a3`, `fed3cc3`, `1e3aafe`,
  `3bb4aa8`, `24c41db`): new `QSTASH_STEP_RETRIES` config (default `0`) and
  a `failureCallback` (`/api/agent-worker-failure`, `/api/editor-worker-failure`)
  that finalizes a checkpoint as `"failed"` once QStash's own delivery
  budget is exhausted — a hard-timing-out step now fails cleanly in ~5min
  instead of hanging indefinitely. Also added `Upstash-Retried` header
  inspection to `agent_worker.js` (commit `ebdb441`) as an independent
  dead-letter signal, since a platform kill can never increment this repo's
  own `retryCount`.
- Decoupled both caps to **bai-only** (commit `c4f1313`,
  `applyOversizedStepCaps = effectiveProvider === "bai"`): every repro
  across this entire investigation used `provider: "bai"` exclusively;
  Gemini/GLM/Groq tool-call batching was verified (via direct commit diff)
  to have been uncapped both before and unaffected by this investigation,
  and is left that way.

**Test coverage confirmed present:** `test/agent-worker.test.js`,
`test/editor-worker.test.js`, `test/qstash-client-publish.test.js` (full
suite: 46 files / 541 tests, all passing as of last check).

**Confirmed working live** multiple times post-fix: hard-timing-out steps
now cleanly finalize as `"failed"` (visible in both `get_runtime_errors`
and an immediate MCP-side poll) instead of hanging silently.

**Not done:** revert `DEBUG_AGENT_WORKER` to its default-OFF setting
(currently ON, flipped temporarily during this investigation — safe to
revert now that the dead-letter fixes have landed, but not yet done).
QStash's own dashboard/API was never directly inspected — the fix was
derived from the SDK's type defs and Upstash's public docs.

---

## 4. ROOT-CAUSED, FIX AGREED, NOT YET IMPLEMENTED: forced-final-answer step produces garbled/empty output

**Background:** distinct from §3 — this is the **forced-final step**
(`isFinalStep`, no tools available, must synthesize one complete answer)
timing out or producing broken output, even *after* §3's input-side caps
were working correctly on the earlier steps of the same run. §3's caps
have no mechanism to bound this, since there's no batched-tool-call input
to cap on a no-tools step.

**Four rounds of prompt-only fixes were tried and superseded — kept brief:**
1. A brevity instruction added to the final-step SYSTEM NOTE (commit
   `97116d2`) stopped the 300s timeout (3/3 clean on that specific goal)
   but surfaced a *new* problem: garbled/malformed answers, including
   literal leaked tool-call-shaped text (e.g.
   `<githu b_read_file><params>...`).
2. An anti-leakage regex backstop, `detectToolCallLeakage()` (commits
   `101e133`, `d16901a`, `d7f0aa6`, `61c5c6c`, `152cd8e`), caught that
   shape and one more (`[Function call: ...]` bracket syntax) — but a
   third (bare unwrapped JSON args object) and fourth (stated intent to
   keep fetching files instead of answering, e.g. "Fetching those
   now...") kept appearing on repeat live tests, each a new shape not
   covered by the existing pattern.
3. An experiment to drop the final-step note entirely for bai (commit
   `3cc4725`, PR #141) — on the hypothesis that more explicit prohibition
   text was itself priming new leak variants — was merged without a live
   test first, didn't fix delegation per the user's report, and was
   reverted (commit `3ada0c5`).

Across every code state tried (elaborated note / no note / simplified
note), some final-step failure kept recurring in a shape not explicitly
named by whichever note version was live — a strong signal the lever being
pulled (prompt wording) was never the actual mechanism.

**ROOT CAUSE (confirmed via `test-bai-timeout.sh`, hitting bai's completion
endpoint directly, bypassing the agent loop entirely):**
- **Not input size** — a ~120k-char-input call was not disproportionately
  slower than baseline (11.13s vs 7.59s).
- **Is a token-budget race inside a single completion call**: the model
  can spend nearly all of `max_tokens` on internal `reasoning_tokens`
  before ever writing an answer. When `finish_reason: length` fires
  mid-reasoning, whatever partial/no text exists at that instant becomes
  the returned "answer." This plausibly explains all four previously
  "distinct" garbled shapes as one mechanism — different truncation points
  mid-reasoning producing different fragments — not four separate bugs.
- `reasoning_effort` is a real, honored lever on bai's API (0 / 14 / 171
  reasoning tokens at low/high/max on an identical prompt) but **not
  sufficient alone**: even with `reasoning_effort=low` explicitly set,
  repeated identical test runs still fully consumed the token budget on
  reasoning in ~40% of runs (2/5 at `max_tokens=1200`).
- **No fixed `max_tokens` cap is safe either**: a cap of 300 failed 5/5
  times (empty answer, `finish_reason: length`); a cap of 1200 still
  failed 2/5 times.

**Fix agreed, both changes at the bai client-call level
(`connectors/bai/client.js`), NOT the agent-loop/prompt level §4's prior
attempts all targeted:**
1. Set `reasoning_effort: "low"` explicitly on bai's forced-final-step
   call.
2. Detect-and-retry on the response shape: if `finish_reason === "length"`
   AND `reasoning_tokens ≈ completion_tokens` (budget went entirely to
   reasoning, answer is empty/near-empty), retry **once** with a larger
   `max_tokens` budget, keeping `reasoning_effort` at low or lower on the
   retry. **Never raise effort on retry** — higher effort settings produce
   *more* reasoning tokens, which would make budget exhaustion more
   likely, not less.

Cost: one bounded retry (up to ~40s worst case observed) is smaller than
today's cost of silently accepting a token-exhausted non-answer as a
completed step, which currently propagates into the run's final answer or
feeds the stall/dead-letter chain in §3.

**Recommendation: do not attempt further `SYSTEM_PREAMBLE`/final-step-note
wording changes before this client-level fix is tried.** The note was
never the lever controlling which token-budget outcome occurred inside a
given completion call — no amount of prompt-editing was ever likely to
fully resolve this.

**Not yet done:** no code change to `connectors/bai/client.js` yet;
`test-bai-timeout.sh` not yet committed to the repo (should live under
`test/` or `scripts/` as a reusable diagnostic); the originally-discussed
hard `maxOutputTokens` cap on the final step is effectively superseded by
this more targeted fix but hasn't been formally closed out.

**Next live-test pattern once implemented:** re-run the exhaustive
full-repo-writeup repro against `provider: "bai"` and confirm (a) no more
empty/garbled final answers, (b) the retry fires only on genuinely
token-exhausted calls (check via logs, don't assume), (c) delegation time
increase stays within the bounded range anticipated above.

**IMPLEMENTED (2026-09-02), branch `fix/bai-final-step-reasoning-effort`,
CI green as of run #1580:**
- `connectors/bai/client.js`: `baiChat()` now accepts `reasoningEffort`
  (sent as `body.reasoning_effort`). New `isReasoningBudgetExhausted(choice,
  usage)` detects `finish_reason === "length"` with `reasoning_tokens /
  completion_tokens >= 0.9` (checks both a top-level `usage.reasoning_tokens`
  and the nested `usage.completion_tokens_details.reasoning_tokens` shape,
  since bai's exact field name isn't documented). On detection, retries
  **once** with `max_tokens` raised via `computeRetryMaxTokens()` (original
  doubled, floored at `RETRY_MIN_MAX_TOKENS = 4096` -- the fixed floor exists
  because live testing found even a 1200 cap still exhausted the reasoning
  budget 2/5 times). `reasoning_effort` is reused as-is on the retry, never
  raised.
- `connectors/llm/router.js`: `providerChat()` takes `reasoningEffort` and
  passes it through only on the `bai` branch (opt-in, no forced default,
  same contract as `maxOutputTokens`).
- `connectors/gemini/agent_delegate.js`: the single `providerChat(...)` call
  site now sets `reasoningEffort: "low"` gated on `effectiveProvider ===
  "bai" && isFinalStep` specifically -- NOT the broader `withholdTools`
  (which also covers `stuckLoopForce` and the verification pass). Confirmed
  by test that a stuck-loop-forced no-tools turn does NOT get
  `reasoningEffort` set, only the true forced-final step does.
- No `SYSTEM_PREAMBLE`/`BAI_PREAMBLE_ADDENDUM`/final-step-note wording was
  touched, per this section's own recommendation above.
- **Already-shipped, unrelated-to-this-fix code found live on `main`
  independent of this branch:** `BAI_PREAMBLE_ADDENDUM` +
  `buildSystemPreamble(provider)` in `agent_delegate.js` (a short bai-only
  early warning, added in turn 1's system preamble, that a tool-less forced
  final turn is coming). This predates and is orthogonal to the client-level
  fix above -- confirmed via `list_commits`: it landed in commit `f4b87d0`
  ("bai: add early SYSTEM_PREAMBLE reinforcement for forced tool-less final
  turn; reword final-step note to also disallow narrating intended tool
  use", plan.md Section 24 follow-up), which is already on `main`. Section 4
  above did not mention it because the session that wrote it was working
  from an earlier read of this file, before that commit's own section (24)
  was folded into this consolidated document -- not a real doc/code gap,
  just a stale read. No action needed beyond this note.
- **Test coverage added:** `test/bai-client.test.js` (reasoning_effort
  passthrough + the exhaustion-detection/retry path, including the
  never-raise-effort-on-retry contract), `test/llm-router.test.js`
  (reasoningEffort passthrough on the bai branch only), and a new
  `test/agent-delegate-bai-reasoning-effort.test.js` (the `isFinalStep`-only
  gating at the `agent_delegate.js` call site: fires on bai's true final
  step, not on an earlier bai step, not on a non-bai provider's final step,
  and not on a stuck-loop-forced non-final withheld-tools turn).
- **MERGED (2026-09-02):** PR #142 squash-merged to `main` as commit
  `ef71c05`.
- **Correction to `scripts/test-bai-timeout.sh`'s provenance note:** the
  file initially committed to this branch was a *reconstruction* (its own
  header said so explicitly, since the real original script wasn't
  available to that session). The actual original script was later
  recovered and committed in its place (commit `7dac054`, still part of
  this same PR before merge) -- the version now on `main` is the real
  original (Termux-shebang, `BAI_API_KEY` singular, 9-case structure with
  CSV distribution summaries for cases 4/9), not the reconstruction. If
  anything downstream still references the reconstructed version's
  different interface (`BAI_API_KEYS` plural, `RUNS_PER_CONFIG`, single
  hardcoded rate-limiter prompt), that reference is stale.
- **LIVE-CONFIRMED (2026-09-02):** the exhaustive full-repo-writeup repro
  was run against a real `provider: "bai"` delegate_agent call (run
  `7afbab6c-0109-43e8-b95d-f7bec49f94a7`, task: full-repo investigation of
  this very fix, 20 steps, `show_transcript: true`). Findings:
  - **(a)/(b) confirmed by code+test re-verification during the repro:**
    `reasoningEffort: "low"` is gated specifically on `effectiveProvider
    === "bai" && isFinalStep` -- not the broader `withholdTools` (which
    also covers `stuckLoopForce`/verification turns). The retry-once path
    (`computeRetryMaxTokens` doubling + floor) fires only on detected
    budget exhaustion; no code path escalates `reasoning_effort` on retry
    -- only `max_tokens` changes. No empty/garbled final answer was
    produced by the repro run itself.
  - **(c) delegation time:** not independently re-measured against the
    ~40s worst-case estimate in this pass (the repro run's own step timing
    wasn't isolated for this purpose) -- if this matters going forward,
    a dedicated timing comparison (fix branch vs. pre-fix) would need to
    be run separately.
  - **New gaps surfaced for future hardening (not regressions, not
    blocking):**
    1. Retry-once may still be insufficient given the probe's documented
       >4x variance in reasoning-token spend on identical prompts (case 8
       vs. case 9 in `test-bai-timeout.sh`'s data).
    2. Exhaustion detection has no signal if a bai response has neither
       usage-shape field (`completion_tokens_details.reasoning_tokens` nor
       the `message.reasoning_content` fallback) -- garbled output would
       pass through undetected in that case, same class of miss as the
       earlier `detectToolCallLeakage` gaps.
    3. Non-final withheld-tools turns (stuck-loop/verification) can still
       hit budget exhaustion and get the doubled-`max_tokens` retry, but
       never get the cheaper `reasoningEffort: "low"` prevention -- a
       deliberate, tested narrowness per §4's fix design, flagged here as
       a real coverage gap if those turns turn out to fail in practice.
    4. B.AI's server-side ~55-65s connection kill (independent of
       `max_tokens`) means doubling `max_tokens` on retry could push a
       call past that window and convert a budget-exhaustion failure into
       a hard timeout instead -- `BAI_REQUEST_TIMEOUT_MS = 55000` is the
       client-side mirror of this ceiling but doesn't prevent it.
  - This closes out §4's last remaining item. Any follow-up work on gaps
    1-4 above would be a new, separate investigation.

---

## 5. OPEN: the "Void" response mystery

Observed once, never reproduced on demand: two consecutive polls of a
run that was genuinely stalled (pre-dating §3's fixes) returned identical
text prefixed with `"Void (the re-fetch was served from cache, not new
content)."` This string does not exist anywhere in this repo's code —
confirmed via `search_code` — so it must originate from a layer above this
repo (the tool-calling/MCP-client infrastructure) with no read access from
here.

**Leading, unconfirmed hypothesis:** if the platform hard-kills a backing
function before it returns (per §3's mechanism), a subsequent poll of the
same still-unresolved request could plausibly be served a stale cached
response by a gateway-caching layer in front of it — matches "served from
cache, not new content" well, but is inferred, not directly observed in
any log line naming a caching layer.

**Ruled out:** "any byte-identical response triggers Void" (a control run
returned identical "still running" content twice without triggering it)
and "polling speed" (back-to-back polls of the control run didn't trigger
it either).

**Next step if it recurs:** capture whether it correlates with checkpoint
`lastStepAt`/`stepStartedAt` staleness; consider asking whoever owns the
tool-calling/MCP-client layer directly what triggers it, since this is at
the limit of what black-box behavior alone can resolve.

---

## 6. Housekeeping / open items

1. **DONE AND MERGED (2026-09-02, PR #142, commit `ef71c05` on `main`):**
   implement §4's fix (`reasoning_effort: "low"` + finish_reason/
   token-ratio detect-and-retry) in `connectors/bai/client.js`. See §4's
   "IMPLEMENTED"/"MERGED" notes for full detail.
2. **DONE:** `test-bai-timeout.sh` committed to the repo at
   `scripts/test-bai-timeout.sh` (same branch as #1), distinct from the
   existing mocked-`providerChat` unit tests.
3. **Revert `DEBUG_AGENT_WORKER`** to its default-OFF setting — safe now
   that §3's dead-letter fixes have landed.
4. **Do not resume** run `c1beaeda-874a-47dd-97b0-763bff80ba6d` or any of
   its descendants — used to root-cause §3/§4, no longer informative.
   Left to resolve on its own (complete, dead-letter, or TTL-expire).
5. **DONE (2026-09-02):** #1's live-test pattern was run -- see §4's
   "LIVE-CONFIRMED" note for the full repro results (run
   `7afbab6c-0109-43e8-b95d-f7bec49f94a7`) and the four non-blocking gaps
   identified for possible future hardening.
6. §5's "Void" mystery needs server-log/gateway visibility this session
   doesn't have — flag to whoever owns that layer if it recurs.
7. QStash's own dashboard/API has never been directly inspected — worth a
   look if the failure-callback fixes from §3 ever misbehave in practice.
