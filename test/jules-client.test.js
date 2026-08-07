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

  it("jules_list_sources reports an empty account clearly", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ sources: [] }) });

    const result = await server.tools.jules_list_sources({});
    expect(result.content[0].text).toContain("No sources connected");
  });
});
