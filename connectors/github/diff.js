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

  const diff = [];
  diff.push(`--- ${aLabel}`);
  diff.push(`+++ ${bLabel}`);

  const m = aLines.length;
  const n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);

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

// ---------------------------------------------------------------------------
// Helper: read file via Blobs API (no 1MB limit)
// ---------------------------------------------------------------------------
async function readFileBlobForDiff(owner, repo, filePath, ref) {
  const repoInfo = await githubRequest(`/repos/${owner}/${repo}`);
  const branch = ref || repoInfo.default_branch;
  let treeSha;
  try {
    const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    treeSha = refData.object.sha;
  } catch {
    treeSha = branch;
  }
  const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const entry = tree.tree.find((item) => item.path === filePath && item.type === "blob");
  if (!entry) throw new Error(`File not found in tree: ${filePath}`);
  const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
  return fromBase64(blob.content.replace(/\n/g, ""));
}

export function register(server) {

  server.tool(
    "diff_files",
    "Compare two files or two versions of the same file in a GitHub repository and return a unified diff.",
    {
      owner:     z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:      z.string().describe("Repository name"),
      path:      z.string().optional().describe("File path to compare across two refs (use with base_ref and head_ref)"),
      base_ref:  z.string().optional().describe("Base ref (branch, tag, or SHA). Defaults to repo default branch."),
      head_ref:  z.string().optional().describe("Head ref to compare against base_ref."),
      base_path: z.string().optional().describe("Path of the base file (use with head_path for cross-file diff)"),
      head_path: z.string().optional().describe("Path of the head file (use with base_path for cross-file diff)"),
      ref:       z.string().optional().describe("Ref to use when comparing two different file paths (default: default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, base_ref, head_ref, base_path, head_path, ref }) => {
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
        const resolvedBase = base_ref || (await githubRequest(`/repos/${owner}/${repo}`)).default_branch;
        [aText, bText] = await Promise.all([
          readFileBlobForDiff(owner, repo, path, resolvedBase),
          readFileBlobForDiff(owner, repo, path, head_ref),
        ]);
        aLabel = `${path} (${resolvedBase})`;
        bLabel = `${path} (${head_ref})`;
      } else {
        const resolvedRef = ref || (await githubRequest(`/repos/${owner}/${repo}`)).default_branch;
        [aText, bText] = await Promise.all([
          readFileBlobForDiff(owner, repo, base_path, resolvedRef),
          readFileBlobForDiff(owner, repo, head_path, resolvedRef),
        ]);
        aLabel = `${base_path} (${resolvedRef})`;
        bLabel = `${head_path} (${resolvedRef})`;
      }

      const diff = unifiedDiff(aText, bText, aLabel, bLabel);
      return { content: [{ type: "text", text: diff }] };
    }
  );
}
