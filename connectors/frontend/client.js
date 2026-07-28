// ---------------------------------------------------------------------------
// connectors/frontend/client.js — provider-agnostic one-shot text generation
// for delegate_designer. Flip FRONTEND_PROVIDER in config.js (or the
// env var of the same name) to change which backend this calls -- nothing
// in tools.js needs to change when swapping providers.
//
// Every branch below returns a plain string (the model's generated text).
// tools.js is responsible for stripping markdown code fences if the chosen
// model wraps its output in them despite being asked not to.
// ---------------------------------------------------------------------------

import {
  FRONTEND_PROVIDER,
  FRONTEND_REQUEST_TIMEOUT_MS,
  CLOUDFLARE_AI_MODEL,
  OPENROUTER_API_KEY,
  OPENROUTER_API,
  OPENROUTER_MODEL,
} from "../../config.js";
import { cfAccountRequest } from "../cloudflare/client.js";
import { geminiGenerate } from "../gemini/client.js";

// -- cloudflare: Workers AI (/ai/run/{model}) --------------------------------
// Reuses CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID (config.js) -- no
// separate key needed for this provider. cfAccountRequest already handles
// auth/error-unwrapping and returns the unwrapped `result` object (see
// connectors/cloudflare/client.js).
async function callCloudflare(prompt) {
  const data = await cfAccountRequest(`/ai/run/${CLOUDFLARE_AI_MODEL}`, {
    method: "POST",
    body: { messages: [{ role: "user", content: prompt }] },
  });
  const text = data?.response;
  if (!text) throw new Error(`Cloudflare Workers AI (${CLOUDFLARE_AI_MODEL}) returned no response text.`);
  return text;
}

// -- openrouter: openrouter.ai (OpenAI-compatible /chat/completions) --------
// Optional provider -- only reachable if FRONTEND_PROVIDER=openrouter, at
// which point OPENROUTER_API_KEY becomes required.
async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Add it as an environment variable on the madmcp server, " +
      "or switch FRONTEND_PROVIDER away from 'openrouter'."
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FRONTEND_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err.name === "AbortError";
    throw new Error(isAbort
      ? `OpenRouter request timed out after ${FRONTEND_REQUEST_TIMEOUT_MS}ms (model: ${OPENROUTER_MODEL})`
      : `OpenRouter request failed (network error, model: ${OPENROUTER_MODEL}): ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`OpenRouter API error (${res.status}): ${message}`);
  }
  const output = data?.choices?.[0]?.message?.content;
  if (!output) throw new Error(`OpenRouter (${OPENROUTER_MODEL}) returned no response text.`);
  return output;
}

// -- gemini: reuses the existing Gemini connector's client + its own
// GEMINI_API_KEY/GEMINI_MODEL/fallback-cascade config -- nothing new here.
async function callGemini(prompt) {
  return geminiGenerate(prompt);
}

const PROVIDERS = {
  cloudflare: callCloudflare,
  openrouter: callOpenRouter,
  gemini:     callGemini,
};

export async function frontendGenerate(prompt) {
  const impl = PROVIDERS[FRONTEND_PROVIDER];
  if (!impl) {
    throw new Error(`Unknown FRONTEND_PROVIDER "${FRONTEND_PROVIDER}". Valid values: ${Object.keys(PROVIDERS).join(", ")}.`);
  }
  return impl(prompt);
}

// Exposed for tools.js's status/error messages without re-importing config.js.
export function currentProvider() {
  return FRONTEND_PROVIDER;
}
