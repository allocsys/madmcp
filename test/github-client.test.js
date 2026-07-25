import { describe, it, expect } from "vitest";
import { toBase64, fromBase64, isRetryable, retryDelayMs } from "../connectors/github/client.js";

function mockRes(status, headers = {}) {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() in headers ? headers[name.toLowerCase()] : null),
    },
  };
}

describe("toBase64 / fromBase64", () => {
  it("round-trips UTF-8 text, including non-ASCII characters", () => {
    const original = "Hello, madmcp! \u00e9\u00e8\u00ea";
    expect(fromBase64(toBase64(original))).toBe(original);
  });

  it("produces standard base64 output", () => {
    expect(toBase64("hi")).toBe("aGk=");
  });
});

describe("isRetryable", () => {
  it("retries plain 429 responses", () => {
    expect(isRetryable(mockRes(429), null)).toBe(true);
  });

  it("retries a 403 that reports GitHub's secondary rate limit", () => {
    const res = mockRes(403);
    const data = { message: "You have exceeded a secondary rate limit" };
    expect(isRetryable(res, data)).toBe(true);
  });

  it("retries a 403 with x-ratelimit-remaining: 0", () => {
    const res = mockRes(403, { "x-ratelimit-remaining": "0" });
    expect(isRetryable(res, {})).toBe(true);
  });

  it("does not retry an ordinary 403 (e.g. permission denied)", () => {
    const res = mockRes(403, { "x-ratelimit-remaining": "42" });
    expect(isRetryable(res, { message: "Must have admin rights" })).toBe(false);
  });

  it("does not retry a plain 404", () => {
    expect(isRetryable(mockRes(404), { message: "Not Found" })).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("honors a numeric Retry-After header, in seconds", () => {
    const res = mockRes(429, { "retry-after": "2" });
    expect(retryDelayMs(res, 0)).toBe(2000);
  });

  it("derives a delay from x-ratelimit-reset when Retry-After is absent", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 5;
    const res = mockRes(403, { "x-ratelimit-reset": String(resetAt) });
    const delay = retryDelayMs(res, 0);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("falls back to exponential backoff with jitter when no headers are present", () => {
    const res = mockRes(429, {});
    const delay = retryDelayMs(res, 0);
    // base 1500 * 2^0 = 1500, plus up to 250ms jitter
    expect(delay).toBeGreaterThanOrEqual(1500);
    expect(delay).toBeLessThan(1750);
  });

  it("doubles the fallback delay on each subsequent attempt", () => {
    const res = mockRes(429, {});
    const delay = retryDelayMs(res, 2);
    // base 1500 * 2^2 = 6000, plus up to 250ms jitter
    expect(delay).toBeGreaterThanOrEqual(6000);
    expect(delay).toBeLessThan(6250);
  });
});
