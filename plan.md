# Plan: Add GLM (via OpenRouter) as a switchable alternative to Gemini

> **Verification note (added after review):** the first draft of this plan
> was based on a `delegate_agent` (Gemini) self-summary of the codebase.
> Per instruction not to trust that summary at face value, every claim below
> about `connectors/gemini/*` and `connectors/frontend/designer_delegate.js`
> has since been checked against a direct read of the actual files (not a
> re-delegated summary). Three inaccuracies were found and fixed in this
> version — see the "Corrected from the original draft" callouts inline.
> The overall architecture/seam described (adapt at the client boundary,
> keep Gemini's `contents`/`candidate` shape as the lingua franca) was
> confirmed correct; the errors were in implementation-level details
> (exact exports, exact function signatures, what tests already exist).

## Why

`delegate_agent` (and `delegate_designer`) are hard-wired to Gemini
(`connectors/gemini/client.js`, model cascade via `GEMINI_FALLBACK_MODELS`,
single `GEMINI_API_KEY`, Redis cooldown, Redis checkpointing). In practice,
Gemini's code-review/investigation output is mixed and prone to heavy logic
errors on some tasks. We want GLM as a second option, reachable through
OpenRouter, with the **same cascade / multi-key / cooldown / checkpoint
machinery Gemini already has**, selectable per-call via a `provider`
argument on the MCP tool, defaulting to `gemini` so nothing breaks for
existing callers.

Candidate model: **`z-ai/glm-4.6` on OpenRouter**, with a free-tier fallback
of **`z-ai/glm-4.5-air:free`**. Note as of writing GLM-4.6 itself is not a
free OpenRouter endpoint (GLM-4.5-Air is the confirmed `:free` one) —
**verify current free/paid status and exact model slugs at
https://openrouter.ai/models before implementation**, since OpenRouter's
free lineup rotates. Design the config as a comma-separated cascade list
(see below) precisely so this can be corrected/extended without code
changes.

## Non-goals

- Not touching `delegate_designer` in phase 1 (frontend write-agent). Can
  follow the same pattern later once the read-only path is proven — and
  note it is NOT a drop-in copy of phase 1's plumbing (see "Designer notes"
  below, its checkpoint storage shape differs from `delegate_agent`'s).
- Not silently auto-picking "whichever model is best" — this is an explicit
  opt-in `provider` argument, not automatic routing.
- Not deprecating Gemini. Default stays Gemini until GLM is validated head
  to head on real review tasks.

## Current Gemini architecture (baseline being mirrored)

Directly verified by reading each file below in full (not summarized):

- `config.js` — `GEMINI_API_KEY` (single key), `GEMINI_API`, `GEMINI_MODEL`
  (default `"gemini-flash-latest"`), `GEMINI_FALLBACK_MODELS`
  (comma-separated cascade, default `"gemini-3.5-flash-lite,gemini-3.1-flash-lite"`),
  `GEMINI_REQUEST_TIMEOUT_MS`. Also has `EXA_API_KEYS` (comma-separated,
  multi-key rotation for the Exa connector) — this is the pattern GLM's key
  rotation should mirror, since Gemini itself only ever had one key.
- `connectors/gemini/client.js` — `callGenerateContentOnce` (raw HTTP call,
  one model) → `callGenerateContent` (cascades `GEMINI_MODEL` +
  `GEMINI_FALLBACK_MODELS` on 429/503/network-transient errors, checks
  `cooldown.js` before spending a request on a known-cooling-down model,
  records a cooldown on 429) → `geminiChat` (multi-turn, function-calling,
  returns the raw Gemini `candidate`) / `geminiGenerate` (single-turn text).
- `connectors/gemini/cooldown.js` — Redis (Upstash/Vercel KV)-backed
  per-model cooldown memory, fails open if Redis isn't configured. **Key
  prefix is a hardcoded constant, not parameterized** (see step 5 below —
  this was under-specified in the original draft).
- `connectors/gemini/agent_checkpoint.js` — Redis-backed conversation
  checkpointing, **append-delta** (only new `contents` entries are RPUSHed
  each step, not the whole array — this matters, see "Designer notes"
  below for the file that does it differently), 1hr TTL, used for
  `resume_run_id`.
- `connectors/gemini/agent_delegate.js` — the actual read-only investigation
  loop (`runInvestigation`, the **only export** from this file): owns
  `FUNCTIONS` (the GitHub/Notion/Cloudflare/Context7/Mem0 tool declarations
  + `execute` bodies), `FUNCTION_DECLARATIONS` (`FUNCTIONS` wrapped as
  `[{ functionDeclarations: [...] }]` — Gemini's specific wrapper shape,
  see step 4 below), `SYSTEM_PREAMBLE`, stuck-loop detection, step-budget
  nudges, and all checkpoint/resume logic. Calls
  `geminiChat(contents, { tools })` each turn and inspects
  `candidate.content.parts` for `functionCall` vs. plain text. Neither
  `FUNCTIONS` nor `FUNCTION_DECLARATIONS` nor `SYSTEM_PREAMBLE` is exported
  — they're module-private, only used inside this file's own
  `runInvestigation`.
- `connectors/gemini/agent_tools.js` — registers the `delegate_agent` MCP
  tool (zod schema: `task`, `max_steps`, `log_to_notion`, `resume_run_id`,
  `show_transcript`), calls `runInvestigation(...)`.

The **only provider-specific surface** `agent_delegate.js` actually touches
is `geminiChat()`'s call signature and the shape of what it returns
(`candidate.content.parts`, each part either `{ text }` or
`{ functionCall: { name, args, id } }`, plus `finishReason`), and the
conversation array `contents` (`{ role: "user"|"model", parts: [...] }`,
with tool results sent back as `role: "user"` + `functionResponse` parts).
Everything else (the loop, stuck-loop guard, step budgeting, checkpoint
bookkeeping, transcript formatting, `FUNCTIONS`) is provider-agnostic
already. That is the seam this plan cuts along — confirmed by direct
reading, not just the original delegated summary.

## Target architecture

Introduce a **provider router** that both Gemini and GLM sit behind, and a
**format adapter** so `agent_delegate.js`'s loop body does not need to know
which provider it's talking to.

```
connectors/llm/
  router.js        <- picks gemini|glm client based on `provider`, exposes
                       one provider-agnostic chat(contents, opts) function
  types.js (jsdoc)  <- documents the shared "candidate" shape both adapters
                        must produce, so neither client silently drifts

connectors/gemini/
  client.js         <- UNCHANGED (still Gemini's own native wire format)
  cooldown.js        <- generalized to accept a provider/namespace param
                          (see step 5 -- concrete signature change, not just
                          "change the key")
  agent_checkpoint.js <- adds a `provider` field to the saved meta blob
                          (no key-prefix rename needed -- see step 5)
  agent_delegate.js  <- calls connectors/llm/router.js instead of importing
                          geminiChat directly; everything else unchanged
  agent_tools.js     <- adds `provider` zod arg, passes through

connectors/glm/
  client.js          <- OpenRouter HTTP client: multi-key rotation +
                          model cascade + cooldown, mirroring gemini/client.js
  adapter.js          <- translates the Gemini-shaped `contents` +
                          `FUNCTION_DECLARATIONS` into OpenRouter's
                          OpenAI-compatible `messages` + `tools`, and
                          translates the OpenAI-shaped response back into
                          the same `candidate` shape agent_delegate.js
                          already expects (see "Format adapter" below)
```

Why adapt at the edges instead of rewriting `agent_delegate.js`'s internal
format to some new neutral shape: the Gemini `contents`/`parts` shape is
already what's checkpointed to Redis (`agent_checkpoint.js`), already what
`FUNCTIONS`/`SYSTEM_PREAMBLE` are built around, and already what all the
stuck-loop/step-budget logic pattern-matches on. Keeping it as the *lingua
franca* and adapting only at the GLM boundary is a much smaller, lower-risk
diff than introducing a third neutral format everywhere.

## Step-by-step

### 1. Config (`config.js`)

Add, mirroring the `EXA_API_KEYS` multi-key pattern and the
`GEMINI_FALLBACK_MODELS` cascade pattern (both confirmed present in the
current file):

```js
// OpenRouter (GLM). Multi-key, same reasoning as EXA_API_KEYS: rate-limit
// headroom + account isolation. Comma-separated, rotated in order on
// 401/403/429/503/network error (see connectors/glm/client.js).
export const OPENROUTER_API_KEYS = (process.env.OPENROUTER_API_KEYS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
export const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

// Default + fallback cascade for GLM, same shape as GEMINI_MODEL /
// GEMINI_FALLBACK_MODELS. VERIFY current slugs/free-tier status at
// https://openrouter.ai/models before relying on this default -- OpenRouter's
// free lineup changes without notice (see plan.md "Why").
export const GLM_MODEL = process.env.GLM_MODEL || "z-ai/glm-4.6";
export const GLM_FALLBACK_MODELS = (process.env.GLM_FALLBACK_MODELS || "z-ai/glm-4.5-air:free")
  .split(",").map(s => s.trim()).filter(Boolean);

export const GLM_REQUEST_TIMEOUT_MS = Number(process.env.GLM_REQUEST_TIMEOUT_MS) || 55000;

// Which provider delegate_agent uses when the caller doesn't pass `provider`.
export const DEFAULT_LLM_PROVIDER = process.env.DEFAULT_LLM_PROVIDER || "gemini";
```

### 2. `connectors/glm/client.js`

New file, structurally parallel to `connectors/gemini/client.js`:

- `callChatCompletionOnce(body, model, apiKey)` — raw fetch to
  `OPENROUTER_API`, `Authorization: Bearer <key>` header,
  `HTTP-Referer`/`X-Title` headers (OpenRouter asks for these — cosmetic,
  affects your app's listing on their dashboard, not required to place
  first but good practice), same abort/timeout handling as Gemini's client,
  same `err.transient = true` treatment for network failures.
- `callChatCompletion(body, requestedModel)` — **two nested cascades**,
  which Gemini's client doesn't need (it only has one axis: model). GLM
  needs both:
  - Outer: rotate through `OPENROUTER_API_KEYS` (like `EXA_API_KEYS`) on
    401/403 (bad/exhausted key) as well as 429.
  - Inner: for each key, cascade `GLM_MODEL` + `GLM_FALLBACK_MODELS` on
    429/503/network-transient, same logic as Gemini's `callGenerateContent`.
  - Cooldown check per (model, key-index) pair — see step 5, this requires
    an actual signature change to `cooldown.js`, not just reuse as-is.
  - If every (key, model) pair in the matrix fails, throw the last error —
    same contract as Gemini's `callGenerateContent`.
- `glmChat(messages, { model, tools })` — OpenRouter/OpenAI-compatible
  multi-turn call with function-calling (`tools: [{ type: "function",
  function: {...} }]`), returns the raw OpenAI-shaped `choice` (message +
  finish_reason), analogous to `geminiChat` returning the raw Gemini
  `candidate`. Format translation happens in `adapter.js`, not here — this
  file stays a thin, faithful wire-format client, same division of
  responsibility as `gemini/client.js` vs. `agent_delegate.js`.

### 3. `connectors/glm/adapter.js`

The actual seam. Two pure functions:

- `toOpenAIMessages(contents)` — Gemini `contents`
  (`{role:"user"|"model", parts:[{text}|{functionCall}|{functionResponse}]}`)
  → OpenAI `messages` (`{role:"system"|"user"|"assistant"|"tool",
  content, tool_calls?, tool_call_id?}`).
- `toOpenAITools(functionDeclarations)` — **separate function, corrected
  from the original draft**: `agent_delegate.js`'s `tools` argument is
  `FUNCTION_DECLARATIONS`, which is `[{ functionDeclarations: FUNCTIONS.map(...) }]`
  — a one-element array wrapping an object keyed `functionDeclarations`,
  Gemini's specific wire shape. This must be unwrapped
  (`functionDeclarations[0].functionDeclarations`) before mapping each
  `{name, description, parameters}` entry into OpenAI's
  `{type:"function", function:{name, description, parameters}}` shape —
  treating the incoming `tools` value as already a flat array (as an
  earlier draft of this plan implied) would silently produce zero tools.
- `fromOpenAIChoice(choice)` → the same `candidate` shape
  `agent_delegate.js` already consumes: `{ content: { role: "model", parts:
  [...] }, finishReason }`, where OpenAI `tool_calls` become Gemini-style
  `{ functionCall: { name, args: JSON.parse(tool_call.function.arguments),
  id: tool_call.id } }` parts, and OpenAI's `content` string becomes a
  `{ text }` part.

Write this file with a **round-trip test as the spec**: feed it a real
`contents` array captured from a live Gemini `delegate_agent` transcript
(multi-turn, with a function call + response in it), assert the adapted
OpenAI messages are well-formed, then assert `fromOpenAIChoice` on a
synthetic OpenAI tool-call response produces a `candidate` shape identical
in structure to what `geminiChat` would have returned for the equivalent
turn. This is the highest-risk part of the whole plan (subtle role/shape
mismatches here would silently corrupt checkpointed conversations), so it
gets the most test weight.

### 4. `connectors/llm/router.js`

**Corrected from the original draft**: the earlier version of this plan
had `router.js` importing a `FUNCTION_DECLARATIONS_RAW` export from
`agent_delegate.js`. That export doesn't exist — `agent_delegate.js`
exports only `runInvestigation`; `FUNCTION_DECLARATIONS` is module-private.
No import is needed: `agent_delegate.js` already has `FUNCTION_DECLARATIONS`
in scope where it currently calls `geminiChat(contents, { tools })`, and
will pass that same value straight through to `providerChat(contents, {
provider, tools })` instead. `router.js` only needs to know how to unwrap
whatever `tools` it's handed (via `toOpenAITools`, step 3) when the
provider is `glm`.

```js
import { geminiChat } from "../gemini/client.js";
import { glmChat } from "../glm/client.js";
import { toOpenAIMessages, toOpenAITools, fromOpenAIChoice } from "../glm/adapter.js";

export async function providerChat(contents, { provider = "gemini", tools, model } = {}) {
  if (provider === "glm") {
    const messages = toOpenAIMessages(contents);
    const openAITools = tools ? toOpenAITools(tools) : undefined;
    const choice = await glmChat(messages, { model, tools: openAITools });
    return fromOpenAIChoice(choice);
  }
  // default / "gemini"
  return geminiChat(contents, { tools, model });
}
```

`agent_delegate.js` changes from `import { geminiChat } from "./client.js"`
+ `geminiChat(contents, { tools: ... })` to `import { providerChat } from
"../llm/router.js"` + `providerChat(contents, { provider, tools: ... })`.
Everything downstream of that call (reading `candidate.content.parts`,
pushing `{role:"model", parts}` back onto `contents`, building
`functionResponse` parts for the next turn) is untouched, **because the
router always hands back Gemini-shaped `contents`/`candidate` regardless of
which provider actually ran** — GLM's OpenAI-shaped request/response never
leaks past `adapter.js`.

### 5. Generalize `cooldown.js` and `agent_checkpoint.js`

**Corrected from the original draft** — both files were read in full
directly (not summarized) to get the actual current signatures right:

- `cooldown.js` today: `COOLDOWN_KEY_PREFIX = "gemini:cooldown:"` is a
  hardcoded module constant, and `isModelCoolingDown(model)` /
  `setModelCooldown(model, seconds)` take **no provider or key-index
  parameter at all** — Gemini only ever had one model axis to cascade on
  and one API key, so there was never a reason for one. Reusing this file
  as-is for GLM is not possible without a real signature change:
  - Add an optional `namespace` param to both functions (default
    `"gemini"`, so every existing Gemini call site — none of which pass it
    today — keeps behaving identically), used to build the key as
    `` `${namespace}:cooldown:${model}` ``.
  - GLM additionally needs a **second dimension cooldown doesn't have
    today**: per-(model, key-index) tracking, since a 429 on one
    OpenRouter key/model pair shouldn't cool down a different key's quota
    for that same model. Fold the key index into the namespace GLM passes,
    e.g. `` `glm:${keyIndex}` ``, rather than adding a third parameter —
    keeps the function signature to `(model, seconds, namespace)` instead
    of growing indefinitely.
  - Update `test/gemini-client.test.js`'s cooldown assertions (which
    currently hardcode the literal `"gemini:cooldown:..."` key string) to
    account for the new optional param — those tests should keep passing
    unchanged since the default preserves the exact current key format,
    but the mock call assertions are worth double-checking against the new
    signature rather than assumed compatible.
