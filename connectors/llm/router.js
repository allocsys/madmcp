// ---------------------------------------------------------------------------
// connectors/llm/router.js — provider router both Gemini and GLM sit
// behind, so agent_delegate.js's loop body doesn't need to know which
// provider it's talking to. See plan.md step 4.
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
import { toOpenAIMessages, toOpenAITools, fromOpenAIChoice } from "../glm/adapter.js";

export async function providerChat(contents, { provider = "gemini", tools, model } = {}) {
  if (provider === "glm") {
    const messages = toOpenAIMessages(contents);
    const openAITools = tools ? toOpenAITools(tools) : undefined;
    const choice = await glmChat(messages, { model, tools: openAITools });
    return fromOpenAIChoice(choice);
  }
  // default / "gemini"
  return geminiChat(contents, { tools, model });
}
