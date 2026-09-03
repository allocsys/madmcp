// ---------------------------------------------------------------------------
// connectors/delegate/qstash_client.js — Upstash QStash client + inbound
// signature verification, backing Scenario B self-chaining
// delegate_agent worker (connectors/delegate/agent/agent_worker.js).
//
// SAME ACCOUNT, NEW PRODUCT: this is the same Upstash account already used
// for Redis checkpointing (agent_checkpoint.js/cooldown.js) -- QStash is a
// separate product under it, not a new vendor.
//
// ASYMMETRIC FAIL-OPEN CONTRACT -- deliberately NOT the same "always fail
// open" contract as cooldown.js/agent_checkpoint.js:
//   - Publishing (getQStashClient/isQStashConfigured/publishAgentStep) fails
//     open in the sense that a missing QSTASH_TOKEN/AGENT_WORKER_URL just
//     means "the async chain can't be started" -- the caller
//     (agent_tools.js) checks isQStashConfigured() itself and falls back to
//     today's synchronous behavior; there's no sensible fail-open behavior
//     for "no queue exists to publish to" beyond that caller-level fallback.
//   - Signature VERIFICATION (verifyQStashSignature) fails CLOSED instead --
//     missing signing keys, a missing signature header, or a signature that
//     doesn't verify all return false (reject). This differs from every
//     other "never break a real call" file in this connector because
//     agent_worker.js is a PUBLICLY reachable HTTP endpoint (unlike the MCP
//     tool surface behind server.js's requireMcpKey/requireAllowedIp) --
//     accepting an unverifiable request here isn't "cross-call memory
//     unavailable, degrade gracefully", it's "anyone on the internet can
//     drive delegate_agent's Gemini-calling loop for free and burn this
//     account's quota". That must never fail open, however inconvenient a
//     missing/rotated signing key is.
// ---------------------------------------------------------------------------

import { Client, Receiver } from "@upstash/qstash";
import { AGENT_WORKER_URL, AGENT_WORKER_FAILURE_URL, EDITOR_WORKER_URL, EDITOR_WORKER_FAILURE_URL, QSTASH_STEP_RETRIES } from "../../config.js";

let qstashClient = null;
let qstashInitAttempted = false;

// Lazy singleton, same pattern as cooldown.js's getRedis().
export function getQStashClient() {
  if (qstashInitAttempted) return qstashClient;
  qstashInitAttempted = true;
  const token = process.env.QSTASH_TOKEN;
  if (!token) return null;
  try {
    qstashClient = new Client({ token });
  } catch (err) {
    console.warn("QStash client construction failed -- QSTASH_TOKEN was set but rejected; treating QStash as unconfigured:", err?.message ?? err);
    qstashClient = null;
  }
  return qstashClient;
}

// Used by agent_tools.js to decide whether the async start/poll path is
// even reachable this deployment -- both a working client AND a real
// target URL are required (publishJSON has nowhere to send the message
// without AGENT_WORKER_URL, even if QSTASH_TOKEN alone is valid).
export function isQStashConfigured() {
  return getQStashClient() !== null && Boolean(AGENT_WORKER_URL);
}

// Enqueues one worker invocation to continue runId's investigation loop by
// exactly one step. Fails by THROWING -- unlike this connector's read-path
// helpers (checkpoint loads, cooldown checks), a publish failure here means
// the chain is genuinely broken (nothing will ever continue this run in the
// background) -- the caller (agent_tools.js's async-start path, or
// agent_worker.js's own re-chain call after a step) needs to know that
// explicitly rather than have it silently swallowed.
//
// afterStep: the checkpoint's stepsDone at the moment this message is
// published -- see agent_worker.js's idempotency check for why every
// message must carry this.
// retryCount: the consecutive-same-step-failure counter, threaded through
// the chain so it survives across separate QStash-invoked processes (which
// share no in-memory state with each other) -- see agent_worker.js's
// dead-letter handling.
export async function publishAgentStep({ runId, afterStep, retryCount = 0 }) {
  const client = getQStashClient();
  if (!client) throw new Error("QSTASH_TOKEN is not set -- cannot publish to QStash.");
  if (!AGENT_WORKER_URL) throw new Error("AGENT_WORKER_URL is not set -- cannot publish to QStash without a target URL for the worker endpoint.");
  // retries/failureCallback configuration: see config.js's
  // AGENT_WORKER_FAILURE_URL comment for the full reasoning -- previously
  // neither was set, so a step that hard-timed-out on every delivery
  // attempt could exhaust QStash's own (default 3-retry, ~40min) budget
  // with no notification back to this app, leaving the checkpoint stuck at
  // status:"running" forever. failureCallback is only attached if a URL was
  // derivable/configured -- an undefined value here is simply omitted from
  // the publish rather than sent as a broken callback target.
  await client.publishJSON({
    url: AGENT_WORKER_URL,
    body: { runId, afterStep, retryCount },
    retries: QSTASH_STEP_RETRIES,
    ...(AGENT_WORKER_FAILURE_URL ? { failureCallback: AGENT_WORKER_FAILURE_URL } : {}),
  });
}

