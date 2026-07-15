// ---------------------------------------------------------------------------
// connectors/github/repo_mgmt.js — repo lifecycle + file-at-commit tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  // ── Create repo ──────────────────────────────────────────────────────────

  server.tool(
    "create_repo",
    "Create a new GitHub repository under the authenticated user or an org.",
    {
      name:        z.string().describe("Repository name (no spaces)"),
      description: z.string().optional().describe("Short description of the repository"),
      private:     z.boolean().optional().describe("Whether the repo is private (default: false)"),
      auto_init:   z.boolean().optional().describe("Initialize with a README (default: false)"),
      org:         z.string().optional().describe("Organization to create the repo under. Omit to create under the authenticated user."),
    },
    async ({ name, description, private: isPrivate = false, auto_init = false, org }) => {
      const endpoint = org ? `/orgs/${org}/repos` : "/user/repos";
      const data = await githubRequest(endpoint, {
        method: "POST",
        body: { name, description, private: isPrivate, auto_init },
      });
      return {
        content: [{
          type: "text",
          text: `Created ${data.private ? "private" : "public"} repo: ${data.full_name}\n${data.html_url}`,
        }],
      };
    }
  );

  // ── Fork repo ────────────────────────────────────────────────────────────

  server.tool(
    "fork_repo",
    "Fork a GitHub repository into the authenticated user's account or an org. Forking is async on GitHub's side — the returned repo may take a few seconds to become fully clone-able.",
    {
      owner:            z.string().describe("Owner of the repository to fork (e.g. 'modelcontextprotocol')"),
      repo:             z.string().describe("Repository name to fork"),
      organization:      z.string().optional().describe("Org to fork into. Omit to fork into the authenticated user's account."),
      name:             z.string().optional().describe("Rename the fork. Omit to keep the original name."),
      default_branch_only: z.boolean().optional().describe("Fork only the default branch (default: false — forks all branches)."),
    },
    async ({ owner, repo, organization, name, default_branch_only }) => {
      const body = {};
      if (organization) body.organization = organization;
      if (name) body.name = name;
      if (default_branch_only !== undefined) body.default_branch_only = default_branch_only;
      const data = await githubRequest(`/repos/${owner}/${repo}/forks`, {
        method: "POST",
        body,
      });
      return {
        content: [{
          type: "text",
          text: `Forked ${owner}/${repo} → ${data.full_name}\n${data.html_url}\n(fork may take a few seconds to finish populating)`,
        }],
      };
    }
  );

  // ── Delete repo ──────────────────────────────────────────────────────────

  server.tool(
    "delete_repo",
    "Permanently delete a GitHub repository. This is irreversible — use with caution.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name to delete"),
    },
    async ({ owner = DEFAULT_OWNER, repo }) => {
      await githubRequest(`/repos/${owner}/${repo}`, { method: "DELETE" });
      return {
        content: [{
          type: "text",
          text: `🗑️ Deleted ${owner}/${repo} permanently.`,
        }],
      };
    }
  );

  // ── Get file at commit ───────────────────────────────────────────────────

  server.tool(
    "get_file_at_commit",
    "Read a file's contents as it existed at a specific commit SHA.",
    {
      owner:  z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:   z.string().describe("Repository name"),
      path:   z.string().describe("File path within the repo"),
      commit: z.string().describe("Commit SHA to read the file from"),
    },
    async ({ owner = DEFAULT_OWNER, repo, path, commit }) => {
      // Walk the tree at the given commit SHA
      const commitData = await githubRequest(`/repos/${owner}/${repo}/commits/${commit}`);
      const treeSha    = commitData.commit.tree.sha;
      const tree       = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
      const entry      = tree.tree.find((item) => item.path === path && item.type === "blob");
      if (!entry) {
        return {
          content: [{ type: "text", text: `File not found at commit ${commit.slice(0, 7)}: ${path}` }],
          isError: true,
        };
      }
      const blob    = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
      const content = fromBase64(blob.content.replace(/\n/g, ""));
      const header  = `[${path} @ ${commit.slice(0, 7)} | ${commitData.commit.author.date.slice(0, 10)} | ${content.length} chars]\n\n`;
      return { content: [{ type: "text", text: header + content }] };
    }
  );
}
