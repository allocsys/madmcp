// ---------------------------------------------------------------------------
// test/github-codespace-manage.test.js
//
// Direct unit coverage for connectors/github/codespace_manage.js: the
// codespace_manage tool (list | get | machines | create | start | stop |
// delete). Retargeted from the former per-tool tests in
// github-codespaces.test.js.
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
import { register } from "../connectors/github/codespace_manage.js";

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

describe("connectors/github/codespace_manage.js", () => {
  let server;
  const call = (args) => server.tools.codespace_manage(args);

  beforeEach(() => {
    vi.clearAllMocks();
    githubRequest.mockReset();
    server = makeFakeServer();
    register(server);
  });

  it("registers a single codespace_manage tool and none of the old names", () => {
    expect(Object.keys(server.tools)).toEqual(["codespace_manage"]);
  });

  describe("validation", () => {
    it.each(["get", "start", "stop", "delete"])("requires codespace_name for %s", async (action) => {
      const r = await call({ action });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires codespace_name");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it.each(["machines", "create"])("requires repo for %s", async (action) => {
      const r = await call({ action, ref: "main" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires repo");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it.each(["machines", "create"])("requires ref for %s", async (action) => {
      const r = await call({ action, repo: "madmcp" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires ref");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("list needs no params", async () => {
      githubRequest.mockResolvedValueOnce({ total_count: 0, codespaces: [] });
      const r = await call({ action: "list" });
      expect(r.isError).toBeUndefined();
    });
  });

  describe("list", () => {
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

      const result = await call({ action: "list" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces?per_page=100");
      expect(result.content[0].text).toMatch(/1 codespace\(s\)/);
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123/);
      expect(result.content[0].text).not.toMatch(/showing first/);
    });

    it("notes truncation when total_count exceeds the returned page", async () => {
      const cs = { name: "cs-1", state: "Available", repository: { full_name: "allocsys/madmcp" }, git_status: { ref: "main" }, machine: null, web_url: "https://x" };
      githubRequest.mockResolvedValueOnce({ total_count: 150, codespaces: [cs] });

      const result = await call({ action: "list" });

      expect(result.content[0].text).toMatch(/showing first 1 of 150/);
    });

    it("scopes to a repo via repository_id, defaulting owner", async () => {
      githubRequest
        .mockResolvedValueOnce({ id: 4242 })
        .mockResolvedValueOnce({ total_count: 0, codespaces: [] });

      const result = await call({ action: "list", repo: "madmcp" });

      expect(githubRequest).toHaveBeenNthCalledWith(1, "/repos/allocsys/madmcp");
      expect(githubRequest).toHaveBeenNthCalledWith(2, "/user/codespaces?per_page=100&repository_id=4242");
      expect(result.content[0].text).toMatch(/No codespaces found for allocsys\/madmcp/);
    });

    it("reports no codespaces found when the list is empty (no repo scope)", async () => {
      githubRequest.mockResolvedValueOnce({ total_count: 0, codespaces: [] });

      const result = await call({ action: "list" });

      expect(result.content[0].text).toBe("No codespaces found.");
    });

    it("surfaces an insufficient-scope 403 clearly rather than swallowing it", async () => {
      githubRequest.mockRejectedValueOnce(
        new Error("GitHub API error (403): Resource not accessible by personal access token")
      );

      await expect(call({ action: "list" })).rejects.toThrow(/403/);
    });
  });

  describe("get", () => {
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

      const result = await call({ action: "get", codespace_name: "curly-fiesta-abc123" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123");
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123 \[Available\]/);
      expect(result.content[0].text).toMatch(/allocsys\/madmcp@main/);
    });

    it("surfaces a 404 when the codespace doesn't exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(call({ action: "get", codespace_name: "does-not-exist" }))
        .rejects.toThrow(/404/);
    });
  });

  describe("machines", () => {
    it("lists available machine types for a repo at a ref", async () => {
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

      const result = await call({ action: "machines", repo: "madmcp", ref: "main" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/codespaces/machines?ref=main");
      expect(result.content[0].text).toMatch(/basicLinux32gb/);
      expect(result.content[0].text).toMatch(/2 vCPU, 8GB RAM, 32GB storage/);
      expect(result.content[0].text).toMatch(/\[prebuild: ready\]/);
    });

    it("url-encodes ref in the query param", async () => {
      githubRequest.mockResolvedValueOnce({ machines: [] });

      const result = await call({ action: "machines", repo: "madmcp", ref: "feature/x" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/codespaces/machines?ref=feature%2Fx");
      expect(result.content[0].text).toMatch(/No available machine types for allocsys\/madmcp@feature\/x/);
    });

    it("uses the given owner instead of the default", async () => {
      githubRequest.mockResolvedValueOnce({ machines: [] });

      await call({ action: "machines", owner: "someoneelse", repo: "theirrepo", ref: "main" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/someoneelse/theirrepo/codespaces/machines?ref=main");
    });

    it("propagates the error when the repo doesn't exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(call({ action: "machines", repo: "does-not-exist", ref: "main" }))
        .rejects.toThrow(/404/);
    });
  });

  describe("create", () => {
    it("sends only the params that were actually passed (no undefined keys)", async () => {
      githubRequest.mockResolvedValueOnce({
        name: "new-codespace-xyz",
        state: "Provisioning",
        web_url: "https://github.com/codespaces/new-codespace-xyz",
      });

      const result = await call({ action: "create", repo: "madmcp", ref: "main" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/codespaces", {
        method: "POST",
        body: { ref: "main" },
      });
      expect(result.content[0].text).toMatch(/Created codespace: new-codespace-xyz \[Provisioning\]/);
    });

    it("includes ref, machine, and devcontainer_path when provided", async () => {
      githubRequest.mockResolvedValueOnce({
        name: "new-codespace-xyz",
        state: "Provisioning",
        web_url: "https://github.com/codespaces/new-codespace-xyz",
      });

      await call({
        action: "create",
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

      await call({ action: "create", owner: "someoneelse", repo: "theirrepo", ref: "main" });

      expect(githubRequest).toHaveBeenCalledWith("/repos/someoneelse/theirrepo/codespaces", {
        method: "POST",
        body: { ref: "main" },
      });
    });

    it("propagates the error when the requested machine type is invalid", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (422): Unprocessable Entity"));

      await expect(call({ action: "create", repo: "madmcp", ref: "main", machine: "not-a-real-machine" }))
        .rejects.toThrow(/422/);
    });
  });

  describe("start", () => {
    it("starts a codespace and reports its new state", async () => {
      githubRequest.mockResolvedValueOnce({ name: "curly-fiesta-abc123", state: "Starting" });

      const result = await call({ action: "start", codespace_name: "curly-fiesta-abc123" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123/start", { method: "POST" });
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123 — state: Starting/);
    });

    it("propagates the error when the codespace doesn't exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(call({ action: "start", codespace_name: "does-not-exist" }))
        .rejects.toThrow(/404/);
    });
  });

  describe("stop", () => {
    it("stops a codespace and reports its new state", async () => {
      githubRequest.mockResolvedValueOnce({ name: "curly-fiesta-abc123", state: "Shutdown" });

      const result = await call({ action: "stop", codespace_name: "curly-fiesta-abc123" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123/stop", { method: "POST" });
      expect(result.content[0].text).toMatch(/curly-fiesta-abc123 — state: Shutdown/);
    });

    it("propagates the error when the codespace doesn't exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(call({ action: "stop", codespace_name: "does-not-exist" }))
        .rejects.toThrow(/404/);
    });
  });

  describe("owner fallback and path encoding", () => {
    it.each(["machines", "create"])("%s treats an empty-string owner like an omitted one", async (action) => {
      githubRequest.mockResolvedValueOnce(action === "machines" ? { machines: [] } : { name: "n", state: "Provisioning", web_url: "https://x" });

      await call({ action, owner: "", repo: "madmcp", ref: "main" });

      expect(githubRequest.mock.calls[0][0]).toContain("/repos/allocsys/madmcp/codespaces");
    });

    it("url-encodes codespace_name in request paths", async () => {
      githubRequest.mockResolvedValueOnce({ name: "a/b", state: "Starting" });

      await call({ action: "start", codespace_name: "a/b" });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/a%2Fb/start", { method: "POST" });
    });
  });

  describe("delete", () => {
    it("refuses to delete without confirm: true and makes no request", async () => {
      const result = await call({ action: "delete", codespace_name: "curly-fiesta-abc123" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/NOT deleted/);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("refuses when confirm is false or a non-true value", async () => {
      const result = await call({ action: "delete", codespace_name: "curly-fiesta-abc123", confirm: false });

      expect(result.isError).toBe(true);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("deletes a codespace and returns a confirmation", async () => {
      githubRequest.mockResolvedValueOnce({});

      const result = await call({ action: "delete", codespace_name: "curly-fiesta-abc123", confirm: true });

      expect(githubRequest).toHaveBeenCalledWith("/user/codespaces/curly-fiesta-abc123", { method: "DELETE" });
      expect(result.content[0].text).toMatch(/🗑️ Deleted codespace curly-fiesta-abc123 permanently\./);
    });

    it("propagates the error when the codespace doesn't exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(call({ action: "delete", codespace_name: "does-not-exist", confirm: true }))
        .rejects.toThrow(/404/);
    });
  });
});
