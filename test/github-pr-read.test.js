import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  githubGraphQL: vi.fn(),
}));

import { githubRequest } from "../connectors/github/client.js";
import { register as registerPRRead } from "../connectors/github/pr_read.js";

function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("GitHub Connector - pr_read (consolidated)", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    githubRequest.mockReset();
    server = makeFakeServer();
    registerPRRead(server);
  });

  it("registers exactly one tool named pr_read", () => {
    expect(Object.keys(server.tools)).toEqual(["pr_read"]);
  });

  describe("parameter validation (matches original required-ness)", () => {
    it("requires repo for every action", async () => {
      const result = await server.tools.pr_read({ action: "list", owner: "allocsys" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires repo");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it.each(["list", "get", "activity"])("requires owner for '%s' (originally no default)", async (action) => {
      const result = await server.tools.pr_read({ action, repo: "madmcp", pull_number: 1 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires owner");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it.each(["get", "activity", "mergeability"])("requires pull_number for '%s'", async (action) => {
      const result = await server.tools.pr_read({ action, owner: "allocsys", repo: "madmcp" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires pull_number");
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("'list' ignores pull_number and does not require it", async () => {
      githubRequest.mockResolvedValueOnce([]);
      const result = await server.tools.pr_read({ action: "list", owner: "allocsys", repo: "madmcp", pull_number: 7 });
      expect(result.content[0].text).toBe("No open pull requests found.");
    });
  });

  describe("per-action defaults (same as the original tools)", () => {
    it("list defaults to state=open, per_page=20", async () => {
      githubRequest.mockResolvedValueOnce([]);
      await server.tools.pr_read({ action: "list", owner: "allocsys", repo: "madmcp" });
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/pulls?state=open&per_page=20");
    });

    it("activity defaults to per_page=30 and fetches comments then reviews", async () => {
      githubRequest.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const result = await server.tools.pr_read({ action: "activity", owner: "allocsys", repo: "madmcp", pull_number: 42 });
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp/issues/42/comments?per_page=30");
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/allocsys/madmcp/pulls/42/reviews?per_page=30");
      expect(result.content[0].text).toBe("No comments on PR #42.\n\n===\n\nNo reviews on PR #42 yet.");
    });

    it("activity type=reviews only fetches reviews", async () => {
      githubRequest.mockResolvedValueOnce([]);
      await server.tools.pr_read({ action: "activity", owner: "allocsys", repo: "madmcp", pull_number: 42, type: "reviews" });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp/pulls/42/reviews?per_page=30");
    });

    it("activity type=inline fetches only the diff-anchored review comments", async () => {
      githubRequest.mockResolvedValueOnce([
        { user: { login: "alice" }, path: "src/a.js", line: 12, original_line: 12, created_at: "2026-08-03T10:15:00Z", body: "nit", html_url: "https://x/c/1" },
        { user: { login: "bob" }, path: "src/a.js", line: 20, start_line: 15, created_at: "2026-08-03T11:00:00Z", body: "range", html_url: "https://x/c/2", in_reply_to_id: 1 },
        { user: { login: "carol" }, path: "src/b.js", line: null, original_line: 7, created_at: "2026-08-03T12:00:00Z", body: "old", html_url: "https://x/c/3" },
      ]);
      const result = await server.tools.pr_read({ action: "activity", owner: "allocsys", repo: "madmcp", pull_number: 42, type: "inline" });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp/pulls/42/comments?per_page=30");
      const text = result.content[0].text;
      expect(text).toContain("3 inline comment(s) on PR #42:");
      expect(text).toContain("alice on src/a.js:12 (2026-08-03 10:15):\nnit\n  https://x/c/1");
      expect(text).toContain("bob on src/a.js:15-20 (2026-08-03 11:00) [reply]:\nrange");
      expect(text).toContain("carol on src/b.js:7 (outdated) (2026-08-03 12:00):\nold");
    });

    it("activity type=inline says so when there are none", async () => {
      githubRequest.mockResolvedValueOnce([]);
      const result = await server.tools.pr_read({ action: "activity", owner: "allocsys", repo: "madmcp", pull_number: 42, type: "inline", per_page: 5 });
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/allocsys/madmcp/pulls/42/comments?per_page=5");
      expect(result.content[0].text).toBe("No inline comments on PR #42.");
    });

    it("get uses max_comments=20, max_reviews=30, max_commits=100 by default", async () => {
      githubRequest
        .mockResolvedValueOnce({
          number: 42, state: "closed", merged_at: "2026-08-02T00:00:00Z", title: "T",
          head: { label: "a:b" }, base: { label: "a:main" }, user: { login: "u" },
          created_at: "2026-08-01T12:00:00Z", html_url: "url",
        })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const result = await server.tools.pr_read({ action: "get", owner: "allocsys", repo: "madmcp", pull_number: 42 });
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/allocsys/madmcp/issues/42/comments?per_page=20");
      expect(githubRequest.mock.calls[2][0]).toBe("/repos/allocsys/madmcp/pulls/42/reviews?per_page=30");
      expect(githubRequest.mock.calls[3][0]).toBe("/repos/allocsys/madmcp/pulls/42/commits?per_page=100");
      expect(result.content[0].text).toContain("#42 [merged] T");
      expect(result.content[0].text).toContain("(no description)");
      expect(result.content[0].text).toContain("--- No comments ---");
      expect(result.content[0].text).toContain("--- No reviews yet ---");
      expect(result.content[0].text).toContain("--- No commits found ---");
    });
  });

  describe("mergeability (own poll/retry budget preserved)", () => {
    const basePr = {
      title: "Fix it",
      mergeable_state: "clean",
      rebaseable: true,
      head: { label: "allocsys:fix" },
      base: { label: "allocsys:main" },
    };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("defaults owner and resolves immediately when mergeable is known", async () => {
      githubRequest.mockResolvedValueOnce({ ...basePr, mergeable: true });
      const result = await server.tools.pr_read({ action: "mergeability", repo: "madmcp", pull_number: 42 });
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/madmcp/pulls/42");
      expect(result.content[0].text).toBe(
        "PR #42: Fix it\nmergeable: true\nmergeable_state: clean — No conflicts, all checks pass — ready to merge.\nrebaseable: true\nallocsys:fix → allocsys:main"
      );
    });

    it("polls while mergeable is null and reports how many polls it took", async () => {
      githubRequest
        .mockResolvedValueOnce({ ...basePr, mergeable: null })
        .mockResolvedValueOnce({ ...basePr, mergeable: false, mergeable_state: "dirty" });
      const promise = server.tools.pr_read({ action: "mergeability", repo: "madmcp", pull_number: 42 });
      await vi.advanceTimersByTimeAsync(1200);
      const result = await promise;
      expect(githubRequest).toHaveBeenCalledTimes(2);
      expect(result.content[0].text).toContain("mergeable: false (resolved after 2 poll(s))");
      expect(result.content[0].text).toContain("mergeable_state: dirty — Merge conflicts");
    });

    it("gives up after exactly 4 polls (~3.6s) if GitHub never finishes computing", async () => {
      githubRequest.mockResolvedValue({ ...basePr, mergeable: null, mergeable_state: "unknown", rebaseable: null });
      const promise = server.tools.pr_read({ action: "mergeability", repo: "madmcp", pull_number: 42 });
      await vi.advanceTimersByTimeAsync(1200 * 3);
      const result = await promise;
      expect(githubRequest).toHaveBeenCalledTimes(4);
      expect(result.content[0].text).toContain("mergeable: still computing (polled 4x, ~3.5999999999999996s");
      expect(result.content[0].text).toContain("rebaseable: unknown");
    });
  });
});
