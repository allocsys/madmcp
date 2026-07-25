// ---------------------------------------------------------------------------
// connectors/gemini/checkpoint.js — Redis-backed checkpointing for
// gemini_investigate's multi-step loop, so a run that dies partway through
// (Gemini 503/429, network blip, function timeout) doesn't lose every tool
// call it already made.
//
// SAME FAIL-OPEN CONTRACT AS cooldown.js: if Redis isn't configured or a
// call fails, every function here no-ops / returns null. A missing Redis
// must never be the reason an investigation can't run -- it only means a
// failure can't be resumed, same as before this file existed.
// ---------------------------------------------------------------------------

import { getRedis } from "./cooldown.js";

const CHECKPOINT_KEY_PREFIX = "gemini:checkpoint:";
// A checkpoint only needs to survive long enough for the caller to retry
// with resume_run_id -- not to become a permanent store.
const CHECKPOINT_TTL_SECONDS = 3600;

// Persists the current loop state (conversation contents + transcript +
// how many steps are done) after a step completes. Fails open -- never
// throws.
export async function saveCheckpoint(runId, state) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(CHECKPOINT_KEY_PREFIX + runId, JSON.stringify(state), { ex: CHECKPOINT_TTL_SECONDS });
  } catch {
    // best-effort -- see file header
  }
}

// Loads a previously saved checkpoint, or null if missing/expired/Redis is
// unavailable/the stored value doesn't parse.
export async function loadCheckpoint(runId) {
  const client = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(CHECKPOINT_KEY_PREFIX + runId);
    if (raw == null) return null;
    // Upstash's client auto-parses JSON-looking values in some SDK versions
    // and returns a raw string in others -- guard both.
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// Deletes a checkpoint once a run finishes (a final answer, or the model
// stops issuing function calls) -- nothing left to resume.
export async function deleteCheckpoint(runId) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.del(CHECKPOINT_KEY_PREFIX + runId);
  } catch {
    // best-effort
  }
}
