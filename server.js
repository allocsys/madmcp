// ---------------------------------------------------------------------------
// server.js -- HTTP server + MCP bootstrap only.
// To add a new connector: create connectors/<n>/tools.js and register below.
// ---------------------------------------------------------------------------

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { GITHUB_TOKEN, NOTION_TOKEN, MEM0_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CONTEXT7_API_KEY, GEMINI_API_KEY, JULES_API_KEY, MCP_SHARED_KEY, IP_ALLOWLIST_ENABLED, ALLOWED_IP_RANGES, TRUST_PROXY_HOPS, GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY, DELEGATE_AGENT_ASYNC, EDITOR_AGENT_ASYNC } from "./config.js";
import { isQStashConfigured } from "./connectors/gemini/qstash_client.js";
import { isEditorQStashConfigured } from "./connectors/gemini/qstash_client.js";
import { safeEqual, isIpInCidr, getClientIp } from "./connectors/security.js";
import * as github     from "./connectors/github/tools.js";
import * as resource   from "./connectors/github/resource.js";
import * as notion     from "./connectors/notion/tools.js";
import * as mem0       from "./connectors/mem/tools.js";
import * as fetch      from "./connectors/fetch/tools.js";
import * as cloudflare from "./connectors/cloudflare/tools.js";
import * as context7   from "./connectors/context7/tools.js";
import * as agent      from "./connectors/gemini/agent_tools.js";
import { handleAgentWorker } from "./connectors/gemini/agent_worker.js";
import { handleEditorWorker } from "./connectors/github/editor_worker.js";
import * as research   from "./connectors/exa/research_tools.js";
import * as frontend   from "./connectors/frontend/designer_tools.js";
import * as sync       from "./connectors/sync/mem0_notion.js";
import * as jules      from "./connectors/jules/tools.js";

// Factory function to build a fresh McpServer instance with all connectors registered.
// On Vercel, serverless functions reuse warm containers across separate requests/invocations.
// Calling server.connect() a second time on a shared module-level singleton instance throws
// "Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection."
// Therefore, handleMcp calls createMcpServer() per request, while module-load instantiation
// is retained for single-connect tests (e.g. test/mcp-integration.test.js).
function createMcpServer() {
  const server = new McpServer({
    name: "madmcp-server",
    version: "2.1.0",
  });

  github.register(server);
  resource.register(server);
  notion.register(server);
  mem0.register(server);
  fetch.register(server);
  cloudflare.register(server);
  context7.register(server);
  agent.register(server);
  research.register(server);
  frontend.register(server);
  sync.register(server);
  jules.register(server);

  return server;
}

// Build the MCP server once at module load time for tests and single-connect use cases.
const mcpServer = createMcpServer();

// Adding a new connector:
//   import * as myThing from "./connectors/myThing/tools.js";
//   myThing.register(server); // inside createMcpServer()

// --- IP allowlist -----------------------------------------------------
// Restricts inbound requests to known client CIDR ranges (e.g. Anthropic's
// published range for Claude connector traffic) BEFORE the key check runs,
// so a leaked/guessed MCP_SHARED_KEY alone isn't enough to reach the server
// from an untrusted network. IPv4 only; extend if you need IPv6 ranges too.
// (safeEqual, isIpInCidr, getClientIp now live in ./connectors/security.js,
// covered by test/security.test.js.)

function requireAllowedIp(req, res, next) {
  if (!IP_ALLOWLIST_ENABLED) return next();
  const ip = getClientIp(req);
  const allowed = ip && ALLOWED_IP_RANGES.some((cidr) => isIpInCidr(ip, cidr));
  if (allowed) return next();
  console.warn(`Blocked request from non-allowlisted IP: ${ip || "(unknown)"}`);
  res.status(403).json({
    jsonrpc: "2.0",
    error: { code: -32002, message: "Forbidden: source IP not allowlisted" },
    id: null,
  });
}

// Accepts the key via header OR as a URL path segment via /mcp/:key.
// Path-based auth is back because Claude.ai's custom connector UI does not
// currently support request-header auth for MCP servers on this account.
// Prefer the header for any client that does support it.
function requireMcpKey(req, res, next) {
  if (!MCP_SHARED_KEY) return next();
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

// Rate limit auth attempts / tool calls on /mcp so a leaked or guessed key
// can't be used to hammer GitHub/Cloudflare/etc, and the key itself can't be
// brute-forced freely. Applied before requireMcpKey so failed-auth attempts
// count against the limit too.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Rate limit exceeded. Try again shortly." },
    id: null,
  },
});

const app = express();
// Trust TRUST_PROXY_HOPS reverse-proxy hops (default 1, matching Render and
// most single-CDN-hop platforms) so X-Forwarded-For is read consistently
// with getClientIp() below. Fixes express-rate-limit throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request. If deploying behind a
// different proxy chain, set TRUST_PROXY_HOPS to match instead of assuming
// this default is universally correct.
app.set("trust proxy", TRUST_PROXY_HOPS);
app.use(helmet());
// Raise body size limit from the 100kb default to 10mb so that push_files
// and create_or_update_file can handle large source files without truncation.
// `verify` stashes the raw request body bytes on req.rawBody -- needed by
// /api/agent-worker (connectors/gemini/agent_worker.js) to verify QStash's
// request signature against the EXACT bytes QStash signed, since the
// already-JSON.parsed req.body cannot be re-serialized back to a
// byte-for-byte match (key order/whitespace aren't preserved). Cheap for
// every other route (one extra buffer reference, no extra parsing) so it's
// applied globally rather than only on the one route that needs it.
app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Gated behind auth: previously exposed which connectors were configured
// (github/notion/mem0/cloudflare/auth booleans) to anyone with the URL, which
// is free recon for an attacker probing the server. Now requires a valid key,
// same as /mcp. /health stays open and info-free for uptime checks.
app.get("/", requireMcpKey, requireAllowedIp, (_req, res) => {
  res.json({
    status: "ok",
    service: "madmcp-server",
    version: "2.1.0",
    configured: {
      github: Boolean(GITHUB_TOKEN),
      notion: Boolean(NOTION_TOKEN),
      mem0:   Boolean(MEM0_API_KEY),
      cloudflare: Boolean(CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID),
      context7: true, // works unauthenticated at lower rate limits, so always "configured"
      gemini: Boolean(GEMINI_API_KEY),
      frontend: Boolean(GEMINI_API_KEY), // delegate_designer's agent loop runs on the Gemini connector -- no separate frontend provider config anymore
      jules:  Boolean(JULES_API_KEY),
      auth:   Boolean(MCP_SHARED_KEY),
    },
  });
});

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

