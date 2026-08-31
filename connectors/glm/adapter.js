// ---------------------------------------------------------------------------
// connectors/glm/adapter.js — thin re-export.
//
// EXTRACTED 2026-08-27: this
// file used to contain the full toOpenAIMessages/toOpenAITools/
// fromOpenAIChoice implementation, but none of it was ever OpenRouter-
// specific -- it's pure Gemini-shape <-> OpenAI-shape translation, equally
// applicable to any OpenAI-compatible provider. When Groq was added as a
// second such provider, the implementation moved to
// connectors/openai_shape/adapter.js so both providers share one copy
// instead of two that could silently drift apart (see that file's header
// for the full history/reasoning).
//
// This file stays as a re-export, not a deleted/renamed import site,
// specifically so nothing that already imports "../glm/adapter.js" (code
// or tests) needed to change as part of this extraction. New code should
// prefer importing directly from connectors/openai_shape/adapter.js --
// connectors/llm/router.js does, for both its "glm" and "groq" branches --
// but this path keeps working indefinitely, not just as a deprecation
// grace period.
// ---------------------------------------------------------------------------

export { toOpenAIMessages, toOpenAITools, fromOpenAIChoice } from "../openai_shape/adapter.js";
