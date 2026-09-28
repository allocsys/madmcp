// ---------------------------------------------------------------------------
// connectors/github/issue_manage.js — issues tool
//
// Consolidated per plan-madmcp-github-tools-overhaul (group 6): merges
//   get_issue, list_issues, create_issue, update_issue, add_issue_comment
//                                              (were issues.js)
//   search_issues                              (was search.js)
// into one issue_manage tool dispatched on `action`:
//   get | list | create | update | comment | search
//
// Every request, output format and default below was moved verbatim from the
// original tools. What changed is only the dispatch and the fact that
// required-ness is now enforced in the handler (the schema is shared, so
// per-action required params can't live in it).
//
// PRECISION-PASS: 'search' is cross-repo (free-form GitHub issue-search
// `query`), unlike every other action here. owner/repo are optional in the
// schema and IGNORED by 'search'; the top-level description says so.
// PRECISION-PASS: `labels` and `state` mean different things per action
// (list: comma-separated string / open|closed|all; create+update: string
// array / open|closed). The schema accepts the union; the handler enforces the
// original per-action type so behavior matches the old tools.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

export function register(server) {

  server.tool(
    "issue_manage",
    "DOES: Read, create, update, comment on and search GitHub issues. Use `action` to pick. get/list/search are READ-ONLY; create/update/comment MUTATE GitHub state.\n" +
    "RULE: 'get' needs repo + issue_number (owner defaults) and returns full details of a single issue -- complete body text + comment thread. Optional include_comments (default true), max_comments (default 20, max 100, most recent first). Use it first when assessing whether an issue is a good, well-scoped contribution candidate. If the number is a PR it says so instead (use pr_read 'get').\n" +
    "RULE: 'list' needs repo (owner defaults) and lists issues in a single known repo (title/metadata only, no body/comments -> use 'get' for full detail). Optional state (open|closed|all, default open), labels (a comma-separated STRING), assignee, per_page (max 100, default 20). Pull requests are excluded; up to 5 pages are scanned to fill per_page.\n" +
    "RULE: 'create' needs repo + title (owner defaults); optional body (markdown), labels (an ARRAY of strings), assignees (array of usernames).\n" +
    "RULE: 'update' needs repo + issue_number (owner defaults) and edits an existing issue (close, reopen, retitle, relabel, reassign). Optional title, body, state (open|closed only), labels (ARRAY, replaces the existing label list), assignees (array, replaces the existing assignee list).\n" +
    "RULE: 'comment' needs repo + issue_number + body (owner defaults) and posts a comment on an issue OR pull request (markdown supported). This is the general conversation comment for PRs too; a diff-anchored comment is pr_write 'inline_comment', a formal review verdict is pr_write 'review'.\n" +
    "RULE: 'search' needs query and is CROSS-REPO: it uses GitHub issue-search syntax (label:, is:issue, is:pr, stars:>N, org:, repo:, -repo:, etc) and IGNORES owner and repo -- scope it with repo:/org: qualifiers inside `query`, not with the owner/repo params. Optional sort (created|updated|comments, default best-match), order (asc|desc, default desc), per_page (max 100, default 20). Returns title, repo, state, labels, assignee, date, URL per result. Use it for cross-repo discovery (bounty hunting, good-first-issue scanning); for a single known repo use 'list'. For a broader open-ended hunt (many searches -> read candidates -> narrow down) use delegate_agent instead of chaining this manually.\n" +
    "RULE: issue_number/include_comments/max_comments apply to 'get' (issue_number also to 'update' and 'comment'); state/labels/assignee/per_page to 'list' (per_page also 'search'); title/assignees to 'create'/'update'; query/sort/order to 'search' only.",
    {
      action:           z.enum(["get", "list", "create", "update", "comment", "search"]).describe("Which operation to perform."),
      owner:            z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted. IGNORED by 'search'.`),
      repo:             z.string().optional().describe("Repository name. Required for every action except 'search' (which ignores it)."),
      issue_number:     z.number().optional().describe("Issue number ('comment' also accepts a PR number). Required for 'get', 'update' and 'comment'."),
      include_comments: z.boolean().optional().describe("Whether to fetch and include the issue's comment thread (default: true). Used by 'get' only."),
      max_comments:     z.number().optional().describe("Max number of comments to include, most recent first (default: 20, max: 100). Used by 'get' only."),
      state:            z.enum(["open", "closed", "all"]).optional().describe("'list': filter by state (default: open; open|closed|all). 'update': new state (open|closed only)."),
      labels:           z.union([z.string(), z.array(z.string())]).optional().describe("'list': comma-separated list of label names to filter by (a STRING). 'create': labels to apply (an ARRAY of strings). 'update': replacement label list (an ARRAY of strings)."),
      assignee:         z.string().optional().describe("Filter by assignee username. Used by 'list' only."),
      assignees:        z.array(z.string()).optional().describe("'create': GitHub usernames to assign the issue to. 'update': replacement assignee list."),
      per_page:         z.number().optional().describe("Number of results to return, max 100 (default: 20). Used by 'list' and 'search'."),
      title:            z.string().optional().describe("Issue title. Required for 'create'; optional new title for 'update'."),
      body:             z.string().optional().describe("Text body (markdown supported). 'create': issue body. 'update': new body. 'comment': comment body (required)."),
      query:            z.string().optional().describe("Required for 'search': GitHub issue-search query string using standard qualifiers: label:, is:issue, is:pr, is:open, is:closed, stars:>N, org:, repo:, -repo: (exclude), -org: (exclude), created:, assignee:, no:assignee, etc. Combine with spaces (AND). e.g. 'label:bounty is:issue is:open stars:>100 -org:mergeos-bounties'"),
      sort:             z.enum(["created", "updated", "comments"]).optional().describe("Sort field (default: best-match relevance if omitted). Used by 'search' only."),
      order:            z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc). Used by 'search' only."),
    },
    async ({ action, owner, repo, issue_number, include_comments = true, max_comments = 20, state, labels, assignee, assignees, per_page, title, body, query, sort, order = "desc" }) => {

      // ── search (was search_issues) — cross-repo, ignores owner/repo ───────
      if (action === "search") {
        if (query === undefined) return fail("action 'search' requires query (a GitHub issue-search query string).");
        const limit = per_page ?? 20;
        let path = `/search/issues?q=${encodeURIComponent(query)}&order=${order}&per_page=${limit}`;
        if (sort) path += `&sort=${sort}`;
        const data = await githubRequest(path);
        if (!data.items?.length) return { content: [{ type: "text", text: "No results found." }] };
        const lines = data.items.map((item) => {
          const kind = item.pull_request ? "PR" : "Issue";
          const itemLabels = item.labels?.length ? ` [${item.labels.map((l) => l.name).join(", ")}]` : "";
          const itemAssignee = item.assignee ? ` (assigned: ${item.assignee.login})` : " (unassigned)";
          return `${kind} #${item.number} [${item.state}] ${item.title}${itemLabels}${itemAssignee}\n  ${item.repository_url.replace("https://api.github.com/repos/", "")} | created ${item.created_at.slice(0, 10)} | ${item.html_url}`;
        });
        return { content: [{ type: "text", text: `Found ${data.total_count} total result(s) (GitHub search caps at 1000), showing ${data.items.length}:\n\n${lines.join("\n\n")}` }] };
      }

      if (!repo) return fail(`action '${action}' requires repo parameter.`);
      owner = owner ?? DEFAULT_OWNER;

      if ((action === "get" || action === "update" || action === "comment") && issue_number === undefined) {
        return fail(`action '${action}' requires issue_number (the issue number).`);
      }

      // ── get (was get_issue) ───────────────────────────────────────────────
      if (action === "get") {
        const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}`);
        if (data.pull_request) {
          return { content: [{ type: "text", text: `#${issue_number} is a pull request, not an issue -- use pr_read (action: 'get') instead.` }] };
        }
        const labelText = data.labels.length ? data.labels.map((l) => l.name).join(", ") : "none";
        const assigneeText = data.assignees.length ? data.assignees.map((a) => a.login).join(", ") : "none";
        const lines = [
          `#${data.number} [${data.state}] ${data.title}`,
          `by ${data.user.login} | opened ${data.created_at.slice(0, 10)} | updated ${data.updated_at.slice(0, 10)}`,
          `labels: ${labelText} | assignees: ${assigneeText} | comments: ${data.comments}`,
          data.html_url,
          "",
          "--- body ---",
          data.body || "(no body)",
        ];

        if (include_comments && data.comments > 0) {
          // NOTE: the issue-comments endpoint does NOT support sort/direction
          // query params (unlike PR review-comments) -- it always returns
          // oldest-first. To show the most recent `max_comments` when a issue
          // has more comments than that, we must fetch the tail of the list
          // rather than the first page (see the page math below).
          const perPage = Math.min(Math.max(max_comments, 1), 100);
          let commentsData;
          if (data.comments <= perPage) {
            commentsData = await githubRequest(
              `/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=${perPage}&page=1`
            );
          } else {
            // Pages are oldest-first, so the newest `perPage` comments span at
            // most two 100-item pages. Fetch those and keep the tail; fetching
            // just the last page returned fewer than max_comments (e.g. 21
            // comments -> 1 shown).
            const startIdx  = data.comments - perPage;
            const firstPage = Math.floor(startIdx / 100) + 1;
            const lastPage  = Math.ceil(data.comments / 100);
            const all = [];
            for (let p = firstPage; p <= lastPage; p++) {
              const chunk = await githubRequest(
                `/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=100&page=${p}`
              );
              all.push(...chunk);
            }
            commentsData = all.slice(-perPage);
          }
          lines.push("", `--- comments (${commentsData.length} most recent of ${data.comments} shown) ---`);
          for (const c of commentsData) {
            lines.push("", `[${c.user.login} | ${c.created_at.slice(0, 10)}]`, c.body || "(empty)");
          }
        } else if (include_comments) {
          lines.push("", "--- comments ---", "(no comments)");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── list (was list_issues) ────────────────────────────────────────────
      if (action === "list") {
        if (labels !== undefined && typeof labels !== "string") {
          return fail("action 'list' takes labels as a comma-separated string (e.g. \"bug,help wanted\"), not an array.");
        }
        const listState = state ?? "open";
        const want = per_page ?? 20;
        // The issues endpoint also returns PRs, and per_page counts them, so a
        // single page can come back short (or empty) after filtering. Keep
        // paging (same per_page) until `want` issues are collected, the last
        // page is short, or MAX_PAGES is hit. Page 1's request is unchanged.
        const MAX_PAGES = 5;
        const collected = [];
        let capped = false;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const q = new URLSearchParams({ state: listState, per_page: String(want) });
          if (labels)   q.set("labels",   labels);
          if (assignee) q.set("assignee", assignee);
          if (page > 1) q.set("page", String(page));
          const data = await githubRequest(`/repos/${owner}/${repo}/issues?${q}`);
          collected.push(...data.filter((i) => !i.pull_request));
          if (collected.length >= want || data.length < want) break;
          if (page === MAX_PAGES) capped = true;
        }
        const issues = collected.slice(0, want);
        const cappedNote = capped && issues.length < want
          ? `\n\n(Scanned the first ${MAX_PAGES * want} items only; more issues may exist beyond pull requests.)`
          : "";
        if (!issues.length) return { content: [{ type: "text", text: `No ${listState} issues found.${cappedNote}` }] };
        const lines = issues.map((i) =>
          `#${i.number} [${i.state}] ${i.title}\n  by ${i.user.login} | ${i.created_at.slice(0, 10)}` +
          `${i.labels.length ? ` | labels: ${i.labels.map((l) => l.name).join(", ")}` : ""}` +
          `${i.assignee ? ` | assigned: ${i.assignee.login}` : ""}\n  ${i.html_url}`
        );
        return { content: [{ type: "text", text: lines.join("\n\n") + cappedNote }] };
      }

      // ── create (was create_issue) / update (was update_issue) ─────────────
      if (action === "create" || action === "update") {
        if (labels !== undefined && !Array.isArray(labels)) {
          return fail(`action '${action}' takes labels as an array of strings, not a comma-separated string.`);
        }
      }

      if (action === "create") {
        if (title === undefined) return fail("action 'create' requires title.");
        const data = await githubRequest(`/repos/${owner}/${repo}/issues`, {
          method: "POST",
          body: { title, body, labels, assignees },
        });
        return { content: [{ type: "text", text: `Created issue #${data.number}: "${data.title}"\n${data.html_url}` }] };
      }

      if (action === "update") {
        if (state === "all") return fail("action 'update' takes state 'open' or 'closed' ('all' is only valid for 'list').");
        const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}`, {
          method: "PATCH",
          body: { title, body, state, labels, assignees },
        });
        return { content: [{ type: "text", text: `Updated issue #${data.number}: "${data.title}" [${data.state}]\n${data.html_url}` }] };
      }

      // ── comment (was add_issue_comment) ───────────────────────────────────
      if (body === undefined) return fail("action 'comment' requires body (the comment text).");
      const data = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
        method: "POST",
        body: { body },
      });
      return { content: [{ type: "text", text: `Posted comment #${data.id} on #${issue_number}.\n${data.html_url}` }] };
    }
  );
}
