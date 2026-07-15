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
    "cf_hyperdrive_configs_list",
    "List Hyperdrive configurations in your Cloudflare account",
    {
      page: z.number().optional(),
      per_page: z.number().optional(),
      order: z.enum(["id", "name"]).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
    },
    async ({ page, per_page, order, direction }) => {
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
    "cf_hyperdrive_config_get",
    "Get details of a specific Hyperdrive configuration in your Cloudflare account",
    { hyperdrive_id: z.string() },
    async ({ hyperdrive_id }) => textResult(await cfAccountRequest(`/hyperdrive/configs/${hyperdrive_id}`))
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
