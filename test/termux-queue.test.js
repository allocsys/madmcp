import { describe, it, expect, vi, beforeEach } from "vitest";

// Tiny in-memory stand-in for the @upstash/redis calls queue.js uses
// (set/get/lpush/rpop/llen/expire). A real, if small, store -- so these tests
// check actual queue behaviour, not just which methods were called.
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

const fakeRedis = makeFakeRedis();
vi.mock("../connectors/shared/cooldown.js", () => ({
  getRedis: () => fakeRedis,
}));

describe("termux queue.js", () => {
  let queue;

  beforeEach(async () => {
    vi.resetModules();
    // Drain anything a previous test left behind.
    while (await fakeRedis.rpop("termux:queue")) { /* drain */ }
    queue = await import("../connectors/termux/queue.js");
  });

  it("claims jobs oldest-first and marks them running", async () => {
    const a = await queue.enqueueJob({ kind: "exec", command: "echo a", timeoutSeconds: 30 });
    const b = await queue.enqueueJob({ kind: "exec", command: "echo b", timeoutSeconds: 30 });

    const first = await queue.claimJob();
    expect(first.id).toBe(a.id);
    expect(first.status).toBe("running");
    expect((await queue.getJob(a.id)).status).toBe("running");

    const second = await queue.claimJob();
    expect(second.id).toBe(b.id);

    expect(await queue.claimJob()).toBeNull();
  });

  it("skips ids whose job record has expired", async () => {
    const a = await queue.enqueueJob({ kind: "exec", command: "echo a", timeoutSeconds: 30 });
    const b = await queue.enqueueJob({ kind: "exec", command: "echo b", timeoutSeconds: 30 });
    await fakeRedis.del(`termux:job:${a.id}`); // simulate TTL expiry

    const claimed = await queue.claimJob();
    expect(claimed.id).toBe(b.id);
  });

  it("stores the result and refuses a second completion", async () => {
    const job = await queue.enqueueJob({ kind: "exec", command: "ls", timeoutSeconds: 30 });
    await queue.claimJob();

    const first = await queue.completeJob(job.id, { exitCode: 0, stdout: "file.txt\n", stderr: "" });
    expect(first).toEqual({ ok: true });

    const stored = await queue.getJob(job.id);
    expect(stored.status).toBe("done");
    expect(stored.result.exitCode).toBe(0);
    expect(stored.result.stdout).toBe("file.txt\n");

    const replay = await queue.completeJob(job.id, { exitCode: 1, stdout: "overwritten", stderr: "" });
    expect(replay).toEqual({ ok: false, reason: "not_running" });
    expect((await queue.getJob(job.id)).result.stdout).toBe("file.txt\n");
  });

  it("reports not_found for an unknown job and not_running for a job nobody claimed", async () => {
    expect(await queue.completeJob("00000000-0000-4000-8000-000000000000", { exitCode: 0 }))
      .toEqual({ ok: false, reason: "not_found" });

    const job = await queue.enqueueJob({ kind: "exec", command: "ls", timeoutSeconds: 30 });
    expect(await queue.completeJob(job.id, { exitCode: 0 }))
      .toEqual({ ok: false, reason: "not_running" });
  });

  it("marks a job failed when the agent reports an error", async () => {
    const job = await queue.enqueueJob({ kind: "api", action: "battery", args: {}, timeoutSeconds: 30 });
    await queue.claimJob();
    await queue.completeJob(job.id, { exitCode: null, error: "termux-battery-status: not found" });
    const stored = await queue.getJob(job.id);
    expect(stored.status).toBe("failed");
    expect(stored.result.error).toMatch(/not found/);
  });

  it("truncates oversized output", async () => {
    const job = await queue.enqueueJob({ kind: "exec", command: "yes", timeoutSeconds: 30 });
    await queue.claimJob();
    await queue.completeJob(job.id, { exitCode: 0, stdout: "x".repeat(200000), stderr: "" });
    const stored = await queue.getJob(job.id);
    expect(stored.result.stdout.length).toBeLessThan(200000);
    expect(stored.result.stdout).toMatch(/truncated/);
  });

  it("refuses to queue past the depth cap", async () => {
    for (let i = 0; i < 20; i++) {
      await queue.enqueueJob({ kind: "exec", command: `echo ${i}`, timeoutSeconds: 30 });
    }
    await expect(queue.enqueueJob({ kind: "exec", command: "one too many", timeoutSeconds: 30 }))
      .rejects.toThrow(/waiting/);
  });

  it("waitForJob returns as soon as the job finishes", async () => {
    const job = await queue.enqueueJob({ kind: "exec", command: "sleep 1", timeoutSeconds: 30 });
    await queue.claimJob();
    setTimeout(() => { queue.completeJob(job.id, { exitCode: 0, stdout: "ok", stderr: "" }); }, 30);

    const finished = await queue.waitForJob(job.id, { waitMs: 2000, intervalMs: 10 });
    expect(finished.status).toBe("done");
    expect(finished.result.stdout).toBe("ok");
  });

  it("waitForJob with no wait returns the current state immediately", async () => {
    const job = await queue.enqueueJob({ kind: "exec", command: "ls", timeoutSeconds: 30 });
    const current = await queue.waitForJob(job.id, { waitMs: 0 });
    expect(current.status).toBe("queued");
  });

  it("waitForJob returns null for an unknown id", async () => {
    expect(await queue.waitForJob("00000000-0000-4000-8000-000000000000", { waitMs: 0 })).toBeNull();
  });
});
