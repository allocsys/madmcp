// ---------------------------------------------------------------------------
// connectors/mem/delete.js — consolidated Mem0 delete tool
//
// Consolidation of the old mem0_delete, mem0_delete_batch and mem0_delete_all
// into one mem0_delete tool dispatched on `action` ("one" | "batch" | "all").
// Behavior, request shapes and messages are identical to the originals; only
// required-ness moved from the zod schema into the handler (so a missing
// param for the chosen action returns a clear isError result).
//
// NOTE: the new tool reuses the name "mem0_delete" (the old single-delete
// tool). Callers must now pass action: "one" with memory_id.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { mem0Request } from "./client.js";
import { MEM0_USER_ID } from "../../config.js";

export function register(server) {
  server.tool(
    "mem0_delete",
    "DOES: Permanently delete Mem0 memories. IRREVERSIBLE. Use `action` to pick.\n" +
    "RULE: action 'one' requires memory_id and deletes that single memory.\n" +
    "RULE: action 'batch' requires memory_ids (non-empty) and deletes each in parallel; returns a per-item success/failure report.\n" +
    "RULE: action 'all' requires confirm: true and bulk-deletes every memory matching the filters in one server-side call (no IDs needed). At least one filter must resolve (defaults to your own user_id ONLY if no filter at all is given). WARNING: filters are not implicitly combined with user_id — agent_id, app_id, run_id or metadata alone match across ALL users in the project, so pass user_id as well to stay within one user's memories. Pass '*' as a filter value to match ALL entities of that type (e.g. user_id: '*' deletes memories for every user in the whole project) — combine all four id filters with '*' for a full project wipe.\n" +
    "RULE: memory_id applies to 'one' only; memory_ids to 'batch' only; user_id/agent_id/app_id/run_id/metadata/confirm to 'all' only.",
    {
      action:     z.enum(["one", "batch", "all"]).describe("Which operation to perform"),
      memory_id:  z.string().optional().describe("The memory ID to delete. Required for action 'one'."),
      memory_ids: z.array(z.string()).optional().describe("List of memory IDs to delete. Required (non-empty) for action 'batch'."),
      user_id:    z.string().optional().describe(`Filter by user ID. Pass '*' to delete memories for all users. Defaults to ${MEM0_USER_ID} if no filters are given at all. Used by 'all' only.`),
      agent_id:   z.string().optional().describe("Filter by agent ID. Pass '*' to delete memories for all agents. Used by 'all' only."),
      app_id:     z.string().optional().describe("Filter by app ID. Pass '*' to delete memories for all apps. Used by 'all' only."),
      run_id:     z.string().optional().describe("Filter by run ID. Pass '*' to delete memories for all runs. Used by 'all' only."),
      metadata:   z.record(z.any()).optional().describe("Filter by metadata (sent as a JSON-encoded query param; exact-match semantics are up to Mem0 and not verified by this connector). Not user-scoped on its own — combine with user_id. Used by 'all' only."),
      confirm:    z.boolean().optional().describe("Must be explicitly set to true to execute the bulk deletion. Safety guard against accidental bulk wipes — 'all' refuses to run without it. Required for action 'all'."),
    },
    async ({ action, memory_id, memory_ids, user_id, agent_id, app_id, run_id, metadata, confirm }) => {

      if (action === "one") {
        if (!memory_id) {
          return { content: [{ type: "text", text: "action 'one' requires memory_id." }], isError: true };
        }
        await mem0Request(`/v1/memories/${memory_id}/`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Deleted memory (ID: ${memory_id}).` }] };
      }

      if (action === "batch") {
        if (!memory_ids?.length) {
          return { content: [{ type: "text", text: "action 'batch' requires memory_ids (at least one ID)." }], isError: true };
        }
        const results = await Promise.allSettled(
          memory_ids.map((id) => mem0Request(`/v1/memories/${id}/`, { method: "DELETE" }))
        );
        const lines = results.map((r, i) =>
          r.status === "fulfilled"
            ? `✓ Deleted: ${memory_ids[i]}`
            : `✗ Failed:  ${memory_ids[i]} — ${r.reason?.message || r.reason}`
        );
        const deleted = results.filter((r) => r.status === "fulfilled").length;
        return {
          content: [{
            type: "text",
            text: `${deleted}/${memory_ids.length} deleted.\n\n${lines.join("\n")}`,
          }],
        };
      }

      // action === "all"
      if (!confirm) {
        return {
          content: [{ type: "text", text: "Refused: this would bulk-delete memories server-side and cannot be undone. Re-call with confirm: true to proceed." }],
          isError: true,
        };
      }
      // Mem0 itself rejects a filterless call, but fail fast with a clearer
      // message and a safe default (caller's own scope) rather than letting
      // an empty filter set fall through to an ambiguous 400 from the API.
      if (!user_id && !agent_id && !app_id && !run_id && !metadata) {
        user_id = MEM0_USER_ID;
      }
      const params = new URLSearchParams();
      if (user_id) params.set("user_id", user_id);
      if (agent_id) params.set("agent_id", agent_id);
      if (app_id) params.set("app_id", app_id);
      if (run_id) params.set("run_id", run_id);
      if (metadata) params.set("metadata", JSON.stringify(metadata));
      const data = await mem0Request(`/v1/memories/?${params.toString()}`, { method: "DELETE" });
      const wildcardScope = [user_id, agent_id, app_id, run_id].includes("*");
      const notUserScoped = !user_id;
      const scopeDesc = [
        user_id    && `user_id=${user_id}`,
        agent_id   && `agent_id=${agent_id}`,
        app_id     && `app_id=${app_id}`,
        run_id     && `run_id=${run_id}`,
        metadata   && `metadata=${JSON.stringify(metadata)}`,
      ].filter(Boolean).join(", ");
      return {
        content: [{
          type: "text",
          text: `${data?.message || "Memories deleted."} (scope: ${scopeDesc})${wildcardScope ? " — wildcard used, this may have affected multiple entities." : ""}${notUserScoped ? " — no user_id filter was given, so this was not restricted to a single user." : ""}`,
        }],
      };
    }
  );
}
