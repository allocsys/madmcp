// ---------------------------------------------------------------------------
// connectors/context7/tools.js — up-to-date library/framework documentation.
// Two-step flow, same as Context7's own MCP server: search_library to
// resolve a name to a Context7 library ID, then get_library_docs to fetch
// version-specific docs and code examples for that ID.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { context7Request } from "./client.js";

export function register(server) {

  server.tool(
    "search_library",
    "DOES: Search Context7's index by library/framework name, return matching Context7 library IDs.\n" +
    "RULE: call before get_library_docs UNLESS you already know the exact ID (format: /org/project, e.g. /vercel/next.js).",
    {
      libraryName: z.string().describe("The library or framework name to search for (e.g. \"next.js\", \"react\", \"fastapi\")"),
      query:       z.string().describe("The task or question you're trying to solve — used to rank results by relevance (e.g. \"app router middleware\")"),
    },
    async ({ libraryName, query }) => {
      const data = await context7Request("/libs/search", { libraryName, query });
      const results = data?.results || [];
      if (!results.length) {
        return { content: [{ type: "text", text: `No libraries found matching "${libraryName}".` }] };
      }
      const lines = results.slice(0, 10).map((r) =>
        `${r.id} — ${r.title || r.name || r.id}${r.trustScore !== undefined ? ` [trust ${r.trustScore}]` : ""}${r.versions?.length ? ` (versions: ${r.versions.slice(0, 5).join(", ")})` : ""}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_library_docs",
    "DOES: Fetch up-to-date, version-specific docs + code examples for a library, given its Context7 library ID.\n" +
    "RULE: need the ID first via search_library, UNLESS already given an exact one like /vercel/next.js or /vercel/next.js/v15.1.0.",
    {
      libraryId: z.string().describe("Exact Context7-compatible library ID, e.g. \"/vercel/next.js\" or \"/vercel/next.js/v15.1.0\""),
      query:     z.string().describe("The specific question or task to retrieve relevant docs for (e.g. \"how to set up middleware\") — be specific, vague queries return vague docs"),
      tokens:    z.number().optional().describe("Max tokens of documentation to return (default 5000, minimum 1000)"),
    },
    async ({ libraryId, query, tokens }) => {
      const data = await context7Request("/context", {
        libraryId,
        query,
        type: "txt",
        tokens,
      });
      const text = typeof data === "string" ? data : (data?.context || data?.text || JSON.stringify(data, null, 2));
      return { content: [{ type: "text", text: text || "(no documentation returned)" }] };
    }
  );
}
