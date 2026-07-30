// ---------------------------------------------------------------------------
// connectors/github/prs.js — pull request tools
//
// NOTE ON TOOL DESCRIPTIONS BELOW: rewritten into tagged DOES:/RULE:/NOTE:
// format for faster LLM parsing (same convention as github/files.js and
// frontend/tools.js). Rationale/mechanism detail not needed at
// call-selection time (how "ready" is implemented, what the commit
// verification badge means) lives in code comments here instead of in the
// description strings the calling model reads.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, githubGraphQL } from "./client.js";

// GitHub's `state` field is only "open"/"closed" -- a closed-and-merged PR
// and a closed-without-merging PR both report state: "closed". The list and
// single-PR endpoints both also return `merged_at` (null unless merged), so
// use that to tell the two apart instead of state alone.
function prStatusLabel(pr) {
  if (pr.state === "closed") return pr.merged_at ? "merged" : "closed";
  return pr.state;
}

export function register(server) {

  server.tool(
    "get_pull_requests",
    "DOES: List PRs in a repo, OR (pull_number given) fetch one PR's full details + comments + reviews + commits merged into one response.\n" +
    "RULE: pull_number set -> state/per_page ignored. Use include_comments/include_reviews/include_commits=false to trim an unwanted section out of the response.",
    {
      owner:            z.string().describe("Repository owner (user or org)"),
      repo:             z.string().describe("Repository name"),
      state:            z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state when listing (default: open). Ignored if pull_number is given."),
      per_page:         z.number().optional().describe("Number of PRs to return when listing, max 100 (default: 20). Ignored if pull_number is given."),
      pull_number:      z.number().optional().describe("If provided, fetch this single PR's details instead of listing PRs."),
      include_comments: z.boolean().optional().describe("When fetching a single PR, include its conversation comments (default: true)"),
      include_reviews:  z.boolean().optional().describe("When fetching a single PR, include its formal reviews (default: true)"),
      // "Verified"/"Unverified" badge below matches the same GitHub-signature check GitHub's own UI shows on each commit.
      include_commits:  z.boolean().optional().describe("When fetching a single PR, include its commit list with signature verification status (default: true)"),
      max_comments:     z.number().optional().describe("Max comments to include, most recent first, when fetching a single PR (default: 20, max: 100)"),
      max_reviews:      z.number().optional().describe("Max reviews to include when fetching a single PR (default: 30, max: 100)"),
      max_commits:      z.number().optional().describe("Max commits to include when fetching a single PR (default: 100, max: 250)"),
    },
    async ({ owner, repo, state = "open", per_page = 20, pull_number, include_comments = true, include_reviews = true, include_commits = true, max_comments = 20, max_reviews = 30, max_commits = 100 }) => {
      if (pull_number === undefined) {
        const data = await githubRequest(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`);
        if (!data.length) return { content: [{ type: "text", text: `No ${state} pull requests found.` }] };
        const lines = data.map((pr) =>
          `#${pr.number} [${prStatusLabel(pr)}] ${pr.title}\n  ${pr.head.label} → ${pr.base.label} | by ${pr.user.login} | ${pr.created_at.slice(0, 10)}\n  ${pr.html_url}`
        );
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
      const sections = [
        `#${pr.number} [${prStatusLabel(pr)}${pr.draft ? ", draft" : ""}] ${pr.title}\n` +
        `${pr.head.label} → ${pr.base.label} | by ${pr.user.login} | opened ${pr.created_at.slice(0, 10)}\n` +
        `${pr.html_url}\n\n${pr.body || "(no description)"}`
      ];

      if (include_comments) {
        const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${pull_number}/comments?per_page=${max_comments}`);
        sections.push(
          comments.length
            ? `--- ${comments.length} comment(s) ---\n\n` + comments.map((c) =>
                `${c.user.login} (${c.created_at.slice(0, 16).replace("T", " ")}):\n${c.body}`
              ).join("\n\n")
            : "--- No comments ---"
        );
      }

      if (include_reviews) {
        const reviews = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=${max_reviews}`);
        sections.push(
          reviews.length
            ? `--- ${reviews.length} review(s) ---\n\n` + reviews.map((r) =>
                `${r.user.login} — ${r.state} (${(r.submitted_at || "").slice(0, 16).replace("T", " ")})${r.body ? `:\n${r.body}` : ""}`
              ).join("\n\n")
            : "--- No reviews yet ---"
        );
      }

      if (include_commits) {
        const commits = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/commits?per_page=${max_commits}`);
        sections.push(
          commits.length
            ? `--- ${commits.length} commit(s) — signature verification ---\n\n` + commits.map((c) => {
                const v = c.commit?.verification || {};
                const badge = v.verified ? "✅ Verified" : `❌ Unverified${v.reason ? ` (${v.reason})` : ""}`;
                const firstLine = (c.commit?.message || "").split("\n")[0];
                return `${c.sha.slice(0, 7)} — ${badge}\n  ${firstLine}\n  author: ${c.commit?.author?.name || c.author?.login || "unknown"}`;
              }).join("\n\n")
            : "--- No commits found ---"
        );
      }

      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    }
  );

  server.tool(
    "get_pr_activity",
    "DOES: PR conversation comments and/or formal reviews (approve/request-changes/comment verdicts). Use `type` to pick one or both.\n" +
    "NOT: inline diff comments (none of these tools currently expose those).",
    {
      owner:       z.string().describe("Repository owner (user or org)"),
      repo:        z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      type:        z.enum(["comments", "reviews", "both"]).optional().describe("Which activity to fetch (default: both)"),
      per_page:    z.number().optional().describe("Number of items to return per type, max 100 (default: 30)"),
    },
    async ({ owner, repo, pull_number, type = "both", per_page = 30 }) => {
      const sections = [];

      if (type === "comments" || type === "both") {
        const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${pull_number}/comments?per_page=${per_page}`);
        sections.push(
          comments.length
            ? `${comments.length} comment(s) on PR #${pull_number}:\n\n` + comments.map((c) =>
                `${c.user.login} (${c.created_at.slice(0, 16).replace("T", " ")}):\n${c.body}\n  ${c.html_url}`
              ).join("\n\n---\n\n")
            : `No comments on PR #${pull_number}.`
        );
      }

      if (type === "reviews" || type === "both") {
        const reviews = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=${per_page}`);
        sections.push(
          reviews.length
            ? `${reviews.length} review(s) on PR #${pull_number}:\n\n` + reviews.map((r) =>
                `${r.user.login} — ${r.state} (${(r.submitted_at || "").slice(0, 16).replace("T", " ")})` +
                `${r.body ? `:\n${r.body}` : ""}\n  ${r.html_url}`
              ).join("\n\n---\n\n")
            : `No reviews on PR #${pull_number} yet.`
        );
      }

      return { content: [{ type: "text", text: sections.join("\n\n===\n\n") }] };
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
    "update_pull_request",
    "DOES: Edit title/body/base/open-closed-state/draft-status on an existing PR. Pass only the field(s) to change.\n" +
    "RULE: ready=true only converts draft -> ready; no-op (with notice) if already non-draft. No API path exists to convert ready back to draft.",
    {
      owner:       z.string().describe("Repository owner (user or org)"),
      repo:        z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      title:       z.string().optional().describe("New PR title"),
      body:        z.string().optional().describe("New PR description body (replaces the existing description entirely)"),
      state:       z.enum(["open", "closed"]).optional().describe("Set to 'closed' to close the PR without merging, or 'open' to reopen it"),
      base:        z.string().optional().describe("Change the base branch this PR merges into"),
      // GitHub's REST API has no field for draft->ready, so this runs the markPullRequestReadyForReview GraphQL mutation under the hood instead.
      ready:       z.boolean().optional().describe("Set to true to convert a draft PR to ready for review (default: unchanged)"),
    },
    async ({ owner, repo, pull_number, title, body, state, base, ready }) => {
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (body !== undefined) patch.body = body;
      if (state !== undefined) patch.state = state;
      if (base !== undefined) patch.base = base;

      if (Object.keys(patch).length === 0 && ready === undefined) {
        return { content: [{ type: "text", text: "No fields provided to update — pass at least one of title, body, state, base, or ready." }] };
      }

      const results = [];

      if (ready === true) {
        const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
        if (!pr.draft) {
          results.push(`PR #${pull_number} is already ready for review (not a draft) — no change made.`);
        } else {
          await githubGraphQL(
            `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`,
            { id: pr.node_id }
          );
          results.push(`PR #${pull_number} converted from draft to ready for review.`);
        }
      }

      if (Object.keys(patch).length > 0) {
        const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`, {
          method: "PATCH",
          body: patch,
        });
        const updated = Object.keys(patch).join(", ");
        results.push(`Updated PR #${pull_number} (${updated}).\n${data.html_url}`);
      }

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    }
  );

  server.tool(
    "merge_pull_request",
    "DOES: Merge a PR. RULE: irreversible via this tool -- no unmerge.",
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
    "DOES: Submit a formal review on a PR (APPROVE / REQUEST_CHANGES / COMMENT).\n" +
    "NOT: a plain conversation reply -> use add_issue_comment for that (works on PRs too, since PRs are issues under the hood).",
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
}