// --- delegate_editor siblings (plan.md Step 6b) ----------------------------
//
// AGENT_WORKER_URL is imported at module scope above and hardcoded directly
// into publishAgentStep's client.publishJSON({ url: AGENT_WORKER_URL, ... })
// call, and isQStashConfigured() likewise hardcodes the
// Boolean(AGENT_WORKER_URL) check -- neither function takes a url/target
// parameter, and every existing call site (agent_tools.js's fresh-start
// branch, agent_worker.js's re-chain call) calls them with no such
// parameter either. So editor_worker.js/editor_tools.js have no way to
// retarget those at EDITOR_WORKER_URL without a code change here --
// generalizing the existing functions in place isn't achievable without
// either adding a parameter every existing call site would need to be
// touched to pass, or silently changing their target. Two new sibling
// functions instead: same shape, same fail-by-throwing/fail-closed
// contracts, but wired to EDITOR_WORKER_URL, with zero changes to
// publishAgentStep/isQStashConfigured or their call sites -- no risk of
// regressing the live Gemini async path.
//
// Signature verification (verifyQStashSignature/getReceiver) is unchanged
// and shared as-is below -- it's already generic over the caller (it just
// verifies a signature against a body), so no editor-specific variant is
// needed there.

// Same shape as isQStashConfigured() above, but checks EDITOR_WORKER_URL
// instead of AGENT_WORKER_URL -- used by editor_tools.js (plan.md Step 7)
// to decide whether delegate_editor's async start/poll path is reachable
// this deployment.
export function isEditorQStashConfigured() {
  return getQStashClient() !== null && Boolean(EDITOR_WORKER_URL);
}

// Same shape and same fail-by-throwing contract as publishAgentStep above,
// but publishes to EDITOR_WORKER_URL instead of AGENT_WORKER_URL. See that
// function's own comments for the full reasoning (afterStep/retryCount
// threading) -- unchanged here, just against the editor worker endpoint
// (connectors/delegate/editor/editor_worker.js).
export async function publishEditorStep({ runId, afterStep, retryCount = 0 }) {
  const client = getQStashClient();
  if (!client) throw new Error("QSTASH_TOKEN is not set -- cannot publish to QStash.");
  if (!EDITOR_WORKER_URL) throw new Error("EDITOR_WORKER_URL is not set -- cannot publish to QStash without a target URL for the editor worker endpoint.");
  // Same retries/failureCallback reasoning as publishAgentStep above (plan.md
  // Section 13) -- EDITOR_WORKER_FAILURE_URL is only attached if derivable/configured.
  await client.publishJSON({
    url: EDITOR_WORKER_URL,
    body: { runId, afterStep, retryCount },
    retries: QSTASH_STEP_RETRIES,
    ...(EDITOR_WORKER_FAILURE_URL ? { failureCallback: EDITOR_WORKER_FAILURE_URL } : {}),
  });
}

let receiver = null;
let receiverInitAttempted = false;

function getReceiver() {
  if (receiverInitAttempted) return receiver;
  receiverInitAttempted = true;
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey    = process.env.QSTASH_NEXT_SIGNING_KEY;
  // QStash rotates signing keys and expects verifiers to accept EITHER the
  // current or next key during a rotation window -- Receiver handles that
  // internally given both; neither is optional here (see file header: this
  // path fails closed, not open, so a partially-configured pair is treated
  // exactly the same as unconfigured, not "verify against whichever one
  // exists").
  if (!currentSigningKey || !nextSigningKey) return null;
  try {
    receiver = new Receiver({ currentSigningKey, nextSigningKey });
  } catch (err) {
    console.warn("QStash Receiver construction failed -- signing keys were set but rejected:", err?.message ?? err);
    receiver = null;
  }
  return receiver;
}

// Verifies an inbound request actually came from QStash. FAILS CLOSED (see
// file header): returns false for missing signing keys, a missing
// signature header, or a signature that doesn't verify against the raw
// request body. Never throws -- Receiver.verify() can itself throw on a
// malformed signature, which is just another form of "not verified" here,
// not a distinct error case agent_worker.js needs to handle differently.
export async function verifyQStashSignature({ signature, body }) {
  const r = getReceiver();
  if (!r) return false;
  if (!signature) return false;
  try {
    return await r.verify({ signature, body });
  } catch {
    return false;
  }
}
