// ---------------------------------------------------------------------------
// connectors/exa/cooldown.js — per-key rate-limit cooldown for the Exa
// connector, backed by Upstash Redis (Vercel Marketplace integration).
// Same Redis instance/credentials as connectors/gemini/cooldown.js and
// connectors/openai/cooldown.js -- both just namespace their keys
// differently below -- but a SEPARATE client + separate exported
// functions, not a shared import. See those files' headers for why that
// duplication is deliberate.
//
// WHY REDIS, NOT IN-MEMORY / WHY THIS NEVER SLEEPS: identical reasoning to
// connectors/gemini/cooldown.js -- see that file's header. Not repeated here
// beyond this pointer, to avoid the comments drifting apart over time.
//
// WHY keyIndex ALONE, UNLIKE connectors/openai/cooldown.js's (model,
// keyIndex): Exa's /answer endpoint has no selectable model for this call
// shape (see client.js's file header) -- the cascade in client.js is a 1D
// rotation across EXA_API_KEYS only, so a cooldown only ever needs to be
// namespaced by keyIndex (position in EXA_API_KEYS, not the key value
// itself), never a raw API key in a Redis key name.
// ---------------------------------------------------------------------------

import { Redis } from "@upstash/redis";

const COOLDOWN_KEY_PREFIX = "exa:cooldown:";
// Used only when a 429's message doesn't contain a parseable retry-delay
// hint. Exa's documented 429 body is a bare { "error": "..." } string with
// no structured retry-delay field, so this fallback carries most of the
// load in practice -- see parseRetryDelaySeconds below.
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
    console.warn("Redis client construction failed (exa connector) -- URL/token were found but rejected; treating Redis as unconfigured:", err?.message ?? err);
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

// Extracts a retry delay in whole seconds from an Exa 429 error message, if
// present. Exa's documented error format ({"error": "You've exceeded your
// Exa rate limit of 10 requests per second..."}) doesn't carry a structured
// delay in the observed wording, but this stays tolerant of the same
// phrasings connectors/openai/cooldown.js parses in case Exa's message
// wording includes one on a given account/plan -- returns null (falling
// back to DEFAULT_COOLDOWN_SECONDS) when neither pattern matches.
export function parseRetryDelaySeconds(message) {
  const match =
    /try again in ([\d.]+)\s*s/i.exec(message || "") ||
    /retry(?:[- ]after)? ([\d.]+)\s*s/i.exec(message || "");
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

function cooldownKey(keyIndex) {
  return `${COOLDOWN_KEY_PREFIX}${keyIndex}`;
}

// True if the key at `keyIndex` (its position in EXA_API_KEYS, not the key
// value) is currently recorded as rate-limited. Fails open (returns false)
// if Redis isn't configured or unreachable -- never throws.
export async function isKeyCoolingDown(keyIndex) {
  const client = getRedis();
  if (!client) return false;
  try {
    const value = await client.get(cooldownKey(keyIndex));
    return value != null;
  } catch {
    return false;
  }
}

// Records keyIndex as rate-limited for `seconds` (or
// DEFAULT_COOLDOWN_SECONDS if omitted/invalid), auto-expiring via Redis
// TTL. Fails open (silent no-op) if Redis isn't configured or unreachable --
// never throws.
export async function setKeyCooldown(keyIndex, seconds) {
  const client = getRedis();
  if (!client) return;
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_COOLDOWN_SECONDS;
  try {
    await client.set(cooldownKey(keyIndex), "1", { ex: ttl });
  } catch {
    // best-effort -- see file header
  }
}
