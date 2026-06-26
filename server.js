// ---------------------------------------------------------------------------
// server.js — HTTP server + MCP bootstrap only.
// To add a new connector: create connectors/<name>/tools.js and register below.
// ---------------------------------------------------------------------------

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { GITHUB_TOKEN, NOTION_TOKEN, MEM0_API_KEY, MCP_SHARED_KEY } from "./config.js";
import * as github from "./connectors/github/tools.js";
import * as notion from "./connectors/notion/tools.js";
import * as mem0   from "./connectors/mem/tools.js";
import * as fetch  from "./connectors/fetch/tools.js";

// Build the MCP server once at startup and reuse it across all requests.
const mcpServer = new McpServer({
  name: "manufact-mcp-server",
  version: "2.0.0",
});

github.register(mcpServer);
notion.register(mcpServer);
mem0.register(mcpServer);
fetch.register(mcpServer);

// Adding a new connector:
//   import * as myThing from "./connectors/myThing/tools.js";
//   myThing.register(mcpServer);

// Constant-time-ish comparison to avoid trivial timing leaks on the shared key.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Accepts the key either as a header (x-manufact-key) or as a URL path
// segment (/mcp/<key>) — the latter exists because some MCP clients (e.g.
// the Claude apps) don't expose a way to set custom headers on a connector.
function requireMcpKey(req, res, next) {
  if (!MCP_SHARED_KEY) return next(); // auth disabled: no key configured
  const headerKey = req.get("x-manufact-key");
  const pathKey   = req.params.key;
  if ((headerKey && safeEqual(headerKey, MCP_SHARED_KEY)) || (pathKey && safeEqual(pathKey, MCP_SHARED_KEY))) {
    return next();
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid MCP key" },
    id: null,
  });
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "manufact-mcp-server",
    configured: {
      github: Boolean(GITHUB_TOKEN),
      notion: Boolean(NOTION_TOKEN),
      mem0:   Boolean(MEM0_API_KEY),
      auth:   Boolean(MCP_SHARED_KEY),
    },
  });
});

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

async function handleMcp(req, res) {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

// Legacy path: open unless MCP_SHARED_KEY is unset, in which case auth is
// disabled entirely (back-compat). Prefer the keyed path below once a key
// is configured, since most MCP clients can't add custom headers.
app.post("/mcp", requireMcpKey, handleMcp);

// Keyed path for clients that can't set custom headers (e.g. Claude apps):
// the secret travels as a URL path segment instead.
//   https://<host>/mcp/<MCP_SHARED_KEY>
app.post("/mcp/:key", requireMcpKey, handleMcp);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`manufact-mcp-server listening on port ${PORT}`);
  if (!GITHUB_TOKEN)  console.warn("WARNING: GITHUB_TOKEN is not set.");
  if (!NOTION_TOKEN)  console.warn("WARNING: NOTION_TOKEN is not set. Notion tools will fail.");
  if (!MEM0_API_KEY)  console.warn("WARNING: MEM0_API_KEY is not set. Mem0 tools will fail.");
  if (!MCP_SHARED_KEY) console.warn("WARNING: MCP_SHARED_KEY is not set. The /mcp endpoint is OPEN to anyone who has the URL.");
});
