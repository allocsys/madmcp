// ---------------------------------------------------------------------------
// connectors/github/editor_delegate.js -- plan.md step 5, "Build the agent
// loop" for delegate_editor ("Limited GitHub write access for delegate_agent
// (non-default-branch only)").
//
// Adapts connectors/frontend/designer_delegate.js's runDesignAgent shape --
// same multi-step Gemini function-calling loop, same checkpoint/resume
// contract (guardrail #7: reuse designer_checkpoint.js's shape, here via
// connectors/github/editor_checkpoint.js, a same-shape sibling with its own
// Redis key prefix), same stuck-loop/repeat-detection and final-step tool
// withholding fixes -- but:
//
//   - TWO tools only (read_file/write_file), not three: no validate() yet.
//     Wiring a validate-before-write step is plan.md step 6, a separate
//     step from this one -- this loop calls write_file directly, same as
//     designer_delegate.js's write_file tool does today (validate is opt-in
//     there too, the model chooses whether to call it first).
//   - Backed by connectors/github/editor_tool_functions.js's general
//     Contents-API read_file/write_file (guardrails #2/#3/#4 already
//     enforced AT THAT LAYER -- see that file's own header), not
//     designer_tool_functions.js's frontend-only helper.
//   - NEW: guardrail #6, per-run and per-file write caps
//     (EDITOR_MAX_FILES_PER_RUN / EDITOR_MAX_WRITES_PER_FILE), enforced
//     inside write_file's execute() closure below, before writeFile() is
//     even called -- bounds the blast radius of a stuck or misbehaving loop
//     independently of (and in addition to) the stuck-loop repeat detection
//     carried over from designer_delegate.js, since a loop that keeps
//     writing DIFFERENT files/paths each step would never trip repeat
//     detection at all.
//   - Guardrail #2 (default-branch refusal) is checked once, up front, via
//     editor_tool_functions.js's assertNotDefaultBranch -- same "look it up
//     live, never trust the caller" posture designer_delegate.js uses via
//     a raw githubRequest call; here we just reuse the tool layer's own
//     exported helper instead of duplicating the lookup.
//   - No create_pull_request/merge_pull_request in this tool's own function
//     set (guardrail #8) -- enforced structurally, by the FUNCTIONS array
//     below simply never including them, same as designer_delegate.js's
//     three-tool array never including anything outside its own scope.
//
// NOT YET WIRED TO AN MCP TOOL: exports runEditorAgent as a plain function,
// unit-testable independently of any server.tool(...) registration (step 7)
// -- same "build the loop, unit test it independently" posture
// designer_delegate.js's own header describes for its step.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { providerChat } from "../llm/router.js";
import { readFile, writeFile, assertNotDefaultBranch } from "./editor_tool_functions.js";
import { saveCheckpoint, loadCheckpoint, deleteCheckpoint } from "./editor_checkpoint.js";
import { isRedisConfigured } from "../gemini/cooldown.js";
import {
  EDITOR_ALLOWED_EXTENSIONS,
  EDITOR_ALLOWED_PATH_PREFIXES,
  EDITOR_DEFAULT_STEPS,
  EDITOR_HARD_MAX_STEPS,
  EDITOR_MAX_FILES_PER_RUN,
  EDITOR_MAX_WRITES_PER_FILE,
} from "../../config.js";

// Same reasoning as connectors/gemini/agent_delegate.js's
// isTransientGeminiError / designer_delegate.js's copy of it: only 429
// (rate limit) and 503 (overloaded) are worth resuming past -- everything
// else reproduces identically on a resume.
function isTransientGeminiError(err) {
  return err?.status === 429 || err?.status === 503 || err?.transient === true;
}

function scopeDescription() {
  const extPart = `extensions: ${EDITOR_ALLOWED_EXTENSIONS.join(", ")}`;
  const pathPart = EDITOR_ALLOWED_PATH_PREFIXES.length
    ? `; restricted to paths under: ${EDITOR_ALLOWED_PATH_PREFIXES.join(", ")}`
    : "; no additional path restriction beyond the deny list";
  return `${extPart}${pathPart}`;
}

