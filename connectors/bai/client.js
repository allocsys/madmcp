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
// connectors/shared/cooldown.js's generic `namespace` param.
//
// This file stays a thin, faithful wire-format client -- format translation
// between Gemini's `contents`/`candidate` shape and OpenAI's
// `messages`/`choice` shape happens in connectors/openai_shape/adapter.js
// (shared with GLM/Groq), called from connectors/llm/router.js, not here.
// ---------------------------------------------------------------------------

import { BAI_API_KEYS, BAI_API, BAI_MODEL, BAI_REQUEST_TIMEOUT_MS } from "../../config.js";
import { isModelCoolingDown, setModelCooldown, parseRetryDelaySeconds } from "../shared/cooldown.js";

const MAX_KEY_ROTATION_PASSES = 2;

async function callChatCompletionOnce(body, apiKey, keyIndex = 0) {
  if (!apiKey) throw new Error("No B.AI API key available. Set BAI_API_KEYS as an environment variable on the madmcp server.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BAI_REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  console.log(`bai: attempting key #${keyIndex} (startedAt=${startedAt})`);

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
    const elapsedMs = Date.now() - startedAt;
    const isAbort = err.name === "AbortError";
    const failureReason = isAbort ? "timeout" : "network error";
    console.log(`bai: key #${keyIndex} attempt failed (reason=${failureReason}, durationMs=${elapsedMs})`);
    const wrapped = new Error(isAbort ? `B.AI request timed out after ${BAI_REQUEST_TIMEOUT_MS}ms` : `B.AI request failed (network error): ${err.message}`);
    wrapped.transient = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  const elapsedMs = Date.now() - startedAt;
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    console.log(`bai: key #${keyIndex} attempt failed (status=${res.status}, durationMs=${elapsedMs})`);
    const message = (data && (data.error?.message || JSON.stringify(data))) || res.statusText;
    const err = new Error(`B.AI API error (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }

  console.log(`bai: key #${keyIndex} attempt succeeded (status=${res.status}, durationMs=${elapsedMs})`);
  return data;
}

// Cascades through BAI_API_KEYS on 401/403 (bad/exhausted key), 429
// (rate limit), or 503 (overloaded).
async function callChatCompletion(body) {
  if (!BAI_API_KEYS.length) {
    throw new Error("BAI_API_KEYS is not set. Add at least one B.AI API key as an environment variable on the madmcp server.");
  }

  const keyAttempts = [];

  for (let pass = 0; pass < MAX_KEY_ROTATION_PASSES; pass++) {
    let passAttemptCount = 0;

    for (let keyIndex = 0; keyIndex < BAI_API_KEYS.length; keyIndex++) {
      const apiKey = BAI_API_KEYS[keyIndex];
      const namespace = `bai:${keyIndex}`;

      if (await isModelCoolingDown(BAI_MODEL, namespace)) {
        // A recorded cooldown is itself always rate-limit-caused (see
        // setModelCooldown's only call site below) -- transient by definition.
        keyAttempts.push({ keyIndex, reason: "recorded cooldown", transient: true });
        continue;
      }

      passAttemptCount++;
      try {
        const data = await callChatCompletionOnce({ ...body, model: BAI_MODEL }, apiKey, keyIndex);
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
        } else if (isOverloaded || isNetworkTransient) {
          // No Retry-After-style hint on 503s or timeouts -- pass undefined so
          // setModelCooldown() falls back to its existing DEFAULT_COOLDOWN_SECONDS
          // (60s, see cooldown.js). Without this, a chronically slow/overloaded
          // key got retried live from scratch on every step instead of being
          // skipped, which is what drove the widening per-step stall gap.
          await setModelCooldown(BAI_MODEL, undefined, namespace);
        }
      }
    }

    // If this pass made zero live attempts (i.e. every key was already cooling down
    // before we started), further passes won't help, so stop immediately.
    if (passAttemptCount === 0) {
      break;
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

// Floor for the retry's max_tokens bump (see computeRetryMaxTokens below) --
// live testing found a fixed cap of 1200 still exhausted the reasoning
// budget 2/5 times even with reasoning_effort=low, so the retry needs
// meaningfully more headroom than any of the caps that were shown to fail,
// not just a small bump over whatever the original call used.
const RETRY_MIN_MAX_TOKENS = 4096;

// The original call's max_tokens (if any) doubled, floored at
// RETRY_MIN_MAX_TOKENS -- covers both "caller passed a small explicit cap
// that turned out to be too tight" (double it) and "caller passed nothing at
// all" (fall straight to the floor, since there's nothing to double).
function computeRetryMaxTokens(originalMaxTokens) {
  if (typeof originalMaxTokens === "number" && originalMaxTokens > 0) {
    return Math.max(originalMaxTokens * 2, RETRY_MIN_MAX_TOKENS);
  }
  return RETRY_MIN_MAX_TOKENS;
}

// Helper to extract reasoning, completion, and total tokens from either
// the top-level usage shape (usage.reasoning_tokens) or the nested
// OpenAI-style shape (usage.completion_tokens_details.reasoning_tokens).
export function extractUsageDetails(usage) {
  if (!usage) return { reasoningTokens: undefined, completionTokens: undefined, totalTokens: undefined };
  const reasoningTokens = typeof usage.reasoning_tokens === "number"
    ? usage.reasoning_tokens
    : (typeof usage.completion_tokens_details?.reasoning_tokens === "number"
      ? usage.completion_tokens_details.reasoning_tokens
      : undefined);
  return {
    reasoningTokens,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
  };
}

function logResponseUsage(choice, usage) {
  const { reasoningTokens, completionTokens, totalTokens } = extractUsageDetails(usage);
  const finishReason = choice?.finish_reason;
  console.log(`bai: response finish_reason=${finishReason} reasoning_tokens=${reasoningTokens ?? "none"} completion_tokens=${completionTokens ?? "none"} total_tokens=${totalTokens ?? "none"}`);
}

// Detects the root-caused failure shape where key rotation and reasoning-token exhaustion
// interact: the completion hit its max_tokens ceiling (finish_reason "length") with the
// token budget spent almost entirely on internal reasoning_tokens rather
// than the visible answer -- i.e. this was NOT a case of a genuinely long,
// mostly-complete answer that simply ran a little over budget; the model
// barely got to writing an answer at all before truncation. 0.9 is a
// deliberately generous threshold (an answer that's 10%+ of the token
// spend is treated as "the model was actually answering, just verbose" and
// left alone -- only the near-total-reasoning-consumption case triggers a
// retry).
//
// Checks two possible `usage` shapes for reasoning_tokens since bai's exact
// wire format for this field isn't documented anywhere this codebase has
// access to: a top-level `usage.reasoning_tokens` (seen directly in this
// investigation's own test-bai-timeout.sh probing) and the nested
// `usage.completion_tokens_details.reasoning_tokens` shape OpenAI's own
// o-series reasoning models use (bai is OpenAI-shaped throughout, per this
// file's header, so its exact reasoning-model wire format may follow
// either OpenAI's own precedent or its own convention -- support both
// rather than gambling on one).
export function isReasoningBudgetExhausted(choice, usage) {
  if (choice?.finish_reason !== "length") return false;
  if (!usage) return false;

  const { reasoningTokens, completionTokens } = extractUsageDetails(usage);

  if (typeof reasoningTokens !== "number" || typeof completionTokens !== "number" || completionTokens <= 0) {
    return false;
  }

  return (reasoningTokens / completionTokens) >= 0.9;
}

export async function baiChat(messages, { tools, maxOutputTokens, reasoningEffort } = {}) {
  const body = { messages };
  if (tools) body.tools = tools;
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  let data = await callChatCompletion(body);
  let choice = data?.choices?.[0];
  if (!choice) {
    throw new Error("B.AI returned no choices.");
  }
  logResponseUsage(choice, data.usage);

  // Retry ONCE, with a larger max_tokens budget, if this call's entire
  // token budget went to reasoning and produced no usable answer. Do NOT
  // raise reasoning_effort on the retry -- body.reasoning_effort is reused
  // as-is (whatever the caller passed, or omitted entirely), since a higher
  // effort setting produces MORE reasoning tokens, which would make budget
  // exhaustion on the retry more likely, not less (see this function's own
  // header comment and isReasoningBudgetExhausted's for the live-testing
  // evidence behind this constraint).
  if (isReasoningBudgetExhausted(choice, data.usage)) {
    const retryBody = { ...body, max_tokens: computeRetryMaxTokens(maxOutputTokens) };
    data = await callChatCompletion(retryBody);
    choice = data?.choices?.[0];
    if (!choice) {
      throw new Error("B.AI returned no choices on retry (after reasoning-token-budget exhaustion on the first attempt).");
    }
    logResponseUsage(choice, data.usage);
  }

  return choice;
}
