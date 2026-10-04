// ---------------------------------------------------------------------------
// test/notion-chart-data.test.js -- pure builders for notion_chart's
// create_from_data action (connectors/notion/chart_data.js) and the dashboard
// pieces of chart_config.js. No I/O, nothing mocked.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { buildDataset, syntheticSchema, DatasetError, MAX_ROWS } from "../connectors/notion/chart_data.js";
import { buildCreateDashboardBody, buildCreateChartViewBody, ChartConfigError } from "../connectors/notion/chart_config.js";

const COLUMNS = [
  { name: "Region", type: "title" },
  { name: "Revenue", type: "number" },
  { name: "Tier", type: "select" },
  { name: "Closed", type: "date" },
  { name: "Won", type: "checkbox" },
  { name: "Notes", type: "text" },
];

const errorsOf = (fn) => { try { fn(); } catch (e) { return e; } throw new Error("expected a throw"); };

describe("buildDataset", () => {
  it("builds the database schema and Notion property values", () => {
    const d = buildDataset({
      database_title: "Sales",
      columns: COLUMNS,
      rows: [{ Region: "EMEA", Revenue: 120, Tier: "A", Closed: "2026-10-04", Won: true, Notes: "ok" }],
    });
    expect(d.title).toBe("Sales");
    expect(d.schema).toEqual({
      Region: { title: {} }, Revenue: { number: {} }, Tier: { select: {} },
      Closed: { date: {} }, Won: { checkbox: {} }, Notes: { rich_text: {} },
    });
    expect(d.rows[0]).toEqual({
      Region: { title: [{ type: "text", text: { content: "EMEA" } }] },
      Revenue: { number: 120 },
      Tier: { select: { name: "A" } },
      Closed: { date: { start: "2026-10-04" } },
      Won: { checkbox: true },
      Notes: { rich_text: [{ type: "text", text: { content: "ok" } }] },
    });
  });

  it("omits empty cells and accepts numeric strings", () => {
    const d = buildDataset({ database_title: "T", columns: COLUMNS.slice(0, 3), rows: [{ Region: "x", Revenue: "3.5", Tier: null }, { Region: "y" }] });
    expect(d.rows[0]).toEqual({ Region: expect.anything(), Revenue: { number: 3.5 } });
    expect(Object.keys(d.rows[1])).toEqual(["Region"]);
  });

  it("collects every problem in one error", () => {
    const e = errorsOf(() => buildDataset({
      database_title: " ",
      columns: [{ name: "A", type: "title" }, { name: "a", type: "number" }, { name: "B", type: "bogus" }],
      rows: [],
    }));
    expect(e).toBeInstanceOf(DatasetError);
    expect(e.message).toMatch(/database_title is required/);
    expect(e.message).toMatch(/duplicate column name/);
    expect(e.message).toMatch(/type must be one of/);
    expect(e.message).toMatch(/rows is required/);
  });

  it("requires exactly one title column", () => {
    expect(errorsOf(() => buildDataset({ database_title: "T", columns: [{ name: "A", type: "number" }], rows: [{}] })).message).toMatch(/exactly one column must have type "title" \(found 0\)/);
    expect(errorsOf(() => buildDataset({ database_title: "T", columns: [{ name: "A", type: "title" }, { name: "B", type: "title" }], rows: [{}] })).message).toMatch(/found 2/);
  });

  it("validates each cell and names the row and column", () => {
    const e = errorsOf(() => buildDataset({
      database_title: "T",
      columns: COLUMNS,
      rows: [
        { Region: "a", Revenue: "abc", Tier: "x,y", Closed: "yesterday", Won: "yes" },
        { Region: "b", Nope: 1 },
        "not an object",
      ],
    }));
    expect(e.message).toMatch(/rows\[0\]\.Revenue must be a number/);
    expect(e.message).toMatch(/rows\[0\]\.Tier can't contain a comma/);
    expect(e.message).toMatch(/rows\[0\]\.Closed must be an ISO date/);
    expect(e.message).toMatch(/rows\[0\]\.Won must be true or false/);
    expect(e.message).toMatch(/rows\[1\]: "Nope" isn't a declared column/);
    expect(e.message).toMatch(/rows\[2\] must be an object/);
  });

  it("rejects an impossible calendar date and over-long text", () => {
    expect(errorsOf(() => buildDataset({ database_title: "T", columns: COLUMNS, rows: [{ Region: "a", Closed: "2026-13-45" }] })).message).toMatch(/must be an ISO date/);
    expect(errorsOf(() => buildDataset({ database_title: "T", columns: COLUMNS, rows: [{ Region: "a".repeat(2001) }] })).message).toMatch(/limit is 2000/);
  });

  it("caps the number of rows and columns", () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, () => ({ Region: "x" }));
    expect(errorsOf(() => buildDataset({ database_title: "T", columns: COLUMNS, rows })).message).toMatch(/too many rows/);
    const cols = Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, type: i ? "text" : "title" }));
    expect(errorsOf(() => buildDataset({ database_title: "T", columns: cols, rows: [{}] })).message).toMatch(/too many columns/);
  });

  it("truncates a long error list but keeps the total", () => {
    const rows = Array.from({ length: 40 }, () => ({ Region: "a", Revenue: "bad" }));
    const e = errorsOf(() => buildDataset({ database_title: "T", columns: COLUMNS, rows }));
    expect(e.errors).toHaveLength(20);
    expect(e.totalErrors).toBe(40);
    expect(e.message).toMatch(/and 20 more/);
  });
});

