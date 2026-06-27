// ---------------------------------------------------------------------------
// connectors/github/tools.js
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, toBase64, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";
import { register as registerDiff } from "./diff.js";

async function getFileBlobSha(owner, repo, filePath, ref) {
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
  return { blobSha: entry.sha, treeSha };
}

async function readFileViaBlob(owner, repo, filePath, ref) {
  const { blobSha } = await getFileBlobSha(owner, repo, filePath, ref);
  const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${blobSha}`);
  return fromBase64(blob.content.replace(/\n/g, ""));
}

const CHUNK_SIZE = 20000;
const CHUNK_THRESHOLD = 100000;

export function register(server) {

  // ── Download repo — returns file contents as JSON payload to Claude ──────

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
      const files = [];
      const errors = [];
      for (const item of blobs) {
        try {
          const content = await readFileViaBlob(owner, repo, item.path, treeSha);
          files.push({ path: item.path, content });
        } catch (err) {
          errors.push({ path: item.path, error: err.message });
        }
      }
      const summary = `Fetched ${files.length}/${blobs.length} files from ${owner}/${repo}@${targetBranch}${errors.length ? ` (${errors.length} failed)` : ""}`;
      return { content: [{ type: "text", text: JSON.stringify({ summary, files, errors }, null, 2) }] };
    }
  );

  // ── File & directory ──────────────────────────────────────────────────

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
    "create_or_update_file",
    "Create or update a file in a GitHub repository.",
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
      return { content: [{ type: "text", text: `${sha ? "Updated" : "Created"} ${path} in ${owner}/${repo} (commit ${result.commit.sha.slice(0, 7)}).` }] };
    }
  );

  server.tool(
    "delete_file",
    "Delete a file from a GitHub repository.",
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
    "Rename or move a file in a GitHub repository.",
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
    "push_files",
    "Commit multiple files to a GitHub repository in a single commit.",
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

  // ── Branches & commits ──────────────────────────────────────────────────

  server.tool(
    "list_branches",
    "List branches in a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
    },
    async ({ owner = DEFAULT_OWNER, repo }) => {
      const data  = await githubRequest(`/repos/${owner}/${repo}/branches`);
      const lines = data.map((b) => `${b.name}${b.protected ? " (protected)" : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") || "(no branches)" }] };
    }
  );

  server.tool(
    "create_branch",
    "Create a new branch in a GitHub repository from an existing ref.",
    {
      owner:       z.string().describe("Repository owner (user or org)"),
      repo:        z.string().describe("Repository name"),
      branch:      z.string().describe("Name of the new branch to create"),
      from_branch: z.string().optional().describe("Branch, tag, or SHA to branch from (default: repo default branch)"),
    },
    async ({ owner, repo, branch, from_branch }) => {
      let sha;
      if (from_branch) {
        const ref = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`);
        sha = ref.object.sha;
      } else {
        const repoData = await githubRequest(`/repos/${owner}/${repo}`);
        const ref      = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(repoData.default_branch)}`);
        sha = ref.object.sha;
      }
      await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha },
      });
      return { content: [{ type: "text", text: `Created branch '${branch}' in ${owner}/${repo} from ${sha.slice(0, 7)}.` }] };
    }
  );

  server.tool(
    "list_commits",
    "List commits on a branch in a GitHub repository.",
    {
      owner:    z.string().describe("Repository owner (user or org)"),
      repo:     z.string().describe("Repository name"),
      branch:   z.string().optional().describe("Branch name (default: repo default branch)"),
      per_page: z.number().optional().describe("Number of commits to return, max 100 (default: 20)"),
    },
    async ({ owner, repo, branch, per_page = 20 }) => {
      const query = new URLSearchParams({ per_page: String(per_page) });
      if (branch) query.set("sha", branch);
      const data  = await githubRequest(`/repos/${owner}/${repo}/commits?${query}`);
      const lines = data.map((c) =>
        `${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`
      );
      return { content: [{ type: "text", text: lines.join("\n") || "(no commits)" }] };
    }
  );

  server.tool(
    "get_commit",
    "Get details of a specific commit in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo:  z.string().describe("Repository name"),
      sha:   z.string().describe("Commit SHA"),
    },
    async ({ owner, repo, sha }) => {
      const data  = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
      const files = data.files.map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
      const text  =
        `Commit: ${data.sha.slice(0, 7)}\n` +
        `Author: ${data.commit.author.name} <${data.commit.author.email}>\n` +
        `Date:   ${data.commit.author.date}\n` +
        `Message: ${data.commit.message}\n\n` +
        `Files changed (${data.files.length}):\n${files}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Pull requests ────────────────────────────────────────────────────────

  server.tool(
    "get_pull_requests",
    "List pull requests in a GitHub repository.",
    {
      owner:    z.string().describe("Repository owner (user or org)"),
      repo:     z.string().describe("Repository name"),
      state:    z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state (default: open)"),
      per_page: z.number().optional().describe("Number of PRs to return, max 100 (default: 20)"),
    },
    async ({ owner, repo, state = "open", per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`);
      if (!data.length) return { content: [{ type: "text", text: `No ${state} pull requests found.` }] };
      const lines = data.map((pr) =>
        `#${pr.number} [${pr.state}] ${pr.title}\n  ${pr.head.label} → ${pr.base.label} | by ${pr.user.login} | ${pr.created_at.slice(0, 10)}\n  ${pr.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "create_pull_request",
    "Open a new pull request in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo:  z.string().describe("Repository name"),
      title: z.string().describe("PR title"),
      head:  z.string().describe("The branch containing the changes (source branch)"),
      base:  z.string().describe("The branch to merge into (target branch, e.g. 'main')"),
      body:  z.string().optional().describe("PR description body"),
      draft: z.boolean().optional().describe("Open as a draft PR (default: false)"),
    },
    async ({ owner, repo, title, head, base, body, draft = false }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { title, head, base, body, draft },
      });
      return { content: [{ type: "text", text: `Created PR #${data.number}: "${data.title}"\n${data.html_url}` }] };
    }
  );

  server.tool(
    "merge_pull_request",
    "Merge a pull request in a GitHub repository.",
    {
      owner:          z.string().describe("Repository owner (user or org)"),
      repo:           z.string().describe("Repository name"),
      pull_number:    z.number().describe("Pull request number"),
      merge_method:   z.enum(["merge", "squash", "rebase"]).optional().describe("Merge strategy (default: merge)"),
      commit_title:   z.string().optional().describe("Title for the merge commit"),
      commit_message: z.string().optional().describe("Body for the merge commit"),
    },
    async ({ owner, repo, pull_number, merge_method = "merge", commit_title, commit_message }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
        method: "PUT",
        body: { merge_method, commit_title, commit_message },
      });
      return { content: [{ type: "text", text: `Merged PR #${pull_number}: ${data.message}\nCommit: ${data.sha?.slice(0, 7) ?? "n/a"}` }] };
    }
  );

  server.tool(
    "review_pull_request",
    "Submit a review on a pull request (approve, request changes, or comment).",
    {
      owner:       z.string().describe("Repository owner (user or org)"),
      repo:        z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      event:       z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("Review action"),
      body:        z.string().optional().describe("Review comment body"),
    },
    async ({ owner, repo, pull_number, event, body }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
        method: "POST",
        body: { event, body },
      });
      return { content: [{ type: "text", text: `Submitted review #${data.id} (${event}) on PR #${pull_number}.` }] };
    }
  );

  // ── Issues ───────────────────────────────────────────────────────────────

  server.tool(
    "list_issues",
    "List issues in a GitHub repository.",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      state:    z.enum(["open", "closed", "all"]).optional().describe("Filter by state (default: open)"),
      labels:   z.string().optional().describe("Comma-separated list of label names to filter by"),
      assignee: z.string().optional().describe("Filter by assignee username"),
      per_page: z.number().optional().describe("Number of issues to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, state = "open", labels, assignee, per_page = 20 }) => {
      const query = new URLSearchParams({ state, per_page: String(per_page) });
      if (labels)   query.set("labels",   labels);
      if (assignee) query.set("assignee", assignee);
      const data   = await githubRequest(`/repos/${owner}/${repo}/issues?${query}`);
      const issues = data.filter((i) => !i.pull_request);
      if (!issues.length) return { content: [{ type: "text", text: `No ${state} issues found.` }] };
      const lines = issues.map((i) =>
        `#${i.number} [${i.state}] ${i.title}\n  by ${i.user.login} | ${i.created_at.slice(0, 10)}` +
        `${i.labels.length ? ` | labels: ${i.labels.map((l) => l.name).join(", ")}` : ""}` +
        `${i.assignee ? ` | assigned: ${i.assignee.login}` : ""}\n  ${i.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "create_issue",
    "Open a new issue in a GitHub repository.",
    {
      owner:     z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:      z.string().describe("Repository name"),
      title:     z.string().describe("Issue title"),
      body:      z.string().optional().describe("Issue body (markdown supported)"),
      labels:    z.array(z.string()).optional().describe("Labels to apply to the issue"),
      assignees: z.array(z.string()).optional().describe("GitHub usernames to assign the issue to"),
    },
    async ({ owner = DEFAULT_OWNER, repo, title, body, labels, assignees }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues`, {
        method: "POST",
        body: { title, body, labels, assignees },
      });
      return { content: [{ type: "text", text: `Created issue #${data.number}: "${data.title}"\n${data.html_url}` }] };
    }
  );

  server.tool(
    "update_issue",
    "Update an existing issue (close, reopen, retitle, relabel, or reassign).",
    {
      owner:        z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:         z.string().describe("Repository name"),
      issue_number: z.number().describe("Issue number"),
      title:        z.string().optional().describe("New title"),
      body:         z.string().optional().describe("New body"),
      state:        z.enum(["open", "closed"]).optional().describe("New state"),
      labels:       z.array(z.string()).optional().describe("Replacement label list"),
      assignees:    z.array(z.string()).optional().describe("Replacement assignee list"),
    },
    async ({ owner = DEFAULT_OWNER, repo, issue_number, title, body, state, labels, assignees }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}`, {
        method: "PATCH",
        body: { title, body, state, labels, assignees },
      });
      return { content: [{ type: "text", text: `Updated issue #${data.number}: "${data.title}" [${data.state}]\n${data.html_url}` }] };
    }
  );

  server.tool(
    "add_issue_comment",
    "Post a comment on an issue or pull request.",
    {
      owner:        z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:         z.string().describe("Repository name"),
      issue_number: z.number().describe("Issue or PR number"),
      body:         z.string().describe("Comment body (markdown supported)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, issue_number, body }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
        method: "POST",
        body: { body },
      });
      return { content: [{ type: "text", text: `Posted comment #${data.id} on #${issue_number}.\n${data.html_url}` }] };
    }
  );

  // ── Releases & tags ──────────────────────────────────────────────────────

  server.tool(
    "list_releases",
    "List releases in a GitHub repository.",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of releases to return, max 100 (default: 10)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 10 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=${per_page}`);
      if (!data.length) return { content: [{ type: "text", text: "No releases found." }] };
      const lines = data.map((r) =>
        `${r.tag_name} — ${r.name || "(no name)"}${r.draft ? " [DRAFT]" : ""}${r.prerelease ? " [PRE-RELEASE]" : ""}\n  Published: ${r.published_at?.slice(0, 10) ?? "unpublished"} | ${r.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "create_release",
    "Create a new release in a GitHub repository.",
    {
      owner:            z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:             z.string().describe("Repository name"),
      tag_name:         z.string().describe("Tag name for the release (e.g. 'v1.2.0')"),
      name:             z.string().optional().describe("Release title"),
      body:             z.string().optional().describe("Release notes (markdown supported)"),
      draft:            z.boolean().optional().describe("Create as a draft release (default: false)"),
      prerelease:       z.boolean().optional().describe("Mark as a pre-release (default: false)"),
      target_commitish: z.string().optional().describe("Branch or commit SHA the tag should point to"),
    },
    async ({ owner = DEFAULT_OWNER, repo, tag_name, name, body, draft = false, prerelease = false, target_commitish }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/releases`, {
        method: "POST",
        body: { tag_name, name, body, draft, prerelease, target_commitish },
      });
      return { content: [{ type: "text", text: `Created release "${data.name || data.tag_name}"${draft ? " (draft)" : ""}.\n${data.html_url}` }] };
    }
  );

  server.tool(
    "list_tags",
    "List tags in a GitHub repository.",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of tags to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/tags?per_page=${per_page}`);
      if (!data.length) return { content: [{ type: "text", text: "No tags found." }] };
      const lines = data.map((t) => `${t.name}  ${t.commit.sha.slice(0, 7)}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── Repo metadata ────────────────────────────────────────────────────────

  server.tool(
    "list_repos",
    "List repositories for a GitHub user or organization.",
    {
      owner:    z.string().describe("GitHub username or organization name"),
      type:     z.enum(["all", "owner", "member"]).optional().describe("Filter by repo type (default: all)"),
      sort:     z.enum(["created", "updated", "pushed", "full_name"]).optional().describe("Sort order (default: updated)"),
      per_page: z.number().optional().describe("Number of repos to return, max 100 (default: 30)"),
    },
    async ({ owner, type = "all", sort = "updated", per_page = 30 }) => {
      let data;
      try {
        data = await githubRequest(`/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`);
      } catch {
        data = await githubRequest(`/orgs/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`);
      }
      const lines = data.map((r) =>
        `${r.private ? "🔒" : "🌐"} ${r.full_name}${r.description ? ` — ${r.description}` : ""} [${r.language || "unknown"}] ⭐${r.stargazers_count}`
      );
      return { content: [{ type: "text", text: lines.join("\n") || "(no repositories found)" }] };
    }
  );

  server.tool(
    "get_repo",
    "Get detailed metadata for a GitHub repository.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
    },
    async ({ owner = DEFAULT_OWNER, repo }) => {
      const r    = await githubRequest(`/repos/${owner}/${repo}`);
      const text =
        `${r.full_name} (${r.private ? "private" : "public"})\n` +
        `Description: ${r.description || "(none)"}\n` +
        `Default branch: ${r.default_branch}\n` +
        `Language: ${r.language || "unknown"}\n` +
        `Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Open issues: ${r.open_issues_count}\n` +
        `Topics: ${r.topics?.join(", ") || "(none)"}\n` +
        `Created: ${r.created_at.slice(0, 10)} | Last push: ${r.pushed_at.slice(0, 10)}\n` +
        `URL: ${r.html_url}`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "list_contributors",
    "List contributors to a GitHub repository with commit counts.",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of contributors to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/contributors?per_page=${per_page}`);
      if (!data.length) return { content: [{ type: "text", text: "No contributors found." }] };
      const lines = data.map((c, i) => `${i + 1}. ${c.login} — ${c.contributions} commit${c.contributions !== 1 ? "s" : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_repo_topics",
    "Get or replace the topics on a GitHub repository.",
    {
      owner:      z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:       z.string().describe("Repository name"),
      set_topics: z.array(z.string()).optional().describe("If provided, replaces all existing topics with this list."),
    },
    async ({ owner = DEFAULT_OWNER, repo, set_topics }) => {
      if (set_topics !== undefined) {
        await githubRequest(`/repos/${owner}/${repo}/topics`, {
          method: "PUT",
          body: { names: set_topics },
          accept: "application/vnd.github.mercy-preview+json",
        });
        return { content: [{ type: "text", text: `Updated topics for ${owner}/${repo}: ${set_topics.join(", ") || "(none)"}` }] };
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/topics`, {
        accept: "application/vnd.github.mercy-preview+json",
      });
      return { content: [{ type: "text", text: `Topics for ${owner}/${repo}: ${data.names?.join(", ") || "(none)"}` }] };
    }
  );

  // ── Search ───────────────────────────────────────────────────────────────

  server.tool(
    "search_code",
    "Search for code across GitHub repositories.",
    {
      query:    z.string().describe("Search query (e.g. 'VLESS filename:worker.js user:dumbCodesOnly')"),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 10)"),
    },
    async ({ query, per_page = 10 }) => {
      const data = await githubRequest(`/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`);
      if (!data.items?.length) return { content: [{ type: "text", text: "No results found." }] };
      const lines = data.items.map((item) => `📄 ${item.repository.full_name}/${item.path} (${item.html_url})`);
      return { content: [{ type: "text", text: `Found ${data.total_count} result(s), showing ${data.items.length}:\n\n${lines.join("\n")}` }] };
    }
  );

  // ── GitHub Actions / CI ──────────────────────────────────────────────────

  server.tool(
    "list_workflow_runs",
    "List recent GitHub Actions workflow runs for a repository.",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      workflow_id: z.string().optional().describe("Workflow file name or ID (e.g. 'ci.yml'). Omit for all workflows."),
      branch:      z.string().optional().describe("Filter by branch name"),
      status:      z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]).optional().describe("Filter by run status"),
      per_page:    z.number().optional().describe("Number of runs to return, max 100 (default: 10)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, workflow_id, branch, status, per_page = 10 }) => {
      const query = new URLSearchParams({ per_page: String(per_page) });
      if (branch) query.set("branch", branch);
      if (status) query.set("status", status);
      const endpoint = workflow_id
        ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/runs?${query}`
        : `/repos/${owner}/${repo}/actions/runs?${query}`;
      const data = await githubRequest(endpoint);
      const runs = data.workflow_runs;
      if (!runs?.length) return { content: [{ type: "text", text: "No workflow runs found." }] };
      const icon  = (s, c) => s === "in_progress" ? "🔄" : s === "queued" || s === "waiting" ? "⏳" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "cancelled" ? "🚫" : "⚪";
      const lines = runs.map((r) =>
        `${icon(r.status, r.conclusion)} #${r.run_number} — ${r.name} (${r.head_branch})\n` +
        `  Status: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""} | Triggered: ${r.event} | ${r.created_at.slice(0, 10)}\n` +
        `  ${r.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "get_workflow_run_logs",
    "Get the logs summary for a specific GitHub Actions workflow run.",
    {
      owner:  z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:   z.string().describe("Repository name"),
      run_id: z.number().describe("Workflow run ID (from list_workflow_runs)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, run_id }) => {
      const run      = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}`);
      const jobsData = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
      const jobs     = jobsData.jobs || [];
      const icon     = (s, c) => s === "in_progress" ? "🔄" : c === "success" ? "✅" : c === "failure" ? "❌" : c === "cancelled" ? "🚫" : "⚪";
      const jobLines = jobs.map((j) => {
        const steps = j.steps
          ?.filter((s) => s.conclusion !== "success")
          .map((s) => `      ${icon(s.status, s.conclusion)} Step ${s.number}: ${s.name} [${s.conclusion || s.status}]`)
          .join("\n") || "";
        return `  ${icon(j.status, j.conclusion)} Job: ${j.name} [${j.conclusion || j.status}]\n${steps}`;
      });
      const text =
        `Run #${run.run_number}: ${run.name}\n` +
        `Status: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}\n` +
        `Branch: ${run.head_branch} | Commit: ${run.head_sha.slice(0, 7)}\n` +
        `Triggered by: ${run.event} | Started: ${run.created_at.slice(0, 10)}\n\n` +
        `Jobs (${jobs.length}):\n${jobLines.join("\n\n")}\n\n` +
        `Full logs: ${run.html_url}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // ── str_replace_file ─────────────────────────────────────────────────────

  server.tool(
    "str_replace_file",
    "Apply one or more find-and-replace operations to a file in a GitHub repository and commit the result. Only the changed strings need to be sent — no full file upload required. Returns a unified diff of what changed.",
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
      // Fetch current file content
      const original = await readFileViaBlob(owner, repo, path, branch);
      let updated = original;

      // Apply replacements sequentially
      const errors = [];
      for (const { find, replace } of replacements) {
        const count = updated.split(find).length - 1;
        if (count === 0) {
          errors.push(`⚠️ String not found: ${JSON.stringify(find)}`);
          continue;
        }
        if (count > 1) {
          errors.push(`⚠️ String found ${count} times (must be unique): ${JSON.stringify(find)}`);
          continue;
        }
        updated = updated.replace(find, replace);
      }

      if (errors.length) {
        return {
          content: [{ type: "text", text: `Aborted — fix these issues before committing:\n${errors.join("\n")}` }],
          isError: true,
        };
      }

      if (updated === original) {
        return { content: [{ type: "text", text: "No changes — all replacements produced identical content." }] };
      }

      // Commit the updated file
      const query    = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
      const result   = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "PUT",
        body: { message, content: toBase64(updated), branch, sha: existing.sha },
      });

      // Build a simple unified diff to return
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

      const commitSha = result.commit.sha.slice(0, 7);
      return {
        content: [{
          type: "text",
          text: `✅ Committed ${replacements.length} replacement(s) to ${path} (commit ${commitSha}).\n\n${diffLines.join("\n")}`,
        }],
      };
    }
  );

  // ── Diff ─────────────────────────────────────────────────────────────────
  registerDiff(server);
}
