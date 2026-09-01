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
