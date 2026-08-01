// ---------------------------------------------------------------------------
// connectors/fetch/client.js — simple HTTP fetch helper, with an SSRF guard.
//
// web_fetch takes an arbitrary caller-supplied URL (and forwards arbitrary
// caller-supplied headers), so without validation it can be used to reach
// internal/private network addresses reachable from this server (cloud
// metadata endpoints like 169.254.169.254, localhost services, RFC1918
// ranges, etc). isSafeUrl() resolves the hostname and rejects anything
// that isn't a public address before the request is made, and redirects
// are followed manually (not via fetch's redirect:"follow") so every hop
// gets re-validated the same way — an attacker-controlled redirect can't
// bounce the request to an internal address after an initial public URL
// passes the check.
// ---------------------------------------------------------------------------

import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const MAX_REDIRECTS = 5;

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed -> treat as unsafe
  const [a, b] = parts;
  if (a === 0) return true;                                  // 0.0.0.0/8
  if (a === 10) return true;                                  // 10.0.0.0/8
  if (a === 127) return true;                                  // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;                     // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                      // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;            // 100.64.0.0/10 (CGNAT)
  if (a >= 224) return true;                                     // multicast/reserved
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;                             // loopback
  if (lower === "::") return true;                                // unspecified
  if (lower.startsWith("fe80:")) return true;                    // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local (fc00::/7)
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — check the embedded IPv4 address too.
    return isPrivateIPv4(lower.slice(7));
  }
  return false;
}

function isPrivateIP(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // not a recognizable IP -> treat as unsafe
}

async function assertSafeUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}" — only http/https are allowed.`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets if present
  if (hostname.toLowerCase() === "localhost") {
    throw new Error("Blocked: requests to localhost are not allowed.");
  }

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const results = await dns.lookup(hostname, { all: true });
      addresses = results.map((r) => r.address);
    } catch (err) {
      throw new Error(`Could not resolve host "${hostname}": ${err.message}`, { cause: err });
    }
  }
  if (!addresses.length || addresses.some(isPrivateIP)) {
    throw new Error(`Blocked: "${hostname}" resolves to a private, loopback, or link-local address, which this tool is not allowed to reach.`);
  }
  // Return the resolved address alongside the parsed URL so the caller can
  // pin the actual TCP connection to it (see fetchUrl below). Without this,
  // fetch() would re-resolve the hostname itself a moment later — if the
  // attacker controls DNS for the host, they can serve a public IP here and
  // a private/metadata IP on the real connection (DNS rebinding / TOCTOU),
  // slipping past this check entirely.
  return { parsed, address: addresses[0] };
}

// Strip HTML tags and collapse whitespace into readable plain text. Lives
// here (not fetch/tools.js) so other connectors that need the same
// HTML-to-text step server-side -- e.g. exa/research_tools.js's delegate_research
// (both its precision mode and, via research_delegate.js, its wide mode), which
// strips a fetched page before handing it to Gemini -- can reuse this
// instead of duplicating the tag/entity-stripping regexes.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A dns.lookup-compatible function that ignores whatever hostname it's asked
// to resolve and always answers with the single pre-validated `address`.
// Handles both the plain (err, address, family) callback form and the
// { all: true } form (an array of {address, family}) that Node's Happy
// Eyeballs / autoSelectFamily connection logic uses.
export function pinnedLookup(address) {
  const family = net.isIP(address);
  return (_hostname, options, callback) => {
    if (options && options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

// Builds a dispatcher that forces the TCP connection to `address` while
// leaving the request's Host header / TLS SNI on the original hostname
// (undici derives those from the URL, not from this lookup override) — so
// the connection goes exactly where assertSafeUrl() validated it would.
export function pinnedDispatcher(address) {
  return new Agent({ connect: { lookup: pinnedLookup(address) } });
}

export async function fetchUrl(url, { method = "GET", headers = {}, body } = {}) {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const { parsed, address } = await assertSafeUrl(currentUrl);
    const res = await undiciFetch(parsed, {
      method,
      headers: {
        "User-Agent": "madmcp-server/2.0",
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
      redirect: "manual",
      dispatcher: pinnedDispatcher(address),
    });

    // Manual redirect handling: re-validate the Location header through the
    // same SSRF check before following it, rather than letting fetch follow
    // it automatically and unchecked.
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        const contentType = res.headers.get("content-type") || "";
        const text = await res.text();
        return { status: res.status, ok: res.ok, contentType, text };
      }
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    return { status: res.status, ok: res.ok, contentType, text };
  }
  throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) while fetching ${url}.`);
}
