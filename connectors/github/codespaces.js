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

  // ── List codespace machines ──────────────────────────────────────────────

  server.tool(
    "list_codespace_machines",
    "List the valid machine types available for creating a Codespace on a given repository (and optionally a specific ref). Use this to pick a value for create_codespace's `machine` param.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().describe("Repository name"),
      ref:   z.string().optional().describe("Branch, tag, or commit SHA to check machine availability for (default: repo default branch)"),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref }) => {
      let path = `/repos/${owner}/${repo}/codespaces/machines`;
      if (ref) path += `?ref=${encodeURIComponent(ref)}`;

      const data = await githubRequest(path);
      if (!data.machines || data.machines.length === 0) {
        return { content: [{ type: "text", text: `No available machine types for ${owner}/${repo}${ref ? `@${ref}` : ""}.` }] };
      }

      const lines = data.machines.map((m) =>
        `- ${m.name}: ${m.display_name} (${m.cpus} vCPU, ${Math.round(m.memory_in_bytes / 1024 / 1024 / 1024)}GB RAM, ${Math.round(m.storage_in_bytes / 1024 / 1024 / 1024)}GB storage)${m.prebuild_availability ? ` [prebuild: ${m.prebuild_availability}]` : ""}`
      );
      return {
        content: [{
          type: "text",
          text: `Available machine types for ${owner}/${repo}${ref ? `@${ref}` : ""}:\n${lines.join("\n")}`,
        }],
      };
    }
  );

  // ── Create codespace ─────────────────────────────────────────────────────

  server.tool(
    "create_codespace",
    "Create a new GitHub Codespace for a repository. Creation is async on GitHub's side — the returned state may still be 'Provisioning' or similar for a bit after this returns.",
    {
      owner:            z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:             z.string().describe("Repository name"),
      ref:              z.string().optional().describe("Branch, tag, or commit SHA to create the codespace from (default: repo default branch)"),
      machine:          z.string().optional().describe("Machine type (e.g. 'basicLinux32gb'). Omit to let GitHub pick a default. Use list_codespace_machines to see valid values for a repo."),
      devcontainer_path: z.string().optional().describe("Path to a devcontainer.json to use, relative to repo root"),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref, machine, devcontainer_path }) => {
      const body = {};
      if (ref) body.ref = ref;
      if (machine) body.machine = machine;
      if (devcontainer_path) body.devcontainer_path = devcontainer_path;

      const cs = await githubRequest(`/repos/${owner}/${repo}/codespaces`, {
        method: "POST",
        body,
      });
      return {
        content: [{
          type: "text",
          text: `Created codespace: ${cs.name} [${cs.state}]\n${cs.web_url}`,
        }],
      };
    }
  );

  // ── Start codespace ──────────────────────────────────────────────────────

  server.tool(
    "start_codespace",
    "Start a stopped GitHub Codespace.",
    {
      codespace_name: z.string().describe("The codespace's name"),
    },
    async ({ codespace_name }) => {
      const cs = await githubRequest(`/user/codespaces/${codespace_name}/start`, { method: "POST" });
      return {
        content: [{ type: "text", text: `▶️ ${cs.name} — state: ${cs.state}` }],
      };
    }
  );

  // ── Stop codespace ───────────────────────────────────────────────────────

  server.tool(
    "stop_codespace",
    "Stop a running GitHub Codespace.",
    {
      codespace_name: z.string().describe("The codespace's name"),
    },
    async ({ codespace_name }) => {
      const cs = await githubRequest(`/user/codespaces/${codespace_name}/stop`, { method: "POST" });
      return {
        content: [{ type: "text", text: `⏹️ ${cs.name} — state: ${cs.state}` }],
      };
    }
  );

  // ── Delete codespace ─────────────────────────────────────────────────────

  server.tool(
    "delete_codespace",
    "Permanently delete a GitHub Codespace. This is irreversible — use with caution.",
    {
      codespace_name: z.string().describe("The codespace's name to delete"),
    },
    async ({ codespace_name }) => {
      await githubRequest(`/user/codespaces/${codespace_name}`, { method: "DELETE" });
      return {
        content: [{ type: "text", text: `🗑️ Deleted codespace ${codespace_name} permanently.` }],
      };
    }
  );
}
