// ---------------------------------------------------------------------------
// config.js
// Central place for all environment variables and shared constants.
// ---------------------------------------------------------------------------
// (test commit: verifying the Vercel deploy check after removing the
// legacy "Manufact"-named deployment -- no functional change)

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

// Throttle + retry for the Notion API (fix #3 -- rate-limit asymmetry,
// 2026-07-27). Notion's documented average rate limit is ~3 requests/second
// per integration; this spacing keeps a single madmcp instance comfortably
// under that even when several Notion calls land in the same parallelized
// delegate_gemini step. Mirrors GITHUB_MIN_REQUEST_INTERVAL_MS/
// GITHUB_MAX_RETRIES/GITHUB_RETRY_BASE_MS above -- same override pattern.
export const NOTION_MIN_REQUEST_INTERVAL_MS = Number(process.env.NOTION_MIN_REQUEST_INTERVAL_MS) || 350;
export const NOTION_MAX_RETRIES             = Number(process.env.NOTION_MAX_RETRIES) || 3;
export const NOTION_RETRY_BASE_MS           = Number(process.env.NOTION_RETRY_BASE_MS) || 1000;

// Dedicated index DATABASE used for entity_id -> page_id dedup lookups.
// SUPERSEDES the original page-based index (2026-07-17 fix for gap #1, see
// mem0 entity_id: madmcp-notion-connector-gaps-roadmap): that fix solved the
// notion_search indexing-lag problem by reading a page's own blocks directly
// (uncached, no lag) instead of searching -- but inherited a NEW gap it
// documented at the time: page block reads are capped at 100 blocks per
// page (Notion's /blocks/{id}/children pagination), so an index page with
// more than ~100 tracked entities would silently stop finding older entries.
// REAL FIX (2026-07-24): a Notion database queried via /databases/{id}/query
// with a filter on EntityId is just as immediately-consistent as the direct
// block read (no search-index lag either way, since it's not going through
// notion_search) but is NOT subject to the 100-block-page limit -- database
// queries paginate independently of any single page's block count.
// UPDATE (2026-07-24, later same day): the old page-based index, its
// migration tool, and a since-discovered duplicate database were all
// archived/removed once every remaining reader (linking.js's
// findTagOverlapCandidates, sync/mem0_notion.js's readSyncedIndexEntries)
// was moved onto queryAllIndexEntries (client.js), which reads this
// database directly. NOTION_INDEX_PAGE_ID no longer exists as a config
// value -- nothing in the codebase reads it anymore. This database was
// also recreated fresh (new ID below) as part of that same cleanup, with
// zero rows -- no old entries were migrated in.
// Entity Index database properties: Name (title, holds the entity_id for
// readability in the Notion UI), EntityId (rich_text, the actual filter
// target), PageId (rich_text), Url (url), Tags (rich_text, comma-separated).
// Override via env var if this database is ever moved/recreated.
export const NOTION_INDEX_DATABASE_ID = process.env.NOTION_INDEX_DATABASE_ID || "3a745572-b580-8160-856b-cf6544c8ffa8";

// Parent page for new pages created by sync_mem0_to_notion (connectors/sync/
// mem0_notion.js). Defaults to the "Memory Index" page (id below) that the
// 2026-07-18 manual batch sync populated -- override via env var if that
// page is ever moved/recreated, same pattern as NOTION_INDEX_PAGE_ID above.
export const NOTION_SYNC_PARENT_PAGE_ID = process.env.NOTION_SYNC_PARENT_PAGE_ID || "3a045572-b580-81c5-a067-df834ca9ecc2";

export const MEM0_API_KEY   = process.env.MEM0_API_KEY;
export const MEM0_API       = "https://api.mem0.ai";
export const MEM0_USER_ID   = process.env.MEM0_USER_ID || "default";

// Throttle + retry for the Mem0 API (fix #3 -- rate-limit asymmetry,
// 2026-07-27). Mem0 doesn't publish a hard per-second limit the way GitHub
// and Notion do, so this is a conservative default rather than a figure
// tied to a documented threshold -- same override pattern as the others.
export const MEM0_MIN_REQUEST_INTERVAL_MS = Number(process.env.MEM0_MIN_REQUEST_INTERVAL_MS) || 300;
export const MEM0_MAX_RETRIES             = Number(process.env.MEM0_MAX_RETRIES) || 3;
export const MEM0_RETRY_BASE_MS           = Number(process.env.MEM0_RETRY_BASE_MS) || 1000;

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
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GEMINI_API     = "https://generativelanguage.googleapis.com/v1beta";
// Default model -- override via env var if this drifts out of date; Google
// renames/retires Gemini model IDs periodically, so don't assume this stays
// current without checking https://ai.google.dev/gemini-api/docs/models.
export const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-flash-latest";

