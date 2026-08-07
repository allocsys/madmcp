import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock connectors/github/client.js
vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  githubGraphQL: vi.fn(),
}));

import { githubRequest, githubGraphQL } from "../connectors/github/client.js";
import { register as registerBranches } from "../connectors/github/branches.js";
import { register as registerPRs } from "../connectors/github/prs.js";

function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("GitHub Connector - Branches & Commits", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    registerBranches(server);
  });

  describe("list_branches", () => {
    it("returns formatted branch list", async () => {
      githubRequest.mockResolvedValueOnce([
        { name: "main", protected: true },
        { name: "feature-xyz", protected: false },
      ]);

      const result = await server.tools.list_branches({ repo: "madmcp" });
      expect(result.content[0].text).toBe("main (protected)\nfeature-xyz");
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/branches");
    });

    it("returns empty placeholder when no branches found", async () => {
      githubRequest.mockResolvedValueOnce([]);

      const result = await server.tools.list_branches({ repo: "madmcp" });
      expect(result.content[0].text).toBe("(no branches)");
    });
  });

  describe("create_branch", () => {
    it("creates a branch from an explicit from_branch source", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "abc123sha" } }) // get ref
        .mockResolvedValueOnce({}); // post branch ref

      const result = await server.tools.create_branch({
        owner: "allocsys",
        repo: "madmcp",
        branch: "new-feature",
        from_branch: "main",
      });

      expect(result.content[0].text).toContain("Created branch 'new-feature'");
      expect(result.content[0].text).toContain("abc123s");
      expect(githubRequest).toHaveBeenCalledTimes(2);
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp/git/ref/heads/main");
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/allocsys/madmcp/git/refs");
      expect(githubRequest.mock.calls[1][1].body).toEqual({
        ref: "refs/heads/new-feature",
        sha: "abc123sha",
      });
    });

    it("creates a branch from the repo default branch if from_branch is omitted", async () => {
      githubRequest
        .mockResolvedValueOnce({ default_branch: "develop" }) // get repo data
        .mockResolvedValueOnce({ object: { sha: "def456sha" } }) // get develop ref
        .mockResolvedValueOnce({}); // post branch ref

      const result = await server.tools.create_branch({
        owner: "allocsys",
        repo: "madmcp",
        branch: "new-feature",
      });

      expect(result.content[0].text).toContain("Created branch 'new-feature' in allocsys/madmcp from def456s");
      expect(githubRequest).toHaveBeenCalledTimes(3);
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp");
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/allocsys/madmcp/git/ref/heads/develop");
    });
  });

  describe("list_commits", () => {
    it("lists commits with formatted commit message and details", async () => {
      githubRequest.mockResolvedValueOnce([
        {
          sha: "7777777commit",
          commit: {
            message: "feat: add supercool tests\n\nwith some details",
            author: { name: "Jules", date: "2026-08-01T12:00:00Z" },
          },
        },
      ]);

      const result = await server.tools.list_commits({
        owner: "allocsys",
        repo: "madmcp",
        branch: "main",
        per_page: 5,
      });

      expect(result.content[0].text).toBe("7777777 — feat: add supercool tests (Jules, 2026-08-01)");
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/commits?per_page=5&sha=main");
    });

    it("returns placeholder when no commits found", async () => {
      githubRequest.mockResolvedValueOnce([]);

      const result = await server.tools.list_commits({
        owner: "allocsys",
        repo: "madmcp",
      });

      expect(result.content[0].text).toBe("(no commits)");
    });
  });

  describe("get_commit", () => {
    it("returns structured details of a specific commit and changed files", async () => {
      githubRequest.mockResolvedValueOnce({
        sha: "abcdef123456",
        commit: {
          author: { name: "Jules", email: "jules@alloc.sys", date: "2026-08-01T12:00:00Z" },
          message: "docs: update AGENTS.md",
        },
        files: [
          { status: "modified", filename: "AGENTS.md", additions: 5, deletions: 1 },
          { status: "added", filename: "test/ag.js", additions: 10, deletions: 0 },
        ],
      });

      const result = await server.tools.get_commit({
        owner: "allocsys",
        repo: "madmcp",
        sha: "abcdef1",
      });

      expect(result.content[0].text).toContain("Commit: abcdef1");
      expect(result.content[0].text).toContain("Author: Jules <jules@alloc.sys>");
      expect(result.content[0].text).toContain("docs: update AGENTS.md");
      expect(result.content[0].text).toContain("Files changed (2):");
      expect(result.content[0].text).toContain("  modified AGENTS.md (+5/-1)");
      expect(result.content[0].text).toContain("  added test/ag.js (+10/-0)");
    });
  });
});

