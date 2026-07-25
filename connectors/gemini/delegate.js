// ---------------------------------------------------------------------------
// connectors/gemini/delegate.js — read-only investigation loop.
//
// Lets Gemini run its OWN multi-step tool-use loop server-side (via Gemini
// function calling) to answer an open-ended question, instead of the
// calling model doing 5-10 separate manual tool round-trips. One
// gemini_investigate call in, one synthesized answer out.
//
// SCOPE: every delegated function below is READ-ONLY. Gemini is never given
// a write-capable function here -- writes stay confined to the fixed
// GEMINI_NOTION_ROOT_PAGE_ID path in tools.js, same isolation rule as
// web_fetch_and_ask. This file only reaches into GitHub/Cloudflare/Notion's
// existing client-layer functions (not the MCP tool layer) to avoid
// round-tripping through the MCP server for its own internal calls.
//
// STEP CAP: HARD_MAX_STEPS bounds the loop regardless of the caller's
// max_steps argument -- both to bound Gemini API cost and because a
// synchronous madmcp tool call has to fit inside the hosting platform's
// request duration limit (a real constraint on Vercel -- see the Notion
// plan page for the "known constraint" note; unresolved as of writing).
// ---------------------------------------------------------------------------

import { geminiChat } from "./client.js";
import { githubRequest } from "../github/client.js";
import { readFileViaBlob } from "../github/helpers.js";
import { queryTelemetry } from "../cloudflare/observability.js";
import { notionRequest, notionRichTextToString, notionPageTitle, notionDatabaseTitle, notionBlocksToText } from "../notion/client.js";
import { DEFAULT_OWNER } from "../../config.js";

const HARD_MAX_STEPS = 20;

// ---------------------------------------------------------------------------
// Delegated function declarations -- Gemini's "tools" param (a subset of
// OpenAPI schema: type/properties/required, no $ref/oneOf/etc support).
// Each entry pairs the Gemini-facing declaration with a local `execute`
// that calls the real connector client function.
// ---------------------------------------------------------------------------

const FUNCTIONS = [
  {
    name: "github_read_file",
    description: "Read a file's full contents from a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: `Repository owner (default "${DEFAULT_OWNER}" if omitted)` },
        repo:  { type: "string", description: "Repository name" },
        path:  { type: "string", description: "File path within the repo" },
        ref:   { type: "string", description: "Branch, tag, or commit SHA (default: repo default branch)" },
      },
      required: ["repo", "path"],
    },
    execute: async ({ owner = DEFAULT_OWNER, repo, path, ref }) => {
      const content = await readFileViaBlob(owner, repo, path, ref);
      // Keep the loop's own context bounded -- this is server-side content
      // feeding back into Gemini's next turn, not returned to the caller.
      return content.length > 30000 ? content.slice(0, 30000) + "\n...[truncated]" : content;
    },
  },
  {
    name: "github_get_file_tree",
    description: "Recursively list all files and folders in a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo:  { type: "string", description: "Repository name" },
        ref:   { type: "string", description: "Branch, tag, or commit SHA (default: repo default branch)" },
      },
      required: ["owner", "repo"],
    },
    execute: async ({ owner, repo, ref }) => {
      let treeSha;
      if (ref) {
        try {
          const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
          treeSha = refData.object.sha;
        } catch { treeSha = ref; }
      } else {
        const repoData   = await githubRequest(`/repos/${owner}/${repo}`);
        const branchData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`);
        treeSha = branchData.object.sha;
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
      return data.tree.map((item) => `${item.type === "tree" ? "dir " : "file"} ${item.path}`).join("\n");
    },
  },
  {
    name: "github_list_commits",
    description: "List recent commits on a branch in a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        owner:    { type: "string", description: `Repository owner (default "${DEFAULT_OWNER}" if omitted)` },
        repo:     { type: "string", description: "Repository name" },
        branch:   { type: "string", description: "Branch name (default: repo default branch)" },
        per_page: { type: "number", description: "Number of commits to return (default 20, max 100)" },
      },
      required: ["repo"],
    },
    execute: async ({ owner = DEFAULT_OWNER, repo, branch, per_page = 20 }) => {
      const query = new URLSearchParams({ per_page: String(Math.min(per_page, 100)) });
      if (branch) query.set("sha", branch);
      const data = await githubRequest(`/repos/${owner}/${repo}/commits?${query}`);
      return data.map((c) => `${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]} (${c.commit.author?.name}, ${c.commit.author?.date?.slice(0, 10)})`).join("\n");
    },
  },
  {
    name: "cf_query_logs",
    description: "Query Cloudflare Workers Observability logs/traces/events for a time range.",
    parameters: {
      type: "object",
      properties: {
        timeframe_from: { type: "string", description: "Start of time range, ISO 8601 or epoch millis" },
        timeframe_to:   { type: "string", description: "End of time range, ISO 8601 or epoch millis" },
        script_name:    { type: "string", description: "Optional: scope to one Worker script" },
        limit:          { type: "number", description: "Max results (default ~100)" },
      },
      required: ["timeframe_from", "timeframe_to"],
    },
    execute: async ({ timeframe_from, timeframe_to, script_name, limit }) => {
      const data = await queryTelemetry({ timeframe_from, timeframe_to, script_name, limit });
      return JSON.stringify(data).slice(0, 30000);
    },
  },
  {
    name: "notion_get_page",
    description: "Read a Notion page's title and text content by page ID (read-only). Use this after notion_search finds a candidate page, to actually see what's on it -- notion_search only returns titles/ids, not content.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Notion page ID, e.g. from notion_search results" },
      },
      required: ["page_id"],
    },
    execute: async ({ page_id }) => {
      const [page, blocksData] = await Promise.all([
        notionRequest(`/pages/${page_id}`),
        notionRequest(`/blocks/${page_id}/children?page_size=100`),
      ]);
      const title   = notionPageTitle(page);
      const blocks  = blocksData.results || [];
      const content = notionBlocksToText(blocks) || "(no content)";
      const hasMore = blocksData.has_more ? "\n[note: page has more than 100 blocks, only the first 100 are shown]" : "";
      const text = `# ${title}\n${content}${hasMore}`;
      return text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
    },
  },
  {
    name: "notion_search",
    description: "Search pages and databases in the Notion workspace (read-only).",
    parameters: {
      type: "object",
      properties: {
        query:       { type: "string", description: "Search query string" },
        filter_type: { type: "string", description: "Restrict to 'page' or 'database' (optional)" },
        page_size:   { type: "number", description: "Number of results (default 10, max 100)" },
      },
      required: ["query"],
    },
    execute: async ({ query, filter_type, page_size = 10 }) => {
      const body = { query, page_size };
      if (filter_type) body.filter = { value: filter_type, property: "object" };
      const data = await notionRequest("/search", { method: "POST", body });
      if (!data.results?.length) return "No results found.";
      return data.results.map((r) => {
        const title = r.object === "page" ? notionPageTitle(r) : (notionDatabaseTitle(r) || "(untitled)");
        return `[${r.object}] ${title} — id: ${r.id}`;
      }).join("\n");
    },
  },
  {
    name: "notion_query_database",
    description: "Query rows from a Notion database (read-only), with an optional filter.",
    parameters: {
      type: "object",
      properties: {
        database_id: { type: "string", description: "Notion database ID" },
        page_size:   { type: "number", description: "Number of rows (default 20, max 100)" },
      },
      required: ["database_id"],
    },
    execute: async ({ database_id, page_size = 20 }) => {
      const data = await notionRequest(`/databases/${database_id}/query`, { method: "POST", body: { page_size } });
      if (!data.results?.length) return "No rows found.";
      return data.results.map((row) => {
        const props = Object.entries(row.properties || {}).map(([name, val]) => {
          if (val.type === "title") return `${name}: ${notionRichTextToString(val.title)}`;
          if (val.type === "rich_text") return `${name}: ${notionRichTextToString(val.rich_text)}`;
          return `${name}: ${JSON.stringify(val[val.type] ?? "")}`;
        }).join(" | ");
        return `- ${props}`;
      }).join("\n");
    },
  },
];

