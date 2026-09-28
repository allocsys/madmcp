// ---------------------------------------------------------------------------
// test/github-notifications.test.js
//
// Unit coverage for connectors/github/notifications.js (list_notifications),
// previously untested. Covers:
//   - endpoint selection (global feed vs owner/repo scoped)
//   - owner-only filtering (client-side, case-insensitive)
//   - repo without owner -> error result, no request made
//   - empty-result messages and output formatting
// githubRequest is mocked -- handler unit test, no network.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

import { githubRequest } from "../connectors/github/client.js";
import { register } from "../connectors/github/notifications.js";

function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

const note = (ownerLogin, repoName, overrides = {}) => ({
  reason: "mention",
  unread: true,
  updated_at: "2026-09-28T10:20:30Z",
  subject: { type: "PullRequest", title: `PR in ${repoName}` },
  repository: { full_name: `${ownerLogin}/${repoName}`, owner: { login: ownerLogin } },
  ...overrides,
});

describe("connectors/github/notifications.js", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    register(server);
  });

  it("uses the global feed with defaults when no scope is given", async () => {
    githubRequest.mockResolvedValueOnce([note("allocsys", "madmcp")]);

    await server.tools.list_notifications({});

    expect(githubRequest).toHaveBeenCalledWith("/notifications?all=false&participating=false&per_page=30");
  });

  it("uses the repo-scoped endpoint when owner and repo are both given", async () => {
    githubRequest.mockResolvedValueOnce([note("allocsys", "madmcp")]);

    await server.tools.list_notifications({ owner: "allocsys", repo: "madmcp", per_page: 5 });

    expect(githubRequest).toHaveBeenCalledWith(
      "/repos/allocsys/madmcp/notifications?all=false&participating=false&per_page=5"
    );
  });

  it("owner alone hits the global feed and keeps only that owner's notifications (case-insensitive)", async () => {
    githubRequest.mockResolvedValueOnce([
      note("allocsys", "madmcp"),
      note("someorg", "widgets"),
      note("AllocSys", "other"),
    ]);

    const result = await server.tools.list_notifications({ owner: "allocsys" });

    expect(githubRequest.mock.calls[0][0]).toMatch(/^\/notifications\?/);
    const text = result.content[0].text;
    expect(text).toContain("allocsys/madmcp");
    expect(text).toContain("AllocSys/other");
    expect(text).not.toContain("someorg/widgets");
  });

  it("owner-only filter that removes everything returns the empty message", async () => {
    githubRequest.mockResolvedValueOnce([note("someorg", "widgets")]);

    const result = await server.tools.list_notifications({ owner: "allocsys" });

    expect(result.content[0].text).toBe("No unread notifications.");
  });

  it("repo without owner returns an error result and makes no request", async () => {
    const result = await server.tools.list_notifications({ repo: "madmcp" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/repo requires owner/);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("empty feed message depends on the all flag", async () => {
    githubRequest.mockResolvedValueOnce([]);
    const unread = await server.tools.list_notifications({});
    githubRequest.mockResolvedValueOnce([]);
    const all = await server.tools.list_notifications({ all: true });

    expect(unread.content[0].text).toBe("No unread notifications.");
    expect(all.content[0].text).toBe("No notifications.");
  });

  it("formats reason, subject, repo and timestamp, marking read items", async () => {
    githubRequest.mockResolvedValueOnce([note("allocsys", "madmcp", { unread: false, reason: "review_requested" })]);

    const result = await server.tools.list_notifications({ all: true });

    const text = result.content[0].text;
    expect(text).toContain("[review_requested] PullRequest: PR in madmcp");
    expect(text).toContain("allocsys/madmcp | updated 2026-09-28 10:20 (read)");
  });

  describe("pagination", () => {
    it("sends page only when given (default request is unchanged)", async () => {
      githubRequest.mockResolvedValue([]);

      await server.tools.list_notifications({ page: 3, per_page: 10 });

      expect(githubRequest).toHaveBeenCalledWith("/notifications?all=false&participating=false&per_page=10&page=3");
    });

    it("clamps an invalid page to 1", async () => {
      githubRequest.mockResolvedValue([]);

      await server.tools.list_notifications({ page: 0 });

      expect(githubRequest.mock.calls[0][0]).toMatch(/&page=1$/);
    });

    it("adds a 'more available' note pointing at the next page when a full page comes back", async () => {
      githubRequest.mockResolvedValueOnce([note("allocsys", "a"), note("allocsys", "b")]);

      const result = await server.tools.list_notifications({ per_page: 2 });

      expect(result.content[0].text).toContain("more notifications may be available");
      expect(result.content[0].text).toContain("page=2");
    });

    it("the note counts from the requested page", async () => {
      githubRequest.mockResolvedValueOnce([note("allocsys", "a"), note("allocsys", "b")]);

      const result = await server.tools.list_notifications({ per_page: 2, page: 4 });

      expect(result.content[0].text).toContain("page=5");
    });

    it("no note when the page is not full", async () => {
      githubRequest.mockResolvedValueOnce([note("allocsys", "a")]);

      const result = await server.tools.list_notifications({ per_page: 2 });

      expect(result.content[0].text).not.toContain("more notifications may be available");
    });

    it("a full page that the owner filter empties still says to look at the next page", async () => {
      githubRequest.mockResolvedValueOnce([note("someorg", "a"), note("someorg", "b")]);

      const result = await server.tools.list_notifications({ owner: "allocsys", per_page: 2 });

      expect(result.content[0].text).toContain("No matching notifications on this page.");
      expect(result.content[0].text).toContain("page=2");
    });
  });
});
