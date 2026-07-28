// ---------------------------------------------------------------------------
// test/server-e2e.test.js
// Drives the real Express `app` (exported from server.js) through supertest:
// actual route + middleware chain (mcpLimiter -> requireMcpKey ->
// requireAllowedIp -> handler), not a mock of any of it.
//
// config.js reads its env vars at import time, so the relevant env vars are
// set here BEFORE server.js (and therefore config.js) is imported, via a
// dynamic import.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.MCP_SHARED_KEY = "test-shared-key-for-e2e";
process.env.IP_ALLOWLIST_ENABLED = "true";
process.env.ALLOWED_IP_RANGES = "203.0.113.0/24";
process.env.TRUST_PROXY_HOPS = "1";

const ALLOWED_IP    = "203.0.113.42"; // inside 203.0.113.0/24
const DISALLOWED_IP = "198.51.100.7"; // outside the allowed CIDR
const VALID_KEY     = process.env.MCP_SHARED_KEY;

let app;
let request;

beforeAll(async () => {
  ({ app } = await import("../server.js"));
  ({ default: request } = await import("supertest"));
});

describe("GET /health", () => {
  it("returns 200 { status: 'ok' } with no auth required", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /mcp — auth + IP allowlist ordering", () => {
  it("returns 401 when no key is provided, even from an allowlisted IP", async () => {
    // requireMcpKey runs before requireAllowedIp, so a missing key always
    // short-circuits first regardless of IP.
    const res = await request(app)
      .post("/mcp")
      .set("X-Forwarded-For", ALLOWED_IP)
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });

    expect(res.status).toBe(401);
  });

  it("returns 403 when a valid key is provided from an IP outside the allowed CIDR", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("x-manufact-key", VALID_KEY)
      .set("X-Forwarded-For", DISALLOWED_IP)
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });

    expect(res.status).toBe(403);
  });
});

describe("POST /mcp — rate limiting", () => {
  let freshApp;

  beforeAll(async () => {
    // The earlier describe blocks already sent a couple of requests through
    // the shared `app` singleton's mcpLimiter, so re-importing it here would
    // start this test partway into that quota. vi.resetModules() forces a
    // brand-new module graph (and therefore a brand-new express-rate-limit
    // instance with its own untouched counter) isolated from those tests.
    vi.resetModules();
    ({ app: freshApp } = await import("../server.js"));
  });

  it("allows 30 unauthenticated requests then returns 429 on the 31st", async () => {
    // mcpLimiter is the first middleware in the chain, so it still counts
    // requests that go on to fail auth. Sending them with no key keeps each
    // one cheap (short-circuits at the 401 stage) instead of invoking the
    // real MCP handler 30 times.
    const statuses = [];
    for (let i = 0; i < 31; i++) {
      const res = await request(freshApp)
        .post("/mcp")
        .send({ jsonrpc: "2.0", method: "initialize", id: i });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(401));
    expect(statuses[30]).toBe(429);
  }, 20000);
});
