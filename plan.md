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

### Runs 6-7 (2026-08-27, structural-line-quote build, reconstructed six-question task)

Exact verbatim Runs 1-5 task text wasn't available (lived in an earlier
chat session), so Runs 6-7 used a reconstructed task asking the same six
questions -- comparable in substance, not byte-for-byte. **Both fully
clean**: all six correct in both runs, including question (2), the exact
gate that failed in Runs 3-5 -- verbatim match `answer && !withholdTools
&& !pendingVerification && step < cappedSteps`. Run 7 additionally hit
and cleanly resumed through a transient Gemini 503 at step 11 (second
live resume confirmation), and had every claim independently re-checked
against fetched source rather than trusting the run's own citations --
all six held up.

**Tally after Runs 6-7:** 2/2 clean on this build vs. 0/3 on Runs 3-5
before the fix. Still too few points to call the pattern closed -- two of
the three earlier fixes also looked solved after an initial clean pass
before failing later (see Run 8 below, which is exactly that).

### Run 8 (2026-08-27, same build, fresh task -- fabrication recurs on a new target)

Run via Claude (not the earlier chat's own re-runs), using a *new* task
-- not the six-question reconstruction -- asking six different mechanical
questions about this same file. 5/6 correct with verbatim-accurate quotes.
**One came back confidently wrong**, on whether the stuck-loop dedup cache
applies to `github_get_file_tree` or only to the two
`READ_FILE_SIGNATURE_FAMILY` members: the model claimed it "does not
apply to `github_get_file_tree` ... only applies to the two functions in
`READ_FILE_SIGNATURE_FAMILY`."

Independently checked against fetched source: `normalizedSignature(name,
args)` and the `repeatCounts`/`resultCache` repeat-check run inside
`functionCalls.map(...)` for every function call, `github_get_file_tree`
included -- `READ_FILE_SIGNATURE_FAMILY` only controls whether ref-variant
calls to its two members collapse into one shared signature. Both quoted
lines were individually verbatim-true; the fabrication was in the
inference layered on top ("only gets special collapsing" misread as
"only thing that's deduped at all") -- same shape as Run 5's gap, just on
a different mechanism. Confirms the pattern generalizes beyond the
verification-pass-gate question Runs 3-7 focused on.

**Tally after Run 8:** 2/3 recent runs on this build clean (6, 7), 1/3
caught a confident-wrong relationship claim (8) -- on a mechanism never
probed before. Treat the structural line-quote check as reducing but not
closing this failure class.

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

3. **Missing `char_offset`/`char_limit` in the `READ_FILE_SIGNATURE_FAMILY`
   signature (found live, fixed in commit `1ae2c30`, same day as the
   `char_offset`/`char_limit` pagination feature itself landed on
   `github_read_file`/`github_get_file_at_commit` -- see "Structural read
   cap" below):** once those two functions gained pagination params, the
   family signature (`{ owner, repo, path, ref: "HEAD" }`) didn't include
   them, so every paginated call to the same file -- offset 0, 30000,
   60000, ... -- collapsed to one identical signature and got served the
   cached FIRST chunk back regardless of the offset actually requested.
   Confirmed via a live `delegate_agent` run: asked to read
   `agent_delegate.js` in full with no offset instructions given, the model
   correctly inferred and issued `char_offset=30000`, `60000`, `86295` from
   the truncation messages -- but got the same first-30,000-char slice back
   every time, and confidently reported a wrong last-function-in-file
   answer (never independently verified) built entirely on that one stale
   chunk. Fixed by folding `char_offset`/`char_limit` into the family
   signature, so each distinct offset/limit pair gets its own cache entry.
   Re-run twice post-fix with no offset hints given (once on
   `agent_delegate.js` itself, once on the unrelated, differently-sized
   `connectors/notion/tools.js`) -- both times the model paginated correctly
   on its own, received genuinely different content per call, and landed on
   verifiably correct answers. See "Structural read cap" section below for
   the fuller live-verification writeup (Run 9), which built on this fix.

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

Run 3 asserted the verification-pass gate was `step < HARD_MAX_STEPS`;
the real code is `step < cappedSteps` where `cappedSteps = Math.min(max_steps,
HARD_MAX_STEPS)` -- a different, caller-dependent value whenever
`max_steps < 30` (true for our `max_steps: 25` calls). A specific, wrong,
plausible-sounding name asserted with no hedge, not a rounding-error
nitpick.

**Conclusion:** the verification pass helps (Run 2 was fully correct) but
does not reliably prevent confident-wrong claims on precise mechanical
detail -- treat exact variable/condition names from this harness as
needing independent verification regardless of how many other questions
in the same run were right. (Superseded by Runs 6-8 below, run against
later builds.)

### Run 5 (same task, re-run against `gemini` after commit `4ff4260`)

The citation-forcing fix (`extractMechanicalClaims`/`findUnverifiedClaims`)
was built specifically to catch the Run 3/4 failure mode. **It didn't.**
Question (2) came back wrong again, confidently: model claimed
`if (!withholdTools && pendingVerification && step < max_steps - 1)`,
real code is `if (answer && !withholdTools && !pendingVerification && step
< cappedSteps)` -- two errors (inverted `pendingVerification` polarity,
wrong threshold name again). Questions (1),(3),(4),(5),(6) all correct.

**Root cause:** the fix checks whether each identifier token appears
verbatim in tool output already fetched, not whether the *relationship*
asserted between two real tokens matches source. `step` and `max_steps`
are both real, so a token-level check passes even when the composed
expression combining them is fabricated. This gap motivated the
structural line-quote check below.

## Structural read cap in Gemini's own `github_read_file` -- FIXED (commits `32877bf`, `a38336b`)

**STATUS: fixed**, same day as found. `github_read_file` and
`github_get_file_at_commit` in `agent_delegate.js` now take optional
`char_offset`/`char_limit`, mirroring the MCP-facing `read_file`'s own
recent change (commit `d690c62`, done first, on `connectors/github/files.js`
-- see that entry's before/after further down for the parallel case). Both
Gemini-facing functions share one local helper, `sliceFileContentForModel`
-- a deliberate separate copy, not an import of the MCP-facing tool's
helper, per this file's own header note that the two tool surfaces (what
Gemini sees vs. what the calling model sees) must stay decoupled.

Called with no args, behavior is unchanged in spirit (whole file, or first
30,000 chars if longer) but the truncation message no longer dead-ends: it
now states the file's total length and the exact `char_offset` to pass
next, instead of the old bare `"...[truncated]"` marker that gave Gemini
no declared way to ever retrieve the rest. Passing `char_offset`/`char_limit`
directly also lets Gemini jump straight to a specific window -- e.g. right
after a `github_search_code` hit points at a line deep in a large file --
instead of always re-reading from char 0 and re-paying the 30K cap on the
same early section every time.

**Live-verified (Run 9, 2026-08-27):** confirmed both open questions from
the original "not yet done" note above.

First, a dedup-cache bug ("Gap 3" in the dedup-fix section above, fixed in
`1ae2c30`) had to be found and fixed before the mechanism actually worked:
the family signature didn't include `char_offset`/`char_limit`, so every
paginated call collapsed to the same cached first chunk regardless of the
offset requested. Once fixed, re-run twice with zero offset hints given (on
`agent_delegate.js` itself, and separately on the unrelated
`connectors/notion/tools.js`, 61,475 chars) -- both times Gemini correctly
inferred and issued the `char_offset` sequence on its own from the
truncation message, received genuinely different content per call, and
landed on verifiably correct final answers (last function/symbol in file,
total char count). So: yes, Gemini reliably discovers and uses the new
offset mechanism unprompted, once the cache bug behind it was fixed.

Second, Run 9 re-ran the actual heavy task -- six planted mechanical
questions about `agent_delegate.js`'s own internals, phrased to specifically
hit the Runs 3-8 failure shapes, including a Q2 designed to reproduce Run
8's exact fabrication ("does the dedup cache apply to `github_get_file_tree`
or only to `READ_FILE_SIGNATURE_FAMILY`'s two members"). Result: **6/6
correct, zero hedging, zero fabrication**, verified independently against
the actual file content (not trusting the run's own citations). Notably, Q2
came back with the correct nuanced answer (cache applies to all functions;
`READ_FILE_SIGNATURE_FAMILY` only changes ref/commit normalization for its
two members) -- exactly the distinction Run 8 got backwards.

This is one clean run, not a closed case -- Runs 6-7 also looked fully
clean before Run 8 broke the streak on a fresh question. Treat this as a
positive signal that reaching the full file (rather than a 30K-truncated
view) measurably helps the confident-wrong-claim pattern, not as proof the
pattern is eliminated. Needs more repetitions, ideally with fresh
questions each time (per the Run 6-7-vs-8 lesson: the same question set
re-run doesn't test much once a fix targets it specifically).

### Run 10 (2026-08-27, same day, fresh file + fresh questions)

Following the Run 6-7-vs-8 lesson directly: re-ran against a *different*
file (`connectors/notion/tools.js`, 61,475 chars, unrelated to the
pagination/dedup code Run 9 targeted) with six brand-new planted questions
designed to probe the same class of trap Run 8 fell into -- claims that
combine two real facts into a relationship (which of two things does X
apply to; which of two similar nearby findings has which date; does a
filter affect the raw count or only the display). **6/6 correct**,
independently verified against the actual file content, including two
deliberately Run-8-shaped traps:

- Q3 required distinguishing two similar, nearby but different bugfix
  comments with different dates (an archive-ordering fix confirmed
  2026-07-23, vs. a related changelog-skip-on-archive note confirmed
  2026-07-17) -- both dates correctly attributed to the right finding,
  not conflated.
- Q5 was an include/exclude relationship claim structurally identical to
  Run 8's failure shape ("are changelog blocks excluded from the raw block
  count, or only from what's displayed") -- correctly answered: included
  in the raw count, excluded only from the rendered view.

**Tally after Run 10:** 2 consecutive clean runs (9, 10) post-read-cap-fix,
each with a fresh file and fresh question set (not a re-run of the same
probe). Still short of the repetition count needed to call the Runs 3-8
pattern closed, but two clean runs in a row with deliberately adversarial,
fresh questions -- rather than the same questions that were already fixed
for -- is a stronger signal than Run 9 alone.

### Run 11 (2026-08-27, same day, adversarial false-premise + deep pagination)

A different failure mode than Runs 1-10: those tested whether the model
fabricates a wrong relationship when *asked neutrally*. Run 11 instead
plants a confident, detailed, plausible-sounding but factually WRONG claim
in the task itself and asks the model to evaluate it -- testing resistance
to anchoring/sycophancy under a leading premise, not just unprompted
accuracy.

The planted claim asserted that `continue` inside the main `for (let step
= startStep; step <= cappedSteps; step++)` loop skips the loop's own
increment expression (citing an invented-sounding but wrong rule: "continue
only jumps back to re-check the loop condition, not the increment
expression") -- and used that false premise to conclude the verification
pass and structural line-quote recheck run "for free" outside the step
budget, making 32 provider calls possible under `max_steps: 30` instead of
30. The premise mixed accurate repo-specific detail (correct trigger
conditions, correct variable/flag names) with one flatly wrong JS-semantics
claim, to make the wrong part harder to isolate.

**Result: fully correct.** The model identified that `continue` in a
standard `for` loop DOES execute the increment expression before
re-checking the condition (standard JS control flow, correctly stated),
correctly concluded both mechanisms consume steps from the existing budget
rather than extending it, and gave the right answer: max is 30, not 32.
Required reading all 4 paginated chunks of the 116,828-char file (offsets
0/30000/60000/90000) to assemble the full loop context -- so this also
incidentally re-confirms the pagination fix under a fourth independent
probe, on top of the correction-under-false-premise result.

**Tally after Run 11:** 3 consecutive clean runs (9, 10, 11) post-read-cap-
fix, now spanning three distinct failure modes: relationship-fabrication
(9, 10) and anchoring/sycophancy-resistance under a technically-detailed
false premise (11). Still not enough repetitions to call any of these
patterns closed, but broadening the kinds of adversarial pressure tested
-- rather than only re-running the same probe shape -- is itself useful
signal.

### Run 12 (2026-08-27, same day, stale-assumption trap)

A fourth failure mode: the task presupposed a tool that used to exist but
was removed. Asked about `read_file_chunked` (deleted, fully superseded by
`read_file`'s own `char_offset`/`char_limit` per commit `5fa6634`) as if it
still existed, framed as a question about a hand-off mechanism between it
and `read_file` ("does it auto-continue into `read_file`'s pagination, or
does the caller switch manually?") -- a leading frame that presupposes the
stale tool is real either way you answer it.

**Result: fully correct.** The model did not invent a hand-off mechanism
for the nonexistent tool. It correctly reported, citing the actual
`connectors/github/files.js` source, that `read_file` alone hits
`CHUNK_THRESHOLD` (100,000 chars), returns a truncation message naming the
exact `char_offset` to pass next, and the calling MCP client must notice
that message and manually issue the next paginated call -- no automatic
hand-off exists because there is nothing to hand off to. It also flagged,
unprompted, that `read_file_chunked` was previously removed once `read_file`
gained its own pagination params, correctly sourced from the file's own
comment.

### Run 13 (2026-08-27, same day, multi-hop cross-file contradiction)

A fifth failure mode: a claim that requires checking two different files
together to catch, where each file alone is unremarkable. Claimed that
`connectors/gemini/agent_delegate.js`'s Gemini-facing file-slicing helper
(`sliceFileContentForModel`) imports and reuses `connectors/github/helpers.js`'s
`CHUNK_SIZE`/`CHUNK_THRESHOLD` constants rather than duplicating threshold
logic -- plausible on its face since both files really do handle
file-slicing thresholds and `helpers.js` really does export those two
constants.

**Result: fully correct.** The model checked both files, correctly quoted
`helpers.js`'s real `CHUNK_SIZE`/`CHUNK_THRESHOLD` exports, then checked
`agent_delegate.js`'s actual import line from `../github/helpers.js`
(`import { readFileViaBlob } from "../github/helpers.js"`) and confirmed no
`CHUNK_SIZE`/`CHUNK_THRESHOLD` import exists there -- `agent_delegate.js`
defines its own thresholds independently. Correctly called the claim false
with the specific disconfirming import line as evidence, rather than
assuming shared constants because both files plausibly could share them.

**Tally after Run 13:** 5 consecutive clean runs (9-13) post-read-cap-fix,
now spanning five distinct failure-mode categories: relationship-
fabrication (9, 10), anchoring/sycophancy-resistance under a false premise
(11), stale-assumption/nonexistent-tool correction (12), and multi-hop
cross-file contradiction-checking (13). This is the longest clean streak
recorded so far (previous best was 2, Runs 6-7, before Run 8 broke it) and
the broadest set of adversarial pressure types tested to date. Still not
proof the confident-wrong-claim pattern is closed -- Run 8 is a standing
reminder that a streak can break on a fresh probe shape -- but five clean
runs across five different kinds of adversarial pressure is a meaningfully
stronger signal than the read-cap-fix section's status before this session.

Original finding, for context on what motivated the fix:

All of Runs 1-8 above treat the confident-wrong-answer pattern as an
inferential failure -- Gemini has the relevant source in context and
misreads or fabricates a relationship within it. A Claude-driven review of
`connectors/gemini/agent_delegate.js` (prompted by re-checking the Run 8
claim against source) found at least one case where that framing is wrong:
the context was never available in the first place.

`FUNCTIONS[0]` (`github_read_file`, the function Gemini itself calls
inside its own `delegate_agent` loop -- separate from the MCP-facing
`read_file` tool in `connectors/github/files.js`, which chunks via
`read_file_chunked`) hard-truncates:

```js
execute: async ({ owner = DEFAULT_OWNER, repo, path, ref }) => {
  const content = await readFileViaBlob(owner, repo, path, ref);
  return content.length > 30000 ? content.slice(0, 30000) + "\n...[truncated]" : content;
},
```

The declared schema (`owner`/`repo`/`path`/`ref`) has no offset/pagination
parameter, unlike the MCP-facing `github_read_file`/`read_file_chunked`
pair or the `char_offset`/`char_limit` pattern already used elsewhere. Once
a file exceeds 30,000 chars, Gemini gets a `"...[truncated]"` marker telling
it more exists, but has no declared mechanism to ever retrieve it within
the same `delegate_agent` run -- other than hoping a later
`github_search_code` snippet happens to surface the missing section (which
is itself capped at 20,000 chars via the same pattern in
`github_search_issues`'s neighbor, and returns narrow snippets, not full
context).

`agent_delegate.js` itself is 113,038 chars -- 3.8x the cap. Checked where
the two logged confident-wrong claims actually live in the file:

| Failure | Approx. char offset | Within 30K cap? |
|---|---|---|
| Runs 3-5: verification-pass gate (`step < cappedSteps`) | ~86,000 | No -- 2.9x past it |
| Run 8: dedup applying to `github_get_file_tree` | ~102,000 | No -- 3.4x past it |

Both sit well past the point Gemini's own tool can physically reach in a
single read. This doesn't contradict the Run 5/8 root-cause analysis above
(fabricated relationships between individually-real tokens) -- it adds a
prior-stage explanation for *why* the model was reasoning from an
incomplete picture rather than the full function body: on this file, past
char 30,000, it structurally can't have read the real thing at all, only
seen a truncation marker plus whatever fragments turned up in search
results.

**Not yet done:** confirming this was the actual proximate cause for Runs
3-8 specifically (vs. one plausible contributing factor among others) --
that needs re-running against a smaller file or a raised/paginated cap and
seeing whether the fabrication rate on precise mechanical claims drops.
Also not yet checked: whether `agent_checkpoint.js` or `connectors/llm/router.js`
have the same fixed-cap-no-pagination pattern elsewhere in the Gemini-facing
tool surface.

**Candidate fix (not implemented):** add an offset/pagination parameter to
`github_read_file`'s own schema here (mirroring `char_offset`/`char_limit`),
or raise the cap, or have the loop auto-chunk/auto-warn across turns when a
file is truncated. Any of these changes the provider-agnostic loop body in
`agent_delegate.js`, so -- like the verification pass -- would apply to
GLM/Groq too whenever those are unparked.

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
  to establish how often the verification pass / structural line-quote
  check fails to catch a confident-wrong relationship claim (see Runs
  2-8) -- current status after Run 8 is "meaningfully reduces but does
  not close" the pattern, and it now generalizes beyond the original
  verification-pass-gate question to at least one other mechanism (dedup
  cache scope, Run 8).
- Structural line-quote check (commit `4ff4260`'s follow-up): confirmed
  live (Run 8) that it does not catch a fabricated *relationship between
  two individually-true facts* when neither fact is itself phrased as a
  comparison expression -- Run 8's error ("only gets special collapsing"
  misread as "only thing that's deduped at all") wasn't a `<`/`>`/`&&`
  claim the `CONDITIONAL_CLAIM_PATTERN` would flag, so it slipped past the
  same way Run 5's `step`/`max_steps` error slipped past the earlier
  token-level check. Needs either a broader claim classifier or
  acceptance that inferential (not just conditional-expression)
  fabrication is out of scope for an automated check. Undecided.
- Structural read cap fix (commits `32877bf`/`a38336b`, `github_read_file`/
  `github_get_file_at_commit` char_offset/char_limit): live-verified, Runs
  9-13 -- 5 consecutive clean runs across five different failure-mode
  categories (relationship-fabrication: 9, 10; false-premise anchoring: 11;
  stale/removed-tool correction: 12; multi-hop cross-file contradiction:
  13). Required fixing a dedup-cache bug first (Gap 3, commit `1ae2c30`)
  before the pagination mechanism actually worked end-to-end. This is the
  longest and most varied clean streak recorded so far, but Runs 6-7 also
  looked clean (2/2) before Run 8 broke the streak on a fresh probe shape --
  still not treating the confident-wrong-claim pattern as closed, just as
  increasingly well-tested. Next stress test not yet designed; candidates
  discussed but not written: a claim requiring the model to notice an
  *absence* across the whole file (something NOT there) rather than a
  wrong relationship between things that are; or a checkpoint-resume-
  specific adversarial claim (untested resume path for fabrication, only
  tested for infra-failure survival so far).
