// ---------------------------------------------------------------------------
// connectors/termux/queue.js — Redis-backed job queue between madmcp's
// termux_* tools and the Termux phone agent (scripts/termux-agent.mjs).
//
// WHY A QUEUE: the phone sits behind mobile NAT, so this server can never
// call it. Instead the phone POLLS (outbound HTTPS only, see
// agent_routes.js), picks up a queued job, runs it, and posts the result
// back. The tools enqueue and then wait on the job key for a short while.
//
// WHY REDIS: serverless instances don't share memory (see
// connectors/shared/cooldown.js's header), so the queue has to live in the
// same Upstash Redis the rest of madmcp already uses.
//
// STORAGE:
//   termux:queue        LIST of job ids (LPUSH to enqueue, RPOP to claim = FIFO)
//   termux:job:<uuid>   JSON job record, with a TTL so nothing lives forever
//
// UNLIKE cooldown.js/agent_checkpoint.js this does NOT fail open: without
// Redis there is no queue, so every function throws a clear error that the
// tool layer turns into an isError result.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { getRedis } from "../shared/cooldown.js";
import {
  TERMUX_JOB_TTL_SECONDS,
  TERMUX_MAX_QUEUE_DEPTH,
  TERMUX_MAX_OUTPUT_CHARS,
  TERMUX_WAIT_POLL_MS,
} from "../../config.js";

const QUEUE_KEY = "termux:queue";
const JOB_KEY_PREFIX = "termux:job:";
// How many dead (expired/cancelled) ids claimJob will skip in one call before
// giving up and reporting an empty queue; the phone just polls again.
const MAX_SKIPS_PER_CLAIM = 10;

export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jobKey(id) {
  return `${JOB_KEY_PREFIX}${id}`;
}

// Upstash's client auto-parses JSON-looking strings in some SDK versions and
// returns the raw string in others -- guard both (same as agent_checkpoint.js).
function parseJob(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function requireRedis() {
  const client = getRedis();
  if (!client) {
    throw new Error("The Termux connector needs Redis (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN), which is not configured.");
  }
  return client;
}

function clip(value) {
  if (typeof value !== "string") return "";
  if (value.length <= TERMUX_MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, TERMUX_MAX_OUTPUT_CHARS)}\n[... output truncated at ${TERMUX_MAX_OUTPUT_CHARS} chars]`;
}

// Adds a job to the queue and returns the stored record.
// `kind` is "exec" (command + optional cwd) or "api" (action + args).
export async function enqueueJob({ kind, command, cwd, action, args, timeoutSeconds }) {
  const client = requireRedis();
  const depth = await client.llen(QUEUE_KEY);
  if (depth >= TERMUX_MAX_QUEUE_DEPTH) {
    throw new Error(`The Termux queue already has ${depth} jobs waiting -- the phone agent is probably offline. Not queueing more.`);
  }
  const job = {
    id: randomUUID(),
    kind,
    command,
    cwd,
    action,
    args,
    timeoutSeconds,
    status: "queued",
    createdAt: Date.now(),
  };
  await client.set(jobKey(job.id), JSON.stringify(job), { ex: TERMUX_JOB_TTL_SECONDS });
  await client.lpush(QUEUE_KEY, job.id);
  // Re-armed on every push so ids of long-dead jobs can't pile up forever.
  await client.expire(QUEUE_KEY, TERMUX_JOB_TTL_SECONDS);
  return job;
}

export async function getJob(id) {
  const client = requireRedis();
  return parseJob(await client.get(jobKey(id)));
}

// Called by the phone agent's poll. Pops the oldest id, skips any whose job
// record has already expired, marks the first live one "running" and returns
// it; returns null when nothing is waiting. RPOP is atomic, so two agents
// polling at once can never claim the same job.
export async function claimJob() {
  const client = requireRedis();
  for (let skipped = 0; skipped < MAX_SKIPS_PER_CLAIM; skipped++) {
    const id = await client.rpop(QUEUE_KEY);
    if (!id) return null;
    const job = parseJob(await client.get(jobKey(id)));
    if (!job || job.status !== "queued") continue;
    const running = { ...job, status: "running", startedAt: Date.now() };
    // The TTL covers the command's own timeout on top of the normal job TTL,
    // so a long-running job's record can't expire underneath the phone.
    await client.set(jobKey(id), JSON.stringify(running), { ex: TERMUX_JOB_TTL_SECONDS + (job.timeoutSeconds || 0) });
    return running;
  }
  return null;
}

// Called by the phone agent's result post. Only a "running" job can be
// completed, so a late or replayed post can't overwrite a finished result.
// Returns { ok: true } or { ok: false, reason: "not_found" | "not_running" }.
export async function completeJob(id, { exitCode, stdout, stderr, timedOut, error }) {
  const client = requireRedis();
  const job = parseJob(await client.get(jobKey(id)));
  if (!job) return { ok: false, reason: "not_found" };
  if (job.status !== "running") return { ok: false, reason: "not_running" };
  const done = {
    ...job,
    status: error ? "failed" : "done",
    finishedAt: Date.now(),
    result: {
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      stdout: clip(stdout),
      stderr: clip(stderr),
      timedOut: Boolean(timedOut),
      error: error || undefined,
    },
  };
  await client.set(jobKey(id), JSON.stringify(done), { ex: TERMUX_JOB_TTL_SECONDS });
  return { ok: true };
}

// Polls the job record until it leaves queued/running or waitMs elapses.
// Returns the latest record, or null if it expired/never existed. Costs one
// Redis GET per interval on THIS side only; it never touches the phone.
export async function waitForJob(id, { waitMs = 0, intervalMs = TERMUX_WAIT_POLL_MS } = {}) {
  const deadline = Date.now() + waitMs;
  let job = await getJob(id);
  while (job && (job.status === "queued" || job.status === "running") && Date.now() < deadline) {
    const pause = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, pause));
    job = await getJob(id);
  }
  return job;
}
