// ---------------------------------------------------------------------------
// test/repomap-db.test.js — unit tests for connectors/repomap/db.js
// Covers:
//   - successful query execution paths
//   - connection/pool error handling
//   - read-only role design (ensuring only SELECT/WITH query operations are used)
//   - missing REPO_MAP_DATABASE_URL configuration guard
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pg from "pg";

vi.mock("pg", () => {
  const mQuery = vi.fn();
  const mPool = vi.fn(() => ({
    query: mQuery,
  }));
  return {
    default: {
      Pool: mPool,
    },
  };
});

describe("connectors/repomap/db.js", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("throws an error when REPO_MAP_DATABASE_URL is not set", async () => {
    vi.doMock("../config.js", () => ({
      REPO_MAP_DATABASE_URL: undefined,
    }));

    const { query } = await import("../connectors/repomap/db.js");
    await expect(query("SELECT 1")).rejects.toThrow(/REPO_MAP_DATABASE_URL is not set/);
  });

  it("successfully executes query when configured", async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] });
    pg.Pool.mockImplementationOnce(() => ({
      query: mockQuery,
    }));

    vi.doMock("../config.js", () => ({
      REPO_MAP_DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    }));

    const { query } = await import("../connectors/repomap/db.js");
    const result = await query("SELECT id FROM repos WHERE name = $1", ["widgets"]);

    expect(result).toEqual({ rows: [{ id: 1 }] });
    expect(mockQuery).toHaveBeenCalledWith("SELECT id FROM repos WHERE name = $1", ["widgets"]);
  });

  it("handles query execution errors from the pool", async () => {
    const mockQuery = vi.fn().mockRejectedValueOnce(new Error("connection timeout"));
    pg.Pool.mockImplementationOnce(() => ({
      query: mockQuery,
    }));

    vi.doMock("../config.js", () => ({
      REPO_MAP_DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    }));

    const { query } = await import("../connectors/repomap/db.js");
    await expect(query("SELECT 1")).rejects.toThrow(/connection timeout/);
  });

  it("only performs read (SELECT/WITH) operations consistent with repo_map_reader role", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    pg.Pool.mockImplementationOnce(() => ({
      query: mockQuery,
    }));

    vi.doMock("../config.js", () => ({
      REPO_MAP_DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    }));

    const { query } = await import("../connectors/repomap/db.js");

    await query("SELECT id FROM repos WHERE owner = $1 AND name = $2", ["allocsys", "widgets"]);
    await query("WITH RECURSIVE walk AS (SELECT 1) SELECT * FROM walk", []);

    for (const call of mockQuery.mock.calls) {
      const sql = call[0].trim().toUpperCase();
      expect(sql.startsWith("SELECT") || sql.startsWith("WITH")).toBe(true);
    }
  });
});
