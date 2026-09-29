// ---------------------------------------------------------------------------
// connectors/cloudflare/r2.js — R2 bucket tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

import { textResult } from "../output.js";

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

export function register(server) {
  // Replaces the former cf_r2_bucket (get | list). Requests and output are
  // unchanged.
  server.tool(
    "cf_r2_read",
    "DOES: Read R2 buckets in your Cloudflare account. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'get' requires name and returns that single bucket.\n" +
    "RULE: action 'list' lists all R2 buckets; optional cursor, direction, name_contains, per_page, start_after.\n" +
    "RULE: cursor/direction/name_contains/per_page/start_after apply to 'list' only.",
    {
      action: z.enum(["get", "list"]).describe("Which operation to perform"),
      name: z.string().optional().describe("The bucket name. Required for action 'get'."),
      cursor: z.string().optional().describe("Pagination cursor. Used by 'list' only."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction. Used by 'list' only."),
      name_contains: z.string().optional().describe("Filter buckets by name substring. Used by 'list' only."),
      per_page: z.number().optional().describe("Results per page. Used by 'list' only."),
      start_after: z.string().optional().describe("Start listing after this bucket name. Used by 'list' only."),
    },
    async ({ action, name, cursor, direction, name_contains, per_page, start_after }) => {
      if (action === "get") {
        if (!name) return errorResult("action 'get' requires name.");
        return textResult(await cfAccountRequest(`/r2/buckets/${name}`));
      }

      if (action === "list") {
        const params = new URLSearchParams();
        if (cursor) params.set("cursor", cursor);
        if (direction) params.set("direction", direction);
        if (name_contains) params.set("name_contains", name_contains);
        if (per_page) params.set("per_page", String(per_page));
        if (start_after) params.set("start_after", start_after);
        const qs = params.toString() ? `?${params.toString()}` : "";
        return textResult(await cfAccountRequest(`/r2/buckets${qs}`));
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );

  // Replaces the former cf_r2_bucket_create. Deletion is intentionally not
  // part of this tool (it lives in the separate guarded cf_delete tool).
  server.tool(
    "cf_r2_manage",
    "DOES: Create R2 buckets in your Cloudflare account. MUTATES Cloudflare state. Use `action` to pick.\n" +
    "RULE: action 'create' requires name and creates a new bucket.\n" +
    "NOT: deleting a bucket -> cf_delete.",
    {
      action: z.enum(["create"]).describe("Which operation to perform"),
      name: z.string().optional().describe("Bucket name. Required for action 'create'."),
    },
    async ({ action, name }) => {
      if (action === "create") {
        if (name === undefined) return errorResult("action 'create' requires name.");
        return textResult(await cfAccountRequest("/r2/buckets", { method: "POST", body: { name } }));
      }

      return errorResult(`Unknown action '${action}'.`);
    }
  );
}
