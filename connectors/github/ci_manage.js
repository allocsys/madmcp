// ---------------------------------------------------------------------------
// connectors/github/ci_manage.js — GitHub Actions / CI tool
//
// Consolidated per plan-madmcp-github-tools-overhaul (group 7): merges
//   list_workflow_runs, get_workflow_run_logs, get_job_logs   (was actions.js)
//   trigger_workflow, rerun_workflow, cancel_workflow_run,
//   get_check_runs, get_combined_status                        (was ci_control.js)
// into one ci_manage tool dispatched on `action`:
//   list | run_logs | job_logs | trigger | rerun | cancel | checks | status
//
// Every request, output format, default and polling budget below was moved
// verbatim from the original tools. What changed is only the dispatch and
// the fact that required-ness is now enforced in the handler (the schema is
// shared, so per-action required params can't live in it).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

// GitHub caps per_page at 100 and rejects/ignores nonsense values. Clamp to an
// integer in 1..100 (fall back to the default for undefined / NaN) so an
// oversized or negative value can't produce an unexpected request or response.
function clampPerPage(value, fallback) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

export function register(server) {

  server.tool(
    "ci_manage",
    "DOES: Read, trigger and control GitHub Actions / CI. Use `action` to pick. Actions 'list', 'run_logs', 'job_logs', 'checks' and 'status' are READ-ONLY; 'trigger', 'rerun' and 'cancel' MUTATE GitHub state. owner defaults if omitted; repo is required for every action.\n" +
    "RULE: 'list' needs repo; optional workflow_id, branch, status, per_page (default 20). Lists recent workflow runs. POLLING: if the run you care about is still queued/in_progress, sleep 30 seconds before checking again if you have nothing else to do, then call 'list' again.\n" +
    "RULE: 'run_logs' needs repo + run_id (from 'list'). Returns a summary of the run and its jobs, with any non-successful steps.\n" +
    "RULE: 'job_logs' needs repo + EITHER job_id, OR run_id (+ optional job_name to disambiguate; defaults to the first failed job in the run). Returns the raw console/log text for a job -- actual error messages, stack traces, and stdout/stderr, not just pass/fail step status. Use it after 'run_logs' has identified which job failed, when you need to see *why* it failed (e.g. a syntax error, assertion failure, or stack trace). Optional grep (case-insensitive regex; defaults to common error patterns, with 2 lines of context) and max_matches (default 40).\n" +
    "RULE: 'trigger' needs repo + workflow_id + ref, plus optional inputs. Manually triggers a workflow_dispatch run; the workflow file must have a workflow_dispatch trigger defined, or this fails. Needing CI to run without a real change -> this, instead of opening a throwaway PR. It briefly polls for the new run and returns its URL if GitHub has listed it.\n" +
    "RULE: 'rerun' needs repo + run_id; optional failed_jobs_only. Retrying a flaky test without re-running steps that already passed -> failed_jobs_only=true.\n" +
    "RULE: 'cancel' needs repo + run_id. Cancels a queued or in-progress workflow run.\n" +
    "RULE: 'checks' needs repo + ref (commit SHA, branch or tag); optional per_page (default 30). Individual check/status entries (pass/fail dots) -- the data behind GitHub's green check / red X. NOT a list of Actions runs -> use 'list' for that. POLLING: if checks are still pending, sleep 30 seconds before checking again if you have nothing else to do, then call 'checks' again.\n" +
    "RULE: 'status' needs repo + ref (commit SHA, branch or tag). Combined commit status -- overall pass/fail/pending rollup + each individual status context (the legacy Status API some CI systems/integrations use instead of, or alongside, Actions check-runs). POLLING: if the overall state is still pending, sleep 30 seconds before checking again if you have nothing else to do, then call 'status' again.\n" +
    "RULE: workflow_id/branch/status/per_page apply to 'list' (and per_page to 'checks') only; workflow_id/ref/inputs to 'trigger' (and ref to 'checks'/'status'); run_id to 'run_logs'/'job_logs'/'rerun'/'cancel'; job_id/job_name/grep/max_matches to 'job_logs' only; failed_jobs_only to 'rerun' only.",
    {
      action:           z.enum(["list", "run_logs", "job_logs", "trigger", "rerun", "cancel", "checks", "status"]).describe("Which operation to perform."),
      owner:            z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:             z.string().optional().describe("Repository name. Required for every action."),
      workflow_id:      z.string().optional().describe("Workflow file name or ID (e.g. 'ci.yml'). For 'list': optional, omit for all workflows. For 'trigger': required."),
      branch:           z.string().optional().describe("Filter by branch name. Used by 'list' only."),
      status:           z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]).optional().describe("Filter by run status. Used by 'list' only."),
      per_page:         z.number().optional().describe("Number of items to return, max 100. 'list': runs (default: 20). 'checks': check runs (default: 30). Ignored by other actions."),
      run_id:           z.number().optional().describe("Workflow run ID (from 'list'). Required for 'run_logs', 'rerun' and 'cancel'. For 'job_logs': required if job_id is not provided -- used to look up the job."),
      job_id:           z.number().optional().describe("Specific job ID. Used by 'job_logs' only; if provided, run_id/job_name are not needed. Get this from a run's job list if already known."),
      job_name:         z.string().optional().describe("Job name or partial match (e.g. 'Windows, packages-and-tools') to disambiguate which job to fetch when a run has multiple jobs. Used by 'job_logs' only, and only with run_id. If omitted, the first failed job in the run is used."),
      grep:             z.string().optional().describe("Optional case-insensitive regex to filter log lines (with 2 lines of context around each match). Defaults to common error patterns (##[error], SyntaxError, 'Error:', 'FAIL', assertion failures, etc.) when omitted. Used by 'job_logs' only."),
      max_matches:      z.number().optional().describe("Max number of matched error blocks to return (default: 40). Used by 'job_logs' only."),
      ref:              z.string().optional().describe("For 'trigger': branch, tag, or SHA to run the workflow on (required). For 'checks' and 'status': commit SHA, branch name, or tag (required)."),
      inputs:           z.record(z.string()).optional().describe("Input parameters declared under `workflow_dispatch.inputs` in the workflow file, as string key/value pairs. Used by 'trigger' only."),
      failed_jobs_only: z.boolean().optional().describe("If true, only rerun failed jobs instead of the entire run (default: false). Used by 'rerun' only."),
    },
    async ({ action, owner = DEFAULT_OWNER, repo, workflow_id, branch, status, per_page, run_id, job_id, job_name, grep, max_matches = 40, ref, inputs, failed_jobs_only = false }) => {

      if (!repo) return fail(`action '${action}' requires repo parameter.`);

      if ((action === "run_logs" || action === "rerun" || action === "cancel") && run_id === undefined) {
        return fail(`action '${action}' requires run_id (the workflow run ID, from 'list').`);
      }
      if (action === "trigger") {
        if (!workflow_id) return fail("action 'trigger' requires workflow_id (workflow file name or numeric workflow ID).");
        if (!ref) return fail("action 'trigger' requires ref (branch, tag, or SHA to run the workflow on).");
      }
      if ((action === "checks" || action === "status") && !ref) {
        return fail(`action '${action}' requires ref (commit SHA, branch name, or tag).`);
      }

      // ── list (was list_workflow_runs) ─────────────────────────────────────
      if (action === "list") {
        const limit = clampPerPage(per_page, 20);
        const query = new URLSearchParams({ per_page: String(limit) });
        if (branch) query.set("branch", branch);
        if (status) query.set("status", status);
        const endpoint = workflow_id
          ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/runs?${query}`
          : `/repos/${owner}/${repo}/actions/runs?${query}`;
        const data = await githubRequest(endpoint);
        const runs = data.workflow_runs;
        if (!runs?.length) return { content: [{ type: "text", text: "No workflow runs found." }] };
        const icon  = (s, c) => s === "in_progress" ? "🔄" : s === "queued" || s === "waiting" ? "⏳" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "cancelled" ? "🚫" : "⚪";
        const lines = runs.map((r) =>
          `${icon(r.status, r.conclusion)} #${r.run_number} — ${r.name} (${r.head_branch})\n` +
          `  Status: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""} | Triggered: ${r.event} | ${r.created_at.slice(0, 10)}\n` +
          `  ${r.html_url}`
        );
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      // ── run_logs (was get_workflow_run_logs) ──────────────────────────────
      if (action === "run_logs") {
        const run      = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}`);
        const jobsData = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
        const jobs     = jobsData.jobs || [];
        const icon     = (s, c) => s === "in_progress" ? "🔄" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "cancelled" ? "🚫" : "⚪";
        const jobLines = jobs.map((j) => {
          const steps = j.steps
            ?.filter((s) => s.conclusion !== "success")
            .map((s) => `      ${icon(s.status, s.conclusion)} Step ${s.number}: ${s.name} [${s.conclusion || s.status}]`)
            .join("\n") || "";
          return `  ${icon(j.status, j.conclusion)} Job: ${j.name} [${j.conclusion || j.status}]\n${steps}`;
        });
        const text =
          `Run #${run.run_number}: ${run.name}\n` +
          `Status: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}\n` +
          `Branch: ${run.head_branch} | Commit: ${run.head_sha.slice(0, 7)}\n` +
          `Triggered by: ${run.event} | Started: ${run.created_at.slice(0, 10)}\n\n` +
          `Jobs (${jobs.length}):\n${jobLines.join("\n\n")}\n\n` +
          `Full logs: ${run.html_url}`;
        return { content: [{ type: "text", text }] };
      }

      // ── job_logs (was get_job_logs) ───────────────────────────────────────
      if (action === "job_logs") {
        if (!job_id) {
          // Original threw here rather than returning a validation result; kept.
          if (!run_id) throw new Error("Provide either job_id, or run_id (optionally with job_name).");
          const jobsData = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
          const jobs = jobsData.jobs || [];
          let candidates;
          if (job_name) {
            const needle = job_name.toLowerCase();
            candidates = jobs.filter((j) => j.name.toLowerCase().includes(needle));
          } else {
            candidates = jobs.filter((j) => j.conclusion === "failure");
          }
          if (!candidates.length) {
            throw new Error(
              `No matching job found in run ${run_id}` +
              (job_name ? ` for job_name "${job_name}"` : " with a failure conclusion") +
              `. Available jobs: ${jobs.map((j) => j.name).join(", ")}`
            );
          }
          job_id = candidates[0].id;
        }

        const rawText = await githubRequest(`/repos/${owner}/${repo}/actions/jobs/${job_id}/logs`, {
          accept: "application/vnd.github+json",
        });
        const logText = typeof rawText === "string" ? rawText : JSON.stringify(rawText);
        const lines = logText.split("\n");

        let pattern;
        if (grep) {
          try {
            pattern = new RegExp(grep, "i");
          } catch (e) {
            // Still a throw (as before), but with a message that names the parameter.
            throw new Error(`Invalid grep regex: ${e.message}`, { cause: e });
          }
        } else {
          pattern = /##\[error\]|error TS\d|SyntaxError|ReferenceError|TypeError|Error:|FAIL\b|✗|AssertionError|Unexpected token|Process completed with exit code [1-9]/i;
        }

        const blocks = [];
        for (let i = 0; i < lines.length && blocks.length < max_matches; i++) {
          if (pattern.test(lines[i])) {
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length, i + 4);
            blocks.push(lines.slice(start, end).join("\n"));
          }
        }

        const body = blocks.length
          ? blocks.join("\n---\n")
          : `No lines matched /${pattern.source}/. Showing last 150 lines instead:\n\n${lines.slice(-150).join("\n")}`;

        const text =
          `Job ID: ${job_id} | Total log lines: ${lines.length}\n` +
          `${blocks.length ? `Matched ${blocks.length} error block(s) for /${pattern.source}/` : "No pattern matches"}:\n\n${body}`;

        return { content: [{ type: "text", text }] };
      }

      // ── trigger (was trigger_workflow) ────────────────────────────────────
      if (action === "trigger") {
        // Runs created before this moment (minus a small clock-skew allowance)
        // are earlier dispatches, not the one we just asked for.
        const dispatchedAt = Date.now() - 5000;
        await githubRequest(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/dispatches`, {
          method: "POST",
          body: { ref, inputs },
        });
        // PRECISION-PASS: this action keeps its OWN brief poll (4 attempts,
        // 1.5s apart) exactly as the standalone tool had it. The dispatch
        // endpoint returns no body (204), so poll the workflow's runs list
        // to hand back a run URL instead of a bare "ok". Do not share or
        // divide this budget with any other action in this tool.
        // The runs list is newest-first, so the first entry is only ours if it
        // was created after the dispatch; otherwise keep polling. The branch
        // filter matches head_branch, so a full ref is reduced to its short name.
        const shortRef = ref.replace(/^refs\/(heads|tags)\//, "");
        let found;
        for (let attempt = 0; attempt < 4 && !found; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
          const runs = await githubRequest(
            `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(shortRef)}&per_page=1`
          );
          const latest = runs.workflow_runs?.[0];
          if (latest && Date.parse(latest.created_at) >= dispatchedAt) found = latest;
        }
        return {
          content: [{
            type: "text",
            text: found
              ? `Triggered workflow '${workflow_id}' on ${ref}. Run #${found.run_number}: ${found.html_url}`
              : `Triggered workflow '${workflow_id}' on ${ref}. GitHub hasn't listed the new run yet -- check ci_manage 'list' shortly.`,
          }],
        };
      }

      // ── rerun (was rerun_workflow) ────────────────────────────────────────
      if (action === "rerun") {
        const endpoint = failed_jobs_only ? "rerun-failed-jobs" : "rerun";
        await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/${endpoint}`, { method: "POST" });
        return {
          content: [{
            type: "text",
            text: `Requested rerun of ${failed_jobs_only ? "failed jobs in " : ""}run ${run_id}. Poll with ci_manage 'list' or 'run_logs' to see progress.`,
          }],
        };
      }

      // ── cancel (was cancel_workflow_run) ──────────────────────────────────
      if (action === "cancel") {
        await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/cancel`, { method: "POST" });
        return { content: [{ type: "text", text: `Cancellation requested for run ${run_id}.` }] };
      }

      // ── checks (was get_check_runs) ───────────────────────────────────────
      if (action === "checks") {
        const limit = clampPerPage(per_page, 30);
        const data = await githubRequest(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=${limit}`);
        if (!data.check_runs?.length) return { content: [{ type: "text", text: `No check runs found for ${ref}.` }] };
        const icon = (s, c) => s !== "completed" ? "🔄" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "skipped" ? "⏭️" : c === "cancelled" ? "🚫" : "⚪";
        const lines = data.check_runs.map((c) =>
          `${icon(c.status, c.conclusion)} ${c.name} — ${c.status}${c.conclusion ? `/${c.conclusion}` : ""}\n  ${c.html_url}`
        );
        return { content: [{ type: "text", text: `${data.total_count} check run(s) for ${ref}:\n\n${lines.join("\n\n")}` }] };
      }

      // ── status (was get_combined_status) ──────────────────────────────────
      // action === "status"
      const data = await githubRequest(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`);
      const icon = (s) => s === "success" ? "✅" : s === "failure" || s === "error" ? "❌" : "⏳";
      const lines = (data.statuses || []).map((s) => `${icon(s.state)} ${s.context} — ${s.state}${s.description ? ` (${s.description})` : ""}`);
      const text =
        `Overall state: ${icon(data.state)} ${data.state} (${data.total_count} status(es))\n\n` +
        (lines.length ? lines.join("\n") : "(no individual statuses reported)");
      return { content: [{ type: "text", text }] };
    }
  );
}
