// ---------------------------------------------------------------------------
// connectors/github/str_replace.js — str_replace_file tool
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, toBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";
import { readFileViaBlob } from "./helpers.js";

export function register(server) {
  server.tool(
    "str_replace_file",
    "Edit, patch, modify, or fix part of a file in a GitHub repository by applying one or more targeted find-and-replace operations, then commit the result. Only the changed strings need to be sent — no full file upload required. Returns a unified diff of what changed. Use this for small, surgical edits; for a full rewrite use overwrite_file, or create_repo_file to write a brand-new file.",
    {
      owner:        z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:         z.string().describe("Repository name"),
      path:         z.string().describe("File path within the repo"),
      replacements: z.array(z.object({
        find:    z.string().describe("Exact string to find (must appear exactly once in the file)"),
        replace: z.string().describe("String to replace it with"),
      })).min(1).describe("List of find-and-replace operations to apply sequentially"),
      message: z.string().describe("Commit message"),
      branch:  z.string().optional().describe("Branch to commit to (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, replacements, message, branch }) => {
      const original = await readFileViaBlob(owner, repo, path, branch);
      let updated = original;

      const errors = [];
      for (const { find, replace } of replacements) {
        const count = updated.split(find).length - 1;
        if (count === 0) { errors.push(`⚠️ String not found: ${JSON.stringify(find)}`); continue; }
        if (count > 1)   { errors.push(`⚠️ String found ${count} times (must be unique): ${JSON.stringify(find)}`); continue; }
        updated = updated.replace(find, replace);
      }

      if (errors.length) {
        return { content: [{ type: "text", text: `Aborted — fix these issues before committing:\n${errors.join("\n")}` }], isError: true };
      }
      if (updated === original) {
        return { content: [{ type: "text", text: "No changes — all replacements produced identical content." }] };
      }

      const query    = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
      const result   = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "PUT",
        body: { message, content: toBase64(updated), branch, sha: existing.sha },
      });

      // Build unified diff
      const aLines = original.split("\n");
      const bLines = updated.split("\n");
      const diffLines = [`--- ${path} (before)`, `+++ ${path} (after)`];
      const m = aLines.length, n = bLines.length;
      const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = m - 1; i >= 0; i--)
        for (let j = n - 1; j >= 0; j--)
          dp[i][j] = aLines[i] === bLines[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
      const hunks = [];
      let i = 0, j = 0;
      while (i < m || j < n) {
        if (i < m && j < n && aLines[i] === bLines[j]) { hunks.push({ t: "ctx", l: aLines[i] }); i++; j++; }
        else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) { hunks.push({ t: "add", l: bLines[j] }); j++; }
        else { hunks.push({ t: "del", l: aLines[i] }); i++; }
      }
      const CONTEXT = 3;
      const changed = new Set(hunks.map((h, idx) => h.t !== "ctx" ? idx : -1).filter(x => x >= 0));
      const shown = new Set();
      for (const idx of changed)
        for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(hunks.length - 1, idx + CONTEXT); k++)
          shown.add(k);
      let last = -1;
      for (const idx of [...shown].sort((a, b) => a - b)) {
        if (last !== -1 && idx > last + 1) diffLines.push("@@ ... @@");
        const h = hunks[idx];
        diffLines.push(`${h.t === "add" ? "+" : h.t === "del" ? "-" : " "}${h.l}`);
        last = idx;
      }
      if (diffLines.length === 2) diffLines.push("(no differences)");

      return {
        content: [{ type: "text", text: `✅ Committed ${replacements.length} replacement(s) to ${path} (commit ${result.commit.sha.slice(0, 7)}).\n\n${diffLines.join("\n")}` }],
      };
    }
  );
}
