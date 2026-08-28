import { z } from "zod";
import { runInvestigation, seedRun } from "./agent_delegate.js";
import { loadCheckpoint } from "./agent_checkpoint.js";
import { publishAgentStep, isQStashConfigured } from "./qstash_client.js";
import { doCreatePage } from "../notion/tools.js";
import { GEMINI_NOTION_ROOT_PAGE_ID, DELEGATE_AGENT_ASYNC, AGENT_ASYNC_POLL_FRESH_SECONDS } from "../../config.js";

export function register(server) {

  server.tool(
    "delegate_agent",
    "DOES: Open-ended, multi-step READ-ONLY investigation across GitHub/Notion/Cloudflare -- Gemini runs its own server-side loop (bounded by max_steps) reading files/trees/commits/logs/pages across as many turns as needed, cross-checks claims BETWEEN sources, flags discrepancies, returns one synthesized answer.\n" +
    "RULE: default choice for multi-file or open-ended investigation -- prefer over manual read_file/get_file_tree/list_directory loops UNLESS you need exactly one named file.\n" +
    "NOT: web access -> use delegate_research (task param, wide mode) instead. NOT: any write -> read-only by design.\n" +
    "USE FOR: e.g. 'why is CI failing on PR #42', 'summarize what changed in this repo over the last week' -- cases needing 5-10+ manual cross-system calls otherwise.\n" +
    "RESUME: failed/partial run -> response includes resume_run_id -> pass back to continue from last completed step instead of restarting.\n" +
    "ASYNC -- DO NOT POLL REPEATEDLY: a fresh call may return a run_id immediately while work continues server-side. After receiving a run_id, call again with resume_run_id AT MOST ONCE per turn to check status, then STOP and end your turn -- do not call again back-to-back in the same turn. Rapid polling wastes calls and does not make the run finish faster. If still running: do other useful work, tell the user it's in progress, and only resume in a LATER message (e.g. after the user's next reply, or a real elapsed delay). Still required eventually: only a resume_run_id call retrieves the final answer, and it's also what recovers a stalled background chain -- don't skip checking back entirely.",
    {
      task:          z.string().optional().describe("The investigation task/question, described with enough context (repo names, time ranges, etc.) for Gemini to act without needing to ask you anything back -- it can't. Ignored when resume_run_id resolves to a live checkpoint (the original task from that run is reused). Optional ONLY when resume_run_id is given and its checkpoint is still live; required otherwise -- omitting it on a fresh run (no resume_run_id, or an expired one) returns an error rather than silently proceeding with no task."),
      max_steps:     z.number().optional().describe("Max tool-use turns Gemini gets before being forced to answer (default 20, hard cap 30 regardless of this value). On a resumed run this is the new ceiling, not additional steps on top of what's already done."),
      log_to_notion: z.boolean().optional().describe("Whether to log the task, step-by-step tool calls, and final answer as a page under the Gemini section of Notion (default: false). Write always targets the fixed Gemini root page."),
      resume_run_id: z.string().optional().describe("A runId returned from a previous failed/partial delegate_agent call. If its checkpoint is still live (1 hour TTL), continues that run's conversation instead of starting fresh."),
      show_transcript: z.boolean().optional().describe("Include the full step-by-step tool-call transcript in the response, even on a successful run (default: false). Useful for debugging what Gemini actually called and in what order/grouping -- e.g. checking whether independent calls were batched into the same step. On a failed/partial run the transcript is only included if this flag is explicitly true."),
      provider: z.enum(["gemini"]).optional()
        .describe(`Only "gemini" is currently supported (and is the default).`),
      model: z.string().optional()
        .describe(`Override the specific Gemini model to use (default: GEMINI_MODEL from config). ` +
          `WARNING -- CASCADE DISABLED: passing a model different from the default skips GEMINI_FALLBACK_MODELS entirely -- only the requested model is tried, so a 429/503 on it fails the call instead of cascading to another model. ` +
          `RESUME RULE: if resume_run_id resolves to a checkpoint that recorded a model, that recorded model is always used and this argument is ignored. If the checkpoint has no recorded model, this argument is used as a fallback instead of erroring.`),
      maxOutputTokens: z.number().optional()
        .describe(`Caps the per-turn (not whole-conversation) output token budget for each Gemini call in the investigation loop. Default: none set (Gemini's own API default applies, no cap sent). Raise this if answers are getting cut off mid-response. ` +
          `RESUME RULE: same as model -- if resume_run_id resolves to a checkpoint that recorded a value, that recorded value is always used and this argument is ignored. If the checkpoint has no recorded value, this argument is used as a fallback instead of erroring.`),
    },
    async ({ task, max_steps = 20, log_to_notion = false, resume_run_id, show_transcript = false, provider, model, maxOutputTokens }) => {
      // task is only genuinely optional when resuming a live checkpoint --
      // runInvestigation ignores task entirely in that branch (it rebuilds
      // `contents` straight from the saved checkpoint). On a fresh run (no
      // resume_run_id, or one whose checkpoint already expired), there is no
      // saved task to fall back on, so fail loudly here rather than letting
      // runInvestigation start a conversation with an undefined task.
      if (!task && !resume_run_id) {
        return {
          content: [{ type: "text", text: "Missing required argument: task must be provided unless resuming a live checkpoint via resume_run_id." }],
          isError: true,
        };
      }

      // max_steps has no floor in its Zod type (z.number().optional() accepts
      // 0, negatives, and non-integers), but runInvestigation's loop is a
      // `for (step = startStep; step <= cappedSteps; ...)` that simply never
      // executes when cappedSteps < startStep -- silently "succeeding" with
      // zero Gemini calls made and a confusing "reached the step cap of 0"
      // answer instead of surfacing that the input itself was invalid.
      if (max_steps !== undefined && (!Number.isInteger(max_steps) || max_steps < 1)) {
        return {
          content: [{ type: "text", text: `Invalid max_steps: ${max_steps}. Must be a positive integer (at least 1); the hard cap is 30 regardless of a larger value.` }],
          isError: true,
        };
      }

      // Same reasoning as max_steps's guard above: z.number().optional() has
      // no floor of its own, and a non-positive value here would produce a
      // confusing provider-level error (or, worse, a silently truncated-to-
      // nothing response) instead of a clear rejection at the boundary.
      if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
        return {
          content: [{ type: "text", text: `Invalid maxOutputTokens: ${maxOutputTokens}. Must be a positive integer (at least 1).` }],
          isError: true,
        };
      }

      // Async delegate_agent (plan.md Scenario B, "Tool behavior change"):
      // gated behind BOTH the rollout flag and QStash actually being
      // reachable -- if either is off/unconfigured, every branch below is
      // skipped and this falls straight through to today's fully-
      // synchronous runInvestigation call further down, unchanged.
      const asyncEnabled = DELEGATE_AGENT_ASYNC === "qstash" && isQStashConfigured();

      if (asyncEnabled && !resume_run_id) {
        // Fresh async start: seed a checkpoint (zero steps taken) and hand
        // step 1 onward off to the QStash worker, returning almost
        // immediately instead of blocking on the whole investigation --
        // this is the entire point of Scenario B.
        let runId;
        try {
          runId = await seedRun({ task, provider, model, maxOutputTokens });
          await publishAgentStep({ runId, afterStep: 0 });
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to start async investigation: ${err?.message ?? String(err)}` }], isError: true };
        }
        return {
          content: [{ type: "text", text:
            `Investigation started in the background (run_id: ${runId}). It will keep stepping on its own -- call delegate_agent again with resume_run_id: "${runId}" (task not needed) to poll for progress or the final answer.` }],
        };
      }

      if (asyncEnabled && resume_run_id) {
        const checkpoint = await loadCheckpoint(resume_run_id);
        if (checkpoint && checkpoint.status === "failed") {
          // Dead-lettered by agent_worker.js (plan.md step 8) after repeated
          // same-step failures -- a definitive, non-resumable outcome.
          // Return it directly rather than letting runInvestigation try to
          // resume a run that was deliberately given up on.
          return {
            content: [{ type: "text", text: `Investigation failed permanently (run_id: ${resume_run_id}) after repeated errors on the same step: ${checkpoint.finalAnswer || "(no error detail saved)"}` }],
            isError: true,
          };
        }
        if (checkpoint && checkpoint.status === "running") {
          const ageMs = Date.now() - (checkpoint.lastStepAt || 0);
          if (ageMs < AGENT_ASYNC_POLL_FRESH_SECONDS * 1000) {
            // Fresh lastStepAt -- the background worker chain is still
            // actively stepping. Poll-only: report progress WITHOUT taking
            // a step ourselves, so a poll can never race the worker.
            return {
              content: [{ type: "text", text:
                `Still running (run_id: ${resume_run_id}) -- ${checkpoint.stepsDone} step(s) completed so far. Last activity ${Math.round(ageMs / 1000)}s ago. Call again with the same resume_run_id to keep polling.` +
                (checkpoint.transcript?.length ? `\n\nTool calls so far:\n${checkpoint.transcript.join("\n")}` : "") }],
            };
          }
          // Stale lastStepAt -- the QStash chain likely broke (a failed
          // publish, a dropped/undelivered message). Fall through to the
          // ordinary synchronous runInvestigation call below, which resumes
          // the loop IN THIS CALL -- this is what guarantees a run can never
          // be stranded, per plan.md's "Tool behavior change".
        }
        // checkpoint missing (expired/never existed), or status "done" --
        // fall through to runInvestigation below, which already handles
        // both correctly: "done" is a cheap stored-answer read (no re-
        // execution), and "missing" produces its existing clear error.
      }

      let result;
      try {
        result = await runInvestigation({ task, max_steps, resume_run_id, provider, model, maxOutputTokens });
      } catch (err) {
        return { content: [{ type: "text", text: `Investigation failed: ${err?.message ?? String(err)}` }], isError: true };
      }

      // On a resumed run, `task` may be undefined here (a fresh run always has
      // it, per the guard above) -- runInvestigation returns the effective
      // task text it actually used (the caller-supplied one, or the one
      // restored from the checkpoint) so logging/titling never has to guess.
      const effectiveTask = task || result.task || "(resumed run)";

      let notionNote = "";
      if (log_to_notion) {
        try {
          const logged = await doCreatePage({
            parent_id:   GEMINI_NOTION_ROOT_PAGE_ID,
            parent_type: "page",
            title:       `${result.failed ? "investigate (partial): " : "investigate: "}${effectiveTask.slice(0, 80)}`,
            content:     `Task: ${effectiveTask}\n\nrunId: ${result.runId}${result.failed ? " (resumable)" : ""}\n\nSteps taken: ${result.steps}\n\nTool calls:\n${result.transcript.join("\n") || "(none)"}\n\nAnswer:\n${result.answer}`,
            one_off:     true,
          });
          notionNote = `\n\n(Logged to Notion: ${logged.url})`;
        } catch (err) {
          notionNote = `\n\n(\u26a0\ufe0f Notion logging failed: ${err.message})`;
        }
      }

      // Fix: when a run fails/is partial, if show_transcript is not explicitly true,
      // return a COMPACT structured summary instead of the full transcript:
      // - step count reached
      // - short description of what failed (error message / reason)
      // - resume_run_id if resumable
      // - omit full transcript unless show_transcript is explicitly true.
      if (result.failed) {
        const resumeLine = result.runId ? `resume_run_id: "${result.runId}"` : "not resumable";
        const transcriptBlock = show_transcript && result.transcript?.length
          ? `\n\nTool calls completed before failure:\n${result.transcript.join("\n")}`
          : "";
        const compactText =
          `Investigation failed or partial after ${result.steps} step(s).\n` +
          `Reason/Error: ${result.answer}\n` +
          `Resumable: ${resumeLine}${transcriptBlock}${notionNote}`;
        return { content: [{ type: "text", text: compactText }], isError: true };
      }

      const transcriptBlock = result.transcript?.length && show_transcript
        ? `\n\nTool call transcript:\n${result.transcript.join("\n")}`
        : "";

      return { content: [{ type: "text", text: `${result.answer}${transcriptBlock}\n\n(${result.steps} step(s) taken)${notionNote}` }], isError: false };
    }
  );
}
