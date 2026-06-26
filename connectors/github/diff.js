// ---------------------------------------------------------------------------
// connectors/github/diff.js — diff_files tool
// Compares two files (or two refs of the same file) using GitHub's compare API
// or by fetching both versions and diffing them inline.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

// Minimal unified diff between two strings
function unifiedDiff(aText, bText, aLabel, bLabel) {
  const aLines = aText.split("\n");
  const bLines = bText.split("\n");

  // Build diff using a simple LCS-based line diff
  const diff = [];
  diff.push(`--- ${aLabel}`);
  diff.push(`+++ ${bLabel}`);

  // LCS table (only store lengths to keep memory usage low)
  const m = aLines.length;
  const n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);

  // Trace back
  const hunks = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      hunks.push({ type: "ctx", line: aLines[i] });
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      hunks.push({ type: "add", line: bLines[j] });
      j++;
    } else {
      hunks.push({ type: "del", line: aLines[i] });
      i++;
    }
  }

  // Format with ±3 context lines
  const CONTEXT = 3;
  const changed = new Set(
    hunks.map((h, idx) => (h.type !== "ctx" ? idx : -1)).filter((x) => x >= 0)
  );
  const shown = new Set();
  for (const idx of changed)
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(hunks.length - 1, idx + CONTEXT); k++)
      shown.add(k);

  let lastShown = -1;
  for (const idx of [...shown].sort((a, b) => a - b)) {
    if (lastShown !== -1 && idx > lastShown + 1) diff.push("@@ ... @@");
    const h = hunks[idx];
    diff.push(`${h.type === "add" ? "+" : h.type === "del" ? "-" : " "}${h.line}`);
    lastShown = idx;
  }

  if (diff.length === 2) diff.push("(no differences)");
  return diff.join("\n");
}

export function register(server) {

  server.tool(
    "diff_files",
    "Compare two files or two versions of the same file in a GitHub repository and return a unified diff.",
    {
      owner:  z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:   z.string().describe("Repository name"),
      // Option A: compare same file across two refs
      path:   z.string().optional().describe("File path to compare across two refs (use with base_ref and head_ref)"),
      base_ref: z.string().optional().describe("Base ref (branch, tag, or SHA). Defaults to repo default branch."),
      head_ref: z.string().optional().describe("Head ref to compare against base_ref."),
      // Option B: compare two different files on the same ref
      base_path: z.string().optional().describe("Path of the base file (use with head_path for cross-file diff)"),
      head_path: z.string().optional().describe("Path of the head file (use with base_path for cross-file diff)"),
      ref:       z.string().optional().describe("Ref to use when comparing two different file paths (default: default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, base_ref, head_ref, base_path, head_path, ref }) => {

      // Validate inputs
      const crossFile = base_path && head_path;
      const sameFile  = path && head_ref;
      if (!crossFile && !sameFile) {
        return {
          content: [{ type: "text", text: "Provide either:\n  (a) path + head_ref (and optionally base_ref) to compare a file across two refs, or\n  (b) base_path + head_path (and optionally ref) to compare two different files." }],
          isError: true,
        };
      }

      let aLabel, bLabel, aText, bText;

      if (sameFile) {
        // Compare same file at two refs
        const resolvedBase = base_ref || (await githubRequest(`/repos/${owner}/${repo}`)).default_branch;
        const [aData, bData] = await Promise.all([
          githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(resolvedBase)}`),
          githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(head_ref)}`),
        ]);
        aText  = fromBase64(aData.content);
        bText  = fromBase64(bData.content);
        aLabel = `${path} (${resolvedBase})`;
        bLabel = `${path} (${head_ref})`;
      } else {
        // Compare two different files
        const resolvedRef = ref || (await githubRequest(`/repos/${owner}/${repo}`)).default_branch;
        const [aData, bData] = await Promise.all([
          githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(base_path)}?ref=${encodeURIComponent(resolvedRef)}`),
          githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(head_path)}?ref=${encodeURIComponent(resolvedRef)}`),
        ]);
        aText  = fromBase64(aData.content);
        bText  = fromBase64(bData.content);
        aLabel = `${base_path} (${resolvedRef})`;
        bLabel = `${head_path} (${resolvedRef})`;
      }

      const diff = unifiedDiff(aText, bText, aLabel, bLabel);
      return { content: [{ type: "text", text: diff }] };
    }
  );
}
