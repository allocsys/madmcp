import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

import { githubRequest } from "../connectors/github/client.js";
import { register as registerIssueManage } from "../connectors/github/issue_manage.js";
import { DEFAULT_OWNER } from "../config.js";

function makeFakeServer() {
  const tools = {};
  return { tool: (name, _d, _s, handler) => { tools[name] = handler; }, tools };
}

const issue = (over = {}) => ({
  number: 7, state: "open", title: "Bug", body: "Details",
  user: { login: "alice" }, created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-02T10:00:00Z",
  labels: [], assignees: [], comments: 0, html_url: "https://github.com/o/r/issues/7",
  ...over,
});

describe("issue_manage", () => {
  let server;
  beforeEach(() => {
    vi.clearAllMocks();
    githubRequest.mockReset();
    server = makeFakeServer();
    registerIssueManage(server);
  });
  const call = (args) => server.tools.issue_manage(args);

  it("registers a single issue_manage tool and none of the old names", () => {
    expect(Object.keys(server.tools)).toEqual(["issue_manage"]);
  });

  describe("validation", () => {
    it.each(["get", "list", "create", "update", "comment"])("requires repo for %s", async (action) => {
      const r = await call({ action, issue_number: 1, title: "t", body: "b" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires repo");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it.each(["get", "update", "comment"])("requires issue_number for %s", async (action) => {
      const r = await call({ action, repo: "r", body: "b" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires issue_number");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("create requires title", async () => {
      const r = await call({ action: "create", repo: "r" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires title");
    });

    it("comment requires body", async () => {
      const r = await call({ action: "comment", repo: "r", issue_number: 1 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires body");
    });

    it("search requires query", async () => {
      const r = await call({ action: "search" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires query");
    });

    it("list rejects array labels, create/update reject string labels", async () => {
      expect((await call({ action: "list", repo: "r", labels: ["a"] })).isError).toBe(true);
      expect((await call({ action: "create", repo: "r", title: "t", labels: "a,b" })).isError).toBe(true);
      expect((await call({ action: "update", repo: "r", issue_number: 1, labels: "a,b" })).isError).toBe(true);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("update rejects state 'all'", async () => {
      const r = await call({ action: "update", repo: "r", issue_number: 1, state: "all" });
      expect(r.isError).toBe(true);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("defaults owner to DEFAULT_OWNER for repo-scoped actions", async () => {
      githubRequest.mockResolvedValueOnce([]);
      await call({ action: "list", repo: "r" });
      expect(githubRequest.mock.calls[0][0]).toContain(`/repos/${DEFAULT_OWNER}/r/issues?`);
    });
  });

  describe("get", () => {
    it("formats an issue with no comments", async () => {
      githubRequest.mockResolvedValueOnce(issue());
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7 });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(r.content[0].text).toBe(
        "#7 [open] Bug\nby alice | opened 2026-08-01 | updated 2026-08-02\nlabels: none | assignees: none | comments: 0\nhttps://github.com/o/r/issues/7\n\n--- body ---\nDetails\n\n--- comments ---\n(no comments)"
      );
    });

    it("omits the comments section when include_comments is false", async () => {
      githubRequest.mockResolvedValueOnce(issue({ comments: 3 }));
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7, include_comments: false });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(r.content[0].text).not.toContain("comments ---");
    });

    it("fetches page 1 when comments fit in one page", async () => {
      githubRequest
        .mockResolvedValueOnce(issue({ comments: 2, labels: [{ name: "bug" }], assignees: [{ login: "bob" }] }))
        .mockResolvedValueOnce([{ user: { login: "c1" }, created_at: "2026-08-03T00:00:00Z", body: "hi" }, { user: { login: "c2" }, created_at: "2026-08-04T00:00:00Z", body: null }]);
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7 });
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/o/r/issues/7/comments?per_page=20&page=1");
      expect(r.content[0].text).toContain("labels: bug | assignees: bob | comments: 2");
      expect(r.content[0].text).toContain("--- comments (2 most recent of 2 shown) ---");
      expect(r.content[0].text).toContain("[c1 | 2026-08-03]\nhi");
      expect(r.content[0].text).toContain("[c2 | 2026-08-04]\n(empty)");
    });

    const cmts = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ user: { login: `c${from + i}` }, created_at: "2026-08-03T00:00:00Z", body: `b${from + i}` }));

    it("shows exactly the newest max_comments when comments exceed it (single 100-item page)", async () => {
      githubRequest
        .mockResolvedValueOnce(issue({ comments: 45 }))
        .mockResolvedValueOnce(cmts(1, 45));
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7, max_comments: 20 });
      expect(githubRequest).toHaveBeenCalledTimes(2);
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/o/r/issues/7/comments?per_page=100&page=1");
      expect(r.content[0].text).toContain("--- comments (20 most recent of 45 shown) ---");
      expect(r.content[0].text).toContain("[c26 |");
      expect(r.content[0].text).toContain("[c45 |");
      expect(r.content[0].text).not.toContain("[c25 |");
    });

    it("one comment over max_comments still shows max_comments (not 1)", async () => {
      githubRequest
        .mockResolvedValueOnce(issue({ comments: 21 }))
        .mockResolvedValueOnce(cmts(1, 21));
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7, max_comments: 20 });
      expect(r.content[0].text).toContain("--- comments (20 most recent of 21 shown) ---");
      expect(r.content[0].text).not.toContain("[c1 |");
    });

    it("fetches only the last 100-item page when the newest N sit entirely on it", async () => {
      githubRequest
        .mockResolvedValueOnce(issue({ comments: 130 }))
        .mockResolvedValueOnce(cmts(101, 130));
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7, max_comments: 30 });
      expect(githubRequest).toHaveBeenCalledTimes(2);
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/o/r/issues/7/comments?per_page=100&page=2");
      expect(r.content[0].text).toContain("(30 most recent of 130 shown)");
    });

    it("fetches two pages when the newest N straddle a 100-item boundary", async () => {
      githubRequest
        .mockResolvedValueOnce(issue({ comments: 130 }))
        .mockResolvedValueOnce(cmts(1, 100))
        .mockResolvedValueOnce(cmts(101, 130));
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7, max_comments: 50 });
      expect(githubRequest).toHaveBeenCalledTimes(3);
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/o/r/issues/7/comments?per_page=100&page=1");
      expect(githubRequest.mock.calls[2][0]).toBe("/repos/o/r/issues/7/comments?per_page=100&page=2");
      expect(r.content[0].text).toContain("(50 most recent of 130 shown)");
      expect(r.content[0].text).toContain("[c81 |");
      expect(r.content[0].text).not.toContain("[c80 |");
    });

    it("clamps max_comments to 1..100", async () => {
      githubRequest.mockResolvedValueOnce(issue({ comments: 1 })).mockResolvedValueOnce([]);
      await call({ action: "get", owner: "o", repo: "r", issue_number: 7, max_comments: 500 });
      expect(githubRequest.mock.calls[1][0]).toContain("per_page=100&page=1");
    });

    it("says so when the number is a pull request", async () => {
      githubRequest.mockResolvedValueOnce(issue({ pull_request: {} }));
      const r = await call({ action: "get", owner: "o", repo: "r", issue_number: 7 });
      expect(r.content[0].text).toContain("#7 is a pull request, not an issue");
      expect(r.content[0].text).toContain("pr_read");
      expect(r.isError).toBeUndefined();
    });
  });

  describe("list", () => {
    it("builds the query with defaults and filters PRs out", async () => {
      githubRequest.mockResolvedValueOnce([
        issue({ labels: [{ name: "bug" }], assignee: { login: "bob" } }),
        issue({ number: 8, pull_request: {} }),
      ]);
      const r = await call({ action: "list", owner: "o", repo: "r" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/issues?state=open&per_page=20");
      expect(r.content[0].text).toBe("#7 [open] Bug\n  by alice | 2026-08-01 | labels: bug | assigned: bob\n  https://github.com/o/r/issues/7");
    });

    it("passes state, labels, assignee and per_page through", async () => {
      githubRequest.mockResolvedValueOnce([]);
      const r = await call({ action: "list", owner: "o", repo: "r", state: "closed", labels: "bug,help wanted", assignee: "bob", per_page: 5 });
      const url = githubRequest.mock.calls[0][0];
      expect(url).toContain("state=closed");
      expect(url).toContain("per_page=5");
      expect(url).toContain("labels=bug%2Chelp+wanted");
      expect(url).toContain("assignee=bob");
      expect(r.content[0].text).toBe("No closed issues found.");
    });

    it("pages past a page that is all pull requests until per_page issues are found", async () => {
      githubRequest
        .mockResolvedValueOnce([issue({ number: 1, pull_request: {} }), issue({ number: 2, pull_request: {} })])
        .mockResolvedValueOnce([issue({ number: 3 }), issue({ number: 4 })]);
      const r = await call({ action: "list", owner: "o", repo: "r", per_page: 2 });
      expect(githubRequest).toHaveBeenCalledTimes(2);
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/o/r/issues?state=open&per_page=2");
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/o/r/issues?state=open&per_page=2&page=2");
      expect(r.content[0].text).toContain("#3 [open]");
      expect(r.content[0].text).toContain("#4 [open]");
    });

    it("trims to per_page when paging collects more than requested", async () => {
      githubRequest
        .mockResolvedValueOnce([issue({ number: 1 }), issue({ number: 2, pull_request: {} })])
        .mockResolvedValueOnce([issue({ number: 3 }), issue({ number: 4 })]);
      const r = await call({ action: "list", owner: "o", repo: "r", per_page: 2 });
      expect(githubRequest).toHaveBeenCalledTimes(2);
      expect(r.content[0].text).toContain("#1 [open]");
      expect(r.content[0].text).toContain("#3 [open]");
      expect(r.content[0].text).not.toContain("#4 [open]");
    });

    it("stops after 5 pages and says the scan was capped", async () => {
      githubRequest.mockResolvedValue([issue({ number: 1, pull_request: {} }), issue({ number: 2, pull_request: {} })]);
      const r = await call({ action: "list", owner: "o", repo: "r", per_page: 2 });
      expect(githubRequest).toHaveBeenCalledTimes(5);
      expect(r.content[0].text).toContain("No open issues found.");
      expect(r.content[0].text).toContain("Scanned the first 10 items only");
    });

    it("does not fetch another page when the first page is short", async () => {
      githubRequest.mockResolvedValueOnce([issue({ number: 1, pull_request: {} })]);
      const r = await call({ action: "list", owner: "o", repo: "r", per_page: 2 });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(r.content[0].text).toBe("No open issues found.");
    });
  });

  describe("create / update / comment", () => {
    it("create POSTs title/body/labels/assignees", async () => {
      githubRequest.mockResolvedValueOnce({ number: 9, title: "New", html_url: "https://x/9" });
      const r = await call({ action: "create", owner: "o", repo: "r", title: "New", body: "B", labels: ["bug"], assignees: ["bob"] });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/issues", { method: "POST", body: { title: "New", body: "B", labels: ["bug"], assignees: ["bob"] } });
      expect(r.content[0].text).toBe('Created issue #9: "New"\nhttps://x/9');
    });

    it("update PATCHes and reports the new state", async () => {
      githubRequest.mockResolvedValueOnce({ number: 7, title: "Bug", state: "closed", html_url: "https://x/7" });
      const r = await call({ action: "update", owner: "o", repo: "r", issue_number: 7, state: "closed" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/issues/7", { method: "PATCH", body: { title: undefined, body: undefined, state: "closed", labels: undefined, assignees: undefined } });
      expect(r.content[0].text).toBe('Updated issue #7: "Bug" [closed]\nhttps://x/7');
    });

    it("comment POSTs the body", async () => {
      githubRequest.mockResolvedValueOnce({ id: 555, html_url: "https://x/c" });
      const r = await call({ action: "comment", owner: "o", repo: "r", issue_number: 7, body: "hello" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/o/r/issues/7/comments", { method: "POST", body: { body: "hello" } });
      expect(r.content[0].text).toBe("Posted comment #555 on #7.\nhttps://x/c");
    });
  });

  describe("search", () => {
    const item = (over = {}) => ({
      number: 3, state: "open", title: "Fix it", labels: [{ name: "bounty" }], assignee: null,
      repository_url: "https://api.github.com/repos/acme/widgets", created_at: "2026-07-01T00:00:00Z",
      html_url: "https://github.com/acme/widgets/issues/3", ...over,
    });

    it("ignores owner/repo, encodes the query, and defaults order/per_page", async () => {
      githubRequest.mockResolvedValueOnce({ total_count: 1, items: [item()] });
      const r = await call({ action: "search", owner: "ignored", repo: "ignored", query: "label:bounty is:open" });
      expect(githubRequest).toHaveBeenCalledWith("/search/issues?q=label%3Abounty%20is%3Aopen&order=desc&per_page=20");
      expect(r.content[0].text).toBe(
        "Found 1 total result(s) (GitHub search caps at 1000), showing 1:\n\nIssue #3 [open] Fix it [bounty] (unassigned)\n  acme/widgets | created 2026-07-01 | https://github.com/acme/widgets/issues/3"
      );
    });

    it("appends sort and honours order/per_page; labels PRs and assignees", async () => {
      githubRequest.mockResolvedValueOnce({ total_count: 2, items: [item({ pull_request: {}, assignee: { login: "bob" }, labels: [] })] });
      const r = await call({ action: "search", query: "x", sort: "updated", order: "asc", per_page: 5 });
      expect(githubRequest.mock.calls[0][0]).toBe("/search/issues?q=x&order=asc&per_page=5&sort=updated");
      expect(r.content[0].text).toContain("PR #3 [open] Fix it (assigned: bob)");
    });

    it("returns 'No results found.' for an empty result set", async () => {
      githubRequest.mockResolvedValueOnce({ total_count: 0, items: [] });
      const r = await call({ action: "search", query: "nothing" });
      expect(r.content[0].text).toBe("No results found.");
    });
  });
});
