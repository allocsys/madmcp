// ---------------------------------------------------------------------------
// test/repomap-tools.test.js
//
// Direct unit coverage for connectors/repomap/tools.js (the repo_map_scan +
// repo_map MCP tool handlers). Previously untested at this layer -- only the
// client.js/queries.js modules below it had coverage. Covers:
//   - repo_map_scan: repo-required guard, jobId-poll vs start-scan branching,
//     and that caught errors are prefixed with which operation failed
//   - repo_map: query-required (search) / symbol-or-file-required (graph)
//     guards, the new file-required-for-importers/imports guard, and that
//     caught errors are prefixed with which mode failed
//   - "no results" messaging vs a genuine thrown error, kept distinct
//
// startScan/getScanStatus/searchChunks/queryGraph (connectors/repomap/
// client.js) are mocked -- this is a handler unit test, not a live-network
// test. See repomap-client.test.js / repomap-queries.test.js for the layers
// underneath.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({ DEFAULT_OWNER: "allocsys" }));

vi.mock("../connectors/repomap/client.js", () => ({
  startScan: vi.fn(),
  getScanStatus: vi.fn(),
  searchChunks: vi.fn(),
  queryGraph: vi.fn(),
}));

import { startScan, getScanStatus, searchChunks, queryGraph } from "../connectors/repomap/client.js";
import { register } from "../connectors/repomap/tools.js";

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

