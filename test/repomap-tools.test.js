// ---------------------------------------------------------------------------
// test/repomap-tools.test.js
//
// Direct unit coverage for connectors/repomap/tools.js (the hybrid `map`
// MCP tool -- formerly two tools, map.index + map.query, merged because the
// name similarity caused repeated mix-ups between polling a scan and
// querying the graph, and because staleness used to be silently healed in
// the background instead of being visible to the caller). Covers:
//   - repo-required guard when jobId is not given
//   - jobId resume path: still running vs done, and done with no mode /
//     mode-but-no-repo / mode+repo (runs the query)
//   - fresh-repo path: no mode (status line only) vs mode (runs query)
//   - never-scanned / stale-repo path: blocking scan then optional query,
//     and the scan-not-finished-inside-the-budget branch (both on the
//     first call and once resumed via jobId)
//   - runQuery's shared validation: query required for mode "search",
//     symbol-or-file required for mode "graph", file required specifically
//     for direction importers/imports
//   - formatSearchResults/formatGraphResults, incl. "No results."
//   - top-level catch prefixes the error with "map: "
//
// startScan/getScanStatus/getFreshness/searchChunks/queryGraph
// (connectors/repomap/client.js) are mocked -- this is a handler unit test,
// not a live-network test. See repomap-client.test.js / repomap-queries.test.js
// for the layers underneath.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({ DEFAULT_OWNER: "allocsys" }));

vi.mock("../connectors/repomap/client.js", () => ({
  startScan: vi.fn(),
  getScanStatus: vi.fn(),
  getFreshness: vi.fn(),
  searchChunks: vi.fn(),
  queryGraph: vi.fn(),
}));

import { startScan, getScanStatus, getFreshness, searchChunks, queryGraph } from "../connectors/repomap/client.js";
import { register } from "../connectors/repomap/tools.js";

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

// pollToBudget() keeps polling getScanStatus (sleeping 3s between calls) until
// the job is done/failed or its 45s budget elapses. For "still running" cases the
// mock must keep returning a running job, and fake timers let us blow through the
// budget instantly instead of exhausting a Once-mock (which returned undefined and
// caused "Cannot read properties of undefined (reading 'status')").
async function settle(promise) {
  await vi.advanceTimersByTimeAsync(60000);
  return promise;
}

