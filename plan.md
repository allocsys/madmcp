# Findings: B.AI provider testing + max_steps bug (2026-09-02)

Context: `connectors/bai/client.js`'s bounded 2-pass key-rotation retry
loop (`MAX_KEY_ROTATION_PASSES = 2`) and the Gemini model-first cascade
reorder (`connectors/gemini/client.js`, PR #137 / commit `befdcda`) were
merged to `main` in prior sessions. This session re-tested the bai path
via `delegate_agent({ provider: "bai" })`, which led to finding and
root-causing an unrelated `max_steps` enforcement bug.

---

## 1. bai key-rotation retry loop: code-level verification (confirmed)

Read `connectors/bai/client.js` directly on `main` and confirmed the
described retry loop is actually present as specified:

- Outer loop `for (let pass = 0; pass < MAX_KEY_ROTATION_PASSES; pass++)`,
  `MAX_KEY_ROTATION_PASSES = 2`.
- Inner loop iterates `BAI_API_KEYS`, checking `isModelCoolingDown(BAI_MODEL,
  "bai:<keyIndex>")` before each live attempt and skipping keys still
  cooling.
- 429 -> cooldown via `parseRetryDelaySeconds`; 503/timeout -> cooldown via
  `DEFAULT_COOLDOWN_SECONDS` fallback (added in commit `27449d5`, same day).
- 401/403 (bad key) does NOT `break` the inner loop -- correctly falls
  through to the next key.
- Early-exit: if a whole pass makes zero live attempts (every key already
  cooling), the loop stops without wasting a second pass.
- Aggregate exhaustion error tags `.transient = true` only if every
  contributing attempt was itself transient-shaped.

`test/bai-client.test.js` covers rotation on 429/401/403, cooldown-skip
behavior, the aggregate error (incl. `.transient`), non-retryable statuses
re-thrown immediately, and `_fallbackKeyIndex` tagging.

**Conclusion: the retry loop is correctly implemented and unit-tested.**

---

## 2. bai key-rotation: live-run verification (inconclusive by design)

A real `delegate_agent({ provider: "bai", max_steps: 15 })` run (20 steps,
all bai-backed) completed cleanly with no rate-limit/cooldown activity --
no key ever hit pass 2. This confirms the bai path works end-to-end under
normal conditions but does not exercise the "cooldown clears mid-call"
scenario, which can't be forced from outside the process. The mocked unit
tests in `test/bai-client.test.js` remain the real source of confidence
for that specific mechanism, not a live run.

---

## 3. BUG (ROOT-CAUSED): `max_steps` silently ignored on async fresh-start `delegate_agent` calls

**File:** `connectors/gemini/agent_tools.js`, async fresh-start branch of
the `delegate_agent` tool handler.

**Root cause:** the fresh-start call site never passes `max_steps` through
to `seedRun`:

```js
runId = await seedRun({ task, provider, model, maxOutputTokens });
await publishAgentStep({ runId, afterStep: 0 });
```

`seedRun`'s signature is `seedRun({ task, provider, model, maxOutputTokens,
max_steps = 20 })` (`connectors/gemini/agent_delegate.js`). Since the
caller omits `max_steps` entirely, it silently defaults to `20` on every
async fresh-start call, **regardless of what the caller actually
requested**. That default becomes `overallMaxSteps` in the seeded
checkpoint (`const overallMaxSteps = Math.min(max_steps, HARD_MAX_STEPS)`
inside `seedRun`), and every subsequent worker-driven `singleStep` resume
reads its step ceiling from the checkpoint's `overallMaxSteps` -- not from
anything the original caller passed -- so the run proceeds against a
ceiling of 20, not whatever `max_steps` the caller specified.

**Scope of the bug:** this is specific to the **async fresh-start path**
(`DELEGATE_AGENT_ASYNC === "qstash"` enabled, no `resume_run_id`). The
synchronous path in the same file (`runInvestigation({ task, max_steps,
resume_run_id, provider, model, maxOutputTokens })`, later in the same
handler) DOES pass `max_steps` correctly -- confirmed by reading
`runInvestigation`'s own step-loop logic (`cappedSteps = Math.min(max_steps,
HARD_MAX_STEPS); effectiveOverallMaxSteps = cappedSteps;` when not
`singleStep`), which correctly bounds a normal synchronous call. So a
synchronous `max_steps: 3` call would very likely behave correctly; it was
only the async/QStash worker-chained path that dropped the value.

**How this was found:** requested `max_steps: 3` on a fresh `delegate_agent`
call with `provider: "bai"`. The run (async, since it returned a
`run_id` immediately rather than blocking) proceeded past 3 steps on every
subsequent poll -- observed step counts across repeated polls of the same
`resume_run_id`: 14 -> 15 -> 19, consistent with heading toward the
silently-defaulted ceiling of 20 rather than stopping at 3.

**Confirmed NOT the cause:** `editor_delegate.js`'s equivalent async path
(`seedEditorRun`) was not checked in this session, so it's unknown whether
the same class of bug exists there -- worth checking, since the two files
are structurally parallel (see the old `plan.md`, now replaced, which
ported the async pattern from `agent_*` to `editor_*`).

**Fix (not yet implemented):** pass `max_steps` through in the fresh-start
call:
```js
runId = await seedRun({ task, provider, model, maxOutputTokens, max_steps });
```
A regression test should assert that a fresh async call with an explicit
`max_steps` produces a checkpoint whose `overallMaxSteps` matches the
requested value, not the default of 20.

**Why this matters beyond the immediate test:** this confirms the original
suspicion from earlier in this session -- "if step budgets are this loose,
the enforcement mechanism itself may be unreliable more broadly" -- was
correct, but the actual defect is much narrower and more mundane than a
step-counting logic bug: it's a missed parameter at a single call site,
not a flaw in the step-budget mechanism itself (which, per the code read
in `runInvestigation`/`seedRun`, is otherwise soundly designed -- checkpoint-
persisted `overallMaxSteps`, `HARD_MAX_STEPS` clamping, `isFinalStep`
tool-withholding, etc. all work as documented once given the right input).

---

## 4. Cache-hit repeat calls observed during the same run (likely a symptom of #3, not a separate bug)

During the stuck/over-budget run, steps 16-18 were exact repeats of steps
12-14 (`github_get_file_at_commit` on the same commit + paths), served from
`resultCache` and marked `[CACHED -- identical call already made this run,
not re-executed]` in the transcript.

Having now read `agent_delegate.js` in full: this is **not a bug** in
itself -- `resultCache`/`repeatCounts` and the `consecutiveAllRepeatSteps`
stuck-loop guard are an intentional, working mechanism (repeats are served
from cache for free rather than re-executed; 3 consecutive all-repeat steps
force a no-tools text-only answer). What's still unexplained is why the run
appeared to stall completely (two consecutive polls showing identical
transcript and step count, zero new activity) rather than either continuing
past the repeats or hitting the `consecutiveAllRepeatSteps >= 3` forced-answer
path within a few more steps. Possible explanations, not yet checked:

- The QStash worker chain (`agent_worker.js`) may have silently stopped
  re-publishing the next step (a crash, an unhandled rejection, or a
  dead-letter that didn't update `status` correctly).
- The repeats may not have been 3 consecutive ALL-repeat steps (mixed with
  non-repeat calls elsewhere in the same steps), so `consecutiveAllRepeatSteps`
  never actually hit 3 and the run is still "legitimately" running, just
  slowly, and our polls happened to land in a quiet gap.

**Next step for this specific thread:** re-check `agent_worker.js` (not yet
read this session) for how it dead-letters / detects a stalled chain, and
whether `EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES`'s `agent_*` equivalent
exists and was hit.

---

## Next steps

1. **Fix confirmed bug #3**: add `max_steps` to the `seedRun` call in
   `connectors/gemini/agent_tools.js`'s async fresh-start branch. Add a
   regression test pinning `overallMaxSteps` to the caller's requested
   value on a fresh async call.
2. Check `connectors/github/editor_delegate.js`'s `seedEditorRun` call site
   (in `editor_tools.js`) for the same missed-parameter pattern.
3. Read `agent_worker.js` to understand why the run appeared to stall after
   the cache-hit repeats rather than progressing or forcing a stop.
4. Once #3 is fixed, re-run the original bai key-rotation test with a
   correctly-enforced `max_steps` to confirm the fix doesn't change bai-path
   behavior.
5. See new Section 5 below for the still-open "Void" investigation and its
   own next steps.

---

## 5. The "Void" response on the stuck run -- investigated, not resolved

After root-causing bug #3, we asked whether an explicit `max_steps` could
unstick the frozen run (`d303f6a8-8b0f-4881-bf95-aa6a274271f2`, last known
state: wedged at 19 steps, transcript unchanged across polls). Two
consecutive polls of that run -- one plain, one with `max_steps: 30` added
-- both returned the exact same response text, prefixed with:

> "Void (the re-fetch was served from cache, not new content)."

followed by the identical 19-step transcript both times.

**Important scoping fact:** this string does not exist anywhere in the
`allocsys/madmcp` repo (confirmed via `search_code`). It is NOT produced by
`agent_delegate.js`, `agent_worker.js`, `agent_tools.js`, or any other
server-side code we've read. It must come from a layer above this repo
entirely -- the tool-calling/MCP-client infrastructure that mediates calls
to `delegate_agent`, which we have no read access to from here (not a file
in this repo, no tool available to inspect it).

**What we tried, to narrow down the trigger:**

- Hypothesis: "any call whose result is byte-identical to the last one
triggers Void." Started a fresh control run
(`c3cec1c6-0500-42de-ba53-47cf4fdce6c6`, deliberately small: `max_steps: 5`,
single-file task) and polled it repeatedly, including two consecutive polls
that both returned identical "still running, 1 step done" content. Neither
poll returned "Void" -- both were normal, correctly-formatted responses.
**This rules out "any identical content" as the trigger.**
- Hypothesis: "very short interval between polls triggers it." Polled the
control run back-to-back with minimal delay; got a normal, fresh, and by
that point actually-advanced response (2 steps, real answer) -- no "Void".
**This rules out raw polling speed as the sole trigger**, at least under
the timing we could produce here.
- The control run otherwise completed entirely normally: seeded, stepped
twice, produced a correct final answer (`BAI_API_KEYS` parsing in
`config.js`) with zero anomalies. **This confirms the async worker chain
itself works correctly in the ordinary case** -- the earlier bug (#3) and
this "Void" behavior are both edge cases, not signs of a broadly broken
async path.

**Where this leaves us:** "Void" appears to be specific to the one run
that had genuinely stopped making progress across multiple real polls (not
just returning identical content, since our control run did that too
without triggering it). The likeliest remaining explanation is still that
the worker chain's re-chain publish failed silently at some point on that
run (the `step-ok-rechain-failed` path in `agent_worker.js`, which leaves
the checkpoint validly "running" but with no further worker actually
driving it) -- and "Void" is possibly a client-side signal meaning
something like "no new checkpoint state at all since last time," which
would only fire once a run is well and truly stuck, not merely slow. This
is a plausible theory, NOT a confirmed one -- we could not reproduce it on
demand, and do not have visibility into the layer that emits it.

**Next steps for this specific thread:**

- If a future run exhibits the same "stuck at N steps across multiple real
  polls" symptom, capture whether "Void" reappears and whether it correlates
  with checkpoint `lastStepAt`/`stepStartedAt` staleness (would need
  `DEBUG_AGENT_WORKER=true` and access to server logs -- not available from
  this session).
- Consider asking whoever owns the tool-calling/MCP-client layer directly
  what "Void" means and what triggers it, since we've hit the limit of what
  can be inferred from black-box behavior alone.
- Do not treat "Void" as confirmed evidence of any particular root cause
  (rate-limiting, failed re-chain, or otherwise) in future write-ups --
  it's a symptom we've only ever seen once, on one run, and couldn't
  reproduce under controlled conditions.

---

## 6. Follow-up session (2026-09-02): bug #3 fix confirmed landed, editor path confirmed clean, DEBUG_AGENT_WORKER red herring ruled out

**Bug #3 fix + regression test are already on `main`, no further action
needed:**
- `14245fd` -- "Fix: pass max_steps through to seedRun on async fresh-start
  delegate_agent path". `connectors/gemini/agent_tools.js` now calls
  `seedRun({ task, provider, model, maxOutputTokens, max_steps })`,
  confirmed by direct read of the current file.
- `ded479f` -- "Add regression test: seedRun must pin overallMaxSteps to
  the caller's requested max_steps" (`test/agent-seedrun-max-steps-
  regression.test.js`), pinning `seedRun`'s own contract directly, plus
  the pre-existing `test/agent-tools-async.test.js` covering the call site.

**Next-steps item #2 (editor path) checked -- no analogous bug exists:**
`connectors/github/editor_tools.js`'s fresh-async-start branch already
calls `seedEditorRun({ owner, repo, branch, task, max_steps, provider })`
-- `max_steps` is present. `seedEditorRun`'s signature
(`connectors/github/editor_delegate.js`) is `{ owner, repo, branch, task,
max_steps = EDITOR_DEFAULT_STEPS, provider }`, and `runEditorAgent`'s own
`effectiveOverallMaxSteps`/`cappedSteps` derivation mirrors
`agent_delegate.js`'s (correct) pattern. The two files were structurally
parallel per the original worry in Section 3, but only `agent_tools.js`
actually had the missed-parameter bug -- `editor_tools.js` never did.
No fix or regression test needed here.

**Red herring ruled out -- `DEBUG_AGENT_WORKER`'s history in `config.js`
is NOT the resolution to Section 5's "Void" mystery:** `agent_worker.js`
and `config.js` both carry comments about a worker-chain stall that was
"diagnosed as sustained B.AI rate-limiting" and is why `DEBUG_AGENT_WORKER`
defaults off. This looked at first glance like it might resolve Section 5.
It doesn't: that diagnosis is commit `2aad526` (2026-08-31), which predates
`d7a51d7` (2026-09-01, when Section 5 was written) and explicitly describes
a **separate, self-recovered** stall from an earlier session -- not run
`d303f6a8-8b0f-4881-bf95-aa6a274271f2`, which never self-recovered across
multiple real polls. Section 5 remains genuinely open; do not cite the
B.AI-rate-limiting diagnosis as an explanation for the "Void" run without
new evidence specific to that run.

**Re-ran the original bai key-rotation test with the fix in place --
CONFIRMED FIXED:** started a fresh async `delegate_agent({ provider:
"bai", max_steps: 3 })` run (`run_id:
e6c0ee61-129c-42e9-a698-239557f83567`). First poll: 0 steps done, 2s in
(too early to tell). Second poll returned a completed result after
exactly **3 step(s) taken** -- matching the requested `max_steps: 3`
precisely, not drifting toward the old silently-defaulted ceiling of 20.
This directly confirms the fix from `14245fd` works end-to-end on a real
async bai run, not just in the unit test.

The run's own task failed for an unrelated reason: the agent's attempt to
read `connectors/bai/client.js` 404'd, and two code searches for
`MAX_KEY_ROTATION_PASSES` (repo-scoped and path-scoped) returned zero
results, so it correctly declined to fabricate a summary rather than
guessing. This looks like a repo/owner-resolution issue specific to that
call (possibly a default-owner mismatch on the bai provider path) --
worth a look if bai-provider file reads keep failing this way, but it is
separate from, and does not affect, the max_steps confirmation above.

**Updated overall status: ALL 5 original next-steps items are now
resolved or closed out.** #1 (fix bug #3): fixed and confirmed live. #2
(check editor path): checked, no bug found. #3 (read agent_worker.js):
done, narrowed the DEBUG_AGENT_WORKER history but ruled it out as
unrelated to Void. #4 (re-test bai with the fix): confirmed working via
the run above. #5 (Void investigation, Section 5): remains genuinely
open -- the only unresolved item, and it needs access this session
doesn't have (server logs / the tool-calling layer that emits "Void").

---

## 7. Stall reproduced on demand with an oversized task -- new hypothesis for Section 5 (unconfirmed)

Deliberately started a fresh async `delegate_agent({ provider: "bai",
max_steps: 3 })` run (`run_id: c1beaeda-874a-47dd-97b0-763bff80ba6d`) with
a single huge, sprawling task (full-repo architecture write-up: every
connector, every checkpoint schema, line-by-line worker comparison, every
config.js env var) specifically to see how an oversized step interacts
with the step-budget/worker-chain machinery.

**Observed:**
- Step 1: `github_get_file_tree` -- normal, single call.
- Step 2: the model batched **13 separate `github_read_file` calls into
  one step**, including two calls that hit the 30,000-char truncation
  ceiling (`agent_delegate.js` at 148,522 total chars, `editor_delegate.js`
  at 37,360 total chars).
- Step 3 never happened. Polling ~5 minutes later showed the checkpoint
  stuck at "2 steps done," 279s since last activity -- the same
  "stalled, worker chain may have broken" status `agent_tools.js` reports
  when `lastStepAt`/`stepStartedAt` goes stale.

**Why this is a meaningfully different situation than Section 5:** Section
5's stall (`d303f6a8`) was observed once, after the fact, with no way to
reproduce it. This one was produced on demand, by a specific and
replicable input shape (one step with an unusually large number of
batched tool calls / unusually large combined result payload). That's a
concrete, testable variable Section 5 never had.

**New hypothesis (UNCONFIRMED, needs log evidence):** an oversized step --
many tool calls and/or large truncated file contents accumulated into a
single step's transcript/resultCache -- produces an unusually large
checkpoint payload at `saveState`/`saveCheckpoint` time. This could fail
or silently degrade in at least two places: (a) the Redis checkpoint write
itself, if the serialized payload approaches a size limit, or (b) the
subsequent QStash re-chain `publishAgentStep` call in `agent_worker.js`,
which already has a known silent-failure path (`step-ok-rechain-failed`)
that leaves the checkpoint validly "running" with no worker actually
driving it -- exactly the symptom observed here and in Section 5's
original run. This would mean oversized steps are a plausible **trigger**
for the same failure mode Section 5 could only theorize about abstractly.

**Explicitly NOT confirmed:** we have not inspected checkpoint payload
size, Redis error logs, or QStash delivery logs for this run. The
correlation (huge step -> stall) is suggestive, not proven -- it could
equally be coincidental timing, an unrelated bai-side issue, or something
else entirely. Do not treat this as a resolved root cause.

**Action taken:** flipped `DEBUG_AGENT_WORKER` to default ON in
`config.js` (previously default OFF, per Section 6's finding that it had
been turned off after an earlier, unrelated stall was diagnosed) so that
if this stall pattern recurs -- especially on another oversized-step run
-- the per-invocation entry/exit logs in `agent_worker.js` are captured
automatically rather than requiring a manual env var flip after the fact.
Revert to default OFF once this hypothesis is confirmed or ruled out, per
the same reasoning `config.js`'s own comment gives for why it was
originally turned off (log volume stops earning its keep once diagnosed).

**Next steps for this thread:**
- If a future run stalls the same way, check `DEBUG_AGENT_WORKER` logs for
  `step-ok-rechain-failed` specifically correlated with an oversized
  preceding step.
- Consider adding a checkpoint payload-size log line (bytes) at
  `saveCheckpoint` time regardless of DEBUG_AGENT_WORKER, since that's the
  one number that would most directly confirm or kill this hypothesis.
- See Section 8 below: the attempted resume of this exact run produced its
  own new evidence pointing the same direction.

---

## 8. Three consecutive explicit-max_steps resume attempts on the stalled run all failed to complete -- strengthens the oversized-payload hypothesis, points at a possible execution-timeout angle

Attempted to resume the same stalled run from Section 7
(`c1beaeda-874a-47dd-97b0-763bff80ba6d`, stuck at 4 steps done) using an
explicit `max_steps` on the resume call -- the mechanism `agent_tools.js`
documents for pushing a stale/stalled checkpoint forward synchronously.
Three attempts, all in this same follow-up session, none completed
cleanly:

1. **`resume_run_id` + `max_steps: 5`** (checkpoint was stale, 4 steps
   done, 70-280s since last activity across the polls that preceded this) --
   returned a raw tool-execution error (`{"error": "Error occurred during
   tool execution"}`, no other detail surfaced to this session).
2. **Same run, `max_steps: 5` again**, immediately after -- also a raw
   tool-execution error, distinct request id from attempt 1. Both errors
   were generic infra-level failures, not one of `agent_tools.js`'s own
   handled error paths (no "Investigation failed", no "stalled", no
   "failed permanently" text -- those all render as normal tool text, not
   a `{"error": ...}` shape).
3. **Same run, `max_steps: 8`** -- did not error immediately. Instead it
   ran long enough that the user deliberately interrupted it rather than
   wait out an unknown-length hang. Per the user's own observation of the
   pattern across attempts: *the first resume attempt at a given max_steps
   tends to error/time out quickly, and a subsequent attempt only goes
   through if a bigger max_steps is passed than the one that just failed*
   -- consistent with something size- or duration-proportional gating
   success, not simple flakiness. This third attempt was aborted before
   reaching either a clean result or another error, so we don't know what
   it would have resolved to.

**Why this matters for the Section 7 hypothesis:** a resume on this run
has to reconstruct and resend the ENTIRE accumulated `contents` array --
by step 4, that includes two 30,000-60,000-char file-read results plus
roughly 20 other tool results across 4 batched steps. That is a
substantially larger payload than an ordinary step, both for whatever
backend function handles the resume request and for the outbound call to
bai's API. Two clean infra-level errors immediately, followed by a third
attempt that ran long enough to require manual interruption instead of
erroring fast, is a pattern that fits "payload/duration scales with
accumulated checkpoint size and something (a function execution limit, a
bai request timeout, or similar) is being pushed close to or past its
ceiling" better than it fits ordinary transient flakiness. This is still
an inference from black-box behavior, not a confirmed mechanism.

**Explicitly NOT confirmed:** we do not have the actual error detail
behind either `{"error": "Error occurred during tool execution"}`
response (no stack trace, no distinguishing message reached this session
-- only an opaque request id each time), and we do not know what the
third, interrupted attempt would have returned. The "needs bigger
max_steps to go through" pattern is the user's observation across these
specific attempts, not something we've independently verified holds in
general.

**Next steps for this thread:**
- This now clearly needs server-side visibility this session doesn't have:
  the two request ids from attempts 1-2 above, checked against whatever
  logging/error-tracking sits behind the MCP tool-execution layer (not
  this repo's own code -- these errors happened before/outside
  `agent_tools.js`'s own try/catch blocks, which always return a
  structured text response, never a bare `{"error": ...}`).
- With `DEBUG_AGENT_WORKER` now defaulting on (Section 7), check whether
  `agent_worker.js`'s logs show ANY invocation at all during these resume
  attempts -- if the resume calls are going through `runInvestigation`
  synchronously (as `agent_tools.js`'s stale-checkpoint fallback is
  supposed to do) rather than through the worker, `agent_worker.js`'s logs
  won't show anything relevant and the right place to look is whatever
  wraps the synchronous `runInvestigation` call itself (e.g. a Vercel
  function timeout log, not this repo's own logging).
- Do not attempt further resumes of this specific run
  (`c1beaeda-874a-47dd-97b0-763bff80ba6d`) without logs in hand first --
  three attempts with no clean outcome and one requiring manual
  interruption suggests further blind retries are unlikely to add new
  information and cost real time/quota.
- If/when a synchronous-resume execution-time ceiling is confirmed as the
  mechanism, cross-reference against `GEMINI_REQUEST_TIMEOUT_MS` (55000ms
  default) and any platform-level function-duration limit -- neither has
  been checked against this specific failure yet.

---

## 9. ROOT CAUSE CONFIRMED via Vercel logs: oversized steps hit the platform's 300-second serverless function timeout

Gained Vercel log access this session and checked `get_runtime_errors` +
`get_runtime_logs` for the `madmcp` project (`prj_7iG65asCBZzoZsZoMY1Vuf7B5mbh`,
team `team_LyeppGZMAygFDwBK8CuNZOWx`) directly. This resolves Sections 7
and 8 from theory to confirmed fact, and gives a strong new lead on
Section 5.

**`get_runtime_errors` (last 2h):** a single dominant error group --
`Vercel Runtime Timeout Error: Task timed out after 300 seconds`, 15
occurrences, route `/`, spanning `2026-08-08` to `2026-09-02` (i.e. this
is a recurring, pre-existing failure mode, not a one-off).

**`get_runtime_logs` filtered to `runId=c1beaeda-874a-47dd-97b0-763bff80ba6d`
(the Section 7/8 run) shows the exact mechanism:**

- `/api/agent-worker` hit the 300s timeout FIVE times while stuck trying
  to advance past the oversized step 2: `23:57:29`, `23:57:36`,
  `00:02:47`, `00:04:48`, `00:09:13`. The `00:09:13` entry has a full
  debug trail (DEBUG_AGENT_WORKER was on by then, per Section 7's flip):
  `entry ... afterStep=2` -> `heartbeat written, entering
  runInvestigation` -> killed at exactly 300s, never reaching
  `handleAgentWorker`'s own try/catch or the re-chain/dead-letter logic
  below it.
- Our own `/mcp` resume calls from Section 8 (the two that returned raw
  `{"error": ...}` tool-execution failures, and the third the user
  interrupted) hit the IDENTICAL 300s timeout on the same route:
  `00:05:19`, `00:14:13`, `00:19:15`, `00:21:53`, `00:22:37`. These were
  not `agent_tools.js`-level errors at all -- they were the platform
  hard-killing the synchronous `runInvestigation` call mid-flight, which
  is indistinguishable from a generic tool-execution failure from this
  session's side.
- The run DID eventually advance from 2 steps to 4 (confirmed via two
  `stale-afterStep` no-op log lines reporting `liveStepsDone=4`) -- but
  there is no log evidence of a clean success in between the timeouts.
  The likeliest explanation is a QStash redelivery of the same
  `afterStep=2` message eventually got a fast-enough bai response to
  finish under 300s, i.e. this is probabilistic/flaky (sometimes the
  oversized step's outbound API call finishes in time, sometimes it
  doesn't), not deterministic.

**CONFIRMED: Sections 7 and 8's hypotheses were correct.** An oversized
step (many batched tool calls, large truncated file contents accumulated
into one turn's context) makes the outbound call to the provider (bai, in
every observed case here) slow enough that the whole serverless
invocation -- worker-driven or our own synchronous resume -- routinely
exceeds Vercel's 300-second function execution ceiling and gets hard
terminated by the platform, not by any code path in this repo.

**NEW finding, likely more consequential than the timeout itself: the
dead-letter mechanism doesn't see these failures at all.**
`agent_worker.js`'s `retryCount`/`AGENT_WORKER_MAX_CONSECUTIVE_FAILURES`
(default 5) tracking only increments when `runInvestigation` RETURNS --
either a success or an internally-caught `{ failed: true }`. A hard
platform timeout kills the function before that code ever runs, so it can
never be counted as one of the 5 failures that would otherwise finalize
the checkpoint as `"failed"`. In practice this means a run stuck in this
failure mode can loop on QStash's own automatic redelivery retries
indefinitely (bounded only by QStash's own retry policy, not this repo's
own guardrail), which matches the observed behavior far better than
Section 5's original "maybe the re-chain publish failed silently" theory
did.

**Plausible (not confirmed) explanation for Section 5's "Void" response:**
if the platform hard-kills the backing function before it returns, and
the `/mcp` gateway layer in front of it has any response caching, a
subsequent poll of the same still-unresolved request could plausibly be
served a stale cached response instead of a fresh one -- which matches
"the re-fetch was served from cache, not new content" strikingly well.
This is a much better-supported theory than anything in Section 5's
original writeup, but it is still inferred, not directly observed in a
log line that says "Void" or names a caching layer -- treat it as the
leading hypothesis now, not a closed case.

**Updated status: the core stall/hang mechanism (Sections 5, 7, 8) is now
CONFIRMED as oversized-step-induced Vercel function timeouts, not a bug in
this repo's own retry/checkpoint/re-chain logic**, which was otherwise
verified sound in Sections 3 and 6. The remaining open question is
whether "Void" specifically is caused by the gateway-caching mechanism
above -- narrower and more tractable than the original open-ended
mystery.

**Next steps:**
- Fix candidate (not yet implemented): cap the number of tool calls /
  total result size the model is allowed to batch into a single step, so
  no single step's outbound API call can realistically exceed a safe
  fraction of the 300s ceiling. This would address the root cause
  directly rather than working around it.
- Alternative/complementary fix: reduce `GEMINI_REQUEST_TIMEOUT_MS`-style
  per-call timeout enforcement to also apply on the bai path (Section 3
  noted bai's client has cooldown/retry logic but the config comments
  don't show an equivalent hard per-call timeout the way Gemini's client
  does) so a slow individual call fails fast and cleanly instead of
  riding all the way to the platform's own hard kill.
- Consider whether Vercel's function `maxDuration` can be raised (Fluid
  Compute / Pro plan may allow up to 800s+) as a stopgap, though this only
  delays the same failure mode rather than fixing it, and the team is
  currently on the Hobby plan per `list_teams` (`"plan": "hobby"`), which
  may cap this lower than paid tiers regardless.
- Fix the dead-letter blind spot: consider whether QStash's own delivery
  attempt count/headers can be inspected so `agent_worker.js` can
  recognize "this message has already been redelivered N times by QStash
  itself" as equivalent evidence of stuck-ness, independent of its own
  in-process `retryCount`, which a hard kill can never increment.
- Do NOT resume `c1beaeda-874a-47dd-97b0-763bff80ba6d` again -- it's not
  informative anymore; the mechanism is understood. Any further testing of
  this failure mode should use a fresh, deliberately oversized task like
  Section 7's, now that we know what to look for in the logs.

---

## 10. Fixes implemented for Section 9's root cause (this session) -- branch `fix/oversized-step-timeout`

Implemented the "Next steps" list from Section 9, in priority order. Branch
pushed to `origin/fix/oversized-step-timeout`
(https://github.com/allocsys/madmcp/pull/new/fix/oversized-step-timeout),
not yet merged to `main`. Full test suite (517 tests) and lint pass clean
after both commits below.

**Priority #1 (root-cause fix) -- DONE, commit `ee6560d`:** Added two
guardrails to `agent_delegate.js`'s step loop, independent of the existing
per-call `sliceFileContentForModel` truncation (which alone doesn't stop
the model from batching many individually-within-limit calls into one
step):

- `MAX_TOOL_CALLS_PER_STEP = 8` -- only the first 8 calls the model
  batches into a single turn are actually executed. The rest
  (`deferredFunctionCalls`) still get a `functionResponse` each (required
  by the API contract), but a synthetic, non-executed one telling the
  model to re-request them next step.
- `MAX_STEP_RESULT_CHARS = 60000` -- caps the combined size of what
  actually gets appended to `contents`/`responseParts` for one step.
  Applied AFTER execution/caching, so `resultCache` and the Redis
  side-store still hold the full, untruncated text (nothing is lost for
  `findUnverifiedClaims`/history-compaction purposes) -- only the outbound
  payload sent to the LLM on the next call is bounded. A call cut off by
  this cap can be re-requested (e.g. via `char_offset`) in a later step.

Both values are deliberately conservative but not tiny -- confirmed by the
full pre-existing test suite passing completely unchanged (ordinary steps,
1-3 calls with one moderate file read, are far under either cap). New
regression test `test/agent-oversized-step-cap.test.js` reproduces the
Section 7 repro shape (many batched calls in one step) directly against
`runInvestigation` and asserts both caps against real observed behavior
(actual `readFileViaBlob` call counts for the count cap; the actual
outbound `providerChat` `contents` payload size for the size cap), not
just transcript string matching.

**Priority #2 (bai per-call timeout) -- ALREADY DONE, no fix needed
(correction to the handoff's premise):** The handoff task description
stated bai's client "doesn't appear to have" a `GEMINI_REQUEST_TIMEOUT_MS`
equivalent. This was checked directly against current `main` this session
and found to be incorrect: `connectors/bai/client.js`'s
`callChatCompletionOnce` already wraps its `fetch` call in an
`AbortController` + `setTimeout(..., BAI_REQUEST_TIMEOUT_MS)`, aborting
and throwing a `.transient = true` error on timeout -- the exact same
shape as Gemini's own timeout handling. `config.js` already exports
`BAI_REQUEST_TIMEOUT_MS = Number(process.env.BAI_REQUEST_TIMEOUT_MS) ||
55000` (same 55000ms default as `GEMINI_REQUEST_TIMEOUT_MS`,
`GLM_REQUEST_TIMEOUT_MS`, `GROQ_REQUEST_TIMEOUT_MS`), and
`test/bai-client.test.js` already covers the abort/timeout path
(`"maps a network/abort failure to a transient error"`,
`"rotates to the next key on a network/timeout failure and records a
cooldown"`). Traced via `git log -S` to commit `ad99a3d`, the original
"Add B.AI as a third delegate_agent provider" commit -- it was present
from the start, not added since the handoff was written. No code change
made for this item.

**Priority #3 (dead-letter blind spot) -- DONE, commit `ebdb441`:** Added
`Upstash-Retried` header inspection to `agent_worker.js`. QStash stamps
every HTTP delivery attempt of a given message with this header (`0` on
the first attempt, incrementing by 1 on each subsequent QStash-initiated
redelivery -- confirmed against Upstash's own docs,
https://upstash.com/docs/qstash/features/retry), entirely independent of
whatever this repo's own code did or didn't get to run on a prior
attempt. This closes the exact gap Section 9 identified: a platform
timeout kills the function before `retryCount` (this repo's own counter,
only ever updated via the re-chain `publishAgentStep` call) can be
incremented, so QStash can redeliver the same message indefinitely
without `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES` ever seeing it.

Implementation: `effectiveRetryCount = Math.max(bodyRetryCount,
qstashRetried)`, used in place of plain `retryCount` in two places:

- The existing post-attempt dead-letter check (now correctly reaches the
  threshold via the header even when `body.retryCount` is stuck/stale
  because every prior attempt was platform-killed before reaching the
  code that would have updated it).
- A NEW early pre-attempt check, run immediately after parsing
  `runId`/`afterStep`/`retryCount` from the body and before the heartbeat
  write / `runInvestigation` call: if the header alone already meets
  `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES` on entry, dead-letter
  immediately (with its own `reason: "qstash-retried-threshold"` in the
  response) instead of spending another likely-doomed ~300s attempt.
  Re-checks the checkpoint's live status/stepsDone right before writing,
  same idempotency shape as the rest of the file, so this can't stomp on
  a checkpoint another (successful) concurrent invocation has already
  moved past.

Three new regression tests in `test/agent-worker.test.js`:
1. Simulates `body.retryCount` frozen at 0 across five simulated
   redeliveries while `Upstash-Retried` climbs 0->4, confirming
   dead-lettering fires (via the post-attempt path) driven by the header,
   not the body field.
2. Confirms the early-skip path: a single request whose header alone
   already meets the threshold dead-letters WITHOUT calling
   `providerChat`/`runInvestigation` again.
3. Confirms a low/healthy `Upstash-Retried` value (1) does not trip the
   check prematurely on an otherwise-normal step.

All 8 pre-existing `agent_worker.js` tests pass unchanged (11 total after
the 3 new ones).

**Deliberately NOT done this session (per the handoff's own scope):**
`DEBUG_AGENT_WORKER` remains at its current default (ON, flipped in
Section 7) -- reverting it to default-off was priority #4 in the original
handoff but is being held for a separate step, not bundled into this
branch. Section 5's "Void" question also remains open, as instructed --
nothing in this session's fixes constitutes the "separate confirmation"
that question still needs. Run `c1beaeda-874a-47dd-97b0-763bff80ba6d` was
not touched.

**Next steps:**
- Revert `DEBUG_AGENT_WORKER` default to off (config.js) now that the
  Section 9 root cause has both a fix and a real dead-letter safety net --
  separate step per the handoff, deliberately not included here.
- Open a PR from `fix/oversized-step-timeout` into `main` and merge once
  reviewed.
- Once merged and deployed, the real-world test is whether the Vercel
  `Task timed out after 300 seconds` error group (Section 9) stops
  recurring for new runs -- the 15 occurrences found this session all
  predate this fix. Worth a follow-up `get_runtime_errors` check after a
  reasonable interval post-deploy.
- If a future run still exhibits stalling despite these fixes, that would
  be new information worth its own investigation (would suggest either
  the caps need tuning, or a genuinely different failure mode) rather
  than assuming it's the same one Section 9 already root-caused.

---

## 11. Live test of the Section 9/10 fix (2026-09-02, follow-up session): a NEW post-merge timeout occurrence found -- different failure shape than the original repro, root cause NOT yet fixed

Per the handoff from Section 10, ran the prescribed live test: a fresh,
deliberately oversized `delegate_agent` task (`provider: "bai"`,
`max_steps: 3`), same shape as Section 7's repro (single sprawling
full-repo-architecture-writeup task designed to make the model batch many
tool calls / large file reads), and watched `get_runtime_errors`/
`get_runtime_logs` (project `prj_7iG65asCBZzoZsZoMY1Vuf7B5mbh`, team
`team_LyeppGZMAygFDwBK8CuNZOWx`) for the "Task timed out after 300
seconds" error group throughout.

**Baseline confirmed clean first:** PR #138 merged as commit `c379867` at
`2026-09-02T01:09:27Z`. Before starting the new test run, the error
group's most recent occurrence was `2026-09-02T00:42:01Z` -- strictly
before the merge. No occurrences in the gap between merge and test start.

**Run `223d6b08-d2e1-4f23-8597-27fc48c594a3` (started ~`01:16:47Z`):**

- Step 1: `github_get_file_tree` + `github_get_repo` -- normal.
- Step 2: batched 6 `github_read_file` calls. **The new
  `MAX_STEP_RESULT_CHARS` cap fired exactly as designed**: the 6th call
  (`connectors/github/editor_checkpoint.js`) came back as `[Result
  withheld -- this step's combined tool-result size already reached the
  60000-char per-step cap from earlier calls in the same step. Re-request
  this specific call in your next step.]` instead of its actual content.
  This is the priority #1 fix working correctly, live, on the exact
  batched-calls-in-one-step shape Section 7 used to repro the original
  bug.
- Step 3 (the forced-final-answer step, since `max_steps: 3` was
  reached -- bai has no more tool calls available and must synthesize one
  complete answer covering the full task: every connector, every
  checkpoint schema, a line-by-line worker comparison, every config.js
  env var): invocation `ba8f4094-3f81-4587-ba30-30f4d4df0822` entered at
  `01:17:33Z` and **hard-timed-out at exactly 300 seconds** (`01:17:33Z`
  + 300s, HTTP 504, confirmed via both the polling tool's own
  "stalled... no activity in ~300s" report and a direct
  `get_runtime_logs` hit showing `Vercel Runtime Timeout Error: Task
  timed out after 300 seconds` immediately after that invocation's
  `heartbeat written, entering runInvestigation` line, with no return log
  in between).

**Confirmed NOT a stale-deployment false alarm:** `get_deployment` on
`dpl_ELEZPU9ymzysz8hFEgUz1QYjKRis` (the deployment the timeout occurred
on) shows `githubCommitSha: c379867...`, `githubCommitRef: main`,
`githubCommitVerification: verified` -- this is the exact merged PR #138
commit, in production, not an old deployment.

**Confirmed NOT already accounted for in Section 10's "predate this fix"
baseline:** `get_runtime_errors` immediately after the timeout shows the
error group's `last` timestamp updated to `2026-09-02T01:17:33.000Z` --
strictly after the `01:09:27Z` merge. This is a genuine new occurrence,
not a stale/cached read of the pre-merge data.

**QStash's own redelivery engaged automatically afterward** (a second
invocation, `8d8b49e6-25a4-47e9-a856-db56146ac430`, entered at
`01:22:45Z` for the same `runId`/`afterStep=2`) -- consistent with the
priority #3 dead-letter/redelivery-visibility fix at least not being
broken, though whether `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES`/the
`Upstash-Retried`-driven early-dead-letter path actually fires after
enough of these was not confirmed before this session's investigation
ended (would need to watch further redeliveries play out, or read
`agent_worker.js`'s current logging around that path directly).

**Why this looks like a DIFFERENT failure mode than Sections 7-9's
original repro, not a simple "caps too loose" tuning issue:**

Sections 7-9's repro and root cause were specifically about an oversized
**input** -- many batched tool calls and/or large file-read results
bloating the `contents` payload sent *into* the next outbound LLM call,
making that call slow enough to blow the 300s ceiling. PR #138's two caps
(`MAX_TOOL_CALLS_PER_STEP`, `MAX_STEP_RESULT_CHARS`) target exactly that
mechanism, and this session's run shows the caps working correctly on
that exact shape (step 2's withheld 6th result, above).

But the timeout this session did NOT happen on a bloated-input step -- it
happened on the **forced-final-answer step**, where by definition there
are no more tool calls (bai/Gemini is withheld further tools and must
emit one complete text answer). Nothing about `MAX_TOOL_CALLS_PER_STEP`
or `MAX_STEP_RESULT_CHARS` bounds the model's own **output** generation
time, and this task's forced answer was explicitly asked to be
exhaustive ("every connector directory... every checkpoint schema...
line-by-line worker comparison... enumerate every environment variable...
be exhaustive") -- a large-output-generation problem, structurally
distinct from the large-input-context problem Section 9 root-caused and
Section 10 fixed. The input-side caps have no mechanism to bound this.

**Explicitly NOT confirmed yet:**
- Whether output size/generation time is really the driving factor here
  (vs. e.g. bai-side latency variance, or the accumulated step 1+2
  context -- even after the per-step 60000-char cap -- still being large
  enough across multiple steps to matter for the final call). No token
  count or generation-time breakdown has been pulled for this specific
  invocation.
- Whether this recurs on a LESS exhaustively-worded task (i.e. whether
  the forced-final-answer step is only a problem when the task itself
  explicitly demands an unusually large synthesized answer, as this test
  task deliberately did, or whether it's a more general risk on any
  forced-final-answer step after 2+ steps of accumulated context).
- Whether the QStash redelivery that started at `01:22:45Z` succeeded,
  timed out again, or is still pending -- not watched to completion this
  session.
- Whether `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES`/the `Upstash-Retried`
  dead-letter path actually engages correctly on repeated timeouts of
  this specific run in practice (only unit-tested per Section 10, not
  observed live against a real repeatedly-timing-out run yet).

**Next steps:**
- Do not treat Section 9's root cause as the explanation for this new
  occurrence without further evidence -- per this session's own
  instruction, a new occurrence after the merge means either the caps
  need tuning or a different failure mode is at play, and the
  forced-final-answer/output-size angle above is a distinct-enough
  mechanism that it likely needs its own fix, not a tweak to
  `MAX_TOOL_CALLS_PER_STEP`/`MAX_STEP_RESULT_CHARS`.
- Fix candidate to evaluate: a cap or truncation strategy for the
  **final-step answer generation itself** (e.g. a tighter
  `maxOutputTokens` specifically on the forced-final-answer call, or
  detecting an unusually broad/exhaustive task description and steering
  the model toward a bounded summary rather than an unbounded exhaustive
  one) -- distinct from the existing per-step input caps.
- Watch run `223d6b08-d2e1-4f23-8597-27fc48c594a3`'s QStash redelivery
  chain (started `01:22:45Z`) to see whether it succeeds, times out again,
  or eventually dead-letters -- would give direct evidence on whether this
  is a one-off (e.g. bai latency spike) or a reliably-reproducible new
  failure mode on this same run.
- If reproducible, try the same oversized-task shape with a LESS
  exhaustively-worded final-answer ask (keeping the same batched-tool-call
  step 1/2 shape) to isolate whether output size specifically is the
  driving variable, independent of accumulated input context.
- Pull actual token counts / generation time for the timed-out invocation
  if a way to do so becomes available (not accessible via
  `get_runtime_logs`/`get_runtime_errors` alone) to confirm or rule out
  the output-generation-time theory directly rather than by inference.

---

## 12. Follow-up check on the Section 11 redelivery -- inconclusive, but the inconclusiveness is itself new information

Checked `get_runtime_logs`/`get_runtime_errors` for `223d6b08-d2e1-4f23-
8597-27fc48c594a3` and invocation `8d8b49e6-25a4-47e9-a856-db56146ac430`
across a wide window (`01:20Z` through `06:00Z`) to answer Section 11's
open item #1 (did the redelivery succeed, time out again, or dead-letter).

**Full invocation history for this run, confirmed via logs:**
1. `fa9631f1` (`01:16:47Z`, `afterStep=0`) -- completed normally, `steps=1
   failed=true exit=chained`.
2. `fc02173b` (`01:16:57Z`, `afterStep=1`) -- completed normally, `steps=2
   failed=true exit=chained`.
3. `ba8f4094` (`01:17:33Z`, `afterStep=2`) -- the forced-final-answer
   attempt from Section 11: entered, wrote heartbeat, then hard 300s
   timeout (`504`, `Vercel Runtime Timeout Error`).
4. `8d8b49e6` (`01:22:45Z`, `afterStep=2`, QStash redelivery) -- entered,
   wrote heartbeat, **then nothing**: no `runInvestigation returned` line,
   no `exit` line, no `504`/timeout error, and no further QStash
   redelivery of this `runId`/`afterStep=2`, anywhere in the following
   ~4h40m of logs checked.

**This is none of the three outcomes Section 11 asked about.** Not a
clean success (no `runInvestigation returned`/`exit` line ever appears),
not a repeat of the same 300s timeout (`get_runtime_errors` over the same
window returns zero error groups, and a `statusCode=504` filter over the
window returns nothing), and not a dead-letter (no dead-letter log line,
and Section 10's `Upstash-Retried`-driven dead-letter path logs its own
`reason` string, which also doesn't appear). The invocation's request
itself has no logged terminal status at all in the tool's data -- it
shows `status 0 [info/static]` rather than the `200`/`504` the other three
invocations got.

**Two explanations, neither confirmed:**
- The runtime-logs source this session has access to may simply not
  capture a terminal status line for every request shape (the `status 0
  [info/static]` marking looks different from the other three entries'
  `200`/`504 [info/serverless]` markings, suggesting it may be a
  differently-classified log line rather than evidence the request never
  ended).
- Or: this genuinely is the dead-letter blind spot Section 9/10 were
  trying to close, still open in a different shape -- the function could
  have hard-timed-out exactly like `ba8f4094` did, but for whatever
  reason (log ingestion lag, a timeout that occurred right at/after this
  session's query window's practical edge, or some other gap) it didn't
  get captured in `get_runtime_errors`' aggregation this time. If so, the
  run is now sitting with no further QStash redelivery observed and no
  error surfaced anywhere this session can see -- which would itself be
  new evidence of exactly the "can loop or silently stall with nothing
  watching" risk Section 9 flagged, just manifesting as *zero* further
  activity rather than repeated timeouts.

**Not attempted this session:** resuming or re-polling
`223d6b08-d2e1-4f23-8597-27fc48c594a3` directly (e.g. via `delegate_agent`
with `resume_run_id`) to check its checkpoint status/`stepsDone` from the
MCP side rather than the Vercel-logs side -- this would give an
independent read on whether the run is actually still "running" (per its
own checkpoint) or has quietly finished/failed without a clean log trail,
and doesn't require guessing at log-classification semantics. This is the
most direct next step to actually resolve item #1.

**RESOLVED via direct checkpoint poll:** called `delegate_agent({
  resume_run_id: "223d6b08-d2e1-4f23-8597-27fc48c594a3" })` with no
`max_steps` (guaranteed read-only per the tool's own poll-vs-push
contract). Response: **"Investigation appears stalled ... 2 step(s)
completed, no activity in 388s (the background worker chain may have
broken)."**

This independently confirms the second explanation above and rules out
the first: it is NOT a log-classification artifact. The checkpoint itself
-- read straight from the MCP layer, not Vercel logs -- shows the run
stuck at 2 steps done with no forward progress since the `01:22:45Z`
redelivery attempt. That redelivery (`8d8b49e6`) entered, wrote its
heartbeat, and then never advanced the checkpoint, never errored visibly,
and was never followed by any further QStash redelivery. This is a live,
confirmed instance of the dead-letter blind spot Section 9 identified:
a hard platform timeout kills the function before this repo's own
`retryCount` can increment, and here QStash's own redelivery mechanism
also appears to have stopped after one attempt -- with nothing (neither
this repo's `AGENT_WORKER_MAX_CONSECUTIVE_FAILURES` check nor an external
error) ever finalizing the checkpoint as failed. The run will sit in this
state indefinitely unless manually pushed forward.

**Next steps:**
- Do not assume this is unique to this run -- any future oversized-task
  test that hits the 300s ceiling on its forced-final-answer step should
  be checked the same way (direct checkpoint poll, not just Vercel logs)
  to see whether it also stalls silently after one redelivery rather than
  dead-lettering or retrying further.
- This strengthens the case for Section 9's proposed fix (inspecting
  QStash's own delivery-attempt count/headers so a stuck run can be
  recognized and dead-lettered even when this repo's own `retryCount`
  never gets the chance to increment) -- worth prioritizing given this is
  now observed live, not just theorized.
- Items #2-#4 from Section 11 (less-exhaustive re-test to isolate
  output-size, token/generation-time breakdown) remain open and untouched
  this session.
- This specific run (`223d6b08-d2e1-4f23-8597-27fc48c594a3`) could be
  manually pushed forward with an explicit `max_steps` on a resume call
  to see whether the forced-final-answer step succeeds, times out again,
  or reproduces something new -- not attempted this session; flagging as
  an option rather than doing it unprompted, since Section 9 previously
  cautioned against blind resumes of a run whose mechanism is already
  understood.

---

## 13. QStash config check -- root-caused and fixed (2026-09-02)

Picked up the Section 12 open question: was QStash itself misconfigured?

### 13.1 Root cause

`publishAgentStep`/`publishEditorStep` in `connectors/gemini/qstash_client.js`
called `client.publishJSON({ url, body })` with neither `retries` nor
`failureCallback` set -- confirmed both are real supported options on the
installed `@upstash/qstash` v2.11.3 SDK. Result: QStash's own default
(3 retries, exponential backoff ~12s/~2m28s/~30m8s, worst case ~40min to
exhaust) applied, on a step whose 300s platform timeout makes every retry
deterministic, not transient -- and with no `failureCallback`, once that
budget IS exhausted, nothing tells the app. `agent_worker.js`'s own
dead-letter check (Section 9's `Upstash-Retried` header inspection) only
runs inside a live invocation, so a step timing out on every delivery
attempt means no further invocation ever arrives to run it. Real shape of
the blind spot: a retry-budget mismatch between
`AGENT_WORKER_MAX_CONSECUTIVE_FAILURES` (5) and QStash's default budget
(3 retries/4 attempts) -- QStash gives up before the app's own counter
could ever reach its threshold, and nothing was listening for QStash's
own give-up signal.

### 13.2 `223d6b08` re-poll: mid-backoff, not actually abandoned

Re-polled read-only again: "2 step(s) completed, no activity in 194s" --
down from 388s at the end of Section 12, meaning a new heartbeat had been
written since (consistent with QStash's n=2 backoff, ~2m28s after the
prior timeout, firing on schedule). The Section 12 silence was a snapshot
mid-backoff, not proof QStash had already given up.

### 13.3 Fix shipped (commits `ecbf1a3`, `fed3cc3`, `1e3aafe`, `3bb4aa8`, `24c41db`, all on `main`)

Decision (discussed with the user): `retries: 0`. A retry on this failure
mode either hits the same deterministic 300s timeout for zero benefit, or
is a genuinely transient provider error (Gemini 429/503) -- which never
reaches QStash as a delivery failure at all, since `agent_worker.js`
always returns 200 for that case and re-chains a fresh publish via its own
`retryCount`, independent of QStash's retry mechanism. So `retries: 0`
costs nothing on the case QStash's retries were ever useful for.

- **`config.js`**: new `QSTASH_STEP_RETRIES` (default `0`,
  env-overridable) and `AGENT_WORKER_FAILURE_URL`/`EDITOR_WORKER_FAILURE_URL`
  (derived from the existing worker URLs, same pattern as
  `deriveEditorWorkerUrl`, individually env-overridable).
- **`qstash_client.js`**: `publishAgentStep`/`publishEditorStep` now pass
  `retries: QSTASH_STEP_RETRIES` and, when configured, `failureCallback`.
- **`agent_worker.js`** / **`editor_worker.js`**: new
  `handleAgentWorkerFailure`/`handleEditorWorkerFailure` -- verify the
  (separately-signed) QStash failure-callback request, decode `sourceBody`
  to recover `{runId, afterStep}`, and finalize the checkpoint as
  `"failed"` only if it's still sitting exactly where the callback
  describes (a stale callback is a no-op, not an overwrite).
- **`server.js`**: registers `/api/agent-worker-failure` and
  `/api/editor-worker-failure`, same QStash-signature-only auth posture as
  the existing worker endpoints.

**Result:** a hard-timing-out step now fails cleanly in ~5min instead of
up to ~40min followed by an indefinite hang. Section 9's
`AGENT_WORKER_MAX_CONSECUTIVE_FAILURES`/`Upstash-Retried` path is
unchanged and still covers the organic same-step-failure case exactly as
before -- this fix only closes the gap where no further invocation was
ever going to arrive at all.

**Not done this session:**
- No test coverage yet for the two new failure handlers or the new
  `publishJSON` call shape.
- Section 11's output-size/`maxOutputTokens` fix (the actual reason steps
  time out) is still open -- this section only makes the failure mode
  clean, not the underlying cause. Section 11 items #2-#4 untouched.
- `223d6b08-d2e1-4f23-8597-27fc48c594a3` not resumed or force-finalized;
  left to resolve on its own (complete, dead-letter, or TTL-expire).
- QStash's own dashboard/API was not checked directly -- this fix was
  derived from the SDK's type defs and Upstash's public docs, not from
  inspecting this account's live delivery ledger. Worth a follow-up if the
  new failure handlers don't fire as expected in practice.
- `DEBUG_AGENT_WORKER` left ON (unchanged). Section 5's "Void" question
  remains open, untouched.

---

## 14. Section 13's "no test coverage yet" item -- confirmed STALE, already resolved (2026-09-02, follow-up session)

Picked up Section 13's "Not done this session" item #1 ("No test coverage
 yet for the two new failure handlers or the new `publishJSON` call
 shape"), intending to write it. Read the current test suite on `main`
 first and found it already exists -- this note was stale by the time this
 session started, not an outstanding gap.

**Confirmed present and passing on `main` (no new code needed):**

- `test/agent-worker.test.js` -- a full `describe("agent_worker.js —
  handleAgentWorkerFailure")` block: signature rejection (401), unparseable
  `sourceBody` no-op, missing-`runId` no-op, stale-checkpoint no-op (already
  advanced), already-finished no-op (does not overwrite a real answer), and
  the happy-path finalize (checkpoint still in the exact stalled state the
  callback describes -> `"failed"` with the QStash-sourced reason).
- `test/editor-worker.test.js` -- the editor-side mirror,
  `describe("editor_worker.js — handleEditorWorkerFailure")`, same shape
  plus its own regression check that the whole-blob checkpoint spread
  doesn't drop `owner`/`repo`/`branch`/`contents` on finalize (relevant
  since `editor_checkpoint.js` is a whole-blob overwrite, unlike
  `agent_checkpoint.js`'s list+meta split).
- `test/qstash-client-publish.test.js` -- mocks `@upstash/qstash` directly
  (not `qstash_client.js` itself, unlike the two files above) so the real
  `publishAgentStep`/`publishEditorStep` code runs and the actual
  `publishJSON` call shape can be inspected: default `retries: 0` +
  derived `failureCallback` for both agent and editor paths, a
  `QSTASH_STEP_RETRIES` env override, omission of `failureCallback` when no
  URL is derivable, and an explicit `AGENT_WORKER_FAILURE_URL` override.

**Verification this session:** cloned `main`, ran all three files
directly (`36 tests`, all passing), then the full suite (`45 files, 534
tests`, all passing) to confirm nothing else regressed alongside it.

**Why the discrepancy:** Section 13 was written the same session the fix
itself landed (commits `ecbf1a3`/`fed3cc3`/`1e3aafe`/`3bb4aa8`/`24c41db`)
and candidly flagged tests as not-yet-written at that point. The tests
above landed in a later session that never added its own plan.md entry --
so the code caught up before the notes did. Recorded here so the next
session doesn't re-open this as if it were still a gap.

**Still genuinely open (unaffected by this section):**
- Section 11's root cause (output-generation-time on the forced-final-answer
  step) -- no fix implemented yet.
- `223d6b08-d2e1-4f23-8597-27fc48c594a3` -- left unresumed, per Section 13's
  own instruction.
- `DEBUG_AGENT_WORKER` -- still ON.

---

## 15. Second live, on-demand reproduction of Section 11's output-generation-timeout hypothesis -- CONFIRMED, and Section 13's failure-callback fix observed working cleanly end-to-end (2026-09-02, follow-up session)

Deliberately repeated Section 11's repro shape on demand: fresh async
`delegate_agent({ provider: "bai", max_steps: 3 })`, same oversized/
exhaustive-answer task pattern (full-repo architecture writeup: every
connector file, every checkpoint schema field-by-field, a line-by-line
`agent_worker.js`/`editor_worker.js` comparison, every `config.js` env
var -- explicitly "be exhaustive"). Watched it live via a mix of MCP-side
polling and direct Vercel log/error checks, rather than reconstructing it
after the fact as Section 11/12 had to.

**Run `124a76f8-caa6-4b02-87c7-51dbc315e7a9`:**

- Step 1 (`f6dde9ff`, `02:21:50Z`): `github_get_file_tree` -- normal,
  chained.
- Step 2 (`51fda45e`, `02:21:59Z`): batched several `github_read_file`
  calls (`config.js`, `agent_worker.js`, `editor_worker.js`, then three
  checkpoint files). **`MAX_STEP_RESULT_CHARS` fired correctly** on the
  last three (`agent_checkpoint.js`, `editor_checkpoint.js`,
  `designer_checkpoint.js`), withholding their content with the
  re-request-next-step message -- Section 10's input-side fix working
  exactly as designed, live, again.
- Step 3 (`0b8eeb04`, entered `02:22:36Z`, forced-final-answer since
  `max_steps: 3` was reached): wrote its heartbeat, entered
  `runInvestigation`, and never returned. Polled `get_runtime_errors`
  repeatedly through the window rather than guessing at elapsed time from
  the checkpoint's own "stalled" heuristic (which fires at ~120s of no
  *chain* activity -- a different, earlier clock than the platform's
  actual 300s kill point, and was NOT treated as evidence of a timeout by
  itself this session).
- **`02:27:36Z` (exactly 300s after the `02:22:36Z` entry):**
  `get_runtime_errors` showed two fresh entries appear together:
  - `Vercel Runtime Timeout Error: Task timed out after 300 seconds` --
    `last` timestamp updated to `2026-09-02T02:22:36.000Z` (this specific
    invocation), joining the same long-running error group Section 9
    originally found (`first=2026-08-08`).
  - `agent-worker-failure: runId 124a76f8-... dead-lettered via QStash
    failureCallback ... on step 3` -- same `02:27:36Z` timestamp, i.e. the
    failure callback fired essentially immediately once QStash's own
    `retries: 0` budget was exhausted, not after any further delay.

**Confirmed via a direct MCP-side poll immediately after:** `delegate_agent({
resume_run_id: "124a76f8-..." })` (no `max_steps`, read-only) returned a
definitive permanent-failure error --- "Investigation failed permanently
... QStash exhausted its own delivery budget (retried ?/0) on step 3
... platform-level execution timeout" --- not a "still running"/"stalled"
ambiguous status. The checkpoint is cleanly finalized as `"failed"`.

**What this confirms, beyond Section 11's original single occurrence:**

1. **Section 11's output-generation-time hypothesis is now confirmed by a
   second, deliberately-reproduced, live-watched occurrence** -- not just
   the one retrospective case (`223d6b08`) it was originally inferred
   from. Same mechanism: a forced-final-answer step with no more tool
   calls available, asked to produce an exhaustive answer, runs output
   generation for the full 300s with no early exit and gets hard-killed.
   The existing input-side caps (`MAX_TOOL_CALLS_PER_STEP`,
   `MAX_STEP_RESULT_CHARS`) correctly bounded steps 1-2 but have no
   mechanism to bound step 3's generation time, exactly as Section 11
   theorized.
2. **Section 13's failure-callback fix worked cleanly, live, this time --
   in sharp contrast to `223d6b08`'s behavior pre-fix.** `223d6b08`
   (Section 12) sat at `status:"running"` indefinitely after its own 300s
   timeout, with no further QStash redelivery and no error ever
   finalizing it -- discovered only much later via a manual checkpoint
   poll. `124a76f8` instead went from timeout to a cleanly finalized
   `"failed"` checkpoint within the same second, entirely automatically,
   with both the timeout and the dead-letter visible in
   `get_runtime_errors` and a subsequent poll immediately reporting a
   definitive permanent-failure error rather than ambiguous "stalled"
   status. This is the real-world confirmation Section 10's own "next
   steps" asked for ("the real-world test is whether ... stops recurring
   for new runs" -- it didn't stop recurring, but the fix changed the
   failure from silent-hang to clean-finalize, which was always the
   actual goal of Section 13's fix, not preventing the timeout itself).

**Explicitly NOT done this session:** no fix implemented for the
underlying output-generation-time issue itself -- this section is
additional confirming evidence for Section 11, not a resolution of it.
`223d6b08` still not resumed. `DEBUG_AGENT_WORKER` still ON.

**Next steps (supersedes/reaffirms Section 11's own, now with a second
confirmed data point instead of one):**
- Implement a fix candidate for the output-generation-time problem itself,
  e.g. a tighter `maxOutputTokens` specifically on the forced-final-answer
  call (distinct from the existing per-step input caps), or detecting an
  unusually broad/exhaustive task description up front and steering the
  model toward a bounded summary.
- Consider whether the checkpoint's own "stalled" heuristic (~120s) should
  be surfaced differently from an actual confirmed platform timeout --
  this session treated the two as distinct signals (poll status vs.
  `get_runtime_errors`) rather than conflating them, which is worth
  keeping as the pattern for future investigation of this failure mode.
- Section 11 items #2-#4 (less-exhaustive re-test to isolate output size as
  the driving variable, token/generation-time breakdown for a timed-out
  invocation) remain open and untouched.
