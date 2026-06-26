import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
//
// GITHUB_TOKEN must be set as an environment variable on the Manufact server
// (Manufact dashboard -> server settings -> environment variables, or passed
// via `env` on deploy/update_server). It should be a GitHub Personal Access
// Token scoped to only the repos you want this server to touch. Never commit
// the token to the repo itself.
// ---------------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API = "https://api.github.com";

function assertConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it as an environment variable on the Manufact server."
    );
  }
}

async function githubRequest(path, { method = "GET", body } = {}) {
  assertConfigured();
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "github-mcp-server",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const message =
      (data && (data.message || JSON.stringify(data))) || res.statusText;
    throw new Error(`GitHub API error (${res.status}): ${message}`);
  }
  return data;
}

function toBase64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

function fromBase64(b64) {
  return Buffer.from(b64, "base64").toString("utf-8");
}

// ---------------------------------------------------------------------------
// MCP server definition
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({
    name: "github-mcp-server",
    version: "1.0.0",
  });

  // -------------------------------------------------------------------------
  // Original tools
  // -------------------------------------------------------------------------

  server.tool(
    "read_file",
    "Read a file's contents from a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo, e.g. 'src/server.js'"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, path, ref }) => {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const data = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
      );
      if (Array.isArray(data)) {
        return {
          content: [
            {
              type: "text",
              text: `"${path}" is a directory, not a file. Use list_directory instead.`,
            },
          ],
          isError: true,
        };
      }
      const fileContent = fromBase64(data.content);
      return {
        content: [{ type: "text", text: fileContent }],
      };
    }
  );

  server.tool(
    "list_directory",
    "List files and folders at a path in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().optional().describe("Directory path within the repo (default: repo root)"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, path = "", ref }) => {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const data = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
      );
      const items = Array.isArray(data) ? data : [data];
      const lines = items.map(
        (item) => `${item.type === "dir" ? "📁" : "📄"} ${item.path}`
      );
      return {
        content: [{ type: "text", text: lines.join("\n") || "(empty)" }],
      };
    }
  );

  server.tool(
    "create_or_update_file",
    "Create a new file or update an existing file's contents in a GitHub repository, committing the change directly to a branch.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo, e.g. 'src/server.js'"),
      content: z.string().describe("The full new content of the file (plain text, not base64)"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner, repo, path, content, message, branch }) => {
      let sha;
      try {
        const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
        const existing = await githubRequest(
          `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
        );
        sha = existing.sha;
      } catch {
        // File doesn't exist yet — that's fine, we're creating it.
      }

      const result = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
        {
          method: "PUT",
          body: {
            message,
            content: toBase64(content),
            branch,
            sha,
          },
        }
      );

      return {
        content: [
          {
            type: "text",
            text: `${sha ? "Updated" : "Created"} ${path} in ${owner}/${repo} (commit ${result.commit.sha.slice(0, 7)}).`,
          },
        ],
      };
    }
  );

  server.tool(
    "delete_file",
    "Delete a file from a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repo"),
      message: z.string().describe("Commit message"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner, repo, path, message, branch }) => {
      const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`
      );
      await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "DELETE",
        body: { message, sha: existing.sha, branch },
      });
      return {
        content: [{ type: "text", text: `Deleted ${path} from ${owner}/${repo}.` }],
      };
    }
  );

  server.tool(
    "list_branches",
    "List branches in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
    },
    async ({ owner, repo }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/branches`);
      const lines = data.map((b) => `${b.name}${b.protected ? " (protected)" : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") || "(no branches)" }] };
    }
  );

  server.tool(
    "create_repo",
    "Create a new GitHub repository under the authenticated account.",
    {
      name: z.string().describe("Repository name"),
      private: z.boolean().optional().describe("Whether the repo should be private (default true)"),
      description: z.string().optional().describe("Repository description"),
    },
    async ({ name, private: isPrivate, description }) => {
      const data = await githubRequest(`/user/repos`, {
        method: "POST",
        body: { name, private: isPrivate ?? true, description },
      });
      return {
        content: [{ type: "text", text: `Created repo: ${data.full_name} (${data.html_url})` }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // New tools
  // -------------------------------------------------------------------------

  server.tool(
    "list_repos",
    "List repositories for a GitHub user or organization.",
    {
      owner: z.string().describe("GitHub username or organization name"),
      type: z.enum(["all", "owner", "member"]).optional().describe("Filter by repo type (default: all)"),
      sort: z.enum(["created", "updated", "pushed", "full_name"]).optional().describe("Sort order (default: updated)"),
      per_page: z.number().optional().describe("Number of repos to return, max 100 (default: 30)"),
    },
    async ({ owner, type = "all", sort = "updated", per_page = 30 }) => {
      let data;
      try {
        data = await githubRequest(
          `/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`
        );
      } catch {
        data = await githubRequest(
          `/orgs/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`
        );
      }
      const lines = data.map(
        (r) =>
          `${r.private ? "🔒" : "🌐"} ${r.full_name}${r.description ? ` — ${r.description}` : ""} [${r.language || "unknown"}] ⭐${r.stargazers_count}`
      );
      return {
        content: [{ type: "text", text: lines.join("\n") || "(no repositories found)" }],
      };
    }
  );

  server.tool(
    "search_code",
    "Search for code across GitHub repositories.",
    {
      query: z.string().describe("Search query (e.g. 'VLESS filename:worker.js user:dumbCodesOnly')"),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 10)"),
    },
    async ({ query, per_page = 10 }) => {
      const data = await githubRequest(
        `/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`
      );
      if (!data.items || data.items.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }
      const lines = data.items.map(
        (item) => `📄 ${item.repository.full_name}/${item.path} (${item.html_url})`
      );
      return {
        content: [
          {
            type: "text",
            text: `Found ${data.total_count} result(s), showing ${data.items.length}:\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_commit",
    "Get details of a specific commit in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      sha: z.string().describe("Commit SHA"),
    },
    async ({ owner, repo, sha }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
      const files = data.files
        .map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join("\n");
      const text =
        `Commit: ${data.sha.slice(0, 7)}\n` +
        `Author: ${data.commit.author.name} <${data.commit.author.email}>\n` +
        `Date: ${data.commit.author.date}\n` +
        `Message: ${data.commit.message}\n\n` +
        `Files changed (${data.files.length}):\n${files}`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "list_commits",
    "List commits on a branch in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      branch: z.string().optional().describe("Branch name (default: repo's default branch)"),
      per_page: z.number().optional().describe("Number of commits to return, max 100 (default: 20)"),
    },
    async ({ owner, repo, branch, per_page = 20 }) => {
      const query = new URLSearchParams({ per_page: String(per_page) });
      if (branch) query.set("sha", branch);
      const data = await githubRequest(`/repos/${owner}/${repo}/commits?${query}`);
      const lines = data.map(
        (c) =>
          `${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`
      );
      return { content: [{ type: "text", text: lines.join("\n") || "(no commits)" }] };
    }
  );

  server.tool(
    "create_branch",
    "Create a new branch in a GitHub repository from an existing ref.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      branch: z.string().describe("Name of the new branch to create"),
      from_branch: z.string().optional().describe("Branch, tag, or SHA to branch from (default: repo's default branch)"),
    },
    async ({ owner, repo, branch, from_branch }) => {
      let sha;
      if (from_branch) {
        const ref = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`);
        sha = ref.object.sha;
      } else {
        const repoData = await githubRequest(`/repos/${owner}/${repo}`);
        const defaultBranch = repoData.default_branch;
        const ref = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
        sha = ref.object.sha;
      }

      await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha },
      });

      return {
        content: [{ type: "text", text: `Created branch '${branch}' in ${owner}/${repo} from ${sha.slice(0, 7)}.` }],
      };
    }
  );

  server.tool(
    "get_pull_requests",
    "List pull requests in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      state: z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state (default: open)"),
      per_page: z.number().optional().describe("Number of PRs to return, max 100 (default: 20)"),
    },
    async ({ owner, repo, state = "open", per_page = 20 }) => {
      const data = await githubRequest(
        `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`
      );
      if (!data.length) {
        return { content: [{ type: "text", text: `No ${state} pull requests found.` }] };
      }
      const lines = data.map(
        (pr) =>
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
      repo: z.string().describe("Repository name"),
      title: z.string().describe("PR title"),
      head: z.string().describe("The branch containing the changes (source branch)"),
      base: z.string().describe("The branch to merge into (target branch, e.g. 'main')"),
      body: z.string().optional().describe("PR description body"),
      draft: z.boolean().optional().describe("Open as a draft PR (default: false)"),
    },
    async ({ owner, repo, title, head, base, body, draft = false }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { title, head, base, body, draft },
      });
      return {
        content: [
          {
            type: "text",
            text: `Created PR #${data.number}: "${data.title}"\n${data.html_url}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_file_tree",
    "Recursively list all files and folders in a GitHub repository (full tree).",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, ref }) => {
      let treeSha;
      if (ref) {
        try {
          const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
          treeSha = refData.object.sha;
        } catch {
          treeSha = ref;
        }
      } else {
        const repoData = await githubRequest(`/repos/${owner}/${repo}`);
        const branchData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`);
        treeSha = branchData.object.sha;
      }

      const data = await githubRequest(
        `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`
      );

      const lines = data.tree.map(
        (item) => `${item.type === "tree" ? "📁" : "📄"} ${item.path}`
      );

      const truncatedNote = data.truncated ? "\n\n⚠️ Tree was truncated (repo too large for full listing)." : "";
      return {
        content: [
          {
            type: "text",
            text: lines.join("\n") + truncatedNote || "(empty repository)",
          },
        ],
      };
    }
  );

  server.tool(
    "rename_file",
    "Rename or move a file in a GitHub repository (copies content to new path and deletes the old one).",
    {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      old_path: z.string().describe("Current file path"),
      new_path: z.string().describe("New file path / destination"),
      message: z.string().optional().describe("Commit message (default: 'rename <old> to <new>')"),
      branch: z.string().optional().describe("Branch to commit to (default: repo's default branch)"),
    },
    async ({ owner, repo, old_path, new_path, message, branch }) => {
      const commitMessage = message || `rename ${old_path} to ${new_path}`;

      const query = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(old_path)}${query}`
      );
      const content = existing.content.replace(/\n/g, ""); // already base64, strip newlines

      // Create file at new path
      const createResult = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(new_path)}`,
        {
          method: "PUT",
          body: { message: commitMessage, content, branch },
        }
      );

      // Delete old file
      await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(old_path)}`,
        {
          method: "DELETE",
          body: { message: commitMessage, sha: existing.sha, branch },
        }
      );

      return {
        content: [
          {
            type: "text",
            text: `Renamed ${old_path} → ${new_path} in ${owner}/${repo} (commit ${createResult.commit.sha.slice(0, 7)}).`,
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport (stateless: a fresh MCP server/transport pair per request)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "github-mcp-server", configured: Boolean(GITHUB_TOKEN) });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`github-mcp-server listening on port ${PORT}`);
  if (!GITHUB_TOKEN) {
    console.warn("WARNING: GITHUB_TOKEN is not set. Tools will fail until it is configured.");
  }
});
