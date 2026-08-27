# Plan: Add GLM (via OpenRouter) as a switchable alternative to Gemini

**STATUS (2026-08-27, latest): Groq TPM-ceiling work (options 1-3 logged
in "Groq live smoke test findings" below) is PARKED BY EXPLICIT USER
DECISION, not resolved.** `provider: "groq"` and `provider: "glm"` both
stay wired on main exactly as they were (opt-in only, `DEFAULT_LLM_PROVIDER`
unchanged, no code removed) -- nobody should spend more time on the lean-
schema/pacing/paid-tier options for Groq unless a future session is
explicitly asked to revisit it. Effort shifted instead to a Gemini-side
accuracy problem that's real regardless of the Groq/GLM situation: see
"Gemini harness fix -- self-verification pass" below for what changed and
why. **Practical effect: Gemini remains the only provider anyone should
route real `delegate_agent` work through right now** -- same conclusion
as before, but now because GLM/Groq work is paused rather than because
Groq's TPM ceiling is considered unfixable in principle.

**STATUS (2026-08-27, earlier same day, preserved for history): GLM/
OpenRouter implementation shipped and deployed, but currently
non-functional (see "Current status" -- account has no credit and none is
being added). Groq was added as a third `delegate_agent` provider (PR
#106, merged to main) -- steps 1-8 done, doc updates done. Step 9 (live
smoke test) surfaced that this account's Groq free tier is genuinely not
balance-gated (unlike OpenRouter), but its 8000 TPM/model limit is
tripped almost immediately by `delegate_agent`'s own ~30-tool schema size
-- see "Groq live smoke test findings" below. A single no-tool call works
fine; any real tool-using investigation fails by step 1-2. Three follow-up
options were identified and partially researched (paid-tier TPM, a leaner
groq-specific tool schema, TPM-window-aware pacing) but NOT implemented --
see the now-superseded status paragraph above for why.**

## Why

`delegate_agent` (and `delegate_designer`) were hard-wired to Gemini.
Gemini's code-review/investigation output is mixed and prone to heavy
logic errors on some tasks, so GLM (via OpenRouter) was added as a second
option, selectable per-call via a `provider` argument, defaulting to
`gemini` so nothing broke for existing callers.

Model: **`z-ai/glm-4.6`** (default) / **`z-ai/glm-4.5-air`** (paid
fallback; the `:free` slug was found retired mid-implementation -- see
"Current status").

## Non-goals

- `delegate_designer` (frontend write-agent) is not touched -- same
  pattern could follow later; its checkpoint storage shape differs from
  `delegate_agent`'s (full-array overwrite vs. append-delta), so it is
  NOT a drop-in copy of this work.
- Not auto-picking "whichever model is best" -- explicit opt-in `provider`
  argument only.
- Not deprecating Gemini. Default stays Gemini until GLM is validated
  head-to-head on real tasks (in progress, see "Current status").

## Architecture (as built)

```
connectors/llm/router.js       -- providerChat(contents, {provider, tools,
                                    model, maxOutputTokens}): picks gemini|glm,
                                    always returns Gemini-shaped candidate
connectors/gemini/client.js    -- unchanged, Gemini's native wire format
connectors/gemini/cooldown.js  -- isModelCoolingDown/setModelCooldown take an
                                    optional `namespace` param (default
                                    "gemini"); GLM passes `glm:${keyIndex}`
                                    for per-(model,key) cooldown tracking
connectors/gemini/agent_checkpoint.js -- meta blob also stores provider/
                                    model/maxOutputTokens, restored on resume
                                    in preference to caller-passed values
connectors/gemini/agent_delegate.js   -- runInvestigation loop, provider-
                                    agnostic; calls router.js instead of
                                    geminiChat directly. FUNCTIONS/
                                    FUNCTION_DECLARATIONS/SYSTEM_PREAMBLE/
                                    stuck-loop+step-budget logic unchanged.
                                    Now also validates each function call's
                                    args against its own schema before
                                    execute() (added 2026-08-27, see
                                    "Current status")
connectors/gemini/agent_tools.js      -- delegate_agent MCP schema: added
                                    `provider`, `model`, `maxOutputTokens`
                                    zod args
connectors/glm/client.js       -- OpenRouter HTTP client: outer cascade
                                    over OPENROUTER_API_KEYS (401/403/429),
                                    inner cascade over GLM_MODEL +
                                    GLM_FALLBACK_MODELS (429/503/transient)
connectors/glm/adapter.js      -- toOpenAIMessages / toOpenAITools /
                                    fromOpenAIChoice: pure translation
                                    between Gemini's contents/candidate
                                    shape and OpenAI's messages/choice shape.
                                    Verified to pass `parameters` through
                                    unchanged (schema fidelity confirmed by
                                    direct read, 2026-08-27)
```