async function handleMcp(req, res) {
  try {
    const mcpServer = createMcpServer();
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

app.post("/mcp", mcpLimiter, requireMcpKey, requireAllowedIp, handleMcp);
app.post("/mcp/:key", mcpLimiter, requireMcpKey, requireAllowedIp, handleMcp);

// QStash-invoked worker for delegate_agent's Scenario B self-chaining
// background loop -- deliberately NOT behind requireMcpKey/
// requireAllowedIp (QStash calls from its own infrastructure, not from the
// MCP client's network) or mcpLimiter (a long chain of legitimate one-
// step-per-message calls for a single run would otherwise trip a limiter
// sized for MCP tool-call bursts). Auth for this endpoint is entirely
// handleAgentWorker's own QStash signature verification (fails closed --
// see qstash_client.js's file header), which is why it doesn't reuse any
// of the /mcp middleware stack above.
app.post("/api/agent-worker", handleAgentWorker);

// QStash-invoked worker for delegate_editor's async self-chaining
// background loop (plan.md Step 5) -- same reasoning as /api/agent-worker
// immediately above: deliberately NOT behind requireMcpKey/requireAllowedIp
// (QStash calls from its own infrastructure, not the MCP client's network)
// or mcpLimiter (a long chain of legitimate one-step-per-message calls for
// a single run would otherwise trip a limiter sized for MCP tool-call
// bursts). Auth for this endpoint is entirely handleEditorWorker's own
// QStash signature verification (fails closed), which is why it doesn't
// reuse any of the /mcp middleware stack above. Relies on the same global
// express.json() verify callback above for req.rawBody.
app.post("/api/editor-worker", handleEditorWorker);

const PORT = process.env.PORT || 8080;
// Gated so importing this module (e.g. from tests via supertest, or the MCP
// integration test's InMemoryTransport) never binds a real port. Tests set
// NODE_ENV=test before importing server.js.
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`madmcp-server v2.1.0 listening on port ${PORT}`);
    if (!GITHUB_TOKEN)   console.warn("WARNING: GITHUB_TOKEN is not set.");
    if (!NOTION_TOKEN)   console.warn("WARNING: NOTION_TOKEN is not set. Notion tools will fail.");
    if (!MEM0_API_KEY)   console.warn("WARNING: MEM0_API_KEY is not set. Mem0 tools will fail.");
    if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) console.warn("WARNING: CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set. Cloudflare tools will fail.");
    if (!CONTEXT7_API_KEY) console.warn("NOTE: CONTEXT7_API_KEY is not set. Context7 tools will work but at lower, unauthenticated rate limits.");
    if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEYS (or legacy GEMINI_API_KEY) is not set. delegate_agent will fail entirely, and delegate_research's precision mode (url+question) will fail (wide mode is Exa-backed and unaffected).");
    if (!JULES_API_KEY) console.warn("WARNING: JULES_API_KEY is not set. jules_* tools will fail.");
    if (!MCP_SHARED_KEY) console.warn("WARNING: MCP_SHARED_KEY is not set. The /mcp, /mcp/:key, and / endpoints are OPEN to anyone who has the URL.");
    if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID || !GITHUB_APP_PRIVATE_KEY) console.warn("NOTE: GITHUB_APP_ID/GITHUB_APP_INSTALLATION_ID/GITHUB_APP_PRIVATE_KEY not fully set. get_repo_clone_token (private-repo sandbox clone) will fail until the GitHub App is configured.");
    if (DELEGATE_AGENT_ASYNC === "qstash" && !isQStashConfigured()) console.warn("WARNING: DELEGATE_AGENT_ASYNC=qstash but QStash isn't fully configured (QSTASH_TOKEN and/or AGENT_WORKER_URL missing) -- delegate_agent will silently fall back to today's synchronous behavior instead of Scenario B's background chaining.");
    if (EDITOR_AGENT_ASYNC === "qstash" && !isEditorQStashConfigured()) console.warn("WARNING: EDITOR_AGENT_ASYNC=qstash but QStash isn't fully configured for delegate_editor (QSTASH_TOKEN and/or a derivable/explicit EDITOR_WORKER_URL missing -- see config.js's deriveEditorWorkerUrl) -- delegate_editor will silently fall back to today's synchronous behavior instead of background chaining.");
    console.log(`IP allowlist: ${IP_ALLOWLIST_ENABLED ? `ENABLED (${ALLOWED_IP_RANGES.join(", ")})` : "DISABLED"}`);
  });
}

// Default export so Vercel's Node runtime can invoke this as a serverless
// function handler (Express apps are callable as (req, res) => {}). Named
// exports are kept for tests/other tooling that import { app, mcpServer }.
export default app;
export { app, mcpServer };
