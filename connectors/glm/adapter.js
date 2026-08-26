// ---------------------------------------------------------------------------
// connectors/glm/adapter.js — the actual seam of the GLM provider switch.
// See plan.md "Add GLM (via OpenRouter) as a switchable alternative to
// Gemini", step 3.
//
// Three pure functions translate between Gemini's `contents`/`candidate`
// wire shape (the lingua franca agent_delegate.js's loop, checkpointing,
// and stuck-loop/step-budget logic are all built around) and OpenRouter's
// OpenAI-compatible `messages`/`choice` shape:
//
//   toOpenAIMessages(contents)          Gemini contents -> OpenAI messages
//   toOpenAITools(functionDeclarations) Gemini tools wrapper -> OpenAI tools
//   fromOpenAIChoice(choice)            OpenAI choice -> Gemini candidate
//
// This is the highest-risk file in the whole GLM provider switch (a subtle
// role/shape mismatch here would silently corrupt checkpointed
// conversations) -- see test/glm-adapter.test.js for the round-trip test
// this was written against.
// ---------------------------------------------------------------------------

// Gemini `contents` shape: an array of
//   { role: "user"|"model", parts: [ {text} | {functionCall:{name,args,id}} | {functionResponse:{name,id,response:{result}}} ] }
// Function-call RESULTS go back as role "user" wrapping a functionResponse
// part (current Gemini 3 contract, see gemini/client.js's own header) --
// NOT a distinct "function" role, and a single "user" turn can mix
// functionResponse parts with plain SYSTEM NOTE text parts (agent_delegate.js
// appends step-budget/stuck-loop nudges onto the same responseParts array
// as the functionResponse entries for that step).
//
// OpenAI chat shape has no equivalent of "one turn, several kinds of
// content" for a tool-result turn: each tool result is its OWN message
// with role "tool" and a tool_call_id, and any plain user-facing text has
// to be its own separate "user" message. So one Gemini "user" turn can
// expand into MULTIPLE OpenAI messages (one "tool" message per
// functionResponse part, in original order, followed by a "user" message
// if there's leftover plain text) -- order matters here: OpenAI requires
// every "tool" message immediately following the assistant message that
// requested it, before any new "user" content.
export function toOpenAIMessages(contents) {
  const messages = [];
  for (const turn of contents || []) {
    const parts = turn.parts || [];
    if (turn.role === "model") {
      const functionCallParts = parts.filter((p) => p.functionCall);
      const textParts = parts.filter((p) => p.text !== undefined && p.text !== null);
      const message = { role: "assistant", content: textParts.map((p) => p.text).join("") || null };
      if (functionCallParts.length) {
        message.tool_calls = functionCallParts.map((p) => ({
          // Gemini always assigns functionCall.id itself when it emits a
          // call -- the fallback below only guards a synthetic/test
          // `contents` array that omits it, not anything the real
          // client.js/agent_delegate.js loop produces.
          id: p.functionCall.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
        }));
      }
      messages.push(message);
    } else {
      // role "user" -- may be the original task text (turn 1), a batch of
      // functionResponse results, or (per agent_delegate.js's step-budget /
      // stuck-loop nudges) a mix of functionResponse parts plus a trailing
      // plain-text SYSTEM NOTE in the SAME turn.
      const functionResponseParts = parts.filter((p) => p.functionResponse);
      const textParts = parts.filter((p) => p.text !== undefined && p.text !== null && !p.functionResponse);

      for (const p of functionResponseParts) {
        const result = p.functionResponse.response?.result;
        messages.push({
          role: "tool",
          tool_call_id: p.functionResponse.id,
          content: typeof result === "string" ? result : JSON.stringify(result ?? p.functionResponse.response ?? ""),
        });
      }

      const text = textParts.map((p) => p.text).join("");
      if (text) {
        messages.push({ role: "user", content: text });
      }
    }
  }
  return messages;
}

// `tools` as agent_delegate.js actually passes it is FUNCTION_DECLARATIONS:
// `[{ functionDeclarations: FUNCTIONS.map(({name,description,parameters}) => ({...})) }]`
// -- a one-element array wrapping an object keyed `functionDeclarations`,
// Gemini's specific wire shape. Unwrap that before mapping each
// {name, description, parameters} entry into OpenAI's
// {type:"function", function:{name, description, parameters}} shape.
// Treating the incoming value as already a flat array of declarations (an
// earlier draft of the plan this was built from assumed this) would
// silently produce zero tools -- see plan.md step 3's "corrected from the
// original draft" note.
export function toOpenAITools(tools) {
  if (!tools) return undefined;
  const declarations = Array.isArray(tools)
    ? tools.flatMap((t) => t?.functionDeclarations || [])
    : (tools.functionDeclarations || []);
  if (!declarations.length) return undefined;
  return declarations.map(({ name, description, parameters }) => ({
    type: "function",
    function: { name, description, parameters },
  }));
}

// OpenAI `choice` shape: { message: { role, content, tool_calls? },
// finish_reason }. Produces the same `candidate` shape agent_delegate.js
// already consumes from geminiChat: { content: { role: "model", parts:
// [...] }, finishReason }.
//
// KNOWN, ACCEPTED ASYMMETRY (see plan.md step 3): agent_delegate.js
// special-cases candidate.finishReason === "MALFORMED_FUNCTION_CALL" to
// give an actionable error when the final/stuck-loop step withholds tools
// but the model tries to call one anyway. That's a Gemini-specific
// rejection code -- an OpenAI-compatible API with no `tools` in the
// request body has no way to attempt a tool call at all (it just returns
// plain text, or a finish_reason like "length"), so this function will
// never produce that finishReason value for GLM. Not a bug to patch here:
// it means GLM's failure message on that specific edge case is the
// generic "Gemini stopped without a final answer -- finishReason: stop"
// rather than the Gemini-specific diagnostic. Do not invent a fake
// MALFORMED_FUNCTION_CALL equivalent to paper over this.
export function fromOpenAIChoice(choice) {
  const message = choice?.message || {};
  const parts = [];

  if (message.content) {
    parts.push({ text: message.content });
  }
  if (message.tool_calls?.length) {
    for (const toolCall of message.tool_calls) {
      let args;
      try {
        args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
      } catch {
        // Malformed JSON from the model -- pass through an empty args
        // object rather than throwing here; the downstream function
        // execute() call will surface a clearer error for the specific
        // function than a raw JSON.parse failure would.
        args = {};
      }
      parts.push({ functionCall: { name: toolCall.function?.name, args, id: toolCall.id } });
    }
  }

  return {
    content: { role: "model", parts },
    finishReason: choice?.finish_reason,
  };
}