Config added to `config.js`: `OPENROUTER_API_KEYS` (comma-separated, plural
-- note old docs/README referenced a singular `OPENROUTER_API_KEY` that is
never read; confirm docs were updated to match), `GLM_MODEL`,
`GLM_FALLBACK_MODELS`, `GLM_REQUEST_TIMEOUT_MS`, `GLM_DEFAULT_MAX_OUTPUT_TOKENS`
(default 8192 -- see "Current status" for why this exists),
`DEFAULT_LLM_PROVIDER` (default `"gemini"`).

**Known, accepted asymmetry:** Gemini's `MALFORMED_FUNCTION_CALL`
finishReason (a specific diagnostic for "tools withheld but model tried to
call one anyway") has no OpenAI-API equivalent, so GLM's failure message on
that specific edge case is generic ("stopped without a final answer --
finishReason: stop") rather than pointing at the real cause. Not something
to patch in the adapter.

## Tests

`test/glm-client.test.js`, `test/glm-adapter.test.js` (round-trip test),
`test/llm-router.test.js` (dispatch + import-boundary check), and
`test/agent-delegate-loop.test.js` (stuck-loop/step-budget/checkpoint-resume,
parametrized across both providers) -- all in place and green in CI as of
commit `6d3c4d6`.

## Current status (2026-08-27) -- Trial & Improvement phase

Rollout step 1 (ship behind `provider` arg, default gemini) is done.
Currently in step 2 (comparative testing on real tasks before considering
a `DEFAULT_LLM_PROVIDER` flip). Findings so far:

- **Model-threading + credit-cap bugs (found in initial live testing,
  fixed):** `model` wasn't reaching OpenRouter at all (fixed across
  agent_tools.js -> agent_delegate.js -> router.js -> glm/client.js); once
  fixed, every GLM call still 402'd because nothing ever set `max_tokens`,
  so OpenRouter defaulted to the model's full context (65536). Fixed via
  `GLM_DEFAULT_MAX_OUTPUT_TOKENS` (8192, applied only on the glm branch in
  router.js). Both fixes are on `main`, CI green, confirmed working via a
  live `delegate_agent` call (some initial confusion during rollout was a
  deploy-propagation lag, not a code issue -- resolved).
- **Shared harness gap found and fixed (commit `7dce134`):** function-call
  args were never validated against each tool's own declared schema before
  execute() ran, so a model passing an unknown/extra parameter failed
  silently instead of getting corrective feedback. Added
  `validateFunctionArgs()` -- applies identically to both providers, not
  GLM-specific, though GLM's `github_search_code` misuse (passing a `repo`
  param the tool's schema doesn't define) is what surfaced it.
- **Head-to-head quality (small tasks, 2 trials each):** both providers
  gave accurate final answers. Gemini: consistently tight (3-5 steps), no
  wasted calls. GLM: more thorough (pulled actual commit diffs unprompted
  beyond what was asked), but noisier -- more steps, one code-quoting typo
  in one trial, and one run with an unrelated/noisy tool call.
- **Head-to-head on a harder, open-ended task -- first attempt:**
  inconclusive. Gemini fell into its own redundant-repeat pattern
  (re-reading/re-searching the same thing across several steps) before
  hitting a real Gemini free-tier quota exhaustion (429, recorded
  cooldown); GLM's run hit the new arg-validation error on
  `github_search_code` correctly, but **did not self-correct after 4
  identical corrective error messages** -- a real, distinct finding from
  the earlier silent-failure bug -- before the run hit an OpenRouter
  in-flight-credit 402. Neither run reached a final answer.
