// ---------------------------------------------------------------------------
// test/notion-chart-tool.test.js -- Step 4 of the native Notion charts plan:
// the notion_chart tool (connectors/notion/chart_tool.js). Only notionRequest
// (the I/O boundary) is mocked, same strategy as test/notion-views.test.js.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as client from "../connectors/notion/client.js";
import { register, runChartAction, explainChartError } from "../connectors/notion/chart_tool.js";
import { ChartConfigError } from "../connectors/notion/chart_config.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = vi.fn();
  actual.clientInternals.notionRequest = mocked;
  return { ...actual, notionRequest: mocked };
});

const DS_PROPS = {
  Name:   { id: "title", name: "Name", type: "title" },
  Status: { id: "abc1", name: "Status", type: "status" },
  Amount: { id: "def2", name: "Amount", type: "number" },
  Due:    { id: "ghi3", name: "Due", type: "date" },
};

// handlers: [[/^METHOD path/, (path, opts) => response], ...]
function route(handlers) {
  client.notionRequest.mockImplementation(async (path, opts = {}) => {
    const key = `${opts.method || "GET"} ${path}`;
    for (const [re, fn] of handlers) if (re.test(key)) return fn(path, opts);
    throw new Error(`Notion API error (404): no mock for ${key}`);
  });
}

const SCHEMA_ROUTES = [
  [/^GET \/databases\/db1$/, () => ({ id: "db1", data_sources: [{ id: "ds1", name: "Tasks" }] })],
  [/^GET \/data_sources\/ds1$/, () => ({ id: "ds1", properties: DS_PROPS })],
];

const calls = (method) => client.notionRequest.mock.calls.filter(([, o]) => (o?.method || "GET") === method);

function fakeServer() {
  const tools = {};
  return { tool: (name, _desc, _schema, handler) => { tools[name] = { handler, schema: _schema }; }, tools };
}

beforeEach(() => { vi.resetAllMocks(); });

