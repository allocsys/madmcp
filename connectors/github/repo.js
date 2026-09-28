// ---------------------------------------------------------------------------
// connectors/github/repo.js — repo metadata tool
//
// Consolidated per plan-madmcp-github-tools-overhaul: list_repos,
// get_repo, list_contributors, and get_repo_topics merged into one
// repo_metadata tool, dispatched on `action`.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "repo_metadata",
    "DOES: Fetch repository metadata, list repositories, list contributors, or get/replace repo topics on GitHub. Use `action` to pick.\n" +
    "RULE: action 'list' REQUIRES an explicit owner (user or org); repo is ignored. type/sort/per_page apply.\n" +
    "RULE: actions 'get', 'contributors', 'topics', and 'set_topics' require repo; owner defaults if omitted.\n" +
    "RULE: action 'set_topics' REPLACES all existing topics with `topics` (pass [] to clear). It is the only mutating action here.",
    {
      action:   z.enum(["list", "get", "contributors", "topics", "set_topics"]).describe("Which operation to perform: 'list' (list repos for user/org), 'get' (detailed repo metadata), 'contributors' (repo commit contributors), 'topics' (read repo topic tags), or 'set_topics' (replace repo topic tags)."),
      owner:    z.string().optional().describe(`GitHub username, organization name, or repo owner. Required for action 'list'. For all other actions, defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().optional().describe("Repository name. Required for actions 'get', 'contributors', 'topics', and 'set_topics'."),
      type:     z.enum(["all", "owner", "member"]).optional().describe("Filter by repo type (default: all). Used by action 'list' only. Only meaningful for a user owner -- \"owner\" isn't a valid filter on GitHub's org-repos endpoint, so if `owner` turns out to be an organization, this is silently remapped to \"all\" rather than erroring."),
      sort:     z.enum(["created", "updated", "pushed", "full_name"]).optional().describe("Sort order (default: updated). Used by action 'list' only."),
      per_page: z.number().optional().describe("Number of items to return, max 100 (default: 30 for 'list', 20 for 'contributors'). Used by actions 'list' and 'contributors'."),
      topics:   z.array(z.string()).optional().describe("Full replacement list of topics. Required for action 'set_topics' (use [] to clear all topics); ignored otherwise."),
    },
    async ({ action, owner: ownerArg, repo, type = "all", sort = "updated", per_page, topics }) => {

      if (action === "list") {
        // Original list_repos required an explicit owner (no default) -- keep
        // that behavior rather than silently listing DEFAULT_OWNER's repos.
        if (!ownerArg) {
          return { content: [{ type: "text", text: "action 'list' requires owner (a GitHub username or organization name)." }], isError: true };
        }
        const owner = ownerArg;
        const effectivePerPage = per_page ?? 30;
        let data;
        try {
          data = await githubRequest(`/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${effectivePerPage}`);
        } catch {
          // /orgs/:org/repos doesn't accept the same `type` values as
          // /users/:username/repos — it has no "owner" value (valid values are
          // all/public/private/forks/sources/member). "owner" is only meaningful
          // for the user endpoint we just tried, so map it to "all" here rather
          // than forwarding a value the org endpoint will 422 on. Other type
          // values ("all", "member") are valid on both and pass through as-is.
          const orgType = type === "owner" ? "all" : type;
          data = await githubRequest(`/orgs/${owner}/repos?type=${orgType}&sort=${sort}&per_page=${effectivePerPage}`);
        }
        const lines = data.map((r) =>
          `${r.private ? "🔒" : "🌐"} ${r.full_name}${r.description ? ` — ${r.description}` : ""} [${r.language || "unknown"}] ⭐${r.stargazers_count}`
        );
        return { content: [{ type: "text", text: lines.join("\n") || "(no repositories found)" }] };
      }

      const owner = ownerArg ?? DEFAULT_OWNER;

      if (!repo) {
        return { content: [{ type: "text", text: `action '${action}' requires repo parameter.` }], isError: true };
      }

      if (action === "get") {
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

      if (action === "contributors") {
        const effectivePerPage = per_page ?? 20;
        const data = await githubRequest(`/repos/${owner}/${repo}/contributors?per_page=${effectivePerPage}`);
        if (!data.length) return { content: [{ type: "text", text: "No contributors found." }] };
        const lines = data.map((c, i) => `${i + 1}. ${c.login} — ${c.contributions} commit${c.contributions !== 1 ? "s" : ""}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (action === "set_topics") {
        // PRECISION-PASS: this mutating action is TEMPORARY. Per JULES_PLAN.md
        // it belongs in repo_lifecycle (group 2). It lives here only so
        // set-topics capability isn't lost between this PR and group 2.
        // Remove it from repo_metadata when group 2 lands.
        if (topics === undefined) {
          return { content: [{ type: "text", text: "action 'set_topics' requires topics (array of strings; [] clears all topics)." }], isError: true };
        }
        await githubRequest(`/repos/${owner}/${repo}/topics`, {
          method: "PUT",
          body: { names: topics },
          accept: "application/vnd.github.mercy-preview+json",
        });
        return { content: [{ type: "text", text: `Updated topics for ${owner}/${repo}: ${topics.join(", ") || "(none)"}` }] };
      }

      // action === "topics"
      const data = await githubRequest(`/repos/${owner}/${repo}/topics`, {
        accept: "application/vnd.github.mercy-preview+json",
      });
      return { content: [{ type: "text", text: `Topics for ${owner}/${repo}: ${data.names?.join(", ") || "(none)"}` }] };
    }
  );
}
