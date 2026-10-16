// ---------------------------------------------------------------------------
// connectors/termux/agent_routes.js — the two HTTP endpoints the Termux phone
// agent (scripts/termux-agent.mjs) talks to:
//
//   POST /api/termux/poll         -> { job: null } or { job: {...} }
//   POST /api/termux/result/:id   -> post a finished job's output
//
// AUTH: a bearer token (TERMUX_AGENT_SECRET) that is DELIBERATELY separate
// from MCP_SHARED_KEY, so the secret stored on the phone can only poll and
// post results -- it cannot call any MCP tool. These routes are NOT behind
// requireAllowedIp/mcpLimiter (the phone's IP is arbitrary, on mobile data);
// they have their own limiter below. Same reasoning as /api/agent-worker in
// server.js. They fail closed: flag off or secret unset = 401 for everything,
// and server.js doesn't even mount them unless TERMUX_ENABLED=true.
// ---------------------------------------------------------------------------

import rateLimit from "express-rate-limit";
import { safeEqual } from "../security.js";
import { TERMUX_ENABLED, TERMUX_AGENT_SECRET } from "../../config.js";
import { claimJob, completeJob, JOB_ID_RE } from "./queue.js";

// A busy agent polls about once a second (60/min) and posts a result per
// job, so 240/min leaves headroom while still capping a leaked-secret flood.
export const termuxAgentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Try again shortly." },
});

function authorized(req) {
  if (!TERMUX_ENABLED || !TERMUX_AGENT_SECRET) return false;
  const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  return Boolean(match && safeEqual(match[1], TERMUX_AGENT_SECRET));
}

// Only what the agent needs to run the job -- never the server-side record.
function toAgentJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    command: job.command,
    cwd: job.cwd,
    action: job.action,
    args: job.args,
    timeoutSeconds: job.timeoutSeconds,
  };
}

export async function handleTermuxPoll(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const job = await claimJob();
    return res.status(200).json({ job: job ? toAgentJob(job) : null });
  } catch (err) {
    console.error("termux poll error:", err?.message ?? err);
    return res.status(500).json({ error: "queue error" });
  }
}

export async function handleTermuxResult(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { id } = req.params;
  if (!JOB_ID_RE.test(id || "")) return res.status(400).json({ error: "bad job id" });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const out = await completeJob(id, {
      exitCode: body.exitCode,
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      timedOut: body.timedOut === true,
      error: typeof body.error === "string" ? body.error.slice(0, 2000) : undefined,
    });
    if (out.ok) return res.status(200).json({ ok: true });
    return res.status(out.reason === "not_found" ? 404 : 409).json({ error: out.reason });
  } catch (err) {
    console.error("termux result error:", err?.message ?? err);
    return res.status(500).json({ error: "queue error" });
  }
}
