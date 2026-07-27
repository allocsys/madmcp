// ---------------------------------------------------------------------------
// connectors/openai/client.js — OpenAI Responses API, built-in web_search
// tool only. Docs: https://platform.openai.com/docs/api-reference/responses
// Auth header: "Authorization: Bearer <api_key>"
//
// WHY THIS EXISTS ALONGSIDE GEMINI'S NATIVE GOOGLE SEARCH GROUNDING:
// connectors/gemini/research.js already gets search via the native
// googleSearch tool combined with the web_fetch function -- see that
// file's header for the exact combination contract. But that combination
// is a Preview feature limited to Gemini 3 models, and GEMINI_FALLBACK_MODELS
// (config.js) may include an older model that rejects it outright (400).
// When that happens mid-run, research.js sets searchToolDisabledThisRun
// and falls back to FUNCTION_DECLARATIONS only -- which, before this file
// existed, meant web_fetch with NO way to find a URL it doesn't already
// have. openaiWebSearch() below plugs that gap as an ordinary function
// tool, no native-tool combination involved at all.
//
// NO FREE TIER: unlike Gemini's free-tier RPM quotas (the reason
// GEMINI_FALLBACK_MODELS exists), OpenAI's web_search tool is billed per
// call (flat rate, on top of normal per-token pricing) regardless of
// model or key. The cascade below is about RATE-LIMIT HEADROOM and cost
// control (cheaper models cost less per call; multiple keys mean one
// account's 429s don't stop the loop), not about reaching some free quota
// -- there isn't one. Don't describe this to a caller/user as "free."
//
// CASCADE ORDER: model first (OPENAI_MODEL, then OPENAI_FALLBACK_MODELS),
// all on the SAME key, before rotating to the NEXT key in OPENAI_API_KEYS.
// Rationale: a rate limit is almost always per-model-per-key, so trying a
// cheaper model on the same key is the cheapest next step; only once every
// model on a key has failed is a whole different account worth spending a
// request on. See connectors/openai/cooldown.js for the per-(model,
// keyIndex) cross-call memory that lets a known-cooling-down combination
// be skipped without spending a request on it.
// ---------------------------------------------------------------------------

import { OPENAI_API_KEYS, OPENAI_API, OPENAI_MODEL, OPENAI_FALLBACK_MODELS, OPENAI_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isCombinationCoolingDown, setCombinationCooldown, parseRetryDelaySeconds } from "./cooldown.js";

async function callResponsesOnce(query, model, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(OPENAI_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        input: query,
      }),
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
        ? `OpenAI request timed out after ${OPENAI_REQUEST_TIMEOUT_MS}ms (model: ${model})`
        : `OpenAI request failed (network error, model: ${model}): ${err.message}`
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
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    const err = new Error(`OpenAI API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cascades model (within one key), then key (across OPENAI_API_KEYS), on a
// 429 (rate limit), 503 (overloaded), or network-transient error. Any other
// status (400, 401, etc.) is a real failure and surfaces immediately --
// none of those are problems a different model or key would fix. Throws if
// OPENAI_API_KEYS is empty, since there is nothing to cascade through.
async function callResponses(query) {
  if (OPENAI_API_KEYS.length === 0) {
    throw new Error("OPENAI_API_KEYS is not set. Add at least one key as a comma-separated env var on the madmcp server.");
  }
  const models = [OPENAI_MODEL, ...OPENAI_FALLBACK_MODELS.filter((m) => m !== OPENAI_MODEL)];

  let lastErr;
  for (let keyIndex = 0; keyIndex < OPENAI_API_KEYS.length; keyIndex++) {
    const apiKey = OPENAI_API_KEYS[keyIndex];
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      const isLastAttempt = keyIndex === OPENAI_API_KEYS.length - 1 && m === models.length - 1;

      // Best-effort cross-call memory (see cooldown.js): if this exact
      // (model, key) pair was 429'd recently -- possibly in a prior
      // invocation, since Vercel doesn't guarantee a warm/reused instance --
      // skip it without spending a request.
      if (await isCombinationCoolingDown(model, keyIndex)) {
        lastErr = lastErr || new Error(`OpenAI API error (429): model "${model}" on key #${keyIndex} is in a recorded cooldown from a recent rate limit.`);
        continue;
      }

      try {
        const data = await callResponsesOnce(query, model, apiKey);
        if (keyIndex > 0 || m > 0) data._fallbackUsed = { model, keyIndex }; // surfaced for logging/debugging only
        return data;
      } catch (err) {
        lastErr = err;
        const isRateLimited = err.status === 429;
        const isOverloaded = err.status === 503;
        const isNetworkTransient = err.transient === true;
        if ((!isRateLimited && !isOverloaded && !isNetworkTransient) || isLastAttempt) throw err;
        if (isRateLimited) {
          await setCombinationCooldown(model, keyIndex, parseRetryDelaySeconds(err.message));
        }
        // Fall through to the next model, or (once models are exhausted for
        // this key) the next key.
      }
    }
  }
  throw lastErr;
}

// The Responses API's `output_text` convenience field is usually present,
// but this walks the raw `output` array as a fallback in case a particular
// response shape omits it (e.g. certain finish/incomplete states).
function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("").trim();
}

// Runs one web search + synthesis via OpenAI's built-in web_search tool and
// returns plain text (the model's own synthesis, with citations inline where
// it chose to include them) -- same shape a caller would get from Gemini's
// native Google Search grounding. Throws if every (model, key) combination
// in the cascade fails; the caller (research.js's function execute()
// wrapper) turns that into an "Error: ..." string rather than crashing the
// research loop.
export async function openaiWebSearch(query) {
  const data = await callResponses(query);
  const text = extractOutputText(data);
  if (!text) throw new Error("OpenAI web_search returned no text output.");
  return text;
}
