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

// ---------------------------------------------------------------------------
// QStash (Upstash) -- backs Scenario B, delegate_agent's
// self-chaining background worker (connectors/gemini/agent_worker.js +
// connectors/gemini/qstash_client.js). Same Upstash account/dashboard as
// the Redis checkpoint store above (agent_checkpoint.js/cooldown.js), a new
// product under it, not a new vendor.
//
// QSTASH_TOKEN / QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY are
// read directly from process.env inside qstash_client.js (same
// not-exported-as-a-named-constant pattern as UPSTASH_REDIS_REST_URL/TOKEN
// above) -- listed here only so every QStash-related env var is
// discoverable in one place, not because config.js exports them.

// PUBLIC, absolute URL QStash will POST to (e.g.
// "https://<your-deployment>.vercel.app/api/agent-worker") -- QStash calls
// this server from the open internet, so it cannot be a relative path or
// localhost. Required for the async path to work at all; if unset,
// qstash_client.js's isQStashConfigured() reports false and delegate_agent
// silently stays on today's fully-synchronous behavior regardless of
// DELEGATE_AGENT_ASYNC below.
export const AGENT_WORKER_URL = process.env.AGENT_WORKER_URL;

// Rollout flag: "qstash" opts into Scenario B end to end
// (async start + poll/stale-fallback branching in agent_tools.js); any
// other value (including unset, the default) keeps delegate_agent on
// today's fully-synchronous behavior with no code path change at all --
// flip back to disable Scenario B instantly without a revert if the chain
// misbehaves in production. See plan.md's "Sequencing note".
export const DELEGATE_AGENT_ASYNC = process.env.DELEGATE_AGENT_ASYNC || "sync";

// How fresh a checkpoint's lastStepAt must be for a resume_run_id poll to
// be treated as "the background worker chain is still actively stepping"
// (poll-only, don't touch the loop) rather than "the chain likely broke"
// (fall back to resuming synchronously in this call) -- see plan.md's
// "Tool behavior change". 25s default: comfortably longer than one Gemini
// turn plus a QStash publish round-trip normally takes, short enough that a
// genuinely-broken chain is detected and recovered from within a couple of
// poll calls rather than minutes.
export const AGENT_ASYNC_POLL_FRESH_SECONDS = Number(process.env.AGENT_ASYNC_POLL_FRESH_SECONDS) || 25;

