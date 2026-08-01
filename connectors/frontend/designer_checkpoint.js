// ---------------------------------------------------------------------------
// connectors/frontend/agent_checkpoint.js — Redis-backed checkpointing for
// delegate_designer's agent loop (connectors/frontend/agent.js,
// issue #61 step 2).
//
// SIMPLER THAN connectors/gemini/agent_checkpoint.js'S LIST+META SPLIT, ON
// PURPOSE: that split exists because delegate_agent's open-ended
// investigation surface (GitHub/Cloudflare/Notion/Context7/Mem0, many of
// which return multi-KB text blobs per call) can grow a `contents` array
// large enough that rewriting it whole on every step is real, avoidable
// cost. This agent's tool set is three functions over frontend source files
// on one branch, bounded by FRONTEND_HARD_MAX_STEPS (20) -- its `contents`
// array is small enough that a whole-blob-per-save approach is still the
// right call here too. Reuse that shape rather than importing gemini/
// agent_checkpoint.js's list-vs-meta split, which would be unused complexity
// for this loop's actual size.
//
// SAME FAIL-OPEN CONTRACT AS EVERY OTHER CHECKPOINT MODULE IN THIS REPO: if
// Redis isn't configured or a call fails, every function here no-ops /
// returns null. A missing Redis must never be the reason this agent can't
// run -- it only means a slow/interrupted run can't be resumed across
// calls.
// ---------------------------------------------------------------------------

import { getRedis } from "../gemini/cooldown.js";

const CHECKPOINT_KEY_PREFIX = "designer:checkpoint:";
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
