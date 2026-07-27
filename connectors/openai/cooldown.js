// ---------------------------------------------------------------------------
// connectors/openai/cooldown.js — per (model, key) rate-limit cooldown for
// the OpenAI connector, backed by Upstash Redis (Vercel Marketplace
// integration). Same Redis instance/credentials as connectors/gemini/
// cooldown.js -- both just namespace their keys differently below -- but a
// SEPARATE client + separate exported functions, not a shared import. See
// this file's commit message for why that duplication is deliberate.
//
// WHY REDIS, NOT IN-MEMORY / WHY THIS NEVER SLEEPS: identical reasoning to
// connectors/gemini/cooldown.js -- see that file's header. Not repeated here
// beyond this pointer, to avoid the two comments drifting apart over time.
//
// WHY (model, keyIndex) AND NOT JUST model: connectors/openai/client.js
// cascades through OPENAI_FALLBACK_MODELS on ONE key before rotating to the
// NEXT key in OPENAI_API_KEYS (config.js) -- a 2D grid, not Gemini's 1D
// model-only cascade. A cooldown recorded against "gpt-5.4-mini" alone
// would incorrectly skip that model on every key, even ones that haven't
// been rate-limited at all. Namespacing by keyIndex (position in
// OPENAI_API_KEYS, not the key value itself) keeps each key's quota state
// independent, and never puts a raw API key into a Redis key name.
// ---------------------------------------------------------------------------

import { Redis } from "@upstash/redis";

const COOLDOWN_KEY_PREFIX = "openai:cooldown:";
// Used only when a 429's message doesn't contain a parseable retry-delay
// hint. OpenAI's error bodies are less consistent about this than Gemini's
// observed-so-far format, so this fallback carries more of the load here.
const DEFAULT_COOLDOWN_SECONDS = 60;

let redisClient = null;
let redisInitAttempted = false;

// Same dual-naming-convention handling as connectors/gemini/cooldown.js's
// getRedis() -- see that file's comment for the 2026-07-26 discovery this
// works around (Vercel's own "KV" product exposes the same Upstash REST
// credentials under KV_REST_API_URL/TOKEN instead of the raw Marketplace
// integration's UPSTASH_REDIS_REST_URL/TOKEN names).
export function getRedis() {
  if (redisInitAttempted) return redisClient;
  redisInitAttempted = true;
  const url   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return null; // Neither naming convention is set -- fine, just no cross-call memory.
  }
  try {
    redisClient = new Redis({ url, token });
  } catch (err) {
    console.warn("Redis client construction failed (openai connector) -- URL/token were found but rejected; treating Redis as unconfigured:", err?.message ?? err);
    redisClient = null;
  }
  return redisClient;
}

// Same purpose as connectors/gemini/cooldown.js's isRedisConfigured -- lets
// a caller know upfront whether cross-call cooldown memory is actually
// available this run, rather than discovering it only via silent no-ops.
export function isRedisConfigured() {
  return getRedis() !== null;
}

// Extracts a retry delay in whole seconds from an OpenAI 429 error message.
// Tolerant of both phrasings OpenAI's error bodies have been observed to
// use ("...Please try again in 20s." and "...retry after 1.234s") --
// returns null if neither pattern matches, so the caller falls back to
// DEFAULT_COOLDOWN_SECONDS.
export function parseRetryDelaySeconds(message) {
  const match =
    /try again in ([\d.]+)\s*s/i.exec(message || "") ||
    /retry(?:[- ]after)? ([\d.]+)\s*s/i.exec(message || "");
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

function cooldownKey(model, keyIndex) {
  return `${COOLDOWN_KEY_PREFIX}${model}:${keyIndex}`;
}

// True if `model` on the key at `keyIndex` (its position in OPENAI_API_KEYS,
// not the key value) is currently recorded as rate-limited. Fails open
// (returns false) if Redis isn't configured or unreachable -- never throws.
export async function isCombinationCoolingDown(model, keyIndex) {
  const client = getRedis();
  if (!client) return false;
  try {
    const value = await client.get(cooldownKey(model, keyIndex));
    return value != null;
  } catch {
    return false;
  }
}

// Records (model, keyIndex) as rate-limited for `seconds` (or
// DEFAULT_COOLDOWN_SECONDS if omitted/invalid), auto-expiring via Redis
// TTL. Fails open (silent no-op) if Redis isn't configured or unreachable --
// never throws.
export async function setCombinationCooldown(model, keyIndex, seconds) {
  const client = getRedis();
  if (!client) return;
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_COOLDOWN_SECONDS;
  try {
    await client.set(cooldownKey(model, keyIndex), "1", { ex: ttl });
  } catch {
    // best-effort -- see file header
  }
}
