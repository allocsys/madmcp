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
    "DOES: Mint (or reuse a still-valid server-cached) short-lived, single-repo, read-only GitHub token for cloning a PRIVATE repo, plus the exact `git clone` command to run with it.\n" +
    "RULE: PUBLIC repo -> don't use this. `git clone https://github.com/{owner}/{repo}.git` directly in the sandbox works with no token -- github.com/codeload.github.com/raw.githubusercontent.com are already on its network allowlist.\n" +
    "RULE: token is cached server-side per repo -- calling this again for the same repo shortly after is cheap (reuses the cached token), not a fresh mint every time.\n" +
    "SCOPE: contents:read only, single repo, ~1hr TTL (GitHub's max), never write access.\n" +
    "CAUTION: the token appears in your context via this tool's response -- use it immediately for the one clone command, then treat it as spent. Do not persist it to a file, env var, or shell history entry beyond that single command, and do not repeat it back or log it anywhere else.",
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
        `Token ${result.cached ? "reused from server-side cache" : "freshly minted"}, expires ${result.expiresAt} (contents:read, ${owner}/${repo} only).\n\n` +
        `Run this in your sandbox to clone:\n` +
        `git clone ${cloneUrl}\n\n` +
        `This token is single-use-in-intent: use it for this clone now, then don't reference it again -- it isn't reusable across sessions and shouldn't be persisted anywhere.`;
      return { content: [{ type: "text", text }] };
    }
  );
}
