// ---------------------------------------------------------------------------
// connectors/github/download.js — download_repo tool
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {
  server.tool(
    "download_repo",
    "Fetch all files from a GitHub repository and return their full contents as a JSON payload. Claude receives {summary, files:[{path,content}], errors} and can then write them locally using create_file.",
    {
      owner:      z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:       z.string().describe("Repository name"),
      ref:        z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
      src_path:   z.string().optional().describe("Subdirectory inside the repo to download (default: entire repo root)"),
      extensions: z.array(z.string()).optional().describe("Only download files with these extensions e.g. ['.js', '.ts']. Omit to download everything."),
      max_files:  z.number().optional().describe("Safety cap on number of files to download (default: 200)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref, src_path = "", extensions, max_files = 200 }) => {
      const repoInfo     = await githubRequest(`/repos/${owner}/${repo}`);
      const targetBranch = ref || repoInfo.default_branch;
      let treeSha;
      try {
        const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
        treeSha = refData.object.sha;
      } catch {
        treeSha = targetBranch;
      }
      const treeData = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
      let blobs = treeData.tree.filter((item) => item.type === "blob");
      if (src_path) {
        const prefix = src_path.endsWith("/") ? src_path : src_path + "/";
        blobs = blobs.filter((item) => item.path.startsWith(prefix));
      }
      if (extensions && extensions.length > 0) {
        const exts = extensions.map((e) => e.startsWith(".") ? e : "." + e);
        blobs = blobs.filter((item) => exts.some((ext) => item.path.endsWith(ext)));
      }
      if (blobs.length > max_files) {
        return {
          content: [{ type: "text", text: `⚠️ Repo has ${blobs.length} matching files which exceeds max_files=${max_files}. Use src_path or extensions to narrow the scope, or raise max_files.` }],
          isError: true,
        };
      }
      // Fetch blobs directly by the SHA we already have from treeData above —
      // each item.sha is a stable blob SHA (unlike a branch name, it can't
      // move), so there's no need to re-resolve owner/repo/branch or re-walk
      // the whole recursive tree for every single file. Previously this used
      // readFileViaBlob(owner, repo, item.path, treeSha), which internally
      // re-fetched repo info, re-attempted a branch-ref lookup, AND re-fetched
      // the entire recursive tree again per file — O(n) full-tree fetches for
      // an n-file repo. Fetched with bounded concurrency so a large repo
      // doesn't fire hundreds of simultaneous requests at once.
      const CONCURRENCY = 10;
      const files = [];
      const errors = [];
      let cursor = 0;
      async function worker() {
        while (cursor < blobs.length) {
          const item = blobs[cursor++];
          try {
            const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${item.sha}`);
            const content = fromBase64(blob.content.replace(/\n/g, ""));
            files.push({ path: item.path, content });
          } catch (err) {
            errors.push({ path: item.path, error: err.message });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blobs.length) }, worker));
      files.sort((a, b) => a.path.localeCompare(b.path));
      const summary = `Fetched ${files.length}/${blobs.length} files from ${owner}/${repo}@${targetBranch}${errors.length ? ` (${errors.length} failed)` : ""}`;
      return { content: [{ type: "text", text: JSON.stringify({ summary, files, errors }, null, 2) }] };
    }
  );
}
