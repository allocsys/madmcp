// ---------------------------------------------------------------------------
// test/repomap-client.test.js
//
// Direct unit coverage for connectors/repomap/client.js (the HTTP layer
// between madmcp and the repo_map worker deployed on Railway). Covers:
//   - assertConfigured() guards (REPO_MAP_WORKER_URL / REPO_MAP_SHARED_SECRET
//     missing -- the exact state before the worker was provisioned)
//   - startScan() mints a clone token and forwards it in the request body,
//     never leaking it anywhere else
//   - the shared-secret bearer header is sent on every request
//   - non-2xx worker responses are surfaced as thrown Errors with the
//     worker's own error message included
//   - getScanStatus/searchChunks/queryGraph hit the right path+method+body
//
// global.fetch is mocked -- this is a handler/HTTP-shape unit test, not a
// live-network test against the real worker. getCloneToken
// (connectors/github/app_auth.js) is mocked the same way
// test/github-clone-token.test.js mocks it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../connectors/github/app_auth.js", () => ({
  getCloneToken: vi.fn(),
}));

// searchChunks/queryGraph now query Neon directly via queries.js (no worker
// HTTP hop -- see client.js's file header) -- mock at this boundary rather
// than fetch, which also means db.js/embed.js (and their REPO_MAP_DATABASE_URL/
// GEMINI_API_KEYS config.js dependency) never load in this test file.
// getRepoRow is also mocked here -- it's what ensureFresh() (client.js) uses
// to read last_scanned_commit/default_ref for the staleness check below.
vi.mock("../connectors/repomap/queries.js", () => ({
  queryChunksDb: vi.fn(),
  queryGraphDb: vi.fn(),
  getRepoRow: vi.fn(),
}));

// ensureFresh()'s HEAD-sha check goes through githubRequest, not raw fetch --
// mock at that boundary so these tests aren't coupled to githubRequest's own
// retry/throttle internals (already covered by test/github-client.test.js).
vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
}));

