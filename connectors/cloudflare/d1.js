// ---------------------------------------------------------------------------
// connectors/cloudflare/d1.js — D1 database tools
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
  // Replaces the former cf_d1_database (get | list). Requests and output are
  // unchanged.
  server.tool(
    "cf_d1_read",
    "DOES: Read D1 databases in your Cloudflare account. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'get' requires database_id and returns that single database.\n" +
    "RULE: action 'list' lists all D1 databases; optional name (filter), page, per_page.\n" +
    "RULE: name/page/per_page apply to 'list' only.",
    {
      action: z.enum(["get", "list"]).describe("Which operation to perform"),
      database_id: z.string().optional().describe("The database ID. Required for action 'get'."),
      name: z.string().optional().describe("Filter by database name. Used by 'list' only."),
      page: z.number().optional().describe("Page number. Used by 'list' only."),
      per_page: z.number().optional().describe("Results per page. Used by 'list' only."),
    },
    async ({ action, database_id, name, page, per_page }) => {
      if (action === "get") {
        if (!database_id) return errorResult("action 'get' requires database_id.");
        return textResult(await cfAccountRequest(`/d1/database/${database_id}`));
      }

      if (action === "list") {
        const params = new URLSearchParams();
        if (name) params.set("name", name);
        if (page) params.set("page", String(page));
        if (per_page) params.set("per_page", String(per_page));
        const qs = params.toString() ? `?${params.toString()}` : "";
        return textResult(await cfAccountRequest(`/d1/database${qs}`));
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );

  // Replaces the former cf_d1_database_create. Deletion is intentionally not
  // part of this tool (it will move to a separate guarded delete tool).
  server.tool(
    "cf_d1_manage",
    "DOES: Create D1 databases in your Cloudflare account. MUTATES Cloudflare state. Use `action` to pick.\n" +
    "RULE: action 'create' requires name; optional primary_location_hint (wnam|enam|weur|eeur|apac|oc).\n" +
    "NOT: deleting a database -> cf_d1_database_delete.",
    {
      action: z.enum(["create"]).describe("Which operation to perform"),
      name: z.string().optional().describe("Name of the new database. Required for action 'create'."),
      primary_location_hint: z.enum(["wnam", "enam", "weur", "eeur", "apac", "oc"]).optional()
        .describe("Optional location hint. Used by 'create' only."),
    },
    async ({ action, name, primary_location_hint }) => {
      if (action === "create") {
        if (name === undefined) return errorResult("action 'create' requires name.");
        return textResult(
          await cfAccountRequest("/d1/database", { method: "POST", body: { name, primary_location_hint } })
        );
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );

  // Kept until the guarded delete tool lands (last group of the overhaul).
  server.tool(
    "cf_d1_database_delete",
    "Delete a D1 database in your Cloudflare account",
    { database_id: z.string() },
    async ({ database_id }) =>
      textResult(await cfAccountRequest(`/d1/database/${database_id}`, { method: "DELETE" }))
  );

  // Renamed from cf_d1_database_query; behavior unchanged.
  server.tool(
    "cf_d1_query",
    "Run a SQL query against a D1 database in your Cloudflare account. NOTE: executes the SQL as given, so it can modify data.",
    {
      database_id: z.string(),
      sql: z.string(),
      params: z.array(z.string()).optional(),
    },
    async ({ database_id, sql, params }) =>
      textResult(await cfAccountRequest(`/d1/database/${database_id}/query`, { method: "POST", body: { sql, params } }))
  );
}