- `agent_checkpoint.js` today: `CHECKPOINT_KEY_PREFIX = "gemini:checkpoint:"`
  is also hardcoded, but — unlike cooldown — **this one does not need to
  change for correctness**. Every checkpoint is keyed by `runId`
  (`randomUUID()`), which is already globally unique regardless of which
  provider generated it; a hardcoded "gemini:" prefix on the Redis key
  doesn't cause a GLM run's checkpoint to collide with anything. The
  original draft implied a prefix rename was required — it isn't. The only
  real change needed is adding `provider` to the saved/loaded meta blob
  (trivial: `saveCheckpoint`'s meta object is already a plain destructured
  set of fields serialized with `JSON.stringify` — add `provider` to both
  the destructure and the call sites). **Resume must reuse the original
  provider** — `runInvestigation` should ignore a caller-passed `provider`
  on a live resume the same way it already ignores a caller-passed `task`
  (`checkpoint.task || task` — do the same: `checkpoint.provider ||
  provider`). This matters because a checkpointed `contents` array is
  provider-shaped the way Gemini expects (see step 3) — resuming a
  Gemini-started run on GLM (or vice versa) without going through the
  adapter consistently would silently corrupt the conversation.

### 6. `agent_delegate.js` changes

- `runInvestigation({ task, max_steps, resume_run_id, provider })` — new
  `provider` param, defaulted from `DEFAULT_LLM_PROVIDER`, threaded through
  every `providerChat(...)` call, persisted in every `saveCheckpoint(...)`
  call, restored via `checkpoint.provider || provider` on resume (per step 5).
