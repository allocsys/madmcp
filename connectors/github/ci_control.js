// ---------------------------------------------------------------------------
// connectors/github/ci_control.js — triggering & controlling CI runs, and
// reading commit-level check state (as opposed to actions.js, which only
// lists/reads runs that already exist and can't start, stop, or query the
// checks/status API for a specific commit/ref).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "trigger_workflow",
    "DOES: Manually trigger a workflow_dispatch run on a branch/ref, with optional inputs.\n" +
    "RULE: workflow file must have a workflow_dispatch trigger defined, or this fails.\n" +
    "RULE: needing CI to run without a real change -> this, instead of opening a throwaway PR.",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      workflow_id: z.string().describe("Workflow file name (e.g. 'ci.yml') or numeric workflow ID"),
      ref:         z.string().describe("Branch, tag, or SHA to run the workflow on"),
      inputs:      z.record(z.string()).optional().describe("Input parameters declared under `workflow_dispatch.inputs` in the workflow file, as string key/value pairs"),
    },
    async ({ owner = DEFAULT_OWNER, repo, workflow_id, ref, inputs }) => {
      await githubRequest(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/dispatches`, {
        method: "POST",
        body: { ref, inputs },
      });
      // The dispatch endpoint returns no body (204), so poll the workflow's
      // runs list briefly to hand back a run URL instead of a bare "ok".
      let found;
      for (let attempt = 0; attempt < 4 && !found; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
        const runs = await githubRequest(
          `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=1`
        );
        found = runs.workflow_runs?.[0];
      }
      return {
        content: [{
          type: "text",
          text: found
            ? `Triggered workflow '${workflow_id}' on ${ref}. Run #${found.run_number}: ${found.html_url}`
            : `Triggered workflow '${workflow_id}' on ${ref}. GitHub hasn't listed the new run yet -- check list_workflow_runs shortly.`,
        }],
      };
    }
  );

  server.tool(
    "rerun_workflow",
    "DOES: Rerun a workflow run -- whole run, or failed jobs only.\n" +
    "RULE: retrying a flaky test without re-running steps that already passed -> failed_jobs_only=true.",
    {
      owner:            z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:             z.string().describe("Repository name"),
      run_id:           z.number().describe("Workflow run ID (from list_workflow_runs)"),
      failed_jobs_only: z.boolean().optional().describe("If true, only rerun failed jobs instead of the entire run (default: false)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, run_id, failed_jobs_only = false }) => {
      const endpoint = failed_jobs_only ? "rerun-failed-jobs" : "rerun";
      await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/${endpoint}`, { method: "POST" });
      return {
        content: [{
          type: "text",
          text: `Requested rerun of ${failed_jobs_only ? "failed jobs in " : ""}run ${run_id}. Poll with list_workflow_runs or get_workflow_run_logs to see progress.`,
        }],
      };
    }
  );

  server.tool(
    "cancel_workflow_run",
    "DOES: Cancel a queued or in-progress workflow run.",
    {
      owner:  z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:   z.string().describe("Repository name"),
      run_id: z.number().describe("Workflow run ID (from list_workflow_runs)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, run_id }) => {
      await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/cancel`, { method: "POST" });
      return { content: [{ type: "text", text: `Cancellation requested for run ${run_id}.` }] };
    }
  );

  server.tool(
    "get_check_runs",
    "DOES: Individual check/status entries (pass/fail dots) for a commit/branch/tag -- the data behind GitHub's green check / red X.\n" +
    "NOT: a list of Actions runs -> use list_workflow_runs for that.",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      ref:      z.string().describe("Commit SHA, branch name, or tag to get check runs for"),
      per_page: z.number().optional().describe("Number of check runs to return, max 100 (default: 30)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref, per_page = 30 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=${per_page}`);
      if (!data.check_runs?.length) return { content: [{ type: "text", text: `No check runs found for ${ref}.` }] };
      const icon = (s, c) => s !== "completed" ? "🔄" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "skipped" ? "⏭️" : c === "cancelled" ? "🚫" : "⚪";
      const lines = data.check_runs.map((c) =>
        `${icon(c.status, c.conclusion)} ${c.name} — ${c.status}${c.conclusion ? `/${c.conclusion}` : ""}\n  ${c.html_url}`
      );
      return { content: [{ type: "text", text: `${data.total_count} check run(s) for ${ref}:\n\n${lines.join("\n\n")}` }] };
    }
  );

  server.tool(
    "get_combined_status",
    "DOES: Combined commit status for a ref -- overall pass/fail/pending rollup + each individual status context (the legacy Status API some CI systems/integrations use instead of, or alongside, Actions check-runs).",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
      ref:   z.string().describe("Commit SHA, branch name, or tag"),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref }) => {
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