// Fallback model cascade for rate-limit (429) errors. Free-tier Gemini quotas
// are tracked PER MODEL, so a different model has its own separate RPM
// bucket -- on a 429 from GEMINI_MODEL, client.js retries the same request
// against the next model here instead of failing the whole call/investigation
// outright. This multiplies effective free-tier throughput without enabling
// billing. Order matters: put higher-RPM/lower-capability models later, since
// they're only used once the primary model's quota is exhausted for the
// current window. Override via env var as a comma-separated list of model
// IDs; GEMINI_MODEL is always tried first regardless of whether it's
// repeated in this list. See https://ai.google.dev/gemini-api/docs/models for
// current model IDs/limits -- these drift as Google ships new Flash/Flash-Lite
// generations.
export const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Defensive ceiling on a single generateContent call -- no official guidance
// from Google on max latency, but without SOME timeout a hung/dropped
// connection leaves delegate.js's per-step checkpointing unable to kick in
// at all (the call just never returns). Override via env var if this proves
// too tight for slower multi-tool-call turns, or too loose relative to the
// hosting platform's own request-duration limit.
export const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 55000;

// Read/write isolation for the Gemini connector's Notion access (2026-07-25
// plan): Gemini tools may READ any page/database reachable via the existing
// Notion connector (Memory Index, Entity Index, Job Leads, etc.), but may
// only WRITE under this one page -- deliberately NOT a caller-supplied
// parameter anywhere in connectors/gemini/, so there is no code path that
// lets a Gemini tool call target a write anywhere else. A bad or
// hallucinated Gemini write can only ever land inside this subtree, never
// inside the Claude-side Memory Index / Entity Index / Job Leads structures
// that other tools' dedup and sync logic depend on.
// "Gemini" page, created as a sibling of the "Claude" root page.
export const GEMINI_NOTION_ROOT_PAGE_ID = process.env.GEMINI_NOTION_ROOT_PAGE_ID || "3a845572-b580-81d0-8653-f64596e45e58";

// Redis-backed per-model rate-limit cooldown for the Gemini connector (see
// connectors/gemini/cooldown.js), provisioned via the Vercel Marketplace
// Upstash integration ("vercel install upstash", or the Vercel dashboard).
// Not read as named exports here -- connectors/gemini/cooldown.js reads the
// env vars directly, and accepts EITHER naming convention Vercel might hand
// you depending on how the integration was provisioned:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (raw Upstash Marketplace integration)
//   KV_REST_API_URL / KV_REST_API_TOKEN                (Vercel's own "KV" product, Upstash-backed)
// Discovered 2026-07-26: a deployment with the latter names set had Redis
// fully provisioned and reachable, but every cooldown/checkpoint call
// reported "not configured" anyway, because the code only checked for the
// UPSTASH_* names at the time. Listed here only so both are discoverable
// alongside every other service's env vars, not because config.js exports
// them. If neither pair is set, cooldown.js fails open (no cross-call
// rate-limit memory, but never breaks a real Gemini call) -- safe to leave
// both unset until an integration is activated.