describe("connectors/repomap/tools.js", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    register(server);
  });

  describe("repo_map_scan", () => {
    it("requires repo when jobId is not given", async () => {
      const result = await server.tools.repo_map_scan({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/repo is required/);
      expect(startScan).not.toHaveBeenCalled();
    });

    it("polls status via getScanStatus when jobId is given, without calling startScan", async () => {
      getScanStatus.mockResolvedValueOnce({ status: "done", files_scanned: 12, files_changed: 3, chunks_embedded: 40 });

      const result = await server.tools.repo_map_scan({ jobId: "job-1" });

      expect(getScanStatus).toHaveBeenCalledWith("job-1");
      expect(startScan).not.toHaveBeenCalled();
      expect(result.content[0].text).toMatch(/Job job-1: done \(12 files scanned, 3 changed, 40 chunks embedded\)/);
    });

    it("surfaces a failed job's error in the status summary", async () => {
      getScanStatus.mockResolvedValueOnce({ status: "failed", error: "embedding batch 400" });

      const result = await server.tools.repo_map_scan({ jobId: "job-2" });

      expect(result.content[0].text).toBe("Job job-2: failed -- embedding batch 400");
    });

    it("starts a scan via startScan when repo is given and no jobId", async () => {
      startScan.mockResolvedValueOnce({ jobId: "job-3", status: "queued" });

      const result = await server.tools.repo_map_scan({ owner: "allocsys", repo: "widgets", ref: "main" });

      expect(startScan).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", ref: "main" });
      expect(getScanStatus).not.toHaveBeenCalled();
      expect(result.content[0].text).toMatch(/Scan started for allocsys\/widgets@main. jobId: job-3/);
    });

    it("defaults owner to DEFAULT_OWNER when omitted", async () => {
      startScan.mockResolvedValueOnce({ jobId: "job-4", status: "queued" });

      await server.tools.repo_map_scan({ repo: "widgets" });

      expect(startScan).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", ref: undefined });
    });

    it("prefixes a caught error from starting a scan with 'start scan'", async () => {
      startScan.mockRejectedValueOnce(new Error("worker unreachable"));

      const result = await server.tools.repo_map_scan({ repo: "widgets" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("repo_map_scan (start scan): worker unreachable");
    });

    it("prefixes a caught error from polling status with 'status check'", async () => {
      getScanStatus.mockRejectedValueOnce(new Error("worker unreachable"));

      const result = await server.tools.repo_map_scan({ jobId: "job-5" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("repo_map_scan (status check): worker unreachable");
    });
  });

  describe("repo_map — mode: search", () => {
    it("requires query", async () => {
      const result = await server.tools.repo_map({ repo: "widgets", mode: "search" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/query is required/);
      expect(searchChunks).not.toHaveBeenCalled();
    });

    it("reports 'no results' distinctly from a thrown error when the repo hasn't been scanned", async () => {
      searchChunks.mockResolvedValueOnce({ results: [] });

      const result = await server.tools.repo_map({ owner: "allocsys", repo: "widgets", mode: "search", query: "parse config" });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/No results\. Has allocsys\/widgets been scanned yet\?/);
    });

    it("formats successful search results", async () => {
      searchChunks.mockResolvedValueOnce({
        results: [{ filePath: "src/a.js", symbolName: "foo", qualifiedName: "mod.foo", startLine: 1, endLine: 5, distance: 0.123456 }],
      });

      const result = await server.tools.repo_map({ repo: "widgets", mode: "search", query: "q" });

      expect(result.content[0].text).toBe("src/a.js — mod.foo (L1-5) [dist 0.123]");
    });

    it("prefixes a caught error with 'mode: search'", async () => {
      searchChunks.mockRejectedValueOnce(new Error("db unavailable"));

      const result = await server.tools.repo_map({ repo: "widgets", mode: "search", query: "q" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("repo_map (mode: search): db unavailable");
    });
  });

  describe("repo_map — mode: graph", () => {
    it("requires symbol or file", async () => {
      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/symbol or file is required/);
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("requires file specifically when direction is importers, even if symbol is given", async () => {
      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph", symbol: "foo", direction: "importers" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/file is required when direction is "importers"/);
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("requires file specifically when direction is imports, even if symbol is given", async () => {
      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph", symbol: "foo", direction: "imports" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/file is required when direction is "imports"/);
      expect(queryGraph).not.toHaveBeenCalled();
    });

    it("does not require file for importers/imports once file is actually given", async () => {
      queryGraph.mockResolvedValueOnce({ results: [] });

      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph", file: "src/a.js", direction: "imports" });

      expect(result.isError).toBeUndefined();
      expect(queryGraph).toHaveBeenCalledWith({ owner: "allocsys", repo: "widgets", symbol: undefined, file: "src/a.js", direction: "imports", depth: undefined });
    });

    it("does NOT require file for callers/callees -- symbol alone is enough", async () => {
      queryGraph.mockResolvedValueOnce({ results: [] });

      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph", symbol: "foo", direction: "callers" });

      expect(result.isError).toBeUndefined();
      expect(queryGraph).toHaveBeenCalled();
    });

    it("reports 'no results' distinctly from a thrown error", async () => {
      queryGraph.mockResolvedValueOnce({ results: [] });

      const result = await server.tools.repo_map({ owner: "allocsys", repo: "widgets", mode: "graph", symbol: "foo" });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/No results\. Has allocsys\/widgets been scanned yet\?/);
    });

    it("formats successful graph results for symbols", async () => {
      queryGraph.mockResolvedValueOnce({
        results: [{ name: "foo", qualifiedName: "mod.foo", filePath: "src/a.js", startLine: 1, endLine: 5, depth: 1 }],
      });

      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph", symbol: "foo" });

      expect(result.content[0].text).toBe("mod.foo — src/a.js (L1-5) [depth 1]");
    });

    it("formats successful graph results for files (importers/imports)", async () => {
      queryGraph.mockResolvedValueOnce({
        results: [{ filePath: "src/b.js", depth: 1 }],
      });

      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph", file: "src/a.js", direction: "imports" });

      expect(result.content[0].text).toBe("src/b.js (depth 1)");
    });

    it("prefixes a caught error with 'mode: graph'", async () => {
      queryGraph.mockRejectedValueOnce(new Error("db unavailable"));

      const result = await server.tools.repo_map({ repo: "widgets", mode: "graph", symbol: "foo" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("repo_map (mode: graph): db unavailable");
    });
  });
});
