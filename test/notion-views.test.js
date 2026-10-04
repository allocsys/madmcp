// ---------------------------------------------------------------------------
// test/notion-views.test.js -- Step 2 of the native Notion charts plan:
// connectors/notion/views.js client wrappers. Only notionRequest (the I/O
// boundary) is mocked, same strategy as test/notion-audit-fixes.test.js.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as client from "../connectors/notion/client.js";
import {
  VIEWS_API_VERSION,
  CHART_TYPES,
  createView,
  retrieveView,
  updateView,
  deleteView,
  listViews,
  getDatabaseSchema,
} from "../connectors/notion/views.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockedNotionRequest = vi.fn();
  actual.clientInternals.notionRequest = mockedNotionRequest;
  return { ...actual, notionRequest: mockedNotionRequest };
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("constants", () => {
  it("uses the 2026-03-11 API version and supports the 5 chart types", () => {
    expect(VIEWS_API_VERSION).toBe("2026-03-11");
    expect(CHART_TYPES).toEqual(["column", "bar", "line", "donut", "number"]);
  });
});

describe("view CRUD wrappers", () => {
  it("createView POSTs /views with the version override", async () => {
    client.notionRequest.mockResolvedValue({ id: "v1" });
    const body = { name: "c", type: "chart" };
    await createView(body);
    expect(client.notionRequest).toHaveBeenCalledWith("/views", { method: "POST", body, version: "2026-03-11" });
  });

  it("createView rejects a missing body without calling Notion", () => {
    expect(() => createView()).toThrow(/body is required/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("retrieveView GETs /views/{id} and encodes the id", async () => {
    client.notionRequest.mockResolvedValue({});
    await retrieveView("a b/c");
    expect(client.notionRequest).toHaveBeenCalledWith("/views/a%20b%2Fc", { method: "GET", body: undefined, version: "2026-03-11" });
  });

  it("retrieveView requires a view_id", () => {
    expect(() => retrieveView("")).toThrow(/view_id is required/);
    expect(() => retrieveView("   ")).toThrow(/view_id is required/);
    expect(() => retrieveView(undefined)).toThrow(/view_id is required/);
  });

  it("updateView PATCHes /views/{id}", async () => {
    client.notionRequest.mockResolvedValue({});
    const body = { name: "new" };
    await updateView("v1", body);
    expect(client.notionRequest).toHaveBeenCalledWith("/views/v1", { method: "PATCH", body, version: "2026-03-11" });
  });

  it("updateView requires id and body", () => {
    expect(() => updateView("", { a: 1 })).toThrow(/view_id is required/);
    expect(() => updateView("v1")).toThrow(/body is required/);
  });

  it("deleteView DELETEs /views/{id}", async () => {
    client.notionRequest.mockResolvedValue({ object: "view", id: "v1" });
    await deleteView("v1");
    expect(client.notionRequest).toHaveBeenCalledWith("/views/v1", { method: "DELETE", body: undefined, version: "2026-03-11" });
  });
});

describe("listViews", () => {
  it("lists by database_id", async () => {
    client.notionRequest.mockResolvedValue({ results: [] });
    await listViews({ database_id: "db1" });
    expect(client.notionRequest.mock.calls[0][0]).toBe("/views?database_id=db1");
    expect(client.notionRequest.mock.calls[0][1].version).toBe("2026-03-11");
  });

  it("lists by data_source_id with pagination params", async () => {
    client.notionRequest.mockResolvedValue({ results: [] });
    await listViews({ data_source_id: "ds1", start_cursor: "cur", page_size: 25 });
    expect(client.notionRequest.mock.calls[0][0]).toBe("/views?data_source_id=ds1&start_cursor=cur&page_size=25");
  });

  it("clamps page_size to 1..100", async () => {
    client.notionRequest.mockResolvedValue({ results: [] });
    await listViews({ database_id: "db1", page_size: 500 });
    expect(client.notionRequest.mock.calls[0][0]).toContain("page_size=100");
  });

  it("requires exactly one of database_id / data_source_id", () => {
    expect(() => listViews({})).toThrow(/exactly one/);
    expect(() => listViews()).toThrow(/exactly one/);
    expect(() => listViews({ database_id: "a", data_source_id: "b" })).toThrow(/exactly one/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });
});

describe("getDatabaseSchema", () => {
  const dsProps = {
    Name:   { id: "title", name: "Name", type: "title" },
    Status: { id: "abc1", name: "Status", type: "status" },
    Amount: { id: "def2", name: "Amount", type: "number" },
  };

  function mockDb(sources, props = dsProps) {
    client.notionRequest.mockImplementation(async (path) => {
      if (/^\/databases\/[^/]+$/.test(path)) return { id: "db1", data_sources: sources };
      if (/^\/data_sources\/[^/]+$/.test(path)) return { id: "ds1", properties: props };
      throw new Error(`unexpected path ${path}`);
    });
  }

  it("resolves the single data source and builds name/id property maps", async () => {
    mockDb([{ id: "ds1", name: "Tasks" }]);
    const schema = await getDatabaseSchema("db1");
    expect(schema.database_id).toBe("db1");
    expect(schema.data_source_id).toBe("ds1");
    expect(schema.data_source_name).toBe("Tasks");
    expect(schema.properties.Amount).toMatchObject({ id: "def2", name: "Amount", type: "number" });
    expect(schema.propertiesById.abc1.name).toBe("Status");
    for (const call of client.notionRequest.mock.calls) {
      expect(call[1].version).toBe("2026-03-11");
    }
  });

  it("errors on multiple data sources unless data_source_id is given", async () => {
    mockDb([{ id: "ds1", name: "A" }, { id: "ds2", name: "B" }]);
    await expect(getDatabaseSchema("db1")).rejects.toThrow(/2 data sources; pass data_source_id/);
    const schema = await getDatabaseSchema("db1", { data_source_id: "ds2" });
    expect(schema.data_source_id).toBe("ds2");
  });

  it("errors when data_source_id is not in the database", async () => {
    mockDb([{ id: "ds1", name: "A" }]);
    await expect(getDatabaseSchema("db1", { data_source_id: "nope" })).rejects.toThrow(/not found in database db1/);
  });

  it("errors when the database has no data sources", async () => {
    mockDb([]);
    await expect(getDatabaseSchema("db1")).rejects.toThrow(/no data sources/);
  });

  it("requires a database_id", async () => {
    await expect(getDatabaseSchema("")).rejects.toThrow(/database_id is required/);
  });

  it("falls back to the map key when a property has no name field", async () => {
    mockDb([{ id: "ds1" }], { Foo: { id: "p1", type: "number" } });
    const schema = await getDatabaseSchema("db1");
    expect(schema.properties.Foo.id).toBe("p1");
    expect(schema.data_source_name).toBeNull();
  });
});

describe("retry safety (duplicate-chart protection)", () => {
  it("never retries POST /views on a 5xx, but does for PATCH/DELETE/GET", () => {
    expect(client.isSafeToRetryOnServerError("POST", "/views")).toBe(false);
    expect(client.isSafeToRetryOnServerError("PATCH", "/views/v1")).toBe(true);
    expect(client.isSafeToRetryOnServerError("DELETE", "/views/v1")).toBe(true);
    expect(client.isSafeToRetryOnServerError("GET", "/views/v1")).toBe(true);
  });
});
