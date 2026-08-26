# Plan: Add GLM (via OpenRouter) as a switchable alternative to Gemini

**STATUS (2026-08-27): Implementation shipped and deployed. Currently in
the Trial & Improvement phase (rollout step 2) -- see "Current status"
near the bottom for what's been found and what's next.**

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

## Designer notes (future phase-2 port, not this plan's scope)

`connectors/frontend/designer_delegate.js` imports `geminiChat`/
`isRedisConfigured` directly and would need the same router swap. Two
differences from `delegate_agent`'s plumbing to account for, not a
copy-paste: (1) its checkpoint (`designer_checkpoint.js`) does a full-array
overwrite each step, not append-delta; (2) its repeat-call cache only
serves `read_file`/`validate`, never `write_file`.

## Remaining open questions

- GLM's `:free` fallback slug is retired -- `GLM_FALLBACK_MODELS` needs a
  working free-tier entry (or should just cascade to other paid slugs) --
  confirm current options at https://openrouter.ai/models.
- OpenRouter credit sizing: initial testing has run into 402s twice
  (context-cap and in-flight-concurrency variants) -- worth a real budget
  check before heavier automated use.
- Whether GLM's poor recovery from repeated corrective tool-call errors
  (see "Current status") is a `provider: "glm"` blocker for open-ended
  investigation tasks specifically, or just needs the stuck-loop guard
  extended to cover it.
