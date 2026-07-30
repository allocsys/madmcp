// ---------------------------------------------------------------------------
// connectors/cloudflare/kv.js — Workers KV namespace tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function register(server) {
  server.tool(
    "cf_kv_namespace",
    "DOES: Get a single KV namespace (pass namespace_id), OR list all KV namespaces in your Cloudflare account (omit namespace_id).\n" +
    "RULE: namespace_id set -> page/per_page/order/direction ignored.",
    {
      namespace_id: z.string().optional().describe("If provided, fetch this single namespace instead of listing."),
      page: z.number().optional().describe("Page number when listing. Ignored if namespace_id is given."),
      per_page: z.number().optional().describe("Results per page when listing. Ignored if namespace_id is given."),
      order: z.enum(["id", "title"]).optional().describe("Sort field when listing. Ignored if namespace_id is given."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction when listing. Ignored if namespace_id is given."),
    },
    async ({ namespace_id, page, per_page, order, direction }) => {
      if (namespace_id) {
        return textResult(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`));
      }
      const params = new URLSearchParams();
      if (page) params.set("page", String(page));
      if (per_page) params.set("per_page", String(per_page));
      if (order) params.set("order", order);
      if (direction) params.set("direction", direction);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return textResult(await cfAccountRequest(`/storage/kv/namespaces${qs}`));
    }
  );

  server.tool(
    "cf_kv_namespace_create",
    "Create a new kv namespace in your Cloudflare account",
    { title: z.string() },
    async ({ title }) =>
      textResult(await cfAccountRequest("/storage/kv/namespaces", { method: "POST", body: { title } }))
  );

  server.tool(
    "cf_kv_namespace_update",
    "Update the title of a kv namespace in your Cloudflare account",
    { namespace_id: z.string(), title: z.string() },
    async ({ namespace_id, title }) =>
      textResult(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`, { method: "PUT", body: { title } }))
  );

  server.tool(
    "cf_kv_namespace_delete",
    "Delete a kv namespace in your Cloudflare account",
    { namespace_id: z.string() },
    async ({ namespace_id }) =>
      textResult(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`, { method: "DELETE" }))
  );
}