const FUNCTION_DECLARATIONS = [{
  functionDeclarations: FUNCTIONS.map(({ name, description, parameters }) => ({ name, description, parameters })),
}];

const SYSTEM_PREAMBLE =
  "You are a read-only investigation agent. Use the available functions to gather whatever " +
  "information you need to answer the task fully, calling as many as necessary across multiple " +
  "turns. When you have enough information, respond with a final plain-text answer and no further " +
  "function calls. Be specific and cite what you found (file paths, commit SHAs, log entries, page " +
  "titles) rather than speculating.";

// Runs the investigation loop. Returns { answer, steps, transcript } where
// transcript is a human-readable log of each function call made (for the
// Notion write in tools.js) and steps is how many model turns it took.
export async function runInvestigation({ task, max_steps = 6 }) {
  const cappedSteps = Math.min(max_steps, HARD_MAX_STEPS);
  const contents = [{ role: "user", parts: [{ text: `${SYSTEM_PREAMBLE}\n\nTask: ${task}` }] }];
  const transcript = [];

  for (let step = 1; step <= cappedSteps; step++) {
    const candidate = await geminiChat(contents, { tools: FUNCTION_DECLARATIONS });
    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (!functionCalls.length) {
      const answer = parts.map((p) => p.text || "").join("").trim();
      if (!answer) {
        return { answer: `(Gemini stopped without a final answer -- finishReason: ${candidate.finishReason || "unknown"})`, steps: step, transcript };
      }
      return { answer, steps: step, transcript };
    }

    // Record the model's turn (including its functionCall parts) before
    // executing anything, so the conversation history stays accurate even
    // if a function call below throws.
    contents.push({ role: "model", parts });

    const responseParts = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      const fn = FUNCTIONS.find((f) => f.name === name);
      let resultText;
      if (!fn) {
        resultText = `Error: unknown function "${name}".`;
      } else {
        try {
          resultText = await fn.execute(args || {});
        } catch (err) {
          resultText = `Error: ${err.message}`;
        }
      }
      transcript.push(`[step ${step}] ${name}(${JSON.stringify(args || {})}) -> ${resultText.length > 300 ? resultText.slice(0, 300) + "…" : resultText}`);
      responseParts.push({ functionResponse: { name, response: { result: resultText } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return { answer: `(Investigation stopped after reaching the step cap of ${cappedSteps} without a final answer -- the task may need to be narrowed, or more steps requested up to the hard cap of ${HARD_MAX_STEPS}.)`, steps: cappedSteps, transcript };
}
