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

// Throttle + retry for the Notion API (fix #3 -- rate-limit asymmetry,
// 2026-07-27). Notion's documented average rate limit is ~3 requests/second
// per integration; this spacing keeps a single madmcp instance comfortably
// under that even when several Notion calls land in the same parallelized
// delegate_agent step. Mirrors GITHUB_MIN_REQUEST_INTERVAL_MS/
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
// mem0_notion.js). Was the "Memory Index" page, but that page went 404
// (deleted/unshared) during a manual Notion reorg on 2026-08-01. Now
// defaults to the "Claude" page (id below), adopted as the new root --
// override via env var if that page is ever moved/recreated, same pattern
// as NOTION_INDEX_PAGE_ID above.
export const NOTION_SYNC_PARENT_PAGE_ID = process.env.NOTION_SYNC_PARENT_PAGE_ID || "3a045572-b580-8007-b622-c120958557bf";

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
// GEMINI_API_KEYS is plural/comma-separated, same multi-key rotation pattern
// as EXA_API_KEYS/OPENROUTER_API_KEYS/GROQ_API_KEYS elsewhere in this repo --
// added because the Gemini connector previously only supported a single key
// (GEMINI_MODEL/GEMINI_FALLBACK_MODELS' per-model cascade covered rate-limit
// headroom on ONE account, but not a second account/project's quota, or
// account-level 401/403 exhaustion). Falls back to the legacy singular
// GEMINI_API_KEY if GEMINI_API_KEYS is unset, so existing single-key
// deployments keep working with zero config changes.
export const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Kept for any call site still expecting a single value (e.g. server.js's
// status endpoint) -- always the first configured key, or undefined if none.
export const GEMINI_API_KEY = GEMINI_API_KEYS[0];
export const GEMINI_API     = "https://generativelanguage.googleapis.com/v1beta";
// Default model -- override via env var if this drifts out of date; Google
// renames/retires Gemini model IDs periodically, so don't assume this stays
// current without checking https://ai.google.dev/gemini-api/docs/models.
export const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-flash-latest";
export const HISTORY_COMPACTION_PROVIDERS = (process.env.HISTORY_COMPACTION_PROVIDERS ?? "bai")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
// connection leaves agent_delegate.js's per-step checkpointing unable to kick in
// at all (the call just never returns). Override via env var if this proves
// too tight for slower multi-tool-call turns, or too loose relative to the
// hosting platform's own request-duration limit.
export const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 55000;

// Read/write isolation for the Gemini connector's Notion access (2026-07-25
// plan): Gemini tools may READ any page/database reachable via the existing
// Notion connector (Memory Index, Entity Index, Job Leads, etc.), but may
// only WRITE under this one page -- deliberately NOT a caller-supplied
// parameter anywhere in connectors/delegate/agent/, so there is no code path that
// lets a Gemini tool call target a write anywhere else. A bad or
// hallucinated Gemini write can only ever land inside this subtree, never
// inside the Claude-side Memory Index / Entity Index / Job Leads structures
// that other tools' dedup and sync logic depend on.
// "Gemini" page, created as a sibling of the "Claude" root page.
export const GEMINI_NOTION_ROOT_PAGE_ID = process.env.GEMINI_NOTION_ROOT_PAGE_ID || "3a845572-b580-81d0-8653-f64596e45e58";

export const AGENT_WORKER_URL = process.env.AGENT_WORKER_URL;

// Failure-callback target + retry budget for publishAgentStep/publishEditorStep
// (plan.md Section 13, fixing the live dead-letter blind spot confirmed in
// Section 12). Previously client.publishJSON() was called with neither
// `retries` nor `failureCallback` set, so QStash fell back to its own
// defaults: 3 retries with exponential backoff (~12s, ~2m28s, ~30m8s --
// worst case ~40min to exhaust), and, critically, NO notification to this
// app when that budget runs out. agent_worker.js's own dead-letter check
// (effectiveRetryCount via the Upstash-Retried header) only runs INSIDE a
// live worker invocation -- but a step that hard-times-out on every single
// QStash delivery attempt (the Section 11 output-size problem, not a
// transient blip) means no further invocation ever arrives once QStash's
// budget is spent, so that check never gets a chance to fire. The
// checkpoint is left at status:"running" forever with nothing to catch it.
//
// Fix: QSTASH_STEP_RETRIES=0 (retrying a step that will deterministically
// time out again buys nothing but another guaranteed 300s -- there's no
// "maybe it was transient" case here worth paying for; genuinely transient
// provider errors like Gemini 429/503 are caught and re-chained by this
// app's OWN retryCount logic via a fresh publish, not by QStash redelivering
// the same message, so this doesn't reduce that coverage) plus a
// failureCallback so QStash tells the app directly, in one HTTP round trip,
// the moment its (now much smaller) retry budget is exhausted -- instead of
// silently going nowhere.
export const QSTASH_STEP_RETRIES = Number.isInteger(Number(process.env.QSTASH_STEP_RETRIES)) ? Number(process.env.QSTASH_STEP_RETRIES) : 0;

// Derives a sibling "-failure" endpoint URL from a worker URL by swapping
// its path suffix, same pattern as deriveEditorWorkerUrl() further below --
// kept as its own small helper (rather than only inline in
// deriveEditorWorkerUrl) so both AGENT_WORKER_FAILURE_URL here and
// EDITOR_WORKER_FAILURE_URL below can share it without one being defined in
// terms of the other's unrelated derivation function.
function deriveFailureUrl(workerUrl, fromSuffix, toSuffix, envOverride) {
  if (envOverride) return envOverride;
  if (!workerUrl) return undefined;
  if (workerUrl.includes(fromSuffix)) return workerUrl.replace(fromSuffix, toSuffix);
  return undefined;
}
export const AGENT_WORKER_FAILURE_URL = deriveFailureUrl(AGENT_WORKER_URL, "/api/agent-worker", "/api/agent-worker-failure", process.env.AGENT_WORKER_FAILURE_URL);

export const DELEGATE_AGENT_ASYNC = process.env.DELEGATE_AGENT_ASYNC || "sync";
export const AGENT_ASYNC_POLL_FRESH_SECONDS = Number(process.env.AGENT_ASYNC_POLL_FRESH_SECONDS) || 60;
// Max plausible time a single delegate_agent step can legitimately take before
// being considered genuinely stuck/crashed (comfortably longer than bai's
// worst-case single-key retry time of ~55s plus QStash delivery lag). Used
// alongside AGENT_ASYNC_POLL_FRESH_SECONDS to guard against the crash blind
// spot where a worker dies mid-step and leaves stepStartedAt set indefinitely.
export const AGENT_ASYNC_STEP_DEAD_SECONDS = Number(process.env.AGENT_ASYNC_STEP_DEAD_SECONDS) || 120;
export const AGENT_WORKER_MAX_CONSECUTIVE_FAILURES = Number(process.env.AGENT_WORKER_MAX_CONSECUTIVE_FAILURES) || 5;
// Per-invocation debug logging in agent_worker.js (randomUUID() invocationId
// logged at every entry/exit point of handleAgentWorker -- added 2026-09-01,
// commit 2aad526, to diagnose a worker-chain stall). Was default OFF after
// the 2026-09-01 stall was diagnosed (sustained B.AI rate-limiting driving
// the existing retry/re-chain path, not a concurrent-duplicate idempotency
// bug) -- see plan.md Section 6 for why that diagnosis does NOT explain the
// separate, still-open "Void"/stall investigation in Section 5.
// FLIPPED TO DEFAULT ON (2026-09-02, plan.md Section 7): a NEW,
// reproducible-on-demand stall was found (an oversized single step -- many
// batched tool calls / large truncated file reads -- correlating with the
// worker chain going silent afterward). Turned logging back on by default
// to capture entry/exit + step-ok-rechain-failed evidence automatically if
// the pattern recurs, rather than requiring a manual flip after the fact.
// Revert to default OFF (process.env.DEBUG_AGENT_WORKER === "true") once
// Section 7's oversized-step hypothesis is confirmed or ruled out -- same
// log-volume reasoning as the original OFF default above.
export const DEBUG_AGENT_WORKER = process.env.DEBUG_AGENT_WORKER !== "false";

export const EXA_API_KEYS = (process.env.EXA_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const EXA_API = "https://api.exa.ai/answer";
export const EXA_REQUEST_TIMEOUT_MS = Number(process.env.EXA_REQUEST_TIMEOUT_MS) || 55000;

export const OPENROUTER_API_KEYS = (process.env.OPENROUTER_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
export const GLM_MODEL = process.env.GLM_MODEL || "z-ai/glm-4.5-air:free";
export const GLM_FALLBACK_MODELS = (process.env.GLM_FALLBACK_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const GLM_REQUEST_TIMEOUT_MS = Number(process.env.GLM_REQUEST_TIMEOUT_MS) || 55000;
export const GLM_DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.GLM_DEFAULT_MAX_OUTPUT_TOKENS) || 8192;
// Explicit per-provider enable flag (decouple-gemini-delegation plan, step
// 5): defaults to true, matching current behavior (glm is already
// reachable via providerChat's `provider: "glm"` with no gate at all).
// router.js checks this before ever calling glmChat -- set GLM_ENABLED=false
// to turn glm off deployment-wide with a clear config error instead of
// letting a bad/missing OPENROUTER_API_KEYS fail obscurely deep inside the
// glm client on first real use.
export const GLM_ENABLED = process.env.GLM_ENABLED !== "false";
export const DEFAULT_LLM_PROVIDER = process.env.DEFAULT_LLM_PROVIDER || "gemini";

export const GROQ_API_KEYS = (process.env.GROQ_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
export const GROQ_FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS || "qwen/qwen3.6-27b")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const GROQ_REQUEST_TIMEOUT_MS = Number(process.env.GROQ_REQUEST_TIMEOUT_MS) || 55000;
export const GROQ_DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.GROQ_DEFAULT_MAX_OUTPUT_TOKENS) || 4096;
// Same enable-flag pattern as GLM_ENABLED above -- see its comment for the
// full reasoning (decouple-gemini-delegation plan, step 5). Defaults to
// true, matching current behavior.
export const GROQ_ENABLED = process.env.GROQ_ENABLED !== "false";

// ---------------------------------------------------------------------------
// B.AI (api.b.ai) -- third delegate_agent provider option, OpenAI-compatible
// like GLM/Groq above. UNLIKE GLM/Groq: key-rotation-only cascade, no
// BAI_FALLBACK_MODELS (see connectors/bai/client.js's header for why --
// there's deliberately only ever one model behind this provider).
//
// NO BAI_DEFAULT_MAX_OUTPUT_TOKENS, unlike GLM_DEFAULT_MAX_OUTPUT_TOKENS /
// GROQ_DEFAULT_MAX_OUTPUT_TOKENS above: GLM's forced default exists because
// OpenRouter defaults an unset max_tokens to the target model's full
// context (65536), which 402'd against that account's exhausted paid
// credit balance -- a real, observed cost problem. B.AI's GLM-5.3-Flash is
// currently billed at 0 Credits (input/output/cache all free, see
// docs.b.ai/llmservice/models/glm-5-3-flash/), so there is no equivalent
// cost-runaway risk to guard against here. A caller-supplied
// maxOutputTokens is still honored exactly when given (see
// connectors/llm/router.js's "bai" branch); when omitted, no max_tokens is
// sent at all and B.AI's own model default applies (65536 for
// GLM-5.3-Flash per B.AI's docs) -- same "no forced default" contract as
// the Gemini provider branch. Revisit if B.AI's free-tier pricing changes.
export const BAI_API_KEYS = (process.env.BAI_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const BAI_API = "https://api.b.ai/v1/chat/completions";
// NOT YET LIVE-VERIFIED: B.AI's docs never state the literal API model-ID
// string for GLM-5.3-Flash (only a "your-model-id" placeholder throughout
// their reference). "glm-5.3-flash" is a best guess from the doc URL slug
// (docs.b.ai/llmservice/models/glm-5-3-flash/) -- confirm against
// GET https://api.b.ai/v1/models with a real key before relying on this in
// production.
export const BAI_MODEL = process.env.BAI_MODEL || "glm-5.3-flash";
// Same defensive-ceiling reasoning as GEMINI_REQUEST_TIMEOUT_MS above.
export const BAI_REQUEST_TIMEOUT_MS = Number(process.env.BAI_REQUEST_TIMEOUT_MS) || 55000;
// Same enable-flag pattern as GLM_ENABLED/GROQ_ENABLED above -- see
// GLM_ENABLED's comment for the full reasoning (decouple-gemini-delegation
// plan, step 5). FLIPPED TO DEFAULT OFF (2026-09-03): unlike GLM_ENABLED/
// GROQ_ENABLED, this now requires an explicit BAI_ENABLED=true to reach the
// bai provider at all -- set it to opt back in. Note this is independent of
// HISTORY_COMPACTION_PROVIDERS/connectors/bai/delegate_hooks.js above --
// BAI_ENABLED gates whether bai is reachable as a provider at all, not its
// delegate-loop-specific behavior once selected.
export const BAI_ENABLED = process.env.BAI_ENABLED === "true";

export const FRONTEND_ALLOWED_EXTENSIONS = (process.env.FRONTEND_ALLOWED_EXTENSIONS || ".html,.css,.scss,.jsx,.tsx,.vue")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
export const FRONTEND_DEFAULT_STEPS  = Number(process.env.FRONTEND_DEFAULT_STEPS) || 12;
export const FRONTEND_HARD_MAX_STEPS = Number(process.env.FRONTEND_HARD_MAX_STEPS) || 20;
export const FRONTEND_MAX_VALIDATE_CALLS = Number(process.env.FRONTEND_MAX_VALIDATE_CALLS) || 5;

export const EDITOR_ALLOWED_EXTENSIONS = (process.env.EDITOR_ALLOWED_EXTENSIONS || ".js,.jsx,.ts,.tsx,.json,.md,.yml,.yaml,.html,.css,.scss,.vue,.txt")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
export const EDITOR_ALLOWED_PATH_PREFIXES = (process.env.EDITOR_ALLOWED_PATH_PREFIXES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const EDITOR_DENY_PATH_PATTERNS = (process.env.EDITOR_DENY_PATH_PATTERNS || ".github/workflows/**,connectors/security.js,connectors/github/app_auth.js,connectors/github/clone_token.js")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const EDITOR_MAX_FILES_PER_RUN    = Number(process.env.EDITOR_MAX_FILES_PER_RUN) || 20;
export const EDITOR_MAX_WRITES_PER_FILE  = Number(process.env.EDITOR_MAX_WRITES_PER_FILE) || 20;
export const EDITOR_MAX_VALIDATE_CALLS   = Number(process.env.EDITOR_MAX_VALIDATE_CALLS) || 5;
export const EDITOR_DEFAULT_STEPS  = Number(process.env.EDITOR_DEFAULT_STEPS) || 20;
export const EDITOR_HARD_MAX_STEPS = Number(process.env.EDITOR_HARD_MAX_STEPS) || 30;
export const EDITOR_AGENT_ENABLED = process.env.EDITOR_AGENT_ENABLED !== "false";

// Async delegate_editor (plan.md Step 6) -- mirrors the AGENT_WORKER_URL/
// DELEGATE_AGENT_ASYNC/AGENT_ASYNC_*_SECONDS/AGENT_WORKER_MAX_CONSECUTIVE_FAILURES
// block above almost exactly, but kept as its own set of flags rather than
// reusing the AGENT_* ones directly -- delegate_editor's async rollout
// should be independently toggleable from delegate_agent's, same way
// EDITOR_AGENT_ENABLED above is already independent of anything gating
// delegate_agent.
// No dedicated EDITOR_WORKER_URL env var required: both worker endpoints
// live on the same deployment (server.js registers /api/agent-worker and
// /api/editor-worker side by side), so this defaults to AGENT_WORKER_URL
// with the path suffix swapped, riding on the SAME QSTASH_TOKEN +
// AGENT_WORKER_URL already configured for delegate_agent's async path --
// no new secret/URL needs to be provisioned just to light up delegate_editor's
// async worker chain. process.env.EDITOR_WORKER_URL still wins if explicitly
// set, for the (currently hypothetical) case of routing the editor worker to
// a different host than the agent worker.
function deriveEditorWorkerUrl() {
  if (process.env.EDITOR_WORKER_URL) return process.env.EDITOR_WORKER_URL;
  if (!AGENT_WORKER_URL) return undefined;
  if (AGENT_WORKER_URL.includes("/api/agent-worker")) {
    return AGENT_WORKER_URL.replace("/api/agent-worker", "/api/editor-worker");
  }
  // AGENT_WORKER_URL set but doesn't contain the expected path (unusual
  // override) -- no safe substring to swap, so don't guess; require an
  // explicit EDITOR_WORKER_URL in that case instead of silently publishing
  // to a made-up URL.
  return undefined;
}
export const EDITOR_WORKER_URL = deriveEditorWorkerUrl();
// Same failure-callback derivation as AGENT_WORKER_FAILURE_URL above --
// see that constant's comment for the full reasoning (plan.md Section 13).
export const EDITOR_WORKER_FAILURE_URL = deriveFailureUrl(EDITOR_WORKER_URL, "/api/editor-worker", "/api/editor-worker-failure", process.env.EDITOR_WORKER_FAILURE_URL);
export const EDITOR_AGENT_ASYNC = process.env.EDITOR_AGENT_ASYNC || "qstash";
// Same default as AGENT_ASYNC_POLL_FRESH_SECONDS -- no reason for the
// freshness window itself to differ between the two workers.
export const EDITOR_ASYNC_POLL_FRESH_SECONDS = Number(process.env.EDITOR_ASYNC_POLL_FRESH_SECONDS) || 60;
// Max plausible time a single delegate_editor step can legitimately take
// before being considered genuinely stuck/crashed. Used alongside
// EDITOR_ASYNC_POLL_FRESH_SECONDS to guard against the crash blind spot
// where a worker dies mid-step and leaves stepStartedAt set indefinitely --
// same reasoning as AGENT_ASYNC_STEP_DEAD_SECONDS above.
export const EDITOR_ASYNC_STEP_DEAD_SECONDS = Number(process.env.EDITOR_ASYNC_STEP_DEAD_SECONDS) || 120;
export const EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES = Number(process.env.EDITOR_WORKER_MAX_CONSECUTIVE_FAILURES) || 5;

export const GITHUB_APP_ID              = process.env.GITHUB_APP_ID;
export const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
export const GITHUB_APP_PRIVATE_KEY     = process.env.GITHUB_APP_PRIVATE_KEY;
export const GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS = Number(process.env.GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS) || 30;

export const JULES_API_KEY = process.env.JULES_API_KEY;
export const JULES_API     = "https://jules.googleapis.com/v1alpha";

export const MCP_SHARED_KEY = process.env.MCP_SHARED_KEY;

export const IP_ALLOWLIST_ENABLED = process.env.IP_ALLOWLIST_ENABLED !== "false";
export const ALLOWED_IP_RANGES = (process.env.ALLOWED_IP_RANGES || "160.79.104.0/21,208.77.244.90/32")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const TRUST_PROXY_HOPS = Number.isInteger(Number(process.env.TRUST_PROXY_HOPS))
  ? Number(process.env.TRUST_PROXY_HOPS)
  : 1;
