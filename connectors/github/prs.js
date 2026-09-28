// ---------------------------------------------------------------------------
// connectors/github/prs.js — pull request write tools
//
// get_pull_requests and get_pr_activity moved to pr_read.js (group 4 of the
// GitHub tools consolidation). These write tools move to pr_write in group 5.
//
// NOTE ON TOOL DESCRIPTIONS BELOW: rewritten into tagged DOES:/RULE:/NOTE:
// format for faster LLM parsing (same convention as github/files.js and
// frontend/designer_tools.js). Rationale/mechanism detail not needed at
// call-selection time (how "ready" is implemented, what the commit
// verification badge means) lives in code comments here instead of in the
// description strings the calling model reads.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, githubGraphQL } from "./client.js";

export function register(server) {

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
