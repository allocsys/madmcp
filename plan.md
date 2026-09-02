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
- **DONE, CONFIRMED-SAFE:** §3's `MAX_STEP_RESULT_CHARS` raised 60000 → 100000 (PR #143, commit `628d1f7`); live-timing-tested against real Vercel invocation logs, gaps ~5–9% of the 300s ceiling, no revert needed (§6 item 9).
- **CONFIRMED UNSAFE (2026-09-02):** follow-up raise 100000 → 300000 for `MAX_STEP_RESULT_CHARS`, PR #144 squash-merged to `main` as commit `ef66382`, is live but should NOT be treated as safe. A real, timestamped `Vercel Runtime Timeout Error: Task timed out after 300 seconds` was confirmed via direct log query (not inferred from a QStash error string) against the exact deployment running this code, tied to the specific run (`e7cace87-72c1-453c-84d6-230f0bf2063a`) that cleared the cap. See §6 item 9's follow-up sub-entry for full detail. Recommended next step: back off to 200000 and live-test that the same way 100000 was validated, OR revert to the confirmed-safe 100000 floor.
- **DONE (2026-09-02):** raised the *separate* per-call `char_limit` ceiling inside `sliceFileContentForModel` (`connectors/gemini/agent_delegate.js`) from 100000 → 200000, commit `b025675`, pushed directly to `main` (repo owner's explicit instruction, no PR/test-first this time). **This is a different knob from `MAX_STEP_RESULT_CHARS`** — it governs how much of a single large file one `github_read_file`/`github_get_file_at_commit` call can return, not the aggregate step-1 payload cap. Explicitly flagged to the repo owner before making the change: this raise makes it *easier* to clear the still-unsafe 300000 `MAX_STEP_RESULT_CHARS` ceiling in fewer calls (e.g. one call can now return all 167,329 chars of `agent_delegate.js` instead of needing two 100k-capped reads to assemble the full file) — it increases the odds of retriggering the confirmed timeout above, not decreases them. No live test run against this change yet.
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
8. **DONE (2026-09-02):** follow-up live test -- deliberately over-scoped
   `delegate_agent({ provider: "bai", max_steps: 3 })` task (read 5 large
   files in full + cross-reference against ~10 test files -- far beyond a
   3-step budget) to confirm graceful step-budget exhaustion. Run
   `b64e7640-e39b-4939-88b2-b5234e3052d8`. Result: the loop correctly
   stopped at exactly 3 steps (no drift past the caller-set ceiling), and
   the final answer explicitly and accurately reported incomplete coverage
   -- per-file granularity (fully read / partially read / entirely unread),
   an honest zero on test cross-referencing, and a correct call-out of the
   `MAX_STEP_RESULT_CHARS` 60k per-step cap (§3) as the specific mechanism
   that withheld the `editor_delegate.js` read mid-step-2 -- rather than
   fabricating or silently truncating content for the unread portions.
   Confirms the forced-final-step fix (§4) doesn't just avoid garbled
   output on genuine token-budget exhaustion; step-budget exhaustion
   (a different, caller-controlled limit) is also handled honestly.
6. §5's "Void" mystery needs server-log/gateway visibility this session
   doesn't have — flag to whoever owns that layer if it recurs.
7. QStash's own dashboard/API has never been directly inspected — worth a
   look if the failure-callback fixes from §3 ever misbehave in practice.
9. **DONE, CONFIRMED-SAFE (2026-09-02):**
   §3's `MAX_STEP_RESULT_CHARS` cap raised from 60000 to 100000, to reduce
   how often bai needs a `char_offset` re-request to see a full large file.
   PR #143 squash-merged to `main` as commit `628d1f7` (source branch
   `test/raise-max-step-result-chars-100k`, `b442ddf`). CI green on both
   the push run (#1585) and the PR run (#1586) before merge.
   Explicitly not the same fix as §4's `reasoningEffort`/retry change —
   §4 only gates the forced-final-step (`isFinalStep`) OUTPUT-generation
   call; `MAX_STEP_RESULT_CHARS` bounds a normal mid-run step's INPUT
   payload size (a bloated `contents` history making the *next*
   `providerChat` call slow enough to risk Vercel's 300s ceiling — §3's
   original root cause).

   **Live timing test run (2026-09-02), run `5680e1f8-d994-4fa2-a184-8fb720dbe0f4`:**
   a real `delegate_agent({ provider: "bai", max_steps: 3 })` call was given
   a task requiring five real repo files (including a 166,873-char file) to
   be batch-read in a single step, to force the aggregate step-result cap
   to actually engage. Per the transcript, it did engage — `connectors/github/tools.js`
   was truncated by the combined-result cap on the first pass and had to be
   fully re-read on the next step, confirming this wasn't just a
   near-miss but a genuine trip of the 100000-char ceiling. Actual
   `/api/agent-worker` invocation timestamps pulled directly from Vercel
   runtime logs (project `prj_7iG65asCBZzoZsZoMY1Vuf7B5mbh`, not inferred
   from MCP-side polling):
   - `afterStep=0` (executes the 5 batched reads): started 19:09:56
   - `afterStep=1` (**the at-risk call** — receives the ~100k-char step-1
     payload, calls `providerChat`, executes step 2): started 19:10:11
     — **15s** after the prior invocation started
   - `afterStep=2` (finalizes, produces the answer): started 19:10:37
     — **26s** after the at-risk invocation started

   Both gaps (invocation runtime + QStash chaining latency, an upper bound
   on the true function duration) are ~5–9% of Vercel's 300s hard ceiling.
   `get_runtime_errors` for the same window: zero errors.

   **Verdict: comfortably clear.** No revert needed. This closed out §6
   item 9's original scope — the 100000 cap is confirmed-safe against the
   original §3 risk, not just passing on mocked unit tests.

   **FOLLOW-UP (2026-09-02), 100000 -> 300000, IN PROGRESS / BLOCKED:**
   Handoff instructions asked for a further raise to 300000, live-tested
   *before* merge this time (the 100k rollout above was tested after merge,
   which the handoff flagged as the wrong order).

   - **Code change:** `MAX_STEP_RESULT_CHARS` 100000 -> 300000 in
     `connectors/gemini/agent_delegate.js`, branch
     `test/raise-max-step-result-chars-300k`, commit `80da8b7`.
   - **Test-fixture bug found and fixed (two attempts):** the handoff
     assumed `test/agent-oversized-step-cap.test.js` needed no changes
     since it imports `MAX_STEP_RESULT_CHARS` dynamically -- true for the
     *cap value*, but the fixture's ability to produce enough aggregate
     payload to actually trip that cap does NOT scale automatically.
     - First CI run (#1588) failed outright: pushed the code change before
       updating the test file at all.
     - First fix attempt (commit `b422b3c`, bumping mock file content from
       40,000 to 90,000 chars) was itself wrong and still failed CI (run
       #1589: `expected 150810 to be greater than 299000`). Root cause:
       the test's mocked `github_read_file` calls carried no explicit
       `char_limit` in their args, so `sliceFileContentForModel`'s
       no-offset/no-limit branch silently capped every call at its own
       hardcoded 30,000-char default regardless of how large the
       underlying mock content was -- 5 calls x ~30,150 chars (30000 +
       header) = ~150,810, matching the CI failure exactly, well under a
       300,000 cap no matter what the raw mock size is.
     - Real fix (commit `39a0614`): each call's args now explicitly pass
       `char_limit: PER_CALL_CHAR_LIMIT` (100000 -- `sliceFileContentForModel`'s
       own ceiling via `Math.min(char_limit, 100000)`, so this is the most
       any single call can ever return). Mock content raised to 150,000
       chars/file so it's never itself the limiting factor. Added a
       fail-loud guard (`callCount * PER_CALL_CHAR_LIMIT` must clear
       `MAX_STEP_RESULT_CHARS * 1.2`) so a future cap raise that outgrows
       what `(MAX_TOOL_CALLS_PER_STEP - 1) * 100000` chars can produce
       throws a clear error instead of silently degrading into a no-op
       test again. CI green on run #1590.
   - **PR opened, NOT merged:** #144
     (https://github.com/allocsys/madmcp/pull/144), base `main`, head
     `test/raise-max-step-result-chars-300k`.
   - **BLOCKED: the live-timing test itself could not be run this
     session.** Two structural problems, not attempted-and-failed --
     flagging honestly rather than fabricating results:
     1. No Vercel runtime-logs tool was available in this session's
        toolset (searched via `tool_search` for "vercel runtime logs
        deployment", "vercel deployment project logs", and
        "get_runtime_logs get_runtime_errors" -- none returned a matching
        tool). The prior session's §6 item 9 writeup above used a
        `get_runtime_logs` tool against project
        `prj_7iG65asCBZzoZsZoMY1Vuf7B5mbh` that this session does not have
        access to, for reasons not visible from here (toolset
        configuration change, permissions, or something else).
     2. Even with that tool available, `delegate_agent` calls hit
        whatever's actually deployed (built from `main`), not this PR's
        branch -- so a live call made before merging would exercise the
        *old* 100000 cap, not the 300000 change under test. The handoff's
        own "(on the branch (or after a preview deploy))" phrasing
        suggests this was anticipated as a possible gap, but no tool here
        exposes a way to target a specific preview deployment by URL.
   - **Decision (2026-09-02):** repo owner explicitly authorized option
     (c) above -- accept the same test-after-merge order used for the
     100k rollout, given the headroom evidence already collected (bai
     context window, Redis limits, QStash message size -- see this
     section's earlier entries). **PR #144 squash-merged to `main` as
     commit `ef66382`.** `MAX_STEP_RESULT_CHARS = 300000` is now live in
     production.
   - **STILL OPEN, AND NEW CONCERNING EVIDENCE (2026-09-02, this
     session):** this session *does* have the Vercel log tools
     (`get_runtime_logs`, `get_runtime_errors`, `get_deployment_build_logs`
     all loaded fine via `tool_search`) -- a different toolset gap than
     the prior session hit. But every call against
     `prj_7iG65asCBZzoZsZoMY1Vuf7B5mbh` / `team_LyeppGZMAygFDwBK8CuNZOWx`
     (`get_runtime_logs`, `get_runtime_errors`, even a plain `get_project`
     and `list_projects`) returned **403 Forbidden** -- "You don't have
     permission to access this resource." Different blocker than last
     time (tool present, credentials rejected for this specific
     team/project) -- worth flagging to whoever manages this session's
     Vercel auth/scopes, since this is now blocked two sessions running
     for two different reasons.

     Without log access, exact invocation timestamps couldn't be pulled.
     Two live `delegate_agent({ provider: "bai", max_steps: 3 })` runs
     were still made, forcing step 1's aggregate payload up via batched
     `github_read_file` calls with explicit `char_limit: 100000` each:
     - Run `68895fa5-9584-4d08-b1e5-ffef7e239361`: 7 files/reads,
       aggregate 294,455 chars -- landed just *under* the 300000 cap.
       Completed cleanly in 2 steps (expected -- cap never engaged).
     - Run `e7cace87-72c1-453c-84d6-230f0bf2063a`: 8 files/reads (added
       `connectors/github/search.js`), aggregate 310,831 chars --
       clearing the cap. Step 1 completed normally (all 8 reads returned
       in full at the read layer, as expected -- `MAX_STEP_RESULT_CHARS`
       bounds what's sent to `providerChat`, not what `github_read_file`
       itself returns). **Step 2 -- the at-risk call that absorbs that
       ~310k-char step-1 result into the next `providerChat` call --
       never completed.** The run first showed as stalled ("no activity
       in 133s"), and a synchronous resume attempt then failed outright:
       "QStash exhausted its own delivery budget (retried ?/0) on step 2
       without ever getting a response -- almost always a
       platform-level execution timeout repeating on the same oversized
       step." The §3 dead-letter fix worked as designed (finalized
       cleanly as `"failed"` instead of hanging forever), but the
       underlying event -- repeated non-response on step 2, every QStash
       delivery attempt -- is exactly the failure mode §3/§6-item-9 exist
       to keep *out* of the 300s danger zone, not a borderline timing
       result.

     **This is not confirmed-safe, and the honest read leans toward the
     opposite: the one run that actually cleared 300000 chars failed to
     complete step 2 at all, on every delivery attempt.** Caveats worth
     naming rather than glossing over: (a) single data point, not a
     repeated/averaged result like the 100k test had; (b) without Vercel
     logs there's no direct confirmation this was specifically a 300s
     *timeout* vs. some other step-2 failure mode -- that's the tool's
     own inferred error text, not something independently verified this
     session; (c) step 1 was already at the `MAX_TOOL_CALLS_PER_STEP = 8`
     ceiling, a co-occurring boundary condition worth noting though not
     obviously causal. None of that is reason to wave this off, though.
     **Recommend against declaring 300000 confirmed-safe on this
     session's evidence, and recommend seriously weighing the handoff's
     own fallback -- back off toward 200000, with 100000 as the
     already-confirmed-safe floor -- rather than running further live
     tests against production traffic until Vercel log access is
     restored and the failure can be root-caused against real
     timestamps instead of an inferred QStash error string.**

   **RESOLVED (2026-09-02, next session): Vercel log access restored, failure ROOT-CAUSED AND CONFIRMED REAL -- NOT SAFE, back off recommended.**

   This session's toolset had working `get_runtime_logs`/`get_runtime_errors`
   access against `prj_7iG65asCBZzoZsZoMY1Vuf7B5mbh` / `team_LyeppGZMAygFDwBK8CuNZOWx`
   -- no 403, first call succeeded. `get_runtime_errors` (since: "1h") returned:

   - `Vercel Runtime Timeout Error: Task timed out after 300 seconds` --
     count=2, route `/`, `first=2026-08-08T11:54:37Z`,
     `last=2026-09-02T19:53:27Z`.
   - `agent-worker-failure: runId e7cace87-72c1-453c-84d6-230f0bf2063a
     dead-lettered via QStash failureCallback (retried=undefined,
     maxRetries=0) on step 2` -- count=1, `2026-09-02T19:56:10Z`.

   The timeout error's `last` timestamp (19:53:27) lands ~3 minutes before
   the dead-letter callback fired for run `e7cace87` (19:56:10) -- the gap
   is consistent with QStash's own retry/give-up delay after the
   underlying invocation was already killed by Vercel's 300s ceiling, not
   a coincidence. **This confirms the prior session's cautious read was
   correct and not overcautious: run `e7cace87`'s step-2 stall genuinely
   was Vercel's hard 300-second timeout**, not merely QStash's own
   inferred error text as the only evidence.

   A second, smaller live run this session (`d926e567-a406-4379-8ce8-a57f4169137d`,
   3 files, explicit `char_limit: 100000` each) completed cleanly in 2
   steps with no issue -- but its aggregate payload (166,307 chars) never
   actually cleared the 300000 cap, so it is **not** evidence of safety at
   300k; it simply didn't test the boundary. No further live attempts to
   clear the 300000 cap were made this session, since real, timestamped
   confirmation of a genuine 300s production timeout at that cap already
   exists above -- repeating the test against production traffic to
   "re-confirm" a failure already confirmed by real logs isn't warranted.

   **Verdict: 300000 is CONFIRMED UNSAFE, not merely unconfirmed.**
   Recommend a follow-up session (or this repo's owner) revert
   `MAX_STEP_RESULT_CHARS` to 200000 (untested but smaller than the
   failure point and above the confirmed-safe 100000 floor) or back to
   the confirmed-safe 100000, and live-test 200000 the same way the 100k
   raise was tested before calling it safe. This edit only updates
   `plan.md`'s record -- no code change was made this session.

   **FOLLOW-UP (2026-09-02, next session), 300000 -> 270000, IMPLEMENTED AND MERGED, LIVE-TIMING TEST STILL OUTSTANDING:**

   - **Decision:** go straight to 270000 rather than testing 200000 first.
     Rationale: two clean confirmed failures at 300000 and zero data points
     anywhere between the confirmed-safe 100000 floor and the
     confirmed-unsafe 300000 ceiling give little reason to assume 200000
     needs testing before 270000 doesn't -- either way an untested value
     needs live validation before being trusted, so pick the value closer
     to the original target and validate that one instead.
   - **Code change:** `MAX_STEP_RESULT_CHARS` 300000 -> 270000 in
     `connectors/gemini/agent_delegate.js`, branch
     `test/lower-max-step-result-chars-270k`, commit `49815a3`. The
     constant's inline comment was rewritten to record the confirmed-unsafe
     finding at 300000 and the 270000 decision above (superseding the old
     "TESTING" comment that still described 300000 as unconfirmed).
   - **Test fixture:** `test/agent-oversized-step-cap.test.js` needed no
     changes -- verified this session, not just assumed per the handoff:
     it imports `MAX_STEP_RESULT_CHARS`/`MAX_TOOL_CALLS_PER_STEP`
     dynamically, `callCount = MAX_TOOL_CALLS_PER_STEP - 3 = 5`, and the
     fail-loud guard (`callCount * PER_CALL_CHAR_LIMIT` must clear
     `MAX_STEP_RESULT_CHARS * 1.2`) still passes comfortably at 270000
     (500000 > 324000). CI confirmed green on the branch push (run #1594)
     before merging, per the handoff's test-before-merge instruction.
   - **PR opened and merged:** #145
     (https://github.com/allocsys/madmcp/pull/145), base `main`, head
     `test/lower-max-step-result-chars-270k`, squash-merged as commit
     `d023a5c`. `MAX_STEP_RESULT_CHARS = 270000` is now live on `main`.
   - **LIVE-TIMING VALIDATION NOW DONE (2026-09-02, same session as the
     merge), CONFIRMED SAFE:** Vercel log access (`get_runtime_logs`,
     `get_runtime_errors`) turned out to be available after all via a
     differently-scoped tool search than the one that came up empty
     earlier this session -- worth remembering for future sessions that
     hit an apparent tool-access gap: retry the search before concluding
     the tool genuinely isn't there.

     Two independent live `delegate_agent({provider: "bai", max_steps: 3})`
     runs were made, each batching 8 `github_read_file` calls (two
     paginated reads of `agent_delegate.js` covering its full 167,939
     chars, plus 6 other real repo files) with explicit `char_limit: 100000`
     per call, aggregate ~305,672 chars -- comfortably past the 270000 cap
     so it would genuinely engage, not just graze it (an earlier same-session
     attempt at this test picked smaller files by mistake, landed at only
     186,254 chars aggregate, and never tripped the cap at all -- a sizing
     miss worth noting so a future session doesn't repeat it; the two runs
     below are the corrected version).

     - Run `9afeb4f4-ae64-40f3-b00c-50ad697473d3`: cap engaged as designed
       (6/8 calls returned in full, 1 truncated mid-file, 1 withheld
       entirely -- aggregate clamped at 270000). Real `/api/agent-worker`
       invocation timestamps from Vercel runtime logs:
       `afterStep=0` (executes the 8 batched reads): started 20:55:28
       `afterStep=1` (**the at-risk call** -- absorbs the ~270k-char
       step-1 payload into `providerChat`, executes step 2): started
       20:55:47 -- **19s** after the prior invocation started.
       `runInvestigation returned steps=2 failed=false`, `exit status=done`.
     - Run `dcac8f6e-1f9e-489a-82fe-3f82e46a1c27` (second repro, same
       methodology): cap engaged identically (5/8 full, 1 truncated, 2
       withheld). Timestamps: `afterStep=0` started 21:00:00,
       `afterStep=1` (at-risk call) started 21:00:19 -- **19s** again,
       identical gap to the first run. `steps=2 failed=false`,
       `exit status=done`.

     Both runs: 19s gap, ~6.3% of Vercel's 300s ceiling -- same range as
     the confirmed-safe 100000 validation (15-26s gaps). `get_runtime_errors`
     (`since: 1h`) shows no new error groups from either run -- the only
     entries present are the pre-existing `aa81ada5`/`e7cace87` timeout and
     dead-letter records from the earlier confirmed-unsafe-300000 finding,
     unchanged.

     **Verdict: 270000 is CONFIRMED SAFE.** Two independent repro runs,
     both with real Vercel timestamps (not inferred from QStash error
     text), both landing at the same 19s gap, both comfortably clear of
     the 300s ceiling, zero new runtime errors. This closes out the
     live-timing validation the handoff's step 3/4 called for. No further
     action needed on this constant unless future evidence surfaces a
     problem at 270000 specifically.

     **BONUS COMBO TEST (2026-09-02, same session): §3's payload cap AND
     §4's forced-final-step path exercised together in one run, clean
     pass.** Same 8-call ~305,672-char batch as above, but with
     `max_steps: 2` instead of 3 -- this makes step 2 (the call absorbing
     the ~270k-char step-1 payload) *also* the forced-final step
     (`isFinalStep`, tools withheld, `reasoningEffort: "low"` gated in per
     §4), stacking both guardrails' load in a single call instead of
     testing them separately. Run `af817175-da11-4435-8a75-3c78dceb9a27`:
     completed in 2 steps, `failed=false`. The forced-final answer was
     accurate and honest, not garbled -- it correctly itemized which of
     the 8 files arrived in full (5), which was truncated mid-file (1,
     `designer_delegate.js`), which were withheld entirely (2,
     `editor_tool_functions.js`/`files.js`), reconstructed the exact
     cap-accounting arithmetic (240,860 chars from the first 5 calls,
     leaving ~29,140 of the 270,000 budget for the 6th call's partial
     slice), and explicitly declined to guess at the withheld files'
     contents rather than fabricating. No leaked tool-call syntax, no
     empty/truncated-mid-reasoning answer -- exactly the behavior §4's
     fix was designed to produce under combined load. This step did take
     noticeably longer than the two solo-cap-test runs above (multiple
     polls over ~2+ minutes before returning, vs. single-poll returns
     before) -- not flagged as a problem (well within the 300s ceiling,
     no timeout/error surfaced), but worth noting as a real cost of
     stacking both mechanisms in one call, in case it matters for a
     future combined-load scenario.

     **Known stale artifact from this test:** the forced-final answer
     quoted `agent_delegate.js`'s own `MAX_STEP_RESULT_CHARS` inline
     comment verbatim, which still reads "270000 marked UNTESTED pending
     live validation" -- accurate at the time that comment was written
     (commit `49815a3`, before this session's live-timing runs), now
     stale given the CONFIRMED SAFE verdict directly above. Not yet fixed
     in code as of this plan.md edit -- flagging here so a follow-up
     commit updates that comment to match, rather than leaving the
     in-repo documentation and this plan's own verdict disagreeing with
     each other.
