// ---------------------------------------------------------------------------
// connectors/gemini/qstash_client.js — Upstash QStash client + inbound
// signature verification, backing plan.md's Scenario B self-chaining
// delegate_agent worker (connectors/gemini/agent_worker.js).
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
import { AGENT_WORKER_URL } from "../../config.js";

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
  await client.publishJSON({
    url: AGENT_WORKER_URL,
    body: { runId, afterStep, retryCount },
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
