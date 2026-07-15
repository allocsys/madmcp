// ---------------------------------------------------------------------------
// connectors/github/actions.js — GitHub Actions / CI tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "list_workflow_runs",
    "List recent GitHub Actions workflow runs for a repository.",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      workflow_id: z.string().optional().describe("Workflow file name or ID (e.g. 'ci.yml'). Omit for all workflows."),
      branch:      z.string().optional().describe("Filter by branch name"),
      status:      z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]).optional().describe("Filter by run status"),
      per_page:    z.number().optional().describe("Number of runs to return, max 100 (default: 10)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, workflow_id, branch, status, per_page = 10 }) => {
      const query = new URLSearchParams({ per_page: String(per_page) });
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
  );

  server.tool(
    "get_workflow_run_logs",
    "Get the logs summary for a specific GitHub Actions workflow run.",
    {
      owner:  z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:   z.string().describe("Repository name"),
      run_id: z.number().describe("Workflow run ID (from list_workflow_runs)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, run_id }) => {
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
  );

  server.tool(
    "get_job_logs",
    "Get the raw console/log text for a specific GitHub Actions job — actual error messages, stack traces, and stdout/stderr, not just pass/fail step status. Use this after get_workflow_run_logs has identified which job failed, when you need to see *why* it failed (e.g. a syntax error, assertion failure, or stack trace). Provide either job_id directly, or run_id (+ optional job_name to disambiguate; defaults to the first failed job in the run).",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      run_id:   z.number().optional().describe("Workflow run ID (from list_workflow_runs). Required if job_id is not provided — used to look up the job."),
      job_id:   z.number().optional().describe("Specific job ID. If provided, run_id/job_name are not needed. Get this from a run's job list if already known."),
      job_name: z.string().optional().describe("Job name or partial match (e.g. 'Windows, packages-and-tools') to disambiguate which job to fetch when a run has multiple jobs. Only used with run_id. If omitted, the first failed job in the run is used."),
      grep:     z.string().optional().describe("Optional case-insensitive regex to filter log lines (with 2 lines of context around each match). Defaults to common error patterns (##[error], SyntaxError, 'Error:', 'FAIL', assertion failures, etc.) when omitted."),
      max_matches: z.number().optional().describe("Max number of matched error blocks to return (default: 40)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, run_id, job_id, job_name, grep, max_matches = 40 }) => {
      if (!job_id) {
        if (!run_id) throw new Error("Provide either job_id, or run_id (optionally with job_name).");
        const jobsData = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
        const jobs = jobsData.jobs || [];
        let candidates = jobs;
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

      const pattern = grep
        ? new RegExp(grep, "i")
        : /##\[error\]|error TS\d|SyntaxError|ReferenceError|TypeError|Error:|FAIL\b|✗|AssertionError|Unexpected token|Process completed with exit code [1-9]/i;

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
  );
}