describe("connectors/repomap/client.js", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.resetModules();
  });

  describe("when REPO_MAP_WORKER_URL / REPO_MAP_SHARED_SECRET are unset", () => {
    beforeEach(() => {
      vi.doMock("../config.js", () => ({
        REPO_MAP_WORKER_URL: undefined,
        REPO_MAP_SHARED_SECRET: undefined,
        DEFAULT_OWNER: "allocsys",
      }));
    });

    it("startScan throws a clear config error without ever calling fetch", async () => {
      global.fetch = vi.fn();
      const { getCloneToken } = await import("../connectors/github/app_auth.js");
      getCloneToken.mockResolvedValue({ token: "ghs_shouldnotbeused" });

      const { startScan } = await import("../connectors/repomap/client.js");

      await expect(startScan({ repo: "widgets" })).rejects.toThrow(/REPO_MAP_WORKER_URL is not set/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("getScanStatus throws the same config error", async () => {
      global.fetch = vi.fn();
      const { getScanStatus } = await import("../connectors/repomap/client.js");

      await expect(getScanStatus("1")).rejects.toThrow(/REPO_MAP_WORKER_URL is not set/);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("when only REPO_MAP_SHARED_SECRET is missing", () => {
    beforeEach(() => {
      vi.doMock("../config.js", () => ({
        REPO_MAP_WORKER_URL: "https://repo-map-worker-production.up.railway.app",
        REPO_MAP_SHARED_SECRET: undefined,
        DEFAULT_OWNER: "allocsys",
      }));
    });

    it("throws the shared-secret config error, not a network call", async () => {
      global.fetch = vi.fn();
      const { getScanStatus } = await import("../connectors/repomap/client.js");

      await expect(getScanStatus("1")).rejects.toThrow(/REPO_MAP_SHARED_SECRET is not set/);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("when fully configured", () => {
    const WORKER_URL = "https://repo-map-worker-production.up.railway.app";
    const SECRET = "test-shared-secret";

    beforeEach(() => {
      vi.doMock("../config.js", () => ({
        REPO_MAP_WORKER_URL: WORKER_URL,
        REPO_MAP_SHARED_SECRET: SECRET,
        DEFAULT_OWNER: "allocsys",
      }));
    });

    function mockFetchOnce(status, body) {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        statusText: "status text",
        text: async () => JSON.stringify(body),
      });
    }

    it("startScan mints a clone token and POSTs it in the body, with the bearer header set", async () => {
      const { getCloneToken } = await import("../connectors/github/app_auth.js");
      getCloneToken.mockResolvedValue({ token: "ghs_realtoken123" });
      mockFetchOnce(202, { jobId: 7, status: "queued" });

      const { startScan } = await import("../connectors/repomap/client.js");
      const result = await startScan({ owner: "allocsys", repo: "widgets", ref: "main" });

      expect(getCloneToken).toHaveBeenCalledWith("allocsys", "widgets");
      expect(result).toEqual({ jobId: 7, status: "queued" });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe(`${WORKER_URL}/scan`);
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
      expect(init.headers["Content-Type"]).toBe("application/json");
      const sentBody = JSON.parse(init.body);
      expect(sentBody).toEqual({ owner: "allocsys", repo: "widgets", ref: "main", cloneToken: "ghs_realtoken123" });
    });

    it("startScan falls back to a tokenless clone when the App isn't installed on the repo", async () => {
      const { getCloneToken } = await import("../connectors/github/app_auth.js");
      getCloneToken.mockRejectedValue(
        new Error(
          "Failed to mint installation token for someuser/somerepo (422): " +
          "There is at least one repository that does not exist or is not accessible to the parent installation."
        )
      );
      mockFetchOnce(202, { jobId: 9, status: "queued" });

      const { startScan } = await import("../connectors/repomap/client.js");
      const result = await startScan({ owner: "someuser", repo: "somerepo" });

      expect(result).toEqual({ jobId: 9, status: "queued" });
      const [, init] = global.fetch.mock.calls[0];
      const sentBody = JSON.parse(init.body);
      expect(sentBody).toEqual({ owner: "someuser", repo: "somerepo", ref: undefined, cloneToken: undefined });
    });

    it("startScan still rethrows a getCloneToken error unrelated to install scope, without calling fetch", async () => {
      global.fetch = vi.fn();
      const { getCloneToken } = await import("../connectors/github/app_auth.js");
      getCloneToken.mockRejectedValue(new Error("GITHUB_APP_PRIVATE_KEY not configured"));

      const { startScan } = await import("../connectors/repomap/client.js");

      await expect(startScan({ repo: "widgets" })).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY not configured/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    describe("startScan's not-installed fallback prefers err.status over message wording", () => {
      function notInstalledError(status) {
        // Message deliberately does NOT match the old/new regex, to prove
        // the status check alone is what triggers the fallback.
        const err = new Error("Failed to mint installation token for someuser/somerepo: some new wording GitHub might use someday");
        if (status !== undefined) err.status = status;
        return err;
      }

      it("falls back on err.status 404, regardless of message wording", async () => {
        const { getCloneToken } = await import("../connectors/github/app_auth.js");
        getCloneToken.mockRejectedValue(notInstalledError(404));
        mockFetchOnce(202, { jobId: 10, status: "queued" });

        const { startScan } = await import("../connectors/repomap/client.js");
        const result = await startScan({ owner: "someuser", repo: "somerepo" });

        expect(result).toEqual({ jobId: 10, status: "queued" });
        const [, init] = global.fetch.mock.calls[0];
        expect(JSON.parse(init.body).cloneToken).toBeUndefined();
      });

      it("falls back on err.status 422, regardless of message wording", async () => {
        const { getCloneToken } = await import("../connectors/github/app_auth.js");
        getCloneToken.mockRejectedValue(notInstalledError(422));
        mockFetchOnce(202, { jobId: 11, status: "queued" });

        const { startScan } = await import("../connectors/repomap/client.js");
        const result = await startScan({ owner: "someuser", repo: "somerepo" });

        expect(result).toEqual({ jobId: 11, status: "queued" });
      });

      it("still falls back via message-match when err.status is absent (older error shape)", async () => {
        const { getCloneToken } = await import("../connectors/github/app_auth.js");
        getCloneToken.mockRejectedValue(
          new Error("resource not accessible by integration")
        );
        mockFetchOnce(202, { jobId: 12, status: "queued" });

        const { startScan } = await import("../connectors/repomap/client.js");
        const result = await startScan({ owner: "someuser", repo: "somerepo" });

        expect(result).toEqual({ jobId: 12, status: "queued" });
      });

      it("rethrows when err.status is an unrelated code and the message doesn't match either", async () => {
        global.fetch = vi.fn();
        const { getCloneToken } = await import("../connectors/github/app_auth.js");
        getCloneToken.mockRejectedValue(notInstalledError(500));

        const { startScan } = await import("../connectors/repomap/client.js");

        await expect(startScan({ repo: "widgets" })).rejects.toThrow(/some new wording/);
        expect(global.fetch).not.toHaveBeenCalled();
      });
    });

    it("startScan defaults owner to DEFAULT_OWNER when omitted", async () => {
      const { getCloneToken } = await import("../connectors/github/app_auth.js");
      getCloneToken.mockResolvedValue({ token: "ghs_x" });
      mockFetchOnce(202, { jobId: 8, status: "queued" });

      const { startScan } = await import("../connectors/repomap/client.js");
      await startScan({ repo: "widgets" });

      expect(getCloneToken).toHaveBeenCalledWith("allocsys", "widgets");
    });

    it("getScanStatus GETs /status/:jobId with the jobId URL-encoded", async () => {
      mockFetchOnce(200, { id: 7, status: "done", files_scanned: 12 });

      const { getScanStatus } = await import("../connectors/repomap/client.js");
      const result = await getScanStatus("job/with slash");

      expect(result).toEqual({ id: 7, status: "done", files_scanned: 12 });
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe(`${WORKER_URL}/status/${encodeURIComponent("job/with slash")}`);
      expect(init.method).toBe("GET");
    });

    describe("getFreshness (pure HEAD-vs-last_scanned_commit check, no side effects)", () => {
      it("returns { scanned: false } when the repo has never been scanned, without calling githubRequest", async () => {
        const { getRepoRow } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce(null);

        const { getFreshness } = await import("../connectors/repomap/client.js");
        const result = await getFreshness({ owner: "allocsys", repo: "widgets" });

        expect(result).toEqual({ scanned: false });
        expect(githubRequest).not.toHaveBeenCalled();
      });

      it("reports fresh: true when HEAD matches last_scanned_commit, using the repo's default_ref", async () => {
        const { getRepoRow } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ last_scanned_commit: "abc123", default_ref: "main" });
        githubRequest.mockResolvedValueOnce({ object: { sha: "abc123" } });

        const { getFreshness } = await import("../connectors/repomap/client.js");
        const result = await getFreshness({ owner: "allocsys", repo: "widgets" });

        expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/widgets/git/ref/heads/main");
        expect(result).toEqual({ scanned: true, fresh: true, headSha: "abc123", lastScannedCommit: "abc123", branch: "main" });
      });

      it("reports fresh: false on a HEAD mismatch, without starting a scan itself", async () => {
        const { getRepoRow } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ last_scanned_commit: "old_sha", default_ref: "main" });
        githubRequest.mockResolvedValueOnce({ object: { sha: "new_sha" } });
        global.fetch = vi.fn();

        const { getFreshness } = await import("../connectors/repomap/client.js");
        const result = await getFreshness({ owner: "allocsys", repo: "widgets" });

        expect(result).toEqual({ scanned: true, fresh: false, headSha: "new_sha", lastScannedCommit: "old_sha", branch: "main" });
        expect(global.fetch).not.toHaveBeenCalled(); // pure check -- caller (the `map` tool) decides whether to scan
      });

      it("uses an explicit ref instead of default_ref when given", async () => {
        const { getRepoRow } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ last_scanned_commit: "abc", default_ref: "main" });
        githubRequest.mockResolvedValueOnce({ object: { sha: "feat_sha" } });

        const { getFreshness } = await import("../connectors/repomap/client.js");
        const result = await getFreshness({ owner: "allocsys", repo: "widgets", ref: "feature-branch" });

        expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/widgets/git/ref/heads/feature-branch");
        expect(result.branch).toBe("feature-branch");
      });

      it("propagates a failure fetching HEAD sha (unlike ensureFresh, which swallows it)", async () => {
        const { getRepoRow } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ last_scanned_commit: "abc", default_ref: "main" });
        githubRequest.mockRejectedValueOnce(new Error("GitHub API hiccup"));

        const { getFreshness } = await import("../connectors/repomap/client.js");
        await expect(getFreshness({ owner: "allocsys", repo: "widgets" })).rejects.toThrow(/GitHub API hiccup/);
      });
    });

    it("searchChunks calls queryChunksDb directly (no worker HTTP hop) and wraps the result", async () => {
      global.fetch = vi.fn();
      const { queryChunksDb } = await import("../connectors/repomap/queries.js");
      queryChunksDb.mockResolvedValueOnce([{ filePath: "src/a.js", distance: 0.1 }]);

      const { searchChunks } = await import("../connectors/repomap/client.js");
      const result = await searchChunks({ owner: "allocsys", repo: "widgets", query: "parse config", topK: 5 });

      expect(result).toEqual({ results: [{ filePath: "src/a.js", distance: 0.1 }] });
      expect(queryChunksDb).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", query: "parse config", topK: 5 });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("queryGraph calls queryGraphDb directly (no worker HTTP hop) and wraps the result", async () => {
      global.fetch = vi.fn();
      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      queryGraphDb.mockResolvedValueOnce([{ name: "foo", filePath: "src/a.js", depth: 1 }]);

      const { queryGraph } = await import("../connectors/repomap/client.js");
      const result = await queryGraph({ owner: "allocsys", repo: "widgets", symbol: "foo", direction: "callers", depth: 2 });

      expect(result).toEqual({ results: [{ name: "foo", filePath: "src/a.js", depth: 1 }] });
      expect(queryGraphDb).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", symbol: "foo", file: undefined, direction: "callers", depth: 2 });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    describe("ensureFresh (staleness check called from searchChunks/queryGraph)", () => {
      beforeEach(async () => {
        const { getCloneToken } = await import("../connectors/github/app_auth.js");
        getCloneToken.mockResolvedValue({ token: "ghs_x" });
      });

      it("never-scanned repo (no row): does not call githubRequest or startScan, still answers the read", async () => {
        const { getRepoRow, queryChunksDb } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce(null);
        queryChunksDb.mockResolvedValueOnce([]);
        global.fetch = vi.fn();

        const { searchChunks } = await import("../connectors/repomap/client.js");
        const result = await searchChunks({ owner: "allocsys", repo: "widgets", query: "q" });

        expect(result).toEqual({ results: [] });
        expect(githubRequest).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it("fresh HEAD (matches last_scanned_commit): does not fire a scan", async () => {
        const { getRepoRow, queryGraphDb } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ id: 1, last_scanned_commit: "abc123", default_ref: "main" });
        githubRequest.mockResolvedValueOnce({ object: { sha: "abc123" } });
        queryGraphDb.mockResolvedValueOnce([]);
        global.fetch = vi.fn();

        const { queryGraph } = await import("../connectors/repomap/client.js");
        await queryGraph({ owner: "allocsys", repo: "widgets", symbol: "foo" });

        expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/widgets/git/ref/heads/main");
        expect(global.fetch).not.toHaveBeenCalled(); // startScan (which hits fetch) never fired
      });

      it("stale HEAD (mismatch): fires startScan in the background without blocking the read's result", async () => {
        const { getRepoRow, queryChunksDb } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ id: 1, last_scanned_commit: "old_sha", default_ref: "main" });
        githubRequest.mockResolvedValueOnce({ object: { sha: "new_sha" } });
        queryChunksDb.mockResolvedValueOnce([{ filePath: "src/a.js" }]);
        mockFetchOnce(202, { jobId: 42, status: "queued" });

        const { searchChunks } = await import("../connectors/repomap/client.js");
        const result = await searchChunks({ owner: "allocsys", repo: "widgets", query: "q" });

        // Read still answers from whatever's currently indexed -- doesn't wait on the rescan.
        expect(result).toEqual({ results: [{ filePath: "src/a.js" }] });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe(`${WORKER_URL}/scan`);
        const sentBody = JSON.parse(init.body);
        expect(sentBody).toMatchObject({ owner: "allocsys", repo: "widgets", ref: "main" });
      });

      it("always checks HEAD against the repo's default_ref -- searchChunks/queryGraph accept no ref param (only map.index does)", async () => {
        const { getRepoRow, queryGraphDb } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ id: 1, last_scanned_commit: "abc", default_ref: "main" });
        githubRequest.mockResolvedValueOnce({ object: { sha: "abc" } });
        queryGraphDb.mockResolvedValueOnce([]);
        global.fetch = vi.fn();

        const { queryGraph } = await import("../connectors/repomap/client.js");
        // A stray `ref` here is not destructured by queryGraph and has no effect --
        // documenting that on purpose, not testing a real forwarding path.
        await queryGraph({ owner: "allocsys", repo: "widgets", symbol: "foo", ref: "feature-branch" });

        expect(githubRequest).toHaveBeenCalledWith("/repos/allocsys/widgets/git/ref/heads/main");
      });

      it("swallows a failure fetching HEAD sha and still returns the read's results", async () => {
        const { getRepoRow, queryChunksDb } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ id: 1, last_scanned_commit: "abc", default_ref: "main" });
        githubRequest.mockRejectedValueOnce(new Error("GitHub API hiccup"));
        queryChunksDb.mockResolvedValueOnce([{ filePath: "src/a.js" }]);
        global.fetch = vi.fn();

        const { searchChunks } = await import("../connectors/repomap/client.js");
        const result = await searchChunks({ owner: "allocsys", repo: "widgets", query: "q" });

        expect(result).toEqual({ results: [{ filePath: "src/a.js" }] });
        expect(global.fetch).not.toHaveBeenCalled(); // never got far enough to call startScan
      });

      it("swallows a failure enqueuing the rescan itself and still returns the read's results", async () => {
        const { getRepoRow, queryGraphDb } = await import("../connectors/repomap/queries.js");
        const { githubRequest } = await import("../connectors/github/client.js");
        getRepoRow.mockResolvedValueOnce({ id: 1, last_scanned_commit: "old_sha", default_ref: "main" });
        githubRequest.mockResolvedValueOnce({ object: { sha: "new_sha" } });
        queryGraphDb.mockResolvedValueOnce([{ name: "foo" }]);
        global.fetch = vi.fn().mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => JSON.stringify({ error: "worker briefly down" }),
        });

        const { queryGraph } = await import("../connectors/repomap/client.js");
        const result = await queryGraph({ owner: "allocsys", repo: "widgets", symbol: "foo" });

        expect(result).toEqual({ results: [{ name: "foo" }] });
      });
    });

    it("throws an Error including the worker's error message on a non-2xx response", async () => {
      mockFetchOnce(500, { error: "database unavailable" });

      const { getScanStatus } = await import("../connectors/repomap/client.js");
      await expect(getScanStatus("1")).rejects.toThrow(/database unavailable/);
    });

    it("throws including raw text when the error body isn't JSON", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "<html>Bad Gateway</html>",
      });

      const { getScanStatus } = await import("../connectors/repomap/client.js");
      await expect(getScanStatus("1")).rejects.toThrow(/Bad Gateway|502/);
    });
  });
});
