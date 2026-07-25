// ---------------------------------------------------------------------------
// connectors/gemini/client.js — Gemini API (generativelanguage.googleapis.com)
// Docs: https://ai.google.dev/gemini-api/docs
// Auth header: "x-goog-api-key: <api_key>"
// ---------------------------------------------------------------------------

import { GEMINI_API_KEY, GEMINI_API, GEMINI_MODEL, GEMINI_FALLBACK_MODELS } from "../../config.js";

async function callGenerateContentOnce(body, model) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set. Add it as an environment variable on the Manufact server.");

  const res = await fetch(`${GEMINI_API}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "Content-Type":   "application/json",
    },
    body: JSON.stringify(body),
  });

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

// Cascades through GEMINI_MODEL + GEMINI_FALLBACK_MODELS, but ONLY on a 429
// (rate limit exceeded) -- free-tier Gemini quotas are tracked per model, so
// a fresh model has its own separate RPM bucket, making this a legitimate
// way to keep going rather than a blind retry. Any other status (400, 500,
// etc.) is a real failure and surfaces immediately without trying other
// models, since those aren't quota problems a different model would fix.
//
// If the caller passed an explicit `model` that differs from the configured
// default (GEMINI_MODEL), that choice is honored exactly with no cascade --
// they asked for that specific model, so silently substituting another one
// on a 429 would violate that request.
async function callGenerateContent(body, requestedModel) {
  const models = requestedModel && requestedModel !== GEMINI_MODEL
    ? [requestedModel]
    : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)];

  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      const data = await callGenerateContentOnce(body, models[i]);
      if (i > 0) data._fallbackModelUsed = models[i]; // surfaced for logging/debugging, not required by callers
      return data;
    } catch (err) {
      lastErr = err;
      const isLast = i === models.length - 1;
      if (err.status !== 429 || isLast) throw err;
      // else: rate-limited on this model -- fall through to try the next one.
    }
  }
  throw lastErr;
}

// Single-turn text generation. Takes a plain prompt string (build any
// system/user framing into it before calling) and returns the model's text
// output. Used by web_fetch_and_ask -- a genuine one-shot "here's context,
// answer this" call with no tool use.
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
// connectors/gemini/delegate.js's investigation loop. Unlike geminiGenerate,
// this takes/returns the raw `contents` conversation array and the raw
// candidate, since the caller (delegate.js) needs to inspect whether the
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
// delegate.js for how a turn is actually built -- don't "fix" it back to
// role: "function" without re-checking current docs against the model in use.
export async function geminiChat(contents, { model = GEMINI_MODEL, tools, maxOutputTokens } = {}) {
  const body = { contents };
  if (tools) body.tools = tools;
  if (maxOutputTokens) body.generationConfig = { maxOutputTokens };

  const data = await callGenerateContent(body, model);
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    throw new Error("Gemini returned no candidates.");
  }
  return candidate; // { content: { role, parts }, finishReason, ... }
}
