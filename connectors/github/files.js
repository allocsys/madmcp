// ---------------------------------------------------------------------------
// connectors/github/files.js — file & directory tools
//
// NOTE ON "RULE for the calling model..." TEXT BELOW: these descriptions are
// what the MCP-calling model (e.g. Claude) sees when deciding which tool to
// use, and are the only place the "prefer delegate_gemini" routing hints
// live. They are read by a DIFFERENT model, for a DIFFERENT purpose, than
// the FUNCTIONS declarations Gemini sees in connectors/gemini/delegate.js
// during its own internal tool-calling loop -- editing one has no effect on
// the other. Do not assume changes here propagate to delegate.js, and never
// port this "use delegate_gemini instead" phrasing onto delegate.js's own
// function declarations (see the warning at the top of that file for why).
//
// NOTE ON "clone via bash_tool" TEXT BELOW (added 2026-07-28, see Notion
// entity_id madmcp-delegate-designer-plan): confirmed by direct test that
// the calling model's own sandbox (bash_tool) can `git clone` a PUBLIC repo
// straight from github.com/codeload.github.com/raw.githubusercontent.com --
// all three are already on that sandbox's network allowlist. That's a THIRD
// option alongside read_file and delegate_gemini, and for its specific use
// case (needing multiple files locally to run/test/lint, not just read) it
// beats both: unlike read_file it doesn't put file contents in the calling
// model's context at all (only command output does), and unlike
// delegate_gemini it lets the calling model actually EXECUTE the code
// (npm test, eslint, etc.), not just read/summarize it. Only works for
// PUBLIC repos -- the sandbox has no GitHub credentials, so a private repo
// clone will simply fail auth, at which point read_file/delegate_gemini are
// still the right fallback.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, toBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";
import { readFileViaBlob, CHUNK_SIZE, CHUNK_THRESHOLD } from "./helpers.js";

export function register(server) {

  server.tool(
    "read_file",
    "USE: single, specifically-named file, exact path already known.\n" +
    "RULE: >2 files needed, OR request = understand/review/summarize a repo or directory (any phrasing: 'read the repo', 'dig into it', 'get up to speed') -> delegate_gemini instead. Never loop read_file manually for that.\n" +
    "RULE: repo is PUBLIC and goal = run/test/lint code (not just read it) -> git clone via bash_tool instead (github.com/codeload.github.com/raw.githubusercontent.com allowlisted; zero context cost; can execute code). PUBLIC REPOS ONLY -- no GitHub creds in sandbox.\n" +
    "DOES: reads a file's contents from a GitHub repository. Auto-chunks if >100,000 chars -- use read_file_chunked for subsequent pages.",
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
    "DOES: Read a slice of a large file. Use when read_file times out or is truncated.\n" +
    "RULE: chunking through several large files for one open-ended question -> delegate_gemini instead of many manual round-trips.",
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
    "DOES: List files/folders at a path.\n" +
    "RULE: drilling into many directories one at a time to map an unfamiliar repo -> delegate_gemini instead, server-side in one call.",
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
    "USE: one-time single tree snapshot.\n" +
    "RULE: result has >~10 files, OR next step = reading/searching multiple files from it -> STOP, use delegate_gemini for the whole investigation instead. Applies regardless of phrasing ('thorough read', 'quick look', 'dig deeper' all count). Never chain this into manual read_file loops.\n" +
    "RULE: repo is PUBLIC and goal = run/test/lint multiple files (not just read them) -> git clone via bash_tool instead (see read_file's description; zero context cost, can execute code, public repos only).\n" +
    "DOES: recursively lists all files and folders in a GitHub repository (full tree).",
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
    "DOES: Write a brand-new file to a GitHub repo. NOT the sandbox filesystem -> use the computer-use create_file tool for that.\n" +
    "RULE: fails if the path already exists -> str_replace_file to patch, overwrite_file to fully replace.",
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
    "DOES: Full rewrite of a file's contents (creates it if it doesn't exist).\n" +
    "RULE: small targeted edit -> str_replace_file instead (no need to resend the whole file). Must fail if file already exists -> create_repo_file. Several files as one atomic commit -> overwrite_files.",
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
    "DOES: Delete a file from a repo.\n" +
    "NOT: replacing/updating contents -> overwrite_file or str_replace_file. NOT: creating a file -> create_repo_file.",
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
    "DOES: Rename/move a file in a repo.\n" +
    "NOT: editing contents without moving -> str_replace_file (targeted) or overwrite_file (full rewrite). NOT: creating a new file -> create_repo_file.",
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
    "DOES: Create/overwrite multiple files as ONE atomic commit -- each file's full content written as-is.\n" +
    "RULE: one file at a time -> use create_repo_file/overwrite_file/str_replace_file instead (single-file equivalents).",
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
