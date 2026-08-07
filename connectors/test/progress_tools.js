// ---------------------------------------------------------------------------
// connectors/test/progress_tools.js — diagnostic tool only.
// Emits a series of notifications/progress messages during a single tool
// call, then returns a final result. Used to empirically test whether a
// given MCP client surfaces mid-call progress notifications as visible
// content, or only as an opaque progress bar (or nothing at all).
//
// Safe to delete once the test is done — this has no dependency from any
// other connector and no side effects beyond sending notifications.
// ---------------------------------------------------------------------------

import { z } from "zod";

export function register(server) {
  server.tool(
    "test_progress_notifications",
    "DIAGNOSTIC TOOL: emits `steps` notifications/progress messages roughly 1s apart, then returns a final text result.\n" +
    "Use this to test whether the connected MCP client surfaces mid-call progress text, before wiring real progress " +
    "reporting into any production tool. If a progressToken is not supplied in the request _meta, no notifications " +
    "are sent (this is a no-op passthrough in that case) and only the final result is returned.",
    {
      steps: z.number().optional().describe("Number of progress steps to emit before returning (default 4)"),
    },
    async ({ steps = 4 }, { sendNotification, _meta }) => {
      const progressToken = _meta?.progressToken;
      const sent = [];

      for (let i = 1; i <= steps; i++) {
        if (progressToken !== undefined) {
          const message = `Step ${i} of ${steps}`;
          await sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: i, total: steps, message },
          });
          sent.push(message);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const summary = progressToken !== undefined
        ? `Done. Emitted ${sent.length} progress notification(s): ${sent.join(", ")}.`
        : `Done. No progressToken was present in the request _meta, so no progress notifications were sent (this is expected behavior, not an error).`;

      return { content: [{ type: "text", text: summary }] };
    }
  );
}
