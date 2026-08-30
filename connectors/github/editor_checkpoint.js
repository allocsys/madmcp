// ---------------------------------------------------------------------------
// connectors/github/editor_checkpoint.js -- checkpoint layer for delegate_editor.
//
// Reuses connectors/frontend/designer_checkpoint.js's shape verbatim (per
// guardrail #7: "Checkpoint/resume contract identical to delegate_designer's,
// not a new one -- reuse designer_checkpoint.js's shape ... rather than
// inventing a fourth checkpoint schema alongside agent_checkpoint.js and
// designer_checkpoint.js"). Only the Redis key prefix differs, so this
// module's checkpointed run state doesn't collide with delegate_designer's.
//
// Same reasoning as designer_checkpoint.js for why the simpler whole-blob
// save (vs. connectors/gemini/agent_checkpoint.js's list+meta split) is the
// right call here too: delegate_editor's tool set (read_file/write_file
// against one repo/branch, bounded by EDITOR_HARD_MAX_STEPS) is closer in
// shape/size to delegate_designer's three-function loop than to
// delegate_agent's open-ended, multi-KB-blob-per-call investigation surface.
//
// SAME FAIL-OPEN CONTRACT AS EVERY OTHER CHECKPOINT MODULE IN THIS REPO: if
// Redis isn't configured or a call fails, every function here no-ops /
// returns null. A missing Redis must never be the reason this agent can't
// run -- it only means a slow/interrupted run can't be resumed across
// calls.
//
// NOT YET WIRED to any agent loop or MCP tool registration.
// ---------------------------------------------------------------------------

import { getRedis } from "../gemini/cooldown.js";

const CHECKPOINT_KEY_PREFIX = "editor:checkpoint:";
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
