// ---------------------------------------------------------------------------
// connectors/cloudflare/d1.js — D1 database tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";
import { textResult, capArray } from "../output.js";

// Default cap on rows returned per statement by cf_d1_query. Large result sets
// are pasted into the model's context, so callers must opt in to more.
export const DEFAULT_MAX_ROWS = 50;

// D1 responds with an array of statement results: [{ results: [...rows], success, meta }].
// Truncate each statement's rows and say how many were omitted.
export function capD1Rows(data, maxRows) {
  if (!maxRows || !Array.isArray(data)) return data;
  return data.map((stmt) => {
    if (!stmt || !Array.isArray(stmt.results)) return stmt;
    const { items, omitted } = capArray(stmt.results, maxRows);
    if (!omitted) return stmt;
    return {
      ...stmt,
      results: items,
      rows_omitted: omitted,
      note: `Showing ${items.length} of ${stmt.results.length} rows. Add LIMIT/OFFSET or a WHERE clause, or raise max_rows (0 = no row cap).`,
    };
  });
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
  // part of this tool (it lives in the separate guarded cf_delete tool).
  server.tool(
    "cf_d1_manage",
    "DOES: Create D1 databases in your Cloudflare account. MUTATES Cloudflare state. Use `action` to pick.\n" +
    "RULE: action 'create' requires name; optional primary_location_hint (wnam|enam|weur|eeur|apac|oc).\n" +
    "NOT: deleting a database -> cf_delete.",
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

  // Renamed from cf_d1_database_query; behavior unchanged.
  server.tool(
    "cf_d1_query",
    "Run a SQL query against a D1 database in your Cloudflare account. NOTE: executes the SQL as given, so it can modify data.\n" +
    "RULE: results are capped to max_rows rows per statement (default 50) to keep output small; prefer selecting only the columns you need and using LIMIT/WHERE. Pass max_rows 0 to disable the row cap.",
    {
      database_id: z.string(),
      sql: z.string(),
      params: z.array(z.string()).optional(),
      max_rows: z.number().optional().describe(`Max rows returned per statement (default ${DEFAULT_MAX_ROWS}; 0 = no row cap). Truncated output says how many rows were omitted.`),
    },
    async ({ database_id, sql, params, max_rows }) => {
      const data = await cfAccountRequest(`/d1/database/${database_id}/query`, { method: "POST", body: { sql, params } });
      return textResult(capD1Rows(data, max_rows ?? DEFAULT_MAX_ROWS));
    }
  );
}
