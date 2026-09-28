import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// config.js reads JULES_API_KEY at import time via process.env, so set it
// before importing the client.
process.env.JULES_API_KEY = "test-jules-key";

const { julesRequest } = await import("../connectors/jules/client.js");
const { register } = await import("../connectors/jules/tools.js");

function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("Jules Connector - client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the x-goog-api-key header and no body on GET", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sources: [] }),
    });

    await julesRequest("/sources");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url.toString()).toBe("https://jules.googleapis.com/v1alpha/sources");
    expect(opts.headers["x-goog-api-key"]).toBe("test-jules-key");
    expect(opts.body).toBeUndefined();
  });

  it("sends a JSON body and Content-Type on POST", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ name: "sessions/1" }),
    });

    await julesRequest("/sessions", { method: "POST", body: { prompt: "do the thing" } });

    const [, opts] = fetch.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ prompt: "do the thing" });
  });

  it("appends query params, skipping undefined/null/empty", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" });

    await julesRequest("/sessions", { params: { pageSize: 5, pageToken: undefined, foo: "" } });

    const [url] = fetch.mock.calls[0];
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.has("pageToken")).toBe(false);
    expect(url.searchParams.has("foo")).toBe(false);
  });

  it("throws a descriptive error on non-ok response", async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => JSON.stringify({ error: { message: "session not found" } }),
    });

    await expect(julesRequest("/sessions/nope")).rejects.toThrow("Jules API error (404): session not found");
  });
});

