// ---------------------------------------------------------------------------
// connectors/github/releases.js — releases & tags tool
//
// Consolidated per plan-madmcp-github-tools-overhaul: list_releases,
// create_release, and list_tags merged into one release_manage tool,
// dispatched on `action`. This was the pilot group for the GitHub
// consolidation (lowest risk: three simple, non-overlapping, non-destructive
// single-repo operations).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "release_manage",
    "DOES: List releases, create a release, or list tags in a GitHub repository. Use `action` to pick.\n" +
    "RULE: action 'create' requires tag_name; name/body/draft/prerelease/target_commitish are only used with 'create' and ignored otherwise.\n" +
    "RULE: action 'list' and 'list_tags' both accept per_page; 'create' ignores it.",
    {
      owner:            z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:             z.string().describe("Repository name"),
      action:           z.enum(["list", "create", "list_tags"]).describe("Which operation to perform"),
      per_page:         z.number().optional().describe("Number of releases/tags to return, max 100 (default: 20). Used by 'list' and 'list_tags' only."),
      tag_name:         z.string().optional().describe("Tag name for the release (e.g. 'v1.2.0'). Required for action 'create'."),
      name:             z.string().optional().describe("Release title. Only used with action 'create'."),
      body:             z.string().optional().describe("Release notes (markdown supported). Only used with action 'create'."),
      draft:            z.boolean().optional().describe("Create as a draft release (default: false). Only used with action 'create'."),
      prerelease:       z.boolean().optional().describe("Mark as a pre-release (default: false). Only used with action 'create'."),
      target_commitish: z.string().optional().describe("Branch or commit SHA the tag should point to. Only used with action 'create'."),
    },
    async ({ owner = DEFAULT_OWNER, repo, action, per_page = 20, tag_name, name, body, draft = false, prerelease = false, target_commitish }) => {

      if (action === "list") {
        const data = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=${per_page}`);
        if (!data.length) return { content: [{ type: "text", text: "No releases found." }] };
        const lines = data.map((r) =>
          `${r.tag_name} — ${r.name || "(no name)"}${r.draft ? " [DRAFT]" : ""}${r.prerelease ? " [PRE-RELEASE]" : ""}\n  Published: ${r.published_at?.slice(0, 10) ?? "unpublished"} | ${r.html_url}`
        );
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      if (action === "create") {
        if (!tag_name) {
          return { content: [{ type: "text", text: "action 'create' requires tag_name (e.g. 'v1.2.0')." }], isError: true };
        }
        const data = await githubRequest(`/repos/${owner}/${repo}/releases`, {
          method: "POST",
          body: { tag_name, name, body, draft, prerelease, target_commitish },
        });
        return { content: [{ type: "text", text: `Created release "${data.name || data.tag_name}"${draft ? " (draft)" : ""}.\n${data.html_url}` }] };
      }

      // action === "list_tags"
      const data = await githubRequest(`/repos/${owner}/${repo}/tags?per_page=${per_page}`);
      if (!data.length) return { content: [{ type: "text", text: "No tags found." }] };
      const lines = data.map((t) => `${t.name}  ${t.commit.sha.slice(0, 7)}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