function buildSystemPreamble({ owner, repo, branch, task }) {
  return (
    "You are a general-purpose repo-editing agent working inside ONE fixed repository and branch. " +
    `You may read and write files within this scope only (${scopeDescription()}) -- some paths are also ` +
    "hard-denied regardless of extension (e.g. CI workflow files, auth-adjacent code); a denied write will " +
    "come back as an error explaining why, not a silent skip.\n\n" +
    `Repository: ${owner}/${repo}. Branch: ${branch} (already confirmed to not be the default branch).\n\n` +
    `This run may touch at most ${EDITOR_MAX_FILES_PER_RUN} distinct file(s), and write to any single file ` +
    `at most ${EDITOR_MAX_WRITES_PER_FILE} time(s) -- plan your edits accordingly rather than writing the ` +
    "same file repeatedly to iterate toward a result.\n\n" +
    "You have two tools:\n" +
    "- read_file(path): reads a file's current content on this branch, together with its blob sha. Always " +
    "read a file before patching it -- write_file's replacements mode benefits from an exact-match sha, " +
    "and either write mode will be rejected as a conflict if the file changed since you last read it.\n" +
    "- write_file(path, content OR replacements, base_sha, message): writes a file. Give `content` for a " +
    "full overwrite (also how you create a brand-new file), or `replacements` (a list of {find, replace} " +
    "operations, each `find` must appear exactly once in the current file) to edit part of a file you " +
    "already read -- replacements mode requires the file to already exist. `base_sha` is optional but " +
    "recommended once you've read a file: if given, the write is rejected as a conflict when it doesn't " +
    "match the file's current sha, which means the file changed since you read it -- re-read and retry " +
    "rather than assuming your version is still current.\n\n" +
    "Work iteratively: read what you need, make changes, write, and confirm the result makes sense. This " +
    "tool cannot open or merge pull requests -- a human reviews the branch afterward. When the task is " +
    "fully done, respond with a final plain-text summary of what you changed (or didn't, and why) and no " +
    "further function calls.\n\n" +
    `Task: ${task}`
  );
}

