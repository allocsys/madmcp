# Plan: Add GLM (via OpenRouter) as a switchable alternative to Gemini

**STATUS (2026-08-27, latest):** `provider: "gemini"` is the only
provider anyone should route real `delegate_agent` work through.
`provider: "glm"` and `provider: "groq"` both stay wired on `main`
exactly as built (opt-in only, `DEFAULT_LLM_PROVIDER` unchanged, no code
removed) but are both blocked for different reasons (see "Provider
status" below). Effort has shifted to a Gemini accuracy problem
(self-verification pass + structural line-quote check). Repeated live
testing (Runs 1-8, see "Live verification test") shows both fixes help
but don't close the confident-wrong-relationship pattern -- Run 8 shows
it generalizing beyond the original verification-pass-gate question to
at least one other mechanism (dedup cache scope).

## Why

`delegate_agent`/`delegate_designer` were hard-wired to Gemini. Gemini's
code-review/investigation output is mixed and prone to logic errors on
some tasks, so GLM (via OpenRouter) was added as a second option,
selectable per-call via a `provider` argument (default `gemini`). Groq
was added later as a third option when GLM turned out to be blocked.

Model: **`z-ai/glm-4.6`** (default) / **`z-ai/glm-4.5-air`** (paid
fallback; the `:free` slug was found retired mid-implementation).

## Non-goals

- `delegate_designer` not touched by this plan -- see "Designer notes."
- Not auto-picking "whichever model is best" -- explicit opt-in `provider`
  argument only.
- Not deprecating Gemini. Default stays Gemini.

## Architecture (as built)

```
connectors/llm/router.js       -- providerChat(contents, {provider, tools,
                                    model, maxOutputTokens}): picks gemini|
                                    glm|groq, always returns Gemini-shaped
                                    candidate
connectors/gemini/client.js    -- unchanged, Gemini's native wire format
connectors/gemini/cooldown.js  -- isModelCoolingDown/setModelCooldown take
                                    optional `namespace` (default "gemini");
                                    glm passes `glm:${keyIndex}`, groq
                                    passes `groq:${keyIndex}`
connectors/gemini/agent_checkpoint.js -- meta blob stores provider/model/
                                    maxOutputTokens/pendingVerification,
                                    restored on resume
connectors/gemini/agent_delegate.js   -- runInvestigation loop, provider-
                                    agnostic; calls router.js. Also:
                                    validateFunctionArgs() before execute(),
                                    normalizedSignature() dedup guard,
                                    self-verification pass (see below)
connectors/gemini/agent_tools.js      -- delegate_agent MCP schema:
                                    `provider` (zod enum incl. groq),
                                    `model`, `maxOutputTokens` args
connectors/glm/client.js       -- OpenRouter HTTP client: outer cascade
                                    over OPENROUTER_API_KEYS, inner cascade
                                    over GLM_MODEL + GLM_FALLBACK_MODELS
connectors/groq/client.js      -- same pattern as glm/client.js, over
                                    GROQ_API_KEYS + GROQ_MODEL +
                                    GROQ_FALLBACK_MODELS
connectors/glm/adapter.js      -- toOpenAIMessages/toOpenAITools/
                                    fromOpenAIChoice: shared OpenAI-shape
                                    translation, used by both glm and groq
                                    clients (chose shared-module option,
                                    not duplicated)
```

Config added to `config.js`: `OPENROUTER_API_KEYS`, `GLM_MODEL`,
`GLM_FALLBACK_MODELS`, `GLM_REQUEST_TIMEOUT_MS`,
`GLM_DEFAULT_MAX_OUTPUT_TOKENS` (8192), `GROQ_API_KEYS`, `GROQ_API`,
`GROQ_MODEL` (`openai/gpt-oss-120b`, production-tier), `GROQ_FALLBACK_MODELS`
(`qwen/qwen3.6-27b`, preview-tier, may disappear without notice),
`GROQ_REQUEST_TIMEOUT_MS`, `GROQ_DEFAULT_MAX_OUTPUT_TOKENS` (4096),
`DEFAULT_LLM_PROVIDER` (default `"gemini"`).

**Known, accepted asymmetry:** Gemini's `MALFORMED_FUNCTION_CALL`
finishReason has no OpenAI-API equivalent, so GLM/Groq's failure message
on that edge case is generic rather than pointing at the real cause. Not
something to patch in the adapter.

## Tests

`test/glm-client.test.js`, `test/glm-adapter.test.js`,
`test/llm-router.test.js` (dispatch across all 3 providers),
`test/groq-client.test.js`, `test/agent-delegate-loop.test.js`
(stuck-loop/step-budget/checkpoint-resume/dedup/verification-pass,
parametrized across providers) -- all green in CI. Full suite as of the
verification-pass PR: 24 files, 350 tests.

## Provider status

**GLM (OpenRouter) -- parked, not being actively fixed.** Confirmed
non-functional: this account's OpenRouter balance is zero and the owner
has declined to top up. A zero-balance account is blocked from BOTH paid
and free GLM routes, in three distinct ways confirmed by live testing:
paid slugs 402 immediately ("requires more credits, or fewer max_tokens");
the nominally-free slug still 402s on prompt-token budget once past the
completion-token cap; and a minimal no-tool call on the free slug 404s
outright ("This model is unavailable for free"). Not fixable by model
selection, prompt size, or output-cap tuning -- needs a positive account
balance first. `provider: "glm"` remains wired and will resume working
immediately once funded, no code changes needed.

**Groq -- parked, not being actively fixed.** Confirmed NOT
balance-gated (unlike GLM) -- Groq's free tier really is request/
token-rate-limited. But `delegate_agent`'s own ~30-tool schema, sent in
full on every turn, is large enough on its own to consume most/all of an
8000 TPM budget in a single request -- confirmed via live 3-stage smoke
test (no-tool single call: fine; multi-step tool task at defaults: 413
"Requested 10303" against an 8000 limit; same task pinned to primary
model + reduced maxOutputTokens: succeeds step 1, then 429 on step 2
with "Used 6259" of 8000 TPM already gone). Lowering `maxOutputTokens`
doesn't help -- the bottleneck is prompt-side (tool schema +
accumulating conversation), which that setting doesn't cap. Options not
yet decided: paid/dev Groq tier, a leaner groq-specific tool schema
(cuts against delegate_agent's whole-connector-coverage premise), or
confirming the TPM window length to make inter-step pacing viable. Until
decided, treat `provider: "groq"` like `glm`: wired, live, but not for
real work yet. `DEFAULT_LLM_PROVIDER` remains `"gemini"`.

**Gemini -- the only usable provider, with a known-and-patched accuracy
issue.** A 13-step live run found Gemini confidently giving a wrong
answer about its own codebase: it had the complete file in context from
its first tool call, but its final synthesis trusted a later, narrower
`github_search_code` snippet (which only showed a function's definition
line, not its call site) over the full file already read. Not an
infrastructure failure -- a real reasoning/synthesis error. Fixed (see
"Gemini harness fix" below); see "Live verification test" for the first
live result against a heavy task post-fix.

## Gemini harness fix -- self-verification pass

Two changes targeting the specific "trusts narrow/late result over an
earlier full read" failure mode (not a full loop rewrite):

1. **SYSTEM_PREAMBLE rule:** when a full/direct read (`github_read_file`,
   `github_get_file_at_commit`, `notion_get_page`, etc.) and a narrower/
   derived result about the same fact disagree, the full/direct read
   wins, even if the narrower result came later in the conversation.
2. **Mandatory one-time self-verification pass:** the first time the
   model produces a draft final answer (no function calls) WITH tool
   budget still available (`step < cappedSteps`, not a forced no-tools
   turn), the loop does NOT return it immediately. It pushes the draft
   back with a `VERIFICATION_PROMPT` -- a structurally tools-withheld
   turn (same mechanism class as `isFinalStep`/stuck-loop forcing, not
   just a text nudge) instructing the model to re-check every claim
   against the RAW tool results already in context, applying rule (1).
   Whatever comes back is what's actually returned. If no steps remain
   when the draft arrives, verification is skipped and the draft is
   returned as-is (no budget to check twice).

**Cost:** one extra provider call/step on every run that would otherwise
finish with budget to spare (a 3-step run becomes 4). Deliberate
accuracy-for-cost tradeoff. Lives in the provider-agnostic loop body, so
it'll apply to GLM/Groq too whenever those are unparked.

**State threading:** `pendingVerification` boolean threaded through
checkpoint save/load exactly like `consecutiveAllRepeatSteps`/
`repeatCounts`, defaulted `false` for pre-existing checkpoints. A run
that dies mid-verification resumes back into the verification turn
rather than silently drafting a new answer.

Merged and green in CI (24 files, 350 tests). Branch:
`gemini-verification-pass`.

## Structural line-quote check (commit `4ff4260` follow-up, fix for Run 5 gap)

Run 5 (below) showed the citation-forcing fix (`extractMechanicalClaims`/
`findUnverifiedClaims`) does not catch a fabricated RELATIONSHIP between two
real, individually-verifiable identifiers (`step < max_steps - 1` asserted
when the real code is `step < cappedSteps` -- both `step` and `max_steps`
really do appear in fetched source, so a token-presence check alone passes).

Research direction (arxiv 2512.12117 "Citation-Grounded Code Comprehension",
CoVe arxiv 2309.11495, "Tool Receipts" arxiv 2603.10060): self-verification
via LLM judgment is weak; mechanical/structural verification against ground
truth is what works. Applied here as two changes in
`connectors/gemini/agent_delegate.js`:

1. **`CONDITIONAL_CLAIM_PATTERN`/`extractConditionalClaims`:** a second,
   stricter claim class alongside the existing identifier-token check --
   flags claims shaped like a conditional/comparison expression (contains
   `<`, `>`, `===`, `&&`, `||`, etc., either backtick-quoted or as bare
   `identifier op identifier` text), since these need the exact-line-quote
   treatment below rather than mere token presence.
2. **`LINE_QUOTE` mechanism (`lineIsVerbatimInToolResults`,
   `extractLineQuotes`, `stripLineQuoteMarkers`):** for each flagged
   conditional claim, the verification prompt now requires the model to
   quote the exact literal source line, in a fixed `LINE_QUOTE: <line>`
   format. That quote is checked with a plain JS `.includes()` against raw
   tool-result text already in `contents` -- not another LLM judgment call.
   A failed check triggers exactly ONE bounded corrective round
   (`structuralRecheckUsed`, single-fire like `pendingVerification`), after
   which whatever comes back is accepted as final. `LINE_QUOTE:` marker
   lines are stripped before any answer is returned to a caller.

Per CoVe's factored-verification finding (verification questions posed
without re-showing the model its own prior draft wording, to avoid
anchoring), the correction note explicitly instructs a fresh re-read rather
than re-confirming from the existing draft/scrollback.

