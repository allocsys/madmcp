// ---------------------------------------------------------------------------
// connectors/cloudflare/kv.js — Workers KV namespace tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

export function register(server) {
  // Replaces the former cf_kv_namespace (get | list). Requests and output are
  // unchanged.
  server.tool(
    "cf_kv_read",
    "DOES: Read KV namespaces in your Cloudflare account. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'get' requires namespace_id and returns that single namespace.\n" +
    "RULE: action 'list' lists all KV namespaces; optional page, per_page, order, direction.\n" +
    "RULE: page/per_page/order/direction apply to 'list' only.",
    {
      action: z.enum(["get", "list"]).describe("Which operation to perform"),
      namespace_id: z.string().optional().describe("The namespace ID. Required for action 'get'."),
      page: z.number().optional().describe("Page number. Used by 'list' only."),
      per_page: z.number().optional().describe("Results per page. Used by 'list' only."),
      order: z.enum(["id", "title"]).optional().describe("Sort field. Used by 'list' only."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction. Used by 'list' only."),
    },
    async ({ action, namespace_id, page, per_page, order, direction }) => {
      if (action === "get") {
        if (!namespace_id) return errorResult("action 'get' requires namespace_id.");
        return textResult(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`));
      }

      if (action === "list") {
        const params = new URLSearchParams();
        if (page) params.set("page", String(page));
        if (per_page) params.set("per_page", String(per_page));
        if (order) params.set("order", order);
        if (direction) params.set("direction", direction);
        const qs = params.toString() ? `?${params.toString()}` : "";
        return textResult(await cfAccountRequest(`/storage/kv/namespaces${qs}`));
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );

  // Replaces the former cf_kv_namespace_create and cf_kv_namespace_update.
  // Deletion is intentionally not part of this tool (it lives in the
  // separate guarded cf_delete tool).
  server.tool(
    "cf_kv_manage",
    "DOES: Create or rename KV namespaces in your Cloudflare account. MUTATES Cloudflare state. Use `action` to pick.\n" +
    "RULE: action 'create' requires title and creates a new namespace.\n" +
    "RULE: action 'update' requires namespace_id and title and renames that namespace.\n" +
    "RULE: namespace_id applies to 'update' only.\n" +
    "NOT: deleting a namespace -> cf_delete.",
    {
      action: z.enum(["create", "update"]).describe("Which operation to perform"),
      namespace_id: z.string().optional().describe("The namespace ID. Required for action 'update'."),
      title: z.string().optional().describe("Namespace title. Required for actions 'create' and 'update'."),
    },
    async ({ action, namespace_id, title }) => {
      if (action === "create") {
        if (title === undefined) return errorResult("action 'create' requires title.");
        return textResult(await cfAccountRequest("/storage/kv/namespaces", { method: "POST", body: { title } }));
      }

      if (action === "update") {
        const missing = [];
        if (namespace_id === undefined) missing.push("namespace_id");
        if (title === undefined) missing.push("title");
        if (missing.length) return errorResult(`action 'update' requires ${missing.join(" and ")}.`);
        return textResult(
          await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`, { method: "PUT", body: { title } })
        );
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );
}
