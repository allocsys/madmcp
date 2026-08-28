// ---------------------------------------------------------------------------
// connectors/gemini/client.js — Gemini API (generativelanguage.googleapis.com)
// Docs: https://ai.google.dev/gemini-api/docs
// Auth header: "x-goog-api-key: <api_key>"
// ---------------------------------------------------------------------------

import { GEMINI_API_KEYS, GEMINI_API, GEMINI_MODEL, GEMINI_FALLBACK_MODELS, GEMINI_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isModelCoolingDown, setModelCooldown, parseRetryDelaySeconds } from "./cooldown.js";

async function callGenerateContentOnce(body, model, apiKey) {
  if (!apiKey) throw new Error("No Gemini API key available. Set GEMINI_API_KEYS (or the legacy GEMINI_API_KEY) as an environment variable on the madmcp server.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${GEMINI_API}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type":   "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network-level failure -- connection dropped, DNS/TLS error, or our own
    // abort firing. None of these carry an HTTP status (err.status is
    // undefined), so without this they'd fall through callGenerateContent's
    // 429/503-only retry check as a hard, non-cascading failure even though
    // they're exactly as transient as a 503 in practice. `transient: true`
    // lets the cascade (and agent_delegate.js's isTransientGeminiError) treat them
    // the same way, without pretending they're a real HTTP status code.
    const isAbort = err.name === "AbortError";
    const wrapped = new Error(isAbort ? `Gemini request timed out after ${GEMINI_REQUEST_TIMEOUT_MS}ms (model: ${model})` : `Gemini request failed (network error, model: ${model}): ${err.message}`);
    wrapped.transient = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    const err = new Error(`Gemini API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cascades through (GEMINI_API_KEYS x [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]),
// same two-axis shape as connectors/groq/client.js's callChatCompletion --
// see that file's header for the general reasoning. Model-first ordering:
// for a GIVEN key, exhaust every fallback model before rotating to the next
// key. Rationale: a 429/503 is usually a per-model, per-key quota signal
// (free-tier Gemini quotas are tracked per model), so cascading models
// within the SAME key/account is the cheap, free lever -- no second
// account/project's quota gets touched until that lever is fully spent.
// Key rotation is the more expensive fallback (a second key likely means a
// second billing account/project), so it's reserved for when the whole
// model list is exhausted on the current key, OR the key itself is bad/
// revoked (401/403, which breaks out of the model loop immediately -- no
// point cycling models on a dead key).
//
// Cooldown is namespaced per (model, key-index) via "gemini:<keyIndex>",
// mirroring Groq's client.js -- a 429 on model X under key 0 must not cool
// down model X under key 1, since that's a completely separate quota
// bucket. Key 0 keeps the bare "gemini" default namespace (cooldown.js's
// DEFAULT_NAMESPACE) so any cooldown recorded before this multi-key change
// shipped is still honored for the first/only key on upgrade.
//
// If the caller passed an explicit `model` that differs from the configured
// default (GEMINI_MODEL), that choice is honored exactly with no MODEL
// cascade -- they asked for that specific model, so silently substituting
// another one on a 429 would violate that request. Key rotation still
// applies in that case, same as Groq: a bad/exhausted key isn't a model
// choice.
async function callGenerateContent(body, requestedModel) {
  if (!GEMINI_API_KEYS.length) {
    throw new Error("No Gemini API key configured. Set GEMINI_API_KEYS (or the legacy GEMINI_API_KEY) as an environment variable on the madmcp server.");
  }
  const models = requestedModel && requestedModel !== GEMINI_MODEL
    ? [requestedModel]
    : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)];

  let lastErr;
  for (let keyIndex = 0; keyIndex < GEMINI_API_KEYS.length; keyIndex++) {
    const apiKey = GEMINI_API_KEYS[keyIndex];
    const namespace = keyIndex === 0 ? undefined : `gemini:${keyIndex}`;
    const isLastKey = keyIndex === GEMINI_API_KEYS.length - 1;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const isLastModelForKey = i === models.length - 1;
      // Best-effort cross-call memory (see cooldown.js): if this (model, key)
      // pair was 429'd recently -- possibly in a prior invocation, since
      // Vercel doesn't guarantee a warm/reused instance between calls --
      // skip it without spending a request, same as if it had just failed
      // with a fresh 429.
      if (await isModelCoolingDown(model, namespace)) {
        lastErr = lastErr || new Error(`Gemini API error (429): model "${model}" on key #${keyIndex} is in a recorded cooldown from a recent rate limit.`);
        continue;
      }
      try {
        const data = await callGenerateContentOnce(body, model, apiKey);
        if (keyIndex > 0 || i > 0) data._fallbackModelUsed = model; // surfaced for logging/debugging, not required by callers
        return data;
      } catch (err) {
        lastErr = err;
        const isBadKey = err.status === 401 || err.status === 403;
        const isRateLimited = err.status === 429;
        const isOverloaded  = err.status === 503;
        const isNetworkTransient = err.transient === true; // timeout/dropped connection, see callGenerateContentOnce
        // A bad/exhausted key (401/403) isn't a model problem -- no point
        // cascading through the rest of this key's model list, jump
        // straight to the next key instead.
        if (isBadKey) break;
        if (!isRateLimited && !isOverloaded && !isNetworkTransient) throw err;
        if (isRateLimited) {
          // Rate-limited on this (model, key) pair -- record a cooldown
          // (best-effort; never blocks or throws on its own) so future calls
          // -- including a resumed/retried one -- can skip straight past it.
          // Recorded even on the very last model of the very last key: a 429
          // there still means it's exhausted for the window, and skipping
          // the call in that case would mean a resume walks straight back
          // into this same exhausted (model, key) pair and fails identically.
          // No equivalent recording for 503: there's no per-model quota hint
          // to parse, and an overload isn't reliably tied to this model
          // specifically the way a 429 is.
          await setModelCooldown(model, parseRetryDelaySeconds(err.message), namespace);
        }
        if (isLastModelForKey && isLastKey) throw err;
        // Otherwise fall through -- either to the next model on this key,
        // or (via the outer loop, once this key's models are exhausted) to
        // the next key.
      }
    }
  }
  throw lastErr;
}