**State threading:** `structuralRecheckUsed` persisted through
checkpoint save/load exactly like `pendingVerification`, defaulted `false`
for pre-existing checkpoints.

**Tests:** `test/agent-delegate-loop.test.js` -- new regression test
confirms a draft with a plausible-but-wrong composed conditional (real
identifiers, wrong relationship) is flagged and corrected via exactly one
bounded structural round, even though a token-level check alone would pass
it; also confirms `LINE_QUOTE` markers never leak into a returned answer.
Full suite: 24 files, 362 tests, all green.

### Run 6 (2026-08-27, re-run against `gemini` on the structural-line-quote build)

First live re-test against this build. Note on comparability: the exact
verbatim task text used in Runs 1-5 was not available when this run was
kicked off (it lived in an earlier chat session, referenced but not
quoted in the handoff that led to this fix), so this run used a
reconstructed task asking the same six mechanical questions the Runs
table already tracks, worded fresh rather than replayed verbatim. Treat
as comparable in substance, not a byte-for-byte repeat.

**Result: all six questions answered correctly, including question (2)
-- the exact verification-pass gate condition -- which was the specific
question that came back confidently wrong in Runs 3, 4, and 5.** Verbatim
match against source: `answer && !withholdTools && !pendingVerification
&& step < cappedSteps`. Question (6) (asked fresh this round, on the
structural line-quote mechanism itself) was also answered correctly:
named `extractConditionalClaims`/`extractLineQuotes`/
`lineIsVerbatimInToolResults` and described the single-bounded-round
behavior accurately. Commit `4ff4260`'s follow-up (this fix) was also
correctly confirmed present and test-covered.

