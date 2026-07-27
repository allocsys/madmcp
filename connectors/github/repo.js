// ---------------------------------------------------------------------------
// connectors/github/repo.js — repo metadata tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "list_repos",
    "List repositories for a GitHub user or organization.",
    {
      owner:    z.string().describe("GitHub username or organization name"),
      type:     z.enum(["all", "owner", "member"]).optional().describe("Filter by repo type (default: all). Only meaningful for a user owner -- \"owner\" isn't a valid filter on GitHub's org-repos endpoint, so if `owner` turns out to be an organization, this is silently remapped to \"all\" rather than erroring."),
      sort:     z.enum(["created", "updated", "pushed", "full_name"]).optional().describe("Sort order (default: updated)"),
      per_page: z.number().optional().describe("Number of repos to return, max 100 (default: 30)"),
    },
    async ({ owner, type = "all", sort = "updated", per_page = 30 }) => {
      let data;
      try {
        data = await githubRequest(`/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`);
      } catch {
        // /orgs/:org/repos doesn't accept the same `type` values as
        // /users/:username/repos — it has no "owner" value (valid values are
        // all/public/private/forks/sources/member). "owner" is only meaningful
        // for the user endpoint we just tried, so map it to "all" here rather
        // than forwarding a value the org endpoint will 422 on. Other type
        // values ("all", "member") are valid on both and pass through as-is.
        const orgType = type === "owner" ? "all" : type;
        data = await githubRequest(`/orgs/${owner}/repos?type=${orgType}&sort=${sort}&per_page=${per_page}`);
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
}
