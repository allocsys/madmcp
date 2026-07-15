// ---------------------------------------------------------------------------
// connectors/github/files.js — file & directory tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, toBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";
import { readFileViaBlob, CHUNK_SIZE, CHUNK_THRESHOLD } from "./helpers.js";

export function register(server) {

  server.tool(
    "read_file",
    "Read a file's contents from a GitHub repository. Automatically returns the file in chunks if it exceeds 100,000 characters, with pagination info so you can call read_file_chunked for subsequent pages.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
      path:  z.string().describe("File path within the repo, e.g. 'src/server.js'"),
      ref:   z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, ref }) => {
      const content = await readFileViaBlob(owner, repo, path, ref);
      const total   = content.length;
      if (total <= CHUNK_THRESHOLD) {
        return { content: [{ type: "text", text: content }] };
      }
      const slice     = content.slice(0, CHUNK_SIZE);
      const remaining = total - CHUNK_SIZE;
      const header    =
        `⚠️ File too large to return in full (${total.toLocaleString()} chars). ` +
        `Returning first ${CHUNK_SIZE.toLocaleString()} chars. ` +
        `Use read_file_chunked with char_offset=${CHUNK_SIZE} to continue.\n` +
        `[File: ${path} | Total: ${total} chars | Offset: 0 | Returning: ${slice.length} chars | Remaining: ${remaining} chars]\n\n`;
      return { content: [{ type: "text", text: header + slice }] };
    }
  );

  server.tool(
    "read_file_chunked",
    "Read a slice of a large file from a GitHub repository. Use when read_file times out or is truncated.",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      path:        z.string().describe("File path within the repo"),
      ref:         z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
      char_offset: z.number().optional().describe("Character offset to start reading from (default: 0)"),
      char_limit:  z.number().optional().describe("Maximum number of characters to return (default: 20000, max: 100000)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, ref, char_offset = 0, char_limit = 20000 }) => {
      const safeLimit = Math.min(char_limit, 100000);
      const content   = await readFileViaBlob(owner, repo, path, ref);
      const total     = content.length;
      const slice     = content.slice(char_offset, char_offset + safeLimit);
      const remaining = Math.max(0, total - char_offset - slice.length);
      const header    = `[File: ${path} | Total: ${total} chars | Offset: ${char_offset} | Returning: ${slice.length} chars | Remaining: ${remaining} chars]\n\n`;
      return { content: [{ type: "text", text: header + slice }] };
    }
  );

  server.tool(
    "list_directory",
    "List files and folders at a path in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
      path:  z.string().optional().describe("Directory path within the repo (default: repo root)"),
      ref:   z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path = "", ref }) => {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const data  = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
      const items = Array.isArray(data) ? data : [data];
      const lines = items.map((item) => `${item.type === "dir" ? "📁" : "📄"} ${item.path}`);
      return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }] };
    }
  );

  server.tool(
    "get_file_tree",
    "Recursively list all files and folders in a GitHub repository (full tree).",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo:  z.string().describe("Repository name"),
      ref:   z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
    },
    async ({ owner, repo, ref }) => {
      let treeSha;
      if (ref) {
        try {
          const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
          treeSha = refData.object.sha;
        } catch { treeSha = ref; }
      } else {
        const repoData   = await githubRequest(`/repos/${owner}/${repo}`);
        const branchData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`);
        treeSha = branchData.object.sha;
      }
      const data  = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
      const lines = data.tree.map((item) => `${item.type === "tree" ? "📁" : "📄"} ${item.path}`);
      const note  = data.truncated ? "\n\n⚠️ Tree was truncated (repo too large)." : "";
      return { content: [{ type: "text", text: lines.join("\n") + note || "(empty repository)" }] };
    }
  );

  server.tool(
    "create_repo_file",
    "Create, add, or write a brand-new file in a GitHub repository (not the local sandbox filesystem -- for that, use the computer-use create_file tool). Fails if the path already exists -- use str_replace_file to edit/patch/modify an existing file, or overwrite_file to explicitly replace its full contents.",
    {
      owner:   z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:    z.string().describe("Repository name"),
      path:    z.string().describe("File path within the repo"),
      content: z.string().describe("Full content of the new file (plain text)"),
      message: z.string().describe("Commit message"),
      branch:  z.string().optional().describe("Branch to commit to (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, content, message, branch }) => {
      const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      try {
        await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
        throw new Error(`${path} already exists in ${owner}/${repo}${branch ? `@${branch}` : ""}. Use overwrite_file to replace it, or str_replace_file to patch it.`);
      } catch (e) {
        if (e.message?.includes("already exists")) throw e;
        /* 404 means the path is free -- proceed */
      }
      const result = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "PUT",
        body: { message, content: toBase64(content), branch },
      });
      return { content: [{ type: "text", text: `Created ${path} in ${owner}/${repo} (commit ${result.commit.sha.slice(0, 7)}).` }] };
    }
  );

  server.tool(
    "overwrite_file",
    "Replace, rewrite, or update a file's full contents in a GitHub repository, or create it if it doesn't exist yet. Use this for a deliberate full rewrite; for small, targeted edits/patches use str_replace_file instead so you don't have to resend the whole file. To create a new file and fail loudly if it already exists, use create_repo_file instead.",
    {
      owner:   z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:    z.string().describe("Repository name"),
      path:    z.string().describe("File path within the repo"),
      content: z.string().describe("Full new content of the file (plain text)"),
      message: z.string().describe("Commit message"),
      branch:  z.string().optional().describe("Branch to commit to (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, content, message, branch }) => {
      let sha;
      try {
        const query    = branch ? `?ref=${encodeURIComponent(branch)}` : "";
        const existing = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
        sha = existing.sha;
      } catch { /* new file */ }
      const result = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "PUT",
        body: { message, content: toBase64(content), branch, sha },
      });
      return { content: [{ type: "text", text: `${sha ? "Overwrote" : "Created"} ${path} in ${owner}/${repo} (commit ${result.commit.sha.slice(0, 7)}).` }] };
    }
  );

  server.tool(
    "delete_file",
    "Delete or remove a file from a GitHub repository. To replace/update a file's contents instead of removing it, use overwrite_file or str_replace_file; to create a new file instead, use create_repo_file.",
    {
      owner:   z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:    z.string().describe("Repository name"),
      path:    z.string().describe("File path within the repo"),
      message: z.string().describe("Commit message"),
      branch:  z.string().optional().describe("Branch to commit to (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, message, branch }) => {
      const query    = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
      await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "DELETE",
        body: { message, sha: existing.sha, branch },
      });
      return { content: [{ type: "text", text: `Deleted ${path} from ${owner}/${repo}.` }] };
    }
  );

  server.tool(
    "rename_file",
    "Rename, move, or relocate a file in a GitHub repository. To edit/update a file's contents without moving it, use str_replace_file (targeted edit) or overwrite_file (full rewrite); to create a brand-new file, use create_repo_file.",
    {
      owner:    z.string().describe("Repository owner (user or org)"),
      repo:     z.string().describe("Repository name"),
      old_path: z.string().describe("Current file path"),
      new_path: z.string().describe("New file path / destination"),
      message:  z.string().optional().describe("Commit message (default: 'rename <old> to <new>')"),
      branch:   z.string().optional().describe("Branch to commit to (default: repo default branch)"),
    },
    async ({ owner, repo, old_path, new_path, message, branch }) => {
      const commitMessage = message || `rename ${old_path} to ${new_path}`;
      const content      = await readFileViaBlob(owner, repo, old_path, branch);
      const repoInfo     = await githubRequest(`/repos/${owner}/${repo}`);
      const targetBranch = branch || repoInfo.default_branch;
      const refData      = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
      const baseCommit   = await githubRequest(`/repos/${owner}/${repo}/git/commits/${refData.object.sha}`);
      const newBlob = await githubRequest(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: { content: toBase64(content), encoding: "base64" },
      });
      const newTree = await githubRequest(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: {
          base_tree: baseCommit.tree.sha,
          tree: [
            { path: new_path, mode: "100644", type: "blob", sha: newBlob.sha },
            { path: old_path, mode: "100644", type: "blob", sha: null },
          ],
        },
      });
      const newCommit = await githubRequest(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: { message: commitMessage, tree: newTree.sha, parents: [refData.object.sha] },
      });
      await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
        method: "PATCH",
        body: { sha: newCommit.sha },
      });
      return { content: [{ type: "text", text: `Renamed ${old_path} → ${new_path} in ${owner}/${repo} (commit ${newCommit.sha.slice(0, 7)}).` }] };
    }
  );

  server.tool(
    "overwrite_files",
    "Create, overwrite, replace, or update multiple files in a GitHub repository as a single atomic commit -- each file's full content is written as-is (create_repo_file/overwrite_file/str_replace_file are single-file equivalents; use those for one file at a time).",
    {
      owner:   z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:    z.string().describe("Repository name"),
      branch:  z.string().optional().describe("Branch to push to (default: repo default branch)"),
      message: z.string().describe("Commit message"),
      files:   z.array(z.object({
        path:    z.string().describe("File path within the repo"),
        content: z.string().describe("Full new content of the file (plain text)"),
      })).min(1).describe("Files to include in this commit"),
    },
    async ({ owner = DEFAULT_OWNER, repo, branch, message, files }) => {
      const repoInfo     = await githubRequest(`/repos/${owner}/${repo}`);
      const targetBranch = branch || repoInfo.default_branch;
      const refData      = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
      const baseCommit   = await githubRequest(`/repos/${owner}/${repo}/git/commits/${refData.object.sha}`);
      const blobs        = await Promise.all(files.map((f) =>
        githubRequest(`/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: { content: toBase64(f.content), encoding: "base64" },
        })
      ));
      const newTree = await githubRequest(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: {
          base_tree: baseCommit.tree.sha,
          tree: files.map((f, i) => ({ path: f.path, mode: "100644", type: "blob", sha: blobs[i].sha })),
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
      return { content: [{ type: "text", text: `Pushed ${files.length} file(s) to ${owner}/${repo}@${targetBranch} (commit ${newCommit.sha.slice(0, 7)}).` }] };
    }
  );
}
