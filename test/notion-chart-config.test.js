// ---------------------------------------------------------------------------
// test/notion-chart-config.test.js -- Step 3 of the native Notion charts plan:
// pure chart config builders in connectors/notion/chart_config.js. No mocks
// needed (the module has no I/O).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  CHART_TYPES,
  AGGREGATORS,
  ChartConfigError,
  resolveProperty,
  buildChartConfig,
  buildCreateChartViewBody,
  buildUpdateChartViewBody,
} from "../connectors/notion/chart_config.js";

function makeSchema(list) {
  const properties = {};
  const propertiesById = {};
  for (const p of list) {
    properties[p.name] = p;
    propertiesById[p.id] = p;
  }
  return { database_id: "db1", data_source_id: "ds1", data_source_name: "Tasks", properties, propertiesById };
}

const schema = makeSchema([
  { id: "title", name: "Name",     type: "title" },
  { id: "st1",   name: "Status",   type: "status" },
  { id: "pr1",   name: "Priority", type: "select" },
  { id: "tg1",   name: "Tags",     type: "multi_select" },
  { id: "am1",   name: "Amount",   type: "number" },
  { id: "dn1",   name: "Done",     type: "checkbox" },
  { id: "du1",   name: "Due",      type: "date" },
  { id: "nt1",   name: "Notes",    type: "rich_text" },
  { id: "pp1",   name: "Owner",    type: "people" },
  { id: "fm1",   name: "Calc",     type: "formula" },
  { id: "fl1",   name: "Files",    type: "files" },
]);

function errorsOf(fn) {
  try { fn(); } catch (e) { return e; }
  throw new Error("expected function to throw");
}

describe("constants", () => {
  it("exposes the 5 chart types and all documented aggregators", () => {
    expect(CHART_TYPES).toEqual(["column", "bar", "line", "donut", "number"]);
    expect(AGGREGATORS).toHaveLength(20);
    expect(AGGREGATORS).toContain("count");
    expect(AGGREGATORS).toContain("percent_unchecked");
    expect(AGGREGATORS).toContain("date_range");
  });
});

describe("resolveProperty", () => {
  it("resolves by exact name, by id, and by unique case-insensitive name", () => {
    expect(resolveProperty(schema, "Priority").id).toBe("pr1");
    expect(resolveProperty(schema, "pr1").name).toBe("Priority");
    expect(resolveProperty(schema, "priority").id).toBe("pr1");
    expect(resolveProperty(schema, "  Priority ").id).toBe("pr1");
  });

  it("lists available properties when not found", () => {
    expect(() => resolveProperty(schema, "Nope")).toThrow(/not found\. Available: .*Priority \(select\)/);
  });

  it("rejects an empty reference", () => {
    expect(() => resolveProperty(schema, "")).toThrow(/empty/);
    expect(() => resolveProperty(schema, undefined)).toThrow(/empty/);
  });

  it("reports ambiguous case-insensitive matches", () => {
    const s = makeSchema([
      { id: "a", name: "Cost", type: "number" },
      { id: "b", name: "cost", type: "number" },
    ]);
    expect(resolveProperty(s, "Cost").id).toBe("a"); // exact wins
    expect(() => resolveProperty(s, "COST")).toThrow(/ambiguous/);
  });
});

