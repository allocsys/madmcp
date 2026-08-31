# Plan: Add B.AI as a third-party LLM provider

## Context

`connectors/llm/router.js` already abstracts provider selection for
`delegate_agent` (`providerChat(contents, { provider, tools, model,
maxOutputTokens })`), normalizing every provider's response into Gemini's
`candidate` shape. Two providers already sit behind it as OpenAI-compatible
chat-completions clients: GLM (`connectors/glm/`) and Groq
(`connectors/groq/`), both built on the shared translation layer in
`connectors/openai_shape/adapter.js`.

B.AI's `/v1/chat/completions` endpoint is OpenAI-compatible (same
`messages` / `max_tokens` / `tools` / `stream` shape, `choices[0].message`
response), confirmed against https://docs.b.ai/llmservice/api/. It slots
into the same pattern — no new adapter needed.

We'll offer B.AI's free `GLM-5.3-Flash` model (`0` credits per
docs.b.ai/llmservice/models/glm-5-3-flash/ as of 2026-08-31).

## Key difference from Groq/GLM: no model cascade

Groq and GLM both cascade on TWO axes: outer loop over API keys, inner loop
over `[MODEL, ...FALLBACK_MODELS]`. For B.AI we explicitly do **not** want
an inner model-fallback cascade — we only want the one free model
(GLM-5.3-Flash). Silently falling back to a different B.AI model on a 429
could fall through to a paid model and start burning credits without
anyone noticing.

So `BAI_FALLBACK_MODELS` is deliberately not introduced. `BAI_MODEL` is the
only model this client will ever call unless a caller passes an explicit
`model` override (same "explicit choice wins" contract as the other
providers).

## Key difference from Groq/GLM: pattern to copy is Gemini's, not Groq's

The user wants MULTIPLE `BAI_API_KEYS` with clean key-rotation on
401/403/429/network-transient — same shape as `GEMINI_API_KEYS`'s outer
cascade in `connectors/gemini/client.js` — but WITHOUT a model cascade
nested inside it (see above). So the client is structurally: Gemini's key
rotation loop, minus Gemini's model cascade loop (since there's only ever
one model to try).

Cooldown reuses `connectors/gemini/cooldown.js`'s existing
provider-agnostic `namespace` param, namespaced as `bai:<keyIndex>` (same
convention as `groq:<keyIndex>` / `glm:<keyIndex>`).

## Steps

1. **`config.js`** — add, following the exact comment/reasoning style
   already used for `GROQ_*` / `GLM_*` blocks:
   - `BAI_API_KEYS` (comma-separated, `.split/map/filter` pattern identical
     to `GEMINI_API_KEYS`/`GROQ_API_KEYS`)
   - `BAI_API` = `"https://api.b.ai/v1/chat/completions"`
   - `BAI_MODEL` (default placeholder — see "Open question" below; no
     `BAI_FALLBACK_MODELS` export, explained in a comment referencing the
     no-cascade decision above)
   - `BAI_REQUEST_TIMEOUT_MS` (default `55000`, same defensive-ceiling
     reasoning comment as `GEMINI_REQUEST_TIMEOUT_MS`)
   - `BAI_DEFAULT_MAX_OUTPUT_TOKENS` (B.AI's Responses docs list
     `max_output_tokens` default `65536` for GLM-5.3-Flash on that
     endpoint, but we're using `/chat/completions` with `max_tokens`; pick
     a conservative default mirroring `GROQ_DEFAULT_MAX_OUTPUT_TOKENS`'s
     4096 reasoning, override via env var)

2. **`connectors/bai/client.js`** (new) — modeled on
   `connectors/groq/client.js`'s file header/shape, but with the model
   cascade removed:
   - `callChatCompletionOnce(body, apiKey)` — POST to `BAI_API`, header
     `Authorization: Bearer <key>` (per B.AI docs; `x-api-key` is
     equivalent but Bearer matches what Groq/GLM already use, for
     consistency), same AbortController/timeout/error-wrapping shape as
     Groq's client.
   - `callChatCompletion(body)` — SINGLE loop over `BAI_API_KEYS` only (no
     inner model loop). On 401/403 (bad/exhausted key) or 429/503/network
     transient, rotate to the next key; on 429 also record a cooldown via
     `setModelCooldown(BAI_MODEL, ..., "bai:<keyIndex>")` so a later call
     skips a known-cooling-down key without a wasted round trip (mirrors
     Gemini's per-key cooldown check, just without the per-model
     dimension).
   - `baiChat(messages, { tools, maxOutputTokens })` — thin wrapper
     matching `groqChat`'s signature minus the `model` override param
     (deliberately not exposed — there's only one model behind this
     client by design; revisit if B.AI adds more free models we want).
     Sends `max_tokens`, returns `choice` (`data.choices[0]`).

3. **`connectors/llm/router.js`** — add a `provider === "bai"` branch,
   copy-shaped from the existing `groq`/`glm` branches: build
   `toOpenAIMessages(contents)` + `toOpenAITools(tools)`, call
   `baiChat(messages, { tools: openAITools, maxOutputTokens:
   maxOutputTokens ?? BAI_DEFAULT_MAX_OUTPUT_TOKENS })`, return
   `fromOpenAIChoice(choice)`. No `model` param passed through (see step 2
   — not supported for this provider).

4. **`docs/API_KEYS.md`** — add a `B.AI — BAI_API_KEYS` section in the same
   style as the Groq/OpenRouter entries (comma-separated, rate-limit
   headroom + account isolation reasoning, link to
   https://b.ai/ or https://chat.b.ai/chat for key creation), noting it
   backs `provider: "bai"` and is currently wired to the free
   GLM-5.3-Flash model only.

5. **Tests** — new `test/bai-client.test.js` mirroring
   `test/groq-client.test.js`'s structure but exercising: single-model
   single-key happy path, key rotation on 401, key rotation + cooldown on
   429, no-fallback-model behavior (confirms there's no second model ever
   attempted), timeout/network-error wrapping. Update
   `test/llm-router.test.js` to add a `provider: "bai"` case parallel to
   the existing `groq`/`glm` cases.

6. **Verify the real model ID** — before merging, run `GET
   https://api.b.ai/v1/models` with a real `BAI_API_KEYS` value (once
   provisioned) to get the literal model ID string for GLM-5.3-Flash (the
   docs never state it explicitly, only using a `"your-model-id"`
   placeholder throughout). Set `BAI_MODEL`'s default to that confirmed
   string; leave a comment flagging that it was verified live if it can't
   be sourced from public docs, same as `GROQ_MODEL`'s
   "NOT YET LIVE-VERIFIED" comment pattern where applicable.

## Open question / known gap going into implementation

The exact API model-ID string for "GLM-5.3-Flash" on B.AI is not published
in their docs (only shown as `your-model-id` placeholder). Implementation
should use a clearly-marked placeholder default (e.g.
`"glm-5.3-flash"` as best guess from the doc URL slug pattern) with a loud
comment that it MUST be confirmed against `GET /v1/models` before this is
relied on in production, exactly like other "not yet live-verified"
comments elsewhere in `config.js`.
