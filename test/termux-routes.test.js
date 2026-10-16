import { describe, it, expect, vi } from "vitest";

function makeFakeRedis() {
  const strings = new Map();
  const lists = new Map();
  return {
    async set(key, val) { strings.set(key, val); return "OK"; },
    async get(key) { return strings.has(key) ? strings.get(key) : null; },
    async del(key) { strings.delete(key); lists.delete(key); return 1; },
    async lpush(key, ...vals) { const l = lists.get(key) || []; l.unshift(...vals); lists.set(key, l); return l.length; },
    async rpop(key) { const l = lists.get(key) || []; const v = l.pop(); lists.set(key, l); return v ?? null; },
    async llen(key) { return (lists.get(key) || []).length; },
    async expire() { return 1; },
  };
}

async function load({ enabled = true, secret = "s3cret" } = {}) {
  vi.resetModules();
  const redis = makeFakeRedis();
  vi.doMock("../connectors/shared/cooldown.js", () => ({ getRedis: () => redis }));
  vi.doMock("../config.js", async (importOriginal) => ({
    ...(await importOriginal()),
    TERMUX_ENABLED: enabled,
    TERMUX_AGENT_SECRET: secret,
  }));
  const routes = await import("../connectors/termux/agent_routes.js");
  const queue = await import("../connectors/termux/queue.js");
  return { routes, queue };
}

function mockReq({ auth, body, params } = {}) {
  return {
    get: (name) => (name.toLowerCase() === "authorization" ? auth : undefined),
    body,
    params: params || {},
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const GOOD = "Bearer s3cret";

describe("termux agent routes", () => {
  it("rejects poll and result without a valid bearer token", async () => {
    const { routes } = await load();
    for (const auth of [undefined, "", "Bearer wrong", "s3cret", "Basic s3cret"]) {
      const poll = mockRes();
      await routes.handleTermuxPoll(mockReq({ auth }), poll);
      expect(poll.statusCode).toBe(401);

      const result = mockRes();
      await routes.handleTermuxResult(mockReq({ auth, params: { id: "00000000-0000-4000-8000-000000000000" }, body: {} }), result);
      expect(result.statusCode).toBe(401);
    }
  });

  it("rejects everything when the feature flag is off, even with the right token", async () => {
    const { routes } = await load({ enabled: false });
    const res = mockRes();
    await routes.handleTermuxPoll(mockReq({ auth: GOOD }), res);
    expect(res.statusCode).toBe(401);
  });

  it("rejects everything when no secret is configured", async () => {
    const { routes } = await load({ secret: undefined });
    const res = mockRes();
    await routes.handleTermuxPoll(mockReq({ auth: "Bearer undefined" }), res);
    expect(res.statusCode).toBe(401);
  });

  it("poll returns { job: null } when the queue is empty", async () => {
    const { routes } = await load();
    const res = mockRes();
    await routes.handleTermuxPoll(mockReq({ auth: GOOD }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ job: null });
  });

  it("poll hands the agent only the fields it needs", async () => {
    const { routes, queue } = await load();
    const job = await queue.enqueueJob({ kind: "exec", command: "ls", cwd: "/tmp", timeoutSeconds: 30 });

    const res = mockRes();
    await routes.handleTermuxPoll(mockReq({ auth: GOOD }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.job).toEqual({
      id: job.id,
      kind: "exec",
      command: "ls",
      cwd: "/tmp",
      action: undefined,
      args: undefined,
      timeoutSeconds: 30,
    });
    expect(res.body.job.status).toBeUndefined();
    expect(res.body.job.createdAt).toBeUndefined();
  });

  it("result completes a claimed job end to end", async () => {
    const { routes, queue } = await load();
    const job = await queue.enqueueJob({ kind: "exec", command: "echo hi", timeoutSeconds: 30 });
    await routes.handleTermuxPoll(mockReq({ auth: GOOD }), mockRes());

    const res = mockRes();
    await routes.handleTermuxResult(
      mockReq({ auth: GOOD, params: { id: job.id }, body: { exitCode: 0, stdout: "hi\n", stderr: "", timedOut: false } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const stored = await queue.getJob(job.id);
    expect(stored.status).toBe("done");
    expect(stored.result.stdout).toBe("hi\n");
  });

  it("result returns 400 for a malformed id, 404 for an unknown job, 409 for a replay", async () => {
    const { routes, queue } = await load();

    const bad = mockRes();
    await routes.handleTermuxResult(mockReq({ auth: GOOD, params: { id: "../etc/passwd" }, body: {} }), bad);
    expect(bad.statusCode).toBe(400);

    const unknown = mockRes();
    await routes.handleTermuxResult(mockReq({ auth: GOOD, params: { id: "00000000-0000-4000-8000-000000000000" }, body: { exitCode: 0 } }), unknown);
    expect(unknown.statusCode).toBe(404);

    const job = await queue.enqueueJob({ kind: "exec", command: "ls", timeoutSeconds: 30 });
    await routes.handleTermuxPoll(mockReq({ auth: GOOD }), mockRes());
    await routes.handleTermuxResult(mockReq({ auth: GOOD, params: { id: job.id }, body: { exitCode: 0, stdout: "first" } }), mockRes());
    const replay = mockRes();
    await routes.handleTermuxResult(mockReq({ auth: GOOD, params: { id: job.id }, body: { exitCode: 1, stdout: "second" } }), replay);
    expect(replay.statusCode).toBe(409);
    expect((await queue.getJob(job.id)).result.stdout).toBe("first");
  });
});
