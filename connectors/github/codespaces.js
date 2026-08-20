// ---------------------------------------------------------------------------
// connectors/github/codespaces.js — GitHub Codespaces tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  // ── List codespaces ──────────────────────────────────────────────────────

  server.tool(
    "list_codespaces",
    "List GitHub Codespaces for the authenticated user, optionally scoped to a single repository.",
    {
      owner: z.string().optional().describe(`Repository owner to scope the list to. Defaults to "${DEFAULT_OWNER}" if "repo" is given and "owner" is omitted.`),
      repo:  z.string().optional().describe("Repository name to scope the list to. Omit to list codespaces across all repos."),
    },
    async ({ owner, repo }) => {
      let path = "/user/codespaces";
      if (repo) {
        const repoOwner = owner || DEFAULT_OWNER;
        const repoData = await githubRequest(`/repos/${repoOwner}/${repo}`);
        path += `?repository_id=${repoData.id}`;
      }

      const data = await githubRequest(path);
      if (!data.codespaces || data.codespaces.length === 0) {
        return { content: [{ type: "text", text: repo ? `No codespaces found for ${owner || DEFAULT_OWNER}/${repo}.` : "No codespaces found." }] };
      }

      const lines = data.codespaces.map((cs) =>
        `- ${cs.name} [${cs.state}] ${cs.repository.full_name}@${cs.git_status.ref} (${cs.machine ? cs.machine.display_name : "unknown machine"})\n  ${cs.web_url}`
      );
      return {
        content: [{
          type: "text",
          text: `${data.total_count} codespace(s):\n${lines.join("\n")}`,
        }],
      };
    }
  );

  // ── Get codespace ────────────────────────────────────────────────────────

  server.tool(
    "get_codespace",
    "Get full details of a single GitHub Codespace by name.",
    {
      codespace_name: z.string().describe("The codespace's name (e.g. from list_codespaces)"),
    },
    async ({ codespace_name }) => {
      const cs = await githubRequest(`/user/codespaces/${codespace_name}`);
      const lines = [
        `${cs.name} [${cs.state}]`,
        `Repo: ${cs.repository.full_name}@${cs.git_status.ref}`,
        `Machine: ${cs.machine ? cs.machine.display_name : "unknown"}`,
        `Created: ${cs.created_at}`,
        `Last used: ${cs.last_used_at}`,
        `URL: ${cs.web_url}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
