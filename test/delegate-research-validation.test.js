import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// tools.js's delegate_research handler validates mode selection (precision
// vs. wide) BEFORE touching any of its real dependencies (Gemini, fetch,
// research.js's runResearch, Notion). So for the validation-error cases we
// don't need those dependencies to do anything -- but we still stub them
// out since tools.js imports them at module load time regardless of which
// branch a given test exercises, and a couple of tests below exercise the
// success paths too (where the stubs' return values matter).

const CLIENT_PATH = "../connectors/gemini/client.js";
const RESEARCH_PATH = "../connectors/exa/research.js";
const FETCH_PATH = "../connectors/fetch/client.js";
const NOTION_PATH = "../connectors/notion/tools.js";
const TOOLS_PATH = "../connectors/gemini/tools.js";

let geminiGenerate;
let runResearch;
let fetchUrl;
let htmlToText;
let doCreatePage;

// Captures the handler registered under "delegate_research" so it can be
// invoked directly, the same way tools.js's real MCP server would.
function makeFakeServer() {
  const handlers = new Map();
  return {
    tool: (name, _description, _schema, handler) => {
      handlers.set(name, handler);
    },
    get: (name) => handlers.get(name),
  };
}

beforeEach(async () => {
  vi.resetModules();

  geminiGenerate = vi.fn().mockResolvedValue("a gemini answer");
  runResearch = vi.fn().mockResolvedValue({ answer: "research answer", steps: 3, transcript: [], runId: "run-1", task: "the task" });
  fetchUrl = vi.fn().mockResolvedValue({ status: 200, ok: true, contentType: "text/plain", text: "page body" });
  htmlToText = vi.fn((t) => t);
  doCreatePage = vi.fn().mockResolvedValue({ url: "https://notion.example/page" });

  vi.doMock(CLIENT_PATH, () => ({ geminiGenerate, geminiChat: vi.fn() }));
  vi.doMock(RESEARCH_PATH, () => ({ runResearch }));
  vi.doMock(FETCH_PATH, () => ({ fetchUrl, htmlToText }));
  vi.doMock(NOTION_PATH, () => ({ doCreatePage }));
  vi.doMock("../connectors/gemini/delegate.js", () => ({ runInvestigation: vi.fn() }));
});

afterEach(() => {
  vi.doUnmock(CLIENT_PATH);
  vi.doUnmock(RESEARCH_PATH);
  vi.doUnmock(FETCH_PATH);
  vi.doUnmock(NOTION_PATH);
  vi.doUnmock("../connectors/gemini/delegate.js");
});

async function getHandler() {
  const { register } = await import(TOOLS_PATH);
  const server = makeFakeServer();
  register(server);
  return server.get("delegate_research");
}

describe("delegate_research — mode-selection validation", () => {
  it("rejects when both precision args (url/question) and wide args (task) are given", async () => {
    const handler = await getHandler();
    const result = await handler({ url: "https://example.com", question: "q?", task: "do research" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/EITHER url\+question .* OR task\/resume_run_id.*not both/i);
    expect(geminiGenerate).not.toHaveBeenCalled();
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("rejects when neither mode's args are given", async () => {
    const handler = await getHandler();
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing arguments/i);
  });

  it("rejects precision mode when only url is given (missing question)", async () => {
    const handler = await getHandler();
    const result = await handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires BOTH url and question/i);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("rejects precision mode when only question is given (missing url)", async () => {
    const handler = await getHandler();
    const result = await handler({ question: "what is this page about?" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires BOTH url and question/i);
  });

  it("rejects wide mode when task is missing and there's no resume_run_id", async () => {
    // resume_run_id alone counts as "wide args", so this only triggers if
    // neither task nor resume_run_id is present -- covered by the
    // both-missing case above. This test instead checks max_steps validation
    // fires correctly when task IS present.
    const handler = await getHandler();
    const result = await handler({ task: "research something", max_steps: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid max_steps/i);
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("rejects a non-integer max_steps in wide mode", async () => {
    const handler = await getHandler();
    const result = await handler({ task: "research something", max_steps: 2.5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid max_steps/i);
  });

  it("rejects a negative max_steps in wide mode", async () => {
    const handler = await getHandler();
    const result = await handler({ task: "research something", max_steps: -3 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid max_steps/i);
  });

  it("accepts wide mode with only resume_run_id (no task) and does not error out on validation", async () => {
    const handler = await getHandler();
    const result = await handler({ resume_run_id: "run-abc" });
    expect(result.isError).toBeFalsy();
    expect(runResearch).toHaveBeenCalledWith({ task: undefined, max_steps: 20, resume_run_id: "run-abc" });
  });
});

describe("delegate_research — precision mode happy path", () => {
  it("fetches the URL, hands content + question to Gemini, and returns only Gemini's answer", async () => {
    const handler = await getHandler();
    const result = await handler({ url: "https://example.com/doc", question: "does this mention rate limits?" });

    expect(result.isError).toBeFalsy();
    expect(fetchUrl).toHaveBeenCalledWith("https://example.com/doc");
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
    const prompt = geminiGenerate.mock.calls[0][0];
    expect(prompt).toContain("does this mention rate limits?");
    expect(prompt).toContain("page body");
    expect(result.content[0].text).toBe("a gemini answer");
  });

  it("truncates the page content to max_source_chars before sending to Gemini", async () => {
    fetchUrl.mockResolvedValueOnce({ status: 200, ok: true, contentType: "text/plain", text: "0123456789" });
    const handler = await getHandler();
    await handler({ url: "https://example.com/doc", question: "q?", max_source_chars: 4 });

    const prompt = geminiGenerate.mock.calls[0][0];
    expect(prompt).toContain("truncated");
    expect(prompt).not.toContain("0123456789");
    expect(prompt).toContain("0123");
  });

  it("surfaces a fetch failure as an isError result instead of throwing", async () => {
    fetchUrl.mockRejectedValueOnce(new Error("DNS lookup failed"));
    const handler = await getHandler();
    const result = await handler({ url: "https://bad.example", question: "q?" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Fetch failed: DNS lookup failed/);
    expect(geminiGenerate).not.toHaveBeenCalled();
  });
});

describe("delegate_research — wide mode happy path", () => {
  it("delegates to runResearch and returns its answer plus step count", async () => {
    const handler = await getHandler();
    const result = await handler({ task: "what's the latest on X" });

    expect(result.isError).toBeFalsy();
    expect(runResearch).toHaveBeenCalledWith({ task: "what's the latest on X", max_steps: 20, resume_run_id: undefined });
    expect(result.content[0].text).toContain("research answer");
    expect(result.content[0].text).toContain("3 step(s) taken");
  });

  it("marks the result as an error and includes the transcript when the run failed partway through", async () => {
    runResearch.mockResolvedValueOnce({
      answer: "(failed partway)",
      steps: 2,
      transcript: ["[step 1] web_fetch(...) -> ok"],
      runId: "run-2",
      task: "some task",
      failed: true,
    });
    const handler = await getHandler();
    const result = await handler({ task: "some task" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tool calls completed before the failure");
  });

  it("surfaces a runResearch throw as an isError result instead of propagating", async () => {
    runResearch.mockRejectedValueOnce(new Error("boom"));
    const handler = await getHandler();
    const result = await handler({ task: "some task" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Research failed: boom/);
  });
});
