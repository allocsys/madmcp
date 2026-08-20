// ---------------------------------------------------------------------------
// test/github-codespaces.test.js
//
// Direct unit coverage for connectors/github/codespaces.js: list_codespaces,
// get_codespace, list_codespace_machines, create_codespace, start_codespace,
// stop_codespace, delete_codespace.
//
// githubRequest is mocked -- this is a handler unit test, not a live-network
// test (see mcp-integration.test.js / server-e2e.test.js for tests that go
// through the real MCP/HTTP stack).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

import { githubRequest } from "../connectors/github/client.js";
import { register } from "../connectors/github/codespaces.js";

// Minimal fake MCP server: just captures the handler function for each
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

describe("connectors/github/codespaces.js", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    register(server);
  });

  describe("list_codespaces", () => {
    it("lists codespaces across all repos when no repo is given", async () => {
      githubRequest.mockResolvedValueOnce({
        total_count: 1,
        codespaces: [{
          name: "curly-fiesta-abc123",
          state: "Available",
          repository: { full_name: "allocsys/madmcp" },
          git_status: { ref: "main" },
          machine: { display_name: "2-core" },
          web_url: "https://github.com/codespaces/curly-fiesta-abc123",
        }],
      });

      const result = await server.tools.list_codespaces({});

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces");
      expect(result.content[0].text).toMatch(/1 codespace\(s\)/);
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123/);
    });

    it("scopes to a repo via repository_id, defaulting owner", async () => {
      githubRequest
        .mockResolvedValueOnce({ id: 4242 })
        .mockResolvedValueOnce({ total_count: 0, codespaces: [] });

      const result = await server.tools.list_codespaces({ repo: "madmcp" });

      expect(githubRequest).toHaveBeenNthCalledWith(1, "/repos/allocsys/madmcp");
      expect(githubRequest).toHaveBeenNthCalledWith(2, "/user/codespaces?repository_id=4242");
      expect(result.content[0].text).toMatch(/No codespaces found for allocsys\/madmcp/);
    });

    it("reports no codespaces found when the list is empty (no repo scope)", async () => {
      githubRequest.mockResolvedValueOnce({ total_count: 0, codespaces: [] });

      const result = await server.tools.list_codespaces({});

      expect(result.content[0].text).toBe("No codespaces found.");
    });
  });

  describe("get_codespace", () => {
    it("returns formatted details for a codespace", async () => {
      githubRequest.mockResolvedValueOnce({
        name: "curly-fiesta-abc123",
        state: "Available",
        repository: { full_name: "allocsys/madmcp" },
        git_status: { ref: "main" },
        machine: { display_name: "2-core" },
        created_at: "2026-08-01T00:00:00Z",
        last_used_at: "2026-08-20T00:00:00Z",
        web_url: "https://github.com/codespaces/curly-fiesta-abc123",
      });

      const result = await server.tools.get_codespace({ codespace_name: "curly-fiesta-abc123" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123");
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123 \[Available\]/);
      expect(result.content[0].text).toMatch(/allocsys\/madmcp@main/);
    });

    it("surfaces a 404 when the codespace doesn't exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(server.tools.get_codespace({ codespace_name: "does-not-exist" }))
        .rejects.toThrow(/404/);
    });
  });

  describe("list_codespace_machines", () => {
    it("lists available machine types for a repo", async () => {
      githubRequest.mockResolvedValueOnce({
        machines: [{
          name: "basicLinux32gb",
          display_name: "2 cores, 8 GB RAM, 32 GB storage",
          cpus: 2,
          memory_in_bytes: 8 * 1024 * 1024 * 1024,
          storage_in_bytes: 32 * 1024 * 1024 * 1024,
          prebuild_availability: "ready",
        }],
      });

      const result = await server.tools.list_codespace_machines({ repo: "madmcp" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/codespaces/machines");
      expect(result.content[0].text).toMatch(/basicLinux32gb/);
      expect(result.content[0].text).toMatch(/2 vCPU, 8GB RAM, 32GB storage/);
      expect(result.content[0].text).toMatch(/\[prebuild: ready\]/);
    });

    it("appends ref as a query param when given", async () => {
      githubRequest.mockResolvedValueOnce({ machines: [] });

      const result = await server.tools.list_codespace_machines({ repo: "madmcp", ref: "feature-x" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/codespaces/machines?ref=feature-x");
      expect(result.content[0].text).toMatch(/No available machine types for allocsys\/madmcp@feature-x/);
    });

    it("uses the given owner instead of the default", async () => {
      githubRequest.mockResolvedValueOnce({ machines: [] });

      await server.tools.list_codespace_machines({ owner: "someoneelse", repo: "theirrepo" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/someoneelse/theirrepo/codespaces/machines");
    });
  });

  describe("create_codespace", () => {
    it("sends only the params that were actually passed (no undefined keys)", async () => {
      githubRequest.mockResolvedValueOnce({
        name: "new-codespace-xyz",
        state: "Provisioning",
        web_url: "https://github.com/codespaces/new-codespace-xyz",
      });

      const result = await server.tools.create_codespace({ repo: "madmcp" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/codespaces", {
        method: "POST",
        body: {},
      });
      expect(result.content[0].text).toMatch(/Created codespace: new-codespace-xyz \[Provisioning\]/);
    });

    it("includes ref, machine, and devcontainer_path when provided", async () => {
      githubRequest.mockResolvedValueOnce({
        name: "new-codespace-xyz",
        state: "Provisioning",
        web_url: "https://github.com/codespaces/new-codespace-xyz",
      });

      await server.tools.create_codespace({
        repo: "madmcp",
        ref: "feature-x",
        machine: "basicLinux32gb",
        devcontainer_path: ".devcontainer/custom.json",
      });

      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/codespaces", {
        method: "POST",
        body: {
          ref: "feature-x",
          machine: "basicLinux32gb",
          devcontainer_path: ".devcontainer/custom.json",
        },
      });
    });

    it("uses the given owner instead of the default", async () => {
      githubRequest.mockResolvedValueOnce({
        name: "new-codespace-xyz", state: "Provisioning", web_url: "https://x",
      });

      await server.tools.create_codespace({ owner: "someoneelse", repo: "theirrepo" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/someoneelse/theirrepo/codespaces", {
        method: "POST",
        body: {},
      });
    });
  });

  describe("start_codespace", () => {
    it("starts a codespace and reports its new state", async () => {
      githubRequest.mockResolvedValueOnce({ name: "curly-fiesta-abc123", state: "Starting" });

      const result = await server.tools.start_codespace({ codespace_name: "curly-fiesta-abc123" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123/start", { method: "POST" });
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123 — state: Starting/);
    });
  });

  describe("stop_codespace", () => {
    it("stops a codespace and reports its new state", async () => {
      githubRequest.mockResolvedValueOnce({ name: "curly-fiesta-abc123", state: "Shutdown" });

      const result = await server.tools.stop_codespace({ codespace_name: "curly-fiesta-abc123" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123/stop", { method: "POST" });
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123 — state: Shutdown/);
    });
  });

  describe("delete_codespace", () => {
    it("deletes a codespace and returns a confirmation", async () => {
      githubRequest.mockResolvedValueOnce({});

      const result = await server.tools.delete_codespace({ codespace_name: "curly-fiesta-abc123" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123", { method: "DELETE" });
      expect(result.content[0].text).toMatch(/🗑️ Deleted codespace curly-fiesta-abc123 permanently\./);
    });

    it("propagates the error when the codespace doesn't exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(server.tools.delete_codespace({ codespace_name: "does-not-exist" }))
        .rejects.toThrow(/404/);
    });
  });
});
