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

  it("takes only the leftmost entry out of a long spoofed chain, ignoring every hop after it", () => {
    // A malicious client can send its own multi-hop X-Forwarded-For; since
    // this server trusts the header as-is (see the NOTE in security.js),
    // the leftmost entry is whatever the client put there -- this test
    // documents that behavior rather than asserting it's un-spoofable.
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" },
      socket: { remoteAddress: "10.0.0.1" },
    };
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("treats an empty X-Forwarded-For header as absent and falls back to the socket address", () => {
    const req = { headers: { "x-forwarded-for": "" }, socket: { remoteAddress: "192.168.1.50" } };
    expect(getClientIp(req)).toBe("192.168.1.50");
  });

  it("returns an empty string for a whitespace-only X-Forwarded-For header, WITHOUT falling back to the socket address", () => {
    // NOTE: this is a real gap, not a hardening test -- the header-presence
    // check (`forwarded ? ... : socket.remoteAddress`) only looks at whether
    // the header exists, not whether it's meaningful after trim(). A
    // whitespace-only header is truthy, so the socket-address fallback
    // never runs, and the caller silently gets "" instead of the real
    // client IP. If getClientIp's result feeds an IP allowlist check, this
    // means a request with `X-Forwarded-For: ' '` fails open/closed
    // (depending on how the caller treats "") rather than using the
    // trustworthy socket address that was available the whole time.
    const req = { headers: { "x-forwarded-for": "   " }, socket: { remoteAddress: "192.168.1.50" } };
    expect(getClientIp(req)).toBe("");
  });

  it("trims surrounding whitespace around the leftmost entry", () => {
    const req = { headers: { "x-forwarded-for": "   203.0.113.7  , 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } };
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("handles a leading empty entry (leading comma) by returning the empty string rather than throwing", () => {
    const req = { headers: { "x-forwarded-for": ", 5.6.7.8" }, socket: { remoteAddress: "10.0.0.1" } };
    expect(getClientIp(req)).toBe("");
  });

  it("passes through a non-IPv4 leftmost entry unvalidated (getClientIp does not itself validate IP shape)", () => {
    // getClientIp only splits/trims/normalizes; format validation, if any,
    // is the caller's responsibility (e.g. via isIpv4 before use in an
    // allowlist check). This documents that it won't reject garbage itself.
    const req = { headers: { "x-forwarded-for": "not-an-ip, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } };
    expect(getClientIp(req)).toBe("not-an-ip");
  });

  it("normalizes a ::ffff:-prefixed leftmost X-Forwarded-For entry the same as a socket address", () => {
    const req = { headers: { "x-forwarded-for": "::ffff:203.0.113.7, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } };
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("passes through an IPv6 leftmost entry unchanged (no ::ffff: prefix to strip)", () => {
    const req = { headers: { "x-forwarded-for": "2001:db8::1, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } };
    expect(getClientIp(req)).toBe("2001:db8::1");
  });

  it("returns an empty string when there is neither an X-Forwarded-For header nor a socket address", () => {
    const req = { headers: {}, socket: {} };
    expect(getClientIp(req)).toBe("");
  });
});
