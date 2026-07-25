// ---------------------------------------------------------------------------
// connectors/security.js -- IP allowlist + shared-key auth helpers, extracted
// from server.js so they're unit-testable without spinning up the HTTP
// server. Behavior is unchanged from the original server.js implementation;
// see test/security.test.js for coverage.
// ---------------------------------------------------------------------------

// Constant-time-ish comparison to avoid trivial timing leaks on the shared key.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function ipToLong(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + (parseInt(octet, 10) & 0xff), 0) >>> 0;
}

export function isIpv4(ip) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

export function isIpInCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  if (!isIpv4(ip) || !isIpv4(range)) return false;
  const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

// Strips the ::ffff: prefix Node sometimes adds to IPv4 addresses on dual-stack sockets.
export function normalizeIp(ip) {
  if (typeof ip !== "string") return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

// Reads the client IP from X-Forwarded-For (leftmost = original client) when
// present, falling back to the raw socket address. NOTE: this trusts
// X-Forwarded-For, which is only safe because the deploy platform sits in
// front of this server as the sole entry point (it overwrites/sets this
// header itself). If that ever changes, this needs `app.set('trust proxy', ...)`
// tuned to the actual number of trusted hops, or the header becomes spoofable.
export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
  return normalizeIp(raw || "");
}