describe("connectors/repomap/tools.js", () => {
  let server, map;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getScanStatus.mockReset();
    server = makeFakeServer();
    register(server);
    map = server.tools["map"];
  });

  it("registers a single `map` tool (not map.index/map.query)", () => {
    expect(map).toBeTypeOf("function");
    expect(server.tools["map.index"]).toBeUndefined();
    expect(server.tools["map.query"]).toBeUndefined();
  });

  it("requires repo when jobId is not given", async () => {
    const result = await map({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/repo is required when jobId is not given/);
    expect(getFreshness).not.toHaveBeenCalled();
    expect(startScan).not.toHaveBeenCalled();
  });

  describe("resuming via jobId", () => {
    it("still running: reports progress and tells the caller to resume with the same jobId", async () => {
      vi.useFakeTimers();
      getScanStatus.mockResolvedValue({ status: "running", files_done: 3, files_total: 10 });

      const result = await settle(map({ jobId: "job-1" }));

      expect(getScanStatus).toHaveBeenCalledWith("job-1");
      expect(result.content[0].text).toContain("running");
      expect(result.content[0].text).toMatch(/3\/10/);
      expect(result.content[0].text).toMatch(/Still in progress -- call map again with jobId "job-1"/);
      expect(startScan).not.toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });

    it("done, no mode: reports done and invites a follow-up query", async () => {
      getScanStatus.mockResolvedValueOnce({ status: "done", files_scanned: 12, files_changed: 3, chunks_embedded: 40 });

      const result = await map({ jobId: "job-2" });

      expect(result.content[0].text).toMatch(/Job job-2: done \(12 files scanned, 3 changed, 40 chunks embedded\)/);
      expect(result.content[0].text).toMatch(/Repo is now fresh -- call map again with mode\/query/);
      expect(searchChunks).not.toHaveBeenCalled();
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("done, mode given but no repo: asks for repo instead of guessing", async () => {
      getScanStatus.mockResolvedValueOnce({ status: "done" });

      const result = await map({ jobId: "job-3", mode: "search", query: "parse config" });

      expect(result.content[0].text).toMatch(/Pass repo \(and owner if not "allocsys"\) alongside mode\/query/);
      expect(searchChunks).not.toHaveBeenCalled();
    });

    it("done, mode + repo: runs the query and prefixes it with the done status", async () => {
      getScanStatus.mockResolvedValueOnce({ status: "done", files_scanned: 5, files_changed: 1, chunks_embedded: 9 });
      searchChunks.mockResolvedValueOnce({
        results: [{ filePath: "src/a.js", symbolName: "foo", qualifiedName: "mod.foo", startLine: 1, endLine: 5, distance: 0.123456 }],
      });

      const result = await map({ jobId: "job-4", repo: "widgets", mode: "search", query: "parse config" });

      expect(searchChunks).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", query: "parse config", topK: undefined });
      expect(result.content[0].text).toMatch(/^Job job-4: done/);
      expect(result.content[0].text).toContain("src/a.js — mod.foo (L1-5) [dist 0.123]");
    });

    it("failed job: surfaces the error in the status line", async () => {
      getScanStatus.mockResolvedValueOnce({ status: "failed", error: "embedding batch 400" });

      const result = await map({ jobId: "job-5" });

      expect(result.content[0].text).toContain("failed -- embedding batch 400");
      expect(result.content[0].text).toMatch(/Still in progress -- call map again with jobId "job-5"/);
    });
  });

  describe("fresh repo (no scan needed)", () => {
    it("no mode: reports up to date with the scanned commit, no query run", async () => {
      getFreshness.mockResolvedValueOnce({ scanned: true, fresh: true, lastScannedCommit: "abc123", branch: "main" });

      const result = await map({ repo: "widgets" });

      expect(getFreshness).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", ref: undefined });
      expect(result.content[0].text).toMatch(/allocsys\/widgets is up to date \(commit abc123\)/);
      expect(startScan).not.toHaveBeenCalled();
      expect(searchChunks).not.toHaveBeenCalled();
    });

    it("with mode: runs the query directly, no scan", async () => {
      getFreshness.mockResolvedValueOnce({ scanned: true, fresh: true, lastScannedCommit: "abc123", branch: "main" });
      queryGraph.mockResolvedValueOnce({
        results: [{ name: "foo", qualifiedName: "mod.foo", filePath: "src/a.js", startLine: 1, endLine: 5, depth: 1 }],
      });

      const result = await map({ repo: "widgets", mode: "graph", symbol: "foo" });

      expect(startScan).not.toHaveBeenCalled();
      expect(queryGraph).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", symbol: "foo", file: undefined, direction: undefined, depth: undefined });
      expect(result.content[0].text).toBe("mod.foo — src/a.js (L1-5) [depth 1]");
    });
  });

  describe("never-scanned / stale repo (blocking scan first)", () => {
    it("never scanned, scan finishes in budget, no mode: reports 'never been scanned -- scanning now' + done", async () => {
      getFreshness.mockResolvedValueOnce({ scanned: false });
      startScan.mockResolvedValueOnce({ jobId: "job-6", status: "queued" });
      getScanStatus.mockResolvedValueOnce({ status: "done", files_scanned: 20, files_changed: 20, chunks_embedded: 80 });

      const result = await map({ repo: "widgets", ref: "main" });

      expect(startScan).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", ref: "main" });
      expect(result.content[0].text).toMatch(/allocsys\/widgets has never been scanned -- scanning now\./);
      expect(result.content[0].text).toMatch(/done \(20 files scanned, 20 changed, 80 chunks embedded\)/);
      expect(searchChunks).not.toHaveBeenCalled();
    });

    it("stale, scan finishes in budget, with mode: reports 'was stale -- rescanning' then runs the query", async () => {
      getFreshness.mockResolvedValueOnce({ scanned: true, fresh: false, branch: "main" });
      startScan.mockResolvedValueOnce({ jobId: "job-7", status: "queued" });
      getScanStatus.mockResolvedValueOnce({ status: "done" });
      searchChunks.mockResolvedValueOnce({ results: [] });

      const result = await map({ repo: "widgets", mode: "search", query: "q" });

      expect(startScan).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", ref: "main" });
      expect(result.content[0].text).toMatch(/allocsys\/widgets was stale -- rescanning\./);
      expect(result.content[0].text).toContain("No results.");
    });

    it("scan does not finish in budget, no mode: tells the caller to resume with jobId", async () => {
      getFreshness.mockResolvedValueOnce({ scanned: false });
      startScan.mockResolvedValueOnce({ jobId: "job-8", status: "queued" });
      vi.useFakeTimers();
      getScanStatus.mockResolvedValue({ status: "running", files_done: 4, files_total: 50 });

      const result = await settle(map({ repo: "widgets" }));

      expect(result.content[0].text).toMatch(/Still in progress -- call map again with jobId "job-8" to resume\./);
      expect(searchChunks).not.toHaveBeenCalled();
    });

    it("scan does not finish in budget, with mode: resume hint includes the query args to repeat", async () => {
      getFreshness.mockResolvedValueOnce({ scanned: false });
      startScan.mockResolvedValueOnce({ jobId: "job-9", status: "queued" });
      vi.useFakeTimers();
      getScanStatus.mockResolvedValue({ status: "running", files_done: 1, files_total: 50 });

      const result = await settle(map({ repo: "widgets", mode: "graph", symbol: "foo" }));

      expect(result.content[0].text).toMatch(/jobId "job-9" \(and the same repo\/mode\/symbol or file args\) to resume\./);
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("scan does not finish in budget, mode search: resume hint says 'query' not 'symbol or file'", async () => {
      getFreshness.mockResolvedValueOnce({ scanned: false });
      startScan.mockResolvedValueOnce({ jobId: "job-10", status: "queued" });
      vi.useFakeTimers();
      getScanStatus.mockResolvedValue({ status: "running" });

      const result = await settle(map({ repo: "widgets", mode: "search", query: "q" }));

      expect(result.content[0].text).toMatch(/jobId "job-10" \(and the same repo\/mode\/query args\) to resume\./);
    });
  });

  describe("runQuery validation (shared by the fresh and just-scanned paths)", () => {
    beforeEach(() => {
      getFreshness.mockResolvedValue({ scanned: true, fresh: true, lastScannedCommit: "abc", branch: "main" });
    });

    it("requires query for mode: search", async () => {
      const result = await map({ repo: "widgets", mode: "search" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/query is required for mode "search"/);
      expect(searchChunks).not.toHaveBeenCalled();
    });

    it("requires symbol or file for mode: graph", async () => {
      const result = await map({ repo: "widgets", mode: "graph" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/symbol or file is required for mode "graph"/);
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("requires file specifically when direction is importers, even if symbol is given", async () => {
      const result = await map({ repo: "widgets", mode: "graph", symbol: "foo", direction: "importers" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/file is required when direction is "importers"/);
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("requires file specifically when direction is imports, even if symbol is given", async () => {
      const result = await map({ repo: "widgets", mode: "graph", symbol: "foo", direction: "imports" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/file is required when direction is "imports"/);
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("does not require file for importers/imports once file is actually given", async () => {
      queryGraph.mockResolvedValueOnce({ results: [] });

      const result = await map({ repo: "widgets", mode: "graph", file: "src/a.js", direction: "imports" });

      expect(result.isError).toBeUndefined();
      expect(queryGraph).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", symbol: undefined, file: "src/a.js", direction: "imports", depth: undefined });
    });

    it("does NOT require file for callers/callees -- symbol alone is enough", async () => {
      queryGraph.mockResolvedValueOnce({ results: [] });

      const result = await map({ repo: "widgets", mode: "graph", symbol: "foo", direction: "callers" });

      expect(result.isError).toBeUndefined();
      expect(queryGraph).toHaveBeenCalled();
    });
  });

  describe("formatting", () => {
    beforeEach(() => {
      getFreshness.mockResolvedValue({ scanned: true, fresh: true, lastScannedCommit: "abc", branch: "main" });
    });

    it("search: 'No results.' when empty", async () => {
      searchChunks.mockResolvedValueOnce({ results: [] });
      const result = await map({ repo: "widgets", mode: "search", query: "q" });
      expect(result.content[0].text).toBe("No results.");
    });

    it("graph: 'No results.' when empty", async () => {
      queryGraph.mockResolvedValueOnce({ results: [] });
      const result = await map({ repo: "widgets", mode: "graph", symbol: "foo" });
      expect(result.content[0].text).toBe("No results.");
    });

    it("graph: formats file-level results (importers/imports) without a symbol name", async () => {
      queryGraph.mockResolvedValueOnce({ results: [{ filePath: "src/b.js", depth: 1 }] });
      const result = await map({ repo: "widgets", mode: "graph", file: "src/a.js", direction: "imports" });
      expect(result.content[0].text).toBe("src/b.js (depth 1)");
    });
  });

  it("wraps a thrown error with the 'map: ' prefix", async () => {
    getFreshness.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await map({ repo: "widgets" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("map: db unavailable");
  });
});