// Dead-letter threshold (plan.md step 8): how many consecutive times the
// SAME step can fail (a worker invocation that completes without
// advancing stepsDone) before agent_worker.js stops re-chaining and
// finalizes the checkpoint as "failed" instead of retrying forever. A
// genuinely transient 429/503 succeeds well before this many attempts
// (QStash's own delivery retries already space attempts out in practice);
// this bounds the cost of a permanently broken run (bad config, a
// non-transient error) rather than burning QStash messages/Gemini quota on
// it indefinitely.
export const AGENT_WORKER_MAX_CONSECUTIVE_FAILURES = Number(process.env.AGENT_WORKER_MAX_CONSECUTIVE_FAILURES) || 5;

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
// OpenRouter (GLM) -- second `delegate_agent` provider option alongside
// Gemini, see plan.md "Add GLM (via OpenRouter) as a switchable alternative
// to Gemini". Selected per-call via the `provider` arg on delegate_agent,
// defaulting to DEFAULT_LLM_PROVIDER below so nothing breaks for existing
// callers who don't pass it.
//
// OPENROUTER_API_KEYS is PLURAL and comma-separated, same multi-key
// rotation pattern as EXA_API_KEYS above (rate-limit headroom + account
// isolation) -- deliberately NOT the same name as the singular
// OPENROUTER_API_KEY already referenced in README.md/docs/API_KEYS.md/
// docs/env.html from an earlier, never-wired-up pass. Those docs are being
// updated to the plural name in the same change that introduces this (see
// plan.md step 9) specifically so operators don't set the old singular name
// and have it silently ignored.
export const OPENROUTER_API_KEYS = (process.env.OPENROUTER_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

// Default + fallback cascade for GLM, same shape/reasoning as GEMINI_MODEL /
// GEMINI_FALLBACK_MODELS above.
// UPDATED 2026-08-27: account's OpenRouter credit balance is exhausted and
// is deliberately NOT being topped up (explicit call, not a temp workaround),
// so GLM_MODEL now defaults to z-ai/glm-4.5-air:free (the best/only
// consistently-free GLM slug confirmed live on OpenRouter as of this date --
// z-ai/glm-4.6/glm-4.5 are paid-only) rather than a paid model that will
// just 402 immediately on every call. Previously GLM_MODEL defaulted to the
// paid z-ai/glm-4.6 with :air:free as a fallback-on-429 entry; that ordering
// only made sense when the account had paid headroom. Re-flip this (and
// restore a paid fallback cascade) once/if credits are added back --
// verify current free-tier slugs against https://openrouter.ai/models
// before assuming this one is still free, since availability rotates.
export const GLM_MODEL = process.env.GLM_MODEL || "z-ai/glm-4.5-air:free";
export const GLM_FALLBACK_MODELS = (process.env.GLM_FALLBACK_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Same defensive-ceiling reasoning as GEMINI_REQUEST_TIMEOUT_MS above.
export const GLM_REQUEST_TIMEOUT_MS = Number(process.env.GLM_REQUEST_TIMEOUT_MS) || 55000;

// Default cap on GLM's max_tokens when a caller (delegate_agent's `model`/
// maxOutputTokens args, see agent_tools.js) doesn't specify one explicitly.
// Root cause this exists for (found 2026-08-26 in live testing): with no
// max_tokens set at all, OpenRouter defaults a chat completion request to
// the target model's full max context -- 65536 for z-ai/glm-4.6 -- which
// this account's OpenRouter credit balance cannot cover regardless of which
// GLM model is selected, surfacing as a 402 "requires more credits, or
// fewer max_tokens" on every call. Applied in router.js's glm branch (not
// here in config, and not in glm/client.js -- see router.js's comment for
// why that's the right layer), so a caller who DOES pass an explicit
// maxOutputTokens is never overridden by this default. 8192 is a
// conservative starting point for an investigation loop's per-turn text
// output (not the whole conversation, just one turn) -- raise via env var
// if a task's answers are getting cut off, or lower it if credits remain
// tight even at this level.
export const GLM_DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.GLM_DEFAULT_MAX_OUTPUT_TOKENS) || 8192;

// Which provider delegate_agent uses when the caller doesn't pass `provider`.
// Stays "gemini" until GLM is validated head-to-head on real review tasks
// (see plan.md "Rollout") -- this is an explicit opt-in switch, not
// automatic best-model routing.
export const DEFAULT_LLM_PROVIDER = process.env.DEFAULT_LLM_PROVIDER || "gemini";

// ---------------------------------------------------------------------------
// Groq -- third `delegate_agent` provider option (see plan.md "Groq provider
// addition"), added because GLM/OpenRouter's free tier turned out to be
// gated by account credit balance (see plan.md "Current status" -- a
// zero-balance account is blocked from OpenRouter's free models too, not
// just paid ones). Groq's free tier is documented as request/token-rate-
// limited instead, not tied to a dollar balance, and needs no credit card.
// Also OpenAI-compatible like OpenRouter, so it reuses the same
// translation layer (see connectors/openai_shape/adapter.js, extracted
// from connectors/glm/adapter.js specifically so both providers share one
// implementation instead of two copies drifting apart).
//
// GROQ_API_KEYS is plural/comma-separated, same rotation pattern as
// OPENROUTER_API_KEYS/EXA_API_KEYS above.
export const GROQ_API_KEYS = (process.env.GROQ_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";

// Model choice verified directly against https://console.groq.com/docs/models
// on 2026-08-27 (not from third-party benchmarks alone): Groq explicitly
// classifies qwen/qwen3.6-27b as a PREVIEW model ("intended for evaluation
// purposes only... may be discontinued at short notice") despite it
// scoring highest on Groq's own intelligence ranking, while
// openai/gpt-oss-120b is a PRODUCTION model. For a persistent, unattended
// delegate_agent provider, availability stability matters more than a
// benchmark edge, so production is the default and the stronger-but-
// preview model is only the fallback -- do not swap this ordering without
// re-reading plan.md's "Model choice -- CORRECTED" note first.
export const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
export const GROQ_FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS || "qwen/qwen3.6-27b")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Same defensive-ceiling reasoning as GEMINI_REQUEST_TIMEOUT_MS/
// GLM_REQUEST_TIMEOUT_MS above.
export const GROQ_REQUEST_TIMEOUT_MS = Number(process.env.GROQ_REQUEST_TIMEOUT_MS) || 55000;

// Default cap on Groq's max_tokens when a caller doesn't specify one
// explicitly -- set UP FRONT this time, unlike GLM_DEFAULT_MAX_OUTPUT_TOKENS,
// which was only added reactively after a live 402 revealed OpenRouter has
// no sane default at all (see plan.md's "Current status" and the Groq
// section's step 1 note: don't repeat that discovery-by-failure cycle).
// 4096 follows Groq's own tool-use guidance ("set max_completion_tokens to
// 3000-4000 for complex tasks" -- see console.groq.com/docs on built-in
// tool use). NOT YET LIVE-VERIFIED: Groq's chat completions endpoint is
// OpenAI-compatible, but it's unconfirmed whether it honors the legacy
// `max_tokens` field name (what connectors/openai_shape/adapter.js and
// glm/client.js both send) the same way for every model, or whether some
// Groq models expect the newer `max_completion_tokens` name instead --
// this needs live-testing in plan.md step 9 before being treated as
// settled, exactly the kind of thing pre-emptive comments can flag but not
// substitute for actually running the smoke test.
export const GROQ_DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.GROQ_DEFAULT_MAX_OUTPUT_TOKENS) || 4096;

