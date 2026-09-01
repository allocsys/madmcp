# Findings: B.AI provider testing (2026-09-02)

Context: `connectors/bai/client.js`'s bounded 2-pass key-rotation retry
loop (`MAX_KEY_ROTATION_PASSES = 2`) and the Gemini model-first cascade
reorder (`connectors/gemini/client.js`, PR #137 / commit `befdcda`) were
merged to `main` in prior sessions. This session re-tested the bai path
via `delegate_agent({ provider: "bai" })` against this repo.

---

## 1. Code-level verification (confirmed)

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
  through to the next key, since bai has no inner model loop to fall out of.
- Early-exit: if a whole pass makes zero live attempts (every key already
  cooling), the loop stops without wasting a second pass.
- Aggregate exhaustion error tags `.transient = true` only if every
  contributing attempt was itself transient-shaped.

`test/bai-client.test.js` covers rotation on 429/401/403, cooldown-skip
behavior, the aggregate error (incl. `.transient`), non-retryable statuses
re-thrown immediately, and `_fallbackKeyIndex` tagging.

**Conclusion: the retry loop is correctly implemented and unit-tested.**

---

## 2. Live-run verification (inconclusive by design, not by bug)

Ran a real `delegate_agent({ provider: "bai", max_steps: 15 })`
investigation task (20 steps, all bai-backed). It completed cleanly with
no rate-limit/cooldown activity visible in the transcript -- no key ever
hit pass 2, no `_fallbackKeyIndex` tagging appeared.

This confirms the bai path works end-to-end under normal conditions, but
it does **not** exercise the specific "a key's cooldown clears mid-call
and gets retried on pass 2" scenario, since no key was ever rate-limited
during this run. That scenario can't be forced from outside the process
(no control over B.AI's live rate-limit state), so live runs are not a
reliable way to confirm it -- the existing mocked unit tests in
`test/bai-client.test.js` are the actual source of confidence here, not
this session's live run.

---

## 3. Bug found: `max_steps` not enforced on `bai`-provider runs

While stress-testing with a deliberately heavy task and `max_steps: 3`,
the run blew through the cap -- observed at **14, then 15** completed
steps (still climbing) against a requested ceiling of 3, with no forced-
answer cutoff. Per `delegate_agent`'s own tool description, `max_steps`
is supposed to cap tool-use turns before the run is forced to answer
(default 20, hard cap 30 regardless of the passed value) -- 3 was neither
honored nor did the hard-cap-independent behavior kick in as documented.

**Not yet root-caused.** Open questions for the next session:

- Is `max_steps` actually threaded through to the bai-provider branch of
  the agent loop (`agent_delegate.js` / wherever provider dispatch
  happens), or does the bai path silently ignore it and fall back to some
  other default/hard-cap?
- Is this bai-specific, or would the same test against `provider: "gemini"`
  also blow past a `max_steps: 3` cap? (Not yet tested -- needed to
  isolate whether this is a provider-dispatch bug or a general step-budget
  bug that happens to have been noticed on the bai path.)
- Given the plan.md history (now replaced by this file) around
  `singleStep` vs. `max_steps: stepsDone + 1` NOT being equivalent for the
  editor's async port -- worth checking whether `agent_delegate.js`'s own
  step-counting has a similar off-by-logic gap that only manifests for
  certain providers or call shapes.

**Why this matters beyond the immediate test:** if step budgets are this
loose, it suggests the enforcement mechanism itself may be unreliable
more broadly (cost control, runaway-loop protection, dead-letter/retry
budget interactions), not just a cosmetic mismatch between requested and
actual step count on this one call.

**Next step:** root-cause where `max_steps` is supposed to be read/enforced
in the bai dispatch path, add a regression test pinning the cap, and check
whether `gemini`-provider runs have the same gap.