// Exa /answer API (docs.exa.ai/reference/answer) -- backs delegate_research's
// wide mode as the sole implementation (a single search+synthesis call),
// not a fallback for anything; see connectors/exa/client.js's file header
// for the 2026-07-27 history of what this replaced. FORMERLY OPENAI
// (2026-07-27): this section replaced the OPENAI_* config that used to
// serve the same role via OpenAI's Responses API web_search tool -- see git
// history if that needs to be resurrected.
//
// EXA_API_KEYS is a comma-separated list -- deliberately supporting
// MULTIPLE keys/accounts, same reasoning as the OpenAI config it replaces.
// There is no free tier for this endpoint (billed per call, on top of
// content-retrieval costs baked into the same call), so this cascade is
// about rate-limit headroom (Exa's documented default is 10 QPS per
// account, shared across ALL endpoints) and cost/account isolation, not
// accessing a free quota. Unlike the OpenAI config this replaces, there is
// no per-key model tier to cascade through first -- Exa's /answer endpoint
// has no selectable model for this call shape -- so connectors/exa/client.js
// simply rotates through EXA_API_KEYS in order on a 429/503/network error.
export const EXA_API_KEYS = (process.env.EXA_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const EXA_API = "https://api.exa.ai/answer";

// Same defensive-ceiling reasoning as GEMINI_REQUEST_TIMEOUT_MS above.
export const EXA_REQUEST_TIMEOUT_MS = Number(process.env.EXA_REQUEST_TIMEOUT_MS) || 55000;

// ---------------------------------------------------------------------------
// Frontend/design delegate (connectors/frontend/) -- provider-agnostic text
// generation used ONLY by delegate_designer for one-shot HTML/CSS/
// component generation. FRONTEND_PROVIDER selects which backend client.js
// calls; swapping providers is a config change, not a code change. Add a
// new provider by branching in connectors/frontend/client.js and adding its
// own key/model config here -- keep a provider's config block even when it's
// not the current default, since flipping back only works if it's still here.
export const FRONTEND_PROVIDER = process.env.FRONTEND_PROVIDER || "cloudflare";

// -- cloudflare: Workers AI (api.cloudflare.com/.../ai/run/{model}) --
// Reuses CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID below -- no separate key
// needed for this provider. Free daily neuron allocation; see
// https://developers.cloudflare.com/workers-ai/platform/pricing/ for current
// limits, which drift over time. Default model is a general instruct model,
// not design-specialized -- override via env var if a better-suited model
// becomes available on Workers AI.
export const CLOUDFLARE_AI_MODEL = process.env.CLOUDFLARE_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// -- openrouter: openrouter.ai (OpenAI-compatible /chat/completions) --
// Optional -- only required if FRONTEND_PROVIDER=openrouter. Default model
// is a free (":free"-suffixed) route; override via env var, but check
// https://openrouter.ai/models for which routes are still free before
// changing it.
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const OPENROUTER_API     = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || "qwen/qwen3-coder:free";

// -- gemini: reuses the existing Gemini connector's geminiGenerate() and its
// GEMINI_API_KEY/GEMINI_MODEL config above -- no separate keys needed here.

// Same defensive-ceiling reasoning as GEMINI_REQUEST_TIMEOUT_MS/
// EXA_REQUEST_TIMEOUT_MS above -- applies to whichever provider is active.
export const FRONTEND_REQUEST_TIMEOUT_MS = Number(process.env.FRONTEND_REQUEST_TIMEOUT_MS) || 55000;

// Extensions delegate_designer is allowed to read as context OR write
// as output. Fences BOTH the read side (so a manipulated task can't feed a
// secrets-adjacent file like config.js to a third-party LLM API as prompt
// text) and the write side (so a generation can't overwrite server.js/
// package.json/workflow files/etc) to the frontend surface this tool exists
// for. Comma-separated, override via env var if the frontend stack changes.
export const FRONTEND_ALLOWED_EXTENSIONS = (process.env.FRONTEND_ALLOWED_EXTENSIONS || ".html,.css,.scss,.jsx,.tsx,.vue")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Bounds delegate_designer's generate -> validate -> fix loop (connectors/
// frontend/validate.js + checkpoint.js). Mirrors delegate_gemini's
// HARD_MAX_STEPS reasoning -- both bounds LLM call cost and keeps a single
// resumable unit of work small. A run that can't converge within this many
// attempts writes its best (most-recently-generated) attempt with an
// unresolved-issues note rather than looping indefinitely.
export const FRONTEND_MAX_ATTEMPTS = Number(process.env.FRONTEND_MAX_ATTEMPTS) || 3;

// Wall-clock budget for the WHOLE validate-fix loop within one delegate_
// designer call, checked before starting each attempt -- distinct from
// FRONTEND_REQUEST_TIMEOUT_MS above, which bounds a single LLM call. A
// 3-attempt loop (3 LLM calls) can plausibly exceed a hosting platform's
// own request-duration ceiling (the same constraint that motivated
// delegate_gemini's checkpoint/resume, see its HARD_MAX_STEPS comment) even
// though no single attempt does. When exceeded, the loop checkpoints
// (connectors/frontend/checkpoint.js) and returns a resume_run_id instead of
// continuing past the platform's own limit. Set comfortably below that
// limit, not up against it.
export const FRONTEND_TOTAL_BUDGET_MS = Number(process.env.FRONTEND_TOTAL_BUDGET_MS) || 45000;

// ---------------------------------------------------------------------------
// GitHub App -- scoped, short-lived clone tokens for PRIVATE repos (2026-07-28
// plan, see Notion entity_id madmcp-github-app-scoped-clone-token-plan).
// Deliberately a SEPARATE credential from GITHUB_TOKEN above: GITHUB_TOKEN is
// a broad, long-lived token used by every other GitHub tool in this
// connector, while this App is scoped ONLY to contents:read and installed
// only on repos that need sandbox-clone access. connectors/github/app_auth.js
// mints per-repo installation tokens from these credentials on demand
// (~1hr TTL, GitHub's max), returned to the calling model so it can `git
// clone` a private repo into its own sandbox -- see that file's header for
// why the token has to pass through the calling model at all (the sandbox
// can't reach this server directly to fetch it itself).
// GITHUB_APP_PRIVATE_KEY: paste the PEM as-is; if your env var tooling can't
// store literal newlines, escape them as \n and app_auth.js unescapes them.
export const GITHUB_APP_ID              = process.env.GITHUB_APP_ID;
export const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
export const GITHUB_APP_PRIVATE_KEY     = process.env.GITHUB_APP_PRIVATE_KEY;

// Server-side cache buffer (connectors/github/app_auth.js): a cached token
// is only reused if AT LEAST this many seconds of validity remain; otherwise
// a fresh one is minted. Exists so a token doesn't get handed out with (say)
// 10 seconds left, expiring mid-clone on a large repo/slow connection.
export const GITHUB_APP_TOKEN_CACHE_BUFFER_SECONDS = Number(process.env.GITHUB_APP_TOKEN_CACHE_BUFFER_SECONDS) || 300;

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
