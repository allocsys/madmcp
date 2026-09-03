// ---------------------------------------------------------------------------
// connectors/shared/cooldown.js — per-model rate-limit cooldown, backed by
// Upstash Redis (Vercel Marketplace integration).
//
// SHARED ACROSS PROVIDERS: this module has no Gemini-specific logic (it's
// pure model/namespace -> cooldown-until bookkeeping) and lives here, not
// under connectors/gemini/, because Gemini, GLM, Groq, and B.AI's clients
// (connectors/gemini/client.js, connectors/glm/client.js,
// connectors/groq/client.js, connectors/bai/client.js) all import it
// directly, plus connectors/delegate/agent/agent_checkpoint.js and
// connectors/delegate/agent/agent_delegate.js for Redis config checks, and the
// designer/editor delegate+checkpoint pairs under connectors/delegate/ for
// the same. Each provider
// namespaces its own keys (see DEFAULT_NAMESPACE below and each caller's
// own namespace argument) so a cooldown recorded for one provider/key never
// bleeds into another's.
//
// WHY REDIS, NOT IN-MEMORY: Vercel serverless functions don't guarantee a
// warm/reused instance between invocations (especially on the Hobby plan,
// which lacks Pro's "cold start prevention" / reserved concurrency), so an
// in-process Map would only help within a single delegate_agent call's
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

// Default namespace, preserved for every existing (Gemini) call site that
// doesn't pass one. Every other provider that shares this module (GLM, Groq,
// B.AI -- see connectors/glm/client.js, connectors/groq/client.js,
// connectors/bai/client.js) passes its own namespace instead (e.g.
// "glm:<keyIndex>", "bai:<keyIndex>", folding the key index in rather than
// adding a third parameter) so a 429 on one provider/key pair doesn't cool
// down a different provider or key's quota for that same model name.
const DEFAULT_NAMESPACE = "gemini";
function cooldownKey(model, namespace = DEFAULT_NAMESPACE) {
  return `${namespace}:cooldown:${model}`;
}
// Used only when a 429's message doesn't contain a parseable "retry in Ns"
// hint -- Google's actual responses observed so far always include one, so
// this is a conservative fallback, not the common case.
const DEFAULT_COOLDOWN_SECONDS = 60;

let redisClient = null;
let redisInitAttempted = false;

// NAMING: @upstash/redis's own Redis.fromEnv() only ever reads
// UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN -- but Vercel's own KV
// product (Marketplace "KV" / "Upstash for Redis" depending on how it was
// provisioned) names the exact same underlying Upstash REST credentials
// KV_REST_API_URL/KV_REST_API_TOKEN instead. Discovered 2026-07-26: Redis
// was fully provisioned and reachable, but getRedis() reported it as
// unconfigured on every call because Redis.fromEnv() was silently looking
// for env vars that were never going to exist under this integration --
// not a connectivity or credentials problem, a naming mismatch. Built the
// client manually with an explicit fallback so either naming convention
// works, rather than requiring the operator to duplicate env vars under
// both names.
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
    // Distinct from the "env vars simply unset" branch above, which is
    // expected and silent -- this means credentials WERE found under one of
    // the two naming conventions but the Redis client constructor itself
    // rejected them (malformed URL, wrong format, etc). Previously silent,
    // which made a genuine misconfiguration indistinguishable from Redis
    // just not being set up -- isModelCoolingDown/isRedisConfigured/etc all
    // report the same "not configured" either way, so this warning is the
    // only place that fact ever surfaces.
    console.warn("Redis client construction failed -- URL/token were found but rejected; treating Redis as unconfigured:", err?.message ?? err);
    redisClient = null;
  }
  return redisClient;
}

// Synchronous, side-effect-free (beyond the one-time lazy init above) check
// for whether cross-call Redis memory is actually available right now --
// used by agent_delegate.js to tell a caller UPFRONT that checkpointing/resume
// won't work this run (env var missing, or client construction failed),
// rather than letting them discover it only when a resume_run_id later
// comes back with no live checkpoint. Does not distinguish "not configured"
// from "configured but Redis.fromEnv() itself threw" -- both mean the same
// thing to a caller (no cross-call memory this run) and getRedis() doesn't
// preserve which one happened.
export function isRedisConfigured() {
  return getRedis() !== null;
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
export async function isModelCoolingDown(model, namespace) {
  const client = getRedis();
  if (!client) return false;
  try {
    const value = await client.get(cooldownKey(model, namespace));
    return value != null;
  } catch {
    return false;
  }
}

// Records `model` as rate-limited for `seconds` (or DEFAULT_COOLDOWN_SECONDS
// if omitted/invalid), auto-expiring via Redis TTL. Fails open (silent no-op)
// if Redis isn't configured or unreachable -- never throws.
export async function setModelCooldown(model, seconds, namespace) {
  const client = getRedis();
  if (!client) return;
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_COOLDOWN_SECONDS;
  try {
    await client.set(cooldownKey(model, namespace), "1", { ex: ttl });
  } catch {
    // best-effort -- see file header
  }
}
