// ---------------------------------------------------------------------------
// connectors/github/clone_token.js — get_repo_clone_token tool.
// See app_auth.js's file header for the full design rationale (why this
// exists, why the token has to pass through the calling model, why it's
// cached server-side).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { DEFAULT_OWNER } from "../../config.js";
import { getCloneToken } from "./app_auth.js";

export function register(server) {
  server.tool(
    "get_repo_clone_token",
    "DOES: Mint a fresh, single-use, single-repo, read-only GitHub token for cloning a PRIVATE repo, plus the exact `git clone` command to run with it.\n" +
    "RULE: PUBLIC repo -> don't use this. `git clone https://github.com/{owner}/{repo}.git` directly in the sandbox works with no token -- github.com/codeload.github.com/raw.githubusercontent.com are already on its network allowlist.\n" +
    "RULE: every call mints a brand-new token -- there is no server-side reuse, so calling this again for the same repo costs a fresh mint each time.\n" +
    "SCOPE: contents:read only, single repo, auto-revoked by this server a few minutes after minting regardless of GitHub's own ~1hr TTL -- effectively single-use, never write access.\n" +
    "CAUTION: the token appears in your context via this tool's response -- use it immediately for the one clone command. It will stop working shortly after regardless of what you do with it, so there's no benefit to persisting it to a file, env var, or shell history entry, and no reason to repeat it back or log it anywhere else.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
    },
    async ({ owner = DEFAULT_OWNER, repo }) => {
      let result;
      try {
        result = await getCloneToken(owner, repo);
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      const cloneUrl = `https://x-access-token:${result.token}@github.com/${owner}/${repo}.git`;
      const text =
        `Freshly minted token (contents:read, ${owner}/${repo} only), GitHub-issued expiry ${result.expiresAt} -- but this server will auto-revoke it a few minutes from now regardless, so it's single-use in practice, not just in intent.\n\n` +
        `Run this in your sandbox to clone:\n` +
        `git clone ${cloneUrl}\n\n` +
        `Use it for this clone now -- it won't be reusable shortly after, whether or not you reference it again.`;
      return { content: [{ type: "text", text }] };
    }
  );
}