describe("buildChartConfig: grouped charts", () => {
  it("column count by select", () => {
    expect(buildChartConfig(schema, { chart_type: "column", x: "Priority" })).toEqual({
      type: "chart",
      chart_type: "column",
      x_axis: { type: "select", property_id: "pr1", sort: { type: "manual" } },
      y_axis: { aggregator: "count" },
    });
  });

  it("sum of a number property grouped by status (default group_by option)", () => {
    const c = buildChartConfig(schema, { chart_type: "bar", x: "Status", y_aggregator: "sum", y_property: "Amount" });
    expect(c.x_axis).toEqual({ type: "status", property_id: "st1", group_by: "option", sort: { type: "manual" } });
    expect(c.y_axis).toEqual({ aggregator: "sum", property_id: "am1" });
  });

  it("status can group by status group", () => {
    const c = buildChartConfig(schema, { chart_type: "donut", x: "Status", x_group_by: "group" });
    expect(c.x_axis.group_by).toBe("group");
    expect(() => buildChartConfig(schema, { chart_type: "donut", x: "Status", x_group_by: "week" })).toThrow(/status property must be/);
  });

  it("date x defaults to month + ascending, and accepts overrides", () => {
    const c = buildChartConfig(schema, { chart_type: "line", x: "Due" });
    expect(c.x_axis).toEqual({ type: "date", property_id: "du1", group_by: "month", sort: { type: "ascending" } });
    const w = buildChartConfig(schema, { chart_type: "line", x: "Due", x_group_by: "week", x_sort: "descending" });
    expect(w.x_axis.group_by).toBe("week");
    expect(w.x_axis.sort).toEqual({ type: "descending" });
    expect(() => buildChartConfig(schema, { chart_type: "line", x: "Due", x_group_by: "decade" })).toThrow(/date property must be/);
  });

  it("maps rich_text -> text, people -> person, title -> title", () => {
    expect(buildChartConfig(schema, { chart_type: "bar", x: "Notes" }).x_axis).toEqual({ type: "text", property_id: "nt1", group_by: "exact", sort: { type: "ascending" } });
    expect(buildChartConfig(schema, { chart_type: "bar", x: "Owner" }).x_axis).toEqual({ type: "person", property_id: "pp1", sort: { type: "manual" } });
    expect(buildChartConfig(schema, { chart_type: "bar", x: "Name", x_group_by: "alphabet_prefix" }).x_axis.group_by).toBe("alphabet_prefix");
    expect(() => buildChartConfig(schema, { chart_type: "bar", x: "Notes", x_group_by: "month" })).toThrow(/text property must be/);
  });

  it("number x supports bucket ranges, validated", () => {
    const c = buildChartConfig(schema, { chart_type: "column", x: "Amount", x_range: { start: 0, end: 100, size: 10 } });
    expect(c.x_axis).toEqual({ type: "number", property_id: "am1", range_start: 0, range_end: 100, range_size: 10, sort: { type: "ascending" } });
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Amount", x_range: { size: 0 } })).toThrow(/range\.size must be a number >= 1/);
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Priority", x_range: { size: 5 } })).toThrow(/range only applies to number/);
  });

  it("rejects group_by on property types that don't take one", () => {
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Priority", x_group_by: "exact" })).toThrow(/group_by doesn't apply to select/);
  });

  it("rejects invalid x_sort", () => {
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Priority", x_sort: "random" })).toThrow(/sort must be one of/);
  });

  it("rejects x types that can't group (formula, files)", () => {
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Calc" })).toThrow(/type formula, which can't group a chart/);
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Files" })).toThrow(/type files/);
  });

  it("requires x for grouped charts and an existing property", () => {
    expect(() => buildChartConfig(schema, { chart_type: "column" })).toThrow(/x is required for column charts/);
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Nope" })).toThrow(/x: Property "Nope" not found/);
  });
});

