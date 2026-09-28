// ---------------------------------------------------------------------------
// connectors/github/review_control.js — reviewer assignment, merge
// readiness, inline review comments, and notifications. (Branch protection
// read moved to repo_inspect's 'branch_protection' action; merge-readiness
// read moved to pr_read's 'mergeability' action.) Complements prs.js (which
// submits whole-PR reviews but can't request reviewers) and actions.js/
// ci_control.js (commit-level CI state, not PR-level review state).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "request_reviewers",
    "DOES: Request review from users/teams on a PR (same as clicking 'Request review' in the GitHub UI).\n" +
    "NOT: submitting a review verdict yourself -> use review_pull_request for that.",
    {
      owner:         z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:          z.string().describe("Repository name"),
      pull_number:   z.number().describe("Pull request number"),
      reviewers:     z.array(z.string()).optional().describe("GitHub usernames to request review from"),
      team_reviewers: z.array(z.string()).optional().describe("Team slugs (org teams) to request review from, e.g. 'platform-team'"),
    },
    async ({ owner = DEFAULT_OWNER, repo, pull_number, reviewers, team_reviewers }) => {
      if (!reviewers?.length && !team_reviewers?.length) {
        throw new Error("Provide at least one of reviewers or team_reviewers.");
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/requested_reviewers`, {
        method: "POST",
        body: {
          ...(reviewers?.length ? { reviewers } : {}),
          ...(team_reviewers?.length ? { team_reviewers } : {}),
        },
      });
      const requested = (data.requested_reviewers || []).map((r) => r.login);
      const requestedTeams = (data.requested_teams || []).map((t) => t.slug);
      const text =
        `Requested review on PR #${pull_number}.\n` +
        `Reviewers: ${requested.length ? requested.join(", ") : "(none)"}\n` +
        `Teams: ${requestedTeams.length ? requestedTeams.join(", ") : "(none)"}`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "remove_requested_reviewers",
    "DOES: Cancel a pending review request on a PR. RULE: does not affect reviews already submitted.",
    {
      owner:          z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:           z.string().describe("Repository name"),
      pull_number:    z.number().describe("Pull request number"),
      reviewers:      z.array(z.string()).optional().describe("GitHub usernames to remove from the review request"),
      team_reviewers: z.array(z.string()).optional().describe("Team slugs to remove from the review request"),
    },
    async ({ owner = DEFAULT_OWNER, repo, pull_number, reviewers, team_reviewers }) => {
      if (!reviewers?.length && !team_reviewers?.length) {
        throw new Error("Provide at least one of reviewers or team_reviewers.");
      }
      await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/requested_reviewers`, {
        method: "DELETE",
        body: {
          ...(reviewers?.length ? { reviewers } : {}),
          ...(team_reviewers?.length ? { team_reviewers } : {}),
        },
      });
      return { content: [{ type: "text", text: `Removed review request(s) on PR #${pull_number}.` }] };
    }
  );

  server.tool(
    "add_review_comment",
    "DOES: Inline comment anchored to a diff line (same as clicking a line in GitHub's 'Files changed' view).\n" +
    "NOT: whole-PR verdict -> review_pull_request. NOT: general non-anchored conversation comment -> add_issue_comment.",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      commit_id:   z.string().describe("SHA of the commit being commented on — typically the PR's current head SHA (from get_pull_requests or list_commits)"),
      path:        z.string().describe("File path (relative to repo root) the comment applies to"),
      line:        z.number().describe("Line number in the file (as shown in the diff) to attach the comment to. For a multi-line comment, this is the LAST line of the range."),
      side:        z.enum(["LEFT", "RIGHT"]).optional().describe("Which side of the diff `line` refers to — RIGHT for the new/added version, LEFT for the old/removed version (default: RIGHT)"),
      start_line:  z.number().optional().describe("First line of a multi-line comment range. Omit for a single-line comment. Must be on the same side as `line` and less than it."),
      start_side:  z.enum(["LEFT", "RIGHT"]).optional().describe("Side of the diff `start_line` refers to (default: same as `side`). Only used with `start_line`."),
      body:        z.string().describe("Comment text"),
    },
    async ({ owner = DEFAULT_OWNER, repo, pull_number, commit_id, path, line, side = "RIGHT", start_line, start_side, body }) => {
      const payload = { commit_id, path, line, side, body };
      if (start_line !== undefined) {
        if (start_line >= line) {
          throw new Error("start_line must be less than line for a multi-line comment.");
        }
        payload.start_line = start_line;
        payload.start_side = start_side || side;
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/comments`, {
        method: "POST",
        body: payload,
      });
      const rangeDesc = start_line !== undefined ? `${start_line}-${line}` : `${line}`;
      return { content: [{ type: "text", text: `Added inline comment on ${path}:${rangeDesc} (PR #${pull_number}).\n${data.html_url}` }] };
    }
  );

  server.tool(
    "list_notifications",
    "DOES: Authenticated-token notification feed (mentions, review requests, replies, CI failures on watched runs) -- same feed as github.com/notifications.\n" +
    "RULE: 'did anyone reply to me' / 'is anything waiting on me' -> this, instead of re-polling specific issues/PRs one at a time.",
    {
      all:           z.boolean().optional().describe("If true, include notifications already marked as read (default: false — unread only)"),
      participating: z.boolean().optional().describe("If true, only show notifications where the token owner is directly @mentioned or involved (not just watching) (default: false)"),
      owner:         z.string().optional().describe("Restrict to a single repository owner. Omit for all repos the token can see."),
      repo:          z.string().optional().describe("Restrict to a single repository (requires owner). Omit for all repos."),
      per_page:      z.number().optional().describe("Number of notifications to return, max 100 (default: 30)"),
    },
    async ({ all = false, participating = false, owner, repo, per_page = 30 }) => {
      const query = new URLSearchParams({ all: String(all), participating: String(participating), per_page: String(per_page) });
      const endpoint = owner && repo
        ? `/repos/${owner}/${repo}/notifications?${query}`
        : `/notifications?${query}`;
      const data = await githubRequest(endpoint);
      if (!data.length) return { content: [{ type: "text", text: all ? "No notifications." : "No unread notifications." }] };
      const icon = (reason) => ({
        mention: "💬", review_requested: "👀", assign: "📌", author: "✍️",
        comment: "💬", state_change: "🔄", ci_activity: "🏗️",
      }[reason] || "🔔");
      const lines = data.map((n) =>
        `${icon(n.reason)} [${n.reason}] ${n.subject.type}: ${n.subject.title}\n` +
        `  ${n.repository.full_name} | updated ${n.updated_at.slice(0, 16).replace("T", " ")}${n.unread ? "" : " (read)"}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );
}
