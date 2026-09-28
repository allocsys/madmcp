// ---------------------------------------------------------------------------
// connectors/github/pr_read.js — read-only pull request tool
//
// Consolidated per plan-madmcp-github-tools-overhaul (group 4): merges
//   get_pull_requests (list + single-PR detail, was prs.js),
//   get_pr_activity   (was prs.js),
//   get_pr_mergeability (was review_control.js)
// into one pr_read tool dispatched on `action`:
//   list | get | activity | mergeability
//
// Every request, output format, default and polling budget below was moved
// verbatim from the original tools. What changed is only the dispatch and
// the fact that required-ness is now enforced in the handler (the schema is
// shared, so per-action required params can't live in it).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

// GitHub's `state` field is only "open"/"closed" -- a closed-and-merged PR
// and a closed-without-merging PR both report state: "closed". The list and
// single-PR endpoints both also return `merged_at` (null unless merged), so
// use that to tell the two apart instead of state alone.
function prStatusLabel(pr) {
  if (pr.state === "closed") return pr.merged_at ? "merged" : "closed";
  return pr.state;
}

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

export function register(server) {

  server.tool(
    "pr_read",
    "DOES: Read pull requests. READ-ONLY. Use `action` to pick.\n" +
    "RULE: 'list' needs owner + repo; optional state (open|closed|all, default open) and per_page (default 20). Returns one summary block per PR.\n" +
    "RULE: 'get' needs owner + repo + pull_number and returns that PR's details + comments + reviews + commits (with signature verification) merged into one response. Use include_comments/include_reviews/include_commits=false to trim a section out; max_comments (default 20), max_reviews (default 30), max_commits (default 100) cap each section.\n" +
    "RULE: 'activity' needs owner + repo + pull_number and returns the PR's conversation comments and/or formal reviews (approve/request-changes/comment verdicts). Use `type` (comments|reviews|both, default both) to pick; per_page defaults to 30 here. NOT inline diff comments (no tool currently exposes those).\n" +
    "RULE: 'mergeability' needs repo + pull_number (owner defaults) and checks mergeable state, conflicts and required-check status. It retries briefly server-side (up to 4 polls, ~1.2s apart) since GitHub computes this async. Use it instead of inferring conflicts from a failed merge attempt or a stale diff.\n" +
    "RULE: state/per_page apply to 'list' (and per_page to 'activity') only; the include_*/max_* params apply to 'get' only; type applies to 'activity' only.",
    {
      action:           z.enum(["list", "get", "activity", "mergeability"]).describe("Which operation to perform."),
      owner:            z.string().optional().describe(`Repository owner (user or org). REQUIRED for 'list', 'get', and 'activity'; for 'mergeability' defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:             z.string().optional().describe("Repository name. Required for every action."),
      pull_number:      z.number().optional().describe("Pull request number. Required for 'get', 'activity', and 'mergeability'; ignored by 'list'."),
      state:            z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state (default: open). Used by 'list' only."),
      per_page:         z.number().optional().describe("Number of items to return, max 100. 'list': PRs (default: 20). 'activity': items per type (default: 30). Ignored by 'get' and 'mergeability'."),
      include_comments: z.boolean().optional().describe("Include the PR's conversation comments (default: true). Used by 'get' only."),
      include_reviews:  z.boolean().optional().describe("Include the PR's formal reviews (default: true). Used by 'get' only."),
      // "Verified"/"Unverified" badge below matches the same GitHub-signature check GitHub's own UI shows on each commit.
      include_commits:  z.boolean().optional().describe("Include the PR's commit list with signature verification status (default: true). Used by 'get' only."),
      max_comments:     z.number().optional().describe("Max comments to include, most recent first (default: 20, max: 100). Used by 'get' only."),
      max_reviews:      z.number().optional().describe("Max reviews to include (default: 30, max: 100). Used by 'get' only."),
      max_commits:      z.number().optional().describe("Max commits to include (default: 100, max: 250). Used by 'get' only."),
      type:             z.enum(["comments", "reviews", "both"]).optional().describe("Which activity to fetch (default: both). Used by 'activity' only."),
    },
    async ({ action, owner, repo, pull_number, state = "open", per_page, include_comments = true, include_reviews = true, include_commits = true, max_comments = 20, max_reviews = 30, max_commits = 100, type = "both" }) => {

      if (!repo) return fail(`action '${action}' requires repo parameter.`);

      // These three originally required an explicit owner (no default); keep
      // that rather than silently targeting DEFAULT_OWNER. Only mergeability
      // ever defaulted it.
      if (action !== "mergeability" && !owner) {
        return fail(`action '${action}' requires owner (the repository owner, a user or org).`);
      }

      if (action !== "list" && pull_number === undefined) {
        return fail(`action '${action}' requires pull_number (the pull request number).`);
      }

      // ── list (was get_pull_requests without pull_number) ──────────────────
      if (action === "list") {
        const limit = per_page ?? 20;
        const data = await githubRequest(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${limit}`);
        if (!data.length) return { content: [{ type: "text", text: `No ${state} pull requests found.` }] };
        const lines = data.map((pr) =>
          `#${pr.number} [${prStatusLabel(pr)}] ${pr.title}\n  ${pr.head.label} → ${pr.base.label} | by ${pr.user.login} | ${pr.created_at.slice(0, 10)}\n  ${pr.html_url}`
        );
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      // ── get (was get_pull_requests with pull_number) ──────────────────────
      if (action === "get") {
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

      // ── activity (was get_pr_activity) ────────────────────────────────────
      if (action === "activity") {
        const limit = per_page ?? 30;
        const sections = [];

        if (type === "comments" || type === "both") {
          const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${pull_number}/comments?per_page=${limit}`);
          sections.push(
            comments.length
              ? `${comments.length} comment(s) on PR #${pull_number}:\n\n` + comments.map((c) =>
                  `${c.user.login} (${c.created_at.slice(0, 16).replace("T", " ")}):\n${c.body}\n  ${c.html_url}`
                ).join("\n\n---\n\n")
              : `No comments on PR #${pull_number}.`
          );
        }

        if (type === "reviews" || type === "both") {
          const reviews = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=${limit}`);
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

      // ── mergeability (was get_pr_mergeability) ────────────────────────────
      // action === "mergeability"
      // PRECISION-PASS: this action keeps its OWN poll/retry budget (4 attempts,
      // 1.2s apart) exactly as the standalone tool had it. GitHub computes
      // `mergeable` async; do not share or divide this budget with any other
      // action in this tool.
      const targetOwner = owner ?? DEFAULT_OWNER;
      let pr;
      let polls = 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        pr = await githubRequest(`/repos/${targetOwner}/${repo}/pulls/${pull_number}`);
        polls++;
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

      const mergeableLine = pr.mergeable === null
        ? `mergeable: still computing (polled ${polls}x, ~${(polls - 1) * 1.2}s — GitHub hasn't finished; try again shortly)`
        : `mergeable: ${pr.mergeable}${polls > 1 ? ` (resolved after ${polls} poll(s))` : ""}`;
      const text =
        `PR #${pull_number}: ${pr.title}\n` +
        `${mergeableLine}\n` +
        `mergeable_state: ${pr.mergeable_state}${stateMeaning[pr.mergeable_state] ? ` — ${stateMeaning[pr.mergeable_state]}` : ""}\n` +
        `rebaseable: ${pr.rebaseable === null ? "unknown" : pr.rebaseable}\n` +
        `${pr.head.label} → ${pr.base.label}`;
      return { content: [{ type: "text", text }] };
    }
  );
}
