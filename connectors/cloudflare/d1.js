// ---------------------------------------------------------------------------
// connectors/cloudflare/d1.js — D1 database tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function register(server) {
  server.tool(
    "cf_d1_database",
    "DOES: Get a single D1 database (pass database_id), OR list all D1 databases in your Cloudflare account (omit database_id).\n" +
    "RULE: database_id set -> name/page/per_page ignored.",
    {
      database_id: z.string().optional().describe("If provided, fetch this single database instead of listing."),
      name: z.string().optional().describe("Filter by database name when listing. Ignored if database_id is given."),
      page: z.number().optional().describe("Page number when listing. Ignored if database_id is given."),
      per_page: z.number().optional().describe("Results per page when listing. Ignored if database_id is given."),
    },
    async ({ database_id, name, page, per_page }) => {
      if (database_id) {
        return textResult(await cfAccountRequest(`/d1/database/${database_id}`));
      }
      const params = new URLSearchParams();
      if (name) params.set("name", name);
      if (page) params.set("page", String(page));
      if (per_page) params.set("per_page", String(per_page));
      const qs = params.toString() ? `?${params.toString()}` : "";
      const result = await cfAccountRequest(`/d1/database${qs}`);
      return textResult(result);
    }
  );

  server.tool(
    "cf_d1_database_create",
    "Create a new D1 database in your Cloudflare account",
    {
      name: z.string(),
      primary_location_hint: z.enum(["wnam", "enam", "weur", "eeur", "apac", "oc"]).optional(),
    },
    async ({ name, primary_location_hint }) =>
      textResult(await cfAccountRequest("/d1/database", { method: "POST", body: { name, primary_location_hint } }))
  );

  server.tool(
    "cf_d1_database_delete",
    "Delete a D1 database in your Cloudflare account",
    { database_id: z.string() },
    async ({ database_id }) =>
      textResult(await cfAccountRequest(`/d1/database/${database_id}`, { method: "DELETE" }))
  );

  server.tool(
    "cf_d1_database_query",
    "Query a D1 database in your Cloudflare account",
    {
      database_id: z.string(),
      sql: z.string(),
      params: z.array(z.string()).optional(),
    },
    async ({ database_id, sql, params }) =>
      textResult(await cfAccountRequest(`/d1/database/${database_id}/query`, { method: "POST", body: { sql, params } }))
  );
}
