// ---------------------------------------------------------------------------
// connectors/gemini/agent_tools.js
//
// Registers delegate_agent: open-ended, multi-step READ-ONLY investigation
// across GitHub/Notion/Cloudflare/Context7/Mem0, backed by agent_delegate.js's
// server-side Gemini function-calling loop.
//
// delegate_research (web research, Exa-backed) used to be co-located in
// this file alongside delegate_agent -- both were "the Gemini connector's
// tools" at the time. As of the exa/gemini naming pass (2026-08-01),
// delegate_research now has its own file, connectors/exa/research_tools.js,
// so each MCP tool's registration lives next to the connector that actually
// backs it (agent_tools.js here for Gemini/delegate_agent, research_tools.js
// for Exa/delegate_research). See the delegation-naming-convention Notion
// plan for the full history of this split.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { runInvestigation } from "./agent_delegate.js";
import { doCreatePage } from "../notion/tools.js";
import { GEMINI_NOTION_ROOT_PAGE_ID, DEFAULT_LLM_PROVIDER, GLM_DEFAULT_MAX_OUTPUT_TOKENS } from "../../config.js";

export function register(server) {

  server.tool(
    "delegate_agent",
    "DOES: Open-ended, multi-step READ-ONLY investigation across GitHub/Notion/Cloudflare -- Gemini runs its own server-side loop (bounded by max_steps) reading files/trees/commits/logs/pages across as many turns as needed, cross-checks claims BETWEEN sources, flags discrepancies, returns one synthesized answer.\n" +
    "RULE: default choice for multi-file or open-ended investigation -- prefer over manual read_file/get_file_tree/list_directory loops UNLESS you need exactly one named file.\n" +
    "NOT: web access -> use delegate_research (task param, wide mode) instead. NOT: any write -> read-only by design.\n" +
    "USE FOR: e.g. 'why is CI failing on PR #42', 'summarize what changed in this repo over the last week' -- cases needing 5-10+ manual cross-system calls otherwise.\n" +
    "RESUME: failed/partial run -> response includes resume_run_id -> pass back to continue from last completed step instead of restarting.",
    {
      task:          z.string().optional().describe("The investigation task/question, described with enough context (repo names, time ranges, etc.) for Gemini to act without needing to ask you anything back -- it can't. Ignored when resume_run_id resolves to a live checkpoint (the original task from that run is reused). Optional ONLY when resume_run_id is given and its checkpoint is still live; required otherwise -- omitting it on a fresh run (no resume_run_id, or an expired one) returns an error rather than silently proceeding with no task."),
      max_steps:     z.number().optional().describe("Max tool-use turns Gemini gets before being forced to answer (default 20, hard cap 30 regardless of this value). On a resumed run this is the new ceiling, not additional steps on top of what's already done."),
      log_to_notion: z.boolean().optional().describe("Whether to log the task, step-by-step tool calls, and final answer as a page under the Gemini section of Notion (default: false). Write always targets the fixed Gemini root page."),
      resume_run_id: z.string().optional().describe("A runId returned from a previous failed/partial delegate_agent call. If its checkpoint is still live (1 hour TTL), continues that run's conversation instead of starting fresh."),
      show_transcript: z.boolean().optional().describe("Include the full step-by-step tool-call transcript in the response, even on a successful run (default: false). Useful for debugging what Gemini actually called and in what order/grouping -- e.g. checking whether independent calls were batched into the same step. On a failed/partial run the transcript is always shown regardless of this flag."),
      provider: z.enum(["gemini", "glm"]).optional()
        .describe(`DEFAULT: "${DEFAULT_LLM_PROVIDER}". ` +
          `VALUES: "gemini" (Google Gemini API, needs GEMINI_API_KEY) | "glm" (Z.ai GLM via OpenRouter, needs OPENROUTER_API_KEYS). ` +
          `CHOOSE: the two are interchangeable in capability, not just cost/speed -- switch to "glm" if Gemini's output has been unreliable for this task. ` +
          `RESUME RULE: if resume_run_id resolves to a checkpoint that recorded a provider (any run started after this field existed), that recorded provider is always used and this argument is ignored -- switching providers mid-run risks corrupting the checkpointed conversation. If the checkpoint has no recorded provider (an older run), this argument is used as a fallback instead of erroring.`),
      model: z.string().optional()
        .describe(`DEFAULT: none set -- the chosen provider's own default model is used (GEMINI_MODEL or GLM_MODEL from config). ` +
          `USE: override the specific model within the chosen provider, e.g. model: "z-ai/glm-4.5-air:free" with provider: "glm" to force OpenRouter's free-tier model instead of the default paid GLM_MODEL (useful when the account is low on OpenRouter credits). ` +
          `WARNING -- CASCADE DISABLED: passing a model that differs from the provider's own default model skips that provider's fallback-model list entirely (GLM_FALLBACK_MODELS / GEMINI_FALLBACK_MODELS are NOT tried) -- only the requested model is used, so a 429/503 on it fails the call instead of cascading to another model. API-key rotation (OPENROUTER_API_KEYS) is unaffected either way and still applies. ` +
          `RESUME RULE: same as provider -- if resume_run_id resolves to a checkpoint that recorded a model, that recorded model is always used and this argument is ignored. If the checkpoint has no recorded model (an older run, or a run that didn't specify one), this argument is used as a fallback instead of erroring.`),
      maxOutputTokens: z.number().optional()
        .describe(`DEFAULT: for provider "gemini", none set (Gemini's own API default applies, no cap sent). For provider "glm", ${GLM_DEFAULT_MAX_OUTPUT_TOKENS} (GLM_DEFAULT_MAX_OUTPUT_TOKENS from config) if this argument is omitted. ` +
          `USE: caps the per-turn (not whole-conversation) output token budget for each model call in the investigation loop. Raise this if answers are getting cut off mid-response; lower it if OpenRouter credits are tight. ` +
          `WHY GLM NEEDS A DEFAULT: with no max_tokens at all, OpenRouter defaults a request to the target model's FULL max context (e.g. 65536 for z-ai/glm-4.6) -- on a credit-limited account this fails EVERY GLM call with a 402 "requires more credits, or fewer max_tokens" error regardless of which model is selected, so provider "glm" always sends a value even when this argument is omitted. ` +
          `RESUME RULE: same as provider/model -- if resume_run_id resolves to a checkpoint that recorded a value, that recorded value is always used and this argument is ignored. If the checkpoint has no recorded value (an older run), this argument (or the provider default above) is used as a fallback instead of erroring.`),
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

      // On a failed/partial run, the tool calls already completed are real
      // work (and already checkpointed to Redis -- see runInvestigation's
      // comment) that shouldn't be thrown away. Print them here instead of
      // just a step count, so the caller can see what was actually found
      // before the failure without needing a resume_run_id round-trip or
      // log_to_notion just to inspect them.
      const transcriptBlock = result.transcript?.length && (result.failed || show_transcript)
        ? `\n\n${result.failed ? "Tool calls completed before the failure" : "Tool call transcript"}:\n${result.transcript.join("\n")}`
        : "";

      return { content: [{ type: "text", text: `${result.answer}${transcriptBlock}\n\n(${result.steps} step(s) taken)${notionNote}` }], isError: !!result.failed };
    }
  );
}