// Builds the two function declarations + their execute() closures for one
// run. owner/repo/branch are captured here, NOT exposed as parameters the
// model can set -- same fencing rationale as designer_delegate.js's
// buildFunctions (guardrail #1).
function buildFunctions({ owner, repo, branch, writtenFiles, writesPerFile }) {
  const FUNCTIONS = [
    {
      name: "read_file",
      description: "Read a file's current content on this run's branch, together with its blob sha (useful as base_sha for write_file).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path within the repo, relative to repo root." },
        },
        required: ["path"],
      },
      execute: async ({ path }) => {
        const result = await readFile(owner, repo, path, branch);
        return `sha: ${result.sha}\n\n${result.content}`;
      },
    },
    {
      name: "write_file",
      description: "Write a file on this run's branch. Exactly one of `content` (full overwrite / create) or `replacements` (find/replace operations) is required.",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string", description: "File path within the repo, relative to repo root." },
          content: { type: "string", description: "Full new file content (mutually exclusive with replacements)" },
          replacements: {
            type: "array",
            description: "List of find/replace operations, applied sequentially (mutually exclusive with content). Requires the file to already exist.",
            items: {
              type: "object",
              properties: {
                find:    { type: "string" },
                replace: { type: "string" },
              },
              required: ["find", "replace"],
            },
          },
          base_sha: { type: "string", description: "Optional: the sha returned by a prior read_file call on this exact path, to detect concurrent changes." },
          message:  { type: "string", description: "Commit message (optional -- a reasonable default is used if omitted)" },
        },
        required: ["path"],
      },
      execute: async ({ path, content, replacements, base_sha, message }) => {
        // Guardrail #6, checked BEFORE writeFile() is called at all -- a
        // stuck loop that keeps writing different paths would never trip
        // the stuck-loop repeat detection below, so this cap has to be
        // independent of that mechanism, not layered only on top of it.
        const alreadyTouched = writtenFiles.includes(path);
        if (!alreadyTouched && writtenFiles.length >= EDITOR_MAX_FILES_PER_RUN) {
          return `Error: this run has already touched ${writtenFiles.length} distinct file(s), which is this run's per-run cap (EDITOR_MAX_FILES_PER_RUN=${EDITOR_MAX_FILES_PER_RUN}). Writing "${path}" would exceed it -- finish up with the files already touched (${writtenFiles.join(", ")}), or explain what's left undone.`;
        }
        const priorWrites = writesPerFile.get(path) || 0;
        if (priorWrites >= EDITOR_MAX_WRITES_PER_FILE) {
          return `Error: "${path}" has already been written ${priorWrites} time(s) this run, which is this run's per-file cap (EDITOR_MAX_WRITES_PER_FILE=${EDITOR_MAX_WRITES_PER_FILE}). Proceed without further writes to this file.`;
        }

        try {
          const result = await writeFile(owner, repo, path, { content, replacements, baseSha: base_sha, branch, message });
          writesPerFile.set(path, priorWrites + 1);
          if (!alreadyTouched) writtenFiles.push(path);
          if (result.noop) {
            return `No-op: "${path}" content already matches what you submitted -- nothing was committed.`;
          }
          return `Wrote ${result.path} (commit ${result.commitSha.slice(0, 7)}, new sha ${result.sha}).`;
        } catch (err) {
          // Conflict/policy errors are a normal, expected outcome the
          // model should react to (re-read, adjust, retry) -- returning
          // the message as a regular string result (rather than throwing)
          // is what lets the loop's existing error-string convention carry
          // it back to the model as a next-turn input, same as any other
          // tool result. Note: a rejected write (policy or conflict) does
          // NOT count against the write caps above -- nothing was actually
          // committed, so charging the cap for it would penalize the model
          // for correctly discovering a boundary.
          return `Error: ${err.message}`;
        }
      },
    },
  ];

  const declarations = [{
    functionDeclarations: FUNCTIONS.map(({ name, description, parameters }) => ({ name, description, parameters })),
  }];

  return { FUNCTIONS, declarations };
}

