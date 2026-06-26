// ---------------------------------------------------------------------------
// connectors/fetch/tools.js — web_fetch MCP tool
// Fetches a URL and returns its content (text, JSON, or HTML).
// HTML is stripped to readable text to keep responses concise.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { fetchUrl } from "./client.js";

// Strip HTML tags and collapse whitespace into readable plain text
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function register(server) {

  server.tool(
    "web_fetch",
    "Fetch the content of any public URL and return its text, JSON, or stripped HTML. Useful for reading docs, APIs, pages, or raw files from the web.",
    {
      url:          z.string().url().describe("The URL to fetch"),
      max_chars:    z.number().optional().describe("Truncate response to this many characters (default: 8000)"),
      raw_html:     z.boolean().optional().describe("Return raw HTML instead of stripped plain text (default: false)"),
      headers:      z.record(z.string()).optional().describe("Optional extra HTTP request headers (e.g. Authorization)"),
    },
    async ({ url, max_chars = 8000, raw_html = false, headers = {} }) => {
      const { status, ok, contentType, text } = await fetchUrl(url, { headers });

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
