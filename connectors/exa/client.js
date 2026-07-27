// ---------------------------------------------------------------------------
// connectors/exa/client.js — Exa /answer API, used as a search+synthesis
// fallback. Docs: https://docs.exa.ai/reference/answer
// Auth header: "x-api-key: <api_key>"
//
// WHY THIS EXISTS ALONGSIDE GEMINI'S NATIVE GOOGLE SEARCH GROUNDING:
// connectors/gemini/research.js already gets search via the native
// googleSearch tool combined with the web_fetch function -- see that
// file's header for the exact combination contract. But that combination
// is a Preview feature limited to Gemini 3 models, and GEMINI_FALLBACK_MODELS
// (config.js) may include an older model that rejects it outright (400).
// When that happens mid-run, research.js sets searchToolDisabledThisRun
// and falls back to FUNCTION_DECLARATIONS only -- which, without a
// standalone search fallback, means web_fetch with NO way to find a URL
// it doesn't already have. exaWebSearch() below plugs that gap as an
// ordinary function tool, no native-tool combination involved at all.
//
// FORMERLY OPENAI (2026-07-27): this file replaces connectors/openai/
// client.js, which did the same job via OpenAI's Responses API web_search
// tool. Swapped to Exa's /answer endpoint -- same "search + synthesize
// with sources" shape, different provider. See git history for the prior
// implementation if the OpenAI version needs to be resurrected.
//
// NO FREE TIER: Exa's /answer endpoint is billed per call (plus content
// retrieval costs baked into the same call), regardless of key. The
// cascade below is about RATE-LIMIT HEADROOM (Exa's documented default is
// 10 QPS per account, shared across ALL endpoints) and having a second
// account's quota to fall into if one is exhausted -- not about reaching
// some free quota. Don't describe this to a caller/user as "free."
//
// CASCADE ORDER: unlike the OpenAI client this replaces, there is no
// model tier to cascade through first -- Exa's /answer endpoint doesn't
// expose a selectable model for this call shape. The cascade is simply
// EXA_API_KEYS in order: on a 429/503/network-transient error, rotate to
// the next key. See connectors/exa/cooldown.js for the per-keyIndex
// cross-call memory that lets a known-cooling-down key be skipped without
// spending a request on it.
// ---------------------------------------------------------------------------

import { EXA_API_KEYS, EXA_API, EXA_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isKeyCoolingDown, setKeyCooldown, parseRetryDelaySeconds } from "./cooldown.js";

async function callAnswerOnce(query, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXA_REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(EXA_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, text: true }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network-level failure (dropped connection, DNS/TLS error, our own
    // abort firing) -- none of these carry an HTTP status. `transient: true`
    // lets the cascade below treat them the same as a 503, same reasoning
    // as connectors/gemini/client.js's callGenerateContentOnce.
    const isAbort = err.name === "AbortError";
    const wrapped = new Error(
      isAbort
        ? `Exa request timed out after ${EXA_REQUEST_TIMEOUT_MS}ms`
        : `Exa request failed (network error): ${err.message}`
    );
    wrapped.transient = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    // Exa's 429 body is a bare { "error": "..." } string, not the nested
    // { error: { message } } shape OpenAI/Gemini use -- handle both just
    // in case, but Exa's documented format is the flat one.
    const message = (data && (data.error?.message || data.error || JSON.stringify(data))) || res.statusText;
    const err = new Error(`Exa API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cascades across EXA_API_KEYS on a 429 (rate limit -- Exa's documented
// default is 10 QPS shared across all endpoints, per account), 503
// (overloaded), or network-transient error. Any other status (400, 401,
// etc.) is a real failure and surfaces immediately -- none of those are
// problems a different key would fix. Throws if EXA_API_KEYS is empty,
// since there is nothing to cascade through.
async function callAnswer(query) {
  if (EXA_API_KEYS.length === 0) {
    throw new Error("EXA_API_KEYS is not set. Add at least one key as a comma-separated env var on the madmcp server.");
  }

  let lastErr;
  for (let keyIndex = 0; keyIndex < EXA_API_KEYS.length; keyIndex++) {
    const apiKey = EXA_API_KEYS[keyIndex];
    const isLastAttempt = keyIndex === EXA_API_KEYS.length - 1;

    // Best-effort cross-call memory (see cooldown.js): if this key was
    // 429'd recently -- possibly in a prior invocation, since Vercel
    // doesn't guarantee a warm/reused instance -- skip it without spending
    // a request.
    if (await isKeyCoolingDown(keyIndex)) {
      lastErr = lastErr || new Error(`Exa API error (429): key #${keyIndex} is in a recorded cooldown from a recent rate limit.`);
      continue;
    }

    try {
      const data = await callAnswerOnce(query, apiKey);
      if (keyIndex > 0) data._fallbackUsed = { keyIndex }; // surfaced for logging/debugging only
      return data;
    } catch (err) {
      lastErr = err;
      const isRateLimited = err.status === 429;
      const isOverloaded = err.status === 503;
      const isNetworkTransient = err.transient === true;
      if ((!isRateLimited && !isOverloaded && !isNetworkTransient) || isLastAttempt) throw err;
      if (isRateLimited) {
        await setKeyCooldown(keyIndex, parseRetryDelaySeconds(err.message));
      }
      // Fall through to the next key.
    }
  }
  throw lastErr;
}

// Runs one web search + synthesis via Exa's /answer endpoint and returns
// plain text (the model's own synthesis) -- same shape a caller would get
// from Gemini's native Google Search grounding or the OpenAI web_search
// tool this replaces. Throws if every key in the cascade fails; the caller
// (research.js's function execute() wrapper) turns that into an
// "Error: ..." string rather than crashing the research loop.
export async function exaWebSearch(query) {
  const data = await callAnswer(query);
  const answer = typeof data?.answer === "string" ? data.answer : (data?.answer ? JSON.stringify(data.answer) : "");
  if (!answer) throw new Error("Exa /answer returned no answer text.");
  return answer;
}
