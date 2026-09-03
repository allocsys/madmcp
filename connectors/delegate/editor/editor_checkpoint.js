// ---------------------------------------------------------------------------
// connectors/delegate/editor/editor_checkpoint.js -- checkpoint layer for delegate_editor.
//
// Reuses connectors/delegate/designer/designer_checkpoint.js's shape verbatim (per
// guardrail #7: "Checkpoint/resume contract identical to delegate_designer's,
// not a new one -- reuse designer_checkpoint.js's shape ... rather than
// inventing a fourth checkpoint schema alongside agent_checkpoint.js and
// designer_checkpoint.js"). Only the Redis key prefix differs, so this
// module's checkpointed run state doesn't collide with delegate_designer's.
//
// Same reasoning as designer_checkpoint.js for why the simpler whole-blob
// save (vs. connectors/delegate/agent/agent_checkpoint.js's list+meta split) is the
// right call here too: delegate_editor's tool set (read_file/write_file
// against one repo/branch, bounded by EDITOR_HARD_MAX_STEPS) is closer in
// shape/size to delegate_designer's three-function loop than to
// delegate_agent's open-ended, multi-KB-blob-per-call investigation surface.
//
// ASYNC STATUS FIELDS (groundwork for QStash-backed async delegate_editor
// -- mirrors agent_checkpoint.js's own
// status/lastStepAt/stepStartedAt/finalAnswer fields, but layered onto THIS
// file's whole-blob save rather than that file's list+meta split):
//   - status: "running" | "done" | "failed". Defaults to "running" when the
//     caller omits it, so every existing (pre-async) call site -- which has
//     never heard of this field -- keeps working unchanged.
//   - lastStepAt: epoch ms, always set HERE (not left to the caller) on
//     every save -- same reasoning as agent_checkpoint.js: a caller-supplied
//     value could be stale by the time the write actually lands, defeating
//     the point of a freshness signal. This is what will let a poller tell
//     a genuinely-still-running background worker apart from one whose
//     chain silently died.
//   - stepStartedAt: epoch ms or null, defaulting to null when the caller
//     omits it. Meant to be written by the (future) editor worker right
//     before it starts a step, as a heartbeat -- lets a poller detect a
//     crashed-mid-step worker (started a step, never finished it) as
//     distinct from one that's merely between steps.
//   - finalAnswer: only ever set by a completion path once a run is
//     genuinely "done" or "failed" -- lets a poll of a finished checkpoint
//     return the real answer/error without needing the rest of the loop
//     state. Passed through as-is; no default here.
//
// IMPORTANT -- because this file is a WHOLE-BLOB overwrite (see above), any
// caller writing a checkpoint (runEditorAgent's saveState, and later the
// editor worker's heartbeat/dead-letter writes) MUST pass the entire current
// state on every call, not just the fields it thinks changed -- there is no
// merge here, unlike agent_checkpoint.js's meta-key spread. A partial object
// silently drops every field it omits (including `contents`,
// `writtenFiles`, etc. if the caller isn't careful). This module only
// supplies defaults for the three async fields above (status,
// stepStartedAt, lastStepAt) so existing non-async-aware call sites don't
// need to know about them -- it does not and cannot protect a caller
// against an accidentally-partial write.
//
// SAME FAIL-OPEN CONTRACT AS EVERY OTHER CHECKPOINT MODULE IN THIS REPO: if
// Redis isn't configured or a call fails, every function here no-ops /
// returns null. A missing Redis must never be the reason this agent can't
// run -- it only means a slow/interrupted run can't be resumed across
// calls.
//
// NOT YET WIRED to any agent loop or MCP tool registration.
// ---------------------------------------------------------------------------

import { getRedis } from "../../shared/cooldown.js";

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
    const record = {
      ...state,
      status: state.status ?? "running",
      stepStartedAt: state.stepStartedAt ?? null,
      lastStepAt: Date.now(),
    };
    await client.set(key(runId), JSON.stringify(record), { ex: CHECKPOINT_TTL_SECONDS });
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
