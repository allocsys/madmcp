import { describe, it, expect, vi, beforeEach } from "vitest";
import { GLM_DEFAULT_MAX_OUTPUT_TOKENS, GROQ_DEFAULT_MAX_OUTPUT_TOKENS } from "../config.js";

// Mock all provider clients and the shared adapter so this test is
// purely about router.js's dispatch logic.
const mockGeminiChat = vi.fn();
const mockGlmChat = vi.fn();
const mockGroqChat = vi.fn();
const mockBaiChat = vi.fn();
const mockToOpenAIMessages = vi.fn((contents) => [{ role: "user", content: "adapted" }]);
const mockToOpenAITools = vi.fn((tools) => (tools ? [{ type: "function", function: { name: "adapted_tool" } }] : undefined));
const mockFromOpenAIChoice = vi.fn((choice) => ({ content: { role: "model", parts: [{ text: "adapted answer" }] }, finishReason: choice?.finish_reason }));

vi.mock("../connectors/gemini/client.js", () => ({
  geminiChat: mockGeminiChat,
}));
vi.mock("../connectors/glm/client.js", () => ({
  glmChat: mockGlmChat,
}));
vi.mock("../connectors/groq/client.js", () => ({
  groqChat: mockGroqChat,
}));
vi.mock("../connectors/bai/client.js", () => ({
  baiChat: mockBaiChat,
}));
vi.mock("../connectors/openai_shape/adapter.js", () => ({
  toOpenAIMessages: mockToOpenAIMessages,
  toOpenAITools: mockToOpenAITools,
  fromOpenAIChoice: mockFromOpenAIChoice,
}));

