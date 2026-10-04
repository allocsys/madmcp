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

  describe("carries over unchanged configuration (Notion replaces it wholesale)", () => {
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

    it("keeps other saved options (height, show_data_labels) when changing one", async () => {
      patchRoutes({ ...COLUMN_VIEW, configuration: { ...COLUMN_VIEW.configuration, color_theme: "green", height: "large", show_data_labels: true } });
      await runChartAction({ action: "update", view_id: "v1", options: { color_theme: "blue" } });
      expect(calls("PATCH")[0][1].body.configuration).toMatchObject({ color_theme: "blue", height: "large", show_data_labels: true });
    });

    it("an explicit null still clears a saved option", async () => {
      patchRoutes({ ...COLUMN_VIEW, configuration: { ...COLUMN_VIEW.configuration, height: "large" } });
      await runChartAction({ action: "update", view_id: "v1", options: { height: null } });
      expect(calls("PATCH")[0][1].body.configuration.height).toBeNull();
    });

    it("keeps saved reference_lines", async () => {
      const lines = [{ id: "r1", value: 5, label: "Goal", color: "red", dash_style: "dash" }];
      patchRoutes({ id: "v1", name: "L", type: "chart", configuration: { type: "chart", chart_type: "line", reference_lines: lines } });
      await runChartAction({ action: "update", view_id: "v1", options: { smooth_line: true } });
      expect(calls("PATCH")[0][1].body.configuration).toMatchObject({ smooth_line: true, reference_lines: lines });
    });

    it("does not carry saved options over when chart_type changes", async () => {
      patchRoutes({ ...COLUMN_VIEW, configuration: { ...COLUMN_VIEW.configuration, height: "large" } });
      await runChartAction({ action: "update", view_id: "v1", chart_type: "number" });
      expect(calls("PATCH")[0][1].body.configuration).toEqual({ type: "chart", chart_type: "number" });
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


describe("create_dashboard", () => {
  it("creates an empty dashboard on the database's data source", async () => {
    route([
      ...SCHEMA_ROUTES,
      [/^POST \/views$/, () => ({ id: "dash1", url: "https://notion.so/dash1" })],
    ]);
    const text = await runChartAction({ action: "create_dashboard", database_id: "db1", name: "KPIs" });
    expect(calls("POST")).toHaveLength(1);
    expect(calls("POST")[0][1]).toMatchObject({ body: { data_source_id: "ds1", database_id: "db1", name: "KPIs", type: "dashboard" }, version: "2026-03-11" });
    expect(calls("POST")[0][1].body).not.toHaveProperty("configuration");
    expect(text).toMatch(/Created empty dashboard "KPIs"/);
    expect(text).toContain("dashboard_id: dash1");
  });

  it("dry_run never POSTs", async () => {
    route(SCHEMA_ROUTES);
    const text = await runChartAction({ action: "create_dashboard", database_id: "db1", name: "KPIs", dry_run: true });
    expect(calls("POST")).toHaveLength(0);
    expect(text).toMatch(/^DRY RUN/);
  });

  it("requires database_id and a name, and rejects chart settings", async () => {
    await expect(runChartAction({ action: "create_dashboard", name: "x" })).rejects.toThrow(/database_id is required for action "create_dashboard"/);
    route(SCHEMA_ROUTES);
    await expect(runChartAction({ action: "create_dashboard", database_id: "db1" })).rejects.toThrow(/name is required/);
    await expect(runChartAction({ action: "create_dashboard", database_id: "db1", name: "x", chart_type: "bar" })).rejects.toThrow(/chart_type doesn't apply to dashboards/);
    expect(calls("POST")).toHaveLength(0);
  });
});

describe("create as a dashboard widget", () => {
  it("adds the chart to the dashboard with the requested placement", async () => {
    route([
      ...SCHEMA_ROUTES,
      [/^POST \/views$/, () => ({ id: "w1" })],
    ]);
    const text = await runChartAction({ action: "create", database_id: "db1", dashboard_id: "dash1", placement: { type: "existing_row", row_index: 0 }, name: "By status", chart_type: "column", x: "Status" });
    const body = calls("POST")[0][1].body;
    expect(body).toMatchObject({ view_id: "dash1", data_source_id: "ds1", type: "chart", placement: { type: "existing_row", row_index: 0 } });
    expect(body).not.toHaveProperty("database_id");
    expect(text).toMatch(/as a widget in dashboard dash1/);
  });

  it("rejects dashboard_id together with page_id before any write", async () => {
    route(SCHEMA_ROUTES);
    await expect(runChartAction({ action: "create", database_id: "db1", dashboard_id: "d", page_id: "p", name: "n", chart_type: "column", x: "Status" })).rejects.toThrow(/can't be combined/);
    expect(calls("POST")).toHaveLength(0);
  });

  it("describes dashboards and widgets in get", async () => {
    route([
      [/^GET \/views\/dash1$/, () => ({ id: "dash1", name: "KPIs", type: "dashboard", data_source_id: null, configuration: { type: "dashboard", rows: [{ id: "r1", widgets: [{ id: "a", view_id: "w1" }, { id: "b", view_id: "w2" }] }] } })],
      [/^GET \/views\/w1$/, () => ({ id: "w1", name: "W", type: "chart", dashboard_view_id: "dash1", configuration: { type: "chart", chart_type: "bar" } })],
    ]);
    expect(await runChartAction({ action: "get", view_id: "dash1" })).toMatch(/KPIs \u2014 dashboard\/1 row\(s\), 2 widget\(s\)/);
    expect(await runChartAction({ action: "get", view_id: "w1" })).toMatch(/chart\/bar \u2014 id: w1, widget of dashboard dash1/);
  });
});

describe("create_from_data", () => {
  const COLUMNS = [{ name: "Region", type: "title" }, { name: "Revenue", type: "number" }];
  const ROWS = [{ Region: "EMEA", Revenue: 120 }, { Region: "APAC", Revenue: 90 }, { Region: "AMER", Revenue: 200 }];
  const ARGS = {
    action: "create_from_data", parent_page_id: "page1", database_title: "Sales", columns: COLUMNS, rows: ROWS,
    chart_type: "bar", x: "Region", y_aggregator: "sum", y_property: "Revenue",
  };
  const NEW_PROPS = { Region: { id: "title", name: "Region", type: "title" }, Revenue: { id: "r3v", name: "Revenue", type: "number" } };

  const routes = (over = {}) => [
    [/^POST \/databases$/, over.db || (() => ({ id: "newdb", url: "https://notion.so/newdb" }))],
    [/^POST \/pages$/, over.page || (() => ({ id: "row" }))],
    [/^GET \/databases\/newdb$/, () => ({ id: "newdb", data_sources: [{ id: "ds2", name: "Sales" }] })],
    [/^GET \/data_sources\/ds2$/, () => ({ id: "ds2", properties: NEW_PROPS })],
    [/^POST \/views$/, over.view || (() => ({ id: "v9", url: "https://notion.so/v9" }))],
  ];

  it("creates the database, inserts the rows, then charts it with the real property ids", async () => {
    route(routes());
    const text = await runChartAction(ARGS);

    const order = client.notionRequest.mock.calls.filter(([, o]) => o?.method === "POST").map(([p]) => p);
    expect(order).toEqual(["/databases", "/pages", "/pages", "/pages", "/views"]);

    const [dbPath, dbOpts] = calls("POST")[0];
    expect(dbPath).toBe("/databases");
    expect(dbOpts.version).toBeUndefined(); // default Notion version, same as notion_create
    expect(dbOpts.body.parent).toEqual({ type: "page_id", page_id: "page1" });
    expect(dbOpts.body.properties).toEqual({ Region: { title: {} }, Revenue: { number: {} } });

    const pageBodies = calls("POST").filter(([p]) => p === "/pages").map(([, o]) => o.body);
    expect(pageBodies[0]).toEqual({
      parent: { type: "database_id", database_id: "newdb" },
      properties: { Region: { title: [{ type: "text", text: { content: "EMEA" } }] }, Revenue: { number: 120 } },
    });

    const viewCall = calls("POST").find(([p]) => p === "/views")[1];
    expect(viewCall.version).toBe("2026-03-11");
    expect(viewCall.body).toMatchObject({
      database_id: "newdb", data_source_id: "ds2", name: "Sales", type: "chart",
      configuration: { chart_type: "bar", x_axis: { type: "title", property_id: "title" }, y_axis: { aggregator: "sum", property_id: "r3v" } },
    });
    expect(text).toMatch(/Created database "Sales" \(id: newdb.*\) with 3 rows and chart "Sales" as a view tab/);
    expect(text).toContain("view id: v9");
  });

  it("uses the given chart name and supports a dashboard widget", async () => {
    route(routes());
    const text = await runChartAction({ ...ARGS, name: "Revenue by region", dashboard_id: "dash1", placement: { type: "new_row" } });
    const body = calls("POST").find(([p]) => p === "/views")[1].body;
    expect(body).toMatchObject({ name: "Revenue by region", view_id: "dash1", placement: { type: "new_row" } });
    expect(body).not.toHaveProperty("database_id");
    expect(text).toMatch(/as a widget in dashboard dash1/);
  });

  it("dry_run writes nothing and shows the plan", async () => {
    route(routes());
    const text = await runChartAction({ ...ARGS, dry_run: true });
    expect(calls("POST")).toHaveLength(0);
    expect(client.notionRequest).not.toHaveBeenCalled();
    expect(text).toMatch(/^DRY RUN/);
    expect(text).toContain("POST /v1/databases");
    expect(text).toContain("POST /v1/pages \u00d7 3");
    expect(text).toContain("POST /v1/views");
  });

  it("rejects bad data before any request", async () => {
    route(routes());
    await expect(runChartAction({ ...ARGS, rows: [{ Region: "x", Revenue: "lots" }] })).rejects.toMatchObject({ name: "DatasetError" });
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("rejects bad chart settings before any write", async () => {
    route(routes());
    await expect(runChartAction({ ...ARGS, x: "Nope" })).rejects.toMatchObject({ name: "ChartConfigError" });
    await expect(runChartAction({ ...ARGS, y_property: "Region" })).rejects.toMatchObject({ name: "ChartConfigError" });
    await expect(runChartAction({ ...ARGS, chart_type: undefined })).rejects.toMatchObject({ name: "ChartConfigError" });
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("requires parent_page_id and refuses database_id", async () => {
    await expect(runChartAction({ ...ARGS, parent_page_id: undefined })).rejects.toThrow(/parent_page_id is required for action "create_from_data"/);
    await expect(runChartAction({ ...ARGS, database_id: "db1" })).rejects.toThrow(/database_id doesn't apply/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("reports what was created if a row fails, and never charts", async () => {
    let n = 0;
    route(routes({ page: () => { n += 1; if (n === 2) throw new Error("Notion API error (400): validation_error"); return { id: "row" }; } }));
    const err = await runChartAction(ARGS).catch((e) => e);
    expect(err.message).toMatch(/Created database newdb/);
    expect(err.message).toMatch(/inserted 1\/3 rows, then row 1 failed/);
    expect(err.message).toMatch(/Nothing was charted/);
    expect(calls("POST").some(([p]) => p === "/views")).toBe(false);
    expect(calls("POST").filter(([p]) => p === "/pages")).toHaveLength(2); // stops at the first failure
  });

  it("reports what was created if the chart fails", async () => {
    route(routes({ view: () => { throw new Error("Notion API error (403): restricted_resource"); } }));
    const err = await runChartAction(ARGS).catch((e) => e);
    expect(err.message).toMatch(/Created database newdb .* with 3 rows, but creating the chart failed/);
    expect(err.message).toMatch(/action "create" and database_id newdb/);
  });

  it("stops if the database itself can't be created", async () => {
    route(routes({ db: () => { throw new Error("Notion API error (404): object_not_found"); } }));
    await expect(runChartAction(ARGS)).rejects.toThrow(/object_not_found/);
    expect(calls("POST")).toHaveLength(1);
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

  it("lists dataset problems", () => {
    const err = Object.assign(new Error("x"), { name: "DatasetError", errors: ["rows[0].A must be a number"], totalErrors: 3 });
    const text = explainChartError(err);
    expect(text).toMatch(/Invalid data \(3\)/);
    expect(text).toContain("- rows[0].A must be a number");
    expect(text.trim().endsWith("- ...")).toBe(true);
  });

  it("passes other errors through unchanged", () => {
    expect(explainChartError(new Error("boom"))).toBe("boom");
  });
});
