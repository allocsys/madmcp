// ---------------------------------------------------------------------------
// connectors/gemini/cooldown.js — per-model rate-limit cooldown, backed by
// Upstash Redis (Vercel Marketplace integration).
//
// WHY REDIS, NOT IN-MEMORY: Vercel serverless functions don't guarantee a
// warm/reused instance between invocations (especially on the Hobby plan,
// which lacks Pro's "cold start prevention" / reserved concurrency), so an
// in-process Map would only help within a single delegate_gemini call's
// own multi-step loop -- it can't prevent separate tool calls from re-hitting
// a model that was already rate-limited seconds ago in a prior invocation.
// Redis's native TTL gives "key expires itself" for free, matching the data
// shape exactly (model -> cooldown-until), which is why this isn't Postgres:
// no schema, no manual expiry bookkeeping, one round-trip per check.
//
// WHY THIS NEVER SLEEPS: Hobby-plan function duration is capped (60s without
// Fluid Compute; still bounded with it), and HARD_MAX_STEPS's investigation
// loop can run many turns in one invocation -- blocking on Google's own
// "retry in Ns" hint would eat directly into that budget. So this only ever
// SKIPS a model known to be cooling down (saving a wasted quota-consuming
// request) and lets the existing cascade in client.js fall through to the
// next model immediately, exactly as it does today for a live 429.
//
// BEST-EFFORT BY DESIGN: if UPSTASH_REDIS_REST_URL/TOKEN aren't set (e.g.
// before the Marketplace integration is activated in the Vercel dashboard)
// or a Redis call fails for any reason, every function here fails open --
// checks return "not cooling down" and writes silently no-op. A missing or
// down Redis must never be the reason a real Gemini call fails; it only
// means cross-call memory is temporarily unavailable, same as before this
// file existed.
// ---------------------------------------------------------------------------

import { Redis } from "@upstash/redis";

const COOLDOWN_KEY_PREFIX = "gemini:cooldown:";
// Used only when a 429's message doesn't contain a parseable "retry in Ns"
// hint -- Google's actual responses observed so far always include one, so
// this is a conservative fallback, not the common case.
const DEFAULT_COOLDOWN_SECONDS = 60;

let redisClient = null;
let redisInitAttempted = false;

export function getRedis() {
  if (redisInitAttempted) return redisClient;
  redisInitAttempted = true;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null; // Marketplace integration not activated yet -- fine, just no cross-call memory.
  }
  try {
    redisClient = Redis.fromEnv();
  } catch {
    redisClient = null;
  }
  return redisClient;
}

// Extracts a retry delay in whole seconds from a Gemini 429 error message,
// e.g. "...Please retry in 52.395004654s." Returns null if not found, so the
// caller can fall back to DEFAULT_COOLDOWN_SECONDS.
export function parseRetryDelaySeconds(message) {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || "");
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

// True if `model` is currently recorded as rate-limited. Fails open (returns
// false) if Redis isn't configured or unreachable -- never throws.
export async function isModelCoolingDown(model) {
  const client = getRedis();
  if (!client) return false;
  try {
    const value = await client.get(COOLDOWN_KEY_PREFIX + model);
    return value != null;
  } catch {
    return false;
  }
}

// Records `model` as rate-limited for `seconds` (or DEFAULT_COOLDOWN_SECONDS
// if omitted/invalid), auto-expiring via Redis TTL. Fails open (silent no-op)
// if Redis isn't configured or unreachable -- never throws.
export async function setModelCooldown(model, seconds) {
  const client = getRedis();
  if (!client) return;
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_COOLDOWN_SECONDS;
  try {
    await client.set(COOLDOWN_KEY_PREFIX + model, "1", { ex: ttl });
  } catch {
    // best-effort -- see file header
  }
}
