import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock connectors/github/client.js (code_search.js, imported by repo_inspect.js,
// also pulls githubGraphQL / githubFetchTarball from here).
vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  githubGraphQL: vi.fn(),
  githubFetchTarball: vi.fn(),
  fromBase64: (s) => Buffer.from(s, "base64").toString("utf-8"),
}));

import { githubRequest } from "../connectors/github/client.js";
import { register as registerRepoInspect } from "../connectors/github/repo_inspect.js";

function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("GitHub Connector - repo_inspect (consolidated)", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    registerRepoInspect(server);
  });

  it("registers exactly one tool named repo_inspect", () => {
    expect(Object.keys(server.tools)).toEqual(["repo_inspect"]);
  });

  describe("parameter validation", () => {
    it("requires repo for every action", async () => {
      const result = await server.tools.repo_inspect({ action: "list_branches" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires repo");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("get_commit requires sha", async () => {
      const result = await server.tools.repo_inspect({ action: "get_commit", owner: "allocsys", repo: "madmcp" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires sha");
    });

    it("at_commit requires both path and commit", async () => {
      const result = await server.tools.repo_inspect({ action: "at_commit", repo: "madmcp", path: "a.js" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires both path and commit");
    });

    it("branch_protection requires branch", async () => {
      const result = await server.tools.repo_inspect({ action: "branch_protection", repo: "madmcp" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires branch");
    });

    it("diff explains the two accepted parameter shapes when neither is given", async () => {
      const result = await server.tools.repo_inspect({ action: "diff", repo: "madmcp" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("path + head_ref");
      expect(result.content[0].text).toContain("base_path + head_path");
    });
  });

  describe("owner requirements (match the original tools)", () => {
    it.each(["list_commits", "get_commit"])("%s requires an explicit owner", async (action) => {
      const result = await server.tools.repo_inspect({ action, repo: "madmcp", branch: "b", sha: "abc" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires owner");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("list_branches still defaults owner", async () => {
      githubRequest.mockResolvedValueOnce([]);
      await server.tools.repo_inspect({ action: "list_branches", repo: "madmcp" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/branches");
    });
  });

  describe("list_commits", () => {
    it("requires branch (as the original tool's schema did)", async () => {
      const result = await server.tools.repo_inspect({ action: "list_commits", owner: "allocsys", repo: "madmcp" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires branch");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("defaults per_page to 20 and passes sha=branch", async () => {
      githubRequest.mockResolvedValueOnce([]);
      await server.tools.repo_inspect({ action: "list_commits", owner: "allocsys", repo: "madmcp", branch: "main" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/commits?per_page=20&sha=main");
    });
  });

  describe("branch_protection", () => {
    it("reports a friendly message on 404 (no rules configured)", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Branch not protected"));
      const result = await server.tools.repo_inspect({ action: "branch_protection", repo: "madmcp", branch: "main" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Branch 'main' has no protection rules configured.");
    });

    it("reports a permission message on 403", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (403): Forbidden"));
      const result = await server.tools.repo_inspect({ action: "branch_protection", repo: "madmcp", branch: "main" });
      expect(result.content[0].text).toContain("lacks permission (403)");
    });

    it("formats protection rules", async () => {
      githubRequest.mockResolvedValueOnce({
        required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, dismiss_stale_reviews: true },
        required_status_checks: { contexts: ["verify"], strict: true },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_linear_history: { enabled: true },
      });
      const result = await server.tools.repo_inspect({ action: "branch_protection", repo: "madmcp", branch: "main" });
      const txt = result.content[0].text;
      expect(txt).toContain("Required approving reviews: 2 (code owner review required)");
      expect(txt).toContain("Required status checks: verify");
      expect(txt).toContain("Enforce for admins: yes");
      expect(txt).toContain("Allow force pushes: no");
    });
  });

  describe("at_commit", () => {
    it("reads a file as it existed at a commit", async () => {
      githubRequest
        .mockResolvedValueOnce({ commit: { tree: { sha: "treesha" }, author: { date: "2026-08-01T00:00:00Z" } } })
        .mockResolvedValueOnce({ tree: [{ path: "a.js", type: "blob", sha: "blobsha" }] })
        .mockResolvedValueOnce({ content: Buffer.from("hello").toString("base64") });

      const result = await server.tools.repo_inspect({ action: "at_commit", repo: "madmcp", path: "a.js", commit: "abcdef1234567" });
      expect(result.content[0].text).toContain("[a.js @ abcdef1 | 2026-08-01 | 5 chars]");
      expect(result.content[0].text).toContain("hello");
    });

    it("errors when the file does not exist at that commit", async () => {
      githubRequest
        .mockResolvedValueOnce({ commit: { tree: { sha: "treesha" }, author: { date: "2026-08-01T00:00:00Z" } } })
        .mockResolvedValueOnce({ tree: [] });

      const result = await server.tools.repo_inspect({ action: "at_commit", repo: "madmcp", path: "missing.js", commit: "abcdef1234567" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("File not found at commit abcdef1");
    });
  });
});
