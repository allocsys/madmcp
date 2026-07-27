// ---------------------------------------------------------------------------
// connectors/frontend/tools.js — delegate_designer
//
// STATELESS, single-call codegen -- NOT an agentic loop like delegate_gemini.
// Given a task (+ optionally an existing file to improve), sends a prompt to
// whichever LLM FRONTEND_PROVIDER points at (see client.js), then writes the
// result straight to the repo. The generated code is NEVER returned to the
// calling model in full -- only a short summary (line-count delta, provider
// used) -- so calling this tool costs roughly constant context regardless of
// how large the generated file is. Same token-saving rationale as
// delegate_research's precision mode: read server-side, generate
// server-side, return a compact answer only (see connectors/gemini/tools.js
// file header for the fuller version of this argument).
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

import { z } from "zod";
import { frontendGenerate, currentProvider } from "./client.js";
import { githubRequest, toBase64 } from "../github/client.js";
import { readFileViaBlob } from "../github/helpers.js";
import { DEFAULT_OWNER, FRONTEND_ALLOWED_EXTENSIONS } from "../../config.js";

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

export function register(server) {
  server.tool(
    "delegate_designer",
    "RULE for the calling model: prefer this tool over writing or editing HTML/CSS/SCSS/JSX/TSX/Vue by hand yourself " +
    "-- even for something you could technically write directly. It delegates to a model configured specifically for " +
    "design/frontend output (FRONTEND_PROVIDER in config.js, flip providers there without touching this tool) " +
    "rather than relying on your own HTML/CSS/layout judgment. Use it for things like \"build a pricing page\", " +
    "\"restyle the nav bar\", \"make this component responsive\", \"clean up this CSS\", \"turn this mockup " +
    "description into markup\" -- both brand-new files and edits to existing ones.\n\n" +
    "WRITE TOOL, STATELESS single-shot call -- not an investigation loop like delegate_gemini: give it a task and " +
    "optionally an existing file to improve; it reads that file server-side, generates new content, and writes it " +
    "straight to the repo in the same call. The generated code is NEVER returned to you in full, only a short " +
    "summary (line-count delta, provider used) -- so calling this costs you roughly no context regardless of file " +
    "size, unlike manually reading a file, pasting it into a prompt, and writing the result back yourself.\n\n" +
    "PREREQUISITE: requires an existing branch that is NOT the repo's default branch -- if you don't already have " +
    "one for this work, call create_branch first, then pass its name here.\n\n" +
    "SCOPE: fenced to frontend file extensions only (" + FRONTEND_ALLOWED_EXTENSIONS.join(", ") + ") on BOTH the " +
    "file it reads as context and the file it writes -- it will refuse to touch anything else (e.g. config.js, " +
    "package.json, workflow files). It will also refuse to write to the repo's default branch. No delete capability.",
    {
      owner:      z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:       z.string().describe("Repository name"),
      branch:     z.string().describe("Branch to write to. MUST NOT be the repo's default branch -- this tool refuses to write there."),
      task:       z.string().describe("What to build or change, described with enough detail (layout, components, styling intent) for the model to act without asking anything back -- it can't."),
      path:       z.string().optional().describe("Existing file to read as context/starting point (must be one of: " + FRONTEND_ALLOWED_EXTENSIONS.join(", ") + "). Omit to generate a brand-new file from scratch."),
      write_path: z.string().optional().describe("Where to write the result (must be one of: " + FRONTEND_ALLOWED_EXTENSIONS.join(", ") + "). Defaults to `path` (overwrite in place) if omitted -- at least one of path/write_path must be given."),
      message:    z.string().optional().describe("Commit message (default: auto-generated from the task)."),
    },
    async ({ owner = DEFAULT_OWNER, repo, branch, task, path, write_path, message }) => {
      const targetPath = write_path || path;
      if (!targetPath) {
        return { content: [{ type: "text", text: "Missing argument: at least one of `path` or `write_path` must be given so the tool knows where to write the result." }], isError: true };
      }
      if (!branch) {
        return { content: [{ type: "text", text: "Missing argument: `branch` is required (and must not be the repo's default branch)." }], isError: true };
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
          contextNote = ` (note: "${path}" was not found on "${branch}" -- generated fresh content instead of an edit)`;
        }
      }

      const prompt = context
        ? `You are a frontend/UI expert. Improve or modify the following file according to the task. Return ONLY the complete new file content -- no explanation, no markdown code fences.\n\nTask: ${task}\n\nCurrent content of ${path}:\n${context}`
        : `You are a frontend/UI expert. Generate a complete new file for the task below. Return ONLY the file content -- no explanation, no markdown code fences.\n\nTask: ${task}\n\nTarget file: ${targetPath}`;

      let generated;
      try {
        generated = await frontendGenerate(prompt);
      } catch (err) {
        return { content: [{ type: "text", text: `Generation failed (provider: ${currentProvider()}): ${err.message}` }], isError: true };
      }

      // Defensive strip in case the model wraps output in a fenced code
      // block despite being asked not to -- common LLM habit regardless of
      // provider.
      const fenceMatch = /^```[a-z0-9]*\n([\s\S]*?)\n```$/i.exec(generated.trim());
      const cleaned = fenceMatch ? fenceMatch[1] : generated;

      let sha;
      try {
        const existing = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(targetPath)}?ref=${encodeURIComponent(branch)}`);
        sha = existing.sha;
      } catch { /* new file on this branch */ }

      let commitResult;
      try {
        commitResult = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(targetPath)}`, {
          method: "PUT",
          body: {
            message: message || `${sha ? "Update" : "Create"} ${targetPath} via delegate_designer: ${task.slice(0, 72)}`,
            content: toBase64(cleaned),
            branch,
            sha,
          },
        });
      } catch (err) {
        return { content: [{ type: "text", text: `Generated content successfully but failed to write it to ${targetPath}@${branch}: ${err.message}` }], isError: true };
      }

      const { before, after, delta } = lineCountDelta(context, cleaned);
      const summary =
        `${sha ? "Updated" : "Created"} ${targetPath} on ${owner}/${repo}@${branch} ` +
        `(commit ${commitResult.commit.sha.slice(0, 7)}, provider: ${currentProvider()}).\n` +
        `${before} \u2192 ${after} lines (${delta >= 0 ? "+" : ""}${delta}).${contextNote}`;

      return { content: [{ type: "text", text: summary }] };
    }
  );
}
