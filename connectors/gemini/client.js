// ---------------------------------------------------------------------------
// connectors/gemini/client.js — Gemini API (generativelanguage.googleapis.com)
// Docs: https://ai.google.dev/gemini-api/docs
// Auth header: "x-goog-api-key: <api_key>"
// ---------------------------------------------------------------------------

import { GEMINI_API_KEY, GEMINI_API, GEMINI_MODEL, GEMINI_FALLBACK_MODELS } from "../../config.js";
import { isModelCoolingDown, setModelCooldown, parseRetryDelaySeconds } from "./cooldown.js";

// No official guidance from Google on a max generateContent latency; this
// is a defensive ceiling so a hung/dropped connection fails fast enough for
// delegate.js's per-step checkpointing to actually kick in, rather than the
// whole request (and the platform's own hosting-duration limit) timing out
// with zero information back to the caller. Override via env var if this
// proves too tight for slower multi-tool-call turns.
const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 55000;

async function callGenerateContentOnce(body, model) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set. Add it as an environment variable on the madmcp server.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${GEMINI_API}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
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
    // lets the cascade (and delegate.js's isTransientGeminiError) treat them
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

// Cascades through GEMINI_MODEL + GEMINI_FALLBACK_MODELS on a 429 (rate
// limit exceeded) OR a 503 (overloaded/high demand). Free-tier Gemini
// quotas are tracked per model, so a fresh model has its own separate RPM
// bucket on a 429, making cascade a legitimate way to keep going rather
// than a blind retry. A 503 isn't a quota signal, but each model is still a
// separate backend deployment, so one being overloaded doesn't mean the
// next is -- worth trying before failing the whole call. Any other status
// (400, 500, etc.) is a real failure and surfaces immediately without
// trying other models, since those aren't problems a different model would fix.
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
    const model = models[i];
    // Best-effort cross-call memory (see cooldown.js): if this model was 429'd
    // recently -- possibly in a prior invocation, since Vercel doesn't
    // guarantee a warm/reused instance between calls -- skip it without
    // spending a request, same as if it had just failed with a fresh 429.
    if (await isModelCoolingDown(model)) {
      lastErr = lastErr || new Error(`Gemini API error (429): model "${model}" is in a recorded cooldown from a recent rate limit.`);
      continue;
    }
    try {
      const data = await callGenerateContentOnce(body, model);
      if (i > 0) data._fallbackModelUsed = model; // surfaced for logging/debugging, not required by callers
      return data;
    } catch (err) {
      lastErr = err;
      const isLast = i === models.length - 1;
      const isRateLimited = err.status === 429;
      const isOverloaded  = err.status === 503;
      const isNetworkTransient = err.transient === true; // timeout/dropped connection, see callGenerateContentOnce
      if ((!isRateLimited && !isOverloaded && !isNetworkTransient) || isLast) throw err;
      if (isRateLimited) {
        // Rate-limited on this model -- record a cooldown (best-effort; never
        // blocks or throws on its own) so future calls can skip straight past
        // it. No equivalent recording for 503: there's no per-model quota
        // hint to parse, and an overload isn't reliably tied to this model
        // specifically the way a 429 is.
        await setModelCooldown(model, parseRetryDelaySeconds(err.message));
      }
      // Fall through to try the next model either way.
    }
  }
  throw lastErr;
}

// Single-turn text generation. Takes a plain prompt string (build any
// system/user framing into it before calling) and returns the model's text
// output. Used by Delegate_web_fetch -- a genuine one-shot "here's context,
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