// ---------------------------------------------------------------------------
// Frontend/design delegate (connectors/frontend/) -- delegate_designer's
// write-capable agent loop (agent.js), backed by the existing Gemini
// connector (geminiChat/GEMINI_API_KEY/GEMINI_MODEL above) -- no separate
// provider config needed here.

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

// ---------------------------------------------------------------------------
// delegate_designer (issue #61 agent redesign) -- bounds
// connectors/frontend/designer_delegate.js's runDesignAgent loop, the read_file/
// write_file/validate-based replacement for the generate->validate->fix
// loop above. Deliberately TIGHTER than delegate_agent's 20 default / 30
// hard cap (see the GEMINI connector's HARD_MAX_STEPS in connectors/gemini/
// agent_delegate.js): this agent's tool set (read/write/validate on frontend
// files within one branch) is far narrower than delegate_agent's open-ended
// cross-system investigation surface, so it doesn't need investigation-scale
// step counts to do useful work. Resolved 2026-08-01 per the Notion design
// doc's open question -- see issue #61.
export const FRONTEND_DEFAULT_STEPS  = Number(process.env.FRONTEND_DEFAULT_STEPS) || 12;
export const FRONTEND_HARD_MAX_STEPS = Number(process.env.FRONTEND_HARD_MAX_STEPS) || 20;

// validate() calls do NOT count against the step budget above (a validate
// call is cheap -- local syntax checking, no LLM/network round trip beyond
// the agent's own turn -- so charging a full step for it would waste budget
// that's better spent on read_file/write_file turns). Capped independently,
// PER FILE PATH, so a model stuck in a validate/tweak/validate loop on one
// file can't thrash indefinitely without ever burning a step -- resolved
// alongside FRONTEND_DEFAULT_STEPS above, same source.
export const FRONTEND_MAX_VALIDATE_CALLS = Number(process.env.FRONTEND_MAX_VALIDATE_CALLS) || 5;

// ---------------------------------------------------------------------------
// delegate_editor (plan.md, "Limited GitHub write access for delegate_agent
// (non-default-branch only)") -- config surface for steps 2-6 (allow/deny
// lists, write caps, step budget, validate-call cap). The tools layer
// (editor_tool_functions.js, step 3), checkpoint layer (editor_checkpoint.js,
// step 4), agent loop (editor_delegate.js, step 5), and validate wiring
// (editor_validate.js, step 6) are all built and unit-testable as of this
// comment. MCP registration (step 7, editor_tools.js) is what actually
// exposes this to a caller -- see EDITOR_AGENT_ENABLED below, which gates
// that registration and stays "false" by default per plan.md step 10's
// rollout posture until a human flips it on deliberately.
//
// Deliberately a SEPARATE config surface from FRONTEND_ALLOWED_EXTENSIONS
// above, not a superset/reuse of it -- delegate_designer's scope is
// intentionally narrower (frontend file types only) and this plan's
// Non-goals section says explicitly that tool's fencing isn't being
// loosened. EDITOR_* below is for the new, broader-scope tool only.

