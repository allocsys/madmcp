// ---------------------------------------------------------------------------
// connectors/groq/client.js — Groq (api.groq.com), an OpenAI-compatible
// chat completions API. Structurally parallel to connectors/glm/client.js
// (itself parallel to connectors/gemini/client.js).
//
// SAME TWO CASCADE AXES AS GLM, for the same reasons (see glm/client.js's
// header for the full explanation): outer cascade over GROQ_API_KEYS on
// 401/403/429 (bad/exhausted key), inner cascade over GROQ_MODEL +
// GROQ_FALLBACK_MODELS on 429/503/network-transient. Cooldown is namespaced
// per (model, key-index) via "groq:<keyIndex>", reusing
// connectors/gemini/cooldown.js's generic `namespace` param -- no changes
// needed there, it was already provider-agnostic (verified by direct read
// when this file was written, not assumed from GLM's integration alone).
//
// UNLIKE GLM: no OpenRouter-style cosmetic attribution headers -- Groq is a
// single vendor, not a router across many upstream providers, so there's
// no equivalent "which app is this usage attributed to" concept to send.
//
// This file stays a thin, faithful wire-format client -- format translation
// between Gemini's `contents`/`candidate` shape and OpenAI's
// `messages`/`choice` shape happens in connectors/openai_shape/adapter.js
// (shared with GLM), called from connectors/llm/router.js, not here.
// ---------------------------------------------------------------------------

import { GROQ_API_KEYS, GROQ_API, GROQ_MODEL, GROQ_FALLBACK_MODELS, GROQ_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isModelCoolingDown, setModelCooldown, parseRetryDelaySeconds } from "../gemini/cooldown.js";

async function callChatCompletionOnce(body, model, apiKey) {
  if (!apiKey) throw new Error("No Groq API key available. Set GROQ_API_KEYS as an environment variable on the madmcp server.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(GROQ_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
    });
  } catch (err) {
    // Same reasoning as glm/client.js's callChatCompletionOnce: a
    // network-level failure carries no HTTP status, so `transient: true`
    // lets the cascade below treat it the same as a 503.
    const isAbort = err.name === "AbortError";
    const wrapped = new Error(isAbort ? `Groq request timed out after ${GROQ_REQUEST_TIMEOUT_MS}ms (model: ${model})` : `Groq request failed (network error, model: ${model}): ${err.message}`);
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
    const err = new Error(`Groq API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cascades through (GROQ_API_KEYS x [GROQ_MODEL, ...GROQ_FALLBACK_MODELS])
// on 401/403 (bad/exhausted key), 429 (rate limit), or 503 (overloaded).
// Same "any other status is a real failure, surface immediately" rule as
// Gemini's and GLM's clients. If the caller passed an explicit `model`
// that differs from the configured default (GROQ_MODEL), that choice is
// honored exactly with no model cascade (same contract as the other two
// providers) -- but key rotation still applies, since a bad/exhausted key
// isn't a model choice.
async function callChatCompletion(body, requestedModel) {
  if (!GROQ_API_KEYS.length) {
    throw new Error("GROQ_API_KEYS is not set. Add at least one Groq API key as an environment variable on the madmcp server.");
  }
  const models = requestedModel && requestedModel !== GROQ_MODEL
    ? [requestedModel]
    : [GROQ_MODEL, ...GROQ_FALLBACK_MODELS.filter((m) => m !== GROQ_MODEL)];

  let lastErr;
  for (let keyIndex = 0; keyIndex < GROQ_API_KEYS.length; keyIndex++) {
    const apiKey = GROQ_API_KEYS[keyIndex];
    const namespace = `groq:${keyIndex}`;
    const isLastKey = keyIndex === GROQ_API_KEYS.length - 1;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const isLastModelForKey = i === models.length - 1;
      if (await isModelCoolingDown(model, namespace)) {
        lastErr = lastErr || new Error(`Groq API error (429): model "${model}" on key #${keyIndex} is in a recorded cooldown from a recent rate limit.`);
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

// Multi-turn call with function-calling support, mirroring glmChat's role:
// takes/returns OpenAI-shaped `messages`/`choice` (NOT Gemini's
// `contents`/`candidate` -- that translation is
// connectors/openai_shape/adapter.js's job, called from
// connectors/llm/router.js, not from here). `tools` is an OpenAI-shaped
// tools array or undefined -- passing undefined omits `tools` from the
// request body entirely (not an empty array), matching Gemini/GLM's
// "withhold tools" behavior on the final/stuck-loop step.
export async function groqChat(messages, { model = GROQ_MODEL, tools, maxOutputTokens } = {}) {
  const body = { messages };
  if (tools) body.tools = tools;
  // NOTE (see config.js's GROQ_DEFAULT_MAX_OUTPUT_TOKENS comment): sent as
  // `max_tokens`, matching GLM's client and the OpenAI legacy field name.
  // Not yet live-verified against Groq's actual API behavior for every
  // model -- not assumed correct just because it mirrors GLM.
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;

  const data = await callChatCompletion(body, model);
  const choice = data?.choices?.[0];
  if (!choice) {
    throw new Error("Groq returned no choices.");
  }
  return choice; // { message: { role, content, tool_calls? }, finish_reason, ... }
}
