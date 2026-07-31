// ---------------------------------------------------------------------------
// connectors/frontend/agent_checkpoint.js — Redis-backed checkpointing for
// delegate_designer v2's agent loop (connectors/frontend/agent.js,
// issue #61 step 2).
//
// SEPARATE key prefix from connectors/frontend/checkpoint.js (v1's
// "designer:checkpoint:") so a v1 and v2 run against the same repo/branch
// can never collide on the same Redis key -- deliberate, not incidental,
// since both tools exist side by side until v1 is retired (rollout, step 5).
//
// SIMPLER THAN connectors/gemini/checkpoint.js'S LIST+META SPLIT, ON
// PURPOSE: that split exists because delegate_agent's open-ended
// investigation surface (GitHub/Cloudflare/Notion/Context7/Mem0, many of
// which return multi-KB text blobs per call) can grow a `contents` array
// large enough that rewriting it whole on every step is real, avoidable
// cost. This agent's tool set is three functions over frontend source files
// on one branch, bounded by FRONTEND_V2_HARD_MAX_STEPS (20) -- its `contents`
// array is small enough for the whole-blob-per-save approach connectors/
// frontend/checkpoint.js already uses for v1 to still be the right call
// here too. Reuse that shape rather than importing gemini/checkpoint.js's
// list-vs-meta split, which would be unused complexity for this loop's
// actual size.
//
// SAME FAIL-OPEN CONTRACT AS EVERY OTHER CHECKPOINT MODULE IN THIS REPO: if
// Redis isn't configured or a call fails, every function here no-ops /
// returns null. A missing Redis must never be the reason this agent can't
// run -- it only means a slow/interrupted run can't be resumed across
// calls.
// ---------------------------------------------------------------------------

import { getRedis } from "../gemini/cooldown.js";

const CHECKPOINT_KEY_PREFIX = "designer:v2:checkpoint:";
// Same reasoning as every other checkpoint module in this repo -- only
// needs to survive long enough for the caller to retry with resume_run_id.
const CHECKPOINT_TTL_SECONDS = 3600;

function key(runId) {
  return `${CHECKPOINT_KEY_PREFIX}${runId}`;
}

export async function saveCheckpoint(runId, state) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(key(runId), JSON.stringify(state), { ex: CHECKPOINT_TTL_SECONDS });
  } catch {
    // best-effort -- see file header
  }
}

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

export async function deleteCheckpoint(runId) {
  const client = getRedis();
  if (!client) return;
  try {
    await client.del(key(runId));
  } catch {
    // best-effort
  }
}
