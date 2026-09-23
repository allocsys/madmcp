// ---------------------------------------------------------------------------
// test/repomap-queries.test.js — unit tests for connectors/repomap/queries.js
// Covers:
//   - queryChunksDb and queryGraphDb success paths and edge cases
//   - argument validation errors (missing parameters)
//   - empty database results handling (missing repo, missing symbols/files, no walk path)
//   - different queryGraphDb directions/modes (fileMode/imports vs symbolMode/callers)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../connectors/repomap/db.js", () => ({
  query: vi.fn(),
}));

vi.mock("../connectors/repomap/embed.js", () => ({
  embedQuery: vi.fn(),
}));

describe("connectors/repomap/queries.js", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("queryChunksDb", () => {
    it("throws if owner or repo is missing", async () => {
      const { queryChunksDb } = await import("../connectors/repomap/queries.js");
      await expect(queryChunksDb({ repo: "r", query: "q" })).rejects.toThrow(/owner and repo are required/);
      await expect(queryChunksDb({ owner: "o", query: "q" })).rejects.toThrow(/owner and repo are required/);
    });

    it("throws if query text is missing", async () => {
      const { queryChunksDb } = await import("../connectors/repomap/queries.js");
      await expect(queryChunksDb({ owner: "o", repo: "r" })).rejects.toThrow(/query text is required/);
    });

    it("returns empty array if repo does not exist in DB", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockResolvedValueOnce({ rows: [] }); // getRepoRow returns empty rows

      const { queryChunksDb } = await import("../connectors/repomap/queries.js");
      const results = await queryChunksDb({ owner: "o", repo: "r", query: "q" });

      expect(results).toEqual([]);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/SELECT .*FROM repos WHERE owner = \$1 AND name = \$2/s);
      expect(sql).toMatch(/last_scanned_commit/);
      expect(sql).toMatch(/default_ref/);
      expect(params).toEqual(["o", "r"]);
    });

    it("successfully embeds text and runs pgvector semantic search query", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      const { embedQuery } = await import("../connectors/repomap/embed.js");

      query.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // getRepoRow
      embedQuery.mockResolvedValueOnce([0.1, 0.2]); // embedQuery
      query.mockResolvedValueOnce({ // chunk query results
        rows: [
          {
            id: 101,
            content: "const a = 1;",
            distance: 0.15,
            file_path: "src/a.js",
            symbol_name: "a",
            qualified_name: "mod.a",
            kind: "variable",
            start_line: 1,
            end_line: 1,
          }
        ]
      });

      const { queryChunksDb } = await import("../connectors/repomap/queries.js");
      const results = await queryChunksDb({ owner: "owner", repo: "repo", query: "hello", topK: 5 });

      expect(results).toEqual([
        {
          filePath: "src/a.js",
          symbolName: "a",
          qualifiedName: "mod.a",
          kind: "variable",
          startLine: 1,
          endLine: 1,
          content: "const a = 1;",
          distance: 0.15,
        }
      ]);

      expect(query).toHaveBeenCalledTimes(2);
      expect(embedQuery).toHaveBeenCalledWith("hello");
    });
  });

  describe("queryGraphDb", () => {
    it("throws if owner or repo is missing", async () => {
      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      await expect(queryGraphDb({ repo: "r", symbol: "s" })).rejects.toThrow(/owner and repo are required/);
    });

    it("throws if symbol and file are both missing", async () => {
      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      await expect(queryGraphDb({ owner: "o", repo: "r" })).rejects.toThrow(/symbol or file is required/);
    });

    it("returns empty array if repo does not exist", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockResolvedValueOnce({ rows: [] }); // getRepoRow

      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      const results = await queryGraphDb({ owner: "o", repo: "r", symbol: "s" });

      expect(results).toEqual([]);
    });

    it("returns empty array if startIds are empty", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // getRepoRow
      query.mockResolvedValueOnce({ rows: [] }); // startIds (symbol not found)

      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      const results = await queryGraphDb({ owner: "o", repo: "r", symbol: "s" });

      expect(results).toEqual([]);
    });

    it("handles graph traversal with file mode (direction: imports)", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockImplementation((sql, params) => {
        if (sql.includes("FROM repos WHERE")) {
          return Promise.resolve({ rows: [{ id: 42 }] });
        }
        if (sql.includes("SELECT id FROM files WHERE")) {
          return Promise.resolve({ rows: [{ id: 201 }] });
        }
        if (sql.includes("WITH RECURSIVE walk")) {
          return Promise.resolve({ rows: [{ node_id: 202, depth: 1 }] });
        }
        if (sql.includes("SELECT id, path, language FROM files WHERE")) {
          return Promise.resolve({ rows: [{ id: 202, path: "src/b.js", language: "javascript" }] });
        }
        return Promise.reject(new Error("unexpected sql: " + sql));
      });

      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      const results = await queryGraphDb({
        owner: "o",
        repo: "r",
        file: "src/a.js",
        direction: "imports",
        depth: 2,
      });

      expect(results).toEqual([
        { filePath: "src/b.js", language: "javascript", depth: 1 },
      ]);
    });

    it("handles graph traversal with symbol mode (direction: callers)", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockImplementation((sql, params) => {
        if (sql.includes("FROM repos WHERE")) {
          return Promise.resolve({ rows: [{ id: 42 }] });
        }
        if (sql.includes("SELECT id FROM symbols WHERE")) {
          return Promise.resolve({ rows: [{ id: 501 }] });
        }
        if (sql.includes("WITH RECURSIVE walk")) {
          return Promise.resolve({ rows: [{ node_id: 502, depth: 1 }] });
        }
        if (sql.includes("SELECT s.id, s.name")) {
          return Promise.resolve({
            rows: [{
              id: 502,
              name: "callerFunc",
              qualified_name: "callerFunc",
              kind: "function",
              start_line: 10,
              end_line: 15,
              file_path: "src/b.js",
            }],
          });
        }
        return Promise.reject(new Error("unexpected sql: " + sql));
      });

      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      const results = await queryGraphDb({
        owner: "o",
        repo: "r",
        symbol: "targetFunc",
        direction: "callers",
        depth: 1,
      });

      expect(results).toEqual([
        {
          name: "callerFunc",
          qualifiedName: "callerFunc",
          kind: "function",
          filePath: "src/b.js",
          startLine: 10,
          endLine: 15,
          depth: 1,
        },
      ]);
    });

    it("returns empty if graph traversal returns no nodeIds", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockImplementation((sql, params) => {
        if (sql.includes("FROM repos WHERE")) {
          return Promise.resolve({ rows: [{ id: 42 }] });
        }
        if (sql.includes("SELECT id FROM symbols WHERE")) {
          return Promise.resolve({ rows: [{ id: 501 }] });
        }
        if (sql.includes("WITH RECURSIVE walk")) {
          return Promise.resolve({ rows: [] }); // no nodes reached
        }
        return Promise.reject(new Error("unexpected sql: " + sql));
      });

      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      const results = await queryGraphDb({
        owner: "o",
        repo: "r",
        symbol: "targetFunc",
        direction: "callers",
      });

      expect(results).toEqual([]);
    });

    it("defaults to reading symbols in file when only file is given with callers direction", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      query.mockImplementation((sql, params) => {
        if (sql.includes("FROM repos WHERE")) {
          return Promise.resolve({ rows: [{ id: 42 }] });
        }
        if (sql.includes("SELECT s.id FROM symbols s JOIN files f") && sql.includes("f.path = $2")) {
          return Promise.resolve({ rows: [{ id: 501 }] });
        }
        if (sql.includes("WITH RECURSIVE walk")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.reject(new Error("unexpected sql: " + sql));
      });

      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      const results = await queryGraphDb({
        owner: "o",
        repo: "r",
        file: "src/a.js",
        direction: "callers",
      });

      expect(results).toEqual([]);
    });

    it("scopes the symbol lookup to file when both symbol and file are given (previously file was silently ignored)", async () => {
      const { query } = await import("../connectors/repomap/db.js");
      let capturedSql, capturedParams;
      query.mockImplementation((sql, params) => {
        if (sql.includes("FROM repos WHERE")) {
          return Promise.resolve({ rows: [{ id: 42 }] });
        }
        if (sql.includes("SELECT s.id FROM symbols s JOIN files f") && sql.includes("f.path = $3")) {
          capturedSql = sql;
          capturedParams = params;
          return Promise.resolve({ rows: [{ id: 777 }] });
        }
        if (sql.includes("WITH RECURSIVE walk")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.reject(new Error("unexpected sql: " + sql));
      });

      const { queryGraphDb } = await import("../connectors/repomap/queries.js");
      const results = await queryGraphDb({
        owner: "o",
        repo: "r",
        symbol: "register",
        file: "connectors/repomap/tools.js",
        direction: "callers",
      });

      expect(results).toEqual([]);
      expect(capturedSql).toMatch(/WHERE s\.repo_id = \$1 AND \(s\.name = \$2 OR s\.qualified_name = \$2\) AND f\.path = \$3/);
      expect(capturedParams).toEqual([42, "register", "connectors/repomap/tools.js"]);
    });
  });
});
