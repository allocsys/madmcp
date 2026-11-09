// ---------------------------------------------------------------------------
// test/muse-server-e2e.test.js
// Drives the real Express `app` through supertest: the actual route +
// middleware chain for the limited Muse endpoint (/mcp/muse), not a mock.
//
// Key-separation guarantees tested here:
//   - the Claude key (MCP_SHARED_KEY) is rejected on /mcp/muse
//   - the Muse key (MUSE_MCP_KEY) is rejected on /mcp
//   - /mcp/muse has NO IP allowlist (Muse doesn't come from Anthropic's
//     ranges) -- a valid Muse key works from a disallowed IP
//   - with MUSE_MCP_KEY unset the endpoint fails closed (401, not open)
//   - /mcp/muse has its own rate-limit counter (30/min)
//
// config.js reads env vars at import time, so they are set here BEFORE
// server.js is imported, via a dynamic import -- same pattern as
// test/server-e2e.test.js.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.MCP_SHARED_KEY = "test-shared-key-for-e2e";
process.env.MUSE_MCP_KEY = "test-muse-key-for-e2e";
process.env.IP_ALLOWLIST_ENABLED = "true";
process.env.ALLOWED_IP_RANGES = "203.0.113.0/24";
process.env.TRUST_PROXY_HOPS = "1";

const ALLOWED_IP = "203.0.113.42"; // inside 203.0.113.0/24
const DISALLOWED_IP = "198.51.100.7"; // outside the allowed CIDR
const CLAUDE_KEY = process.env.MCP_SHARED_KEY;
const MUSE_KEY = process.env.MUSE_MCP_KEY;

const INITIALIZE = {
  jsonrpc: "2.0",
  method: "initialize",
  id: 1,
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "muse-e2e-test", version: "1.0" },
  },
};

let app;
let request;

beforeAll(async () => {
  ({ app } = await import("../server.js"));
  ({ default: request } = await import("supertest"));
});

describe("POST /mcp/muse — key separation", () => {
  it("returns 401 with no key", async () => {
    const res = await request(app).post("/mcp/muse").send(INITIALIZE);
    expect(res.status).toBe(401);
  });

  it("returns 401 with the Claude key (keys are not interchangeable)", async () => {
    const res = await request(app)
      .post("/mcp/muse")
      .set("x-manufact-key", CLAUDE_KEY)
      .send(INITIALIZE);
    expect(res.status).toBe(401);
  });

  it("returns 200 with the Muse key, even from an IP outside the Claude allowlist", async () => {
    // This is the point of the separate route: Muse traffic doesn't come
    // from Anthropic's ranges, so /mcp/muse deliberately skips the IP
    // allowlist that /mcp enforces.
    const res = await request(app)
      .post("/mcp/muse")
      .set("x-manufact-key", MUSE_KEY)
      .set("X-Forwarded-For", DISALLOWED_IP)
      .set("Accept", "application/json, text/event-stream")
      .send(INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.text).toContain("madmcp-server-muse");
  });

  it("accepts the Muse key as a path segment, like /mcp does", async () => {
    const res = await request(app)
      .post(`/mcp/muse/${MUSE_KEY}`)
      .set("Accept", "application/json, text/event-stream")
      .send(INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.text).toContain("madmcp-server-muse");
  });
});

describe("POST /mcp — Muse key stays out, Claude behaviour unchanged", () => {
  it("returns 401 with the Muse key", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("x-manufact-key", MUSE_KEY)
      .set("X-Forwarded-For", ALLOWED_IP)
      .send(INITIALIZE);
    expect(res.status).toBe(401);
  });

  it("still returns 200 with the Claude key from an allowlisted IP", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("x-manufact-key", CLAUDE_KEY)
      .set("X-Forwarded-For", ALLOWED_IP)
      .set("Accept", "application/json, text/event-stream")
      .send(INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.text).toContain('"name":"madmcp-server"');
  });

  it("GET / reports the Muse endpoint as configured (MUSE_MCP_KEY is set here)", async () => {
    const res = await request(app)
      .get("/")
      .set("x-manufact-key", CLAUDE_KEY)
      .set("X-Forwarded-For", ALLOWED_IP);
    expect(res.status).toBe(200);
    expect(res.body.configured.muse).toBe(true);
    expect(res.body.configured.auth).toBe(true);
  });
});