describe("GitHub Connector - Pull Requests", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    registerPRs(server);
  });

  describe("get_pull_requests — list mode", () => {
    it("lists open PRs", async () => {
      githubRequest.mockResolvedValueOnce([
        {
          number: 42,
          state: "open",
          title: "Fix secondary rate limit cooldown",
          head: { label: "allocsys:fix-rate-limit" },
          base: { label: "allocsys:main" },
          user: { login: "jules" },
          created_at: "2026-08-01T12:00:00Z",
          html_url: "https://github.com/allocsys/madmcp/pull/42",
        },
      ]);

      const result = await server.tools.get_pull_requests({
        owner: "allocsys",
        repo: "madmcp",
        state: "open",
      });

      expect(result.content[0].text).toContain("#42 [open] Fix secondary rate limit cooldown");
      expect(result.content[0].text).toContain("allocsys:fix-rate-limit → allocsys:main | by jules | 2026-08-01");
      expect(result.content[0].text).toContain("https://github.com/allocsys/madmcp/pull/42");
    });

    it("lists closed and merged PRs", async () => {
      githubRequest.mockResolvedValueOnce([
        {
          number: 40,
          state: "closed",
          merged_at: "2026-07-31T12:00:00Z",
          title: "Setup Vitest",
          head: { label: "allocsys:vitest" },
          base: { label: "allocsys:main" },
          user: { login: "someone" },
          created_at: "2026-07-30T12:00:00Z",
          html_url: "https://github.com/allocsys/madmcp/pull/40",
        },
      ]);

      const result = await server.tools.get_pull_requests({
        owner: "allocsys",
        repo: "madmcp",
        state: "closed",
      });

      expect(result.content[0].text).toContain("#40 [merged] Setup Vitest");
    });

    it("returns placeholder when no PRs are found", async () => {
      githubRequest.mockResolvedValueOnce([]);

      const result = await server.tools.get_pull_requests({
        owner: "allocsys",
        repo: "madmcp",
      });

      expect(result.content[0].text).toBe("No open pull requests found.");
    });
  });

  describe("get_pull_requests — single PR detailed mode", () => {
    it("fetches single PR along with comments, reviews, and commits with signatures", async () => {
      githubRequest
        // Main PR details call
        .mockResolvedValueOnce({
          number: 42,
          state: "open",
          draft: true,
          title: "Fix rate limits",
          head: { label: "allocsys:fix-rate-limit" },
          base: { label: "allocsys:main" },
          user: { login: "jules" },
          created_at: "2026-08-01T12:00:00Z",
          html_url: "https://github.com/allocsys/madmcp/pull/42",
          body: "This PR resolves various rate limits.",
        })
        // PR conversation comments call
        .mockResolvedValueOnce([
          {
            user: { login: "reviewer1" },
            created_at: "2026-08-01T13:00:00Z",
            body: "Great changes!",
          },
        ])
        // PR reviews call
        .mockResolvedValueOnce([
          {
            user: { login: "reviewer2" },
            state: "APPROVED",
            submitted_at: "2026-08-01T14:00:00Z",
            body: "Looks perfect.",
          },
        ])
        // PR commits call
        .mockResolvedValueOnce([
          {
            sha: "aabbccddeeff",
            commit: {
              message: "fix: client throttler",
              author: { name: "Jules" },
              verification: { verified: true },
            },
          },
        ]);

      const result = await server.tools.get_pull_requests({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
      });

      const txt = result.content[0].text;
      expect(txt).toContain("#42 [open, draft] Fix rate limits");
      expect(txt).toContain("This PR resolves various rate limits.");
      expect(txt).toContain("--- 1 comment(s) ---");
      expect(txt).toContain("reviewer1 (2026-08-01 13:00):\nGreat changes!");
      expect(txt).toContain("--- 1 review(s) ---");
      expect(txt).toContain("reviewer2 — APPROVED (2026-08-01 14:00):\nLooks perfect.");
      expect(txt).toContain("--- 1 commit(s) — signature verification ---");
      expect(txt).toContain("aabbccd — ✅ Verified");
      expect(txt).toContain("fix: client throttler");
    });

    it("honors false flags to omit unwanted sections", async () => {
      githubRequest.mockResolvedValueOnce({
        number: 42,
        state: "open",
        title: "Fix rate limits",
        head: { label: "allocsys:fix" },
        base: { label: "allocsys:main" },
        user: { login: "jules" },
        created_at: "2026-08-01T12:00:00Z",
        html_url: "https://github.com/allocsys/madmcp/pull/42",
      });

      const result = await server.tools.get_pull_requests({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
        include_comments: false,
        include_reviews: false,
        include_commits: false,
      });

      const txt = result.content[0].text;
      expect(txt).toContain("#42");
      expect(txt).not.toContain("comment(s)");
      expect(txt).not.toContain("review(s)");
      expect(txt).not.toContain("commit(s)");
    });
  });

  describe("get_pr_activity", () => {
    it("fetches comments and reviews for a PR", async () => {
      githubRequest
        // comments
        .mockResolvedValueOnce([
          { user: { login: "user1" }, created_at: "2026-08-01T12:00:00Z", body: "comment text", html_url: "c-url" },
        ])
        // reviews
        .mockResolvedValueOnce([
          { user: { login: "user2" }, state: "COMMENTED", submitted_at: "2026-08-01T13:00:00Z", body: "review text", html_url: "r-url" },
        ]);

      const result = await server.tools.get_pr_activity({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
        type: "both",
      });

      const txt = result.content[0].text;
      expect(txt).toContain("user1 (2026-08-01 12:00):\ncomment text");
      expect(txt).toContain("user2 — COMMENTED (2026-08-01 13:00):\nreview text");
    });
  });

  describe("create_pull_request", () => {
    it("POSTs and returns confirmation message", async () => {
      githubRequest.mockResolvedValueOnce({
        number: 50,
        title: "New awesome branch",
        html_url: "https://github.com/allocsys/madmcp/pull/50",
      });

      const result = await server.tools.create_pull_request({
        owner: "allocsys",
        repo: "madmcp",
        title: "New awesome branch",
        head: "feature",
        base: "main",
        body: "Description",
        draft: true,
      });

      expect(result.content[0].text).toContain('Created PR #50: "New awesome branch"');
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/pulls", {
        method: "POST",
        body: { title: "New awesome branch", head: "feature", base: "main", body: "Description", draft: true },
      });
    });
  });

  describe("update_pull_request", () => {
    it("returns descriptive message if no fields are specified", async () => {
      const result = await server.tools.update_pull_request({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
      });

      expect(result.content[0].text).toContain("No fields provided to update");
    });

    it("patches the requested fields", async () => {
      githubRequest.mockResolvedValueOnce({
        html_url: "https://github.com/allocsys/madmcp/pull/42",
      });

      const result = await server.tools.update_pull_request({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
        title: "Updated Title",
        body: "Updated Body",
      });

      expect(result.content[0].text).toContain("Updated PR #42 (title, body)");
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/pulls/42", {
        method: "PATCH",
        body: { title: "Updated Title", body: "Updated Body" },
      });
    });

    it("marks draft pull request ready using GraphQL", async () => {
      githubRequest
        // PR details
        .mockResolvedValueOnce({
          node_id: "MDExOlB1bGxSZXF1ZXN0NDI=",
          draft: true,
        });

      githubGraphQL.mockResolvedValueOnce({});

      const result = await server.tools.update_pull_request({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
        ready: true,
      });

      expect(result.content[0].text).toContain("PR #42 converted from draft to ready for review");
      expect(githubGraphQL).toHaveBeenCalledWith(
        expect.stringContaining("markPullRequestReadyForReview"),
        { id: "MDExOlB1bGxSZXF1ZXN0NDI=" }
      );
    });

    it("skips draft conversion if PR is already ready for review", async () => {
      githubRequest
        .mockResolvedValueOnce({
          node_id: "MDExOlB1bGxSZXF1ZXN0NDI=",
          draft: false,
        });

      const result = await server.tools.update_pull_request({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
        ready: true,
      });

      expect(result.content[0].text).toContain("PR #42 is already ready for review");
      expect(githubGraphQL).not.toHaveBeenCalled();
    });
  });

  describe("merge_pull_request", () => {
    it("PUTs merge command and returns confirmation", async () => {
      githubRequest.mockResolvedValueOnce({
        message: "Pull Request successfully merged",
        sha: "mergecommitsha123",
      });

      const result = await server.tools.merge_pull_request({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
        merge_method: "squash",
        commit_title: "squash title",
        commit_message: "squash message",
      });

      expect(result.content[0].text).toContain("Merged PR #42: Pull Request successfully merged");
      expect(result.content[0].text).toContain("Commit: mergeco");
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/pulls/42/merge", {
        method: "PUT",
        body: { merge_method: "squash", commit_title: "squash title", commit_message: "squash message" },
      });
    });
  });

  describe("review_pull_request", () => {
    it("submits a formal review", async () => {
      githubRequest.mockResolvedValueOnce({
        id: 112233,
      });

      const result = await server.tools.review_pull_request({
        owner: "allocsys",
        repo: "madmcp",
        pull_number: 42,
        event: "APPROVE",
        body: "LGTM!",
      });

      expect(result.content[0].text).toContain("Submitted review #112233 (APPROVE) on PR #42.");
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/pulls/42/reviews", {
        method: "POST",
        body: { event: "APPROVE", body: "LGTM!" },
      });
    });
  });
});
