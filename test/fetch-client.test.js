import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:dns/promises
vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn(),
  },
}));

// Mock undici Agent and fetch
vi.mock("undici", () => {
  class MockAgent {
    constructor() {
      this.dispatch = vi.fn();
      this.close = vi.fn();
    }
  }
  return {
    Agent: MockAgent,
    fetch: vi.fn(),
  };
});

import dns from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import { htmlToText, fetchUrl } from "../connectors/fetch/client.js";
import { register } from "../connectors/fetch/tools.js";

function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("Fetch Connector - htmlToText", () => {
  it("should strip HTML tags and scripts/styles", () => {
    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
          <script>console.log("hello");</script>
        </head>
        <body>
          <h1>Title</h1>
          <p>This is a <strong>paragraph</strong>.</p>
        </body>
      </html>
    `;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("This is a paragraph");
    expect(text).not.toContain("body { color: red; }");
    expect(text).not.toContain("console.log");
  });

  it("should decode common HTML entities", () => {
    const html = "Hello&nbsp;world! &amp; &lt;tag&gt; &quot;quote&quot; &#39;single&#39;";
    expect(htmlToText(html)).toBe("Hello world! & <tag> \"quote\" 'single'");
  });

  it("should collapse multiple whitespace and newlines", () => {
    const html = "Hello \t \t world!\n\n\n\nNew Line";
    expect(htmlToText(html)).toBe("Hello world!\n\nNew Line");
  });
});

describe("Fetch Connector - fetchUrl and assertSafeUrl security guards", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects invalid URLs", async () => {
    await expect(fetchUrl("not_a_url")).rejects.toThrow("Invalid URL: not_a_url");
  });

  it("rejects non-http/https protocols", async () => {
    await expect(fetchUrl("ftp://example.com")).rejects.toThrow('Blocked: unsupported protocol "ftp:"');
  });

  it("rejects localhost", async () => {
    await expect(fetchUrl("http://localhost")).rejects.toThrow("Blocked: requests to localhost are not allowed.");
    await expect(fetchUrl("http://LOCALHOST/foo")).rejects.toThrow("Blocked: requests to localhost are not allowed.");
  });

  it("rejects private IPv4 addresses directly", async () => {
    await expect(fetchUrl("http://127.0.0.1")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://10.0.0.1")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://192.168.1.100")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://169.254.169.254")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://172.16.0.1")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://100.64.0.5")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://224.0.0.1")).rejects.toThrow("resolves to a private, loopback, or link-local address");
  });

  it("rejects private IPv6 addresses directly", async () => {
    await expect(fetchUrl("http://[::1]")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://[::]")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://[fe80::1]")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://[fc00::1]")).rejects.toThrow("resolves to a private, loopback, or link-local address");
    await expect(fetchUrl("http://[::ffff:127.0.0.1]")).rejects.toThrow("resolves to a private, loopback, or link-local address");
  });

  it("rejects malformed IP inputs as unsafe via URL parser throwing", async () => {
    await expect(fetchUrl("http://999.999.999.999")).rejects.toThrow("Invalid URL: http://999.999.999.999");
  });

  it("rejects if DNS resolution fails", async () => {
    dns.lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(fetchUrl("http://does-not-exist.example")).rejects.toThrow('Could not resolve host "does-not-exist.example"');
  });

  it("rejects if host resolves to private IP", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "10.0.0.5" }]);
    await expect(fetchUrl("http://private-dns.example")).rejects.toThrow("resolves to a private, loopback, or link-local address");
  });

  it("succeeds with safe host and URL", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (name) => {
          if (name === "content-type") return "text/plain";
          return null;
        },
      },
      text: async () => "Hello safe world",
    });

    const res = await fetchUrl("http://example.com/foo");
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.text).toBe("Hello safe world");
  });

  it("handles body format correctly (string vs object)", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: () => "text/plain" },
      text: async () => "posted",
    });

    await fetchUrl("http://example.com", { method: "POST", body: { foo: "bar" } });
    expect(undiciFetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ foo: "bar" }),
      })
    );
  });

  it("handles manual redirects up to MAX_REDIRECTS", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    // 1st fetch: redirect to /two
    undiciFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: {
        get: (name) => {
          if (name === "location") return "http://example.com/two";
          return null;
        },
      },
    });
    // 2nd fetch: redirect to /three
    undiciFetch.mockResolvedValueOnce({
      status: 301,
      ok: false,
      headers: {
        get: (name) => {
          if (name === "location") return "http://example.com/three";
          return null;
        },
      },
    });
    // 3rd fetch: final 200 OK
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (name) => (name === "content-type" ? "text/html" : null),
      },
      text: async () => "<h1>Success</h1>",
    });

    const res = await fetchUrl("http://example.com/one");
    expect(res.status).toBe(200);
    expect(res.text).toBe("<h1>Success</h1>");
    expect(undiciFetch).toHaveBeenCalledTimes(3);
  });

  it("aborts redirect loop and throws error after MAX_REDIRECTS", async () => {
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValue({
      status: 302,
      headers: {
        get: (name) => (name === "location" ? "http://example.com/loop" : null),
      },
    });

    await expect(fetchUrl("http://example.com/loop")).rejects.toThrow("Too many redirects");
  });

  it("handles redirect with no Location header", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: {
        get: (name) => (name === "content-type" ? "text/plain" : null),
      },
      text: async () => "Moved but no location header",
    });

    const res = await fetchUrl("http://example.com");
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
    expect(res.text).toBe("Moved but no location header");
  });
});

describe("Fetch Connector - web_fetch tool", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    register(server);
  });

  it("returns stripped HTML when response is HTML", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (name) => (name === "content-type" ? "text/html; charset=utf-8" : null),
      },
      text: async () => "<div><p>Hello HTML</p></div>",
    });

    const result = await server.tools.web_fetch({ url: "http://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("Hello HTML");
    expect(result.content[0].text).not.toContain("<div>");
  });

  it("returns raw HTML when raw_html = true", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (name) => (name === "content-type" ? "text/html; charset=utf-8" : null),
      },
      text: async () => "<div><p>Hello HTML</p></div>",
    });

    const result = await server.tools.web_fetch({ url: "http://example.com", raw_html: true });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("<div><p>Hello HTML</p></div>");
  });

  it("pretty prints JSON response", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (name) => (name === "content-type" ? "application/json" : null),
      },
      text: async () => '{"foo":"bar"}',
    });

    const result = await server.tools.web_fetch({ url: "http://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('"foo": "bar"');
  });

  it("falls back to raw text if JSON is invalid", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (name) => (name === "content-type" ? "application/json" : null),
      },
      text: async () => '{"foo": invalid-json',
    });

    const result = await server.tools.web_fetch({ url: "http://example.com" });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('{"foo": invalid-json');
  });

  it("truncates response to max_chars", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (name) => (name === "content-type" ? "text/plain" : null),
      },
      text: async () => "abcdefghij",
    });

    const result = await server.tools.web_fetch({ url: "http://example.com", max_chars: 5 });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("abcde\n\n[... truncated at 5 chars");
  });

  it("signals isError = true for non-2xx responses", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    undiciFetch.mockResolvedValueOnce({
      status: 404,
      ok: false,
      headers: {
        get: (name) => (name === "content-type" ? "text/plain" : null),
      },
      text: async () => "Not Found",
    });

    const result = await server.tools.web_fetch({ url: "http://example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("⚠️ Non-2xx response");
    expect(result.content[0].text).toContain("Not Found");
  });
});
