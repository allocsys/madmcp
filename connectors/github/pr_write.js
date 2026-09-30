// ---------------------------------------------------------------------------
// connectors/github/pr_write.js — pull request write tool
//
// Consolidated per plan-madmcp-github-tools-overhaul (group 5): merges
//   create_pull_request, update_pull_request, merge_pull_request,
//   review_pull_request          (were prs.js)
//   request_reviewers, remove_requested_reviewers, add_review_comment
//                                (were review_control.js)
// into one pr_write tool dispatched on `action`:
//   create | update | merge | review | request_reviewers | remove_reviewers | inline_comment
//
// Every request, output format, default and thrown error below was moved
// verbatim from the original tools. What changed is only the dispatch and
// the fact that required-ness is now enforced in the handler (the schema is
// shared, so per-action required params can't live in it).
//
// PRECISION-PASS: 'update' keeps the `ready: true` path as a distinct GraphQL
// branch (markPullRequestReadyForReview) -- REST has no draft->ready field, so
// it cannot be folded into the same PATCH as title/body/state/base.
// PRECISION-PASS: 'merge' is irreversible via this tool; that framing lives in
// the top-level description below.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { waitUntil } from "@vercel/functions";
import { githubRequest, githubGraphQL } from "./client.js";
import { DEFAULT_OWNER, COMMIT_LOG_ENABLED } from "../../config.js";
import { recordCommit } from "../notion/commit_log.js";

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

