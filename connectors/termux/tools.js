// ---------------------------------------------------------------------------
// connectors/termux/tools.js — termux_exec / termux_api / termux_result.
//
// Lets an agent run commands and use Termux:API features on the owner's
// phone. The phone is behind NAT, so these tools never call it: they put a
// job in Redis (queue.js) and the Termux agent (scripts/termux-agent.mjs)
// polls for it. See docs/TERMUX.md for setup.
//
// OPT-IN, same posture as exec_in_codespace (connectors/github/codespaces.js):
// register() is a no-op unless TERMUX_ENABLED=true, so a default deployment
// exposes no phone access at all.
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  TERMUX_ENABLED,
  TERMUX_AGENT_SECRET,
  TERMUX_JOB_TTL_SECONDS,
  TERMUX_DEFAULT_TIMEOUT_SECONDS,
  TERMUX_MAX_TIMEOUT_SECONDS,
  TERMUX_DEFAULT_WAIT_SECONDS,
  TERMUX_MAX_WAIT_SECONDS,
} from "../../config.js";
import { enqueueJob, getJob, waitForJob, JOB_ID_RE } from "./queue.js";
import { API_ACTIONS, buildApiArgs } from "./actions.js";

function respond(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function describeJob(job, id) {
  if (!job) {
    return respond(`Job ${id} not found -- it never existed or has expired (jobs are kept for ${TERMUX_JOB_TTL_SECONDS}s).`, true);
  }
  if (job.status === "queued") {
    return respond(
      `Job ${job.id} is QUEUED -- the phone agent has not picked it up yet. ` +
      "Make sure Termux is open and the agent (scripts/termux-agent.mjs) is running; see docs/TERMUX.md. " +
      "Call termux_result with this job_id to check again. Do not re-send the command."
    );
  }
  if (job.status === "running") {
    return respond(`Job ${job.id} is RUNNING on the phone. Call termux_result with this job_id to collect the output.`);
  }
  const r = job.result || {};
  const parts = [`Job ${job.id} ${job.status} -- exit code ${r.exitCode ?? "n/a"}${r.timedOut ? " (timed out)" : ""}`];
  if (r.error) parts.push(`Agent error: ${r.error}`);
  if (r.stdout) parts.push(`Stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`Stderr:\n${r.stderr}`);
  const failed = job.status === "failed" || r.timedOut || (r.exitCode != null && r.exitCode !== 0);
  return respond(parts.join("\n\n"), Boolean(failed));
}

async function submit(jobInput, waitSeconds) {
  if (!TERMUX_AGENT_SECRET) {
    return respond("TERMUX_AGENT_SECRET is not set on the server, so no phone agent can authenticate. Set it (and the same value on the phone) first.", true);
  }
  try {
    const job = await enqueueJob(jobInput);
    const latest = await waitForJob(job.id, { waitMs: waitSeconds * 1000 });
    return describeJob(latest, job.id);
  } catch (err) {
    return respond(`Termux request failed: ${err.message}`, true);
  }
}

export function register(server) {
  if (!TERMUX_ENABLED) return;

  const waitSchema = z.number().min(0).max(TERMUX_MAX_WAIT_SECONDS).optional()
    .describe(`Seconds to wait for the phone to finish before returning the job_id (default ${TERMUX_DEFAULT_WAIT_SECONDS}, max ${TERMUX_MAX_WAIT_SECONDS}). 0 = queue and return immediately.`);

  server.tool(
    "termux_exec",
    "DOES: Run a shell command on the owner's phone in Termux (through the polling phone agent) and return stdout, stderr and the exit code. Runs as the Termux app user: Termux's home dir, plus shared storage if termux-setup-storage was run.\n" +
    "RULE: waits up to wait_seconds for the phone to finish; if the job is still queued/running it returns the job_id -> call termux_result later. Never re-send the same command.\n" +
    "RULE: the phone only picks work up while Termux is open and the agent is running, and an idle agent can take ~10s to notice a first job.\n" +
    "RULE: battery/location/clipboard/notifications -> termux_api instead of a raw shell command.",
    {
      command:         z.string().min(1).max(8000).describe("Shell command, run with sh -c in Termux"),
      cwd:             z.string().max(500).optional().describe("Working directory on the phone (default: Termux home)"),
      timeout_seconds: z.number().int().min(1).max(TERMUX_MAX_TIMEOUT_SECONDS).optional().describe(`Kill the command after this many seconds (default ${TERMUX_DEFAULT_TIMEOUT_SECONDS}, max ${TERMUX_MAX_TIMEOUT_SECONDS})`),
      wait_seconds:    waitSchema,
    },
    async ({ command, cwd, timeout_seconds = TERMUX_DEFAULT_TIMEOUT_SECONDS, wait_seconds = TERMUX_DEFAULT_WAIT_SECONDS }) =>
      submit({ kind: "exec", command, cwd, timeoutSeconds: timeout_seconds }, wait_seconds)
  );

  server.tool(
    "termux_api",
    "DOES: Use a fixed set of Termux:API phone features without writing a shell command: battery, location, clipboard_get, clipboard_set, notify, toast, vibrate, wifi_info. Needs the Termux:API app + package installed on the phone.\n" +
    "RULE: required fields per action -> clipboard_set: text; toast: text; notify: content (title optional); vibrate: duration_ms optional (1-5000).\n" +
    "RULE: anything outside this list -> termux_exec.",
    {
      action:       z.enum(API_ACTIONS).describe("Which phone feature to use"),
      text:         z.string().optional().describe("For clipboard_set and toast"),
      title:        z.string().optional().describe("For notify (optional)"),
      content:      z.string().optional().describe("For notify"),
      duration_ms:  z.number().optional().describe("For vibrate (1-5000, default 300)"),
      wait_seconds: waitSchema,
    },
    async ({ action, text, title, content, duration_ms, wait_seconds = TERMUX_DEFAULT_WAIT_SECONDS }) => {
      const built = buildApiArgs(action, { text, title, content, duration_ms });
      if (built.error) return respond(built.error, true);
      return submit(
        { kind: "api", action, args: built.args, timeoutSeconds: TERMUX_DEFAULT_TIMEOUT_SECONDS },
        wait_seconds
      );
    }
  );

  server.tool(
    "termux_result",
    "DOES: Fetch the status/output of a job started by termux_exec or termux_api, optionally waiting for it to finish.\n" +
    "RULE: use this when termux_exec/termux_api returned a job_id instead of output -- do not re-run the command.",
    {
      job_id:       z.string().describe("The job id returned by termux_exec or termux_api"),
      wait_seconds: waitSchema,
    },
    async ({ job_id, wait_seconds = TERMUX_DEFAULT_WAIT_SECONDS }) => {
      if (!JOB_ID_RE.test(job_id)) {
        return respond("job_id must be the id returned by termux_exec or termux_api.", true);
      }
      try {
        const job = await waitForJob(job_id, { waitMs: wait_seconds * 1000 });
        return describeJob(job, job_id);
      } catch (err) {
        return respond(`Termux request failed: ${err.message}`, true);
      }
    }
  );
}

// Re-exported so tests (and any future caller) can read a job without going
// through the MCP tool layer.
export { getJob };
