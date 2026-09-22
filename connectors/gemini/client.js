// ---------------------------------------------------------------------------
// connectors/gemini/client.js — Gemini API (generativelanguage.googleapis.com)
// Docs: https://ai.google.dev/gemini-api/docs
// Auth header: "x-goog-api-key: <api_key>"
// ---------------------------------------------------------------------------

import { GEMINI_API_KEYS, GEMINI_API, GEMINI_MODEL, GEMINI_FALLBACK_MODELS, GEMINI_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isModelCoolingDown, setModelCooldown, parseRetryDelaySeconds } from "../shared/cooldown.js";

// 503s and network-transient errors (timeout/dropped connection) carry no
// Retry-After header to parse, unlike a 429 (see parseRetryDelaySeconds), so
// we use a short fixed cooldown instead. Local to this file rather than
// config.js since it's an internal cascade-tuning constant, not something a
// deployer needs to override per-environment.
const TRANSIENT_COOLDOWN_SECONDS = 20;

// Rotates which API key each call starts its inner cascade loop on. Every
// call used to start at keyIndex 0 unconditionally, which meant key 0
// absorbed disproportionate load across the WHOLE app -- every single call,
// healthy or not, began there -- making it statistically the most likely
// already-exhausted key even for an otherwise-fresh call. Incrementing this
// per call spreads that starting-point load across all configured keys.
let keyRotationCounter = 0;

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

