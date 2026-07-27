// ---------------------------------------------------------------------------
// connectors/gemini/research.js — backs delegate_research's "wide mode"
// (a `task`, no `url`/`question`) in tools.js -- the precision mode (single
// url + question, one geminiGenerate call) stays inline in tools.js since
// it's a genuinely different, simpler code path.
//
// NO GEMINI "FIRST TRY" (2026-07-27): this used to run a multi-step Gemini
// loop first (native Google Search grounding + a web_fetch function tool),
// falling back to OpenAI's web_search only when Gemini failed or its search
// tool was rejected mid-run. That architecture, and OpenAI along with it,
// is gone -- this now calls Exa's /answer endpoint directly, which already
// does search + synthesis with sources in a single call. No multi-step
// loop, no checkpointing, no tool-combination handling, no Gemini call at
// all. See connectors/exa/client.js for the retry/cooldown/key-rotation
// behavior backing this call, and git history for the prior Gemini-loop
// implementation if it's ever wanted back.
//
// resume_run_id: tools.js's delegate_research still accepts this param for
// wide mode (shared validation with delegate_gemini's checkpoint/resume
// story), but there is no longer anything to resume -- a single Exa call
// either succeeds or fails in one shot, with nothing partial to save. If a
// caller passes resume_run_id without a task, that's surfaced as a failed
// result explaining resuming isn't a thing here anymore, rather than
// silently doing nothing or throwing.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { exaWebSearch } from "../exa/client.js";

// Runs wide-mode research via a single Exa /answer call. Returns the same
// { answer, steps, transcript, runId, task, failed? } shape the prior
// Gemini-loop implementation returned, so tools.js's delegate_research
// handler (and its Notion logging / transcript display) needs no changes.
export async function runResearch({ task, resume_run_id }) {
  const runId = randomUUID();

  if (!task) {
    return {
      answer: resume_run_id
        ? `(resume_run_id "${resume_run_id}" cannot be resumed -- wide-mode delegate_research is now a single direct call to Exa, with no multi-step loop or checkpoint to resume. Call delegate_research again with a task and no resume_run_id.)`
        : `(No task provided.)`,
      steps: 0,
      transcript: [],
      runId,
      task,
      failed: true,
    };
  }

  try {
    const answer = await exaWebSearch(task);
    return {
      answer,
      steps: 1,
      transcript: [`[step 1] exa_web_search -> ${answer.length > 300 ? answer.slice(0, 300) + "…" : answer}`],
      runId,
      task,
    };
  } catch (err) {
    const errMessage = err?.message ?? String(err);
    return {
      answer: `(Exa research call failed: ${errMessage})`,
      steps: 0,
      transcript: [],
      runId,
      task,
      failed: true,
    };
  }
}
