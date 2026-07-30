// ---------------------------------------------------------------------------
// test/github-app-auth.test.js
//
// Direct unit coverage for connectors/github/app_auth.js, previously
// untested. Covers:
//   - buildAppJwt's RS256 signing (verified against a real keypair, both
//     literal-PEM and \n-escaped-PEM env var forms)
//   - mintInstallationToken's request shape and config-missing errors
//   - getCloneToken's waitUntil-scheduled revoke (the single-use guard) --
//     including the best-effort failure handling in revokeInstallationToken
//
// config.js and @vercel/functions are mocked -- this is a handler unit
// test, not a live-network test. config.js values vary per test (to cover
// the "not configured" error paths), so it's re-mocked via vi.doMock +
// vi.resetModules + dynamic import per test group rather than a single
// static vi.mock like the other test files use.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function base64urlToBuffer(input) {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeJwt(jwt) {
  const [headerB64, payloadB64, sigB64] = jwt.split(".");
  return {
    header: JSON.parse(base64urlToBuffer(headerB64).toString("utf-8")),
    payload: JSON.parse(base64urlToBuffer(payloadB64).toString("utf-8")),
    signingInput: `${headerB64}.${payloadB64}`,
    signature: base64urlToBuffer(sigB64),
  };
}

function verifyJwtSignature(jwt, pubKey) {
  const { signingInput, signature } = decodeJwt(jwt);
  return crypto.createVerify("RSA-SHA256").update(signingInput).verify(pubKey, signature);
}

const BASE_CONFIG = {
  GITHUB_API: "https://api.github.com",
  GITHUB_APP_ID: "app-123",
  GITHUB_APP_INSTALLATION_ID: "install-456",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS: 5,
};

async function loadAppAuth(configOverrides = {}) {
  vi.resetModules();
  vi.doMock("../config.js", () => ({ ...BASE_CONFIG, ...configOverrides }));
  return import("../connectors/github/app_auth.js");
}

function mintOk(overrides = {}) {
  return {
    ok: true,
    status: 201,
    json: () => Promise.resolve({ token: "ghs_minted-token", expires_at: "2026-08-01T00:00:00Z", ...overrides }),
  };
}

