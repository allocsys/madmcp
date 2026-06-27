// ---------------------------------------------------------------------------
// connectors/github/patch.js — patch_file tool
// Applies a unified diff patch to a file in a GitHub repository.
// Only the patch travels over MCP — never the full file content.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, toBase64, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

// ---------------------------------------------------------------------------
// Minimal unified diff patch applier
// Supports the standard format produced by `git diff` / diff_files tool:
//   @@ -start,count +start,count @@
//   -removed line
//   +added line
//    context line
// ---------------------------------------------------------------------------
function applyPatch(original, patch) {
  const origLines  = original.split("\n");
  const patchLines = patch.split("\n");
  const result     = [];
  let origIdx      = 0; // 0-based index into origLines

  let i = 0;
  // Skip file header lines (--- / +++)
  while (i < patchLines.length && (patchLines[i].startsWith("---") || patchLines[i].startsWith("+++ "))) i++;

  while (i < patchLines.length) {
    const line = patchLines[i];

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@\s+-(?:(\d+)(?:,(\d+))?)\s+\+(?:(\d+)(?:,(\d+))?)\s+@@/);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10) - 1; // convert to 0-based

      // Copy original lines up to the start of this hunk
      while (origIdx < oldStart) {
        result.push(origLines[origIdx++]);
      }

      i++;
      // Process hunk lines
      while (i < patchLines.length && !patchLines[i].startsWith("@@")) {
        const hunkLine = patchLines[i];
        if (hunkLine.startsWith("+")) {
          result.push(hunkLine.slice(1));  // added line
        } else if (hunkLine.startsWith("-")) {
          origIdx++;                        // skip removed line
        } else if (hunkLine.startsWith(" ")) {
          result.push(origLines[origIdx++]); // context line
        } else if (hunkLine === "\\ No newline at end of file") {
          // ignore
        }
        i++;
      }
    } else {
      i++;
    }
  }

  // Copy any remaining original lines after the last hunk
  while (origIdx < origLines.length) {
    result.push(origLines[origIdx++]);
  }

  return result.join("\n");
}

export function register(server) {

  server.tool(
    "patch_file",
    "Apply a unified diff patch to a file in a GitHub repository and commit the result. Use this instead of push_files for large files — only the patch travels over MCP, never the full file content.",
    {
      owner:   z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:    z.string().describe("Repository name"),
      path:    z.string().describe("File path within the repo to patch"),
      patch:   z.string().describe("Unified diff patch string (standard git diff format: @@ hunks with - / + / context lines)"),
      message: z.string().describe("Commit message"),
      branch:  z.string().optional().describe("Branch to commit to (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, patch, message, branch }) => {
      // 1. Fetch current file via Blobs API (no size limit)
      const repoInfo     = await githubRequest(`/repos/${owner}/${repo}`);
      const targetBranch = branch || repoInfo.default_branch;

      const refData    = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
      const baseCommit = await githubRequest(`/repos/${owner}/${repo}/git/commits/${refData.object.sha}`);
      const tree       = await githubRequest(`/repos/${owner}/${repo}/git/trees/${baseCommit.tree.sha}?recursive=1`);

      const entry = tree.tree.find((item) => item.path === path && item.type === "blob");
      if (!entry) throw new Error(`File not found in tree: ${path}`);

      const blob    = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
      const current = fromBase64(blob.content.replace(/\n/g, ""));

      // 2. Apply the patch in memory
      let patched;
      try {
        patched = applyPatch(current, patch);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Patch apply failed: ${err.message}` }],
          isError: true,
        };
      }

      // 3. Commit patched content via Git Data API (blob → tree → commit → ref)
      const newBlob = await githubRequest(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: { content: toBase64(patched), encoding: "base64" },
      });

      const newTree = await githubRequest(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: {
          base_tree: baseCommit.tree.sha,
          tree: [{ path, mode: "100644", type: "blob", sha: newBlob.sha }],
        },
      });

      const newCommit = await githubRequest(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: { message, tree: newTree.sha, parents: [refData.object.sha] },
      });

      await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
        method: "PATCH",
        body: { sha: newCommit.sha },
      });

      // Exclude --- / +++ header lines from the changed-line count
      const linesChanged = patch.split("\n").filter((l) =>
        (l.startsWith("+") || l.startsWith("-")) &&
        !l.startsWith("---") &&
        !l.startsWith("+++ ")
      ).length;

      return {
        content: [{ type: "text", text: `Patched ${path} in ${owner}/${repo}@${targetBranch} (commit ${newCommit.sha.slice(0, 7)}). ~${linesChanged} lines changed.` }],
      };
    }
  );
}
