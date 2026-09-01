// ---------------------------------------------------------------------------
// connectors/github/clone_token.js — get_repo_clone_token tool.
// See app_auth.js's file header for the full design rationale (why this
// exists, why the token has to pass through the calling model, why it's
// NOT cached server-side -- every call mints a fresh one-time token).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { DEFAULT_OWNER } from "../../config.js";
import { getCloneToken } from "./app_auth.js";

export function register(server) {
  server.tool(
    "get_repo_clone_token",
    "DOES: Mint a fresh, single-use, single-repo, READ-AND-WRITE GitHub token (upgraded 2026-09-01 from read-only, at the repo owner's explicit request) for cloning AND pushing to a PRIVATE repo, plus the exact `git clone` command to run with it.\n" +
    "RULE: PUBLIC repo -> plain `git clone https://github.com/{owner}/{repo}.git` still works with no token for read access -- github.com/codeload.github.com/raw.githubusercontent.com are already on the sandbox's network allowlist. Use this tool instead when you need a credential that can PUSH, even to a public repo, since the sandbox has none by default.\n" +
    "RULE: every call mints a brand-new token -- there is no server-side reuse, so calling this again for the same repo costs a fresh mint each time.\n" +
    "SCOPE: contents:write (includes read), single repo, auto-revoked by this server a few minutes after minting regardless of GitHub's own ~1hr TTL -- effectively single-use. This token CAN push -- treat it as a real write credential, not merely a clone convenience.\n" +
    "CAUTION: the token appears in your context via this tool's response -- use it immediately for the one clone/push. It will stop working shortly after regardless of what you do with it, so there's no benefit to persisting it to a file, env var, or shell history entry, and no reason to repeat it back or log it anywhere else. Because this token can now write, double-check the intended branch and commit before pushing with it -- there is no separate confirmation step here.",
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
        `Freshly minted token (contents:write, ${owner}/${repo} only -- can push, not just clone), GitHub-issued expiry ${result.expiresAt} -- but this server will auto-revoke it a few minutes from now regardless, so it's single-use in practice, not just in intent.\n\n` +
        `Run this in your sandbox to clone:\n` +
        `git clone ${cloneUrl}\n\n` +
        `It can also be used to push (e.g. via 'git remote set-url' then 'git push') before it's revoked. Use it now -- it won't be reusable shortly after, whether or not you reference it again.`;
      return { content: [{ type: "text", text }] };
    }
  );
}
