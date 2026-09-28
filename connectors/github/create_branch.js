// ---------------------------------------------------------------------------
// connectors/github/create_branch.js — standalone create_branch tool
//
// Split out of repo_inspect (which is now strictly read-only) so the one
// mutating branch action lives in its own tool. Behavior is identical to the
// former repo_inspect 'create_branch' action.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

export function register(server) {
  server.tool(
    "create_branch",
    "DOES: Create a new branch in a GitHub repository. MUTATES GitHub state.\n" +
    "RULE: needs owner + repo + branch (the NEW branch's name). owner has NO default here (unlike most other tools), and all three are marked optional in the schema but REQUIRED: a call missing one returns a 'create_branch requires ...' error. Optional from_branch is an existing BRANCH name (tags and SHAs are not supported); default: the repo's default branch.\n" +
    "RULE: listing existing branches is repo_inspect 'list_branches'. Committing to the new branch is edit_file / overwrite_files / create_repo_file / delete_file; opening a PR from it is pr_write 'create'.",
    {
      owner:       z.string().optional().describe("Repository owner (user or org). Required; no default."),
      repo:        z.string().optional().describe("Repository name. Required."),
      branch:      z.string().optional().describe("Name of the NEW branch to create. Required."),
      from_branch: z.string().optional().describe("Existing branch name to branch from (default: repo default branch). Tags and SHAs are not supported."),
    },
    async ({ owner, repo, branch, from_branch }) => {
      if (!repo) return fail("create_branch requires repo parameter.");

      // Originally required an explicit owner (no default); keep that rather
      // than silently targeting DEFAULT_OWNER.
      if (!owner) return fail("create_branch requires owner (the repository owner, a user or org).");
      if (!branch) return fail("create_branch requires branch (the name of the new branch).");

      let baseSha;
      if (from_branch) {
        const baseRef = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`);
        baseSha = baseRef.object.sha;
      } else {
        const repoData = await githubRequest(`/repos/${owner}/${repo}`);
        const baseRef  = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(repoData.default_branch)}`);
        baseSha = baseRef.object.sha;
      }
      await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha: baseSha },
      });
      return { content: [{ type: "text", text: `Created branch '${branch}' in ${owner}/${repo} from ${baseSha.slice(0, 7)}.` }] };
    }
  );
}
