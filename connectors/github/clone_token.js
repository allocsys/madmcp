// ---------------------------------------------------------------------------
// connectors/github/clone_token.js — gh_token tool.
// See app_auth.js's file header for the full design rationale (why this
// exists, why the token has to pass through the calling model, why it's
// NOT cached server-side -- every call mints a fresh one-time token).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { DEFAULT_OWNER } from "../../config.js";
import { getCloneToken } from "./app_auth.js";

// GitHub owner logins: alphanumerics and single hyphens; repo names: alphanumerics, '.', '_', '-'.
// Rejecting anything else keeps odd input out of the request path and the clone URL.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

export function register(server) {
  server.tool(
    "gh_token",
    "DOES: Mint a read-and-write (contents:write) GitHub token for ONE repo and return the `git clone` command. Use it to clone a PRIVATE repo, or to PUSH to any repo (the sandbox has no credential).\n" +
    "RULE: PUBLIC repo, read only -> plain `git clone https://github.com/{owner}/{repo}.git`, no token needed.\n" +
    "RULE: every call mints a new token. The server auto-revokes it within minutes: use it immediately, do not persist or repeat it.\n" +
    "CAUTION: the token can push. Check the branch and commit before pushing.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
    },
    async ({ owner = DEFAULT_OWNER, repo }) => {
      if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") {
        return { content: [{ type: "text", text: `Invalid owner/repo: "${owner}/${repo}".` }], isError: true };
      }
      let result;
      try {
        result = await getCloneToken(owner, repo);
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      const cloneUrl = `https://x-access-token:${result.token}@github.com/${owner}/${repo}.git`;
      const text =
        `Token: ${owner}/${repo} only, contents:write (can push), auto-revoked in minutes.\n` +
        `Clone: git clone ${cloneUrl}\n` +
        `After cloning: git remote set-url origin https://github.com/${owner}/${repo}.git`;
      return { content: [{ type: "text", text }] };
    }
  );
}
