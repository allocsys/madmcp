import { describe, it, expect } from "vitest";
import {
  safeEqual,
  ipToLong,
  isIpv4,
  isIpInCidr,
  normalizeIp,
  getClientIp,
} from "../connectors/security.js";

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("secret-key", "secret-key")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(safeEqual("secret-key", "secret-keZ")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(safeEqual("short", "much-longer-string")).toBe(false);
  });

  it("returns false when either argument is not a string", () => {
    expect(safeEqual(undefined, "x")).toBe(false);
    expect(safeEqual("x", undefined)).toBe(false);
    expect(safeEqual(null, null)).toBe(false);
  });
});

describe("isIpv4", () => {
  it("accepts a plain dotted-quad address", () => {
    expect(isIpv4("192.168.1.1")).toBe(true);
  });

  it("rejects IPv6 addresses", () => {
    expect(isIpv4("::1")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isIpv4("not-an-ip")).toBe(false);
    expect(isIpv4("")).toBe(false);
  });
});

describe("ipToLong", () => {
  it("converts a dotted-quad address to its 32-bit integer form", () => {
    expect(ipToLong("0.0.0.1")).toBe(1);
    expect(ipToLong("255.255.255.255")).toBe(4294967295);
  });
});

describe("isIpInCidr", () => {
  it("matches an address inside a /21 range (Anthropic's published range)", () => {
    expect(isIpInCidr("160.79.104.5", "160.79.104.0/21")).toBe(true);
  });

  it("rejects an address outside the range", () => {
    expect(isIpInCidr("160.79.112.5", "160.79.104.0/21")).toBe(false);
  });

  it("treats a /32 as an exact match only", () => {
    expect(isIpInCidr("208.77.244.90", "208.77.244.90/32")).toBe(true);
    expect(isIpInCidr("208.77.244.91", "208.77.244.90/32")).toBe(false);
  });

  it("treats a /0 as matching everything", () => {
    expect(isIpInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });

  it("returns false for a malformed client IP or range", () => {
    expect(isIpInCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(isIpInCidr("10.0.0.1", "not-a-range/8")).toBe(false);
  });

  it("treats a /31 as a two-address range", () => {
    expect(isIpInCidr("10.0.0.0", "10.0.0.0/31")).toBe(true);
    expect(isIpInCidr("10.0.0.1", "10.0.0.0/31")).toBe(true);
    expect(isIpInCidr("10.0.0.2", "10.0.0.0/31")).toBe(false);
  });

  it("treats a /1 as half the address space", () => {
    expect(isIpInCidr("1.2.3.4", "0.0.0.0/1")).toBe(true);
    expect(isIpInCidr("200.0.0.1", "0.0.0.0/1")).toBe(false);
    expect(isIpInCidr("200.0.0.1", "128.0.0.0/1")).toBe(true);
  });

  it("rejects a prefix length above 32 instead of wrapping via JS shift-mod-32 semantics", () => {
    // Without the explicit bits > 32 guard, "/33" would silently behave
    // like "/1" because JS's << operator takes the shift amount mod 32.
    expect(isIpInCidr("1.2.3.4", "0.0.0.0/33")).toBe(false);
    expect(isIpInCidr("255.255.255.255", "0.0.0.0/33")).toBe(false);
  });

  it("rejects a non-numeric or trailing-junk prefix length instead of coercing it via parseInt", () => {
    // Without the /^\d{1,2}$/ guard, parseInt("xyz", 10) is NaN (bits > 32
    // check fails open) and parseInt("24abc", 10) silently parses as 24.
    expect(isIpInCidr("10.0.0.1", "10.0.0.0/xyz")).toBe(false);
    expect(isIpInCidr("10.0.0.1", "10.0.0.0/24abc")).toBe(false);
  });

  it("rejects a negative prefix length", () => {
    expect(isIpInCidr("1.2.3.4", "0.0.0.0/-1")).toBe(false);
  });
});

describe("normalizeIp", () => {
  it("strips the ::ffff: prefix Node adds on dual-stack sockets", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  it("leaves a plain IPv4 address unchanged", () => {
    expect(normalizeIp("127.0.0.1")).toBe("127.0.0.1");
  });

  it("returns an empty string for non-string input", () => {
    expect(normalizeIp(undefined)).toBe("");
    expect(normalizeIp(null)).toBe("");
  });
});

describe("getClientIp", () => {
  it("prefers the leftmost X-Forwarded-For entry over the socket address", () => {
    const req = {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    };
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("falls back to the socket address when there's no X-Forwarded-For header", () => {
    const req = { headers: {}, socket: { remoteAddress: "192.168.1.50" } };
    expect(getClientIp(req)).toBe("192.168.1.50");
  });

  it("normalizes a ::ffff:-prefixed socket address", () => {
    const req = { headers: {}, socket: { remoteAddress: "::ffff:192.168.1.50" } };
    expect(getClientIp(req)).toBe("192.168.1.50");
  });
});
