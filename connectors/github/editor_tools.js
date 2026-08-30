// ---------------------------------------------------------------------------
// connectors/github/editor_tools.js -- MCP tool registration for delegate_editor
// ("Limited GitHub write access for delegate_agent (non-default-branch only)").
//
// Thin wrapper around runEditorAgent (editor_delegate.js), same shape as
// connectors/frontend/designer_tools.js's delegate_designer wrapper: same
// resume_run_id / max_steps / show_transcript conventions, same
// writtenFiles/transcript response shaping (guardrail #9's audit trail --
// the transcript/writtenFiles reporting IS the audit trail, per the
// note that mandatory Notion logging was considered and dropped as
// redundant with this).
//
// GATED BEHIND EDITOR_AGENT_ENABLED (the rollout flag):
// register() below is a no-op unless the flag is "true", so this tool
// simply doesn't exist on the MCP surface until a human flips it on
// deliberately -- same "disable without a revert" posture as
// DELEGATE_AGENT_ASYNC elsewhere in this repo. Flip via env var, not code,
// once the test suite and a manual smoke test both look right.
//
// Tool description is deliberately as explicit about scope limits as
// delegate_agent's own description is about being read-only -- the calling
// model needs to know, from the description alone, that this tool can only
// write to a non-default branch it doesn't get to choose past guardrails #1/#2,
// before it ever calls it.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { runEditorAgent } from "./editor_delegate.js";
import {
  DEFAULT_OWNER,
  EDITOR_ALLOWED_EXTENSIONS,
  EDITOR_ALLOWED_PATH_PREFIXES,
  EDITOR_DEFAULT_STEPS,
  EDITOR_HARD_MAX_STEPS,
  EDITOR_MAX_FILES_PER_RUN,
  EDITOR_MAX_WRITES_PER_FILE,
  EDITOR_AGENT_ENABLED,
} from "../../config.js";

function scopeSummary() {
  const pathPart = EDITOR_ALLOWED_PATH_PREFIXES.length
    ? `; restricted to paths under: ${EDITOR_ALLOWED_PATH_PREFIXES.join(", ")}`
    : "; no additional path restriction beyond the deny list";
  return `${EDITOR_ALLOWED_EXTENSIONS.join(", ")}${pathPart}`;
}

export function register(server) {
  // Rollout gate: this tool is not registered at all --
  // not "registered but refuses calls" -- unless the flag is on. A caller
  // (or a prompt-injected instruction) can't discover or invoke a tool
  // that was never added to the server's tool list in the first place.
  if (!EDITOR_AGENT_ENABLED) return;

  server.tool(
    "delegate_editor",
    "TRIGGERS: general-purpose repo edits on a feature branch -- docs, config, backend code, tests, etc. -- that aren't frontend " +
      "HTML/CSS/JSX/Vue (use delegate_designer for those) and aren't a read-only investigation (use delegate_agent for those).\n" +
      "IS: WRITE TOOL, bounded agentic loop (default " + EDITOR_DEFAULT_STEPS + " steps, hard cap " + EDITOR_HARD_MAX_STEPS + ") with three tools of its own (read_file/write_file/validate) -- commits to the repo in the same call. Returns the agent's own final text summary plus which files it wrote, not the generated code inline.\n" +
      "SCOPE, ENFORCED AT THE TOOL LAYER (not just prompt instructions): reads/writes fenced to extensions " + scopeSummary() + ". " +
      "A hard deny list (independent of the allowlist) always blocks .github/workflows/**, connectors/security.js, and GitHub-App auth files, and blocks package.json's scripts/dependencies fields specifically -- regardless of extension. " +
      "This run may touch at most " + EDITOR_MAX_FILES_PER_RUN + " distinct file(s), and write any single file at most " + EDITOR_MAX_WRITES_PER_FILE + " time(s).\n" +
      "PREREQUISITE: `branch` MUST already exist and MUST NOT be the repo's default branch -- checked live against the GitHub API before any tool call, never trusted from the argument alone. No branch yet -> call create_branch first.\n" +
      "CANNOT open, approve, or merge pull requests -- this tool has no create_pull_request/merge_pull_request in its own function set, structurally, not just by convention. A human reviews the branch's diff afterward; this tool only gets it ready for that review.\n" +
      "RESUME: failed/partial run -> response includes resume_run_id -> pass back to continue from the last completed step instead of restarting.",
    {
      owner:           z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:            z.string().optional().describe("Repository name. Not needed when resuming (resume_run_id carries it)."),
      branch:          z.string().optional().describe("Branch to work on. Must already exist and MUST NOT be the repo's default branch. Not needed when resuming."),
      task:            z.string().optional().describe("What to change, described with enough detail for the agent to act without asking anything back -- it can't. Ignored when resume_run_id resolves to a live checkpoint (the original task from that run is reused). Optional ONLY when resume_run_id is given and its checkpoint is still live; required otherwise."),
      max_steps:       z.number().optional().describe(`Max agent steps before being forced to answer (default ${EDITOR_DEFAULT_STEPS}, hard cap ${EDITOR_HARD_MAX_STEPS} regardless of this value). On a resumed run this is the new ceiling, not additional steps on top of what's already done.`),
      resume_run_id:   z.string().optional().describe("A runId returned from a previous failed/partial delegate_editor call. If its checkpoint is still live (1 hour TTL), continues that run's conversation instead of starting fresh."),
      show_transcript: z.boolean().optional().describe("Include the full step-by-step tool-call transcript in the response, even on a successful run (default: false). On a failed/partial run the transcript is always shown regardless of this flag."),
    },
    async ({ owner = DEFAULT_OWNER, repo, branch, task, max_steps, resume_run_id, show_transcript = false }) => {
      // Same "task is only genuinely optional when resuming a live
      // checkpoint" reasoning as delegate_designer/delegate_agent's own
      // handlers.
      if (!task && !resume_run_id) {
        return {
          content: [{ type: "text", text: "Missing required argument: task must be provided unless resuming a live checkpoint via resume_run_id." }],
          isError: true,
        };
      }
      if (max_steps !== undefined && (!Number.isInteger(max_steps) || max_steps < 1)) {
        return {
          content: [{ type: "text", text: `Invalid max_steps: ${max_steps}. Must be a positive integer (at least 1); the hard cap is ${EDITOR_HARD_MAX_STEPS} regardless of a larger value.` }],
          isError: true,
        };
      }

      let result;
      try {
        result = await runEditorAgent({ owner, repo, branch, task, max_steps, resume_run_id });
      } catch (err) {
        return { content: [{ type: "text", text: `delegate_editor failed: ${err?.message ?? String(err)}` }], isError: true };
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
