// ---------------------------------------------------------------------------
// connectors/cloudflare/delete.js — guarded delete tool
//
// Replaces cf_d1_database_delete, cf_kv_namespace_delete, cf_r2_bucket_delete
// and cf_hyperdrive_config_delete with one cf_delete tool. Deletion is kept
// out of the *_manage tools on purpose: every delete here needs an explicit
// confirm: true (same pattern as mem0_delete / repo_lifecycle 'delete').
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

const RESOURCES = {
  d1: { label: "D1 database", path: (id) => `/d1/database/${id}` },
  kv: { label: "KV namespace", path: (id) => `/storage/kv/namespaces/${id}` },
  r2: { label: "R2 bucket", path: (id) => `/r2/buckets/${id}` },
  hyperdrive: { label: "Hyperdrive configuration", path: (id) => `/hyperdrive/configs/${id}` },
};

export function register(server) {
  server.tool(
    "cf_delete",
    "DOES: Delete a D1 database, KV namespace, R2 bucket or Hyperdrive configuration in your Cloudflare account. MUTATES Cloudflare state and is IRREVERSIBLE.\n" +
    "RULE: requires resource, id AND confirm: true; without confirm: true nothing is deleted.\n" +
    "RULE: id is the database ID for 'd1', the namespace ID for 'kv', the bucket NAME for 'r2', and the configuration ID for 'hyperdrive'.\n" +
    "NOT: creating or updating -> cf_d1_manage / cf_kv_manage / cf_r2_manage / cf_hyperdrive_manage.",
    {
      resource: z.enum(["d1", "kv", "r2", "hyperdrive"]).describe("Which kind of resource to delete"),
      id: z.string().optional().describe("Database ID (d1), namespace ID (kv), bucket name (r2) or configuration ID (hyperdrive). Required."),
      confirm: z.boolean().optional().describe("Must be explicitly true for the delete to proceed. Safety guard: deletion is irreversible."),
    },
    async ({ resource, id, confirm }) => {
      const target = RESOURCES[resource];
      if (!target) return errorResult(`Unknown resource '${resource}'.`);
      if (!id) return errorResult(`cf_delete requires id (the ${target.label} to delete).`);

      // This check is the ONLY thing standing between a stray call and a
      // permanent delete -- do not weaken or reorder it.
      if (confirm !== true) {
        return errorResult(
          `Refused: ${target.label} "${id}" was NOT deleted. Deletion is irreversible. ` +
          `Re-call cf_delete with resource: "${resource}", id: "${id}" and confirm: true to proceed.`
        );
      }

      return textResult(await cfAccountRequest(target.path(id), { method: "DELETE" }));
    }
  );
}
