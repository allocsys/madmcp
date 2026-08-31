// ---------------------------------------------------------------------------
// connectors/llm/router.js — provider router both Gemini and GLM sit
// behind, so agent_delegate.js's loop body doesn't need to know which
// provider it's talking to.
//
// Always hands back Gemini-shaped `candidate` regardless of which provider
// actually ran -- GLM's OpenAI-shaped request/response never leaks past
// connectors/glm/adapter.js. Everything downstream in agent_delegate.js
// (reading candidate.content.parts, pushing {role:"model", parts} back onto
// contents, building functionResponse parts for the next turn) is
// unaffected by which provider handled a given call.
//
// No FUNCTION_DECLARATIONS import needed here: agent_delegate.js already has
// that value in scope where it currently calls geminiChat(contents, {
// tools }), and passes the same value straight through to
// providerChat(contents, { provider, tools }) -- this file only needs to
// know how to unwrap whatever `tools` it's handed (via toOpenAITools) when
// the provider is "glm".
// ---------------------------------------------------------------------------

import { geminiChat } from "../gemini/client.js";
import { glmChat } from "../glm/client.js";
import { groqChat } from "../groq/client.js";
import { baiChat } from "../bai/client.js";
import { toOpenAIMessages, toOpenAITools, fromOpenAIChoice } from "../openai_shape/adapter.js";
import { GLM_DEFAULT_MAX_OUTPUT_TOKENS, GROQ_DEFAULT_MAX_OUTPUT_TOKENS, BAI_DEFAULT_MAX_OUTPUT_TOKENS } from "../../config.js";

export async function providerChat(contents, { provider = "gemini", tools, model, maxOutputTokens } = {}) {
  if (provider === "glm") {
    const messages = toOpenAIMessages(contents);
    const openAITools = tools ? toOpenAITools(tools) : undefined;
    // A caller-supplied maxOutputTokens is honored exactly (same "explicit
    // choice wins" contract as `model` in client.js's cascade) -- the
    // GLM_DEFAULT_MAX_OUTPUT_TOKENS fallback only kicks in when nothing was
    // specified at all, which is the case that was silently sending no
    // max_tokens whatsoever and defaulting to the target model's full max
    // context (see config.js's comment on GLM_DEFAULT_MAX_OUTPUT_TOKENS for
    // why that was a real problem, not a hypothetical one).
    const choice = await glmChat(messages, { model, tools: openAITools, maxOutputTokens: maxOutputTokens ?? GLM_DEFAULT_MAX_OUTPUT_TOKENS });
    return fromOpenAIChoice(choice);
  }
  if (provider === "groq") {
    // Same adapter reuse and "explicit value wins, otherwise apply the
    // provider's own default" contract as the glm branch above -- see
    // connectors/groq/client.js's header and config.js's
    // GROQ_DEFAULT_MAX_OUTPUT_TOKENS comment for why a default is applied
    // pre-emptively here rather than after a live failure, unlike GLM's.
    const messages = toOpenAIMessages(contents);
    const openAITools = tools ? toOpenAITools(tools) : undefined;
    const choice = await groqChat(messages, { model, tools: openAITools, maxOutputTokens: maxOutputTokens ?? GROQ_DEFAULT_MAX_OUTPUT_TOKENS });
    return fromOpenAIChoice(choice);
  }
  if (provider === "bai") {
    // No forced maxOutputTokens default, unlike the glm/groq branches above
    // -- see config.js's comment on BAI_API_KEYS for why (B.AI's
    // GLM-5.3-Flash is free, so there's no equivalent cost-runaway risk to
    // guard against). A caller-supplied value is still honored exactly;
    // omitted, B.AI's own model default applies, same as the gemini branch
    // below.
    const messages = toOpenAIMessages(contents);
    const openAITools = tools ? toOpenAITools(tools) : undefined;
    const choice = await baiChat(messages, { tools: openAITools, maxOutputTokens });
    return fromOpenAIChoice(choice);
  }
  // default / "gemini" -- maxOutputTokens passed through as-is, no forced
  // default (see config.js's comment: this problem was only observed on
  // the GLM path, so Gemini's existing unbounded-by-default behavior is
  // left untouched rather than changed to fix an unrelated provider).
  return geminiChat(contents, { tools, model, maxOutputTokens });
}
