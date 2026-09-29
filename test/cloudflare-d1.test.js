import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/cloudflare/client.js", () => ({
  cfAccountRequest: vi.fn(),
}));

import { cfAccountRequest } from "../connectors/cloudflare/client.js";
import { register as registerD1 } from "../connectors/cloudflare/d1.js";

function makeFakeServer() {
  const tools = {};
  const names = [];
  return {
    tool: (name, _description, _schema, handler) => {
      names.push(name);
      tools[name] = handler;
    },
    tools,
    names,
  };
}

describe("Cloudflare connector - consolidated D1 tools", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerD1(server);
  });

  it("registers the new D1 tools and drops the old names", () => {
    expect(server.names).toEqual(["cf_d1_read", "cf_d1_manage", "cf_d1_query"]);
    for (const old of ["cf_d1_database", "cf_d1_database_create", "cf_d1_database_query", "cf_d1_database_delete"]) {
      expect(server.names).not.toContain(old);
    }
  });

  describe("cf_d1_read 'get'", () => {
    it("requires database_id", async () => {
      const result = await server.tools.cf_d1_read({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires database_id");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("requests /d1/database/{id} and returns compact JSON", async () => {
      const data = { uuid: "abc", name: "db" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_d1_read({ action: "get", database_id: "abc" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/d1/database/abc");
      expect(result.content[0].text).toBe(JSON.stringify(data));
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("404 not found"));
      await expect(server.tools.cf_d1_read({ action: "get", database_id: "x" })).rejects.toThrow("404 not found");
    });
  });

  describe("cf_d1_read 'list'", () => {
    it("requests /d1/database with no query string by default", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_d1_read({ action: "list" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/d1/database");
    });

    it("passes name, page and per_page as query params", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_d1_read({ action: "list", name: "prod", page: 2, per_page: 5 });
      expect(cfAccountRequest).toHaveBeenCalledWith("/d1/database?name=prod&page=2&per_page=5");
    });

    it("ignores database_id when listing", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_d1_read({ action: "list", database_id: "abc" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/d1/database");
    });
  });

  describe("cf_d1_manage 'create'", () => {
    it("requires name", async () => {
      const result = await server.tools.cf_d1_manage({ action: "create" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires name");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("POSTs name and primary_location_hint", async () => {
      const data = { uuid: "new" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_d1_manage({ action: "create", name: "db", primary_location_hint: "weur" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/d1/database", {
        method: "POST",
        body: { name: "db", primary_location_hint: "weur" },
      });
      expect(result.content[0].text).toBe(JSON.stringify(data));
    });
  });

  describe("cf_d1_query", () => {
    it("POSTs sql and params to /d1/database/{id}/query", async () => {
      cfAccountRequest.mockResolvedValueOnce({ results: [] });
      await server.tools.cf_d1_query({ database_id: "abc", sql: "SELECT ?", params: ["1"] });
      expect(cfAccountRequest).toHaveBeenCalledWith("/d1/database/abc/query", {
        method: "POST",
        body: { sql: "SELECT ?", params: ["1"] },
      });
    });

    it("caps rows per statement at 50 by default and reports what was omitted", async () => {
      const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));
      cfAccountRequest.mockResolvedValueOnce([{ results: rows, success: true }]);
      const result = await server.tools.cf_d1_query({ database_id: "abc", sql: "SELECT id FROM t" });
      const out = JSON.parse(result.content[0].text);
      expect(out[0].results).toHaveLength(50);
      expect(out[0].rows_omitted).toBe(70);
      expect(out[0].note).toContain("50 of 120");
    });

    it("honours max_rows, and 0 disables the row cap", async () => {
      const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));
      cfAccountRequest.mockResolvedValueOnce([{ results: rows }]);
      let out = JSON.parse((await server.tools.cf_d1_query({ database_id: "abc", sql: "x", max_rows: 5 })).content[0].text);
      expect(out[0].results).toHaveLength(5);

      cfAccountRequest.mockResolvedValueOnce([{ results: rows }]);
      out = JSON.parse((await server.tools.cf_d1_query({ database_id: "abc", sql: "x", max_rows: 0 })).content[0].text);
      expect(out[0].results).toHaveLength(120);
      expect(out[0].rows_omitted).toBeUndefined();
    });

    it("count_only returns row_count per statement and no rows", async () => {
      const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));
      cfAccountRequest.mockResolvedValueOnce([
        { results: rows, success: true, meta: { duration: 1 } },
        { results: [], success: true },
      ]);
      const result = await server.tools.cf_d1_query({ database_id: "abc", sql: "x", count_only: true });
      const out = JSON.parse(result.content[0].text);
      expect(out).toEqual([
        { success: true, meta: { duration: 1 }, row_count: 120 },
        { success: true, row_count: 0 },
      ]);
    });

    it("count_only leaves non-row statements untouched", async () => {
      const data = [{ success: true, meta: { changes: 3 } }];
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_d1_query({ database_id: "abc", sql: "UPDATE t SET a=1", count_only: true });
      expect(result.content[0].text).toBe(JSON.stringify(data));
    });

    it("leaves small results untouched", async () => {
      const data = [{ results: [{ id: 1 }], success: true }];
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_d1_query({ database_id: "abc", sql: "x" });
      expect(result.content[0].text).toBe(JSON.stringify(data));
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("400 bad sql"));
      await expect(
        server.tools.cf_d1_query({ database_id: "abc", sql: "oops" })
      ).rejects.toThrow("400 bad sql");
    });
  });
});
