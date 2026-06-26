// ---------------------------------------------------------------------------
// server.js — HTTP server + MCP bootstrap only.
// To add a new connector: create connectors/<name>/tools.js and register below.
// ---------------------------------------------------------------------------

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { GITHUB_TOKEN, NOTION_TOKEN, MEM0_API_KEY } from "./config.js";
import * as github from "./connectors/github/tools.js";
import * as notion from "./connectors/notion/tools.js";
import * as mem0   from "./connectors/mem/tools.js";

function buildServer() {
  const server = new McpServer({
    name: "manufact-mcp-server",
    version: "2.0.0",
  });

  github.register(server);
  notion.register(server);
  mem0.register(server);

  // Adding a new connector:
  //   import * as myThing from "./connectors/myThing/tools.js";
  //   myThing.register(server);

  return server;
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
    },
  });
});

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
  try {
    const server    = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`manufact-mcp-server listening on port ${PORT}`);
  if (!GITHUB_TOKEN) console.warn("WARNING: GITHUB_TOKEN is not set.");
  if (!NOTION_TOKEN) console.warn("WARNING: NOTION_TOKEN is not set. Notion tools will fail.");
  if (!MEM0_API_KEY) console.warn("WARNING: MEM0_API_KEY is not set. Mem0 tools will fail.");
});
