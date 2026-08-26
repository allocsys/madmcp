import { describe, it, expect } from "vitest";
import { toOpenAIMessages, toOpenAITools, fromOpenAIChoice } from "../connectors/glm/adapter.js";

// This is the highest-risk file in the whole GLM provider switch (plan.md
// step 3): a subtle role/shape mismatch here would silently corrupt
// checkpointed conversations. Written against a synthetic but realistic
// multi-turn `contents` array shaped exactly like what agent_delegate.js's
// loop actually produces (task turn -> model turn with a function call ->
// user turn wrapping a functionResponse -> final model text turn), plus a
// SYSTEM NOTE-bearing turn (step-budget/stuck-loop nudges mix a
// functionResponse part with plain text in the SAME turn -- see
// agent_delegate.js's header).

describe("glm/adapter.js — toOpenAIMessages", () => {
  it("converts a task-only first turn to a plain user message", () => {
    const contents = [{ role: "user", parts: [{ text: "Task: investigate the thing" }] }];
    const messages = toOpenAIMessages(contents);
    expect(messages).toEqual([{ role: "user", content: "Task: investigate the thing" }]);
  });

  it("converts a model turn with only text to an assistant message with no tool_calls", () => {
    const contents = [{ role: "model", parts: [{ text: "Here is my answer." }] }];
    const messages = toOpenAIMessages(contents);
    expect(messages).toEqual([{ role: "assistant", content: "Here is my answer.", tool_calls: undefined }]);
  });

  it("converts a model turn with a functionCall to an assistant message with tool_calls", () => {
    const contents = [{
      role: "model",
      parts: [{ functionCall: { name: "github_read_file", args: { repo: "madmcp", path: "plan.md" }, id: "call_1" } }],
    }];
    const messages = toOpenAIMessages(contents);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBeNull();
    expect(messages[0].tool_calls).toEqual([{
      id: "call_1",
      type: "function",
      function: { name: "github_read_file", arguments: JSON.stringify({ repo: "madmcp", path: "plan.md" }) },
    }]);
  });

  it("converts a user turn wrapping a functionResponse to a role:tool message keyed by id", () => {
    const contents = [{
      role: "user",
      parts: [{ functionResponse: { name: "github_read_file", id: "call_1", response: { result: "file contents here" } } }],
    }];
    const messages = toOpenAIMessages(contents);
    expect(messages).toEqual([{ role: "tool", tool_call_id: "call_1", content: "file contents here" }]);
  });

  it("splits a mixed functionResponse + SYSTEM NOTE turn into a tool message followed by a user message, in order", () => {
    // Exactly the shape agent_delegate.js produces for a step-budget nudge:
    // responseParts.push({functionResponse...}) then
    // responseParts.push({text: "[SYSTEM NOTE: ...]"}) on the same turn.
    const contents = [{
      role: "user",
      parts: [
        { functionResponse: { name: "github_list_commits", id: "call_2", response: { result: "abc123 — fix bug" } } },
        { text: "[SYSTEM NOTE: only 2 step(s) remain after this one.]" },
      ],
    }];
    const messages = toOpenAIMessages(contents);
    expect(messages).toEqual([
      { role: "tool", tool_call_id: "call_2", content: "abc123 — fix bug" },
      { role: "user", content: "[SYSTEM NOTE: only 2 step(s) remain after this one.]" },
    ]);
  });

  it("stringifies a non-string functionResponse result", () => {
    const contents = [{
      role: "user",
      parts: [{ functionResponse: { name: "cf_query_logs", id: "call_3", response: { result: { count: 3 } } } }],
    }];
    const messages = toOpenAIMessages(contents);
    expect(messages[0].content).toBe(JSON.stringify({ count: 3 }));
  });

  it("round-trips a full multi-turn conversation in order", () => {
    const contents = [
      { role: "user", parts: [{ text: "Task: why is CI failing" }] },
      { role: "model", parts: [{ functionCall: { name: "github_get_check_runs", args: { repo: "madmcp", ref: "main" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_get_check_runs", id: "call_1", response: { result: "1 check run: lint: completed/failure" } } }] },
      { role: "model", parts: [{ text: "The lint check is failing." }] },
    ];
    const messages = toOpenAIMessages(contents);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1].tool_calls[0].function.name).toBe("github_get_check_runs");
    expect(messages[2].tool_call_id).toBe("call_1");
    expect(messages[3].content).toBe("The lint check is failing.");
  });
});

describe("glm/adapter.js — toOpenAITools", () => {
  const FUNCTION_DECLARATIONS = [{
    functionDeclarations: [
      { name: "github_read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "notion_search", description: "Search Notion.", parameters: { type: "object", properties: { query: { type: "string" } } } },
    ],
  }];

  it("unwraps agent_delegate.js's Gemini-shaped FUNCTION_DECLARATIONS wrapper into OpenAI's flat tools shape", () => {
    const tools = toOpenAITools(FUNCTION_DECLARATIONS);
    expect(tools).toEqual([
      { type: "function", function: { name: "github_read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
      { type: "function", function: { name: "notion_search", description: "Search Notion.", parameters: { type: "object", properties: { query: { type: "string" } } } } },
    ]);
  });

  it("returns undefined for a missing/empty tools argument", () => {
    expect(toOpenAITools(undefined)).toBeUndefined();
    expect(toOpenAITools([{ functionDeclarations: [] }])).toBeUndefined();
  });

  it("does NOT silently produce zero tools when handed the wrapper shape (regression test for the original draft's bug)", () => {
    // The original (incorrect) draft of this plan assumed `tools` was
    // already a flat array of declarations -- treating FUNCTION_DECLARATIONS
    // that way would map over the single wrapper object instead of its
    // contents and silently produce garbage/zero real tools.
    const tools = toOpenAITools(FUNCTION_DECLARATIONS);
    expect(tools.length).toBe(2);
    expect(tools.every((t) => t.type === "function" && typeof t.function.name === "string")).toBe(true);
  });
});

describe("glm/adapter.js — fromOpenAIChoice", () => {
  it("converts plain assistant text into a Gemini-shaped candidate with a text part", () => {
    const choice = { message: { role: "assistant", content: "The answer is 42." }, finish_reason: "stop" };
    const candidate = fromOpenAIChoice(choice);
    expect(candidate).toEqual({
      content: { role: "model", parts: [{ text: "The answer is 42." }] },
      finishReason: "stop",
    });
  });

  it("converts OpenAI tool_calls into Gemini-shaped functionCall parts with parsed args", () => {
    const choice = {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_9", function: { name: "github_read_file", arguments: JSON.stringify({ repo: "madmcp", path: "plan.md" }) } }],
      },
      finish_reason: "tool_calls",
    };
    const candidate = fromOpenAIChoice(choice);
    expect(candidate.content.role).toBe("model");
    expect(candidate.content.parts).toEqual([
      { functionCall: { name: "github_read_file", args: { repo: "madmcp", path: "plan.md" }, id: "call_9" } },
    ]);
    expect(candidate.finishReason).toBe("tool_calls");
  });

  it("handles a mixed content + tool_calls message (text part first, then functionCall parts)", () => {
    const choice = {
      message: { content: "Let me check that.", tool_calls: [{ id: "call_5", function: { name: "notion_search", arguments: "{\"query\":\"roadmap\"}" } }] },
      finish_reason: "tool_calls",
    };
    const candidate = fromOpenAIChoice(choice);
    expect(candidate.content.parts[0]).toEqual({ text: "Let me check that." });
    expect(candidate.content.parts[1]).toEqual({ functionCall: { name: "notion_search", args: { query: "roadmap" }, id: "call_5" } });
  });

  it("falls back to empty args on malformed tool_call JSON rather than throwing", () => {
    const choice = {
      message: { tool_calls: [{ id: "call_bad", function: { name: "github_read_file", arguments: "{not json" } }] },
      finish_reason: "tool_calls",
    };
    expect(() => fromOpenAIChoice(choice)).not.toThrow();
    const candidate = fromOpenAIChoice(choice);
    expect(candidate.content.parts[0].functionCall.args).toEqual({});
  });

  it("never produces MALFORMED_FUNCTION_CALL as a finishReason (known accepted asymmetry, plan.md step 3)", () => {
    // An OpenAI-compatible response with no tools available in the request
    // has no way to represent a rejected/malformed tool-call attempt --
    // finish_reason in that case is something ordinary like "stop" or
    // "length", never Gemini's specific enum value.
    const choice = { message: { content: "" }, finish_reason: "length" };
    const candidate = fromOpenAIChoice(choice);
    expect(candidate.finishReason).not.toBe("MALFORMED_FUNCTION_CALL");
  });

  it("handles an empty/missing message gracefully", () => {
    const candidate = fromOpenAIChoice({ finish_reason: "stop" });
    expect(candidate).toEqual({ content: { role: "model", parts: [] }, finishReason: "stop" });
  });
});

describe("glm/adapter.js — round trip: toOpenAIMessages -> (simulated model turn) -> fromOpenAIChoice", () => {
  it("produces a candidate structurally identical to what geminiChat would have returned for an equivalent turn", () => {
    // Simulates one full step of agent_delegate.js's loop: an existing
    // Gemini-shaped conversation is adapted to OpenAI messages, a synthetic
    // OpenAI tool-call response is converted back, and the resulting
    // candidate must be push-able onto `contents` exactly the way a real
    // Gemini candidate is (see agent_delegate.js: `contents.push({ role:
    // "model", parts })`).
    const contents = [
      { role: "user", parts: [{ text: "Task: find the failing check" }] },
      { role: "model", parts: [{ functionCall: { name: "github_get_check_runs", args: { repo: "madmcp" }, id: "call_1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "github_get_check_runs", id: "call_1", response: { result: "lint: failure" } } }] },
    ];

    const messages = toOpenAIMessages(contents);
    expect(messages[messages.length - 1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "lint: failure" });

    // Synthetic OpenAI response for the next model turn -- a follow-up tool call.
    const synthenticChoice = {
      message: {
        content: null,
        tool_calls: [{ id: "call_2", function: { name: "github_get_job_logs", arguments: JSON.stringify({ repo: "madmcp", run_id: 42 }) } }],
      },
      finish_reason: "tool_calls",
    };
    const candidate = fromOpenAIChoice(synthenticChoice);

    // Same shape agent_delegate.js expects from geminiChat(): {content:{role,parts},finishReason}
    expect(candidate.content.role).toBe("model");
    expect(Array.isArray(candidate.content.parts)).toBe(true);
    const functionCalls = candidate.content.parts.filter((p) => p.functionCall);
    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0].functionCall).toEqual({ name: "github_get_job_logs", args: { repo: "madmcp", run_id: 42 }, id: "call_2" });

    // This candidate must be push-able back onto `contents` the same way
    // agent_delegate.js does for a real Gemini turn, and the result must
    // still be convertible back to OpenAI messages without error.
    contents.push({ role: "model", parts: candidate.content.parts });
    expect(() => toOpenAIMessages(contents)).not.toThrow();
    const finalMessages = toOpenAIMessages(contents);
    expect(finalMessages[finalMessages.length - 1].tool_calls[0].function.name).toBe("github_get_job_logs");
  });
});
