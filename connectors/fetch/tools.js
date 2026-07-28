// ---------------------------------------------------------------------------
// connectors/fetch/tools.js — web_fetch MCP tool
// Fetches a URL and returns its content (text, JSON, or HTML).
// HTML is stripped to readable text to keep responses concise.
//
// TOKEN COST NOTE: default max_chars is 500,000 -- this tool returns the raw
// page content straight into the calling model's context. When the actual
// need is just an answer to a specific question about a page (not the exact
// text/code itself), delegate_research's precision mode (url+question) is
// far cheaper: it fetches server-side and hands only Gemini's compact
// answer back, never the raw page. See gemini/tools.js's file header for
// the full token-cost comparison.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { fetchUrl, htmlToText } from "./client.js";

export function register(server) {

  server.tool(
    "web_fetch",
    "DOES: Fetch any public URL, return text/JSON/stripped HTML. Also supports POST/PUT/PATCH/DELETE + JSON body for public write APIs (set method and body).\n" +
    "RULE: need only an answer to a specific question about the page, not its exact text/code -> use delegate_research (url+question, precision mode) instead -- far fewer tokens, since that fetches server-side and returns only the compact answer.\n" +
    "USE THIS INSTEAD when you need: exact wording, code snippets to copy, or content to edit in place.",
    {
      url:          z.string().url().describe("The URL to fetch"),
      method:       z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default: GET)"),
      body:         z.any().optional().describe("JSON body to send (object). Only meaningful for POST/PUT/PATCH. Sent with Content-Type: application/json."),
      max_chars:    z.number().optional().describe("Truncate response to this many characters (default: 500000)"),
      raw_html:     z.boolean().optional().describe("Return raw HTML instead of stripped plain text (default: false)"),
      headers:      z.record(z.string()).optional().describe("Optional extra HTTP request headers (e.g. Authorization)"),
    },
    async ({ url, method = "GET", body, max_chars = 500000, raw_html = false, headers = {} }) => {
      const mergedHeaders = body ? { "Content-Type": "application/json", ...headers } : headers;
      const { status, ok, contentType, text } = await fetchUrl(url, { method, body, headers: mergedHeaders });

      let output = text;

      if (!raw_html && contentType.includes("text/html")) {
        output = htmlToText(text);
      } else if (contentType.includes("application/json")) {
        try {
          output = JSON.stringify(JSON.parse(text), null, 2);
        } catch { /* keep raw */ }
      }

      const truncated = output.length > max_chars;
      const result    = truncated ? output.slice(0, max_chars) + `\n\n[... truncated at ${max_chars} chars — use max_chars to increase]` : output;

      return {
        content: [{
          type: "text",
          text: `HTTP ${status} — ${url}\nContent-Type: ${contentType}\n${ok ? "" : "⚠️ Non-2xx response\n"}\n${result}`,
        }],
        isError: !ok,
      };
    }
  );
}