describe("syntheticSchema", () => {
  it("lets chart settings be validated before the database exists", () => {
    const schema = syntheticSchema(COLUMNS);
    const body = buildCreateChartViewBody(schema, { name: "c", chart_type: "bar", x: "Region", y_aggregator: "sum", y_property: "Revenue", database_id: "x" });
    expect(body.configuration.x_axis.type).toBe("title");
    expect(body.configuration.y_axis).toEqual({ aggregator: "sum", property_id: "Revenue" });
  });

  it("maps declared types to Notion property types so aggregator checks still work", () => {
    expect(() => buildCreateChartViewBody(syntheticSchema(COLUMNS), { name: "c", chart_type: "bar", x: "Region", y_aggregator: "sum", y_property: "Notes" })).toThrow(ChartConfigError);
  });
});

describe("dashboards", () => {
  const schema = { database_id: "db1", data_source_id: "ds1", properties: {}, propertiesById: {} };

  it("builds an empty dashboard body", () => {
    expect(buildCreateDashboardBody(schema, { name: " KPIs " })).toEqual({ data_source_id: "ds1", database_id: "db1", name: "KPIs", type: "dashboard" });
  });

  it("requires a name and rejects chart-only settings", () => {
    const e = errorsOf(() => buildCreateDashboardBody(schema, { chart_type: "column", x: "S", page_id: "p" }));
    expect(e).toBeInstanceOf(ChartConfigError);
    expect(e.message).toMatch(/name is required/);
    expect(e.message).toMatch(/chart_type doesn't apply to dashboards/);
    expect(e.message).toMatch(/page_id doesn't apply/);
  });

  describe("widget placement", () => {
    const PROPS = { Status: { id: "abc1", name: "Status", type: "status" } };
    const s2 = { database_id: "db1", data_source_id: "ds1", properties: PROPS, propertiesById: { abc1: PROPS.Status } };
    const base = { name: "w", chart_type: "column", x: "Status", dashboard_id: "dash1" };

    it("makes the dashboard the parent and defaults placement to Notion's", () => {
      const body = buildCreateChartViewBody(s2, base);
      expect(body.view_id).toBe("dash1");
      expect(body.data_source_id).toBe("ds1");
      expect(body).not.toHaveProperty("database_id");
      expect(body).not.toHaveProperty("create_database");
      expect(body).not.toHaveProperty("placement");
    });

    it("passes new_row and existing_row placements through", () => {
      expect(buildCreateChartViewBody(s2, { ...base, placement: { type: "new_row" } }).placement).toEqual({ type: "new_row" });
      expect(buildCreateChartViewBody(s2, { ...base, placement: { type: "new_row", row_index: 0 } }).placement).toEqual({ type: "new_row", row_index: 0 });
      expect(buildCreateChartViewBody(s2, { ...base, placement: { type: "existing_row", row_index: 2 } }).placement).toEqual({ type: "existing_row", row_index: 2 });
    });

    it("rejects bad placements", () => {
      expect(() => buildCreateChartViewBody(s2, { ...base, placement: { type: "existing_row" } })).toThrow(/row_index is required/);
      expect(() => buildCreateChartViewBody(s2, { ...base, placement: { type: "sideways" } })).toThrow(/placement.type must be/);
      expect(() => buildCreateChartViewBody(s2, { ...base, placement: { type: "new_row", row_index: -1 } })).toThrow(/integer >= 0/);
      expect(() => buildCreateChartViewBody(s2, { ...base, placement: { type: "new_row", row_index: 1.5 } })).toThrow(/integer >= 0/);
    });

    it("can't be combined with page_id, and placement needs dashboard_id", () => {
      expect(() => buildCreateChartViewBody(s2, { ...base, page_id: "p1" })).toThrow(/can't be combined/);
      const { dashboard_id, ...noDash } = base; // eslint-disable-line no-unused-vars
      expect(() => buildCreateChartViewBody(s2, { ...noDash, placement: { type: "new_row" } })).toThrow(/placement only applies together with dashboard_id/);
    });
  });
});
