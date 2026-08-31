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

  let lastErr;
  for (let keyIndex = 0; keyIndex < BAI_API_KEYS.length; keyIndex++) {
    const apiKey = BAI_API_KEYS[keyIndex];
    const namespace = `bai:${keyIndex}`;
    const isLastKey = keyIndex === BAI_API_KEYS.length - 1;

    if (await isModelCoolingDown(BAI_MODEL, namespace)) {
      lastErr = lastErr || new Error(`B.AI API error (429): model "${BAI_MODEL}" on key #${keyIndex} is in a recorded cooldown from a recent rate limit.`);
      continue;
    }
    try {
      const data = await callChatCompletionOnce({ ...body, model: BAI_MODEL }, apiKey);
      if (keyIndex > 0) data._fallbackKeyIndex = keyIndex;
      return data;
    } catch (err) {
      lastErr = err;
      const isBadKey = err.status === 401 || err.status === 403;
      const isRateLimited = err.status === 429;
      const isOverloaded = err.status === 503;
      const isNetworkTransient = err.transient === true;

      // NOTE: this client has only ONE loop (key rotation only -- see this
      // file's header on why there's deliberately no inner model loop like
      // groq/glm's clients have). A bad key (401/403) should move on to the
      // next key, same as the rate-limited/overloaded/transient cases below
      // -- it must NOT `break`, since with no inner loop to fall out of,
      // `break` here would exit the whole key-rotation loop and abandon any
      // remaining keys entirely.
      if (!isBadKey && !isRateLimited && !isOverloaded && !isNetworkTransient) throw err;
      if (isRateLimited) {
        await setModelCooldown(BAI_MODEL, parseRetryDelaySeconds(err.message), namespace);
      }
      if (isLastKey) throw err;
    }
  }
  throw lastErr;
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
