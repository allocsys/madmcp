import { describe, it, expect } from "vitest";
import { createThrottle, sleep } from "../connectors/shared/rate-limit.js";

describe("createThrottle", () => {
  it("spaces starts by at least the interval", async () => {
    const schedule = createThrottle(40);
    const starts = [];
    await Promise.all([1, 2, 3].map(() => schedule(async () => { starts.push(Date.now()); })));
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(35);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(35);
  });

  it("lets slow calls overlap", async () => {
    const schedule = createThrottle(20);
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4].map(() => schedule(() => sleep(150))));
    // serial would be ~600ms+; overlapped is ~150 + 3*20
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("a failing call does not jam the queue", async () => {
    const schedule = createThrottle(5);
    await expect(schedule(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(schedule(async () => "ok")).resolves.toBe("ok");
  });
});
