// ---------------------------------------------------------------------------
// connectors/github/repo_mgmt.js — repo lifecycle tool
//
// Consolidated per plan-madmcp-github-tools-overhaul: create_repo, fork_repo,
// sync_fork, delete_repo (and the set_topics write path moved over from
// repo_metadata) merged into one repo_lifecycle tool, dispatched on `action`.
//
// get_file_at_commit moved to repo_inspect ('at_commit' action). gh_token
// lives in clone_token.js and is untouched.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  // ── Repo lifecycle (create / fork / sync_fork / delete / set_topics) ─────

  server.tool(
    "repo_lifecycle",
    "DOES: Create, fork, sync, delete a GitHub repository, or replace its topics. Use `action` to pick. Every action here MUTATES GitHub state.\n" +
    "RULE: action 'create' requires name. If the repo's initial content already exists locally (e.g. files already written in the sandbox) rather than being built here file-by-file, don't call this to create an empty repo and then push files one at a time via create_repo_file/edit_file. Instead: gh_token to mint a fresh push-capable token, then push the local files directly with git/gh (e.g. `gh repo create owner/name --source=. --push`, or `git init && git remote add origin ... && git push`). Faster, and preserves local commit history if there is one.\n" +
    "RULE: action 'fork' requires owner AND repo (the SOURCE repo to fork). Forking is async on GitHub's side — the returned repo may take a few seconds to become fully clone-able.\n" +
    "RULE: action 'sync_fork' requires repo and branch (owner defaults if omitted). Only works on actual forks, and only fast-forwards (no conflict resolution) — if the branch has diverged with local commits ahead of upstream, it reports that a merge is needed instead.\n" +
    "RULE: action 'delete' PERMANENTLY and IRREVERSIBLY deletes the repository (all code, issues, PRs, history). Requires repo AND confirm: true; without confirm: true nothing is deleted.\n" +
    "RULE: action 'set_topics' requires repo and topics, and REPLACES all existing topics (pass [] to clear). Reading topics is repo_metadata's 'topics' action.",
    {
      action:              z.enum(["create", "fork", "sync_fork", "delete", "set_topics"]).describe("Which operation to perform."),
      owner:               z.string().optional().describe(`Repository owner. Required for 'fork' (owner of the repo being forked). For 'sync_fork', 'delete', and 'set_topics', defaults to "${DEFAULT_OWNER}" if omitted. Ignored by 'create' (use org).`),
      repo:                z.string().optional().describe("Repository name. Required for 'fork' (repo to fork), 'sync_fork' (the fork), 'delete', and 'set_topics'. Ignored by 'create' (use name)."),
      name:                z.string().optional().describe("For 'create': repository name (no spaces), required. For 'fork': optional new name for the fork (omit to keep the original name). Ignored otherwise."),
      description:         z.string().optional().describe("Short description of the repository. Used by 'create' only."),
      private:             z.boolean().optional().describe("Whether the new repo is private (default: false). Used by 'create' only."),
      auto_init:           z.boolean().optional().describe("Initialize with a README (default: false). Used by 'create' only."),
      org:                 z.string().optional().describe("Organization to create the repo under. Omit to create under the authenticated user. Used by 'create' only."),
      organization:        z.string().optional().describe("Org to fork into. Omit to fork into the authenticated user's account. Used by 'fork' only."),
      default_branch_only: z.boolean().optional().describe("Fork only the default branch (default: false — forks all branches). Used by 'fork' only."),
      branch:              z.string().optional().describe("Branch to sync. Required for 'sync_fork'; ignored otherwise."),
      confirm:             z.boolean().optional().describe("Must be explicitly true for 'delete' to proceed. Safety guard against accidental deletion — deletion is irreversible and cannot be undone. Ignored by other actions."),
      topics:              z.array(z.string()).optional().describe("Full replacement list of topics. Required for 'set_topics' (use [] to clear all topics); ignored otherwise."),
    },
    async ({ action, owner, repo, name, description, private: isPrivate = false, auto_init = false, org, organization, default_branch_only, branch, confirm, topics }) => {

      if (action === "create") {
        if (!name) {
          return { content: [{ type: "text", text: "action 'create' requires name (the new repository's name)." }], isError: true };
        }
        const endpoint = org ? `/orgs/${org}/repos` : "/user/repos";
        const data = await githubRequest(endpoint, {
          method: "POST",
          body: { name, description, private: isPrivate, auto_init },
        });
        return {
          content: [{
            type: "text",
            text: `Created ${data.private ? "private" : "public"} repo: ${data.full_name}\n${data.html_url}`,
          }],
        };
      }

      if (action === "fork") {
        if (!owner || !repo) {
          return { content: [{ type: "text", text: "action 'fork' requires both owner and repo (the source repository to fork)." }], isError: true };
        }
        const body = {};
        if (organization) body.organization = organization;
        if (name) body.name = name;
        if (default_branch_only !== undefined) body.default_branch_only = default_branch_only;
        const data = await githubRequest(`/repos/${owner}/${repo}/forks`, {
          method: "POST",
          body,
        });
        return {
          content: [{
            type: "text",
            text: `Forked ${owner}/${repo} → ${data.full_name}\n${data.html_url}\n(fork may take a few seconds to finish populating)`,
          }],
        };
      }

      // Remaining actions all target an existing repo, owner defaults.
      const targetOwner = owner ?? DEFAULT_OWNER;
      if (!repo) {
        return { content: [{ type: "text", text: `action '${action}' requires repo parameter.` }], isError: true };
      }

      if (action === "sync_fork") {
        if (!branch) {
          return { content: [{ type: "text", text: "action 'sync_fork' requires branch (the branch to sync)." }], isError: true };
        }
        const data = await githubRequest(`/repos/${targetOwner}/${repo}/merge-upstream`, {
          method: "POST",
          body: { branch },
        });
        return {
          content: [{
            type: "text",
            text: `${data.merge_type === "fast-forward" ? "✅" : "ℹ️"} ${targetOwner}/${repo}:${branch} — ${data.message}\nMerge type: ${data.merge_type}\nNow at: ${data.base_branch}`,
          }],
        };
      }

      if (action === "set_topics") {
        if (topics === undefined) {
          return { content: [{ type: "text", text: "action 'set_topics' requires topics (array of strings; [] clears all topics)." }], isError: true };
        }
        await githubRequest(`/repos/${targetOwner}/${repo}/topics`, {
          method: "PUT",
          body: { names: topics },
          accept: "application/vnd.github.mercy-preview+json",
        });
        return { content: [{ type: "text", text: `Updated topics for ${targetOwner}/${repo}: ${topics.join(", ") || "(none)"}` }] };
      }

      // action === "delete"
      // PRECISION-PASS: confirm guard. Originally enforced at schema level via
      // z.literal(true); with a shared action schema it must be enforced here
      // instead. This check is the ONLY thing standing between a stray call
      // and permanent repo deletion — do not weaken or reorder it.
      if (confirm !== true) {
        return {
          content: [{
            type: "text",
            text: `Refused: "${targetOwner}/${repo}" was NOT deleted. Deleting a repository is irreversible and permanently destroys all code, issues, PRs, and history. Re-call with action: "delete" and confirm: true to proceed.`,
          }],
          isError: true,
        };
      }
      await githubRequest(`/repos/${targetOwner}/${repo}`, { method: "DELETE" });
      return {
        content: [{
          type: "text",
          text: `🗑️ Deleted ${targetOwner}/${repo} permanently.`,
        }],
      };
    }
  );
}
