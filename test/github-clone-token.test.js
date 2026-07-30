// ---------------------------------------------------------------------------
// test/github-clone-token.test.js
//
// Direct unit coverage for connectors/github/clone_token.js (the
// get_repo_clone_token tool), previously untested. Covers:
//   - default owner substitution (DEFAULT_OWNER from config.js)
//   - the exact git-clone URL / command format returned to the caller
//   - error passthrough when getCloneToken() rejects (e.g. App not
//     configured, App not installed on the repo, GitHub API rejection)
//   - that the tool never leaks the raw token outside the embedded clone
//     URL (no separate "here's your token" field)
//
// getCloneToken (connectors/github/app_auth.js) is mocked -- this is a
// handler unit test, not a live-network test. See github-app-auth.test.js
// for direct coverage of getCloneToken/mintInstallationToken/revoke itself.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({ DEFAULT_OWNER: "allocsys" }));

vi.mock("../connectors/github/app_auth.js", () => ({
  getCloneToken: vi.fn(),
}));

import { getCloneToken } from "../connectors/github/app_auth.js";
import { register } from "../connectors/github/clone_token.js";

// Minimal fake MCP server: just captures the handler function for the
// registered tool name so tests can call it directly.
function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("connectors/github/clone_token.js", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    register(server);
  });

  it("mints via getCloneToken using the explicit owner and repo", async () => {
    getCloneToken.mockResolvedValueOnce({ token: "ghs_abc123", expiresAt: "2026-08-01T00:00:00Z" });

    await server.tools.get_repo_clone_token({ owner: "someorg", repo: "widgets" });

    expect(getCloneToken).toHaveBeenCalledWith("someorg", "widgets");
  });

  it("falls back to DEFAULT_OWNER when owner is omitted", async () => {
    getCloneToken.mockResolvedValueOnce({ token: "ghs_abc123", expiresAt: "2026-08-01T00:00:00Z" });

    await server.tools.get_repo_clone_token({ repo: "widgets" });

    expect(getCloneToken).toHaveBeenCalledWith("allocsys", "widgets");
  });

  it("returns a git clone command with the token embedded as x-access-token", async () => {
    getCloneToken.mockResolvedValueOnce({ token: "ghs_abc123", expiresAt: "2026-08-01T00:00:00Z" });

    const result = await server.tools.get_repo_clone_token({ owner: "someorg", repo: "widgets" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(
      "git clone https://x-access-token:ghs_abc123@github.com/someorg/widgets.git"
    );
  });

  it("surfaces the GitHub-issued expiry in the response text", async () => {
    getCloneToken.mockResolvedValueOnce({ token: "ghs_abc123", expiresAt: "2026-08-01T12:34:56Z" });

    const result = await server.tools.get_repo_clone_token({ owner: "someorg", repo: "widgets" });

    expect(result.content[0].text).toContain("2026-08-01T12:34:56Z");
  });

  it("does not emit the raw token anywhere outside the embedded clone URL", async () => {
    getCloneToken.mockResolvedValueOnce({ token: "ghs_abc123", expiresAt: "2026-08-01T00:00:00Z" });

    const result = await server.tools.get_repo_clone_token({ owner: "someorg", repo: "widgets" });

    const text = result.content[0].text;
    const occurrences = text.split("ghs_abc123").length - 1;
    expect(occurrences).toBe(1);
  });

  it("returns an error result (not a throw) when getCloneToken rejects with a config error", async () => {
    getCloneToken.mockRejectedValueOnce(
      new Error("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not configured -- private-repo clone tokens are unavailable.")
    );

    const result = await server.tools.get_repo_clone_token({ owner: "someorg", repo: "widgets" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not configured/);
  });

  it("returns an error result (not a throw) when GitHub rejects the mint call", async () => {
    getCloneToken.mockRejectedValueOnce(
      new Error("Failed to mint installation token for someorg/widgets (404): Not Found")
    );

    const result = await server.tools.get_repo_clone_token({ owner: "someorg", repo: "widgets" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to mint installation token for someorg\/widgets \(404\)/);
  });

  it("does not call getCloneToken again after a failure (each call is a fresh, independent mint)", async () => {
    getCloneToken.mockRejectedValueOnce(new Error("boom"));

    await server.tools.get_repo_clone_token({ owner: "someorg", repo: "widgets" });

    expect(getCloneToken).toHaveBeenCalledTimes(1);
  });
});