// Cascades through ([GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS] x GEMINI_API_KEYS),
// same two-axis shape as connectors/groq/client.js's callChatCompletion --
// see that file's header for the general reasoning. Model-first ordering:
// for a GIVEN model, try every configured key before dropping to the next
// fallback model. Rationale: use the strongest/primary model across ALL
// available API keys before ever falling back to a weaker model. A 429/503
// is usually a per-model, per-key quota signal, so exhausting all available
// keys/accounts on the primary model first ensures we maximize utilization
// of our best model before stepping down to weaker fallbacks.
//
// Key rotation is the natural inner loop: when a key hits rate limits or
// exhausts quota on the current model, we try the next key on that same model.
// If a key is bad or revoked (401/403), we `continue` to the next key under
// the same model. If all keys are exhausted for the current model, the inner
// key loop ends and the outer model loop advances to the next fallback model.
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
// applies in that case, same as Groq: trying all available keys on that
// explicitly requested model.
async function callGenerateContent(body, requestedModel) {
  if (!GEMINI_API_KEYS.length) {
    throw new Error("No Gemini API key configured. Set GEMINI_API_KEYS (or the legacy GEMINI_API_KEY) as an environment variable on the madmcp server.");
  }
  const models = requestedModel && requestedModel !== GEMINI_MODEL
    ? [requestedModel]
    : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)];

  let lastErr;
  // Chosen once per callGenerateContent invocation (not per model) so a
  // single call's cascade consistently rotates through keys in the same
  // order across every fallback model it tries.
  const keyStartOffset = GEMINI_API_KEYS.length ? (keyRotationCounter++ % GEMINI_API_KEYS.length) : 0;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLastModel = i === models.length - 1;

    for (let k = 0; k < GEMINI_API_KEYS.length; k++) {
      // k is the rotation POSITION (always 0..length-1 in order); keyIndex is
      // the REAL index into GEMINI_API_KEYS/cooldown namespacing, offset by
      // keyStartOffset so different calls start at different keys. Cooldown
      // recording/lookup below stays keyed off keyIndex (unchanged), so
      // rotation only affects iteration ORDER, never which namespace a given
      // key maps to.
      const keyIndex = (keyStartOffset + k) % GEMINI_API_KEYS.length;
      const apiKey = GEMINI_API_KEYS[keyIndex];
      const namespace = keyIndex === 0 ? undefined : `gemini:${keyIndex}`;
      // Computed from k (rotation position), NOT keyIndex -- keyIndex no
      // longer runs 0..length-1 in order once rotated, so checking keyIndex
      // here would make isLastCombination fire early or never, corrupting
      // the throw-vs-fall-through logic below.
      const isLastKeyForModel = k === GEMINI_API_KEYS.length - 1;
      const isLastCombination = isLastModel && isLastKeyForModel;

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
        // Only mark _fallbackModelUsed when the MODEL actually changed from the
        // primary/requested one (i > 0) -- a pure key rotation on the same model
        // (i === 0) must not be flagged as a model fallback, since `model` here
        // is just GEMINI_MODEL itself in that case, not an actual fallback entry.
        if (i > 0) data._fallbackModelUsed = model; // surfaced for logging/debugging, not required by callers
        // Gated on `k` (rotation position within THIS call's own attempts), not
        // `keyIndex` (the real array index): keyStartOffset means a call's very
        // first attempt can legitimately land on a non-zero keyIndex without
        // anything having failed, so keyIndex > 0 would falsely flag a
        // perfectly healthy, single-attempt call as a fallback. k > 0 means at
        // least one key was actually skipped (cooldown) or failed before this
        // one succeeded, which is the real signal cascade_log.js's "primary
        // model/key was unavailable" message needs. keyIndex is still the
        // value recorded (which key actually served the call), just no longer
        // the trigger condition.
        if (k > 0) data._fallbackKeyIndex = keyIndex;
        return data;
      } catch (err) {
        lastErr = err;
        const isBadKey = err.status === 401 || err.status === 403;
        const isRateLimited = err.status === 429;
        const isOverloaded  = err.status === 503;
        const isNetworkTransient = err.transient === true; // timeout/dropped connection, see callGenerateContentOnce
        // 404 = model ID retired/unknown (Google shuts down Gemini IDs on a
        // schedule, and 3.6+ Flash are short-term-availability models). The
        // same ID is missing under every key, so skip the remaining keys and
        // advance to the next fallback model rather than failing the call.
        const isModelGone = err.status === 404;
        // A bad/exhausted key (401/403) on the current model shouldn't stop
        // us from trying remaining keys on this model (or moving to the next
        // model if this was the last key). Continue to the next key.
        if (isBadKey) continue;
        if (isModelGone) {
          if (isLastModel) throw err;
          break;
        }
        if (!isRateLimited && !isOverloaded && !isNetworkTransient) throw err;
        if (isRateLimited) {
          // Rate-limited on this (model, key) pair -- record a cooldown
          // (best-effort; never blocks or throws on its own) so future calls
          // -- including a resumed/retried one -- can skip straight past it.
          // Recorded even on the very last model of the very last key: a 429
          // there still means it's exhausted for the window, and skipping
          // the call in that case would mean a resume walks straight back
          // into this same exhausted (model, key) pair and fails identically.
          await setModelCooldown(model, parseRetryDelaySeconds(err.message), namespace);
        }
        if (isOverloaded || isNetworkTransient) {
          // A 503 or timeout/dropped-connection leaves the (model, key) pair
          // just as unusable for a moment as a 429 does, but previously
          // recorded nothing -- so a same-run retry (or a resumed step) could
          // walk straight back into the identical hung/overloaded pair and
          // burn another full GEMINI_REQUEST_TIMEOUT_MS before failing again.
          // Fixed short cooldown since there's no Retry-After to parse and no
          // reliable per-model quota signal the way a 429 carries.
          await setModelCooldown(model, TRANSIENT_COOLDOWN_SECONDS, namespace);
        }
        if (isLastCombination) throw err;
        // Otherwise fall through -- either to the next key on this model,
        // or (via the outer loop, once all keys for this model are exhausted) to
        // the next fallback model.
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
// connectors/delegate/agent/agent_delegate.js's GitHub/Notion/Cloudflare investigation loop.
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
  // that loop was retired 2026-07-27 in favor of a direct Exa /answer call
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
  // Surface which fallback model/key actually served this call, if any --
  // callGenerateContent sets these on `data` (see its own comments), but
  // they'd otherwise be lost here since only `data.candidates[0]` is
  // returned. Attached directly onto the candidate object (not a separate
  // return value) so every existing caller that destructures `{ content,
  // finishReason }` off this return value is unaffected; only a caller that
  // explicitly checks for these two fields will ever see them.
  if (data._fallbackModelUsed) candidate._fallbackModelUsed = data._fallbackModelUsed;
  if (data._fallbackKeyIndex !== undefined) candidate._fallbackKeyIndex = data._fallbackKeyIndex;
  return candidate; // { content: { role, parts }, finishReason, ... }
}