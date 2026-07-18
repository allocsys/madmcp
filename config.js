// ---------------------------------------------------------------------------
// config.js
// Central place for all environment variables and shared constants.
// ---------------------------------------------------------------------------

export const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
export const GITHUB_API     = "https://api.github.com";
export const DEFAULT_OWNER  = process.env.DEFAULT_OWNER || "allocsys";

// Minimum spacing (ms) enforced between outgoing GitHub REST requests, to
// avoid tripping GitHub's *secondary* rate limit, which fires on request
// burstiness/concurrency rather than raw hourly quota (see
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
// A shared in-process queue in client.js enforces this even across
// concurrent tool calls. Override via env var if this proves too
// conservative or not conservative enough in practice.
export const GITHUB_MIN_REQUEST_INTERVAL_MS = Number(process.env.GITHUB_MIN_REQUEST_INTERVAL_MS) || 300;

// Retry behavior specifically for secondary-rate-limit (403) and primary
// rate-limit-exhausted (403 with x-ratelimit-remaining: 0) responses, plus
// 429s. Does NOT retry other 4xx/5xx errors -- those are real failures, not
// pacing issues, and should surface immediately.
export const GITHUB_MAX_RETRIES = Number(process.env.GITHUB_MAX_RETRIES) || 3;
// Fallback backoff (ms) when GitHub doesn't send a Retry-After header.
// Doubles each retry (300 -> ~1.6s -> ~3.2s with jitter) if Retry-After is absent.
export const GITHUB_RETRY_BASE_MS = Number(process.env.GITHUB_RETRY_BASE_MS) || 1500;

export const NOTION_TOKEN   = process.env.NOTION_TOKEN;
export const NOTION_API     = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

// Dedicated index page used for entity_id -> page_id dedup lookups (2026-07-17
// real fix for gap #1, see mem0 entity_id: madmcp-notion-connector-gaps-roadmap).
// notion_search has real indexing lag -- searching for an entity_id string
// immediately after creating that page can return zero results, which let
// duplicates through despite the dedup check being coded correctly. Reading
// a page's own blocks via /blocks/{id}/children is a direct, uncached read
// with no such lag, so entity_id -> page_id mappings are stored as plain
// paragraph blocks on one well-known page instead of being looked up via
// search. Default points at a page created 2026-07-17 under the "Claude"
// page (id 3a045572-b580-8007-b622-c120958557bf) for this purpose; override
// via env var if that page is ever moved/recreated.
export const NOTION_INDEX_PAGE_ID = process.env.NOTION_INDEX_PAGE_ID || "3a045572-b580-81a4-80e8-c9e5460520a6";

// Parent page for new pages created by sync_mem0_to_notion (connectors/sync/
// mem0_notion.js). Defaults to the "Memory Index" page (id below) that the
// 2026-07-18 manual batch sync populated -- override via env var if that
// page is ever moved/recreated, same pattern as NOTION_INDEX_PAGE_ID above.
export const NOTION_SYNC_PARENT_PAGE_ID = process.env.NOTION_SYNC_PARENT_PAGE_ID || "3a045572-b580-81c5-a067-df834ca9ecc2";

export const MEM0_API_KEY   = process.env.MEM0_API_KEY;
export const MEM0_API       = "https://api.mem0.ai";
export const MEM0_USER_ID   = process.env.MEM0_USER_ID || "default";

export const CLOUDFLARE_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
export const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
export const CLOUDFLARE_API        = "https://api.cloudflare.com/client/v4";

// Context7 works without a key at low rate limits, so this is optional
// (unlike the other connectors' tokens) — only warn, never hard-fail on it.
export const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY;
export const CONTEXT7_API     = "https://context7.com/api/v2";

// Shared-secret auth for the /mcp endpoint. If set, every request to /mcp
// must include a matching `x-manufact-key` header, or it is rejected before
// any connector tools (GitHub, Notion, Mem0, Fetch) are reachable.
// If unset, the endpoint remains open (legacy behavior) — set this in
// production so your tokens/connectors aren't usable by anyone with the URL.
export const MCP_SHARED_KEY = process.env.MCP_SHARED_KEY;

// IP allowlist for /mcp, /mcp/:key, and /. Restricts inbound requests to
// known client CIDR ranges regardless of whether the shared key is valid,
// so a leaked key alone isn't enough to reach the server.
// Defaults ON, and defaults to Anthropic's published outbound range for
// Claude connector traffic (https://claude.com/docs/connectors/building/authentication).
// Add more ranges (e.g. for OpenAI/GPT actions) as a comma-separated list.
// Set IP_ALLOWLIST_ENABLED=false to disable entirely (e.g. for local dev).
export const IP_ALLOWLIST_ENABLED = process.env.IP_ALLOWLIST_ENABLED !== "false";
// 208.77.244.90/32 is manufact's own deploy-time health-check IP (it POSTs an
// MCP `initialize` request to /mcp as part of deploy verification) — without
// it, every deploy fails its own health check against this allowlist.
export const ALLOWED_IP_RANGES = (process.env.ALLOWED_IP_RANGES || "160.79.104.0/21,208.77.244.90/32")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Number of reverse-proxy hops in front of this server whose X-Forwarded-For
// entries should be trusted when determining the real client IP (used for
// both Express's own trust-proxy setting and the IP allowlist check).
// Default of 1 matches Render and most single-CDN-hop platforms. Deploying
// behind a different proxy chain (e.g. a platform that adds more hops before
// reaching this app) may need a different value — if legitimate requests
// start getting 403'd, or IP allowlisting seems to trust the wrong address,
// check this first rather than assuming the allowlist itself is wrong.
export const TRUST_PROXY_HOPS = Number.isInteger(Number(process.env.TRUST_PROXY_HOPS))
  ? Number(process.env.TRUST_PROXY_HOPS)
  : 1;
