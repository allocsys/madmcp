// ---------------------------------------------------------------------------
// connectors/github/codespace_manage.js — GitHub Codespaces tool
//
// Consolidated per plan-madmcp-github-tools-overhaul (group 8): merges
//   list_codespaces, get_codespace, list_codespace_machines,
//   create_codespace, start_codespace, stop_codespace, delete_codespace
//   (was codespaces.js)
// into one codespace_manage tool dispatched on `action`:
//   list | get | machines | create | start | stop | delete
//
// exec_in_codespace is NOT part of this tool: it stays in codespaces.js as
// its own conditionally-registered tool (CODE_EXEC_ENABLED).
//
// Every request, output format and default below was moved verbatim from the
// original tools. What changed is only the dispatch and the fact that
// required-ness is now enforced in the handler (the schema is shared, so
// per-action required params can't live in it).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

export function register(server) {

  server.tool(
    "codespace_manage",
    "DOES: Manage GitHub Codespaces for the authenticated user. Use `action` to pick. 'list', 'get' and 'machines' are READ-ONLY; 'create', 'start', 'stop' and 'delete' MUTATE GitHub state.\n" +
    "RULE: 'list' takes optional repo (+ owner) to scope the list to one repository; omit repo to list codespaces across all repos. owner only applies when repo is given, and defaults if omitted.\n" +
    "RULE: 'get' needs codespace_name (e.g. from 'list'). Returns full details of a single codespace.\n" +
    "RULE: 'machines' needs repo + ref (owner defaults). Lists the valid machine types available for creating a codespace on that repository at that ref. Use it to pick a value for 'create's `machine` param.\n" +
    "RULE: 'create' needs repo + ref (owner defaults); optional machine and devcontainer_path. Async: state is 'Provisioning' on return, ~30-90s until 'Available'. Poll 'get' to confirm.\n" +
    "RULE: 'start' needs codespace_name. Starts a stopped codespace.\n" +
    "RULE: 'stop' needs codespace_name. Stops a running codespace. Async: state is 'ShuttingDown' on return, ~30-60s until 'Shutdown'. Poll 'get' to confirm.\n" +
    "RULE: 'delete' needs codespace_name. PERMANENTLY and IRREVERSIBLY deletes the codespace -- use with caution.\n" +
    "RULE: codespace_name applies to 'get', 'start', 'stop' and 'delete' only; ref to 'machines' and 'create'; machine/devcontainer_path to 'create' only. Running commands inside a codespace is a separate tool (exec_in_codespace), only available when enabled on the server.",
    {
      action:            z.enum(["list", "get", "machines", "create", "start", "stop", "delete"]).describe("Which operation to perform."),
      owner:             z.string().optional().describe(`Repository owner. Used by 'list' (only when repo is given), 'machines' and 'create'. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:              z.string().optional().describe("Repository name. Required for 'machines' and 'create'. For 'list': optional, scopes the list to this repo (omit to list codespaces across all repos)."),
      codespace_name:    z.string().optional().describe("The codespace's name (e.g. from 'list'). Required for 'get', 'start', 'stop' and 'delete'."),
      ref:               z.string().optional().describe("Branch, tag, or commit SHA. Required for 'machines' (to check machine availability for) and 'create' (to create the codespace from)."),
      machine:           z.string().optional().describe("Machine type (e.g. 'basicLinux32gb'). Omit to let GitHub pick a default. Use 'machines' to see valid values for a repo. Used by 'create' only."),
      devcontainer_path: z.string().optional().describe("Path to a devcontainer.json to use, relative to repo root. Used by 'create' only."),
    },
    async ({ action, owner, repo, codespace_name, ref, machine, devcontainer_path }) => {

      if ((action === "machines" || action === "create") && !repo) {
        return fail(`action '${action}' requires repo parameter.`);
      }
      if ((action === "machines" || action === "create") && !ref) {
        return fail(`action '${action}' requires ref (branch, tag, or commit SHA).`);
      }
      if (["get", "start", "stop", "delete"].includes(action) && !codespace_name) {
        return fail(`action '${action}' requires codespace_name (the codespace's name, from 'list').`);
      }

      // ── list (was list_codespaces) ────────────────────────────────────────
      if (action === "list") {
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

      // ── get (was get_codespace) ───────────────────────────────────────────
      if (action === "get") {
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

      // ── machines (was list_codespace_machines) ────────────────────────────
      if (action === "machines") {
        const machineOwner = owner ?? DEFAULT_OWNER;
        let path = `/repos/${machineOwner}/${repo}/codespaces/machines`;
        if (ref) path += `?ref=${encodeURIComponent(ref)}`;

        const data = await githubRequest(path);
        if (!data.machines || data.machines.length === 0) {
          return { content: [{ type: "text", text: `No available machine types for ${machineOwner}/${repo}${ref ? `@${ref}` : ""}.` }] };
        }

        const lines = data.machines.map((m) =>
          `- ${m.name}: ${m.display_name} (${m.cpus} vCPU, ${Math.round(m.memory_in_bytes / 1024 / 1024 / 1024)}GB RAM, ${Math.round(m.storage_in_bytes / 1024 / 1024 / 1024)}GB storage)${m.prebuild_availability ? ` [prebuild: ${m.prebuild_availability}]` : ""}`
        );
        return {
          content: [{
            type: "text",
            text: `Available machine types for ${machineOwner}/${repo}${ref ? `@${ref}` : ""}:\n${lines.join("\n")}`,
          }],
        };
      }

      // ── create (was create_codespace) ─────────────────────────────────────
      if (action === "create") {
        const createOwner = owner ?? DEFAULT_OWNER;
        const body = {};
        if (ref) body.ref = ref;
        if (machine) body.machine = machine;
        if (devcontainer_path) body.devcontainer_path = devcontainer_path;

        const cs = await githubRequest(`/repos/${createOwner}/${repo}/codespaces`, {
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

      // ── start (was start_codespace) ───────────────────────────────────────
      if (action === "start") {
        const cs = await githubRequest(`/user/codespaces/${codespace_name}/start`, { method: "POST" });
        return {
          content: [{ type: "text", text: `▶️ ${cs.name} — state: ${cs.state}` }],
        };
      }

      // ── stop (was stop_codespace) ─────────────────────────────────────────
      if (action === "stop") {
        const cs = await githubRequest(`/user/codespaces/${codespace_name}/stop`, { method: "POST" });
        return {
          content: [{ type: "text", text: `⏹️ ${cs.name} — state: ${cs.state}` }],
        };
      }

      // ── delete (was delete_codespace) ─────────────────────────────────────
      // PRECISION-PASS: irreversible. The original tool had no confirm
      // parameter, so none is added here (no behavior change); the
      // irreversibility warning lives in the top-level description.
      // action === "delete"
      await githubRequest(`/user/codespaces/${codespace_name}`, { method: "DELETE" });
      return {
        content: [{ type: "text", text: `🗑️ Deleted codespace ${codespace_name} permanently.` }],
      };
    }
  );
}
