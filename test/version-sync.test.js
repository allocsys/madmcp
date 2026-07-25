import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("version sync", () => {
  it("keeps server.js's reported version in sync with package.json (found drifted 2026-07-25: package.json said 2.0.0, server.js said 2.1.0)", () => {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
    const serverSrc = readFileSync(path.join(rootDir, "server.js"), "utf8");

    // server.js reports its version in two places -- the McpServer
    // constructor and the startup console.log -- both must match
    // package.json exactly, not just each other, so a future bump to one
    // and not the other (or to server.js but not package.json) fails CI
    // immediately instead of silently drifting again.
    const mcpServerMatch = serverSrc.match(/new McpServer\(\{[^}]*version:\s*"([^"]+)"/s);
    const logMatch = serverSrc.match(/manufact-mcp-server v([\d.]+) listening/);

    expect(mcpServerMatch, "Could not find McpServer({ version: \"...\" }) in server.js -- update this test's regex if that constructor call changed shape.").not.toBeNull();
    expect(logMatch, "Could not find the 'manufact-mcp-server vX.Y.Z listening' startup log in server.js -- update this test's regex if that message changed.").not.toBeNull();

    expect(mcpServerMatch[1]).toBe(pkg.version);
    expect(logMatch[1]).toBe(pkg.version);
  });
});
