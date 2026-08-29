// ---------------------------------------------------------------------------
// connectors/github/releases.js — releases & tags tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  server.tool(
    "list_releases",
    "List releases in a GitHub repository.",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of releases to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=${per_page}`);
      if (!data.length) return { content: [{ type: "text", text: "No releases found." }] };
      const lines = data.map((r) =>
        `${r.tag_name} — ${r.name || "(no name)"}${r.draft ? " [DRAFT]" : ""}${r.prerelease ? " [PRE-RELEASE]" : ""}\n  Published: ${r.published_at?.slice(0, 10) ?? "unpublished"} | ${r.html_url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );

  server.tool(
    "create_release",
    "Create a new release in a GitHub repository.",
    {
      owner:            z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:             z.string().describe("Repository name"),
      tag_name:         z.string().describe("Tag name for the release (e.g. 'v1.2.0')"),
      name:             z.string().optional().describe("Release title"),
      body:             z.string().optional().describe("Release notes (markdown supported)"),
      draft:            z.boolean().optional().describe("Create as a draft release (default: false)"),
      prerelease:       z.boolean().optional().describe("Mark as a pre-release (default: false)"),
      target_commitish: z.string().optional().describe("Branch or commit SHA the tag should point to"),
    },
    async ({ owner = DEFAULT_OWNER, repo, tag_name, name, body, draft = false, prerelease = false, target_commitish }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/releases`, {
        method: "POST",
        body: { tag_name, name, body, draft, prerelease, target_commitish },
      });
      return { content: [{ type: "text", text: `Created release "${data.name || data.tag_name}"${draft ? " (draft)" : ""}.\n${data.html_url}` }] };
    }
  );

  server.tool(
    "list_tags",
    "List tags in a GitHub repository.",
    {
      owner:    z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:     z.string().describe("Repository name"),
      per_page: z.number().optional().describe("Number of tags to return, max 100 (default: 20)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/tags?per_page=${per_page}`);
      if (!data.length) return { content: [{ type: "text", text: "No tags found." }] };
      const lines = data.map((t) => `${t.name}  ${t.commit.sha.slice(0, 7)}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