describe("buildChartConfig: aggregation", () => {
  const cfg = (extra) => buildChartConfig(schema, { chart_type: "column", x: "Priority", ...extra });

  it("count takes no property", () => {
    expect(() => cfg({ y_aggregator: "count", y_property: "Amount" })).toThrow(/count.*doesn't take a property/);
  });

  it("other aggregators require a property", () => {
    expect(() => cfg({ y_aggregator: "sum" })).toThrow(/"sum" requires a property/);
  });

  it("numeric aggregators need a number property (formula/rollup allowed)", () => {
    expect(cfg({ y_aggregator: "average", y_property: "Amount" }).y_axis).toEqual({ aggregator: "average", property_id: "am1" });
    expect(cfg({ y_aggregator: "max", y_property: "Calc" }).y_axis.property_id).toBe("fm1");
    expect(() => cfg({ y_aggregator: "sum", y_property: "Priority" })).toThrow(/needs a number property, but "Priority" is select/);
  });

  it("checkbox and date aggregators check the property type", () => {
    expect(cfg({ y_aggregator: "percent_checked", y_property: "Done" }).y_axis).toEqual({ aggregator: "percent_checked", property_id: "dn1" });
    expect(() => cfg({ y_aggregator: "checked", y_property: "Amount" })).toThrow(/needs a checkbox property/);
    expect(cfg({ y_aggregator: "latest_date", y_property: "Due" }).y_axis.aggregator).toBe("latest_date");
    expect(() => cfg({ y_aggregator: "earliest_date", y_property: "Amount" })).toThrow(/needs a date property/);
  });

  it("generic aggregators work on any property", () => {
    expect(cfg({ y_aggregator: "percent_not_empty", y_property: "Notes" }).y_axis).toEqual({ aggregator: "percent_not_empty", property_id: "nt1" });
    expect(cfg({ y_aggregator: "unique", y_property: "Owner" }).y_axis.aggregator).toBe("unique");
  });

  it("rejects unknown aggregators", () => {
    expect(() => cfg({ y_aggregator: "mode" })).toThrow(/unknown aggregator "mode"/);
  });
});

describe("buildChartConfig: number charts", () => {
  it("defaults to count and has no x/y axes", () => {
    expect(buildChartConfig(schema, { chart_type: "number" })).toEqual({ type: "chart", chart_type: "number", value: { aggregator: "count" } });
  });

  it("supports a property aggregation", () => {
    expect(buildChartConfig(schema, { chart_type: "number", y_aggregator: "sum", y_property: "Amount" }).value).toEqual({ aggregator: "sum", property_id: "am1" });
  });

  it("rejects x / stack_by", () => {
    const e = errorsOf(() => buildChartConfig(schema, { chart_type: "number", x: "Priority", stack_by: "Status" }));
    expect(e).toBeInstanceOf(ChartConfigError);
    expect(e.errors).toHaveLength(2);
    expect(e.message).toMatch(/x doesn't apply to number charts/);
    expect(e.message).toMatch(/stack_by doesn't apply to number charts/);
  });
});

describe("buildChartConfig: stack_by", () => {
  it("adds stack_by for column/bar/line", () => {
    const c = buildChartConfig(schema, { chart_type: "column", x: "Priority", stack_by: "Status", stack_group_by: "group" });
    expect(c.stack_by).toEqual({ type: "status", property_id: "st1", group_by: "group", sort: { type: "manual" } });
  });

  it("rejects stack_by on donut", () => {
    expect(() => buildChartConfig(schema, { chart_type: "donut", x: "Priority", stack_by: "Status" })).toThrow(/stack_by only applies to column\/bar\/line/);
  });

  it("validates the stack_by property", () => {
    expect(() => buildChartConfig(schema, { chart_type: "bar", x: "Priority", stack_by: "Calc" })).toThrow(/stack_by: property "Calc"/);
  });
});

describe("buildChartConfig: options", () => {
  const cfg = (options, type = "column") => buildChartConfig(schema, { chart_type: type, x: "Priority", options });

  it("passes valid options through", () => {
    const c = cfg({ color_theme: "blue", height: "large", show_data_labels: true, color_by_value: true, group_style: "percent", caption: "Q4", y_axis_min: 0, y_axis_max: 100, sort: "y_descending", grid_lines: "both", legend_position: "off", axis_labels: "both", hide_empty_groups: true });
    expect(c).toMatchObject({ color_theme: "blue", height: "large", show_data_labels: true, color_by_value: true, group_style: "percent", caption: "Q4", y_axis_min: 0, y_axis_max: 100, sort: "y_descending", grid_lines: "both", legend_position: "off", axis_labels: "both", hide_empty_groups: true });
  });

  it("line-, donut- and number-specific options", () => {
    expect(cfg({ smooth_line: true, cumulative: false, hide_line_fill_area: true }, "line")).toMatchObject({ smooth_line: true, cumulative: false, hide_line_fill_area: true });
    expect(cfg({ donut_labels: "name_and_value" }, "donut").donut_labels).toBe("name_and_value");
    expect(buildChartConfig(schema, { chart_type: "number", options: { hide_title: true } }).hide_title).toBe(true);
  });

  it("rejects type-specific options on the wrong chart type", () => {
    expect(() => cfg({ smooth_line: true }, "column")).toThrow(/"smooth_line" only applies to line charts/);
    expect(() => cfg({ color_by_value: true }, "line")).toThrow(/"color_by_value" only applies to column\/bar charts/);
    expect(() => cfg({ donut_labels: "value" }, "bar")).toThrow(/only applies to donut/);
    expect(() => cfg({ hide_title: true }, "column")).toThrow(/only applies to number/);
  });

  it("rejects unknown options and wrong value types", () => {
    expect(() => cfg({ colour: "blue" })).toThrow(/unknown option "colour"/);
    expect(() => cfg({ color_theme: "neon" })).toThrow(/"color_theme" must be one of/);
    expect(() => cfg({ show_data_labels: "yes" })).toThrow(/must be true or false/);
    expect(() => cfg({ y_axis_min: "0" })).toThrow(/must be a number/);
    expect(() => cfg({ caption: 5 })).toThrow(/must be a string/);
    expect(() => buildChartConfig(schema, { chart_type: "column", x: "Priority", options: [] })).toThrow(/options must be an object/);
  });

  it("allows null to clear a setting", () => {
    expect(cfg({ caption: null }).caption).toBeNull();
  });

  it("validates reference_lines", () => {
    const line = { value: 100, label: "Target", color: "red", dash_style: "dash" };
    expect(cfg({ reference_lines: [line] }).reference_lines).toEqual([line]);
    expect(cfg({ reference_lines: [{ ...line, id: "r1" }] }).reference_lines[0].id).toBe("r1");
    expect(() => cfg({ reference_lines: "x" })).toThrow(/must be an array/);
    const e = errorsOf(() => cfg({ reference_lines: [{ value: "1", color: "mauve", dash_style: "dotted" }] }));
    expect(e.errors).toHaveLength(4); // value, label, color, dash_style
  });
});

describe("buildChartConfig: general", () => {
  it("rejects an invalid chart_type", () => {
    expect(() => buildChartConfig(schema, { chart_type: "pie", x: "Priority" })).toThrow(/chart_type must be one of/);
    expect(() => buildChartConfig(schema, {})).toThrow(/chart_type must be one of/);
  });

  it("reports every problem in one error", () => {
    const e = errorsOf(() => buildChartConfig(schema, { chart_type: "line", x: "Nope", y_aggregator: "sum", y_property: "Priority", options: { color_theme: "neon" } }));
    expect(e).toBeInstanceOf(ChartConfigError);
    expect(e.errors).toHaveLength(3);
  });

  it("partial mode only includes provided parts", () => {
    expect(buildChartConfig(schema, { chart_type: "column", options: { color_theme: "green" } }, { partial: true })).toEqual({ type: "chart", chart_type: "column", color_theme: "green" });
    const c = buildChartConfig(schema, { chart_type: "column", x: "Priority" }, { partial: true });
    expect(c.x_axis.property_id).toBe("pr1");
    expect(c.y_axis).toBeUndefined();
    const y = buildChartConfig(schema, { chart_type: "column", y_aggregator: "sum", y_property: "Amount" }, { partial: true });
    expect(y.y_axis).toEqual({ aggregator: "sum", property_id: "am1" });
    expect(y.x_axis).toBeUndefined();
  });
});

describe("buildCreateChartViewBody", () => {
  const base = { name: "Tasks by priority", chart_type: "column", x: "Priority" };

  it("places the chart as a tab on the database by default", () => {
    const b = buildCreateChartViewBody(schema, base);
    expect(b).toEqual({
      data_source_id: "ds1",
      name: "Tasks by priority",
      type: "chart",
      configuration: buildChartConfig(schema, base),
      database_id: "db1",
    });
    expect(b.create_database).toBeUndefined();
  });

  it("places it inline on a page via create_database, with optional position", () => {
    const b = buildCreateChartViewBody(schema, { ...base, page_id: "page1", after_block_id: "blk1" });
    expect(b.create_database).toEqual({ parent: { type: "page_id", page_id: "page1" }, position: { type: "after_block", block_id: "blk1" } });
    expect(b.database_id).toBeUndefined();
    const plain = buildCreateChartViewBody(schema, { ...base, page_id: "page1" });
    expect(plain.create_database).toEqual({ parent: { type: "page_id", page_id: "page1" } });
  });

  it("passes a filter through", () => {
    const filter = { property: "Status", status: { equals: "Done" } };
    expect(buildCreateChartViewBody(schema, { ...base, filter }).filter).toEqual(filter);
  });

  it("requires a name and rejects bad placement/filter, aggregating errors", () => {
    const e = errorsOf(() => buildCreateChartViewBody(schema, { chart_type: "column", x: "Nope", after_block_id: "b", filter: [] }));
    expect(e.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/name is required/),
      expect.stringMatching(/filter must be a Notion filter object/),
      expect.stringMatching(/after_block_id only applies together with page_id/),
      expect.stringMatching(/x: Property "Nope" not found/),
    ]));
  });
});

