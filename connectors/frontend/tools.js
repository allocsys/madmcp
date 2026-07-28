// ---------------------------------------------------------------------------
// connectors/frontend/tools.js — delegate_designer
//
// Bounded generate -> validate -> fix loop (NOT an open-ended investigation
// loop like delegate_gemini's function-calling agent). Given a task (+
// optionally an existing file to improve), sends a prompt to whichever LLM
// FRONTEND_PROVIDER points at (see client.js), syntax-validates the result
// (see validate.js), and -- if invalid -- feeds the specific errors back to
// the LLM for a fix-up turn, up to FRONTEND_MAX_ATTEMPTS times. Only then
// does it write to the repo. The generated code is NEVER returned to the
// calling model in full, only a short summary (line-count delta, attempts
// used, provider) -- so calling this costs roughly constant context
// regardless of file size or how many fix-up rounds it took.
//
// RESUMABILITY: a 3-attempt loop is 3 sequential LLM calls, which can
// plausibly exceed a hosting platform's own request-duration ceiling (the
// same constraint documented on delegate_gemini's HARD_MAX_STEPS -- see
// connectors/gemini/delegate.js) even though no single attempt does. Before
// starting each attempt, elapsed time is checked against
// FRONTEND_TOTAL_BUDGET_MS; if exceeded, progress is checkpointed to Redis
// (connectors/frontend/checkpoint.js) and a `resume_run_id` is returned for
// the caller to continue with on a follow-up call, instead of the loop
// dying silently at the platform's own timeout.
//
// SCOPE FENCING (deliberate, not incidental):
//  - READ: `path` (context file) must match FRONTEND_ALLOWED_EXTENSIONS.
//    This is the more important of the two fences -- without it, a bad or
//    manipulated task could point this tool at config.js or other
//    secret-adjacent files and have their contents shipped to a
//    THIRD-PARTY LLM API as prompt text. There is no arbitrary-path
//    fallback the way delegate_gemini's github_read_file has.
//  - WRITE: `write_path` must ALSO match FRONTEND_ALLOWED_EXTENSIONS, so a
//    bad generation can't land on server.js/package.json/workflows/etc --
//    files this tool has no legitimate reason to touch.
//  - BRANCH: writes are refused if `branch` resolves to the repo's default
//    branch. Nothing generated here can land on main directly -- same
//    "structurally unreachable, not just discouraged" principle as
//    GEMINI_NOTION_ROOT_PAGE_ID's write isolation in the Gemini connector.
//  - No delete capability at all (create/overwrite only).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { frontendGenerate, currentProvider } from "./client.js";
import { validateByExtension } from "./validate.js";
import { saveCheckpoint, loadCheckpoint, deleteCheckpoint } from "./checkpoint.js";
import { isRedisConfigured } from "../gemini/cooldown.js";
import { githubRequest, toBase64 } from "../github/client.js";
import { readFileViaBlob } from "../github/helpers.js";
import { DEFAULT_OWNER, FRONTEND_ALLOWED_EXTENSIONS, FRONTEND_MAX_ATTEMPTS, FRONTEND_TOTAL_BUDGET_MS } from "../../config.js";

function extensionOf(path) {
  const match = /\.[a-z0-9]+$/i.exec(path);
  return match ? match[0].toLowerCase() : "";
}

function assertAllowedExtension(path, label) {
  const ext = extensionOf(path);
  if (!FRONTEND_ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `${label} "${path}" has extension "${ext || "(none)"}", which is not in the allowed frontend extensions ` +
      `(${FRONTEND_ALLOWED_EXTENSIONS.join(", ")}). This tool is fenced to frontend files only -- both to keep ` +
      `non-frontend source out of a third-party LLM call, and to keep its writes off files it has no business touching.`
    );
  }
}

// Cheap line-count delta for the summary -- NOT a full diff. This tool never
// shows the caller the generated content, so a real diff would just be more
// text to burn tokens on for no benefit; "this got bigger/smaller/about the
// same" is enough signal for the calling model to relay back to the user.
function lineCountDelta(before, after) {
  const b = before ? before.split("\n").length : 0;
  const a = after.split("\n").length;
  return { before: b, after: a, delta: a - b };
}

// Defensive strip in case the model wraps output in a fenced code block
// despite being asked not to -- common LLM habit regardless of provider.
function stripFence(text) {
  const fenceMatch = /^```[a-z0-9]*\n([\s\S]*?)\n```$/i.exec(text.trim());
  return fenceMatch ? fenceMatch[1] : text;
}

function buildPrompt({ task, path, writePath, context, previousAttempt, previousErrors }) {
  if (previousAttempt) {
    return (
      `You are a frontend/UI expert. Your PREVIOUS attempt at the task below had syntax errors. ` +
      `Fix them and return the COMPLETE corrected file content -- no explanation, no markdown code fences.\n\n` +
      `Task: ${task}\n\n` +
      `Target file: ${writePath}\n\n` +
      `Your previous attempt:\n${previousAttempt}\n\n` +
      `Errors found in that attempt:\n${previousErrors.map((e) => `- ${e}`).join("\n")}`
    );
  }
  return context
    ? `You are a frontend/UI expert. Improve or modify the following file according to the task. Return ONLY the complete new file content -- no explanation, no markdown code fences.\n\nTask: ${task}\n\nCurrent content of ${path}:\n${context}`
    : `You are a frontend/UI expert. Generate a complete new file for the task below. Return ONLY the file content -- no explanation, no markdown code fences.\n\nTask: ${task}\n\nTarget file: ${writePath}`;
}