- `FUNCTIONS`/`FUNCTION_DECLARATIONS`/`SYSTEM_PREAMBLE`/stuck-loop
  detection/step-budget nudges: **unchanged**. These are already
  provider-agnostic; that's the whole point of adapting at the client
  boundary instead of rewriting the loop.
- The final-step "withhold tools" trick (`withholdTools` boolean) needs to
  keep working identically for GLM — `router.js`/`adapter.js` must handle
  `tools: undefined` by omitting `tools` from the OpenAI request body too
  (not sending an empty array), so GLM is structurally unable to emit a
  tool call on the final/stuck-loop step, same guarantee Gemini currently
  has.

### 7. `agent_tools.js` changes

Add the switch, defaulted so **nothing breaks for existing callers**:

```js
provider: z.enum(["gemini", "glm"]).optional()
  .describe(`Which model backs this investigation (default: "${DEFAULT_LLM_PROVIDER}"). ` +
    `"gemini" uses Google's Gemini API (GEMINI_API_KEY). "glm" uses Z.ai's GLM model via ` +
    `OpenRouter (OPENROUTER_API_KEYS) -- use this if Gemini's output has been unreliable ` +
    `for a given task; the two are interchangeable in capability, not just cost/speed.`),
```

passed straight through to `runInvestigation({ ..., provider })`. No other
`agent_tools.js` logic changes (the `task`/`max_steps`/`resume_run_id`
validation guards stay exactly as-is).

### 8. Tests

**Corrected from the original draft**: I originally wrote "extend existing
`agent_delegate`-level tests (if any exist beyond the client-layer ones)".
Directly searched the repo for this — confirmed **no such tests exist**:
`test/gemini-client.test.js` covers `client.js` and `cooldown.js` only
(mocked fetch + mocked `@upstash/redis`), and nothing in `test/` currently
exercises `runInvestigation`/`agent_delegate.js`'s loop itself (stuck-loop
detection, step-budget nudges, checkpoint resume). This means:

- `test/glm-client.test.js` — mirror `test/gemini-client.test.js`'s
  structure: mock fetch, assert key rotation on 401/429, assert model
  cascade on 429/503 within one key, assert cooldown skip behavior, assert
  timeout/network-error handling sets `transient: true`.
- `test/glm-adapter.test.js` — the round-trip test described in step 3.
- `test/llm-router.test.js` — assert `providerChat` dispatches correctly
  for both providers and that a `provider: "glm"` call never touches
  `GEMINI_API_KEY`/Gemini's client module (import-boundary check, catches
  an accidental cross-wire early).
- `test/agent-delegate-loop.test.js` — **new file, not an extension of
  anything existing**: parametrize the stuck-loop / step-budget /
  checkpoint-resume cases (currently only exercised manually/informally
  per the file's own code comments referencing specific dated test
  sessions, e.g. "2026-07-26 stress test") against **both** providers via
  a mocked `providerChat`, since those behaviors must be provider-invariant
  by construction. This is net-new test coverage this project didn't have
  before, not a modification of an existing suite.

### 9. Rollout

1. Ship behind `provider` arg, default `"gemini"` — zero behavior change
   for existing callers/automations until they opt in.
2. Manually run the same handful of known-problematic code-review tasks
   (the ones that surfaced Gemini's "mixed, heavy logic error" behavior)
   through `delegate_agent` with `provider: "glm"` and compare transcripts.
3. If GLM checks out, consider flipping `DEFAULT_LLM_PROVIDER` — but that's
   a separate, deliberate decision after real comparative data, not part of
   this plan.
4. Once validated, port the same `provider` switch to `delegate_designer`
   — see "Designer notes" below for why this is not a trivial copy-paste.

## Designer notes (for the future phase-2 port, not this plan's scope)

Directly read `connectors/frontend/designer_delegate.js` to check the
original summary's claims here too. It does import `geminiChat` straight
from `../gemini/client.js` and `isRedisConfigured` from
`../gemini/cooldown.js`, confirming it would need the same router swap.
Two things worth flagging now so phase 2 isn't assumed to be
find-and-replace on phase 1's diff:

- **Different checkpoint storage shape.** `agent_checkpoint.js` (used by
  `delegate_agent`) does append-delta writes (`saveCheckpoint(runId, {
  newContents, ... })`, only new turns RPUSHed per step). `designer_checkpoint.js`
  (used by `delegate_designer`) instead does a full-array overwrite each
  step (`saveState` closes over the whole `contents` array and passes it
  in full every call). Both would need `provider` added to their meta
  blobs, but the router/adapter work in step 4 doesn't automatically
  extend to the designer loop's checkpoint calls — that's a second,
  separate integration point.
- **Different cache-ability rules.** `designer_delegate.js`'s repeat-call
  cache only serves `read_file`/`validate` from cache, never `write_file`
  (a real side-effecting call) — `agent_delegate.js`'s read-only loop
  caches everything. Not a blocker for the provider switch itself, just a
  reminder that the two loops aren't identical enough to share one set of
  loop-level tests; `delegate_designer` would need its own.

## Open questions to resolve before/during implementation

- **Exact OpenRouter model slug(s) for GLM** — confirm at
  https://openrouter.ai/models which of `z-ai/glm-4.6`, `z-ai/glm-4.5-air:free`,
  or a newer GLM release is the right default vs. fallback given current
  free-tier availability (this rotates — see the "Why" section).
  `openrouter/free` (OpenRouter's own free auto-router) is a plausible last
  entry in `GLM_FALLBACK_MODELS` if a fixed free slug proves too rate-limited.
- Does OpenRouter's free tier support function/tool calling reliably for
  the chosen model? (Needed for `delegate_agent`'s whole loop — a model that
  can't do multi-turn tool calls isn't a viable Gemini replacement here,
  only a viable `delegate_research`-style single-shot replacement.) Verify
  with a manual multi-tool-call test before trusting the cascade in prod.
- OpenRouter's own rate limits for free models (observed ~20 RPM / 200 RPD
  per key in public docs, subject to change) inform how many
  `OPENROUTER_API_KEYS` are actually worth provisioning.