describe("buildUpdateChartViewBody", () => {
  it("updates just the name without touching configuration", () => {
    expect(buildUpdateChartViewBody(schema, { name: "New" })).toEqual({ name: "New" });
  });

  it("clears or sets a filter", () => {
    expect(buildUpdateChartViewBody(schema, { filter: null })).toEqual({ filter: null });
    const filter = { property: "Done", checkbox: { equals: true } };
    expect(buildUpdateChartViewBody(schema, { filter })).toEqual({ filter });
  });

  it("builds a partial configuration using the existing chart type", () => {
    const b = buildUpdateChartViewBody(schema, { options: { color_theme: "purple" } }, "bar");
    expect(b).toEqual({ configuration: { type: "chart", chart_type: "bar", color_theme: "purple" } });
  });

  it("changing x resolves it against the schema", () => {
    const b = buildUpdateChartViewBody(schema, { x: "Status" }, "column");
    expect(b.configuration.x_axis.property_id).toBe("st1");
  });

  it("input chart_type overrides the existing one", () => {
    const b = buildUpdateChartViewBody(schema, { chart_type: "line", options: { smooth_line: true } }, "column");
    expect(b.configuration.chart_type).toBe("line");
  });

  it("needs a chart type when changing configuration", () => {
    expect(() => buildUpdateChartViewBody(schema, { options: { color_theme: "blue" } })).toThrow(/chart_type must be one of/);
  });

  it("errors when there is nothing to update", () => {
    expect(() => buildUpdateChartViewBody(schema, {})).toThrow(/nothing to update/);
    expect(() => buildUpdateChartViewBody(schema, { name: "  " })).toThrow(/name can't be empty/);
  });
});
