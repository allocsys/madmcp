// ---------------------------------------------------------------------------
// connectors/cloudflare/workers.js — Workers script inspection tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";
import { textResult, toCompactText, paginateText } from "../output.js";


export function register(server) {
  // Consolidates the former cf_workers_list, cf_workers_get_worker and
  // cf_workers_get_worker_code (action: list | get | code). Requests and output
  // are unchanged; required-ness of scriptName moved from zod into the handler.
  server.tool(
    "cf_workers_read",
    "DOES: Read Cloudflare Workers in your account. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'list' takes no other params and lists all Workers in the account.\n" +
    "RULE: action 'get' requires scriptName and returns that Worker's settings/details.\n" +
    "RULE: action 'code' requires scriptName and returns that Worker's source code. Note: this may be a bundled version of the worker. Large source is paged (default 20000 characters per page): the output says the range shown and the offset to pass next; use offset/limit to read the rest.\n" +
    "RULE: scriptName applies to 'get' and 'code' only; offset and limit (characters) apply to 'code' only.",
    {
      action:     z.enum(["list", "get", "code"]).describe("Which operation to perform"),
      scriptName: z.string().optional().describe("The Worker script name. Required for actions 'get' and 'code'."),
      offset:     z.number().int().min(0).optional().describe("'code' only: character offset to start reading from (default 0). Use the offset given in the previous page's footer."),
      limit:      z.number().int().min(1).optional().describe("'code' only: max characters per page (default 20000)."),
    },
    async ({ action, scriptName, offset, limit }) => {
      if (action === "list") {
        return textResult(await cfAccountRequest("/workers/scripts"));
      }

      if (action === "get") {
        if (!scriptName) {
          return { content: [{ type: "text", text: "action 'get' requires scriptName." }], isError: true };
        }
        return textResult(await cfAccountRequest(`/workers/scripts/${scriptName}/settings`));
      }

      if (action === "code") {
        if (!scriptName) {
          return { content: [{ type: "text", text: "action 'code' requires scriptName." }], isError: true };
        }
        const source = await cfAccountRequest(`/workers/scripts/${scriptName}`);
        return { content: [{ type: "text", text: paginateText(toCompactText(source), { offset, limit }) }] };
      }

      return { content: [{ type: "text", text: `Unknown action '${action}'.` }], isError: true };
    }
  );
}
