// ---------------------------------------------------------------------------
// connectors/cloudflare/r2.js — R2 bucket tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function register(server) {
  server.tool(
    "cf_r2_bucket",
    "DOES: Get a single R2 bucket (pass name), OR list all R2 buckets in your Cloudflare account (omit name).\n" +
    "RULE: name set -> cursor/direction/name_contains/per_page/start_after ignored.",
    {
      name: z.string().optional().describe("If provided, fetch this single bucket instead of listing."),
      cursor: z.string().optional().describe("Pagination cursor when listing. Ignored if name is given."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction when listing. Ignored if name is given."),
      name_contains: z.string().optional().describe("Filter buckets by name substring when listing. Ignored if name is given."),
      per_page: z.number().optional().describe("Results per page when listing. Ignored if name is given."),
      start_after: z.string().optional().describe("Start listing after this bucket name. Ignored if name is given."),
    },
    async ({ name, cursor, direction, name_contains, per_page, start_after }) => {
      if (name) {
        return textResult(await cfAccountRequest(`/r2/buckets/${name}`));
      }
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (direction) params.set("direction", direction);
      if (name_contains) params.set("name_contains", name_contains);
      if (per_page) params.set("per_page", String(per_page));
      if (start_after) params.set("start_after", start_after);
      const qs = params.toString() ? `?${params.toString()}` : "";
      return textResult(await cfAccountRequest(`/r2/buckets${qs}`));
    }
  );

  server.tool(
    "cf_r2_bucket_create",
    "Create a new r2 bucket in your Cloudflare account",
    { name: z.string() },
    async ({ name }) => textResult(await cfAccountRequest("/r2/buckets", { method: "POST", body: { name } }))
  );

  server.tool(
    "cf_r2_bucket_delete",
    "Delete an R2 bucket",
    { name: z.string() },
    async ({ name }) => textResult(await cfAccountRequest(`/r2/buckets/${name}`, { method: "DELETE" }))
  );
}
