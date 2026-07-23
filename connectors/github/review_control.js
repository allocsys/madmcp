// ---------------------------------------------------------------------------
// connectors/github/review_control.js — reviewer assignment, merge
// readiness, inline review comments, branch protection (read), and
// notifications. Complements prs.js (which submits whole-PR reviews but
// can't request reviewers or surface merge conflicts) and actions.js/
// ci_control.js (commit-level CI state, not PR-level review state).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "request_reviewers",
    "Request review from specific users and/or teams on a pull request. Distinct from review_pull_request, which submits a review verdict (approve/comment/request-changes) — this instead asks someone else to review, the same as clicking 'Request review' in the GitHub UI.",
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
    "Cancel a pending review request from specific users and/or teams on a pull request (does not affect reviews already submitted).",
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
    "get_pr_mergeability",
    "Check whether a pull request can be merged: mergeable state, merge conflicts, and required-check status. GitHub computes `mergeable` asynchronously, so a null result on first call means 'still computing' — this tool retries briefly before giving up. Use this instead of inferring conflicts manually from a failed merge attempt or a stale diff.",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
    },
    async ({ owner = DEFAULT_OWNER, repo, pull_number }) => {
      let pr;
      for (let attempt = 0; attempt < 4; attempt++) {
        pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
        if (pr.mergeable !== null) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1200));
      }

      const stateMeaning = {
        clean:     "No conflicts, all checks pass — ready to merge.",
        dirty:     "Merge conflicts — the branch needs to be updated before it can merge.",
        unstable:  "Mergeable, but some non-required checks are failing.",
        blocked:   "Blocked — a required check is failing or hasn't run, or a required review is missing.",
        behind:    "Branch is out of date with the base branch and needs updating (required by branch protection).",
        draft:     "PR is a draft.",
        unknown:   "GitHub is still computing mergeability — try again shortly.",
      };

      const text =
        `PR #${pull_number}: ${pr.title}\n` +
        `mergeable: ${pr.mergeable === null ? "still computing" : pr.mergeable}\n` +
        `mergeable_state: ${pr.mergeable_state}${stateMeaning[pr.mergeable_state] ? ` — ${stateMeaning[pr.mergeable_state]}` : ""}\n` +
        `rebaseable: ${pr.rebaseable === null ? "unknown" : pr.rebaseable}\n` +
        `${pr.head.label} → ${pr.base.label}`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "add_review_comment",
    "Add an inline review comment anchored to a specific line in a pull request's diff — the same as clicking a line in the GitHub 'Files changed' view and leaving a comment there. Distinct from review_pull_request (whole-PR verdict + summary body) and add_issue_comment (general, non-anchored PR conversation comment).",
    {
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:        z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      commit_id:   z.string().describe("SHA of the commit being commented on — typically the PR's current head SHA (from get_pull_requests or list_commits)"),
      path:        z.string().describe("File path (relative to repo root) the comment applies to"),
      line:        z.number().describe("Line number in the file (as shown in the diff) to attach the comment to"),
      side:        z.enum(["LEFT", "RIGHT"]).optional().describe("Which side of the diff the line refers to — RIGHT for the new/added version, LEFT for the old/removed version (default: RIGHT)"),
      body:        z.string().describe("Comment text"),
    },
    async ({ owner = DEFAULT_OWNER, repo, pull_number, commit_id, path, line, side = "RIGHT", body }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/comments`, {
        method: "POST",
        body: { commit_id, path, line, side, body },
      });
      return { content: [{ type: "text", text: `Added inline comment on ${path}:${line} (PR #${pull_number}).\n${data.html_url}` }] };
    }
  );

  server.tool(
    "get_branch_protection",
    "Read the branch protection rules for a branch — required status checks, required approving reviews, whether admins are exempt, and whether force-pushes/deletions are blocked. Read-only; explains upfront why a PR might be gated (e.g. 'requires 1 approval from a code owner') instead of that being discovered empirically from a rejected merge.",
    {
      owner:  z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:   z.string().describe("Repository name"),
      branch: z.string().describe("Branch name, e.g. 'main'"),
    },
    async ({ owner = DEFAULT_OWNER, repo, branch }) => {
      let data;
      try {
        data = await githubRequest(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`);
      } catch (err) {
        if (/404/.test(err.message)) {
          return { content: [{ type: "text", text: `Branch '${branch}' has no protection rules configured.` }] };
        }
        throw err;
      }

      const reviews = data.required_pull_request_reviews;
      const checks  = data.required_status_checks;
      const lines = [
        `Branch protection for '${branch}':`,
        `  Required approving reviews: ${reviews ? reviews.required_approving_review_count : 0}${reviews?.require_code_owner_reviews ? " (code owner review required)" : ""}`,
        `  Dismiss stale reviews on new commits: ${reviews?.dismiss_stale_reviews ? "yes" : "no"}`,
        `  Required status checks: ${checks?.contexts?.length ? checks.contexts.join(", ") : "(none)"}`,
        `  Require branches up to date before merge: ${checks?.strict ? "yes" : "no"}`,
        `  Enforce for admins: ${data.enforce_admins?.enabled ? "yes" : "no"}`,
        `  Allow force pushes: ${data.allow_force_pushes?.enabled ? "yes" : "no"}`,
        `  Allow deletions: ${data.allow_deletions?.enabled ? "yes" : "no"}`,
        `  Linear history required: ${data.required_linear_history?.enabled ? "yes" : "no"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "list_notifications",
    "List GitHub notifications for the authenticated token (PR/issue mentions, review requests, comment replies, CI failures on watched runs, etc.) — the same feed as github.com/notifications. Use this to check 'did anyone reply to me' or 'is anything waiting on me' without re-polling specific issues/PRs one at a time.",
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
