// ---------------------------------------------------------------------------
// config.js
// Central place for all environment variables and shared constants.
// ---------------------------------------------------------------------------

export const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
export const GITHUB_API     = "https://api.github.com";
export const DEFAULT_OWNER  = process.env.DEFAULT_OWNER || "dumbCodesOnly";

export const NOTION_TOKEN   = process.env.NOTION_TOKEN;
export const NOTION_API     = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

export const MEM0_API_KEY   = process.env.MEM0_API_KEY;
export const MEM0_API       = "https://api.mem0.ai";
export const MEM0_USER_ID   = process.env.MEM0_USER_ID || "default";

export const CLOUDFLARE_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
export const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
export const CLOUDFLARE_API        = "https://api.cloudflare.com/client/v4";

// Shared-secret auth for the /mcp endpoint. If set, every request to /mcp
// must include a matching `x-manufact-key` header, or it is rejected before
// any connector tools (GitHub, Notion, Mem0, Fetch) are reachable.
// If unset, the endpoint remains open (legacy behavior) — set this in
// production so your tokens/connectors aren't usable by anyone with the URL.
export const MCP_SHARED_KEY = process.env.MCP_SHARED_KEY;