describe("connectors/github/app_auth.js", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("buildAppJwt (via getCloneToken's mint call)", () => {
    it("signs a well-formed RS256 App JWT and sends it as the mint call's Bearer token", async () => {
      global.fetch.mockResolvedValueOnce(mintOk());
      const { getCloneToken } = await loadAppAuth();

      await getCloneToken("acme", "widgets");

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe("https://api.github.com/app/installations/install-456/access_tokens");
      expect(opts.method).toBe("POST");

      const jwt = opts.headers.Authorization.replace(/^Bearer /, "");
      const { header, payload } = decodeJwt(jwt);

      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(payload.iss).toBe("app-123");
      // iat backdated 60s for clock skew; exp = iat + 600 (540s TTL + the 60s backdate)
      expect(payload.exp - payload.iat).toBe(600);
      const now = Math.floor(Date.now() / 1000);
      expect(payload.iat).toBeLessThanOrEqual(now - 59);
      expect(payload.exp).toBeLessThanOrEqual(now + 541);

      expect(verifyJwtSignature(jwt, publicKey)).toBe(true);
    });

    it("still produces a validly signed JWT when the private key is \\n-escaped (env-var-safe form)", async () => {
      global.fetch.mockResolvedValueOnce(mintOk());
      const escapedKey = privateKey.replace(/\n/g, "\\n");
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_PRIVATE_KEY: escapedKey });

      await getCloneToken("acme", "widgets");

      const jwt = global.fetch.mock.calls[0][1].headers.Authorization.replace(/^Bearer /, "");
      expect(verifyJwtSignature(jwt, publicKey)).toBe(true);
    });

    it("throws a configuration error and never calls fetch when GITHUB_APP_ID is missing", async () => {
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_ID: undefined });
      await expect(getCloneToken("acme", "widgets")).rejects.toThrow(
        /GITHUB_APP_ID \/ GITHUB_APP_PRIVATE_KEY not configured/
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("throws a configuration error and never calls fetch when GITHUB_APP_PRIVATE_KEY is missing", async () => {
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_PRIVATE_KEY: undefined });
      await expect(getCloneToken("acme", "widgets")).rejects.toThrow(
        /GITHUB_APP_ID \/ GITHUB_APP_PRIVATE_KEY not configured/
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("mintInstallationToken", () => {
    it("throws a configuration error and never calls fetch when GITHUB_APP_INSTALLATION_ID is missing", async () => {
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_INSTALLATION_ID: undefined });
      await expect(getCloneToken("acme", "widgets")).rejects.toThrow(
        /GITHUB_APP_INSTALLATION_ID not configured/
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("scopes the mint request to exactly the one repo, contents:read only", async () => {
      global.fetch.mockResolvedValueOnce(mintOk());
      const { getCloneToken } = await loadAppAuth();

      await getCloneToken("acme", "widgets");

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
    });

    it("returns the minted token and its GitHub-issued expiry", async () => {
      global.fetch.mockResolvedValueOnce(mintOk({ token: "ghs_xyz", expires_at: "2026-08-01T12:34:56Z" }));
      const { getCloneToken } = await loadAppAuth();

      const result = await getCloneToken("acme", "widgets");

      expect(result).toEqual({ token: "ghs_xyz", expiresAt: "2026-08-01T12:34:56Z" });
    });

    it("surfaces a descriptive error when GitHub rejects the mint call", async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });
      const { getCloneToken } = await loadAppAuth();

      await expect(getCloneToken("acme", "widgets")).rejects.toThrow(
        /Failed to mint installation token for acme\/widgets \(404\): Not Found/
      );
    });

    it("still reports the failure if reading the error body itself fails", async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error("body read failed")),
      });
      const { getCloneToken } = await loadAppAuth();

      await expect(getCloneToken("acme", "widgets")).rejects.toThrow(
        /Failed to mint installation token for acme\/widgets \(500\): \(no response body\)/
      );
    });
  });

  describe("getCloneToken — waitUntil-scheduled revoke (single-use guard)", () => {
    it("schedules exactly one waitUntil call, and does not block on it before returning", async () => {
      global.fetch.mockResolvedValueOnce(mintOk());
      const { getCloneToken } = await loadAppAuth();
      const { waitUntil } = await import("@vercel/functions");

      const result = await getCloneToken("acme", "widgets");

      expect(result.token).toBe("ghs_minted-token");
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    });

    it("revokes the exact minted token via DELETE /installation/token after the configured grace period", async () => {
      vi.useFakeTimers();
      global.fetch.mockResolvedValueOnce(mintOk({ token: "ghs_to-revoke" }));
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS: 5 });
      const { waitUntil } = await import("@vercel/functions");

      await getCloneToken("acme", "widgets");
      const revokePromise = waitUntil.mock.calls[0][0];

      global.fetch.mockResolvedValueOnce({ ok: true, status: 204 });
      // Not yet due -- the revoke fetch shouldn't have fired before the grace period elapses.
      await vi.advanceTimersByTimeAsync(4999);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await revokePromise;

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const [url, opts] = global.fetch.mock.calls[1];
      expect(url).toBe("https://api.github.com/installation/token");
      expect(opts.method).toBe("DELETE");
      expect(opts.headers.Authorization).toBe("Bearer ghs_to-revoke");
    });

    it("logs but does not throw when revocation fails with a real error status", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      global.fetch.mockResolvedValueOnce(mintOk());
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS: 5 });
      const { waitUntil } = await import("@vercel/functions");

      await getCloneToken("acme", "widgets");
      const revokePromise = waitUntil.mock.calls[0][0];

      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("revoke boom"),
      });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(revokePromise).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Failed to revoke clone token \(500\): revoke boom/));
    });

    it("treats 401/404 on revoke as already-invalid, not an error worth logging", async () => {
      for (const status of [401, 404]) {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        global.fetch = vi.fn().mockResolvedValueOnce(mintOk());
        const { getCloneToken } = await loadAppAuth({ GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS: 5 });
        const { waitUntil } = await import("@vercel/functions");

        await getCloneToken("acme", "widgets");
        const revokePromise = waitUntil.mock.calls[0][0];

        global.fetch.mockResolvedValueOnce({ ok: false, status, text: () => Promise.resolve("") });
        await vi.advanceTimersByTimeAsync(5000);
        await revokePromise;

        expect(errorSpy).not.toHaveBeenCalled();
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    });

    it("logs but does not throw when the revoke fetch itself rejects (network error)", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      global.fetch.mockResolvedValueOnce(mintOk());
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS: 5 });
      const { waitUntil } = await import("@vercel/functions");

      await getCloneToken("acme", "widgets");
      const revokePromise = waitUntil.mock.calls[0][0];

      global.fetch.mockRejectedValueOnce(new Error("network down"));
      await vi.advanceTimersByTimeAsync(5000);
      await expect(revokePromise).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Error revoking clone token: network down/));
    });

    it("honors an overridden grace period (e.g. the 30s default) rather than a hardcoded delay", async () => {
      vi.useFakeTimers();
      global.fetch.mockResolvedValueOnce(mintOk());
      const { getCloneToken } = await loadAppAuth({ GITHUB_APP_TOKEN_REVOKE_GRACE_SECONDS: 30 });
      const { waitUntil } = await import("@vercel/functions");

      await getCloneToken("acme", "widgets");
      const revokePromise = waitUntil.mock.calls[0][0];

      global.fetch.mockResolvedValueOnce({ ok: true, status: 204 });
      await vi.advanceTimersByTimeAsync(29999);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await revokePromise;
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