// The Streamable HTTP transport answers with server-sent events; pull the
// single JSON payload out of the `data: ...` line.
function sseJson(res) {
  const line = res.text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice("data: ".length));
}

const MUSE_TOOLS = [
  "bridge_post",
  "get_file_tree",
  "list_directory",
  "list_notifications",
  "notion_find",
  "notion_read",
  "pr_read",
  "read_file",
  "repo_inspect",
  "repo_metadata",
  "search_code",
];

describe("tools/list + tools/call over HTTP — the route serves the filtered server", () => {
  // The InMemory tests in test/muse-readonly.test.js prove what
  // createMuseMcpServer registers; these prove the HTTP route actually
  // serves that server (and not the full one) to a real client.
  it("tools/list on /mcp/muse returns exactly the 11 Muse tools", async () => {
    const res = await request(app)
      .post("/mcp/muse")
      .set("x-manufact-key", MUSE_KEY)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const names = sseJson(res).result.tools.map((t) => t.name).sort();
    expect(names).toEqual(MUSE_TOOLS);
  });

  it("tools/list on /mcp returns the full set, including bridge_post and writes", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("x-manufact-key", CLAUDE_KEY)
      .set("X-Forwarded-For", ALLOWED_IP)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const names = new Set(sseJson(res).result.tools.map((t) => t.name));
    for (const name of ["bridge_post", "edit_file", "delegate_agent", "termux_exec"]) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.size).toBeGreaterThan(MUSE_TOOLS.length);
  });

  it("tools/call bridge_post on /mcp/muse fails closed over HTTP (bridge unconfigured in this test env)", async () => {
    const res = await request(app)
      .post("/mcp/muse")
      .set("x-manufact-key", MUSE_KEY)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "bridge_post", arguments: { message: "hello from the e2e test" } },
      });
    expect(res.status).toBe(200);
    const result = sseJson(res).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not configured/);
  });

  it("tools/call bridge_post on /mcp also reaches the handler (sender claude) and fails the same way", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("x-manufact-key", CLAUDE_KEY)
      .set("X-Forwarded-For", ALLOWED_IP)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "bridge_post", arguments: { message: "hello from the e2e test" } },
      });
    expect(res.status).toBe(200);
    const result = sseJson(res).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not configured/);
  });
});

describe("POST /mcp/muse — rate limiting (own counter)", () => {
  let freshApp;

  beforeAll(async () => {
    vi.resetModules();
    ({ app: freshApp } = await import("../server.js"));
  });

  it("allows 30 unauthenticated requests then returns 429 on the 31st", async () => {
    const statuses = [];
    for (let i = 0; i < 31; i++) {
      const res = await request(freshApp)
        .post("/mcp/muse")
        .send({ ...INITIALIZE, id: i });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(401));
    expect(statuses[30]).toBe(429);
  }, 20000);
});

describe("POST /mcp/muse — fail-closed when MUSE_MCP_KEY is unset", () => {
  let closedApp;

  beforeAll(async () => {
    delete process.env.MUSE_MCP_KEY;
    vi.resetModules();
    ({ app: closedApp } = await import("../server.js"));
  });

  afterAll(() => {
    process.env.MUSE_MCP_KEY = MUSE_KEY;
  });

  it("returns 401 even with a key-shaped value, and says it is not configured", async () => {
    const res = await request(closedApp)
      .post("/mcp/muse")
      .set("x-manufact-key", "anything-at-all")
      .send(INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/not configured/);
  });
});
