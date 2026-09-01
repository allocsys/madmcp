// ---------------------------------------------------------------------------
// connectors/bai/client.js — B.AI (api.b.ai), an OpenAI-compatible
// chat completions API.
//
// KEY DIFFERENCE FROM GROQ/GLM: no model cascade. B.AI uses a KEY-ROTATION-ONLY
// cascade over BAI_API_KEYS and deliberately has NO model fallback cascade
// (there is only one free model wired up; silently falling back on 429
// could fall through to paid models and start burning credits).
//
// Cooldown is namespaced per key-index via "bai:<keyIndex>", reusing
// connectors/gemini/cooldown.js's generic `namespace` param.
//
// This file stays a thin, faithful wire-format client -- format translation
// between Gemini's `contents`/`candidate` shape and OpenAI's
// `messages`/`choice` shape happens in connectors/openai_shape/adapter.js
// (shared with GLM/Groq), called from connectors/llm/router.js, not here.
// ---------------------------------------------------------------------------

import { BAI_API_KEYS, BAI_API, BAI_MODEL, BAI_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isModelCoolingDown, setModelCooldown, parseRetryDelaySeconds } from "../gemini/cooldown.js";

async function callChatCompletionOnce(body, apiKey) {
  if (!apiKey) throw new Error("No B.AI API key available. Set BAI_API_KEYS as an environment variable on the madmcp server.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BAI_REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(BAI_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err.name === "AbortError";
    const wrapped = new Error(isAbort ? `B.AI request timed out after ${BAI_REQUEST_TIMEOUT_MS}ms` : `B.AI request failed (network error): ${err.message}`);
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
    const err = new Error(`B.AI API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cascades through BAI_API_KEYS on 401/403 (bad/exhausted key), 429
// (rate limit), or 503 (overloaded).
async function callChatCompletion(body) {
  if (!BAI_API_KEYS.length) {
    throw new Error("BAI_API_KEYS is not set. Add at least one B.AI API key as an environment variable on the madmcp server.");
  }

  const keyAttempts = [];
  for (let keyIndex = 0; keyIndex < BAI_API_KEYS.length; keyIndex++) {
    const apiKey = BAI_API_KEYS[keyIndex];
    const namespace = `bai:${keyIndex}`;

    if (await isModelCoolingDown(BAI_MODEL, namespace)) {
      // A recorded cooldown is itself always rate-limit-caused (see
      // setModelCooldown's only call site below) -- transient by definition.
      keyAttempts.push({ keyIndex, reason: "recorded cooldown", transient: true });
      continue;
    }
    try {
      const data = await callChatCompletionOnce({ ...body, model: BAI_MODEL }, apiKey);
      if (keyIndex > 0) data._fallbackKeyIndex = keyIndex;
      return data;
    } catch (err) {
      const isBadKey = err.status === 401 || err.status === 403;
      const isRateLimited = err.status === 429;
      const isOverloaded = err.status === 503;
      const isNetworkTransient = err.transient === true;

      // Tracked per-attempt (not just logged) so the aggregate
      // all-keys-exhausted error thrown below can itself be tagged
      // `.transient` -- see this function's own throw site and
      // isTransientGeminiError() in agent_delegate.js, which is what
      // actually reads that flag to decide whether a resume is worth
      // suggesting. A bad key (401/403) is NOT transient -- rotating past
      // it here is still the right move (see the no-`break` note below),
      // but if EVERY key in the account is simply invalid, that is a real
      // misconfiguration a resume will not fix, unlike a shared rate limit.
      keyAttempts.push({ keyIndex, reason: err.message, transient: isRateLimited || isOverloaded || isNetworkTransient });

      // NOTE: this client has only ONE loop (key rotation only -- see this
      // file's header on why there's deliberately no inner model loop like
      // groq/glm's clients have). A bad key (401/403) should move on to the
      // next key, same as the rate-limited/overloaded/transient cases below
      // -- it must NOT `break`, since with no inner loop to fall out of,
      // `break` here would exit the whole key-rotation loop and abandon any
      // remaining keys entirely.
      if (!isBadKey && !isRateLimited && !isOverloaded && !isNetworkTransient) {
        throw err;
      }
      if (isRateLimited) {
        await setModelCooldown(BAI_MODEL, parseRetryDelaySeconds(err.message), namespace);
      }
    }
  }

  const totalKeys = BAI_API_KEYS.length;
  const details = keyAttempts.map(a => `key #${a.keyIndex}: ${a.reason}`).join(", ");
  const exhaustedErr = new Error(`B.AI API error: all ${totalKeys} configured keys are rate-limited, in cooldown, or failed (${details})`);
  // Only mark transient if EVERY contributing attempt was itself
  // transient-shaped -- if even one key failed for a permanent reason
  // (e.g. a bad/revoked key), a resume is not guaranteed to help just
  // because the others happened to be rate-limited, so don't advertise
  // this as "just retry me" in that mixed case.
  if (keyAttempts.length && keyAttempts.every(a => a.transient)) {
    exhaustedErr.transient = true;
  }
  throw exhaustedErr;
}

export async function baiChat(messages, { tools, maxOutputTokens } = {}) {
  const body = { messages };
  if (tools) body.tools = tools;
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;

  const data = await callChatCompletion(body);
  const choice = data?.choices?.[0];
  if (!choice) {
    throw new Error("B.AI returned no choices.");
  }
  return choice;
}
