// ---------------------------------------------------------------------------
// connectors/frontend/tools.js — delegate_designer
//
// Write-capable tool-calling agent for HTML/CSS/SCSS/JSX/TSX/Vue files
// (issue #61 redesign). Thin wrapper around runDesignAgent (agent.js):
// validation and response-shaping here deliberately mirror connectors/
// gemini/tools.js's delegate_agent (same resume_run_id / max_steps /
// show_transcript conventions), since this is architecturally the same
// kind of step-bounded, checkpointable tool-calling loop -- just
// write-capable and scoped to frontend files instead of read-only/
// cross-system.
//
// HISTORY: this replaced an older one-shot generate -> validate -> fix loop
// (bounded 3-attempt blind retry, single static context dump, syntax-only
// validation, split full-write/patch-write paths) that accumulated five
// closed issues (#56-#60) which turned out to be tightly entangled --
// patching them one-by-one kept requiring changes to each other, so issue
// #61 redesigned from scratch instead: a real multi-step agent loop
// (read_file/write_file/validate, modeled on delegate_gemini's
// runInvestigation) replacing the fixed pipeline. That loop ran alongside
// the old one as "delegate_designer_v2" behind a feature flag during a
// dark-launch/monitoring period; once it proved stable (four post-launch
// bugs found and fixed live: a final-step write-execution guard, a
// resume_run_id gap on step-cap-without-answer stops, stuck-loop detection,
// and a stale-read-cache bug introduced by that same stuck-loop fix -- see
// the issue #61 Notion design doc for the full history), the old loop and
// its feature flag were removed entirely and this tool took over the
// "delegate_designer" name. connectors/frontend/client.js and checkpoint.js
// (the old loop's provider-agnostic generator and Redis checkpoint module)
// were deleted alongside it -- nothing else in the codebase imported them.
//
// SCOPE FENCING (deliberate, not incidental), enforced at the TOOL layer
// inside agent_tools.js's own read_file/write_file (not just prompt
// instructions), per issue #61:
//  - READ/WRITE: both fenced to FRONTEND_ALLOWED_EXTENSIONS -- a bad or
//    manipulated task can't point this at config.js or other
//    secret-adjacent files, and can't land a write on server.js/
//    package.json/workflows/etc.
//  - BRANCH: refuses to run at all if `branch` resolves to the repo's
//    default branch, checked once up front before any tool call --
//    nothing this agent does can land on main directly.
//  - No delete capability at all (create/overwrite only).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { runDesignAgent } from "./agent.js";
import {
  DEFAULT_OWNER, FRONTEND_ALLOWED_EXTENSIONS, FRONTEND_DEFAULT_STEPS,
} from "../../config.js";

export function register(server) {
  server.tool(
    "delegate_designer",
    "TRIGGERS: \"build a page\", \"restyle X\", \"make responsive\", \"clean up this CSS\", \"turn mockup into markup\" -- ANY HTML/CSS/SCSS/JSX/TSX/Vue creation or edit, new file or existing.\n" +
    "RULE: ALWAYS prefer this over hand-writing/editing HTML/CSS/JSX yourself, even if you could do it directly -- delegates to a model-driven agent that reads files on demand, edits or creates them, validates syntax, and iterates.\n" +
    "IS: WRITE TOOL, bounded agentic loop (default " + FRONTEND_DEFAULT_STEPS + " steps) with three tools of its own (read_file/write_file/validate) -- writes to repo in the same call. Returns the agent's own final text summary, not the generated code.\n" +
    "PREREQUISITE: branch != repo's default branch. No branch yet -> call create_branch first.\n" +
    "SCOPE: reads and writes both fenced to " + FRONTEND_ALLOWED_EXTENSIONS.join(", ") + " only, enforced at the tool layer inside the agent's own read_file/write_file (not just prompt instructions). Refuses default-branch writes. No delete.\n" +
    "RESUME: failed/partial run -> response includes resume_run_id -> pass back to continue from last completed step instead of restarting.",
    {
      owner:           z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:            z.string().optional().describe("Repository name. Not needed when resuming (resume_run_id carries it)."),
      branch:          z.string().optional().describe("Branch to work on. MUST NOT be the repo's default branch. Not needed when resuming."),
      task:            z.string().optional().describe("What to build or change, described with enough detail for the agent to act without asking anything back -- it can't. Ignored when resume_run_id resolves to a live checkpoint (the original task from that run is reused). Optional ONLY when resume_run_id is given and its checkpoint is still live; required otherwise."),
      max_steps:       z.number().optional().describe(`Max agent steps before being forced to answer (default ${FRONTEND_DEFAULT_STEPS}, hard cap 20 regardless of this value). On a resumed run this is the new ceiling, not additional steps on top of what's already done.`),
      resume_run_id:   z.string().optional().describe("A runId returned from a previous failed/partial delegate_designer call. If its checkpoint is still live (1 hour TTL), continues that run's conversation instead of starting fresh."),
      show_transcript: z.boolean().optional().describe("Include the full step-by-step tool-call transcript in the response, even on a successful run (default: false). On a failed/partial run the transcript is always shown regardless of this flag."),
    },
    async ({ owner = DEFAULT_OWNER, repo, branch, task, max_steps, resume_run_id, show_transcript = false }) => {
      // Same "task is only genuinely optional when resuming a live
      // checkpoint" reasoning as delegate_agent's handler in
      // connectors/gemini/tools.js.
      if (!task && !resume_run_id) {
        return {
          content: [{ type: "text", text: "Missing required argument: task must be provided unless resuming a live checkpoint via resume_run_id." }],
          isError: true,
        };
      }
      if (max_steps !== undefined && (!Number.isInteger(max_steps) || max_steps < 1)) {
        return {
          content: [{ type: "text", text: `Invalid max_steps: ${max_steps}. Must be a positive integer (at least 1); the hard cap is 20 regardless of a larger value.` }],
          isError: true,
        };
      }

      let result;
      try {
        result = await runDesignAgent({ owner, repo, branch, task, max_steps, resume_run_id });
      } catch (err) {
        return { content: [{ type: "text", text: `delegate_designer failed: ${err?.message ?? String(err)}` }], isError: true };
      }

      const writtenNote = result.writtenFiles?.length
        ? `\n\nFiles written: ${result.writtenFiles.join(", ")}`
        : "";
      const transcriptBlock = result.transcript?.length && (result.failed || show_transcript)
        ? `\n\n${result.failed ? "Tool calls completed before the failure" : "Tool call transcript"}:\n${result.transcript.join("\n")}`
        : "";

      return {
        content: [{ type: "text", text: `${result.answer}${writtenNote}${transcriptBlock}\n\n(${result.steps} step(s) taken)` }],
        isError: !!result.failed,
      };
    }
  );
}
