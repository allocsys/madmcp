# Plan: Add GLM (via OpenRouter) as a switchable alternative to Gemini

**STATUS (2026-08-27, latest):** `provider: "gemini"` is the only
provider anyone should route real `delegate_agent` work through.
`provider: "glm"` and `provider: "groq"` both stay wired on `main`
exactly as built (opt-in only, `DEFAULT_LLM_PROVIDER` unchanged, no code
removed) but are both blocked for different reasons (see "Provider
status" below). Effort has shifted to a Gemini accuracy problem
(self-verification pass) and today's first live test of it on a heavy,
open-ended task (see "Live verification test" at the end of this file).

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
against a genuinely heavy, open-ended, multi-file task (trace provider
routing + dedup + verification-pass mechanics across several source
files, with 4 specific mechanical questions to answer). Findings:

- **Resume path exercised for real:** hit a transient Gemini 503 ("high
  demand") at step 10. `resume_run_id` continued the checkpoint cleanly
  with no lost work -- first live (non-mocked) confirmation this works
  under a genuine mid-run provider failure, not just a test mock.
- **Verification pass fired:** final step count (11) exceeded the
  visible tool-call count (9), consistent with a draft-answer step plus
  one no-tools verification step -- first live evidence the pass is
  actually executing on a real open-ended task, not just the earlier
  narrow/easy reproduction.
- **Dedup fix confirmed live:** the model read the same file 5 times;
  3 of those were exact-signature repeats and were correctly served from
  cache. The 4th variant (`ref: "main"` right after a no-ref call) was
  correctly NOT collapsed, per the deliberate design in the dedup section
  above -- but it's still wasted effort on the model's part (no reason to
  re-request the same file with an explicit `"main"` ref immediately
  after fetching it with no ref). Not a bug, but a real efficiency gap
  the dedup fix doesn't and isn't meant to cover.
- **Answer quality -- mixed, and notably not a repeat of the original
  failure mode:** of 4 planted mechanical questions, 2 were answered
  correctly and specifically (citing the actual sort-before-stringify
  line; correctly explaining named branches aren't collapsed). The other
  2 (whether `validateFunctionArgs()` is unconditional before the single
  `execute()` call site; the exact skip condition for the verification
  pass) got vague, hedged answers instead of a precise confirmation. This
  is better than the original bug (confidently wrong) but still short of
  what the task asked for. **One run is not enough to call this a
  trend** -- worth repeating.

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
is unpredictable.

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