export function register(server) {

  server.tool(
    "pr_write",
    "DOES: Create, update, merge and review pull requests, manage reviewers, and post inline diff comments. MUTATES GitHub state. Use `action` to pick.\n" +
    "RULE: 'merge' is IRREVERSIBLE via this tool -- there is no unmerge. Confirm intent before calling it.\n" +
    "RULE: 'create' needs owner + repo + title + head (source branch) + base (target branch, e.g. 'main'); optional body, draft (default false).\n" +
    "RULE: 'update' needs owner + repo + pull_number and at least one of title, body, state (open|closed), base, ready. Pass only the field(s) to change. ready=true only converts draft -> ready (no-op with notice if already non-draft); no API path exists to convert ready back to draft. body replaces the existing description entirely.\n" +
    "RULE: 'merge' needs owner + repo + pull_number; optional merge_method (merge|squash|rebase, default merge), commit_title, commit_message.\n" +
    "RULE: 'review' needs owner + repo + pull_number + event (APPROVE|REQUEST_CHANGES|COMMENT); optional body. This is a formal whole-PR verdict. NOT a plain conversation reply -> use issue_manage 'comment' for that (works on PRs too, since PRs are issues under the hood).\n" +
    "RULE: 'request_reviewers' needs repo + pull_number (owner defaults) and at least one of reviewers / team_reviewers (same as clicking 'Request review' in the GitHub UI). NOT submitting a verdict yourself -> use 'review' for that.\n" +
    "RULE: 'remove_reviewers' needs repo + pull_number (owner defaults) and at least one of reviewers / team_reviewers. Cancels a pending review request; does not affect reviews already submitted.\n" +
    "RULE: 'inline_comment' needs repo + pull_number (owner defaults) + commit_id + path + line + body. Anchors a comment to a diff line (same as clicking a line in GitHub's 'Files changed' view). commit_id is typically the PR's current head SHA (from pr_read 'get' or repo_inspect 'list_commits'). NOT a whole-PR verdict -> use 'review'. NOT a general non-anchored conversation comment -> issue_manage 'comment'.\n" +
    "RULE: title/head/base/draft/state/ready apply to 'create'/'update' only; merge_method/commit_title/commit_message to 'merge' only; event to 'review' only; reviewers/team_reviewers to 'request_reviewers'/'remove_reviewers' only; commit_id/path/line/side/start_line/start_side to 'inline_comment' only. body applies to 'create', 'update', 'review' and 'inline_comment'.",
    {
      action:         z.enum(["create", "update", "merge", "review", "request_reviewers", "remove_reviewers", "inline_comment"]).describe("Which operation to perform."),
      owner:          z.string().optional().describe(`Repository owner (user or org). REQUIRED for 'create', 'update', 'merge' and 'review'; for 'request_reviewers', 'remove_reviewers' and 'inline_comment' defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:           z.string().optional().describe("Repository name. Required for every action."),
      pull_number:    z.number().optional().describe("Pull request number. Required for every action except 'create'."),
      title:          z.string().optional().describe("PR title. Required for 'create'; optional new title for 'update'."),
      head:           z.string().optional().describe("The branch containing the changes (source branch). Required for 'create'."),
      base:           z.string().optional().describe("Required for 'create': the branch to merge into (target branch, e.g. 'main'). For 'update': optional new base branch this PR merges into."),
      body:           z.string().optional().describe("Text body. 'create': PR description. 'update': new PR description (replaces the existing description entirely). 'review': review comment body. 'inline_comment': comment text (required)."),
      draft:          z.boolean().optional().describe("Open as a draft PR (default: false). Used by 'create' only."),
      state:          z.enum(["open", "closed"]).optional().describe("Set to 'closed' to close the PR without merging, or 'open' to reopen it. Used by 'update' only."),
      // GitHub's REST API has no field for draft->ready, so this runs the markPullRequestReadyForReview GraphQL mutation under the hood instead.
      ready:          z.boolean().optional().describe("Set to true to convert a draft PR to ready for review (default: unchanged). Used by 'update' only."),
      merge_method:   z.enum(["merge", "squash", "rebase"]).optional().describe("Merge strategy (default: merge). Used by 'merge' only."),
      commit_title:   z.string().optional().describe("Title for the merge commit. Used by 'merge' only."),
      commit_message: z.string().optional().describe("Body for the merge commit. Used by 'merge' only."),
      event:          z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional().describe("Review action. Required for 'review'."),
      reviewers:      z.array(z.string()).optional().describe("GitHub usernames to request review from ('request_reviewers') or remove from the review request ('remove_reviewers')."),
      team_reviewers: z.array(z.string()).optional().describe("Team slugs (org teams) to request review from ('request_reviewers', e.g. 'platform-team') or remove from the review request ('remove_reviewers')."),
      commit_id:      z.string().optional().describe("SHA of the commit being commented on -- typically the PR's current head SHA. Required for 'inline_comment'."),
      path:           z.string().optional().describe("File path (relative to repo root) the comment applies to. Required for 'inline_comment'."),
      line:           z.number().optional().describe("Line number in the file (as shown in the diff) to attach the comment to. For a multi-line comment, this is the LAST line of the range. Required for 'inline_comment'."),
      side:           z.enum(["LEFT", "RIGHT"]).optional().describe("Which side of the diff `line` refers to -- RIGHT for the new/added version, LEFT for the old/removed version (default: RIGHT). Used by 'inline_comment' only."),
      start_line:     z.number().optional().describe("First line of a multi-line comment range. Omit for a single-line comment. Must be on the same side as `line` and less than it. Used by 'inline_comment' only."),
      start_side:     z.enum(["LEFT", "RIGHT"]).optional().describe("Side of the diff `start_line` refers to (default: same as `side`). Only used with `start_line` on 'inline_comment'."),
    },
    async ({ action, owner, repo, pull_number, title, head, base, body, draft, state, ready, merge_method, commit_title, commit_message, event, reviewers, team_reviewers, commit_id, path, line, side, start_line, start_side }) => {

      if (!repo) return fail(`action '${action}' requires repo parameter.`);

      // These four originally required an explicit owner (no default); keep
      // that rather than silently targeting DEFAULT_OWNER. Only the
      // review-control actions ever defaulted it.
      const ownerRequired = action === "create" || action === "update" || action === "merge" || action === "review";
      if (ownerRequired && !owner) {
        return fail(`action '${action}' requires owner (the repository owner, a user or org).`);
      }
      if (!ownerRequired) owner = owner ?? DEFAULT_OWNER;

      if (action !== "create" && pull_number === undefined) {
        return fail(`action '${action}' requires pull_number (the pull request number).`);
      }

      // ── create (was create_pull_request) ──────────────────────────────────
      if (action === "create") {
        if (title === undefined) return fail("action 'create' requires title.");
        if (head === undefined)  return fail("action 'create' requires head (the source branch containing the changes).");
        if (base === undefined)  return fail("action 'create' requires base (the target branch, e.g. 'main').");
        const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          body: { title, head, base, body, draft: draft ?? false },
        });
        return { content: [{ type: "text", text: `Created PR #${data.number}: "${data.title}"\n${data.html_url}` }] };
      }

      // ── update (was update_pull_request) ──────────────────────────────────
      if (action === "update") {
        const patch = {};
        if (title !== undefined) patch.title = title;
        if (body !== undefined) patch.body = body;
        if (state !== undefined) patch.state = state;
        if (base !== undefined) patch.base = base;

        if (Object.keys(patch).length === 0 && ready !== true) {
          return { content: [{ type: "text", text: ready === false ? "Nothing to update: ready: false is a no-op (no API path converts a PR back to draft). Pass at least one of title, body, state, base, or ready: true." : "No fields provided to update — pass at least one of title, body, state, base, or ready." }] };
        }

        // Order matters: converting draft -> ready cannot be undone (no API
        // path back to draft), so it runs LAST. If the PATCH fails, nothing
        // has been converted; if the conversion fails, the (reversible) PATCH
        // is reported as applied instead of being silently half-done.
        let patchMsg = "";
        if (Object.keys(patch).length > 0) {
          const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`, {
            method: "PATCH",
            body: patch,
          });
          const updated = Object.keys(patch).join(", ");
          patchMsg = `Updated PR #${pull_number} (${updated}).\n${data.html_url}`;
        }

        let readyMsg = "";
        if (ready === true) {
          try {
            const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
            if (!pr.draft) {
              readyMsg = `PR #${pull_number} is already ready for review (not a draft) — no change made.`;
            } else {
              await githubGraphQL(
                `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`,
                { id: pr.node_id }
              );
              readyMsg = `PR #${pull_number} converted from draft to ready for review.`;
            }
          } catch (e) {
            if (patchMsg) throw new Error(`${patchMsg}\nHowever, converting the PR to ready for review failed: ${e.message}`, { cause: e });
            throw e;
          }
        }

        return { content: [{ type: "text", text: [readyMsg, patchMsg].filter(Boolean).join("\n\n") }] };
      }

      // ── merge (was merge_pull_request) ────────────────────────────────────
      if (action === "merge") {
        const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
          method: "PUT",
          body: { merge_method: merge_method ?? "merge", commit_title, commit_message },
        });
        // Commit log (best-effort, never affects the merge result). The merge
        // response carries no branch/file info, so log the PR number instead.
        if (COMMIT_LOG_ENABLED && data.sha) {
          try {
            waitUntil(recordCommit({ sha: data.sha, message: commit_title || `Merge PR #${pull_number} (${repo})`, files: [`PR #${pull_number}`], branch: "merge", ts: new Date().toISOString() }));
          } catch (_) {}
        }
        return { content: [{ type: "text", text: `Merged PR #${pull_number}: ${data.message}\nCommit: ${data.sha?.slice(0, 7) ?? "n/a"}` }] };
      }

      // ── review (was review_pull_request) ──────────────────────────────────
      if (action === "review") {
        if (event === undefined) return fail("action 'review' requires event (APPROVE | REQUEST_CHANGES | COMMENT).");
        const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
          method: "POST",
          body: { event, body },
        });
        return { content: [{ type: "text", text: `Submitted review #${data.id} (${event}) on PR #${pull_number}.` }] };
      }

      // ── request_reviewers (was request_reviewers) ─────────────────────────
      if (action === "request_reviewers") {
        if (!reviewers?.length && !team_reviewers?.length) {
          return fail("Provide at least one of reviewers or team_reviewers.");
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

      // ── remove_reviewers (was remove_requested_reviewers) ─────────────────
      if (action === "remove_reviewers") {
        if (!reviewers?.length && !team_reviewers?.length) {
          return fail("Provide at least one of reviewers or team_reviewers.");
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

      // ── inline_comment (was add_review_comment) ───────────────────────────
      if (commit_id === undefined) return fail("action 'inline_comment' requires commit_id (the SHA being commented on, typically the PR's head SHA).");
      if (path === undefined)      return fail("action 'inline_comment' requires path (file path relative to repo root).");
      if (line === undefined)      return fail("action 'inline_comment' requires line (the diff line to attach the comment to).");
      if (body === undefined)      return fail("action 'inline_comment' requires body (the comment text).");
      const commentSide = side ?? "RIGHT";
      const payload = { commit_id, path, line, side: commentSide, body };
      if (start_line !== undefined) {
        if (start_line >= line) {
          return fail("start_line must be less than line for a multi-line comment.");
        }
        payload.start_line = start_line;
        payload.start_side = start_side || commentSide;
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/comments`, {
        method: "POST",
        body: payload,
      });
      const rangeDesc = start_line !== undefined ? `${start_line}-${line}` : `${line}`;
      return { content: [{ type: "text", text: `Added inline comment on ${path}:${rangeDesc} (PR #${pull_number}).\n${data.html_url}` }] };
    }
  );
}
