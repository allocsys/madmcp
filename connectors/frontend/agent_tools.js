// ---------------------------------------------------------------------------
// connectors/frontend/agent_tools.js — read/write/validate primitives for
// delegate_designer v2 (issue #61, Notion "madmcp-delegate-designer-v2-plan"
// design doc). Step 1 of the implementation sequence: "Tools layer" only --
// these are plain async functions, NOT yet wired up as the agent's
// tool-calling loop (that's step 2, adapting connectors/gemini/delegate.js's
// runInvestigation pattern). Kept separate from tools.js (the current v1
// generate->validate->fix loop) so v1 keeps working unmodified while v2 is
// built alongside it; tools.js gets retired in step 5 (rollout).
//
// FIXES #59 (stale-context race): v1's write path re-fetched the current
// blob sha immediately before the PUT, so a write could silently clobber a
// concurrent change as long as ITS sha matched at PUT time -- the sha used
// for the write was never tied to the sha the content was actually read
// from. Here, read_file returns { content, sha } together, and write_file
// requires that exact sha back as base_sha, sending it as the PUT's `sha`
// field. If the file changed on the branch in between, GitHub's Contents
// API rejects the PUT with 409 (sha mismatch) instead of silently
// overwriting -- surfaced here as a normal Error with `.conflict = true` so
// the step-2 agent loop can catch it, re-read, and retry rather than the
// call hard-failing.
//
// SCOPE FENCING: same as tools.js -- read and write paths are both
// restricted to FRONTEND_ALLOWED_EXTENSIONS. Enforced here, at the tool
// layer, not left to the agent's own judgment (per issue #61: "enforced at
// the tool layer, not just prompt instructions").
// ---------------------------------------------------------------------------

import { githubRequest, toBase64, fromBase64 } from "../github/client.js";
import { FRONTEND_ALLOWED_EXTENSIONS } from "../../config.js";
import { validateByExtension } from "./validate.js";

function extensionOf(path) {
  const match = /\.[a-z0-9]+$/i.exec(path);
  return match ? match[0].toLowerCase() : "";
}

function assertAllowedExtension(path, label) {
  const ext = extensionOf(path);
  if (!FRONTEND_ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `${label} "${path}" has extension "${ext || "(none)"}", which is not in the allowed frontend extensions ` +
      `(${FRONTEND_ALLOWED_EXTENSIONS.join(", ")}). This tool is fenced to frontend files only.`
    );
  }
}

function isConflictError(err) {
  return /GitHub API error \(409\)/.test(err.message) || /sha (does not match|was not supplied)/i.test(err.message);
}

// -- read_file ---------------------------------------------------------
// Real on-demand read (unlike v1's single static context dump at task
// start). Returns the blob sha alongside the content so a later write_file
// call can tie its write back to exactly what was read here.
export async function readFile(owner, repo, path, ref) {
  assertAllowedExtension(path, "path");

  const data = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`
  );

  if (Array.isArray(data)) {
    throw new Error(`"${path}" is a directory, not a file.`);
  }
  if (typeof data.content !== "string") {
    throw new Error(`"${path}" has no inline content in GitHub's response (file may be over the Contents API's ~1MB inline limit). Not supported by this tool.`);
  }

  return {
    path,
    content: fromBase64(data.content.replace(/\n/g, "")),
    sha: data.sha,
  };
}

// -- patch application ---------------------------------------------------
// Sequential find/replace operations, same semantics as edit_file's
// `replacements` mode in connectors/github/files.js (kept consistent
// deliberately -- no new patch-format dependency introduced for this).
// Each `find` must appear EXACTLY ONCE in the content being patched, or the
// whole patch is rejected before anything is written.
export function applyPatch(content, patch) {
  let updated = content;
  const errors = [];
  for (const { find, replace } of patch) {
    const count = updated.split(find).length - 1;
    if (count === 0) { errors.push(`String not found: ${JSON.stringify(find)}`); continue; }
    if (count > 1)   { errors.push(`String found ${count} times (must be unique): ${JSON.stringify(find)}`); continue; }
    updated = updated.replace(find, replace);
  }
  if (errors.length) {
    throw new Error(`Patch rejected -- fix these issues before retrying:\n${errors.join("\n")}`);
  }
  return updated;
}

// -- write_file ----------------------------------------------------------
// Unified write tool: exactly one of `content` (full overwrite) or `patch`
// (find/replace operations, applied against the exact blob identified by
// base_sha) must be given.
//
// base_sha is required whenever `patch` is used (there is no content to
// patch against without it). For `content` mode, base_sha is optional:
// omitted means "create a new file" (no sha sent on the PUT); provided
// means "this is meant to replace the exact version read earlier" and is
// sent as-is so GitHub 409s on a stale/mismatched sha instead of silently
// overwriting a concurrent change (fixes #59).
export async function writeFile(owner, repo, path, { content, patch, baseSha, branch, message } = {}) {
  if ((content === undefined) === (patch === undefined)) {
    throw new Error("Provide exactly one of `content` (full overwrite) or `patch` (find/replace operations).");
  }
  if (patch && !baseSha) {
    throw new Error("base_sha is required when using `patch` -- read_file the target path first and pass back the sha it returned.");
  }
  assertAllowedExtension(path, "path");

  let finalContent = content;
  if (patch) {
    const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${baseSha}`);
    const baseContent = fromBase64(blob.content.replace(/\n/g, ""));
    finalContent = applyPatch(baseContent, patch);
  }

  try {
    const result = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: {
        message: message || `Update ${path}`,
        content: toBase64(finalContent),
        branch,
        sha: baseSha,
      },
    });
    return { path, content: finalContent, sha: result.content.sha, commitSha: result.commit.sha };
  } catch (err) {
    if (baseSha && isConflictError(err)) {
      const conflictErr = new Error(
        `Write conflict on "${path}": the file changed on "${branch}" since it was read (base_sha ${baseSha} is stale). ` +
        `Re-read the file and retry instead of overwriting blindly. Original error: ${err.message}`
      );
      conflictErr.conflict = true;
      throw conflictErr;
    }
    throw err;
  }
}

// -- validate --------------------------------------------------------------
// Re-exported as-is: validateByExtension (connectors/frontend/validate.js)
// was already a standalone, dependency-free-of-the-agent-loop callable --
// nothing about it needed to change for v2, it's just exposed here
// alongside read_file/write_file so the step-2 agent loop has one import
// surface for all three tools.
export { validateByExtension as validate };