- **Same task, retried after a wait:** Gemini's cooldown had cleared and
  it completed (13 steps) -- but **gave a verifiably wrong answer** on
  half the task. It correctly audited all 6 sampled tools' schema-vs-
  execute() consistency (no mismatches, matches direct reading of the
  file), but incorrectly claimed `validateFunctionArgs()` is "only
  invoked inside specific execution/fallback code paths" and not applied
  before every `execute()` call. That's false: there is exactly one
  `execute()` call site in the whole loop, and validation runs
  unconditionally before it. Gemini had the full file in context from its
  very first tool call and still got this wrong -- it appears to have
  trusted a later, narrower `github_search_code` result (which only
  surfaced the function's definition line, not the call site) over the
  complete file it had already read. A real accuracy failure, not an
  infrastructure one -- worth weighing against Gemini's "tighter/more
  disciplined" showing on the earlier, easier trials.
  GLM's retry on the same resume hit the identical OpenRouter
  in-flight-credit 402 again, with no improvement -- across two attempts
  several minutes apart this now looks like genuine account credit
  exhaustion rather than transient in-flight contention as the error
  message suggests. GLM's run still never reached a final answer for this
  task.
- **Confirmed:** `z-ai/glm-4.5-air` (paid) works end-to-end for
  multi-turn tool-calling; the `:free` slug in `GLM_FALLBACK_MODELS` was
  found retired by OpenRouter during testing and should be revisited.

**UPDATE (2026-08-27, later same day) -- OpenRouter account confirmed
exhausted, user declining to top up. GLM is now a hard blocker, not a
credit-timing issue:**

User checked the account directly: balance is exhausted, and the decision
is to NOT add funds. Since a paid top-up is off the table, `config.js` was
changed (commit `f1fed45`) to default `GLM_MODEL` to the free
`z-ai/glm-4.5-air:free` slug (previously the paid `z-ai/glm-4.6` was
default, with `:free` only as a fallback-on-429 entry) and
`GLM_FALLBACK_MODELS` was emptied out (no paid fallback left to cascade
to).

A live smoke test against this new config (`delegate_agent`,
`provider: "glm"`) surfaced that **a zero-balance OpenRouter account is
blocked from BOTH the paid and free GLM routes, in different ways**:

1. First call (default 8192 `maxOutputTokens`, tool-using task): 402 --
   "This request requires more credits, or fewer max_tokens. You
   requested up to 8192 tokens, but can only afford 2712." So even the
   *free* model's completion-token ceiling is gated by account balance,
   not just the paid model's.
2. Retried with `maxOutputTokens: 2000` (under the affordable ceiling
   above): got further (2 tool calls succeeded), then failed on step 3
   with 402 -- "Prompt tokens limit exceeded: 17054 > 9946." So the
   *prompt*-side token budget is ALSO gated by balance, independent of
   the completion-side cap in (1). A multi-turn investigation loop that
   accumulates file contents in context will hit this regardless of how
   low `maxOutputTokens` is set.
3. Minimal single-step test (no tools, tiny prompt, `maxOutputTokens: 500`
   -- ruling out both caps above): 404 -- "This model is unavailable for
   free. The paid version is available now - use this slug instead:
   z-ai/glm-4.5-air." So a zero/negative-balance account isn't just rate-
   or token-limited on the free tier, it can be refused free-tier access
   to the model outright.

**Conclusion: this is not fixable by model selection, prompt size, or
output cap tuning.** With this account's balance at zero, OpenRouter
blocks GLM end-to-end -- paid slugs 402 immediately, and the nominally
-free slug is inconsistently gated (sometimes token-limited, sometimes
outright 404'd as "unavailable for free"). `provider: "glm"` should be
treated as **non-functional until the account carries a positive
balance** -- even a small one, since (1) and (2) above suggest the gating
is balance-proportional, not a flat free-vs-paid switch. Do not spend more
time tuning `GLM_MODEL`/`GLM_FALLBACK_MODELS`/`maxOutputTokens` to work
around this without a balance change first.

**Current default provider is effectively Gemini-only.** `provider: "glm"`
remains wired and will start working again immediately once the account
has credit (no code changes needed) -- but until then, don't route real
work through it, and don't count GLM failures from this point on as new
findings unless the error signature differs from the three above.

Separately, still worth doing on the Gemini side regardless of the GLM
situation: Gemini's `validateFunctionArgs` factual error (see the entry
above) is worth a follow-up run on a fresh task to see whether it
repeats -- if verifying a specific implementation detail against a file
it already read is unreliable, that's a real quality concern independent
of any provider comparison, which is now on hold anyway since a head-to-
head needs both providers working.

## Groq provider addition -- sequenced plan (2026-08-27, not started)

**Why Groq specifically:** OpenRouter's free tier turned out to be
credit-balance-gated (see "Current status" above) -- a zero-balance
account gets blocked from free models too, not just paid ones. Groq's
free tier is documented as request/token-rate-limited instead (e.g.
1,000 req/day + 8K TPM per model), not tied to any dollar balance, and
requires no credit card. It's also OpenAI-compatible, same as OpenRouter,
so the existing GLM plumbing is a close template rather than a fresh
design. Treat "not balance-gated" as an assumption to confirm in the live
smoke test below, not a given -- it's based on public docs, not tested
against this account yet.

**Model choice -- CORRECTED 2026-08-27 after checking
https://console.groq.com/docs/models directly (original plan had the
order backwards):** Groq explicitly classifies `qwen/qwen3.6-27b` as a
**preview model** ("intended for evaluation purposes only... may be
discontinued at short notice") despite it scoring highest on Groq's own
intelligence ranking, while `openai/gpt-oss-120b` is a **production
model** ("meet or exceed our high standards for speed, quality, and
reliability"). For a persistent, unattended `delegate_agent` provider,
stability of availability matters more than a benchmark edge -- so the
primary/fallback order from the original plan is swapped:
- `GROQ_MODEL` default: `openai/gpt-oss-120b` -- production-tier,
  reasoning + tool-use capable, and the model Groq is actively
  consolidating other retiring models toward (safer long-lived choice).
- `GROQ_FALLBACK_MODELS` default: `qwen/qwen3.6-27b` -- kept as a
  fallback specifically because it's strong on coding/agentic benchmarks,
  but treat it as liable to disappear without much notice since it's
  preview-only; don't be surprised if it needs replacing on short notice
  independent of any other issue.
- API base is `https://api.groq.com/openai/v1` (chat completions) --
  `console.groq.com` is the docs/dashboard host only, not a usable
  endpoint; don't confuse the two when writing `GROQ_API` in config.
- Re-verify both slugs' current preview/production status at
  https://console.groq.com/docs/models immediately before implementation
  if any time has passed since this was written -- Groq's catalog churns
  (already deprecated qwen3-32b, llama-4-scout-17b, and an earlier
  kimi-k2-instruct build as of mid-2026 per Groq's own deprecation page).

**Model choice -- CORRECTED (2026-08-27, before implementation):** the
ordering above was written before checking each slug's own catalog listing
type, not just its churn history. Groq's model catalog
(https://console.groq.com/docs/models) classifies `qwen/qwen3.6-27b` as a
**preview** model -- "intended for evaluation purposes only... may be
discontinued at short notice" -- despite scoring highest on Groq's own
intelligence ranking, while `openai/gpt-oss-120b` is a **production**
model. `delegate_agent` is a persistent, unattended provider option, not a
one-off benchmark run, so availability stability outweighs a benchmark
edge here. **Swap the ordering above**: `GROQ_MODEL` defaults to
`openai/gpt-oss-120b` (production, primary) and `GROQ_FALLBACK_MODELS`
defaults to `qwen/qwen3.6-27b` (preview, fallback only -- stronger when
available, but not to be relied on as the primary path). This is what
config.js actually ships (see its GROQ_MODEL/GROQ_FALLBACK_MODELS
comments) -- do not revert to the original ordering above without
re-checking https://console.groq.com/docs/models for whether either
model's classification has changed.

**Sequenced steps (steps 1-8 DONE as of commit `00a5edb`, all green in CI;
steps 9-10 still outstanding -- see updated STATUS line above):**

1. **DONE. Config (`config.js`):** add `GROQ_API_KEYS` (comma-separated, plural
   -- same rotation pattern as `OPENROUTER_API_KEYS`/`EXA_API_KEYS`),
   `GROQ_API` endpoint, `GROQ_MODEL`, `GROQ_FALLBACK_MODELS`,
   `GROQ_REQUEST_TIMEOUT_MS`. Also add `GROQ_DEFAULT_MAX_OUTPUT_TOKENS`
   **up front, pre-emptively** -- GLM's `GLM_DEFAULT_MAX_OUTPUT_TOKENS`
   was only added after a live 402 revealed OpenRouter has no sane
   default; don't repeat that discovery-by-failure cycle for Groq. Pick a
   conservative starting value (e.g. 4096-8192) and confirm Groq's actual
   per-model max-output limits from its docs before the first live call.
2. **DONE. Client (`connectors/groq/client.js`):** model closely on
   `connectors/glm/client.js` -- outer cascade over `GROQ_API_KEYS`
   (401/403/429), inner cascade over `GROQ_MODEL` + `GROQ_FALLBACK_MODELS`
   (429/503/transient). Groq's chat-completions endpoint is OpenAI-shaped
   like OpenRouter's, so this should be a close port, not a redesign.
3. **DONE (chose option (a), the shared module):** ~~Adapter -- decide before writing, don't default to copy-paste:~~
   `connectors/glm/adapter.js` (`toOpenAIMessages`/`toOpenAITools`/
   `fromOpenAIChoice`) is pure OpenAI-shape translation with nothing
   OpenRouter-specific in it. Either (a) extract it to a shared
   `connectors/openai_shape/adapter.js` that both `glm/client.js` and the
   new `groq/client.js` import, or (b) duplicate it into
   `connectors/groq/adapter.js` if the two providers are expected to
   diverge (e.g. Groq-specific tool-call quirks surface in testing). Don't
   silently duplicate without making this call explicitly -- duplicated
   translation logic is exactly the kind of drift this codebase's other
   shared-harness fixes (e.g. `validateFunctionArgs`) have had to unwind
   after the fact.
4. **DONE. Router (`connectors/llm/router.js`):** add a `groq` branch alongside
   `gemini`/`glm` in `providerChat`, applying `GROQ_DEFAULT_MAX_OUTPUT_TOKENS`
   the same way the `glm` branch applies its own default (only when the
   caller doesn't pass an explicit `maxOutputTokens`).
5. **DONE (no changes needed -- confirmed already provider-agnostic). Cooldown (`connectors/gemini/cooldown.js`):** already takes a
   `namespace` param -- have Groq pass `groq:${keyIndex}` for its own
   per-(model,key) cooldown tracking, same pattern GLM uses.
6. **DONE (confirmed by direct read, genuinely provider-agnostic). Checkpoint (`connectors/gemini/agent_checkpoint.js`):** confirm the
   provider/model/maxOutputTokens restore-on-resume logic is genuinely
   provider-agnostic (stores whatever string it's given) before assuming
   a third provider value "just works" -- verify by reading the file, not
   by inference from the GLM integration having worked.
7. **DONE. Tool schema (`connectors/gemini/agent_tools.js`):** the `provider`
   arg is very likely a zod enum -- if so it needs `"groq"` added
   explicitly, since zod enums don't silently accept unlisted values.
   Check this before assuming the router-level change alone is sufficient.
8. **DONE. Tests:** mirror the GLM test set --
   `test/groq-client.test.js`, and a shared/adapter test if step 3 goes
   with option (a); extend `test/llm-router.test.js`'s dispatch test to
   cover the `groq` branch; extend `test/agent-delegate-loop.test.js`'s
   provider parametrization to include `groq` as a third case.
9. **NOT DONE -- still the main gap before this can be trusted with real
   traffic.** Everything in steps 1-8 has only been exercised against
   mocked `fetch`/`providerChat` calls (see test/groq-client.test.js,
   test/llm-router.test.js, test/agent-delegate-loop.test.js) -- nothing
   has actually hit `api.groq.com` yet, so the `max_tokens` vs
   `max_completion_tokens` question flagged in config.js's
   `GROQ_DEFAULT_MAX_OUTPUT_TOKENS` comment, and whether the "not
   balance-gated" assumption holds, are both still open. Requires a real
   `GROQ_API_KEYS` value to run -- can't be completed from this branch
   alone. **Live smoke test, sequenced to catch GLM's failure modes early
   rather than late:** run the same three-stage test that surfaced GLM's
   problems -- (a) a tool-using multi-step task at the default output cap,
   (b) the same with a reduced `maxOutputTokens` to check for a prompt-
   token-side cap independent of the completion cap, (c) a minimal
   no-tool single-step call to isolate whether the model/slug is
   refused outright. This directly tests the "not balance-gated"
   assumption above -- if any of the three reproduce a GLM-style 402/404,
   that assumption is wrong and needs documenting here before going
   further.
10. **Code-wise DONE, but gated on step 9:** `provider: "groq"` is already
    wired as opt-in-only with `DEFAULT_LLM_PROVIDER` unchanged (see step 7) --
    the remaining rollout question is whether to treat it as trustworthy for
    real tasks before step 9's live verification, same caution GLM's rollout
    used. **Rollout:** ship behind `provider: "groq"`, opt-in only -- default
    stays `gemini` (`DEFAULT_LLM_PROVIDER` unchanged). Do not remove or
    disable the `glm`/OpenRouter code path in the process -- it stays
    available and will resume working immediately if OpenRouter credit is
    ever added later, with no code changes needed.

## Groq live smoke test findings (2026-08-27, step 9)

Ran against the real `GROQ_API_KEYS` value added to Vercel this same day.
Three calls, mirroring the three-stage test this step called for:

1. **Minimal, no-tool, single-step call** (`max_steps: 1` -- withholds
   tools entirely on the final/only step, see agent_delegate.js's
   `isFinalStep` logic): succeeded immediately, plain-text answer, no
   errors. Confirms the wire-level plumbing (auth, request shape, response
   parsing) all works end-to-end against the real API -- nothing wrong at
   that layer.
2. **Tool-using multi-step task, default config** (`max_steps: 5`, no
   explicit `model`/`maxOutputTokens` override): failed on step 1 with a
   413 from `qwen/qwen3.6-27b` -- "Request too large... Limit 8000,
   Requested 10303" (tokens per minute). The error names the FALLBACK
   model, meaning the PRIMARY model (`openai/gpt-oss-120b`, `GROQ_MODEL`)
   also failed on this same first request with a retryable error (429/503)
   that triggered the model cascade, and the fallback then hit an
   unretryable 413 immediately, so the whole call surfaced that error.
3. **Same task, `model: "openai/gpt-oss-120b"` pinned + `maxOutputTokens:
   500`:** because the pinned value equals the current `GROQ_MODEL`
   default, this did NOT disable the cascade (per client.js's own
   contract: cascade is only disabled when the requested model DIFFERS
   from the configured default -- worth remembering when testing "pin to
   the primary model" scenarios). Step 1 succeeded (one `get_repo_topics`
   tool call completed). Step 2 failed with a 429 from `qwen/qwen3.6-27b`:
   "tokens per minute (TPM): Limit 8000, Used 6259, Requested 6772" --
   i.e. step 1 alone had already consumed 6259 of the account's 8000 TPM
   budget, leaving no room for step 2's request even at a reduced output
   cap.

**Root cause, distinct from GLM's:** this is NOT balance-gating (Groq's
free tier really is request/token-rate-limited, not tied to a dollar
balance, confirming the plan's original assumption) -- it's that
`delegate_agent`'s `FUNCTION_DECLARATIONS` (all ~30 read-only
GitHub/Cloudflare/Notion/Context7/Mem0 tool schemas, sent in full on
EVERY turn, not just the first) is, on its own, large enough to consume
most or all of an 8000 TPM budget in a single request -- before counting
any file/page content the loop has already read back in. Lowering
`maxOutputTokens` (stage 3 above) does not fix this: the bottleneck is
prompt-side (the tool schema + accumulating conversation), which
`GROQ_DEFAULT_MAX_OUTPUT_TOKENS` was never designed to cap.

**Practical implication:** on this account's current Groq tier,
`provider: "groq"` works for the no-tool/final-step case but is not
usable for a genuine multi-step investigation -- the exact workload
`delegate_agent` exists for. Options, not yet decided/actioned:
- Check whether Groq's paid/dev tier raises the TPM limit enough to make
  this workable (https://console.groq.com/settings/billing) -- would need
  an explicit decision to pay, same kind of call as OpenRouter's credit
  question.
- A leaner tool schema specifically for the groq path (e.g. only the
  GitHub-related subset) would reduce prompt size per turn, but this
  cuts against `delegate_agent`'s whole premise (one investigation loop
  across every connector) and would need its own design decision, not a
  quick patch.
- Confirm whether Groq's TPM window is genuinely 60-second (would make
  spacing/backoff between steps a viable mitigation) or something else --
  not yet checked against Groq's own docs.

**Until one of the above is decided, treat `provider: "groq"` the same
way as `provider: "glm"` is currently treated: wired, live, opt-in, but
not yet something to route real investigative work through.**
`DEFAULT_LLM_PROVIDER` remains `"gemini"`.

## Gemini harness fix -- self-verification pass (2026-08-27)

**Why:** independent of the Groq/GLM situation above, Gemini itself has a
real, observed accuracy problem in long investigations (see "Current
status" earlier in this file): on a 13-step run, Gemini had the complete
file in context from its very first tool call, then in its final synthesis
incorrectly claimed a specific implementation detail was false -- it
appears to have trusted a later, narrower `github_search_code` result
(which only showed a function's definition line, not its call site) over
the complete file it had already read earlier in the same run. The
SYSTEM_PREAMBLE already carried general "re-scan your own retrieved text"
guidance before this fix, but that guidance lives inside a single synthesis
pass -- the same pass that produced the wrong answer despite the guidance
being present. This targets that specific failure mode with two changes,
not with a rewrite of the loop's architecture (which would be a much
bigger, riskier change for one observed bug):

1. **SYSTEM_PREAMBLE addition (`connectors/gemini/agent_delegate.js`):** a
   new explicit rule -- when a full/direct read (`github_read_file`,
   `github_get_file_at_commit`, `notion_get_page`, etc.) and a narrower or
   derived result about the same fact (a `github_search_code` snippet, a
   `mem0_search` match) disagree, the full/direct read is the more
   authoritative source, even if the narrower result was fetched more
   recently in the conversation. Directly names the exact failure pattern
   observed rather than a general "be careful" instruction.
2. **Mandatory one-time self-verification pass (new mechanism, not just a
   prompt change):** the first time the model produces a draft final
   answer (no function calls in its response) WITH tool budget still
   available (`step < cappedSteps` and this wasn't already a forced
   no-tools turn), the loop does NOT return that answer immediately.
   Instead it pushes the draft back onto `contents` along with a new
   `VERIFICATION_PROMPT` -- a no-tools turn (tools withheld the same
   structural way the final step and stuck-loop force already withhold
   them, not just a text reminder -- see those mechanisms' own history in
   this file for why a text-only nudge alone wasn't trusted) instructing
   the model to re-check every specific claim in its own draft against the
   RAW tool results already in the conversation, applying the same
   full-read-outranks-narrow-result rule from (1). Whatever text comes
   back from that second call is what's actually returned to the caller.
   If no steps remain when the draft answer arrives (e.g. the draft itself
   IS the final allowed step), the verification pass is skipped and the
   draft is returned as-is -- there's no budget left to check twice, and
   returning nothing would be worse than returning an unverified draft.

**Cost/tradeoff, stated plainly:** this adds one extra provider call (and
therefore one extra step, extra latency, and extra token spend) to every
successful investigation that would otherwise have finished with budget to
spare -- a `max_steps: 6` run that used to finish in 3 steps now finishes
in 4. This is a deliberate accuracy-for-cost tradeoff, not a bug. It also
applies identically to GLM/Groq if those providers are ever unparked --
the verification mechanism lives entirely in the provider-agnostic loop
body, not in Gemini-specific code, so it isn't a Gemini-only patch even
though Gemini is the only provider it's actually being exercised against
right now.

**State threading:** a new `pendingVerification` boolean is threaded
through exactly like `consecutiveAllRepeatSteps`/`repeatCounts` already
were -- restored from a resumed checkpoint (`agent_checkpoint.js`'s
`saveCheckpoint`/`loadCheckpoint` both gained this field), defaulted to
`false` for checkpoints saved before this existed (same defensive pattern
as every other field there). A run that dies mid-verification (the
verification call itself hits a transient 429/503) resumes back into the
verification turn rather than silently re-entering normal tool-use and
drafting an entirely new answer.

**Tests:** `test/agent-delegate-loop.test.js` updated -- every existing
test that reached a draft final answer with steps remaining needed a
second mocked `providerChat` response added (the verification pass) and
its step-count/call-count assertions bumped by one; a new dedicated test
confirms the verification pass can actually change the returned answer
and that its call carries no tools; another new test confirms the
verification pass is skipped when the draft answer is itself the final
allowed step (no budget to check twice). Full suite (`npx vitest run`)
verified green locally against a fresh clone before pushing: 24 files, 350
tests, all passing. Branch: `gemini-verification-pass`.

**NOT YET DONE -- this is a harness/prompt change, not yet re-validated
live:** everything above has only been exercised against the mocked test
suite. The actual claim this is meant to fix -- Gemini trusting a narrow
result over a full read it already has -- has NOT yet been re-tested
against a live Gemini call on a similar task. Next step once this PR is up
(or merged): re-run a comparable investigation task live and confirm (a)
the verification pass actually fires and completes, and (b) it either
catches a similar contradiction or the original bug simply doesn't recur --
either result is useful signal, but treat this as unverified in production
until that live run happens.

**Pre-merge live check (2026-08-27, against `main`, provider `gemini`,
no verification pass -- baseline only):** ran a live `delegate_agent`
task asking Gemini to directly determine, on `main`, whether
`validateFunctionArgs()` runs conditionally or unconditionally before
`execute()` in `agent_delegate.js` -- the same underlying fact the
original 13-step run got wrong. This run (14 steps) answered correctly:
1 `execute()` call site, `validateFunctionArgs()` unconditional before
it, code search agreeing with the full-file read. **Treat this as weak
signal, not a validation of anything:** the task was narrow and pointed
nearly directly at the fact in question, unlike the original open-ended
13-step run where the wrong claim emerged from synthesizing across a
longer, less targeted investigation -- not a faithful reproduction of the
failure conditions. LLM output is also non-deterministic, so one correct
run (on an easier task than the original) is not evidence the underlying
failure mode is gone. This run also did not exercise the verification
pass at all (ran against `main`, pre-merge). **Still needed before trusting
this branch in production:** re-run a task that faithfully reproduces the
original open-ended, multi-step conditions (not a narrowed version) --
ideally several times against `main` first to establish an actual baseline
recurrence rate, then the same task the same number of times against this
branch post-merge, to get a real before/after comparison instead of a
single anecdote either way.

## Repeat/redundant tool-call dedup fix (PR #108, merged 2026-08-27)

**Why:** separate from the Gemini self-verification-pass work above (PR #107,
landed first), live testing on a heavier, open-ended task the same day found
`delegate_agent`'s loop making genuinely redundant tool calls -- e.g.
re-reading the same file 5-6 times with no new information gained -- which
burned through Gemini's free-tier token quota before the task finished
(observed: a 429 quota-exhaustion failure at step 17 of a 25-step run,
`resume_run_id: "20c9914d-c7d0-457b-9a67-04e711f3d74f"`).

The loop already had a repeat-detection/caching mechanism keyed on
`${name}:${JSON.stringify(args || {})}` (exact-signature repeats served from
cache, 3 consecutive all-repeat steps force tools off). Two gaps let real
repeats slip through anyway:

1. **Key-order sensitivity:** `JSON.stringify` on a plain JS object depends
   on key insertion order, not sorted/canonical order. Two calls with
   identical values but different key order in Gemini's own emitted
   function-call JSON produced different signature strings and were never
   recognized as repeats.
2. **No semantic equivalence across tools/params:** the guard only matched
   identical `(function name, args)` pairs -- it had no concept that
   `github_read_file` (no ref, or ref omitted) and
   `github_get_file_at_commit(commit: "HEAD")` on the same path return
   identical content (both are the tip of the default branch).

**Fix implemented (commit `dcf1f51`, tests in `9b29114`, merged as `6c17360`):**
a new `normalizedSignature(name, args)` function in `agent_delegate.js`
replaces the raw signature used by the stuck-loop/cache guard:

- Gap 1: keys are sorted (`Object.keys(a).sort()`) before stringifying, so
  key order in the model's emitted JSON no longer matters.
- Gap 2: `github_read_file` and `github_get_file_at_commit` are treated as a
  signature family (`READ_FILE_SIGNATURE_FAMILY`). When either is called with
  an omitted/empty ref or commit, or the literal string `"HEAD"`, both
  collapse to a single canonical signature keyed on `(owner, repo, path)`.
  **Deliberately lightweight, not the full fix originally proposed:** this
  does NOT resolve a named branch (e.g. `"main"`) that happens to currently
  equal the default branch to the same signature -- doing that correctly
  would require an extra API call to look up the default branch before every
  dedup check, a bad latency/cost trade for the common case. If the
  lightweight version doesn't catch enough real-world redundancy, revisit
  with the heavier default-branch-SHA resolution.
- The weaker/supplementary SYSTEM_PREAMBLE-guidance option from the original
  handoff (telling the model outright that re-reading via a different
  ref/tool won't surface new info) was NOT added -- the structural cache fix
  above was judged sufficient on its own, consistent with this file's
  existing pattern (see isFinalStep/stuckLoopForce/pendingVerification) of
  not trusting text-only nudges alone for loop-control guarantees.

**Tests (`9b29914`):** `test/agent-delegate-loop.test.js` gained two new
cases -- "recognizes repeat calls despite different key order in args (dedup
fix gap 1)" and "recognizes github_read_file and
github_get_file_at_commit(commit: \"HEAD\") on the same path as equivalent
(dedup fix gap 2)" -- each asserting the underlying execute function
(`mockGithubRequest` / `mockReadFileViaBlob`) was only actually invoked once
despite two differently-expressed calls. Both genuinely exercise the fix
(confirmed by direct reading, 2026-08-27) and would catch a regression if
`normalizedSignature` were reverted to the raw `JSON.stringify` form.

**NOT YET DONE as of this writing:**
- **No live smoke test yet.** Everything above has only been verified by
  reading the code and test suite directly (via a `delegate_agent`
  self-audit, 2026-08-27) -- nobody has yet re-run a heavier, open-ended
  task live against the deployed fix to confirm redundant calls actually
  drop in practice, the way the original 25-step run surfaced the problem.
  Treat the fix as code-correct but production-unverified until that
  happens.
- **`resume_run_id: "20c9914d-c7d0-457b-9a67-04e711f3d74f"`** (the original
  429 quota-exhaustion run that motivated this fix) has not been checked or
  resumed. Given the 1-hour checkpoint TTL and the time elapsed since it was
  recorded, it should be treated as stale/expired rather than something
  worth resuming -- a fresh live test is the right way to validate the fix,
  not resuming a pre-fix run's checkpoint (which was captured under the OLD
  signature logic anyway, so resuming it would not even exercise the new
  dedup code on the steps already completed).
- This section was written retroactively -- PR #108 shipped and merged
  before `plan.md` was updated to describe it, unlike PR #107 which was
  documented as it happened. No functional gap, just a process note.

## Designer notes (future phase-2 port, not this plan's scope)

`connectors/frontend/designer_delegate.js` imports `geminiChat`/
`isRedisConfigured` directly and would need the same router swap. Two
differences from `delegate_agent`'s plumbing to account for, not a
copy-paste: (1) its checkpoint (`designer_checkpoint.js`) does a full-array
overwrite each step, not append-delta; (2) its repeat-call cache only
serves `read_file`/`validate`, never `write_file`.

## Remaining open questions

- **OpenRouter has no credit and the owner is declining to add any
  (2026-08-27) -- GLM is parked, not actively being fixed.** Not a slug
  problem: `z-ai/glm-4.5-air:free` is confirmed live and genuinely free on
  a funded account, but this account's zero balance blocks it anyway (see
  "Current status" update above for the three distinct error signatures).
  Whenever this is revisited: re-verify `z-ai/glm-4.5-air:free` is still
  the right free slug (availability rotates), pick a paid fallback cascade
  again once there's headroom to fall back to, and re-run the smoke test
  in "Current status" before assuming it's fixed.
- Whether GLM's poor recovery from repeated corrective tool-call errors
  (see "Current status") is a `provider: "glm"` blocker for open-ended
  investigation tasks specifically, or just needs the stuck-loop guard
  extended to cover it -- untestable until GLM is usable again.
- The head-to-head comparative testing (rollout step 2) is effectively
  paused: it needs both providers completing runs, and only Gemini
  currently can. Gemini's standalone accuracy issue (validateFunctionArgs
  factual error) can still be investigated on its own in the meantime.
