import { describe, it, expect } from "vitest";
import { pinnedLookup, pinnedDispatcher } from "../connectors/fetch/client.js";

// Regression test for the DNS-rebinding / TOCTOU fix in connectors/fetch/client.js.
//
// Before the fix, assertSafeUrl() resolved and validated a hostname, but the
// actual fetch() call re-resolved that same hostname a moment later. An
// attacker controlling DNS for the target host could serve a public IP for
// the check and a private/internal IP (e.g. a cloud metadata address) for
// the real connection, slipping straight past the SSRF guard.
//
// pinnedDispatcher() closes that gap by forcing the connection to use the
// exact address that was already validated, regardless of what a live DNS
// lookup for the hostname would return at connect time. These tests exercise
// the lookup override directly, standing in for the "attacker rebinds DNS
// between validation and connection" scenario.

describe("pinnedLookup", () => {
  it("resolves to the pinned address, ignoring the hostname passed in (single-address callback form)", () => {
    const lookup = pinnedLookup("93.184.216.34"); // pretend this was the validated public IP

    let result;
    // Simulate an attacker's DNS now answering with an internal/metadata
    // address for the same hostname -- the override must NOT consult that.
    lookup("attacker-controlled-host.example", {}, (err, address, family) => {
      result = { err, address, family };
    });

    expect(result.err).toBeNull();
    expect(result.address).toBe("93.184.216.34"); // still the pinned address, not a rebound one
    expect(result.family).toBe(4);
  });

  it("resolves to the pinned address in the { all: true } callback form used by Happy Eyeballs", () => {
    const lookup = pinnedLookup("93.184.216.34");

    let result;
    lookup("attacker-controlled-host.example", { all: true }, (err, addresses) => {
      result = { err, addresses };
    });

    expect(result.err).toBeNull();
    expect(result.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("pins IPv6 addresses correctly", () => {
    const lookup = pinnedLookup("2606:2800:220:1:248:1893:25c8:1946");

    let result;
    lookup("attacker-controlled-host.example", {}, (err, address, family) => {
      result = { err, address, family };
    });

    expect(result.err).toBeNull();
    expect(result.address).toBe("2606:2800:220:1:248:1893:25c8:1946");
    expect(result.family).toBe(6);
  });
});

describe("pinnedDispatcher", () => {
  it("returns a usable undici Agent instance", () => {
    const dispatcher = pinnedDispatcher("93.184.216.34");
    expect(typeof dispatcher.dispatch).toBe("function");
    expect(typeof dispatcher.close).toBe("function");
  });
});
