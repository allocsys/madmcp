// ---------------------------------------------------------------------------
// connectors/cloudflare/hyperdrive.js — Hyperdrive config tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function register(server) {
  server.tool(
    "cf_hyperdrive_config",
    "DOES: Get a single Hyperdrive configuration (pass hyperdrive_id), OR list all Hyperdrive configurations in your Cloudflare account (omit hyperdrive_id).\n" +
    "RULE: hyperdrive_id set -> page/per_page/order/direction ignored.",
    {
      hyperdrive_id: z.string().optional().describe("If provided, fetch this single configuration instead of listing."),
      page: z.number().optional().describe("Page number when listing. Ignored if hyperdrive_id is given."),
      per_page: z.number().optional().describe("Results per page when listing. Ignored if hyperdrive_id is given."),
      order: z.enum(["id", "name"]).optional().describe("Sort field when listing. Ignored if hyperdrive_id is given."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction when listing. Ignored if hyperdrive_id is given."),
    },
    async ({ hyperdrive_id, page, per_page, order, direction }) => {
      if (hyperdrive_id) {
        return textResult(await cfAccountRequest(`/hyperdrive/configs/${hyperdrive_id}`));
      }
      const params = new URLSearchParams();
      if (page) params.set("page", String(page));
      if (per_page) params.set("per_page", String(per_page));
      if (order) params.set("order", order);
      if (direction) params.set("direction", direction);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return textResult(await cfAccountRequest(`/hyperdrive/configs${qs}`));
    }
  );

  server.tool(
    "cf_hyperdrive_config_update",
    "Update (patch) a Hyperdrive configuration in your Cloudflare account",
    {
      hyperdrive_id: z.string(),
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
    async ({ hyperdrive_id, ...patch }) => {
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
  );

  server.tool(
    "cf_hyperdrive_config_delete",
    "Delete a Hyperdrive configuration in your Cloudflare account",
    { hyperdrive_id: z.string() },
    async ({ hyperdrive_id }) =>
      textResult(await cfAccountRequest(`/hyperdrive/configs/${hyperdrive_id}`, { method: "DELETE" }))
  );
}
