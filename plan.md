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

**Re-ran the original bai key-rotation test with the fix in place:**
started a fresh async `delegate_agent({ provider: "bai", max_steps: 3 })`
run (`run_id: e6c0ee61-129c-42e9-a698-239557f83567`) to confirm the run
now actually stops at the requested ceiling instead of drifting to the old
default of 20. First poll: 0 steps done, 2s since start (freshly seeded,
worker not yet chained far enough to observe the cap in effect). Continue
polling this run_id (spaced out, not repeatedly) to confirm it halts at or
before step 3 rather than continuing past it -- this is the final
outstanding item from the original next-steps list.

**Updated overall status:** of the original 5 next-steps items, #1
(fix bug #3) and #2 (check editor path) are now fully closed. #3 (read
agent_worker.js) is done -- see the DEBUG_AGENT_WORKER finding above,
which narrowed but did not resolve it. #4 (re-test bai with the fix) is
in progress (see run above). #5 (Void investigation) remains open per
Section 5, unchanged.