describe("connectors/llm/router.js — providerChat", () => {
  let providerChat;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ providerChat } = await import("../connectors/llm/router.js"));
  });

  it("defaults to gemini when provider is omitted", async () => {
    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    const result = await providerChat(contents);

    expect(mockGeminiChat).toHaveBeenCalledWith(contents, { tools: undefined, model: undefined });
    expect(mockGlmChat).not.toHaveBeenCalled();
    expect(mockGroqChat).not.toHaveBeenCalled();
    expect(mockBaiChat).not.toHaveBeenCalled();
    expect(result.finishReason).toBe("STOP");
  });

  it("dispatches to gemini explicitly and passes tools/model straight through untouched", async () => {
    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [] }, finishReason: "STOP" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];
    const tools = [{ functionDeclarations: [{ name: "x" }] }];

    await providerChat(contents, { provider: "gemini", tools, model: "gemini-flash-latest" });

    expect(mockGeminiChat).toHaveBeenCalledWith(contents, { tools, model: "gemini-flash-latest" });
    expect(mockToOpenAIMessages).not.toHaveBeenCalled();
    expect(mockToOpenAITools).not.toHaveBeenCalled();
  });

  it("dispatches to glm: adapts contents/tools in, adapts the choice back out, and NEVER touches geminiChat", async () => {
    mockGlmChat.mockResolvedValueOnce({ message: { content: "glm says hi" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];
    const tools = [{ functionDeclarations: [{ name: "x" }] }];

    const result = await providerChat(contents, { provider: "glm", tools, model: "z-ai/glm-4.6" });

    expect(mockToOpenAIMessages).toHaveBeenCalledWith(contents);
    expect(mockToOpenAITools).toHaveBeenCalledWith(tools);
    expect(mockGlmChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { model: "z-ai/glm-4.6", tools: [{ type: "function", function: { name: "adapted_tool" } }], maxOutputTokens: GLM_DEFAULT_MAX_OUTPUT_TOKENS }
    );
    expect(mockFromOpenAIChoice).toHaveBeenCalledWith({ message: { content: "glm says hi" }, finish_reason: "stop" });
    expect(mockGeminiChat).not.toHaveBeenCalled();
    expect(mockGroqChat).not.toHaveBeenCalled();
    expect(mockBaiChat).not.toHaveBeenCalled();
    expect(result).toEqual({ content: { role: "model", parts: [{ text: "adapted answer" }] }, finishReason: "stop" });
  });

  it("omits tools from the GLM path when none were passed (withholdTools contract)", async () => {
    mockGlmChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "glm" });

    expect(mockToOpenAITools).not.toHaveBeenCalled();
    expect(mockGlmChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { model: undefined, tools: undefined, maxOutputTokens: GLM_DEFAULT_MAX_OUTPUT_TOKENS }
    );
  });

  it("honors an explicit maxOutputTokens on the glm path instead of the default", async () => {
    mockGlmChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "glm", maxOutputTokens: 2048 });

    expect(mockGlmChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { model: undefined, tools: undefined, maxOutputTokens: 2048 }
    );
  });

  it("passes maxOutputTokens straight through on the gemini path with no forced default", async () => {
    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "gemini", maxOutputTokens: 4096 });
    expect(mockGeminiChat).toHaveBeenCalledWith(contents, { tools: undefined, model: undefined, maxOutputTokens: 4096 });

    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" });
    await providerChat(contents, { provider: "gemini" });
    expect(mockGeminiChat).toHaveBeenCalledWith(contents, { tools: undefined, model: undefined, maxOutputTokens: undefined });
  });

  it("propagates a glmChat failure without swallowing it", async () => {
    mockGlmChat.mockRejectedValueOnce(new Error("OpenRouter API error (503): overloaded"));
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChat(contents, { provider: "glm" })).rejects.toThrow("OpenRouter API error (503): overloaded");
  });

  it("dispatches to groq: adapts contents/tools in, adapts the choice back out", async () => {
    mockGroqChat.mockResolvedValueOnce({ message: { content: "groq says hi" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];
    const tools = [{ functionDeclarations: [{ name: "x" }] }];

    const result = await providerChat(contents, { provider: "groq", tools, model: "openai/gpt-oss-120b" });

    expect(mockToOpenAIMessages).toHaveBeenCalledWith(contents);
    expect(mockToOpenAITools).toHaveBeenCalledWith(tools);
    expect(mockGroqChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { model: "openai/gpt-oss-120b", tools: [{ type: "function", function: { name: "adapted_tool" } }], maxOutputTokens: GROQ_DEFAULT_MAX_OUTPUT_TOKENS }
    );
    expect(mockFromOpenAIChoice).toHaveBeenCalledWith({ message: { content: "groq says hi" }, finish_reason: "stop" });
    expect(mockGeminiChat).not.toHaveBeenCalled();
    expect(mockGlmChat).not.toHaveBeenCalled();
    expect(mockBaiChat).not.toHaveBeenCalled();
    expect(result).toEqual({ content: { role: "model", parts: [{ text: "adapted answer" }] }, finishReason: "stop" });
  });

  it("omits tools from the groq path when none were passed (withholdTools contract)", async () => {
    mockGroqChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "groq" });

    expect(mockToOpenAITools).not.toHaveBeenCalled();
    expect(mockGroqChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { model: undefined, tools: undefined, maxOutputTokens: GROQ_DEFAULT_MAX_OUTPUT_TOKENS }
    );
  });

  it("honors an explicit maxOutputTokens on the groq path instead of the default", async () => {
    mockGroqChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "groq", maxOutputTokens: 2048 });

    expect(mockGroqChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { model: undefined, tools: undefined, maxOutputTokens: 2048 }
    );
  });

  it("propagates a groqChat failure without swallowing it", async () => {
    mockGroqChat.mockRejectedValueOnce(new Error("Groq API error (503): overloaded"));
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChat(contents, { provider: "groq" })).rejects.toThrow("Groq API error (503): overloaded");
  });

  it("dispatches to bai: adapts contents/tools in, adapts the choice back out, with NO forced maxOutputTokens default", async () => {
    mockBaiChat.mockResolvedValueOnce({ message: { content: "b.ai says hi" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];
    const tools = [{ functionDeclarations: [{ name: "x" }] }];

    const result = await providerChat(contents, { provider: "bai", tools });

    expect(mockToOpenAIMessages).toHaveBeenCalledWith(contents);
    expect(mockToOpenAITools).toHaveBeenCalledWith(tools);
    // Unlike glm/groq, bai has no BAI_DEFAULT_MAX_OUTPUT_TOKENS -- B.AI's
    // GLM-5.3-Flash is free, so there's no cost-runaway risk to guard
    // against (see config.js's comment). maxOutputTokens passes through
    // untouched, same contract as the gemini path.
    expect(mockBaiChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { tools: [{ type: "function", function: { name: "adapted_tool" } }], maxOutputTokens: undefined }
    );
    expect(mockFromOpenAIChoice).toHaveBeenCalledWith({ message: { content: "b.ai says hi" }, finish_reason: "stop" });
    expect(mockGeminiChat).not.toHaveBeenCalled();
    expect(mockGlmChat).not.toHaveBeenCalled();
    expect(mockGroqChat).not.toHaveBeenCalled();
    expect(result).toEqual({ content: { role: "model", parts: [{ text: "adapted answer" }] }, finishReason: "stop" });
  });

  it("omits tools from the bai path when none were passed", async () => {
    mockBaiChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "bai" });

    expect(mockToOpenAITools).not.toHaveBeenCalled();
    expect(mockBaiChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { tools: undefined, maxOutputTokens: undefined }
    );
  });

  it("passes an explicit maxOutputTokens straight through on the bai path (no default to override)", async () => {
    mockBaiChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "bai", maxOutputTokens: 2048 });

    expect(mockBaiChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { tools: undefined, maxOutputTokens: 2048 }
    );
  });

  it("propagates a baiChat failure without swallowing it", async () => {
    mockBaiChat.mockRejectedValueOnce(new Error("B.AI API error (503): overloaded"));
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChat(contents, { provider: "bai" })).rejects.toThrow("B.AI API error (503): overloaded");
  });

  it("passes an explicit reasoningEffort straight through on the bai path (plan.md Section 25 fix)", async () => {
    mockBaiChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "bai", maxOutputTokens: 4096, reasoningEffort: "low" });

    expect(mockBaiChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { tools: undefined, maxOutputTokens: 4096, reasoningEffort: "low" }
    );
  });

  it("omits reasoningEffort on the bai path when the caller doesn't pass one", async () => {
    mockBaiChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "bai" });

    expect(mockBaiChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { tools: undefined, maxOutputTokens: undefined, reasoningEffort: undefined }
    );
  });

  it("never sends reasoningEffort to gemini/glm/groq (bai-only option)", async () => {
    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "gemini", reasoningEffort: "low" });
    // geminiChat's call signature has no reasoningEffort field at all --
    // confirms the option is silently dropped on this branch, not
    // forwarded somewhere it isn't understood.
    expect(mockGeminiChat).toHaveBeenCalledWith(contents, { tools: undefined, model: undefined });
  });

  it("propagates a geminiChat failure without swallowing it", async () => {
    mockGeminiChat.mockRejectedValueOnce(new Error("Gemini API error (503): overloaded"));
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChat(contents, { provider: "gemini" })).rejects.toThrow("Gemini API error (503): overloaded");
  });
});

