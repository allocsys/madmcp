import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock both provider clients and the adapter so this test is purely about
// router.js's dispatch logic, not either provider's own wire format.
const mockGeminiChat = vi.fn();
const mockGlmChat = vi.fn();
const mockToOpenAIMessages = vi.fn((contents) => [{ role: "user", content: "adapted" }]);
const mockToOpenAITools = vi.fn((tools) => (tools ? [{ type: "function", function: { name: "adapted_tool" } }] : undefined));
const mockFromOpenAIChoice = vi.fn((choice) => ({ content: { role: "model", parts: [{ text: "adapted answer" }] }, finishReason: choice?.finish_reason }));

vi.mock("../connectors/gemini/client.js", () => ({
  geminiChat: mockGeminiChat,
}));
vi.mock("../connectors/glm/client.js", () => ({
  glmChat: mockGlmChat,
}));
vi.mock("../connectors/glm/adapter.js", () => ({
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
    expect(result.finishReason).toBe("STOP");
  });

  it("dispatches to gemini explicitly and passes tools/model straight through untouched", async () => {
    mockGeminiChat.mockResolvedValueOnce({ content: { role: "model", parts: [] }, finishReason: "STOP" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];
    const tools = [{ functionDeclarations: [{ name: "x" }] }];

    await providerChat(contents, { provider: "gemini", tools, model: "gemini-flash-latest" });

    expect(mockGeminiChat).toHaveBeenCalledWith(contents, { tools, model: "gemini-flash-latest" });
    // Gemini's own path never touches the GLM adapter.
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
      { model: "z-ai/glm-4.6", tools: [{ type: "function", function: { name: "adapted_tool" } }] }
    );
    expect(mockFromOpenAIChoice).toHaveBeenCalledWith({ message: { content: "glm says hi" }, finish_reason: "stop" });
    // The import-boundary check: a provider:"glm" call must never reach
    // Gemini's own client, so a Gemini-only misconfiguration (e.g. a
    // missing GEMINI_API_KEY) can never break a GLM-only deployment.
    expect(mockGeminiChat).not.toHaveBeenCalled();
    expect(result).toEqual({ content: { role: "model", parts: [{ text: "adapted answer" }] }, finishReason: "stop" });
  });

  it("omits tools from the GLM path when none were passed (withholdTools contract)", async () => {
    mockGlmChat.mockResolvedValueOnce({ message: { content: "done" }, finish_reason: "stop" });
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await providerChat(contents, { provider: "glm" });

    expect(mockToOpenAITools).not.toHaveBeenCalled();
    expect(mockGlmChat).toHaveBeenCalledWith(
      [{ role: "user", content: "adapted" }],
      { model: undefined, tools: undefined }
    );
  });

  it("propagates a glmChat failure without swallowing it", async () => {
    mockGlmChat.mockRejectedValueOnce(new Error("OpenRouter API error (503): overloaded"));
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChat(contents, { provider: "glm" })).rejects.toThrow("OpenRouter API error (503): overloaded");
  });

  it("propagates a geminiChat failure without swallowing it", async () => {
    mockGeminiChat.mockRejectedValueOnce(new Error("Gemini API error (503): overloaded"));
    const contents = [{ role: "user", parts: [{ text: "hello" }] }];

    await expect(providerChat(contents, { provider: "gemini" })).rejects.toThrow("Gemini API error (503): overloaded");
  });
});
