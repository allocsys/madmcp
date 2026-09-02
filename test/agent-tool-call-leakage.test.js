import { describe, it, expect, vi } from "vitest";

// Minimal in-memory fake of the @upstash/redis surface agent_checkpoint.js
// uses -- same shape as test/agent-oversized-step-cap.test.js's makeFakeRedis.
function makeFakeRedis() {
  const lists = new Map();
  const strings = new Map();
  return {
    async rpush(key, ...vals) {
      const list = lists.get(key) || [];
      list.push(...vals);
      lists.set(key, list);
      return list.length;
    },
    async expire() { return 1; },
    async set(key, val) { strings.set(key, val); return "OK"; },
    async get(key) { return strings.has(key) ? strings.get(key) : null; },
    async lrange(key) { return lists.get(key) || []; },
    async del(key) { lists.delete(key); strings.delete(key); return 1; },
    async mget(...keys) { return keys.map((k) => (strings.has(k) ? strings.get(k) : null)); },
  };
}

const fakeRedis = makeFakeRedis();
vi.mock("../connectors/shared/cooldown.js", () => ({
  getRedis: () => fakeRedis,
}));

describe("detectToolCallLeakage (plan.md Section 21 fix: whitespace-mangled tag names)", () => {
  it("catches a clean XML-tag-shaped leak of a real function name", async () => {
    const { detectToolCallLeakage } = await import("../connectors/gemini/agent_delegate.js");
    const known = new Set(["github_read_file", "github_get_file_tree"]);
    expect(detectToolCallLeakage("<github_read_file><params>{}</params></github_read_file>", known)).toBe("github_read_file");
  });

  it("catches the ACTUAL literal repro text from plan.md Section 18 (run 6ea018d5): a tag name garbled with an embedded space", async () => {
    const { detectToolCallLeakage } = await import("../connectors/gemini/agent_delegate.js");
    const known = new Set(["github_read_file", "github_get_file_tree"]);
    // Literal text from plan.md Section 18: <githu b_read_file>... -- the
    // ORIGINAL (pre-fix) version of detectToolCallLeakage's patterns only
    // captured contiguous identifier chars ([\w-]*), so this exact string
    // would have captured "githu" (not a real function name) and silently
    // passed through as an unhandled answer. This is the case the
    // whitespace-normalization fix exists for.
    const leaked = '<githu b_read_file><params>{"owner":"allocsys","repo":"madmcp","path":"connectors/github/editor_worker.js"}</params></githu b_read_file>';
    expect(detectToolCallLeakage(leaked, known)).toBe("github_read_file");
  });

  it("catches the bracket-marker-shaped leak from plan.md Section 20 (run ab8afaa8)", async () => {
    const { detectToolCallLeakage } = await import("../connectors/gemini/agent_delegate.js");
    const known = new Set(["github_read_file", "github_get_file_tree"]);
    const leaked = "[Function call: github_read_file with owner=allocsys, repo=madmcp, path=connectors/github/editor_worker.js]";
    expect(detectToolCallLeakage(leaked, known)).toBe("github_read_file");
  });

  it("catches a JSON-shaped leak of a real function name", async () => {
    const { detectToolCallLeakage } = await import("../connectors/gemini/agent_delegate.js");
    const known = new Set(["github_read_file", "github_get_file_tree"]);
    expect(detectToolCallLeakage('{"name": "github_read_file", "args": {}}', known)).toBe("github_read_file");
  });

  it("does NOT false-positive on legitimate markup/code examples unrelated to any real tool name", async () => {
    const { detectToolCallLeakage } = await import("../connectors/gemini/agent_delegate.js");
    const known = new Set(["github_read_file", "github_get_file_tree"]);
    expect(detectToolCallLeakage("Here's an example: <div>hello</div> and an unrelated <foo_bar> tag.", known)).toBeNull();
    expect(detectToolCallLeakage("The function is called github_get_file_tree in this codebase.", known)).toBeNull();
  });
});

describe("bai forced-final-step tool-call-leakage backstop, end-to-end (plan.md Section 18/20/21)", () => {
  it("returns a clean failed:true result instead of the raw garbled text when the model leaks a space-mangled tag on bai's forced-final step", async () => {
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    providerChatMock.mockImplementationOnce(async () => ({
      content: {
        parts: [{
          text: 'Priority fetches: <githu b_read_file><params>{"owner":"allocsys","repo":"madmcp","path":"connectors/github/editor_worker.js"}</params></githu b_read_file>',
        }],
      },
      finishReason: "STOP",
    }));

    const result = await runInvestigation({
      task: "summarize the whole repo exhaustively",
      max_steps: 1,
      provider: "bai",
    });

    expect(result.failed).toBe(true);
    expect(result.answer).toMatch(/github_read_file/);
    expect(result.answer).toMatch(/attempted to invoke/i);

    providerChatMock.mockRestore();
  });

  it("does NOT trigger the backstop for the same garbled text on a non-bai provider (Section 19 decoupling must hold)", async () => {
    const { runInvestigation } = await import("../connectors/gemini/agent_delegate.js");
    const routerModule = await import("../connectors/llm/router.js");

    const providerChatMock = vi.spyOn(routerModule, "providerChat");
    providerChatMock.mockImplementationOnce(async () => ({
      content: {
        parts: [{
          text: '<githu b_read_file><params>{}</params></githu b_read_file>',
        }],
      },
      finishReason: "STOP",
    }));

    const result = await runInvestigation({
      task: "summarize the whole repo exhaustively",
      max_steps: 1,
      provider: "gemini",
    });

    // Gemini gets no leakage backstop (Section 19) -- the garbled text is
    // returned as-is, not intercepted, even though it's the same shape.
    expect(result.failed).toBeFalsy();
    expect(result.answer).toMatch(/githu b_read_file/);

    providerChatMock.mockRestore();
  });
});