describe("Jules Connector - tools", () => {
  let server;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    server = makeFakeServer();
    register(server);
    // Thin wrappers: pre-consolidation tests keep their names and call shapes,
    // but exercise the consolidated jules_inspect tool.
    server.tools.jules_get_session = ({ session }) => server.tools.jules_inspect({ action: "session", session });
    server.tools.jules_get_activities = (args) => server.tools.jules_inspect({ action: "activities", ...args });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("jules_create_session defaults to AUTO_CREATE_PR", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ name: "sessions/42", state: "RUNNING", url: "https://jules.google.com/session/42" }),
    });

    const result = await server.tools.jules_create_session({
      source: "sources/github-owner-repo",
      prompt: "Add rate limiting",
    });

    const [, opts] = fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.automationMode).toBe("AUTO_CREATE_PR");
    expect(result.content[0].text).toContain("sessions/42");
    expect(result.content[0].text).toContain("RUNNING");
  });

  it("jules_get_session normalizes a bare session id and surfaces PR output", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        name: "sessions/42",
        title: "Add rate limiting",
        state: "COMPLETED",
        outputs: [{ pullRequest: { url: "https://github.com/owner/repo/pull/9" } }],
      }),
    });

    const result = await server.tools.jules_get_session({ session: "42" });

    const [url] = fetch.mock.calls[0];
    expect(url.toString()).toBe("https://jules.googleapis.com/v1alpha/sessions/42");
    expect(result.content[0].text).toContain("COMPLETED");
    expect(result.content[0].text).toContain("https://github.com/owner/repo/pull/9");
  });

  it("jules_send_message posts to the :sendMessage endpoint with a bare session id", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" });

    const result = await server.tools.jules_send_message({ session: "42", message: "What exactly went wrong?" });

    const [url, opts] = fetch.mock.calls[0];
    expect(url.toString()).toBe("https://jules.googleapis.com/v1alpha/sessions/42:sendMessage");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ prompt: "What exactly went wrong?" });
    expect(result.content[0].text).toContain("sessions/42");
  });

  it("jules_find sources reports an empty account clearly", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ sources: [] }) });

    const result = await server.tools.jules_find({ action: "sources" });
    expect(result.content[0].text).toContain("No sources connected");
  });

  it("jules_find sources lists repos with privacy, default branch and pagination, passing params through", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        sources: [
          { name: "sources/github-owner-repo", githubRepo: { owner: "owner", repo: "repo", isPrivate: true, defaultBranch: { displayName: "main" } } },
          { name: "sources/other" },
        ],
        nextPageToken: "tok2",
      }),
    });

    const result = await server.tools.jules_find({ action: "sources", page_size: 5, page_token: "tok1" });

    const [url] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/v1alpha/sources");
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.get("pageToken")).toBe("tok1");
    const text = result.content[0].text;
    expect(text).toContain("sources/github-owner-repo — owner/repo (private), default branch: main");
    expect(text).toContain("sources/other — (non-GitHub source)");
    expect(text).toContain("(more available — next page_token: tok2)");
  });

  it("jules_find sessions reports no sessions clearly", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) });

    const result = await server.tools.jules_find({ action: "sessions" });

    const [url] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/v1alpha/sessions");
    expect(result.content[0].text).toBe("No Jules sessions found.");
  });

  it("jules_find sessions shows title/prompt fallback, state, PR urls and pagination", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        sessions: [
          { name: "sessions/1", title: "Add rate limiting", state: "COMPLETED", outputs: [{ pullRequest: { url: "https://github.com/owner/repo/pull/9" } }, {}] },
          { name: "sessions/2", prompt: "Fix the bug", state: "RUNNING" },
        ],
        nextPageToken: "next",
      }),
    });

    const result = await server.tools.jules_find({ action: "sessions", page_size: 2 });

    const [url] = fetch.mock.calls[0];
    expect(url.searchParams.get("pageSize")).toBe("2");
    expect(url.searchParams.has("pageToken")).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain('sessions/1 — "Add rate limiting" — COMPLETED — PR: https://github.com/owner/repo/pull/9');
    expect(text).toContain('sessions/2 — "Fix the bug" — RUNNING');
    expect(text).not.toContain("sessions/2 — \"Fix the bug\" — RUNNING — PR");
    expect(text).toContain("(more available — next page_token: next)");
  });

  it("jules_get_activities surfaces the plan steps of a planGenerated event", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        activities: [{
          createTime: "2026-09-15T07:31:57Z",
          originator: "agent",
          planGenerated: { plan: { id: "p1", steps: [{ title: "Write tests", description: "Cover the client" }] } },
        }],
      }),
    });

    const result = await server.tools.jules_get_activities({ session: "42" });
    expect(result.content[0].text).toContain("Plan generated");
    expect(result.content[0].text).toContain("Write tests");
    expect(result.content[0].text).toContain("Cover the client");
  });

  it("jules_get_activities surfaces the failure reason of a sessionFailed event", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        activities: [{
          createTime: "2026-09-15T08:00:00Z",
          originator: "system",
          sessionFailed: { reason: "Repository checkout failed: permission denied" },
        }],
      }),
    });

    const result = await server.tools.jules_get_activities({ session: "42" });
    expect(result.content[0].text).toContain("SESSION FAILED");
    expect(result.content[0].text).toContain("permission denied");
  });

  it("jules_get_activities surfaces a git patch artifact", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        activities: [{
          createTime: "2026-09-15T08:05:00Z",
          originator: "agent",
          progressUpdated: { title: "Applying changes" },
          artifacts: [{
            changeSet: {
              source: "sources/github-owner-repo",
              gitPatch: { baseCommitId: "abc123", unidiffPatch: "diff --git a/x b/x\n+hello", suggestedCommitMessage: "Add hello" },
            },
          }],
        }],
      }),
    });

    const result = await server.tools.jules_get_activities({ session: "42" });
    expect(result.content[0].text).toContain("Diff (Add hello)");
    expect(result.content[0].text).toContain("diff --git a/x b/x");
  });

  it("jules_inspect session falls back to the prompt, omits PRs when none, and passes qualified names through", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ name: "sessions/7", prompt: "Fix it", state: "RUNNING", url: "https://jules.google.com/session/7" }),
    });

    const result = await server.tools.jules_inspect({ action: "session", session: "sessions/7" });

    const [url] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/v1alpha/sessions/7");
    expect(result.content[0].text).toBe('sessions/7 — "Fix it"\nState: RUNNING\nView in Jules: https://jules.google.com/session/7');
    expect(result.content[0].text).not.toContain("Pull request");
  });

  it("jules_inspect activities reports an empty timeline and hits the activities endpoint", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) });

    const result = await server.tools.jules_inspect({ action: "activities", session: "42" });

    const [url] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/v1alpha/sessions/42/activities");
    expect(result.content[0].text).toBe("No activities recorded yet for this session.");
  });

  it("jules_inspect activities renders message/approval/completion/fallback events, passes pagination params and shows the footer", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        activities: [
          { createTime: "t1", originator: "user", userMessaged: { userMessage: "Please add tests" } },
          { createTime: "t2", originator: "agent", agentMessaged: { agentMessage: "On it" } },
          { createTime: "t3", originator: "user", planApproved: { planId: "p1" } },
          { createTime: "t4", originator: "agent", sessionCompleted: {} },
          { createTime: "t5", originator: "system", description: "Something new" },
          { createTime: "t6", originator: "system" },
        ],
        nextPageToken: "more",
      }),
    });

    const result = await server.tools.jules_inspect({ action: "activities", session: "42", page_size: 3, page_token: "tokA" });

    const [url] = fetch.mock.calls[0];
    expect(url.searchParams.get("pageSize")).toBe("3");
    expect(url.searchParams.get("pageToken")).toBe("tokA");
    const text = result.content[0].text;
    expect(text).toContain("[t1] user: User message: Please add tests");
    expect(text).toContain("[t2] agent: Agent message: On it");
    expect(text).toContain("[t3] user: Plan approved (planId: p1)");
    expect(text).toContain("[t4] agent: Session completed");
    expect(text).toContain("[t5] system: Something new");
    expect(text).toContain("[t6] system: (event)");
    expect(text).toContain("(more available — next page_token: more)");
  });

  it("jules_inspect activities renders bash output, media placeholders and truncates long artifacts", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        activities: [{
          createTime: "t1",
          originator: "agent",
          progressUpdated: { title: "Running tests", description: "npm test" },
          artifacts: [
            { bashOutput: { command: "npm test", exitCode: 1, output: "x".repeat(2500) } },
            { media: { mimeType: "image/png" } },
            { changeSet: { gitPatch: { unidiffPatch: "y".repeat(3200) } } },
          ],
        }],
      }),
    });

    const result = await server.tools.jules_inspect({ action: "activities", session: "42" });

    const text = result.content[0].text;
    expect(text).toContain("Progress: Running tests — npm test");
    expect(text).toContain("  $ npm test  (exit 1)");
    expect(text).toContain("... (truncated, 500 more chars)");
    expect(text).toContain("  [media artifact: image/png]");
    expect(text).toContain("  Diff:\n");
    expect(text).toContain("... (truncated, 200 more chars)");
  });
});
