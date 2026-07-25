// ---------------------------------------------------------------------------
// connectors/fetch/tools.js — web_fetch MCP tool
// Fetches a URL and returns its content (text, JSON, or HTML).
// HTML is stripped to readable text to keep responses concise.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { fetchUrl, htmlToText } from "./client.js";

export function register(server) {

  server.tool(
    "web_fetch",
    "Fetch the content of any public URL and return its text, JSON, or stripped HTML. Useful for reading docs, APIs, pages, or raw files from the web. Also supports POST/PUT/PATCH/DELETE with a JSON body for calling public write APIs (e.g. registering an API key, submitting a form) — set method and body.",
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
