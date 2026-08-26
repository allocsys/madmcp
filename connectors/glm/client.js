// ---------------------------------------------------------------------------
// connectors/glm/client.js — GLM via OpenRouter (openrouter.ai), an
// OpenAI-compatible chat completions API. Structurally parallel to
// connectors/gemini/client.js, see plan.md "Add GLM (via OpenRouter) as a
// switchable alternative to Gemini".
//
// TWO CASCADE AXES, not one: Gemini's client only ever cascades on model
// (one API key). GLM needs both:
//   - Outer: rotate through OPENROUTER_API_KEYS on 401/403 (bad/exhausted
//     key) as well as 429, same reasoning as EXA_API_KEYS's rotation.
//   - Inner: for each key, cascade GLM_MODEL + GLM_FALLBACK_MODELS on
//     429/503/network-transient, same logic as Gemini's callGenerateContent.
// Cooldown is checked per (model, key-index) pair -- a 429 on one
// OpenRouter key/model pair shouldn't cool down a different key's quota for
// that same model, so the key index is folded into the cooldown namespace
// (e.g. "glm:2") rather than adding a third parameter to cooldown.js.
//
// This file stays a thin, faithful wire-format client -- format translation
// between Gemini's `contents`/`candidate` shape and OpenAI's
// `messages`/`choice` shape happens in connectors/glm/adapter.js, not here,
// same division of responsibility as gemini/client.js vs. agent_delegate.js.
// ---------------------------------------------------------------------------

import { OPENROUTER_API_KEYS, OPENROUTER_API, GLM_MODEL, GLM_FALLBACK_MODELS, GLM_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isModelCoolingDown, setModelCooldown, parseRetryDelaySeconds } from "../gemini/cooldown.js";

// Cosmetic headers OpenRouter asks for (affects how your app shows up on
// their dashboard's usage attribution, not required to place first) -- see
// https://openrouter.ai/docs for the current recommended header set.
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/allocsys/madmcp",
  "X-Title": "madmcp",
};

async function callChatCompletionOnce(body, model, apiKey) {
  if (!apiKey) throw new Error("No OpenRouter API key available. Set OPENROUTER_API_KEYS as an environment variable on the madmcp server.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GLM_REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(OPENROUTER_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...OPENROUTER_HEADERS,
      },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
    });
  } catch (err) {
    // Same reasoning as gemini/client.js's callGenerateContentOnce: a
    // network-level failure carries no HTTP status, so `transient: true`
    // lets the cascade below (and agent_delegate.js's isTransientGeminiError-
    // equivalent check, via the router) treat it the same as a 503.
    const isAbort = err.name === "AbortError";
    const wrapped = new Error(isAbort ? `OpenRouter request timed out after ${GLM_REQUEST_TIMEOUT_MS}ms (model: ${model})` : `OpenRouter request failed (network error, model: ${model}): ${err.message}`);
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
    const err = new Error(`OpenRouter API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cascades through (OPENROUTER_API_KEYS x [GLM_MODEL, ...GLM_FALLBACK_MODELS])
// on 401/403 (bad/exhausted key), 429 (rate limit), or 503 (overloaded).
// Same "any other status is a real failure, surface immediately" rule as
// Gemini's client. If the caller passed an explicit `model` that differs
// from the configured default (GLM_MODEL), that choice is honored exactly
// with no model cascade (same contract as Gemini) -- but key rotation still
// applies, since a bad/exhausted key isn't a model choice.
async function callChatCompletion(body, requestedModel) {
  if (!OPENROUTER_API_KEYS.length) {
    throw new Error("OPENROUTER_API_KEYS is not set. Add at least one OpenRouter API key as an environment variable on the madmcp server.");
  }
  const models = requestedModel && requestedModel !== GLM_MODEL
    ? [requestedModel]
    : [GLM_MODEL, ...GLM_FALLBACK_MODELS.filter((m) => m !== GLM_MODEL)];

  let lastErr;
  for (let keyIndex = 0; keyIndex < OPENROUTER_API_KEYS.length; keyIndex++) {
    const apiKey = OPENROUTER_API_KEYS[keyIndex];
    const namespace = `glm:${keyIndex}`;
    const isLastKey = keyIndex === OPENROUTER_API_KEYS.length - 1;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const isLastModelForKey = i === models.length - 1;
      // Best-effort cross-call memory, same reasoning as Gemini's cooldown
      // check -- but namespaced per key-index, since a cooldown recorded
      // for one key/model pair doesn't mean a different key's quota for
      // that same model is also exhausted.
      if (await isModelCoolingDown(model, namespace)) {
        lastErr = lastErr || new Error(`OpenRouter API error (429): model "${model}" on key #${keyIndex} is in a recorded cooldown from a recent rate limit.`);
        continue;
      }
      try {
        const data = await callChatCompletionOnce(body, model, apiKey);
        if (keyIndex > 0 || i > 0) data._fallbackModelUsed = model; // surfaced for logging/debugging only
        return data;
      } catch (err) {
        lastErr = err;
        const isBadKey = err.status === 401 || err.status === 403;
        const isRateLimited = err.status === 429;
        const isOverloaded = err.status === 503;
        const isNetworkTransient = err.transient === true;
        // A bad/exhausted key (401/403) isn't a model problem -- no point
        // cascading through the rest of this key's model list, jump
        // straight to the next key instead.
        if (isBadKey) break;
        if (!isRateLimited && !isOverloaded && !isNetworkTransient) throw err;
        if (isRateLimited) {
          // Same "record even on the last model" reasoning as Gemini's
          // client -- a 429 on the last model for this key still means
          // it's exhausted for the window, so a resumed/retried call
          // should skip straight past it too.
          await setModelCooldown(model, parseRetryDelaySeconds(err.message), namespace);
        }
        if (isLastModelForKey && isLastKey) throw err;
        // Otherwise fall through -- either to the next model on this key,
        // or (via the outer loop) to the next key.
      }
    }
  }
  throw lastErr;
}

// Multi-turn call with function-calling support, mirroring geminiChat's
// role: takes/returns OpenAI-shaped `messages`/`choice` (NOT Gemini's
// `contents`/`candidate` -- that translation is connectors/glm/adapter.js's
// job, called from connectors/llm/router.js, not from here). `tools` is an
// OpenAI-shaped tools array (`[{ type: "function", function: {...} }]`) or
// undefined -- passing undefined omits `tools` from the request body
// entirely (not an empty array), so the model is structurally unable to
// emit a tool call, matching Gemini's "withhold tools" behavior on the
// final/stuck-loop step.
export async function glmChat(messages, { model = GLM_MODEL, tools, maxOutputTokens } = {}) {
  const body = { messages };
  if (tools) body.tools = tools;
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;

  const data = await callChatCompletion(body, model);
  const choice = data?.choices?.[0];
  if (!choice) {
    throw new Error("OpenRouter returned no choices.");
  }
  return choice; // { message: { role, content, tool_calls? }, finish_reason, ... }
}