export function register(server) {
  server.tool(
    "delegate_designer",
    "RULE for the calling model: prefer this tool over writing or editing HTML/CSS/SCSS/JSX/TSX/Vue by hand yourself " +
    "-- even for something you could technically write directly. It delegates to a model configured specifically for " +
    "design/frontend output (FRONTEND_PROVIDER in config.js, flip providers there without touching this tool) " +
    "rather than relying on your own HTML/CSS/layout judgment. Use it for things like \"build a pricing page\", " +
    "\"restyle the nav bar\", \"make this component responsive\", \"clean up this CSS\", \"turn this mockup " +
    "description into markup\" -- both brand-new files and edits to existing ones.\n\n" +
    "WRITE TOOL with a bounded self-correction loop (up to " + FRONTEND_MAX_ATTEMPTS + " attempts) -- give it a task " +
    "and optionally an existing file to improve; it reads that file server-side, generates content, syntax-checks it, " +
    "and re-prompts the LLM with the specific errors if invalid, before writing the result straight to the repo in " +
    "the same call. If a run can't finish inside its time budget, it checkpoints progress and returns a " +
    "resume_run_id -- pass that back on a follow-up call (with no other arguments needed) to continue instead of " +
    "starting over. The generated code is NEVER returned to you in full, only a short summary (line-count delta, " +
    "attempts used, provider) -- so calling this costs you roughly no context regardless of file size.\n\n" +
    "PREREQUISITE: requires an existing branch that is NOT the repo's default branch -- if you don't already have " +
    "one for this work, call create_branch first, then pass its name here.\n\n" +
    "SCOPE: fenced to frontend file extensions only (" + FRONTEND_ALLOWED_EXTENSIONS.join(", ") + ") on BOTH the " +
    "file it reads as context and the file it writes -- it will refuse to touch anything else (e.g. config.js, " +
    "package.json, workflow files). It will also refuse to write to the repo's default branch. No delete capability.",
    {
      owner:          z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:           z.string().optional().describe("Repository name. Not needed when resuming (resume_run_id carries it)."),
      branch:         z.string().optional().describe("Branch to write to. MUST NOT be the repo's default branch. Not needed when resuming."),
      task:           z.string().optional().describe("What to build or change, described with enough detail (layout, components, styling intent) for the model to act without asking anything back -- it can't. Not needed when resuming."),
      path:           z.string().optional().describe("Existing file to read as context/starting point (must be one of: " + FRONTEND_ALLOWED_EXTENSIONS.join(", ") + "). Omit to generate a brand-new file from scratch."),
      write_path:     z.string().optional().describe("Where to write the result (must be one of: " + FRONTEND_ALLOWED_EXTENSIONS.join(", ") + "). Defaults to `path` (overwrite in place) if omitted -- at least one of path/write_path must be given on a fresh call."),
      message:        z.string().optional().describe("Commit message (default: auto-generated from the task)."),
      resume_run_id:  z.string().optional().describe("Continue a previous call that returned a resume_run_id because it ran out of time budget. When set, all other arguments are ignored -- the original task/branch/paths are restored from the checkpoint."),
    },
    async ({ owner = DEFAULT_OWNER, repo, branch, task, path, write_path, message, resume_run_id }) => {
      const startTime = Date.now();
      let state;

      if (resume_run_id) {
        const checkpoint = await loadCheckpoint(resume_run_id);
        if (!checkpoint) {
          return {
            content: [{ type: "text", text:
              isRedisConfigured()
                ? `resume_run_id "${resume_run_id}" has no live checkpoint -- it may have expired (1 hour TTL) or the id may be wrong. Start a new call with task/repo/branch instead.`
                : `resume_run_id "${resume_run_id}" has no live checkpoint -- and Redis is NOT configured in this environment, so no checkpoint could ever have been saved. Start a new call with task/repo/branch instead.`
            }],
            isError: true,
          };
        }
        state = checkpoint;
      } else {
        const targetPath = write_path || path;
        if (!targetPath) {
          return { content: [{ type: "text", text: "Missing argument: at least one of `path` or `write_path` must be given so the tool knows where to write the result." }], isError: true };
        }
        if (!repo) {
          return { content: [{ type: "text", text: "Missing argument: `repo` is required on a fresh call." }], isError: true };
        }
        if (!branch) {
          return { content: [{ type: "text", text: "Missing argument: `branch` is required (and must not be the repo's default branch)." }], isError: true };
        }
        if (!task) {
          return { content: [{ type: "text", text: "Missing argument: `task` is required on a fresh call." }], isError: true };
        }

        try {
          assertAllowedExtension(targetPath, "write_path");
          if (path) assertAllowedExtension(path, "path");
        } catch (err) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }

        let repoInfo;
        try {
          repoInfo = await githubRequest(`/repos/${owner}/${repo}`);
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to look up ${owner}/${repo}: ${err.message}` }], isError: true };
        }
        if (branch === repoInfo.default_branch) {
          return {
            content: [{ type: "text", text: `Refusing to write: "${branch}" is ${owner}/${repo}'s default branch. Create/use a feature branch instead -- this tool never writes directly to the default branch.` }],
            isError: true,
          };
        }

        let context = "";
        let contextNote = "";
        if (path) {
          try {
            context = await readFileViaBlob(owner, repo, path, branch);
          } catch {
            contextNote = ` (note: "${path}" was not found on "${branch}" -- generating fresh content instead of an edit)`;
          }
        }

        state = {
          runId: randomUUID(),
          owner, repo, branch, task, path, writePath: targetPath, message, context, contextNote,
          attempts: [], // [{ content, valid, errors }]
        };
      }

      // -- generate -> validate -> fix loop -------------------------------
      let lastGenerated = state.attempts.length ? state.attempts[state.attempts.length - 1].content : null;
      let lastErrors    = state.attempts.length ? state.attempts[state.attempts.length - 1].errors  : null;
      let lastValid     = state.attempts.length ? state.attempts[state.attempts.length - 1].valid   : false;

      while (state.attempts.length < FRONTEND_MAX_ATTEMPTS && !lastValid) {
        if (Date.now() - startTime > FRONTEND_TOTAL_BUDGET_MS) {
          await saveCheckpoint(state.runId, state);
          return {
            content: [{ type: "text", text:
              `Still working (${state.attempts.length}/${FRONTEND_MAX_ATTEMPTS} attempt(s) done, not yet valid) -- ran out of time budget for this call. ` +
              `Progress is saved. Call delegate_designer again with resume_run_id: "${state.runId}" (no other arguments needed) to continue.`
            }],
          };
        }

        const prompt = buildPrompt({
          task: state.task, path: state.path, writePath: state.writePath, context: state.context,
          previousAttempt: lastGenerated, previousErrors: lastErrors,
        });

        let generated;
        try {
          generated = await frontendGenerate(prompt);
        } catch (err) {
          await saveCheckpoint(state.runId, state);
          return {
            content: [{ type: "text", text:
              `Generation failed on attempt ${state.attempts.length + 1} (provider: ${currentProvider()}): ${err.message}. ` +
              `${state.attempts.length} prior attempt(s) are saved. Call delegate_designer again with resume_run_id: "${state.runId}" to retry.`
            }],
            isError: true,
          };
        }

        const cleaned = stripFence(generated);
        const result = await validateByExtension(state.writePath, cleaned);

        state.attempts.push({ content: cleaned, valid: result.valid, errors: result.errors });
        lastGenerated = cleaned;
        lastErrors = result.errors;
        lastValid = result.valid;
      }

      // -- write best attempt (valid, or last attempt if the loop capped out) --
      const finalAttempt = state.attempts[state.attempts.length - 1];
      const unresolvedNote = finalAttempt.valid
        ? ""
        : ` [WARNING: did not pass syntax validation after ${state.attempts.length} attempt(s) -- writing best attempt anyway. Remaining issues: ${finalAttempt.errors.join("; ")}]`;

      let sha;
      try {
        const existing = await githubRequest(`/repos/${state.owner}/${state.repo}/contents/${encodeURIComponent(state.writePath)}?ref=${encodeURIComponent(state.branch)}`);
        sha = existing.sha;
      } catch { /* new file on this branch */ }

      let commitResult;
      try {
        commitResult = await githubRequest(`/repos/${state.owner}/${state.repo}/contents/${encodeURIComponent(state.writePath)}`, {
          method: "PUT",
          body: {
            message: state.message || `${sha ? "Update" : "Create"} ${state.writePath} via delegate_designer: ${state.task.slice(0, 72)}`,
            content: toBase64(finalAttempt.content),
            branch: state.branch,
            sha,
          },
        });
      } catch (err) {
        await saveCheckpoint(state.runId, state);
        return {
          content: [{ type: "text", text: `Generated content successfully but failed to write it to ${state.writePath}@${state.branch}: ${err.message}. Call delegate_designer again with resume_run_id: "${state.runId}" to retry the write.` }],
          isError: true,
        };
      }

      await deleteCheckpoint(state.runId);

      const { before, after, delta } = lineCountDelta(state.context, finalAttempt.content);
      const summary =
        `${sha ? "Updated" : "Created"} ${state.writePath} on ${state.owner}/${state.repo}@${state.branch} ` +
        `(commit ${commitResult.commit.sha.slice(0, 7)}, provider: ${currentProvider()}, ${state.attempts.length}/${FRONTEND_MAX_ATTEMPTS} attempt(s)).\n` +
        `${before} \u2192 ${after} lines (${delta >= 0 ? "+" : ""}${delta}).${state.contextNote || ""}${unresolvedNote}`;

      return { content: [{ type: "text", text: summary }] };
    }
  );
}
