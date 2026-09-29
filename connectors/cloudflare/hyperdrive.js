// ---------------------------------------------------------------------------
// connectors/cloudflare/hyperdrive.js — Hyperdrive config tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

import { textResult } from "../output.js";

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

export function register(server) {
  // Replaces the former cf_hyperdrive_config (get | list). Requests and output
  // are unchanged.
  server.tool(
    "cf_hyperdrive_read",
    "DOES: Read Hyperdrive configurations in your Cloudflare account. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'get' requires hyperdrive_id and returns that single configuration.\n" +
    "RULE: action 'list' lists all Hyperdrive configurations; optional page, per_page, order, direction.\n" +
    "RULE: page/per_page/order/direction apply to 'list' only.",
    {
      action: z.enum(["get", "list"]).describe("Which operation to perform"),
      hyperdrive_id: z.string().optional().describe("The configuration ID. Required for action 'get'."),
      page: z.number().optional().describe("Page number. Used by 'list' only."),
      per_page: z.number().optional().describe("Results per page. Used by 'list' only."),
      order: z.enum(["id", "name"]).optional().describe("Sort field. Used by 'list' only."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction. Used by 'list' only."),
    },
    async ({ action, hyperdrive_id, page, per_page, order, direction }) => {
      if (action === "get") {
        if (!hyperdrive_id) return errorResult("action 'get' requires hyperdrive_id.");
        return textResult(await cfAccountRequest(`/hyperdrive/configs/${hyperdrive_id}`));
      }

      if (action === "list") {
        const params = new URLSearchParams();
        if (page) params.set("page", String(page));
        if (per_page) params.set("per_page", String(per_page));
        if (order) params.set("order", order);
        if (direction) params.set("direction", direction);
        const qs = params.toString() ? `?${params.toString()}` : "";
        return textResult(await cfAccountRequest(`/hyperdrive/configs${qs}`));
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );

  // Replaces the former cf_hyperdrive_config_update. Deletion is intentionally
  // not part of this tool (it lives in the separate guarded cf_delete tool).
  server.tool(
    "cf_hyperdrive_manage",
    "DOES: Update (patch) Hyperdrive configurations in your Cloudflare account. MUTATES Cloudflare state. Use `action` to pick.\n" +
    "RULE: action 'update' requires hyperdrive_id; only the fields you pass are patched (name, origin fields, caching fields).\n" +
    "NOT: deleting a configuration -> cf_delete.",
    {
      action: z.enum(["update"]).describe("Which operation to perform"),
      hyperdrive_id: z.string().optional().describe("The configuration ID. Required for action 'update'."),
      name: z.string().optional(),
      database: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      scheme: z.enum(["postgresql"]).optional(),
      user: z.string().optional(),
      caching_disabled: z.boolean().optional(),
      caching_max_age: z.number().optional(),
      caching_stale_while_revalidate: z.number().optional(),
    },
    async ({ action, hyperdrive_id, ...patch }) => {
      if (action === "update") {
        if (hyperdrive_id === undefined) return errorResult("action 'update' requires hyperdrive_id.");
        const body = {};
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.database || patch.host || patch.port || patch.scheme || patch.user) {
          body.origin = {
            ...(patch.database ? { database: patch.database } : {}),
            ...(patch.host ? { host: patch.host } : {}),
            ...(patch.port ? { port: patch.port } : {}),
            ...(patch.scheme ? { scheme: patch.scheme } : {}),
            ...(patch.user ? { user: patch.user } : {}),
          };
        }
        if (patch.caching_disabled !== undefined || patch.caching_max_age !== undefined || patch.caching_stale_while_revalidate !== undefined) {
          body.caching = {
            ...(patch.caching_disabled !== undefined ? { disabled: patch.caching_disabled } : {}),
            ...(patch.caching_max_age !== undefined ? { max_age: patch.caching_max_age } : {}),
            ...(patch.caching_stale_while_revalidate !== undefined ? { stale_while_revalidate: patch.caching_stale_while_revalidate } : {}),
          };
        }
        return textResult(await cfAccountRequest(`/hyperdrive/configs/${hyperdrive_id}`, { method: "PATCH", body }));
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );
}