// Coverage for the decouple-gemini-delegation plan's step 5
// (GLM_ENABLED/GROQ_ENABLED/BAI_ENABLED) -- kept as its own describe block
// with its own config.js mock per test (via vi.doMock + vi.importActual,
// overriding only the one flag under test) so the rest of this file's
// tests, which rely on the REAL config.js default (all three flags on),
// are never affected. Each test mocks config.js, resets the module
// registry, and re-imports router.js fresh -- same dynamic-import pattern
// this file's own beforeEach already uses -- then unmocks/resets in
// afterEach so the next test (in this block or any other) starts clean.
describe("connectors/llm/router.js — per-provider enable flags (step 5)", () => {
  afterEach(() => {
    vi.doUnmock("../config.js");
    vi.resetModules();
  });

  it("throws a clear config error and never calls glmChat when GLM_ENABLED is false", async () => {
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual("../config.js");
      return { ...actual, GLM_ENABLED: false };
    });
    vi.resetModules();
    const { providerChat: providerChatGlmDisabled } = await import("../connectors/llm/router.js");
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChatGlmDisabled(contents, { provider: "glm" }))
      .rejects.toThrow(/Provider "glm" is disabled \(GLM_ENABLED=false\)/);
    expect(mockGlmChat).not.toHaveBeenCalled();
  });

  it("throws a clear config error and never calls groqChat when GROQ_ENABLED is false", async () => {
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual("../config.js");
      return { ...actual, GROQ_ENABLED: false };
    });
    vi.resetModules();
    const { providerChat: providerChatGroqDisabled } = await import("../connectors/llm/router.js");
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChatGroqDisabled(contents, { provider: "groq" }))
      .rejects.toThrow(/Provider "groq" is disabled \(GROQ_ENABLED=false\)/);
    expect(mockGroqChat).not.toHaveBeenCalled();
  });

  it("throws a clear config error and never calls baiChat when BAI_ENABLED is false", async () => {
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual("../config.js");
      return { ...actual, BAI_ENABLED: false };
    });
    vi.resetModules();
    const { providerChat: providerChatBaiDisabled } = await import("../connectors/llm/router.js");
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChatBaiDisabled(contents, { provider: "bai" }))
      .rejects.toThrow(/Provider "bai" is disabled \(BAI_ENABLED=false\)/);
    expect(mockBaiChat).not.toHaveBeenCalled();
  });

  it("gemini is unaffected by any/all of glm, groq, bai being disabled -- it has no flag of its own", async () => {
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual("../config.js");
      return { ...actual, GLM_ENABLED: false, GROQ_ENABLED: false, BAI_ENABLED: false };
    });
    vi.resetModules();
    const { providerChat: providerChatAllDisabled } = await import("../connectors/llm/router.js");
    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    const result = await providerChatAllDisabled(contents, { provider: "gemini" });

    expect(result.finishReason).toBe("STOP");
    expect(mockGeminiChat).toHaveBeenCalled();
  });

  it("still defaults to (unaffected) gemini when provider is omitted, even with every other provider disabled", async () => {
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual("../config.js");
      return { ...actual, GLM_ENABLED: false, GROQ_ENABLED: false, BAI_ENABLED: false };
    });
    vi.resetModules();
    const { providerChat: providerChatAllDisabled } = await import("../connectors/llm/router.js");
    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    const result = await providerChatAllDisabled(contents);

    expect(result.finishReason).toBe("STOP");
  });

  it("re-enables normally once GLM_ENABLED is back to true (default, no override) -- confirms the mock isn't sticky across tests", async () => {
    // No vi.doMock here at all -- real config.js, real default (true).
    // This runs AFTER the disabled-glm test above and relies on that
    // test's afterEach having actually unmocked config.js; if it hadn't,
    // this would fail too, making it a regression check on the block's own
    // cleanup as much as on router.js.
    const { providerChat: providerChatDefault } = await import("../connectors/llm/router.js");
    mockGlmChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChatDefault(contents, { provider: "glm" });

    expect(mockGlmChat).toHaveBeenCalled();
  });
});