// Single-turn text generation. Takes a plain prompt string (build any
// system/user framing into it before calling) and returns the model's text
// output. Used by delegate_research's precision mode (url + question) --
// a genuine one-shot "here's context, answer this" call with no tool use.
export async function geminiGenerate(prompt, { model = GEMINI_MODEL, maxOutputTokens } = {}) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };
  if (maxOutputTokens) body.generationConfig = { maxOutputTokens };

  const data = await callGenerateContent(body, model);
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const parts = candidate?.content?.parts || [];
  const output = parts.map((p) => p.text || "").join("");

  if (!output) {
    // e.g. finishReason "SAFETY" or "RECITATION" with no text part -- surface
    // the reason rather than silently returning an empty string.
    throw new Error(`Gemini returned no text output (finishReason: ${finishReason || "unknown"}).`);
  }
  return output;
}

// Multi-turn call WITH function-calling support -- used by
// connectors/gemini/agent_delegate.js's GitHub/Notion/Cloudflare investigation loop.
// Unlike geminiGenerate,
// this takes/returns the raw `contents` conversation array and the raw
// candidate, since the caller (agent_delegate.js) needs to inspect whether the
// response is a functionCall (keep looping) or plain text (done), which a
// single flattened string can't represent.
//
// `contents` follows Gemini's REST shape: an array of
// { role: "user"|"model", parts: [...] } turns. CORRECTED 2026-07-25: an
// earlier version of this comment said function-call results go back as a
// distinct "function" role -- that was true of an older multi-turn doc
// example, but current Gemini 3 models (see the generateContent docs) expect
// function results back as role: "user" wrapping a functionResponse part,
// with functionResponse.id echoing the originating functionCall.id. See
// agent_delegate.js for how a turn is actually built -- don't "fix" it back to
// role: "function" without re-checking current docs against the model in use.
export async function geminiChat(contents, { model = GEMINI_MODEL, tools, toolConfig, maxOutputTokens } = {}) {
  const body = { contents };
  if (tools) body.tools = tools;
  // toolConfig is a historical param from when research_delegate.js (then
  // still under connectors/gemini/) ran a multi-step Gemini loop passing
  // { includeServerSideToolInvocations: true } to combine the native
  // googleSearch tool with a custom function declaration in the same call.
  // That loop was retired 2026-07-27 in favor of a direct Exa /answer call
  // (see research_delegate.js's header) -- nothing in this codebase passes
  // toolConfig anymore, but the param is left in place in case a future
  // caller needs it. agent_delegate.js never passes this: it has no built-in tools.
  if (toolConfig) body.toolConfig = toolConfig;
  if (maxOutputTokens) body.generationConfig = { maxOutputTokens };

  const data = await callGenerateContent(body, model);
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    throw new Error("Gemini returned no candidates.");
  }
  return candidate; // { content: { role, parts }, finishReason, ... }
}
