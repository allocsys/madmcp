# Plan: Add GLM (via OpenRouter) as a switchable alternative to Gemini

**STATUS (2026-08-27): GLM/OpenRouter implementation shipped and deployed,
but currently non-functional (see "Current status" -- account has no
credit and none is being added). Groq has been added as the practical
free-tier alternative to Gemini -- steps 1-8 of "Groq provider addition"
below (config, client, shared adapter extraction, router wiring,
checkpoint/cooldown reuse, tool schema, tests) are implemented and green
in CI as of commit `00a5edb`. STILL OUTSTANDING: step 9 (live smoke test
against a real Groq account -- nothing here has been run against Groq's
actual API yet, only mocked), step 10 (rollout confirmation), and doc
updates -- README.md/docs/API_KEYS.md/docs/env.html still don't mention
Groq at all as of this STATUS line. GLM code stays in place (not being
ripped out) in case OpenRouter credit is ever added later.**

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

**Model choice (confirm against current Groq catalog before hardcoding --
their model list churns; already deprecated qwen3-32b, llama-4-scout-17b,
and an earlier kimi-k2-instruct build as of mid-2026 per Groq's own
deprecation page):**
- `GROQ_MODEL` default: `qwen/qwen3.6-27b` -- Groq's own docs describe it
  as flagship-level agentic coding with tool use and thinking/non-thinking
  modes; also the top score on Groq's Artificial Analysis intelligence
  ranking as of this writing. 131K context, free tier ~1,000 req/day.
- `GROQ_FALLBACK_MODELS` default: `openai/gpt-oss-120b` -- Groq's
  flagship open-weight reasoning/tool-use model, and the model Groq is
  actively consolidating other retiring models toward, so it's the safer
  long-lived fallback choice.
- Verify both slugs live at https://console.groq.com/docs/models
  immediately before implementation, not from this plan alone.

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
