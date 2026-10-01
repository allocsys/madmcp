// ---------------------------------------------------------------------------
// connectors/shared/lock.js -- short-lived mutual exclusion keyed by string.
//
// Two layers:
//   1. In-process promise chain per key (always on): serializes callers
//      inside one server instance.
//   2. Upstash Redis `SET key token NX EX ttl` (when Redis is configured):
//      serializes callers across Vercel serverless instances, which share
//      no memory. Same fail-open policy as cooldown.js -- a missing/down
//      Redis never blocks the caller, it only means cross-instance
//      protection is unavailable (callers keep their own post-hoc
//      reconciliation as the backstop).
//
// If the Redis lock can't be obtained within `waitMs` the function runs
// anyway (fail open) rather than stalling a tool call on a stuck lock;
// the TTL guarantees a crashed holder can't wedge the key.
// ---------------------------------------------------------------------------

import { getRedis } from "./cooldown.js";
import { sleep } from "./rate-limit.js";

const chains = new Map();

async function acquireRedis(key, ttlSeconds, waitMs) {
  const redis = getRedis();
  if (!redis) return null;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      const ok = await redis.set(`lock:${key}`, token, { nx: true, ex: ttlSeconds });
      if (ok) return { redis, token };
      if (Date.now() >= deadline) return null;
      await sleep(150);
    }
  } catch (err) {
    console.warn(`[lock] Redis lock unavailable for ${key}: ${err?.message ?? err}`);
    return null;
  }
}

async function releaseRedis(key, held) {
  if (!held) return;
  try {
    // Only delete if we still own it (TTL may have expired and another
    // holder taken over).
    const current = await held.redis.get(`lock:${key}`);
    if (current === held.token) await held.redis.del(`lock:${key}`);
  } catch { /* TTL will clear it */ }
}

export async function withLock(key, fn, { ttlSeconds = 30, waitMs = 10000 } = {}) {
  const prev = chains.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  chains.set(key, tail);
  await prev;
  let held = null;
  try {
    held = await acquireRedis(key, ttlSeconds, waitMs);
    return await fn();
  } finally {
    await releaseRedis(key, held);
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}
