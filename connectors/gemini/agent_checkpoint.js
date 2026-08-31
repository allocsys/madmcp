// ---------------------------------------------------------------------------
// connectors/gemini/agent_checkpoint.js — Redis-backed checkpointing for
// delegate_agent's multi-step loop, so a run that dies partway through
// (Gemini 503/429, network blip, function timeout) doesn't lose every tool
// call it already made.
//
// STORAGE SHAPE (fix #5, 2026-07-27 -- append-delta instead of overwrite-
// whole-blob): the conversation `contents` array is the part of loop state
// that grows every step and can get large (tool outputs up to ~30k chars
// each) -- it lives in its own Redis LIST, and callers only ever RPUSH the
// turns added since the last checkpoint (see saveCheckpoint's `newContents`
// param), not the whole array. Write cost is therefore O(delta per step),
// not O(total conversation so far). Everything else (transcript, stepsDone,
// task, and fix #4's repeat-signature tracking state) stays small and cheap
// regardless of run length, so it's kept as one JSON blob under a separate
// key -- no benefit to splitting that up further.
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

function contentsKey(runId) {
  return `${CHECKPOINT_KEY_PREFIX}${runId}:contents`;
}
function metaKey(runId) {
  return `${CHECKPOINT_KEY_PREFIX}${runId}:meta`;
}

// Persists loop state after a step completes:
//   - newContents: ONLY the turn(s) added to `contents` since the last
//     saveCheckpoint call for this runId (may be an empty array -- e.g. a
//     geminiChat failure that happens before any new turn was pushed --
//     in which case the list simply isn't touched this call, only meta is).
//     The caller (agent_delegate.js) is responsible for tracking which slice of
//     its in-memory `contents` array is new; this function has no way to
//     know that on its own since it never sees the full array.
//   - transcript/stepsDone/task/repeatCounts/consecutiveAllRepeatSteps: the
//     small stuff, always written in full (cheap regardless of run length).
//   - status/lastStepAt (added for async delegate_agent work,
//     Scenario A `waitUntil` and Scenario B QStash self-chaining -- both
//     reuse this same meta shape): `status` is one of "running" | "done" |
//     "failed", defaulting to "running" when omitted so every existing
//     synchronous call site keeps working unchanged. `lastStepAt` is an
//     epoch-ms timestamp of THIS save, always set here (not left to the
//     caller) so every checkpoint write freshens it -- this is what lets
//     delegate_agent's poll path in agent_tools.js tell a genuinely-still-
//     running background worker apart from one whose chain silently died
//     (stale lastStepAt -> fall back to synchronous resume instead of
//     polling forever). Do not compute lastStepAt in a caller instead of
//     here -- a caller-supplied value could be stale by the time the actual
//     Redis write lands, defeating the freshness check.
// Fails open -- never throws.
export async function saveCheckpoint(runId, { newContents = [], transcript, stepsDone, task, repeatCounts, consecutiveAllRepeatSteps, provider, model, maxOutputTokens, pendingVerification, structuralRecheckUsed, overallMaxSteps, status = "running", finalAnswer }) {
  const client = getRedis();
  if (!client) return;
  try {
    const ops = [];
    if (newContents.length) {
      ops.push(client.rpush(contentsKey(runId), ...newContents.map((c) => JSON.stringify(c))));
      // EXPIRE (not a per-SET `ex` option, since RPUSH has no TTL param of
      // its own) re-armed on every push so the list's TTL tracks the meta
      // key's, rather than being set once and left to whatever it was at
      // list-creation time.
      ops.push(client.expire(contentsKey(runId), CHECKPOINT_TTL_SECONDS));
    }
    // finalAnswer (added alongside status/lastStepAt for async
    // delegate_agent work): only ever set by agent_delegate.js's completion
    // paths, once a run is genuinely done -- this is what lets a
    // resume_run_id poll of a "done" checkpoint (agent_delegate.js's
    // short-circuit right after loadCheckpoint) return the actual answer
    // instead of just a status flag with nothing to show for it. Always
    // included in the meta blob (even as undefined on every "running" save)
    // rather than conditionally spread in, so the shape of a saved
    // checkpoint doesn't vary step-to-step -- consistent with every other
    // field here.
    const meta = JSON.stringify({ transcript, stepsDone, task, repeatCounts, consecutiveAllRepeatSteps, provider, model, maxOutputTokens, pendingVerification, structuralRecheckUsed, overallMaxSteps, status, finalAnswer, lastStepAt: Date.now() });
    ops.push(client.set(metaKey(runId), meta, { ex: CHECKPOINT_TTL_SECONDS }));
    await Promise.all(ops);
  } catch {
    // best-effort -- see file header
  }
}

// Loads a previously saved checkpoint, or null if missing/expired/Redis is
// unavailable/either stored value doesn't parse. Reconstructs `contents` by
// concatenating every entry in the list (LRANGE 0 -1) -- this is the one
// place read cost is still O(total run length), but it only happens once
// per resume, not once per step (see file header).
//
// A genuine exception here (network blip, malformed JSON, etc.) is logged
// as a warning before returning null -- distinct from the ordinary "key
// doesn't exist" case (empty list / null meta), which is expected and
// silent. Both cases still return null to the caller (agent_delegate.js can't do
// anything different with either -- see its header), so this doesn't
// change behavior, only observability: without it, a Redis outage and an
// expired checkpoint look identical in the logs.
export async function loadCheckpoint(runId) {
  const client = getRedis();
  if (!client) return null;
  try {
    const [rawList, rawMeta] = await Promise.all([
      client.lrange(contentsKey(runId), 0, -1),
      client.get(metaKey(runId)),
    ]);
    // Meta missing means there's nothing usable here at all (expired, never
    // existed, or a partial/corrupted write) -- same as the old single-key
    // "raw == null" check.
    //
    // rawList (contents) being EMPTY, on the other hand, is no longer on its
    // own a sign of "nothing to resume" -- it used to be, back when every
    // checkpoint write was mid-loop and therefore always had at least one
    // turn already pushed. Two legitimate cases now produce an empty list
    // alongside real meta: (a) a "done" checkpoint (see agent_delegate.js's
    // finishRun/hard-cap-finalize paths, added for async
    // delegate_agent groundwork), which deliberately skips re-pushing
    // `contents` since nothing reads it once a run is finished -- only
    // finalAnswer/steps/transcript/task matter for a poll; and (b) a task
    // that's answered directly on step 1 with zero tool calls, which never
    // pushes a functionResponse turn at all before finishing. Neither case
    // is missing/expired/corrupted -- meta alone is the source of truth for
    // whether a checkpoint exists; `contents` is reconstructed as whatever
    // was actually saved (possibly empty), not treated as a required field.
    if (rawMeta == null) return null;
    // Upstash's client auto-parses JSON-looking values in some SDK versions
    // and returns a raw string in others -- guard both, same as the old
    // single-key version did.
    const contents = (rawList || []).map((entry) => (typeof entry === "string" ? JSON.parse(entry) : entry));
    const meta = typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta;
    return { contents, ...meta };
  } catch (err) {
    console.warn(`loadCheckpoint(${runId}) failed -- treating as no checkpoint:`, err?.message ?? err);
    return null;
  }
}

// Deletes a checkpoint once a run finishes (a final answer, or the model
// stops issuing function calls) -- nothing left to resume. Clears both keys.
export async function deleteCheckpoint(runId) {
  const client = getRedis();
  if (!client) return;
  try {
    await Promise.all([client.del(contentsKey(runId)), client.del(metaKey(runId))]);
  } catch {
    // best-effort
  }
}
