// ---------------------------------------------------------------------------
// connectors/github/issues.js — issues tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "get_issue",
    "Get a single issue's full details, including its complete body text and comment thread -- unlike search_issues/list_issues, which only return title/metadata snippets. Use this before assessing whether an issue is a good, well-scoped contribution candidate.",
    {
      owner:                z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:                 z.string().describe("Repository name"),
      issue_number:         z.number().describe("Issue number"),
      include_comments:     z.boolean().optional().describe("Whether to fetch and include the issue's comment thread (default: true)"),
      max_comments:         z.number().optional().describe("Max number of comments to include, most recent first (default: 20, max: 100)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, issue_number, include_comments = true, max_comments = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}`);
      if (data.pull_request) {
        return { content: [{ type: "text", text: `#${issue_number} is a pull request, not an issue -- use get_pr_comments/get_pr_reviews instead.` }] };
      }
      const labels = data.labels.length ? data.labels.map((l) => l.name).join(", ") : "none";
      const assignees = data.assignees.length ? data.assignees.map((a) => a.login).join(", ") : "none";
      const lines = [
        `#${data.number} [${data.state}] ${data.title}`,
        `by ${data.user.login} | opened ${data.created_at.slice(0, 10)} | updated ${data.updated_at.slice(0, 10)}`,
        `labels: ${labels} | assignees: ${assignees} | comments: ${data.comments}`,
        data.html_url,
        "",
        "--- body ---",
        data.body || "(no body)",
      ];

      if (include_comments && data.comments > 0) {
        const perPage = Math.min(Math.max(max_comments, 1), 100);
        const commentsData = await githubRequest(
          `/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=${perPage}&sort=created&direction=desc`
        );
        // Re-sort ascending (oldest first) for a natural reading order, since
        // the API call above fetches the most recent N via direction=desc.
        const ordered = [...commentsData].reverse();
        lines.push("", `--- comments (${ordered.length} of ${data.comments} shown) ---`);
        for (const c of ordered) {
          lines.push("", `[${c.user.login} | ${c.created_at.slice(0, 10)}]`, c.body || "(empty)");
        }
      } else if (include_comments) {
        lines.push("", "--- comments ---", "(no comments)");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

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
}