describe("registration", () => {
  it("registers a single notion_chart tool with the expected parameters", () => {
    const server = fakeServer();
    register(server);
    expect(Object.keys(server.tools)).toEqual(["notion_chart"]);
    expect(Object.keys(server.tools.notion_chart.schema)).toEqual(expect.arrayContaining([
      "action", "database_id", "view_id", "page_id", "name", "chart_type", "x", "y_aggregator", "options", "dry_run",
    ]));
  });

  it("the handler returns isError with a readable message instead of throwing", async () => {
    const server = fakeServer();
    register(server);
    const res = await server.tools.notion_chart.handler({ action: "get" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/view_id is required for action "get"/);
  });

  it("the handler returns text on success", async () => {
    route([[/^DELETE \/views\/v1$/, () => ({ object: "view", id: "v1" })]]);
    const server = fakeServer();
    register(server);
    const res = await server.tools.notion_chart.handler({ action: "delete", view_id: "v1" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/Deleted view v1/);
  });
});

describe("create", () => {
  const base = { action: "create", database_id: "db1", name: "Tasks by status", chart_type: "column", x: "Status" };

  it("POSTs /views with the built body and the 2026-03-11 version", async () => {
    route([...SCHEMA_ROUTES, [/^POST \/views$/, () => ({ id: "v-new", url: "https://notion.so/v-new" })]]);
    const text = await runChartAction(base);

    const posts = calls("POST");
    expect(posts).toHaveLength(1);
    const [path, opts] = posts[0];
    expect(path).toBe("/views");
    expect(opts.version).toBe("2026-03-11");
    expect(opts.body).toMatchObject({
      database_id: "db1",
      data_source_id: "ds1",
      name: "Tasks by status",
      type: "chart",
      configuration: {
        type: "chart",
        chart_type: "column",
        x_axis: { type: "status", property_id: "abc1", group_by: "option" },
        y_axis: { aggregator: "count" },
      },
    });
    expect(text).toMatch(/Created chart "Tasks by status" as a view tab on database db1/);
    expect(text).toContain("view id: v-new");
    expect(text).toContain("https://notion.so/v-new");
  });

  it("places the chart inline when page_id is given", async () => {
    route([...SCHEMA_ROUTES, [/^POST \/views$/, () => ({ id: "v2" })]]);
    const text = await runChartAction({ ...base, page_id: "page1", after_block_id: "blk1" });
    const body = calls("POST")[0][1].body;
    expect(body.database_id).toBeUndefined();
    expect(body.create_database).toEqual({
      parent: { type: "page_id", page_id: "page1" },
      position: { type: "after_block", block_id: "blk1" },
    });
    expect(text).toMatch(/inline on page page1/);
  });

  it("resolves a sum aggregator on a number property", async () => {
    route([...SCHEMA_ROUTES, [/^POST \/views$/, () => ({ id: "v3" })]]);
    await runChartAction({ ...base, chart_type: "line", x: "Due", x_group_by: "month", y_aggregator: "sum", y_property: "Amount", options: { smooth_line: true } });
    const config = calls("POST")[0][1].body.configuration;
    expect(config.x_axis).toMatchObject({ type: "date", property_id: "ghi3", group_by: "month" });
    expect(config.y_axis).toEqual({ aggregator: "sum", property_id: "def2" });
    expect(config.smooth_line).toBe(true);
  });

  it("passes data_source_id through to the schema lookup", async () => {
    route([
      [/^GET \/databases\/db1$/, () => ({ id: "db1", data_sources: [{ id: "ds1", name: "A" }, { id: "ds2", name: "B" }] })],
      [/^GET \/data_sources\/ds2$/, () => ({ id: "ds2", properties: DS_PROPS })],
      [/^POST \/views$/, () => ({ id: "v4" })],
    ]);
    await runChartAction({ ...base, data_source_id: "ds2" });
    expect(calls("POST")[0][1].body.data_source_id).toBe("ds2");
  });

  it("dry_run returns the exact body and never POSTs", async () => {
    route(SCHEMA_ROUTES);
    const text = await runChartAction({ ...base, dry_run: true });
    expect(calls("POST")).toHaveLength(0);
    expect(text).toMatch(/^DRY RUN/);
    expect(text).toContain("POST /v1/views (Notion-Version 2026-03-11)");
    const body = JSON.parse(text.slice(text.indexOf("{")));
    expect(body).toMatchObject({ database_id: "db1", name: "Tasks by status", type: "chart" });
    // only read-only lookups happened
    expect(client.notionRequest.mock.calls.every(([, o]) => (o?.method || "GET") === "GET")).toBe(true);
  });

  it("reports every invalid input at once and does not POST", async () => {
    route(SCHEMA_ROUTES);
    const err = await runChartAction({ action: "create", database_id: "db1", chart_type: "column", y_aggregator: "sum", y_property: "Name" }).catch((e) => e);
    expect(err).toBeInstanceOf(ChartConfigError);
    expect(err.errors.length).toBeGreaterThanOrEqual(3); // name, x, sum-on-title
    expect(calls("POST")).toHaveLength(0);
  });

  it("requires database_id", async () => {
    await expect(runChartAction({ action: "create", name: "x", chart_type: "column", x: "Status" })).rejects.toThrow(/database_id is required for action "create"/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });
});

describe("update", () => {
  const CHART_VIEW = { id: "v1", name: "Old", type: "chart", configuration: { type: "chart", chart_type: "line" } };

  it("renames without a schema lookup", async () => {
    route([
      [/^GET \/views\/v1$/, () => CHART_VIEW],
      [/^PATCH \/views\/v1$/, () => ({ id: "v1" })],
    ]);
    const text = await runChartAction({ action: "update", view_id: "v1", name: "New" });
    expect(calls("PATCH")).toHaveLength(1);
    expect(calls("PATCH")[0][1]).toMatchObject({ body: { name: "New" }, version: "2026-03-11" });
    expect(client.notionRequest.mock.calls.some(([p]) => p.startsWith("/databases/"))).toBe(false);
    expect(text).toMatch(/Updated chart v1 \(changed: name\)/);
  });

  it("keeps the existing chart_type when changing settings", async () => {
    route([
      ...SCHEMA_ROUTES,
      [/^GET \/views\/v1$/, () => CHART_VIEW],
      [/^PATCH \/views\/v1$/, () => ({ id: "v1" })],
    ]);
    await runChartAction({ action: "update", view_id: "v1", database_id: "db1", y_aggregator: "average", y_property: "Amount" });
    const body = calls("PATCH")[0][1].body;
    expect(body.configuration).toMatchObject({ type: "chart", chart_type: "line", y_axis: { aggregator: "average", property_id: "def2" } });
  });

  it("needs database_id when property names must be resolved", async () => {
    route([[/^GET \/views\/v1$/, () => CHART_VIEW]]);
    await expect(runChartAction({ action: "update", view_id: "v1", x: "Status" })).rejects.toThrow(/database_id is required for action "update/);
    expect(calls("PATCH")).toHaveLength(0);
  });

  it("refuses to edit a non-chart view", async () => {
    route([[/^GET \/views\/t1$/, () => ({ id: "t1", name: "Table", type: "table" })]]);
    await expect(runChartAction({ action: "update", view_id: "t1", name: "x" })).rejects.toThrow(/is a table view, not a chart/);
    expect(calls("PATCH")).toHaveLength(0);
  });

  it("rejects an update with nothing to change", async () => {
    route([[/^GET \/views\/v1$/, () => CHART_VIEW]]);
    await expect(runChartAction({ action: "update", view_id: "v1" })).rejects.toThrow(/nothing to update/);
  });

  it("dry_run returns the PATCH body and never PATCHes", async () => {
    route([[/^GET \/views\/v1$/, () => CHART_VIEW]]);
    const text = await runChartAction({ action: "update", view_id: "v1", name: "New", dry_run: true });
    expect(calls("PATCH")).toHaveLength(0);
    expect(text).toMatch(/^DRY RUN/);
    expect(text).toContain("PATCH /v1/views/v1");
    expect(JSON.parse(text.slice(text.indexOf("{")))).toEqual({ name: "New" });
  });

  describe("carries over unchanged configuration (Notion doesn't merge)", () => {
    const COLUMN_VIEW = {
      id: "v1", name: "Old", type: "chart",
      configuration: {
        type: "chart", chart_type: "column",
        x_axis: { type: "status", property_id: "abc1", property_name: "Status", group_by: "option", sort: { type: "manual" } },
        y_axis: { aggregator: "sum", property_id: "def2", property_name: "Amount" },
      },
    };
    const patchRoutes = (view) => route([
      ...SCHEMA_ROUTES,
      [/^GET \/views\/v1$/, () => view],
      [/^PATCH \/views\/v1$/, () => ({ id: "v1" })],
    ]);

    it("options-only update re-sends x_axis and y_axis without property_name", async () => {
      patchRoutes(COLUMN_VIEW);
      await runChartAction({ action: "update", view_id: "v1", options: { color_theme: "blue" } });
      expect(calls("PATCH")[0][1].body.configuration).toEqual({
        type: "chart", chart_type: "column", color_theme: "blue",
        x_axis: { type: "status", property_id: "abc1", group_by: "option", sort: { type: "manual" } },
        y_axis: { aggregator: "sum", property_id: "def2" },
      });
    });

    it("explicitly passed settings win over the existing ones", async () => {
      patchRoutes(COLUMN_VIEW);
      await runChartAction({ action: "update", view_id: "v1", database_id: "db1", y_aggregator: "average", y_property: "Amount" });
      const cfg = calls("PATCH")[0][1].body.configuration;
      expect(cfg.y_axis).toEqual({ aggregator: "average", property_id: "def2" });
      expect(cfg.x_axis).toMatchObject({ type: "status", property_id: "abc1" });
    });

    it("carries over stack_by", async () => {
      patchRoutes({ ...COLUMN_VIEW, configuration: { ...COLUMN_VIEW.configuration, stack_by: { type: "status", property_id: "abc1", property_name: "Status", group_by: "group", sort: { type: "manual" } } } });
      await runChartAction({ action: "update", view_id: "v1", options: { color_theme: "blue" } });
      expect(calls("PATCH")[0][1].body.configuration.stack_by).toEqual({ type: "status", property_id: "abc1", group_by: "group", sort: { type: "manual" } });
    });

    it("carries over a number chart's value", async () => {
      patchRoutes({ id: "v1", name: "N", type: "chart", configuration: { type: "chart", chart_type: "number", value: { aggregator: "count" } } });
      await runChartAction({ action: "update", view_id: "v1", options: { hide_title: true } });
      expect(calls("PATCH")[0][1].body.configuration).toMatchObject({ chart_type: "number", value: { aggregator: "count" }, hide_title: true });
    });

    it("does not carry anything over when chart_type changes", async () => {
      patchRoutes(COLUMN_VIEW);
      await runChartAction({ action: "update", view_id: "v1", chart_type: "number" });
      const cfg = calls("PATCH")[0][1].body.configuration;
      expect(cfg).toEqual({ type: "chart", chart_type: "number" });
    });

    it("name-only updates still send no configuration", async () => {
      patchRoutes(COLUMN_VIEW);
      await runChartAction({ action: "update", view_id: "v1", name: "New" });
      expect(calls("PATCH")[0][1].body).toEqual({ name: "New" });
    });

    it("dry_run shows the filled-in body", async () => {
      patchRoutes(COLUMN_VIEW);
      const text = await runChartAction({ action: "update", view_id: "v1", options: { color_theme: "blue" }, dry_run: true });
      expect(JSON.parse(text.slice(text.indexOf("{"))).configuration.x_axis.property_id).toBe("abc1");
      expect(calls("PATCH")).toHaveLength(0);
    });
  });

  it("requires view_id", async () => {
    await expect(runChartAction({ action: "update", name: "x" })).rejects.toThrow(/view_id is required for action "update"/);
  });
});

describe("get", () => {
  it("returns a summary line plus the view JSON", async () => {
    route([[/^GET \/views\/v1$/, () => ({ id: "v1", name: "Chart A", type: "chart", configuration: { type: "chart", chart_type: "donut" } })]]);
    const text = await runChartAction({ action: "get", view_id: "v1" });
    expect(text).toContain("Chart A \u2014 chart/donut \u2014 id: v1");
    expect(text).toContain('"chart_type": "donut"');
  });
});

describe("list", () => {
  it("lists views with details and surfaces the next cursor", async () => {
    route([
      [/^GET \/views\?database_id=db1$/, () => ({ results: [{ object: "view", id: "v1" }, { object: "view", id: "v2" }], has_more: true, next_cursor: "c2" })],
      [/^GET \/views\/v1$/, () => ({ id: "v1", name: "Chart A", type: "chart", configuration: { type: "chart", chart_type: "column" } })],
      [/^GET \/views\/v2$/, () => ({ id: "v2", name: "Table", type: "table" })],
    ]);
    const text = await runChartAction({ action: "list", database_id: "db1" });
    expect(text).toContain("2 view(s):");
    expect(text).toContain("Chart A \u2014 chart/column \u2014 id: v1");
    expect(text).toContain("Table \u2014 table \u2014 id: v2");
    expect(text).toContain('cursor: "c2"');
  });

  it("keeps going when one view's details can't be fetched", async () => {
    route([
      [/^GET \/views\?data_source_id=ds1$/, () => ({ results: [{ id: "v1" }, { id: "v2" }] })],
      [/^GET \/views\/v1$/, () => { throw new Error("Notion API error (404): gone"); }],
      [/^GET \/views\/v2$/, () => ({ id: "v2", name: "Ok", type: "chart", configuration: { chart_type: "bar" } })],
    ]);
    const text = await runChartAction({ action: "list", data_source_id: "ds1" });
    expect(text).toMatch(/id: v1 .*details unavailable/);
    expect(text).toContain("Ok \u2014 chart/bar \u2014 id: v2");
  });

  it("reports when there are no views", async () => {
    route([[/^GET \/views\?database_id=db1$/, () => ({ results: [] })]]);
    expect(await runChartAction({ action: "list", database_id: "db1" })).toBe("No views found.");
  });

  it("requires database_id or data_source_id", async () => {
    await expect(runChartAction({ action: "list" })).rejects.toThrow(/database_id \(or data_source_id\) is required/);
  });

  it("passes cursor and page_size through", async () => {
    route([[/^GET \/views\?database_id=db1&start_cursor=cur&page_size=5$/, () => ({ results: [] })]]);
    await runChartAction({ action: "list", database_id: "db1", cursor: "cur", page_size: 5 });
    expect(client.notionRequest.mock.calls[0][0]).toBe("/views?database_id=db1&start_cursor=cur&page_size=5");
  });
});

describe("delete", () => {
  it("DELETEs the view", async () => {
    route([[/^DELETE \/views\/v1$/, () => ({ object: "view", id: "v1" })]]);
    const text = await runChartAction({ action: "delete", view_id: "v1" });
    expect(calls("DELETE")).toHaveLength(1);
    expect(text).toMatch(/Deleted view v1/);
  });

  it("dry_run makes no Notion call at all", async () => {
    const text = await runChartAction({ action: "delete", view_id: "v1", dry_run: true });
    expect(client.notionRequest).not.toHaveBeenCalled();
    expect(text).toMatch(/^DRY RUN/);
    expect(text).toContain("DELETE /v1/views/v1");
  });
});

describe("runChartAction", () => {
  it("rejects an unknown action", async () => {
    await expect(runChartAction({ action: "explode" })).rejects.toThrow(/invalid action "explode"/);
  });
});

describe("explainChartError", () => {
  it("lists every ChartConfigError problem", () => {
    const text = explainChartError(new ChartConfigError(["name is required", "x is required"]));
    expect(text).toBe("Invalid chart settings (2):\n- name is required\n- x is required");
  });

  it("adds a dry_run hint for Notion validation errors", () => {
    expect(explainChartError(new Error("Notion API error (400): validation_error: body.type invalid"))).toMatch(/dry_run: true/);
  });

  it("adds a capability hint for permission errors", () => {
    expect(explainChartError(new Error("Notion API error (403): restricted_resource"))).toMatch(/capability/);
  });

  it("adds a sharing hint for not-found errors", () => {
    expect(explainChartError(new Error("Notion API error (404): object_not_found"))).toMatch(/shared with the integration/);
  });

  it("passes other errors through unchanged", () => {
    expect(explainChartError(new Error("boom"))).toBe("boom");
  });
});
