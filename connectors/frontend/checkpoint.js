// ---------------------------------------------------------------------------
// connectors/frontend/checkpoint.js — Redis-backed checkpointing for
// delegate_designer's generate -> validate -> fix loop, so a run that can't
// finish inside one HTTP call (slow provider, hosting platform's own
// request-duration ceiling -- e.g. Vercel) doesn't lose the attempt(s) it
// already made.
//
// SAME FAIL-OPEN CONTRACT AS connectors/gemini/checkpoint.js: if Redis isn't
// configured or a call fails, every function here no-ops / returns null. A
// missing Redis must never be the reason delegate_designer can't run -- it
// only means a slow run can't be resumed across calls, same as before this
// file existed.
//
// SIMPLER THAN connectors/gemini/checkpoint.js ON PURPOSE: that file exists
// because delegate_gemini's `contents` array grows every step and can get
// large (many tool-call turns), which is why it splits state across a
// Redis LIST (append-only) and a small meta blob. delegate_designer's loop
// has no equivalent growth problem -- it's at most FRONTEND_MAX_ATTEMPTS
// (a handful) generate/validate rounds on ONE file, so the whole state
// (task, context, current best attempt, validation errors) comfortably fits
// as a single JSON blob under one key. Reuse the pattern's shape (module
// name, TTL reasoning, fail-open contract) without importing its
// list-vs-meta split, which would just be unused complexity here.
// ---------------------------------------------------------------------------

import { getRedis } from "../gemini/cooldown.js";

const CHECKPOINT_KEY_PREFIX = "designer:checkpoint:";
// Same reasoning as gemini/checkpoint.js's CHECKPOINT_TTL_SECONDS -- only
// needs to survive long enough for the caller to retry with resume_run_id.
const CHECKPOINT_TTL_SECONDS = 3600;

function key(runId) {
  return `${CHECKPOINT_KEY_PREFIX}${runId}`;
}

// Persists the full loop state after an attempt completes. Fails open --
// never throws.
export async function saveCheckpoint(runId, state) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(key(runId), JSON.stringify(state), { ex: CHECKPOINT_TTL_SECONDS });
  } catch {
    // best-effort -- see file header
  }
}

// Loads a previously saved checkpoint, or null if missing/expired/Redis is
// unavailable/doesn't parse.
export async function loadCheckpoint(runId) {
  const client = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(key(runId));
    if (raw == null) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn(`loadCheckpoint(${runId}) failed -- treating as no checkpoint:`, err?.message ?? err);
    return null;
  }
}

// Deletes a checkpoint once a run finishes (written to the repo, or
// permanently failed) -- nothing left to resume.
export async function deleteCheckpoint(runId) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.del(key(runId));
  } catch {
    // best-effort
  }
}