// Runs the write-capable general-editor agent loop. Returns
// { answer, steps, transcript, runId, writtenFiles, task, failed? } -- same
// overall shape as designer_delegate.js's runDesignAgent / delegate_agent's
// runInvestigation, so the eventual MCP-facing tool (step 7) can follow the
// same resume_run_id/failed-response conventions those already use.
//
// On a fresh call, owner/repo/branch/task are required; on a resume
// (resume_run_id set), they're restored from the checkpoint and any passed
// values are ignored -- same resume contract as designer_delegate.js (see
// its comments for why `task` specifically must never be trusted over the
// checkpoint's own record of it on a live resume).
export async function runEditorAgent({ owner, repo, branch, task, max_steps = EDITOR_DEFAULT_STEPS, resume_run_id }) {
  const cappedSteps = Math.min(max_steps, EDITOR_HARD_MAX_STEPS);

  let runId = resume_run_id;
  let contents;
  let transcript;
  let startStep;
  let writtenFiles;
  let writesPerFile;
  let effectiveOwner = owner;
  let effectiveRepo = repo;
  let effectiveBranch = branch;
  let effectiveTask = task;
  // Stuck-loop detection -- same shape as designer_delegate.js's copy of
  // connectors/gemini/agent_delegate.js's fix #4. See that file's comments
  // for the full reasoning; unchanged here.
  let repeatCounts = new Map();
  let resultCache = new Map();
  let consecutiveAllRepeatSteps = 0;

  const checkpoint = resume_run_id ? await loadCheckpoint(resume_run_id) : null;

  if (checkpoint) {
    contents = checkpoint.contents;
    transcript = checkpoint.transcript;
    startStep = checkpoint.stepsDone + 1;
    writtenFiles = checkpoint.writtenFiles || [];
    writesPerFile = new Map(Object.entries(checkpoint.writesPerFile || {}));
    effectiveOwner = checkpoint.owner;
    effectiveRepo = checkpoint.repo;
    effectiveBranch = checkpoint.branch;
    effectiveTask = checkpoint.task;
    repeatCounts = new Map(Object.entries(checkpoint.repeatCounts || {}));
    consecutiveAllRepeatSteps = checkpoint.consecutiveAllRepeatSteps || 0;
  } else if (resume_run_id) {
    // Same "fail loudly and distinctly" reasoning as designer_delegate.js --
    // this loop has no task-optional fallback path either, so there's no
    // ambiguous case to accommodate: always an error.
    throw new Error(
      isRedisConfigured()
        ? `resume_run_id "${resume_run_id}" has no live checkpoint -- it may have expired (1 hour TTL) or the id may be wrong. Start a new run with owner/repo/branch/task instead.`
        : `resume_run_id "${resume_run_id}" has no live checkpoint -- and Redis is NOT configured in this environment, so no checkpoint could ever have been saved. Start a new run with owner/repo/branch/task instead.`
    );
  } else {
    if (!owner || !repo || !branch || !task) {
      throw new Error("owner, repo, branch, and task are all required on a fresh call (not resuming).");
    }

    // Guardrail #2, checked once up front, before the loop starts --
    // reuses editor_tool_functions.js's own live lookup rather than
    // duplicating it.
    await assertNotDefaultBranch(owner, repo, branch);

    runId = randomUUID();
    contents = [{ role: "user", parts: [{ text: buildSystemPreamble({ owner, repo, branch, task }) }] }];
    transcript = [];
    startStep = 1;
    writtenFiles = [];
    writesPerFile = new Map();
  }

  const { FUNCTIONS, declarations } = buildFunctions({
    owner: effectiveOwner, repo: effectiveRepo, branch: effectiveBranch, writtenFiles, writesPerFile,
  });

  if (checkpoint && startStep > cappedSteps) {
    return {
      answer: `(This run already completed ${startStep - 1} step(s), which meets or exceeds the requested max_steps of ${cappedSteps} -- no new steps were taken this call. The checkpoint has NOT been discarded. Call again with resume_run_id: "${runId}" and a higher max_steps to continue.)`,
      steps: startStep - 1,
      transcript,
      runId,
      task: effectiveTask,
      writtenFiles,
      failed: true,
    };
  }

  const saveState = (stepsDone) => saveCheckpoint(runId, {
    contents,
    transcript,
    stepsDone,
    task: effectiveTask,
    owner: effectiveOwner,
    repo: effectiveRepo,
    branch: effectiveBranch,
    writtenFiles,
    writesPerFile: Object.fromEntries(writesPerFile),
    repeatCounts: Object.fromEntries(repeatCounts),
    consecutiveAllRepeatSteps,
  });

  for (let step = startStep; step <= cappedSteps; step++) {
    // Withhold tools on the final step, same reasoning/mechanism as
    // designer_delegate.js: structurally forces a plain-text answer
    // instead of an unexecuted function call.
    const isFinalStep = step === cappedSteps;
    const stuckLoopForce = consecutiveAllRepeatSteps >= 3;
    const withholdTools = isFinalStep || stuckLoopForce;

    let candidate;
    try {
      candidate = await providerChat(contents, { tools: withholdTools ? undefined : declarations });
    } catch (err) {
      await saveState(step - 1);
      const redisOk = isRedisConfigured();
      const resumeHint = isTransientGeminiError(err)
        ? (redisOk
            ? ` ${transcript.length} tool call(s) already completed this run are saved. Call again with resume_run_id: "${runId}" to continue instead of starting over. Checkpoint expires in 1 hour.`
            : ` ${transcript.length} tool call(s) were completed this run, but Redis is NOT configured, so nothing was actually saved -- resume_run_id: "${runId}" will NOT work. Re-run from scratch with the full task text.`)
        : ` This does not look like a transient error (not a 429/503) -- resuming will likely reproduce the same failure. Check the underlying cause before retrying.`;
      return {
        answer: `(Gemini call failed on step ${step}: ${err?.message ?? String(err)} --${resumeHint})`,
        steps: step - 1,
        transcript,
        runId,
        task: effectiveTask,
        writtenFiles,
        failed: true,
      };
    }

    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (withholdTools && functionCalls.length) {
      await saveState(step - 1);
      const reason = stuckLoopForce
        ? `the agent appeared stuck repeating the same call(s) for ${consecutiveAllRepeatSteps} consecutive steps, so tools were withheld to force a plain-text answer instead of continuing to loop`
        : `the model attempted a function call on the final step, where no tools are available`;
      return {
        answer: `(Run stopped after reaching the step cap of ${cappedSteps}: ${reason}, so it was discarded rather than executed -- the task may need to be narrowed, or more steps requested up to the hard cap of ${EDITOR_HARD_MAX_STEPS}. ${transcript.length} tool call(s) already completed this run are saved. Call again with resume_run_id: "${runId}" to continue instead of starting over. Checkpoint expires in 1 hour.)`,
        steps: step - 1,
        transcript,
        runId,
        task: effectiveTask,
        writtenFiles,
        failed: true,
      };
    }

    if (!functionCalls.length) {
      const answer = parts.map((p) => p.text || "").join("").trim();
      if (!answer) {
        await saveState(step - 1);
        const starvationNote = withholdTools && candidate.finishReason === "MALFORMED_FUNCTION_CALL"
          ? (stuckLoopForce
              ? ` Tools were withheld this step because the agent appeared stuck repeating the same call(s) for ${consecutiveAllRepeatSteps} consecutive steps, but the model attempted a function call anyway, which Gemini rejects as malformed when no tools are available.`
              : ` This was the final allowed step, which never includes tools -- but the model attempted a function call anyway, which Gemini rejects as malformed when no tools are available. This usually means the task needed more steps than max_steps (${cappedSteps}) allowed. Retry with a higher max_steps.`)
          : "";
        return {
          answer: `(Gemini stopped without a final answer -- finishReason: ${candidate.finishReason || "unknown"})${starvationNote} ${transcript.length} tool call(s) already completed this run are saved. Call again with resume_run_id: "${runId}" to continue instead of starting over. Checkpoint expires in 1 hour.`,
          steps: step - 1,
          transcript,
          runId,
          task: effectiveTask,
          writtenFiles,
          failed: true,
        };
      }
      await deleteCheckpoint(runId);
      return { answer, steps: step, transcript, runId, task: effectiveTask, writtenFiles };
    }

    contents.push({ role: "model", parts });

    let responseParts;
    try {
      // Parallelized for the same reason as designer_delegate.js: every
      // call batched into one model turn was decided without seeing any
      // of the others' results. write_file is NEVER cache-served (has a
      // real side effect -- a commit); read_file is safe to cache-serve on
      // an exact repeat, same distinction designer_delegate.js draws.
      const CACHEABLE_TOOLS = new Set(["read_file"]);

      const results = await Promise.all(functionCalls.map(async (part) => {
        const { name, args, id } = part.functionCall;
        const signature = `${name}:${JSON.stringify(args || {})}`;
        const priorCount = repeatCounts.get(signature) || 0;
        const isRepeat = priorCount > 0;
        repeatCounts.set(signature, priorCount + 1);

        const fn = FUNCTIONS.find((f) => f.name === name);
        let resultText;
        let servedFromCache = false;
        if (isRepeat && CACHEABLE_TOOLS.has(name) && resultCache.has(signature)) {
          resultText = resultCache.get(signature);
          servedFromCache = true;
        } else if (!fn) {
          resultText = `Error: unknown function "${name}".`;
        } else {
          try {
            resultText = await fn.execute(args || {});
          } catch (err) {
            resultText = `Error: ${err?.message ?? String(err)}`;
          }
        }
        if (typeof resultText !== "string") {
          resultText = `Error: ${name} returned a non-string result (${typeof resultText}); this is a bug in its execute().`;
        }
        if (!servedFromCache && CACHEABLE_TOOLS.has(name)) {
          resultCache.set(signature, resultText);
        }
        return { name, args, id, resultText, isRepeat, servedFromCache };
      }));

      // Invalidate any cached read_file result for a path this step just
      // wrote to successfully -- same reasoning as designer_delegate.js:
      // without this, a confirming re-read right after a write would be
      // served stale pre-write content.
      for (const r of results) {
        if (r.name === "write_file" && !r.resultText.startsWith("Error:") && r.args?.path) {
          const readSignature = `read_file:${JSON.stringify({ path: r.args.path })}`;
          resultCache.delete(readSignature);
          repeatCounts.delete(readSignature);
        }
      }

      const allRepeatsThisStep = results.length > 0 && results.every((r) => r.isRepeat);
      consecutiveAllRepeatSteps = allRepeatsThisStep ? consecutiveAllRepeatSteps + 1 : 0;

      responseParts = results.map((r) => {
        const cacheNote = r.servedFromCache ? " [served from cache -- identical call already made this run]" : "";
        transcript.push(`[step ${step}] ${r.name}(${JSON.stringify(r.args || {})})${cacheNote} -> ${r.resultText.length > 300 ? r.resultText.slice(0, 300) + "…" : r.resultText}`);
        return { functionResponse: { name: r.name, id: r.id, response: { result: r.resultText } } };
      });
    } catch (err) {
      await saveState(step - 1);
      return {
        answer: `(Unexpected error while processing step ${step}'s function calls: ${err?.message ?? String(err)} -- ${transcript.length} tool call(s) already completed this run are saved. Call again with resume_run_id: "${runId}" to continue.)`,
        steps: step - 1,
        transcript,
        runId,
        task: effectiveTask,
        writtenFiles,
        failed: true,
      };
    }

    if (consecutiveAllRepeatSteps === 2) {
      responseParts.push({
        text: "[SYSTEM NOTE: the last 2 steps consisted entirely of calls identical to ones already made this run. One more step like that and tools will be withheld to force a plain-text answer instead. If you're re-reading to double-check, that's fine once -- but if you're retrying the same write and getting the same result, stop and explain what's blocking it instead of repeating the call.]",
      });
    }

    const remainingAfterThisStep = cappedSteps - step;
    if (remainingAfterThisStep === 1) {
      responseParts.push({
        text: "[SYSTEM NOTE: only 1 step remains after this one, and the step after that has NO tools available. Finish any in-progress write now if the file is ready, or explain what's left undone -- do not leave a task half-written without saying so.]",
      });
    } else if (remainingAfterThisStep === 0) {
      responseParts.push({
        text: "[SYSTEM NOTE: the next turn will NOT include any tools -- you must answer now in plain text summarizing what you changed (or didn't, and why) rather than attempting another function call.]",
      });
    }

    contents.push({ role: "user", parts: responseParts });
    await saveState(step);
  }

  // Defensive fallback only -- see designer_delegate.js's identical comment
  // for why this should no longer be reachable in normal operation.
  return {
    answer: `(Run stopped after reaching the step cap of ${cappedSteps} without a final answer -- the task may need to be narrowed, or more steps requested up to the hard cap of ${EDITOR_HARD_MAX_STEPS}. ${transcript.length} tool call(s) already completed this run are saved. Call again with resume_run_id: "${runId}" to continue instead of starting over. Checkpoint expires in 1 hour.)`,
    steps: cappedSteps,
    transcript,
    runId,
    task: effectiveTask,
    writtenFiles,
    failed: true,
  };
}