// Guardrail #3 (path/extension allowlist, "configurable per run rather than
// hardcoded to frontend types"): unlike FRONTEND_ALLOWED_EXTENSIONS,
// general-purpose repo edits need BOTH an extension check AND a path-prefix
// check -- an extension-only check doesn't stop a write to e.g.
// .github/workflows/deploy.yml or server.js just because .yml/.js is
// allowed. Both lists below are permissive defaults (broad file types /
// "anywhere in the repo"); EDITOR_DENY_PATH_PATTERNS is what actually keeps
// this narrow in practice, as an independent second layer (guardrail #4),
// and a caller-supplied run can narrow further but never widen past these.
export const EDITOR_ALLOWED_EXTENSIONS = (process.env.EDITOR_ALLOWED_EXTENSIONS || ".js,.jsx,.ts,.tsx,.json,.md,.yml,.yaml,.html,.css,.scss,.vue,.txt")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Path PREFIXES (not globs -- kept simple/explicit for v1) this tool is
// allowed to write under. Empty list means "no path restriction beyond the
// deny list" -- callers narrow this per-run via their own argument, not by
// widening it here.
export const EDITOR_ALLOWED_PATH_PREFIXES = (process.env.EDITOR_ALLOWED_PATH_PREFIXES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Guardrail #4: hard deny list, independent of and layered ON TOP OF the
// allowlist above -- checked regardless of what the allowlist permits.
// Matched as a path-prefix/glob-lite (simple leading-segment or trailing
// "**" match, see editor_policy.js), not a full glob engine, to keep the
// matching logic itself easy to audit.
//   - .github/workflows/**   -- CI definitions; a write here is a
//     privilege-escalation vector, since CI often runs with more trust
//     than a branch push does.
//   - connectors/security.js, connectors/github/app_auth.js,
//     connectors/github/clone_token.js -- auth-adjacent code.
//   - package.json is NOT fully denied (docs/version bumps etc. are
//     legitimate edits) -- its `scripts`/`dependencies`/`devDependencies`
//     fields specifically are what guardrail #4 flags as supply-chain
//     risk; that's a content-level check (see editor_policy.js), not
//     expressible as a path pattern, so it's enforced separately rather
//     than by denying the whole file here.
export const EDITOR_DENY_PATH_PATTERNS = (process.env.EDITOR_DENY_PATH_PATTERNS || ".github/workflows/**,connectors/security.js,connectors/github/app_auth.js,connectors/github/clone_token.js")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Guardrail #6: per-run and per-file write caps, same reasoning/shape as
// FRONTEND_MAX_VALIDATE_CALLS -- bound the blast radius of a stuck or
// misbehaving loop before a human ever looks at the branch. Also covers
// the "long sequential chain" exposure noted in plan.md's parallel-
// orchestration resolution (a chain of many small edits over time can
// touch as much surface as a simultaneous batch would have).
export const EDITOR_MAX_FILES_PER_RUN    = Number(process.env.EDITOR_MAX_FILES_PER_RUN) || 15;
export const EDITOR_MAX_WRITES_PER_FILE  = Number(process.env.EDITOR_MAX_WRITES_PER_FILE) || 5;

// Guardrail #5 (step 6): validate() calls do NOT count against the step
// budget below (same reasoning as FRONTEND_MAX_VALIDATE_CALLS -- a cheap
// local syntax check, no LLM/network round trip beyond the agent's own
// turn), but are capped independently, per file path, so a model can't
// thrash a validate/tweak/validate loop on one file without ever burning a
// step. Same default as FRONTEND_MAX_VALIDATE_CALLS for consistency.
export const EDITOR_MAX_VALIDATE_CALLS   = Number(process.env.EDITOR_MAX_VALIDATE_CALLS) || 5;

// Step budget -- same shape/reasoning as FRONTEND_DEFAULT_STEPS/
// FRONTEND_HARD_MAX_STEPS. Left slightly higher than delegate_designer's
// since general-purpose edits (reading more context files before writing)
// are less narrowly scoped than frontend-only files, but still well below
// delegate_agent's open-ended investigation budget.
export const EDITOR_DEFAULT_STEPS  = Number(process.env.EDITOR_DEFAULT_STEPS) || 15;
export const EDITOR_HARD_MAX_STEPS = Number(process.env.EDITOR_HARD_MAX_STEPS) || 24;

// Rollout flag (plan.md step 10), same "disable without a revert" reasoning
// as DELEGATE_AGENT_ASYNC above. FLIPPED TO DEFAULT-ON 2026-08-28 per explicit
// operator request -- delegate_editor is now registered and callable unless
// this is explicitly set to "false". Prior to this change it defaulted off
// pending a deliberate human decision (plan.md step 10's original rollout
// posture, and its own step 9 notes that checkpoint/validate-specific unit
// tests and a live end-to-end smoke test were still outstanding at the time
// this was flipped -- see plan.md's progress log).
export const EDITOR_AGENT_ENABLED = process.env.EDITOR_AGENT_ENABLED !== "false";

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

// Grace period (connectors/github/app_auth.js): how long a freshly minted
// clone token is allowed to live before this server auto-revokes it via
// GitHub's revoke endpoint, making it effectively single-use rather than
// relying on GitHub's own ~1hr installation-token TTL. Enforced via
// @vercel/functions' waitUntil() (requires Fluid Compute), not a bare
// setTimeout -- Vercel can freeze/tear down a serverless invocation right
// after its response is sent, so a plain unref()'d timer isn't reliable
// there. 30s by default -- short, to minimize compute kept alive per call;
// raise it (env var) if clones of a particularly large private repo start
// getting cut off mid-transfer.
export const GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS = Number(process.env.GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS) || 30;

// Jules (Google's async coding agent) REST API. Alpha API -- no
// unauthenticated tier, unlike Context7 above; JULES_API_KEY is required
// for any jules_* tool to work. Get a key from the Jules web app's Settings
// page (https://jules.google.com/settings#api), max 3 keys per account.
export const JULES_API_KEY = process.env.JULES_API_KEY;
export const JULES_API     = "https://jules.googleapis.com/v1alpha";

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
