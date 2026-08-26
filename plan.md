# Plan: Add GLM (via OpenRouter) as a switchable alternative to Gemini

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
  follow the same pattern later once the read-only path is proven.
- Not silently auto-picking "whichever model is best" — this is an explicit
  opt-in `provider` argument, not automatic routing.
- Not deprecating Gemini. Default stays Gemini until GLM is validated head
  to head on real review tasks.

## Current Gemini architecture (baseline being mirrored)

- `config.js` — `GEMINI_API_KEY` (single key), `GEMINI_API`, `GEMINI_MODEL`
  (default), `GEMINI_FALLBACK_MODELS` (comma-separated cascade),
  `GEMINI_REQUEST_TIMEOUT_MS`.
- `connectors/gemini/client.js` — `callGenerateContentOnce` (raw HTTP call,
  one model) → `callGenerateContent` (cascades `GEMINI_MODEL` +
  `GEMINI_FALLBACK_MODELS` on 429/503/network-transient errors, checks
  `cooldown.js` before spending a request on a known-cooling-down model,
  records a cooldown on 429) → `geminiChat` (multi-turn, function-calling,
  returns the raw Gemini `candidate`) / `geminiGenerate` (single-turn text).
- `connectors/gemini/cooldown.js` — Redis (Upstash/Vercel KV)-backed
  per-model cooldown memory, fails open if Redis isn't configured.
- `connectors/gemini/agent_checkpoint.js` — Redis-backed conversation
  checkpointing (append-delta), 1hr TTL, used for `resume_run_id`.
- `connectors/gemini/agent_delegate.js` — the actual read-only investigation
  loop (`runInvestigation`): owns `FUNCTIONS` (the GitHub/Notion/Cloudflare/
  Context7/Mem0 tool declarations + `execute` bodies), `SYSTEM_PREAMBLE`,
  stuck-loop detection, step-budget nudges, and all checkpoint/resume logic.
  Calls `geminiChat(contents, { tools })` each turn and inspects
  `candidate.content.parts` for `functionCall` vs. plain text.
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
already. That is the seam this plan cuts along.

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
  cooldown.js        <- generalized to key by `${provider}:${model}` (see below)
  agent_checkpoint.js <- generalized to a provider-agnostic checkpoint (adds
                          a `provider` field to the saved blob)
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

Add, mirroring the `EXA_API_KEYS` multi-key pattern (not the single-key
`GEMINI_API_KEY` pattern — we explicitly want multi-key cascade for GLM
from day one) and the `GEMINI_FALLBACK_MODELS` cascade pattern:

```js
// OpenRouter (GLM). Multi-key, same reasoning as EXA_API_KEYS: rate-limit
// headroom + account isolation. Comma-separated, rotated in order on
// 429/503/network error, same as EXA client.
export const OPENROUTER_API_KEYS = (process.env.OPENROUTER_API_KEYS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
export const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

// Default + fallback cascade for GLM, same shape as GEMINI_MODEL /
// GEMINI_FALLBACK_MODELS. VERIFY current slugs/free-tier status at
// https://openrouter.ai/models before relying on this default -- OpenRouter's
// free lineup changes without notice (see plan.md).
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
  - Reuse `cooldown.js` (generalized, see step 4) keyed by
    `glm:${model}:${keyIndex}` so a cooling-down (model, key) pair is
    skipped the same way Gemini skips a cooling-down model.
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

- `toOpenAIMessages(contents, functionDeclarations)` — Gemini `contents`
  (`{role:"user"|"model", parts:[{text}|{functionCall}|{functionResponse}]}`)
  → OpenAI `messages` (`{role:"system"|"user"|"assistant"|"tool",
  content, tool_calls?, tool_call_id?}`). Also converts `FUNCTIONS`'
  Gemini-style `parameters` (already plain JSON Schema, no `$ref`/`oneOf`)
  into OpenAI's `tools: [{type:"function", function:{name, description,
  parameters}}]` — this part is closer to 1:1 since both use JSON Schema
  for parameters; the real work is the message-role/tool-call mapping.
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

```js
import { geminiChat } from "../gemini/client.js";
import { glmChat } from "../glm/client.js";
import { toOpenAIMessages, fromOpenAIChoice } from "../glm/adapter.js";
import { FUNCTION_DECLARATIONS_RAW } from "../gemini/agent_delegate.js"; // see note below

export async function providerChat(contents, { provider = "gemini", tools, model } = {}) {
  if (provider === "glm") {
    const messages = toOpenAIMessages(contents, tools);
    const choice = await glmChat(messages, { model, tools: !!tools });
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

- `cooldown.js`: change the Redis key from `gemini:cooldown:${model}` (or
  equivalent) to `${provider}:cooldown:${model}`, add an optional
  `keyIndex` component for GLM's multi-key case
  (`glm:cooldown:${model}:${keyIndex}`) so different OpenRouter keys don't
  share cooldown state. Gemini's existing calls pass `provider: "gemini"`
  implicitly (default param) — no behavior change for Gemini, purely
  additive.
- `agent_checkpoint.js`: add `provider` to the saved/loaded checkpoint blob.
  **Resume must reuse the original provider** — `runInvestigation` should
  ignore a caller-passed `provider` on a live resume the same way it
  already ignores a caller-passed `task` (ties back into `checkpoint.task
  || task` — do the same for provider: `checkpoint.provider || provider`).
  This matters because a checkpointed `contents` array is provider-shaped
  the way Gemini expects (see step 3) — resuming a Gemini-started run on
  GLM (or vice versa) without going through the adapter consistently would
  silently corrupt the conversation.

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

- `test/glm-client.test.js` — mirror `test/gemini-client.test.js`'s
  structure: mock fetch, assert key rotation on 401/429, assert model
  cascade on 429/503 within one key, assert cooldown skip behavior, assert
  timeout/network-error handling sets `transient: true`.
- `test/glm-adapter.test.js` — the round-trip test described in step 3.
- `test/llm-router.test.js` — assert `providerChat` dispatches correctly
  for both providers and that a `provider: "glm"` call never touches
  `GEMINI_API_KEY`/Gemini's client module (import-boundary check, catches
  an accidental cross-wire early).
- Extend existing `agent_delegate`-level tests (if any exist beyond the
  client-layer ones) to run the stuck-loop / step-budget / checkpoint-resume
  cases against **both** providers via a parametrized test, since those
  behaviors must be provider-invariant by construction.

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
   (`connectors/frontend/designer_delegate.js` / `designer_tools.js`),
   reusing `connectors/llm/router.js` unchanged.

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
