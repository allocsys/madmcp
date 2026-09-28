// ---------------------------------------------------------------------------
// connectors/github/search_code.js — standalone search_code tool
//
// Split out of repo_inspect (which is now strictly read-only, git-history
// oriented) into its own tool. Behavior is identical to the former
// repo_inspect 'search' action. The implementation (tarball grep, GraphQL
// line resolution) stays in code_search.js as runSearchCode().
// ---------------------------------------------------------------------------

import { z } from "zod";
import { runSearchCode } from "./code_search.js";

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

export function register(server) {
  server.tool(
    "search_code",
    "DOES: Search code in a GitHub repository at a specific branch, tag, or commit.\n" +
    "RULE: needs query AND ref (branch, tag, or commit SHA), and query MUST contain a repo:owner/name qualifier (there are no separate owner/repo params). GitHub's real /search/code index only ever covers a repo's default branch, so every call uses the local content-search fallback directly instead (fetches the repo as a tarball at `ref` and greps it locally; also sidesteps GitHub's known private-repo search-index gap).\n" +
    "RULE: the remaining query text is matched as ONE literal string: no OR, and qualifiers other than repo: (filename:, extension:, language:) are stripped, not applied as filters. One literal per search.\n" +
    "RULE: tracing something across many back-to-back searches (e.g. a symbol across a codebase) -> delegate_agent instead of chaining this manually. Query is conceptual/semantic (\"where is X handled\") rather than a known literal string -> map.query (mode: search) instead.",
    {
      query:    z.string().optional().describe("Search text, e.g. 'createServer repo:owner/name'. Must include a repo:owner/name qualifier. Other qualifiers (filename:, extension:, language:) are stripped and the remaining text is matched as one literal string (no OR)."),
      ref:      z.string().optional().describe("Branch, tag, or commit SHA to search. Required."),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 20)."),
    },
    async ({ query, ref, per_page }) => {
      if (!query) return fail("search_code requires query (include a repo:owner/name qualifier).");
      if (!ref) return fail("search_code requires ref (branch, tag, or commit SHA). GitHub's search index only covers the default branch, so a specific ref plus a repo:owner/name qualifier in query is required for the branch-aware search.");
      return runSearchCode({ query, per_page: per_page ?? 20, ref });
    }
  );
}
