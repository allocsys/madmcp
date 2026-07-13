// ---------------------------------------------------------------------------
// server.js — HTTP server + MCP bootstrap only.
// To add a new connector: create connectors/<n>/tools.js and register below.
// ---------------------------------------------------------------------------

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { GITHUB_TOKEN, NOTION_TOKEN, MEM0_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, MCP_SHARED_KEY, IP_ALLOWLIST_ENABLED, ALLOWED_IP_RANGES } from "./config.js";
import * as github     from "./connectors/github/tools.js";
import * as resource   from "./connectors/github/resource.js";
import * as notion     from "./connectors/notion/tools.js";
import * as mem0       from "./connectors/mem/tools.js";
import * as fetch      from "./connectors/fetch/tools.js";
import * as cloudflare from "./connectors/cloudflare/tools.js";

// Build the MCP server once at startup and reuse it across all requests.
const mcpServer = new McpServer({
  name: "manufact-mcp-server",
  version: "2.1.0",
});

github.register(mcpServer);
resource.register(mcpServer);
notion.register(mcpServer);
mem0.register(mcpServer);
fetch.register(mcpServer);
cloudflare.register(mcpServer);

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

// --- IP allowlist -----------------------------------------------------
// Restricts inbound requests to known client CIDR ranges (e.g. Anthropic's
// published range for Claude connector traffic) BEFORE the key check runs,
// so a leaked/guessed MCP_SHARED_KEY alone isn't enough to reach the server
// from an untrusted network. IPv4 only; extend if you need IPv6 ranges too.

function ipToLong(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + (parseInt(octet, 10) & 0xff), 0) >>> 0;
}

function isIpv4(ip) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

function isIpInCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  if (!isIpv4(ip) || !isIpv4(range)) return false;
  const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

// Strips the ::ffff: prefix Node sometimes adds to IPv4 addresses on dual-stack sockets.
function normalizeIp(ip) {
  if (typeof ip !== "string") return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

// Reads the client IP from X-Forwarded-For (leftmost = original client) when
// present, falling back to the raw socket address. NOTE: this trusts
// X-Forwarded-For, which is only safe because the deploy platform sits in
// front of this server as the sole entry point (it overwrites/sets this
// header itself). If that ever changes, this needs `app.set('trust proxy', ...)`
// tuned to the actual number of trusted hops, or the header becomes spoofable.
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
  return normalizeIp(raw || "");
}

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
// Trust exactly one hop: the deploy platform sits in front of this server as
// the sole entry point and sets X-Forwarded-For itself, so this is safe (and
// matches what getClientIp() below already assumes). Fixes express-rate-limit
// throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request.
app.set("trust proxy", 1);
app.use(helmet());
// Raise body size limit from the 100kb default to 10mb so that push_files
// and create_or_update_file can handle large source files without truncation.
app.use(express.json({ limit: "10mb" }));

// Gated behind auth: previously exposed which connectors were configured
// (github/notion/mem0/cloudflare/auth booleans) to anyone with the URL, which
// is free recon for an attacker probing the server. Now requires a valid key,
// same as /mcp. /health stays open and info-free for uptime monitoring.
app.get("/", requireAllowedIp, requireMcpKey, (_req, res) => {
  res.json({
    status: "ok",
    service: "manufact-mcp-server",
    version: "2.1.0",
    configured: {
      github: Boolean(GITHUB_TOKEN),
      notion: Boolean(NOTION_TOKEN),
      mem0:   Boolean(MEM0_API_KEY),
      cloudflare: Boolean(CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID),
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

app.post("/mcp", mcpLimiter, requireMcpKey, requireAllowedIp, handleMcp);
app.post("/mcp/:key", mcpLimiter, requireMcpKey, requireAllowedIp, handleMcp);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`manufact-mcp-server v2.1.0 listening on port ${PORT}`);
  if (!GITHUB_TOKEN)   console.warn("WARNING: GITHUB_TOKEN is not set.");
  if (!NOTION_TOKEN)   console.warn("WARNING: NOTION_TOKEN is not set. Notion tools will fail.");
  if (!MEM0_API_KEY)   console.warn("WARNING: MEM0_API_KEY is not set. Mem0 tools will fail.");
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) console.warn("WARNING: CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set. Cloudflare tools will fail.");
  if (!MCP_SHARED_KEY) console.warn("WARNING: MCP_SHARED_KEY is not set. The /mcp, /mcp/:key, and / endpoints are OPEN to anyone who has the URL.");
  console.log(`IP allowlist: ${IP_ALLOWLIST_ENABLED ? `ENABLED (${ALLOWED_IP_RANGES.join(", ")})` : "DISABLED"}`);
});
