import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  githubGraphQL: vi.fn(),
}));

import { githubRequest, githubGraphQL } from "../connectors/github/client.js";
import { register as registerPRWrite } from "../connectors/github/pr_write.js";
import { DEFAULT_OWNER } from "../config.js";

function makeFakeServer() {
  const tools = {};
  return { tool: (name, _d, _s, handler) => { tools[name] = handler; }, tools };
}

describe("pr_write", () => {
  let server;
  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    registerPRWrite(server);
  });

  it("registers a single pr_write tool and none of the old names", () => {
    expect(Object.keys(server.tools)).toEqual(["pr_write"]);
  });

  describe("validation", () => {
    it("requires repo for every action", async () => {
      const r = await server.tools.pr_write({ action: "merge", owner: "o", pull_number: 1 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires repo");
    });

    it.each(["create", "update", "merge", "review"])("requires owner for %s (no default)", async (action) => {
      const r = await server.tools.pr_write({ action, repo: "r", pull_number: 1 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires owner");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it.each(["update", "merge", "review", "request_reviewers", "remove_reviewers", "inline_comment"])("requires pull_number for %s", async (action) => {
      const r = await server.tools.pr_write({ action, owner: "o", repo: "r" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires pull_number");
    });

    it("create requires title, head and base", async () => {
      for (const missing of ["title", "head", "base"]) {
        const args = { action: "create", owner: "o", repo: "r", title: "t", head: "h", base: "b" };
        delete args[missing];
        const r = await server.tools.pr_write(args);
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain(missing);
      }
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("review requires event", async () => {
      const r = await server.tools.pr_write({ action: "review", owner: "o", repo: "r", pull_number: 1 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires event");
    });

    it.each(["commit_id", "path", "line", "body"])("inline_comment requires %s", async (missing) => {
      const args = { action: "inline_comment", repo: "r", pull_number: 1, commit_id: "abc", path: "a.js", line: 3, body: "x" };
      delete args[missing];
      const r = await server.tools.pr_write(args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(missing);
      expect(githubRequest).not.toHaveBeenCalled();
    });
  });

  describe("defaults", () => {
    it("create sends draft: false when omitted", async () => {
      githubRequest.mockResolvedValueOnce({ number: 1, title: "t", html_url: "u" });
      await server.tools.pr_write({ action: "create", owner: "o", repo: "r", title: "t", head: "h", base: "b" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/pulls", {
        method: "POST",
        body: { title: "t", head: "h", base: "b", body: undefined, draft: false },
      });
    });

    it("merge sends merge_method 'merge' when omitted", async () => {
      githubRequest.mockResolvedValueOnce({ message: "ok", sha: undefined });
      const r = await server.tools.pr_write({ action: "merge", owner: "o", repo: "r", pull_number: 7 });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/pulls/7/merge", {
        method: "PUT",
        body: { merge_method: "merge", commit_title: undefined, commit_message: undefined },
      });
      expect(r.content[0].text).toContain("Commit: n/a");
    });

    it.each([
      ["request_reviewers", { reviewers: ["a"] }],
      ["remove_reviewers", { reviewers: ["a"] }],
      ["inline_comment", { commit_id: "c", path: "p", line: 1, body: "b" }],
    ])("%s defaults owner to DEFAULT_OWNER", async (action, extra) => {
      githubRequest.mockResolvedValueOnce({ html_url: "u" });
      await server.tools.pr_write({ action, repo: "r", pull_number: 3, ...extra });
      expect(githubRequest.mock.calls[0][0]).toContain(`/repos/${DEFAULT_OWNER}/r/pulls/3/`);
    });
  });

  describe("update", () => {
    it("runs the PATCH first, then the GraphQL ready conversion, in one call", async () => {
      githubRequest
        .mockResolvedValueOnce({ html_url: "https://x/pull/9" })
        .mockResolvedValueOnce({ node_id: "N", draft: true });
      githubGraphQL.mockResolvedValueOnce({});
      const r = await server.tools.pr_write({ action: "update", owner: "o", repo: "r", pull_number: 9, ready: true, title: "T" });
      expect(githubGraphQL).toHaveBeenCalledTimes(1);
      expect(githubRequest).toHaveBeenNthCalledWith(1, "/repos/o/r/pulls/9", { method: "PATCH", body: { title: "T" } });
      expect(r.content[0].text).toContain("converted from draft to ready for review.");
      expect(r.content[0].text).toContain("Updated PR #9 (title).");
      expect(r.content[0].text.indexOf("converted from draft")).toBeLessThan(r.content[0].text.indexOf("Updated PR #9"));
    });

    it("does not convert to ready when the PATCH fails", async () => {
      githubRequest.mockRejectedValueOnce(new Error("422 bad base"));
      await expect(server.tools.pr_write({ action: "update", owner: "o", repo: "r", pull_number: 9, ready: true, base: "nope" }))
        .rejects.toThrow("422 bad base");
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(githubGraphQL).not.toHaveBeenCalled();
    });

    it("reports the applied PATCH when the ready conversion then fails", async () => {
      githubRequest
        .mockResolvedValueOnce({ html_url: "https://x/pull/9" })
        .mockResolvedValueOnce({ node_id: "N", draft: true });
      githubGraphQL.mockRejectedValueOnce(new Error("graphql boom"));
      await expect(server.tools.pr_write({ action: "update", owner: "o", repo: "r", pull_number: 9, ready: true, title: "T" }))
        .rejects.toThrow(/Updated PR #9 \(title\)\.[\s\S]*converting the PR to ready for review failed: graphql boom/);
    });

    it("ready: true alone on a non-draft PR makes no PATCH and says so", async () => {
      githubRequest.mockResolvedValueOnce({ node_id: "N", draft: false });
      const r = await server.tools.pr_write({ action: "update", owner: "o", repo: "r", pull_number: 9, ready: true });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(githubGraphQL).not.toHaveBeenCalled();
      expect(r.content[0].text).toContain("already ready for review");
    });

    it("ready: false alone makes no requests and explains it is a no-op", async () => {
      const r = await server.tools.pr_write({ action: "update", owner: "o", repo: "r", pull_number: 9, ready: false });
      expect(githubRequest).not.toHaveBeenCalled();
      expect(githubGraphQL).not.toHaveBeenCalled();
      expect(r.content[0].text).toContain("ready: false is a no-op");
    });

    it("an empty-string body is still sent (replaces description)", async () => {
      githubRequest.mockResolvedValueOnce({ html_url: "u" });
      await server.tools.pr_write({ action: "update", owner: "o", repo: "r", pull_number: 9, body: "" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/pulls/9", { method: "PATCH", body: { body: "" } });
    });
  });

  describe("request_reviewers / remove_reviewers", () => {
    it("request_reviewers POSTs and lists the resulting reviewers and teams", async () => {
      githubRequest.mockResolvedValueOnce({
        requested_reviewers: [{ login: "alice" }, { login: "bob" }],
        requested_teams: [{ slug: "platform" }],
      });
      const r = await server.tools.pr_write({ action: "request_reviewers", owner: "o", repo: "r", pull_number: 5, reviewers: ["alice", "bob"], team_reviewers: ["platform"] });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/pulls/5/requested_reviewers", {
        method: "POST",
        body: { reviewers: ["alice", "bob"], team_reviewers: ["platform"] },
      });
      expect(r.content[0].text).toBe("Requested review on PR #5.\nReviewers: alice, bob\nTeams: platform");
    });

    it("request_reviewers omits empty arrays and shows (none)", async () => {
      githubRequest.mockResolvedValueOnce({});
      const r = await server.tools.pr_write({ action: "request_reviewers", owner: "o", repo: "r", pull_number: 5, reviewers: ["alice"], team_reviewers: [] });
      expect(githubRequest.mock.calls[0][1].body).toEqual({ reviewers: ["alice"] });
      expect(r.content[0].text).toContain("Reviewers: (none)");
      expect(r.content[0].text).toContain("Teams: (none)");
    });

    it.each(["request_reviewers", "remove_reviewers"])("%s returns an error result when neither reviewers nor team_reviewers is given", async (action) => {
      const r = await server.tools.pr_write({ action, owner: "o", repo: "r", pull_number: 5, reviewers: [] });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Provide at least one of reviewers or team_reviewers.");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("remove_reviewers DELETEs with a body and confirms", async () => {
      githubRequest.mockResolvedValueOnce({});
      const r = await server.tools.pr_write({ action: "remove_reviewers", owner: "o", repo: "r", pull_number: 5, team_reviewers: ["platform"] });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/pulls/5/requested_reviewers", {
        method: "DELETE",
        body: { team_reviewers: ["platform"] },
      });
      expect(r.content[0].text).toBe("Removed review request(s) on PR #5.");
    });
  });

  describe("inline_comment", () => {
    it("posts a single-line comment with side defaulting to RIGHT", async () => {
      githubRequest.mockResolvedValueOnce({ html_url: "https://x/c/1" });
      const r = await server.tools.pr_write({ action: "inline_comment", owner: "o", repo: "r", pull_number: 4, commit_id: "sha", path: "src/a.js", line: 12, body: "nit" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/pulls/4/comments", {
        method: "POST",
        body: { commit_id: "sha", path: "src/a.js", line: 12, side: "RIGHT", body: "nit" },
      });
      expect(r.content[0].text).toBe("Added inline comment on src/a.js:12 (PR #4).\nhttps://x/c/1");
    });

    it("multi-line comment: start_side defaults to side", async () => {
      githubRequest.mockResolvedValueOnce({ html_url: "u" });
      const r = await server.tools.pr_write({ action: "inline_comment", owner: "o", repo: "r", pull_number: 4, commit_id: "sha", path: "a.js", line: 20, start_line: 15, side: "LEFT", body: "b" });
      expect(githubRequest.mock.calls[0][1].body).toEqual({ commit_id: "sha", path: "a.js", line: 20, side: "LEFT", body: "b", start_line: 15, start_side: "LEFT" });
      expect(r.content[0].text).toContain("a.js:15-20");
    });

    it("multi-line comment: explicit start_side wins", async () => {
      githubRequest.mockResolvedValueOnce({ html_url: "u" });
      await server.tools.pr_write({ action: "inline_comment", owner: "o", repo: "r", pull_number: 4, commit_id: "sha", path: "a.js", line: 20, start_line: 15, side: "RIGHT", start_side: "LEFT", body: "b" });
      expect(githubRequest.mock.calls[0][1].body.start_side).toBe("LEFT");
    });

    it("returns an error result when start_line is not less than line", async () => {
      const r = await server.tools.pr_write({ action: "inline_comment", owner: "o", repo: "r", pull_number: 4, commit_id: "sha", path: "a.js", line: 5, start_line: 5, body: "b" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("start_line must be less than line for a multi-line comment.");
      expect(githubRequest).not.toHaveBeenCalled();
    });
  });
});