One minor, non-substantive slip on question (5): the model described the
verification-pass tools argument as `FUNCTIONS` rather than the actual
`FUNCTION_DECLARATIONS` -- the claim about WHEN tools are withheld
(`withholdTools` gate) was correct, only the variable name was off, and
that name was never asked for or asserted as an exact quote, so the
structural line-quote check had no reason to flag it.

**Caveat, consistent with this file's existing pattern of not
overclaiming from one data point:** this is the first fully clean run in
the series, but two of the three earlier fixes (tool-access-during-
verification; extractMechanicalClaims/findUnverifiedClaims) also looked
solved after their own initial passes before failing on a later run.
Treat this as real evidence the structural line-quote check catches the
specific failure class it targets, not as proof the confident-wrong
pattern is fully closed. Repeating this test a few more times, per the
open question below, remains the way to raise confidence further.

### Run 7 (2026-08-27, re-run against `gemini` on the same structural-line-quote build)

Same reconstructed six-question task as Run 6, run again. Hit the same transient
Gemini 503 ("high demand") mid-run (step 11 this time, vs step 10 in the
earlier "Live verification test" run below) -- resumed cleanly via
`resume_run_id` with the 10 already-completed steps intact, second live
confirmation the resume path holds under a genuine provider failure.

**Result: all six questions answered correctly again.** Unlike Run 6, this
time every claim was independently re-checked directly against the raw source
(not just trusting the run's own citations) by fetching
`connectors/gemini/agent_delegate.js` in full outside the delegated run:

- (1) `validateFunctionArgs()` before `execute()`: confirmed -- every code path
  that reaches `fn.execute()` passes through `validateFunctionArgs(fn, args)`
  first (cache-served repeats and unknown-function calls never reach
  `execute()` at all, so the check is unconditional relative to the
  `execute()` call site itself, which is exactly what was claimed).
- (2) verification-pass gate: verbatim match --
  `if (answer && !withholdTools && !pendingVerification && step < cappedSteps)`.
  This is the exact question that came back confidently wrong in Runs 3, 4,
  and 5, and right again in Run 6 and now Run 7.
- (3) key-order-insensitivity: confirmed -- `Object.keys(a).sort()` into a
  fresh `sortedArgs` object before stringifying.
- (4) named-branch exclusion: confirmed -- `isHeadLike` only matches
  `undefined`/`null`/`""`/`"HEAD"`; a `ref:"main"` call is deliberately never
  collapsed into the no-ref signature even when `main` is the default branch.
- (5) tool access during verification: confirmed -- `withholdTools` is
  `isFinalStep || stuckLoopForce` only; the verification-pass branch does not
  add `pendingVerification` to that condition, so `FUNCTION_DECLARATIONS` are
  still sent on that turn.
- (6) structural line-quote mechanism: confirmed -- `extractConditionalClaims`
  flags comparison-shaped claims, `lineIsVerbatimInToolResults` checks a
  model-quoted `LINE_QUOTE:` line via plain `.includes()` against raw tool
  output, bounded to one corrective round by `structuralRecheckUsed`.

**Updated running tally:** 2 of the last 2 runs against the structural-line-
quote build (Runs 6-7) are now fully clean, versus the earlier pattern (Runs
3-5) where the same question (2) failed three times in a row before the fix.
Still only two data points on this specific build -- consistent with this
file's standing caution against overclaiming from one (or two) clean runs --
but the specific failure mode (fabricated relationship between two real
identifiers) has now gone 2-for-2 since the fix, including under independent
re-verification against source rather than relying on the delegated run's own
citations.

## Repeat/redundant tool-call dedup fix (PR #108, merged)

Found via a heavier open-ended task hitting a 429 quota exhaustion at
step 17/25 after repeatedly re-reading the same file with no new
information. The existing repeat-detection cache (keyed on
`${name}:${JSON.stringify(args)}`) had two gaps, both fixed in
`normalizedSignature(name, args)`:

1. **Key-order sensitivity:** `JSON.stringify` depends on key insertion
   order. Fixed by sorting keys (`Object.keys(a).sort()`) before
   stringifying -- confirmed order-insensitive by direct code read and
   by test (`normalizedSignature`'s dedicated test case).
2. **No semantic equivalence across tools:** `github_read_file` (no ref)
   and `github_get_file_at_commit(commit: "HEAD")` on the same path
   return identical content but were never recognized as equivalent.
   Fixed via `READ_FILE_SIGNATURE_FAMILY`: both collapse to one
   canonical `(owner, repo, path)` signature when the ref/commit is
   omitted, empty, or the literal `"HEAD"`. **Deliberately does not**
   resolve a named branch (e.g. `"main"`) that happens to currently
   equal the default branch -- that would need an extra API call per
   dedup check, a bad latency/cost trade. Confirmed live (see "Live
   verification test" below): a `ref:"main"` call was correctly NOT
   collapsed with a no-ref call on the same file.

Text-only SYSTEM_PREAMBLE guidance (telling the model re-reading won't
help) was considered and rejected in favor of the structural cache fix
alone, consistent with this codebase's existing pattern of not trusting
text-only nudges for loop-control guarantees.

## Live verification test (2026-08-27, post-merge)

First live `delegate_agent` run (provider `gemini`, `max_steps: 25`)
against a genuinely heavy, open-ended, multi-file task (4 planted
mechanical questions). This is "Run 1" in the table below. Findings:

- **Resume path exercised for real:** hit a transient Gemini 503 at step
  10; `resume_run_id` continued the checkpoint cleanly -- first live
  (non-mocked) confirmation resume survives a genuine mid-run failure.
- **Verification pass fired:** step count exceeded visible tool-call
  count, consistent with a draft step plus one no-tools verification step.
- **Dedup fix confirmed live:** 3 exact-signature repeats correctly
  served from cache; a `ref:"main"`-after-no-ref variant correctly NOT
  collapsed (deliberate design), though still wasted model effort.
- **Answer quality:** 2/4 correct and specific, 2/4 hedged rather than
  wrong -- see table below for how this evolved over later runs.

### Runs 2 and 3 (same task, re-run against `gemini`)

| Question | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|---|---|---|---|---|---|
| (1) `validateFunctionArgs` unconditional before `execute()` | hedged | correct | correct (less precise) | correct | correct |
| (2) verification-pass skip condition | hedged | correct | **wrong** | **wrong (fabricated)** | **wrong (fabricated + backwards)** |
| (3) key-sort order-insensitivity | correct | correct | correct | correct | correct |
| (4) named-branch exclusion | correct | correct | correct | correct | correct |
| (5) tool access available during verification pass itself | -- | -- | -- | **wrong (fabricated + backwards)** | correct |
| (6, new) exact citation-forcing mechanism (post-4ff4260) | -- | -- | -- | -- | correct |

Run 2 answered point (2) correctly: the skip condition is `step <
cappedSteps`. Run 3 instead asserted the gate was `step < HARD_MAX_STEPS`.
Checked directly against `connectors/gemini/agent_delegate.js`
(`runInvestigation`): the real condition is

```js
if (answer && !withholdTools && step < cappedSteps) {
```

where `cappedSteps = Math.min(max_steps, HARD_MAX_STEPS)` -- the
effective per-call ceiling, not the fixed platform-wide `HARD_MAX_STEPS`
(30) that only feeds into computing it. These are genuinely different
whenever a caller passes `max_steps` below 30, which is exactly what our
test calls do (`max_steps: 25`). So Run 3's version of the claim was
substantively wrong for the very call it was describing, not a
rounding-error nitpick.

**Revised conclusion:** the original concern -- Gemini confidently
stating an incorrect mechanical detail -- recurred, just on a different
question than the first run (point 2 instead of point 1). That's a more
concerning pattern than plain hedging: the model isn't shy about details
it's unsure of, it's willing to assert a specific, wrong, plausible-
sounding variable name (`HARD_MAX_STEPS` in place of `cappedSteps`) with
no hedge at all. The verification pass helps -- Run 2 shows it can
produce a fully correct, precise answer -- but it does not reliably
prevent confident-wrong claims on precise mechanical details. Treat any
such claim from this harness (exact variable/condition names, precise
mechanical specifics) as needing an independent human/code check before
trusting it, even post-verification-pass.

**Still needed:** re-run this same or a similarly heavy task a few more
times against `gemini` to see how often the confident-wrong pattern
recurs and on which categories of claim, and whether it clusters around
specific kinds of mechanical detail (e.g. named constants/thresholds) or
is unpredictable. (Superseded by "Run 6" below, run against the
structural-line-quote-check build.)

### Run 5 (same task, re-run against `gemini` after commit `4ff4260`)

First re-run after the citation-forcing fix (`extractMechanicalClaims`/
`findUnverifiedClaims`, see that commit) that was built specifically to
catch the Run 3/4 failure mode. Result: **the fix did not catch it.**
Question (2) -- the exact verification-pass skip condition -- came back
wrong again, confidently, with no hedge: the model asserted the gate was
`if (!withholdTools && pendingVerification && step < max_steps - 1)`.
The actual code (confirmed directly against
`connectors/gemini/agent_delegate.js`) is

```js
if (answer && !withholdTools && !pendingVerification && step < cappedSteps) {
```

Two distinct errors in one claim: the `pendingVerification` polarity is
inverted (real code requires it to be `false`, i.e. `!pendingVerification`,
to proceed -- the model stated the opposite), and `step < cappedSteps` was
again misstated as `step < max_steps - 1` -- the same class of
fabricated-threshold error the fix targeted, just a different wrong
constant than Run 3's `HARD_MAX_STEPS`.

Questions (1), (3), (4), (5), and (6) were all answered correctly this
run, including (5) and (6), which directly probe the citation-forcing fix
itself (tool access retained during verification; the
extractMechanicalClaims/findUnverifiedClaims mechanism) -- the model can
correctly describe how the fix works while still failing to apply
equivalent scrutiny to its own answer on question (2) in the same
response.

**Likely reason the fix didn't catch this:** `extractMechanicalClaims`
checks whether each extracted identifier token appears verbatim
somewhere in raw tool output already fetched -- not whether the specific
*combination/relationship* asserted between tokens (e.g. "`step` is
compared against `max_steps - 1`") matches what the source actually
shows. Both `step` and `max_steps` are real identifiers that do appear in
the file, so a token-level verbatim check can pass even when the composed
expression citing them is fabricated. The fix narrows the failure surface
(catches invented identifiers) but not this shape of error (real
identifiers, wrong relationship/threshold between them).

**Revised status:** the confident-wrong pattern on precise mechanical
relationships (not just invented names) is not solved by the
citation-forcing fix. Treat this as still open -- any claim from this
harness about an exact conditional expression, especially one combining
multiple named variables/constants, needs independent verification
regardless of how many other questions in the same run were answered
correctly.

## Designer notes (future phase-2 port, not this plan's scope)

`connectors/frontend/designer_delegate.js` imports `geminiChat`/
`isRedisConfigured` directly and would need the same router swap. Not a
copy-paste: (1) its checkpoint does a full-array overwrite per step, not
append-delta; (2) its repeat-call cache only serves `read_file`/
`validate`, never `write_file`.

## Remaining open questions

- GLM: whenever OpenRouter credit is added, re-verify `z-ai/glm-4.5-air:free`
  is still the right free slug (availability rotates) and re-run the
  3-stage smoke test before assuming it's fixed.
- Groq: whether to pay for a higher TPM tier, build a leaner groq-specific
  tool schema, or rely on inter-step pacing -- undecided, needs a TPM
  window-length check against Groq's docs first.
- Whether GLM's poor recovery from repeated corrective tool-call errors is
  a `provider: "glm"` blocker specifically, or a stuck-loop-guard gap --
  untestable until GLM is unparked.
- Head-to-head provider comparison (originally rollout step 2) stays
  paused until at least one of GLM/Groq is usable again.
- Gemini: repeat the heavy-task live verification test a few more times
  to establish how often the verification pass fails to catch a
  confident-wrong mechanical claim (see "Live verification test", runs
  2-5) and whether it clusters around particular kinds of detail (e.g.
  named constants/thresholds) -- current status is "helps, but not a
  reliable guarantee," not "solved."
- Citation-forcing fix (commit `4ff4260`): confirmed live (Run 5) that it
  does not catch a wrong *relationship/threshold between two real,
  already-cited identifiers* (e.g. `step < cappedSteps` misstated as
  `step < max_steps - 1`, both real names) -- it only checks whether each
  individual token appears verbatim in raw tool output, not whether the
  composed expression does. Needs either a stronger check (e.g. requiring
  the model to quote the exact source line rather than individual tokens)
  or acceptance that this class of error is out of scope for an automated
  check. Undecided.
