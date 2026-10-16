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

// Loads fresh copies of the config-dependent modules with the given Termux
// settings, since TERMUX_ENABLED / TERMUX_AGENT_SECRET are read at import time.
async function load({ enabled = true, secret = "s3cret" } = {}) {
  vi.resetModules();
  const redis = makeFakeRedis();
  vi.doMock("../connectors/shared/cooldown.js", () => ({ getRedis: () => redis }));
  vi.doMock("../config.js", async (importOriginal) => ({
    ...(await importOriginal()),
    TERMUX_ENABLED: enabled,
    TERMUX_AGENT_SECRET: secret,
    TERMUX_WAIT_POLL_MS: 10,
  }));
  const tools = {};
  const server = { tool: (name, _description, _schema, handler) => { tools[name] = handler; } };
  const mod = await import("../connectors/termux/tools.js");
  mod.register(server);
  const queue = await import("../connectors/termux/queue.js");
  return { tools, queue, redis };
}

// Stands in for the phone: waits for a job, then completes it.
async function fakePhone(queue, result) {
  for (let i = 0; i < 400; i++) {
    const job = await queue.claimJob();
    if (job) {
      await queue.completeJob(job.id, result);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fake phone never saw a job");
}

const text = (res) => res.content[0].text;

describe("termux tools", () => {
  it("registers nothing unless TERMUX_ENABLED is true", async () => {
    const { tools } = await load({ enabled: false });
    expect(Object.keys(tools)).toEqual([]);
  });

  it("registers termux_exec, termux_api and termux_result when enabled", async () => {
    const { tools } = await load();
    expect(Object.keys(tools).sort()).toEqual(["termux_api", "termux_exec", "termux_result"]);
  });

  it("termux_exec returns the phone's output", async () => {
    const { tools, queue } = await load();
    const phone = fakePhone(queue, { exitCode: 0, stdout: "hello\n", stderr: "" });

    const res = await tools.termux_exec({ command: "echo hello", wait_seconds: 5 });
    const job = await phone;

    expect(res.isError).toBe(false);
    expect(text(res)).toMatch(/exit code 0/);
    expect(text(res)).toMatch(/hello/);
    expect(job.kind).toBe("exec");
    expect(job.command).toBe("echo hello");
  });

  it("termux_exec flags a non-zero exit code as an error", async () => {
    const { tools, queue } = await load();
    const phone = fakePhone(queue, { exitCode: 2, stdout: "", stderr: "no such file" });

    const res = await tools.termux_exec({ command: "cat nope", wait_seconds: 5 });
    await phone;

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/exit code 2/);
    expect(text(res)).toMatch(/no such file/);
  });

  it("returns a queued job_id when the phone has not picked the job up, then termux_result collects it", async () => {
    const { tools, queue } = await load();

    const queued = await tools.termux_exec({ command: "uptime", wait_seconds: 0 });
    expect(queued.isError).toBe(false);
    expect(text(queued)).toMatch(/QUEUED/);
    const id = /Job ([0-9a-f-]{36})/.exec(text(queued))[1];

    const claimed = await queue.claimJob();
    expect(claimed.id).toBe(id);
    await queue.completeJob(id, { exitCode: 0, stdout: "up 3 hours", stderr: "" });

    const result = await tools.termux_result({ job_id: id, wait_seconds: 0 });
    expect(result.isError).toBe(false);
    expect(text(result)).toMatch(/up 3 hours/);
  });

  it("termux_api queues a structured job with validated args only", async () => {
    const { tools, queue } = await load();
    const res = await tools.termux_api({ action: "notify", content: "hi", title: "T", text: "ignored", wait_seconds: 0 });
    expect(res.isError).toBe(false);

    const job = await queue.claimJob();
    expect(job.kind).toBe("api");
    expect(job.action).toBe("notify");
    expect(job.args).toEqual({ content: "hi", title: "T" }); // `text` is not a notify field
    expect(job.command).toBeUndefined();
  });

  it("termux_api rejects missing required fields without queueing anything", async () => {
    const { tools, redis } = await load();
    const res = await tools.termux_api({ action: "clipboard_set", wait_seconds: 0 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/requires 'text'/);
    expect(await redis.llen("termux:queue")).toBe(0);
  });

  it("termux_api rejects an out-of-range vibrate duration", async () => {
    const { tools } = await load();
    const res = await tools.termux_api({ action: "vibrate", duration_ms: 999999, wait_seconds: 0 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/duration_ms/);
  });

  it("refuses to queue when TERMUX_AGENT_SECRET is unset", async () => {
    const { tools, redis } = await load({ secret: "" });
    const res = await tools.termux_exec({ command: "ls", wait_seconds: 0 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/TERMUX_AGENT_SECRET/);
    expect(await redis.llen("termux:queue")).toBe(0);
  });

  it("termux_result rejects a malformed id and reports an unknown one", async () => {
    const { tools } = await load();
    const bad = await tools.termux_result({ job_id: "not-a-uuid", wait_seconds: 0 });
    expect(bad.isError).toBe(true);

    const unknown = await tools.termux_result({ job_id: "00000000-0000-4000-8000-000000000000", wait_seconds: 0 });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/not found/);
  });
});
