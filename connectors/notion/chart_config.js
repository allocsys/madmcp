// ---------------------------------------------------------------------------
// connectors/notion/chart_config.js
//
// Pure functions (no I/O, no imports) that turn friendly chart input into the
// request bodies for the Notion Views API (type: "chart"). Step 3 of the plan
// "Plan: Native Notion charts in madmcp" (entity_id:
// plan-madmcp-notion-charts). Wired into the notion_chart tool in Step 4.
//
// Everything here takes a `schema` as returned by getDatabaseSchema()
// (views.js): { database_id, data_source_id, properties (by name),
// propertiesById }.
//
// Scope: "grouped data" charts (x_axis grouping + y_axis aggregation) for
// column/bar/line/donut, and "number" charts (single aggregated value).
// Notion's "results" mode (x_axis_property_id / y_axis_property_id, raw
// values) is intentionally not supported yet -- see the plan's follow-ups.
//
// Validation collects ALL problems and throws once, so a caller sees every
// mistake in a single round trip instead of fixing them one at a time.
// ---------------------------------------------------------------------------

export const CHART_TYPES = ["column", "bar", "line", "donut", "number"];
const GROUPED_TYPES   = ["column", "bar", "line", "donut"];
const STACKABLE_TYPES = ["column", "bar", "line"];

const NUMERIC_AGG  = ["sum", "average", "median", "min", "max", "range"];
const CHECKBOX_AGG = ["checked", "unchecked", "percent_checked", "percent_unchecked"];
const DATE_AGG     = ["earliest_date", "latest_date", "date_range"];
const ANY_AGG      = ["count_values", "unique", "empty", "not_empty", "percent_empty", "percent_not_empty"];
export const AGGREGATORS = ["count", ...ANY_AGG, ...NUMERIC_AGG, ...CHECKBOX_AGG, ...DATE_AGG];

// formula/rollup can produce numbers, but their result type isn't visible in
// the schema, so they're allowed for numeric aggregators (Notion validates).
const NUMERIC_PROP_TYPES = ["number", "formula", "rollup"];
const DATE_PROP_TYPES    = ["date", "created_time", "last_edited_time"];

// Notion property type -> group-by `type`. Types missing here (formula,
// rollup, files, button, unique_id, ...) can't be used for x_axis/stack_by:
// a formula group-by needs the formula's result type, which the schema
// doesn't expose.
const GROUP_TYPE = {
  title: "title", rich_text: "text", url: "url", email: "email", phone_number: "phone_number",
  number: "number", select: "select", multi_select: "multi_select", status: "status",
  people: "person", created_by: "created_by", last_edited_by: "last_edited_by",
  relation: "relation", date: "date", created_time: "created_time",
  last_edited_time: "last_edited_time", checkbox: "checkbox",
};
const TEXT_GROUP_TYPES = ["title", "text", "url", "email", "phone_number"];
const DATE_GROUP_TYPES = ["date", "created_time", "last_edited_time"];

const GROUP_SORTS = ["manual", "ascending", "descending"];

const ENUMS = {
  sort:            ["manual", "x_ascending", "x_descending", "y_ascending", "y_descending"],
  color_theme:     ["gray", "blue", "yellow", "green", "purple", "teal", "orange", "pink", "red", "auto", "colorful"],
  height:          ["small", "medium", "large", "extra_large"],
  legend_position: ["off", "bottom", "side"],
  axis_labels:     ["none", "x_axis", "y_axis", "both"],
  grid_lines:      ["none", "horizontal", "vertical", "both"],
  group_style:     ["normal", "percent", "side_by_side"],
  donut_labels:    ["none", "value", "name", "name_and_value"],
};
const BOOLEAN_OPTIONS = ["hide_empty_groups", "show_data_labels", "color_by_value", "cumulative", "smooth_line", "hide_line_fill_area", "hide_title"];
const NUMBER_OPTIONS  = ["y_axis_min", "y_axis_max"];
const STRING_OPTIONS  = ["caption"];
// Only the options Notion documents as chart-type-specific are restricted
// here; everything else is passed through and left to Notion to validate.
const TYPE_SPECIFIC = {
  color_by_value:      ["column", "bar"],
  group_style:         ["column", "bar"],
  cumulative:          ["line"],
  smooth_line:         ["line"],
  hide_line_fill_area: ["line"],
  donut_labels:        ["donut"],
  hide_title:          ["number"],
};
export const OPTION_KEYS = [...Object.keys(ENUMS), ...BOOLEAN_OPTIONS, ...NUMBER_OPTIONS, ...STRING_OPTIONS, "reference_lines"];

const REF_LINE_COLORS = ["gray", "lightgray", "brown", "yellow", "orange", "green", "blue", "purple", "pink", "red"];
const REF_LINE_DASH   = ["solid", "dash"];

// Input keys that make up the chart `configuration` (vs name/filter/placement).
const CONFIG_INPUT_KEYS = ["chart_type", "x", "x_group_by", "x_sort", "x_range", "y_aggregator", "y_property", "stack_by", "stack_group_by", "options"];

export class ChartConfigError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.name = "ChartConfigError";
    this.errors = errors;
  }
}

function throwIfErrors(errs) {
  if (errs.length) throw new ChartConfigError(errs);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Property resolution: exact name, then property ID, then a unique
// case-insensitive name match.
export function resolveProperty(schema, ref) {
  const key = String(ref ?? "").trim();
  if (!key) throw new Error("property reference is empty");
  if (schema.properties[key]) return schema.properties[key];
  if (schema.propertiesById[key]) return schema.propertiesById[key];
  const lower = key.toLowerCase();
  const matches = Object.values(schema.properties).filter((p) => p.name.toLowerCase() === lower);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Property "${key}" is ambiguous (matches: ${matches.map((m) => m.name).join(", ")})`);
  }
  const available = Object.values(schema.properties).map((p) => `${p.name} (${p.type})`).join(", ");
  throw new Error(`Property "${key}" not found. Available: ${available}`);
}

function tryResolve(schema, ref, label, errs) {
  try {
    return resolveProperty(schema, ref);
  } catch (err) {
    errs.push(`${label}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Group-by (x_axis / stack_by)
function defaultGroupSort(type) {
  return [...DATE_GROUP_TYPES, ...TEXT_GROUP_TYPES, "number"].includes(type) ? "ascending" : "manual";
}

function buildGroupBy(prop, { group_by, sort, range } = {}, label, errs) {
  const type = GROUP_TYPE[prop.type];
  if (!type) {
    errs.push(`${label}: property "${prop.name}" has type ${prop.type}, which can't group a chart (supported types: ${Object.keys(GROUP_TYPE).join(", ")})`);
    return null;
  }
  const out = { type, property_id: prop.id };
  const before = errs.length;

  if (type === "status") {
    const gb = group_by ?? "option";
    if (!["group", "option"].includes(gb)) errs.push(`${label}: group_by for a status property must be "group" or "option" (got "${gb}")`);
    out.group_by = gb;
  } else if (DATE_GROUP_TYPES.includes(type)) {
    const gb = group_by ?? "month";
    if (!["relative", "day", "week", "month", "year"].includes(gb)) errs.push(`${label}: group_by for a date property must be relative, day, week, month or year (got "${gb}")`);
    out.group_by = gb;
  } else if (TEXT_GROUP_TYPES.includes(type)) {
    const gb = group_by ?? "exact";
    if (!["exact", "alphabet_prefix"].includes(gb)) errs.push(`${label}: group_by for a text property must be "exact" or "alphabet_prefix" (got "${gb}")`);
    out.group_by = gb;
  } else if (group_by !== undefined && group_by !== null) {
    errs.push(`${label}: group_by doesn't apply to ${prop.type} properties`);
  }

  if (range !== undefined && range !== null) {
    if (type !== "number") {
      errs.push(`${label}: range only applies to number properties`);
    } else if (!isObj(range)) {
      errs.push(`${label}: range must be an object {start, end, size}`);
    } else {
      const { start, end, size } = range;
      if (start !== undefined) { if (typeof start === "number" && Number.isFinite(start)) out.range_start = start; else errs.push(`${label}: range.start must be a number`); }
      if (end !== undefined)   { if (typeof end === "number" && Number.isFinite(end)) out.range_end = end; else errs.push(`${label}: range.end must be a number`); }
      if (size !== undefined)  { if (typeof size === "number" && Number.isFinite(size) && size >= 1) out.range_size = size; else errs.push(`${label}: range.size must be a number >= 1`); }
    }
  }

  const s = sort ?? defaultGroupSort(type);
  if (!GROUP_SORTS.includes(s)) errs.push(`${label}: sort must be one of ${GROUP_SORTS.join(", ")} (got "${s}")`);
  out.sort = { type: s };

  return errs.length === before ? out : null;
}

// ---------------------------------------------------------------------------
// Aggregation (y_axis / value)
function buildAggregation(schema, { aggregator, property }, label, errs) {
  const agg = aggregator ?? "count";
  if (!AGGREGATORS.includes(agg)) {
    errs.push(`${label}: unknown aggregator "${agg}". Allowed: ${AGGREGATORS.join(", ")}`);
    return null;
  }
  if (agg === "count") {
    if (property) errs.push(`${label}: aggregator "count" counts all rows and doesn't take a property`);
    return { aggregator: "count" };
  }
  if (!property) {
    errs.push(`${label}: aggregator "${agg}" requires a property`);
    return null;
  }
  const prop = tryResolve(schema, property, label, errs);
  if (!prop) return null;

  if (NUMERIC_AGG.includes(agg) && !NUMERIC_PROP_TYPES.includes(prop.type)) {
    errs.push(`${label}: "${agg}" needs a number property, but "${prop.name}" is ${prop.type}`);
    return null;
  }
  if (CHECKBOX_AGG.includes(agg) && prop.type !== "checkbox") {
    errs.push(`${label}: "${agg}" needs a checkbox property, but "${prop.name}" is ${prop.type}`);
    return null;
  }
  if (DATE_AGG.includes(agg) && !DATE_PROP_TYPES.includes(prop.type)) {
    errs.push(`${label}: "${agg}" needs a date property, but "${prop.name}" is ${prop.type}`);
    return null;
  }
  return { aggregator: agg, property_id: prop.id };
}

// ---------------------------------------------------------------------------
// Format options
function validateOptions(chart_type, options, errs) {
  const out = {};
  if (options === undefined || options === null) return out;
  if (!isObj(options)) {
    errs.push("options must be an object");
    return out;
  }
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined) continue;
    if (!OPTION_KEYS.includes(k)) {
      errs.push(`unknown option "${k}". Allowed: ${OPTION_KEYS.join(", ")}`);
      continue;
    }
    if (TYPE_SPECIFIC[k] && !TYPE_SPECIFIC[k].includes(chart_type)) {
      errs.push(`option "${k}" only applies to ${TYPE_SPECIFIC[k].join("/")} charts (this is a ${chart_type} chart)`);
      continue;
    }
    if (v === null) { out[k] = null; continue; } // nullable: clears the setting on update

    if (ENUMS[k]) {
      if (!ENUMS[k].includes(v)) { errs.push(`option "${k}" must be one of ${ENUMS[k].join(", ")} (got ${JSON.stringify(v)})`); continue; }
    } else if (BOOLEAN_OPTIONS.includes(k)) {
      if (typeof v !== "boolean") { errs.push(`option "${k}" must be true or false`); continue; }
    } else if (NUMBER_OPTIONS.includes(k)) {
      if (typeof v !== "number" || !Number.isFinite(v)) { errs.push(`option "${k}" must be a number`); continue; }
    } else if (STRING_OPTIONS.includes(k)) {
      if (typeof v !== "string") { errs.push(`option "${k}" must be a string`); continue; }
    } else if (k === "reference_lines") {
      if (!Array.isArray(v)) { errs.push("option \"reference_lines\" must be an array"); continue; }
      const lines = [];
      let ok = true;
      v.forEach((line, i) => {
        const l = `reference_lines[${i}]`;
        if (!isObj(line)) { errs.push(`${l} must be an object`); ok = false; return; }
        if (typeof line.value !== "number" || !Number.isFinite(line.value)) { errs.push(`${l}.value must be a number`); ok = false; }
        if (typeof line.label !== "string" || !line.label) { errs.push(`${l}.label is required`); ok = false; }
        if (!REF_LINE_COLORS.includes(line.color)) { errs.push(`${l}.color must be one of ${REF_LINE_COLORS.join(", ")}`); ok = false; }
        if (!REF_LINE_DASH.includes(line.dash_style)) { errs.push(`${l}.dash_style must be "solid" or "dash"`); ok = false; }
        if (line.id !== undefined && typeof line.id !== "string") { errs.push(`${l}.id must be a string`); ok = false; }
        if (ok) lines.push(line.id === undefined ? { value: line.value, label: line.label, color: line.color, dash_style: line.dash_style } : { id: line.id, value: line.value, label: line.label, color: line.color, dash_style: line.dash_style });
      });
      if (ok) out[k] = lines;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chart configuration
//
// input (all flat):
//   chart_type      column | bar | line | donut | number   (required)
//   x               property name/id to group by            (grouped types)
//   x_group_by      status: group|option; date: relative|day|week|month|year;
//                   text/title/url/email/phone: exact|alphabet_prefix
//   x_sort          manual | ascending | descending
//   x_range         {start, end, size} bucketing for a number x property
//   y_aggregator    default "count"; see AGGREGATORS
//   y_property      property for the aggregator (not for count)
//   stack_by        property to stack/split by (column/bar/line)
//   stack_group_by  same meaning as x_group_by, for stack_by
//   options         format options, see OPTION_KEYS
// For a number chart, y_aggregator/y_property define the single value.
//
// partial: true is for updates -- x/y are only included when provided.
function buildConfigInternal(schema, input, { partial }, errs) {
  const chart_type = input.chart_type;
  if (!CHART_TYPES.includes(chart_type)) {
    errs.push(`chart_type must be one of ${CHART_TYPES.join(", ")} (got ${JSON.stringify(chart_type)})`);
    return null;
  }
  const config = { type: "chart", chart_type };
  const grouped = GROUPED_TYPES.includes(chart_type);
  const hasY = input.y_aggregator !== undefined || input.y_property !== undefined;

  if (grouped) {
    if (input.x !== undefined && input.x !== null && input.x !== "") {
      const prop = tryResolve(schema, input.x, "x", errs);
      if (prop) {
        const gb = buildGroupBy(prop, { group_by: input.x_group_by, sort: input.x_sort, range: input.x_range }, "x", errs);
        if (gb) config.x_axis = gb;
      }
    } else if (!partial) {
      errs.push(`x is required for ${chart_type} charts (the property to group by)`);
    }
    if (!partial || hasY) {
      const agg = buildAggregation(schema, { aggregator: input.y_aggregator, property: input.y_property }, "y", errs);
      if (agg) config.y_axis = agg;
    }
    if (input.stack_by !== undefined && input.stack_by !== null && input.stack_by !== "") {
      if (!STACKABLE_TYPES.includes(chart_type)) {
        errs.push(`stack_by only applies to ${STACKABLE_TYPES.join("/")} charts (this is a ${chart_type} chart)`);
      } else {
        const prop = tryResolve(schema, input.stack_by, "stack_by", errs);
        if (prop) {
          const gb = buildGroupBy(prop, { group_by: input.stack_group_by }, "stack_by", errs);
          if (gb) config.stack_by = gb;
        }
      }
    }
  } else {
    // number chart
    for (const k of ["x", "x_group_by", "x_sort", "x_range", "stack_by", "stack_group_by"]) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== "") errs.push(`${k} doesn't apply to number charts (a number chart shows one aggregated value; use y_aggregator/y_property)`);
    }
    if (!partial || hasY) {
      const agg = buildAggregation(schema, { aggregator: input.y_aggregator, property: input.y_property }, "value", errs);
      if (agg) config.value = agg;
    }
  }

  Object.assign(config, validateOptions(chart_type, input.options, errs));
  return config;
}

// Public: build just the `configuration` object. Throws ChartConfigError
// listing every problem found.
export function buildChartConfig(schema, input = {}, { partial = false } = {}) {
  const errs = [];
  const config = buildConfigInternal(schema, input, { partial }, errs);
  throwIfErrors(errs);
  return config;
}

// ---------------------------------------------------------------------------
// POST /v1/views body for a new chart view.
//
// Extra input: name (required); filter (Notion filter object, passed through);
// page_id -> place inline on that page as a linked database view (optionally
// after_block_id); without page_id the chart becomes a view tab on the
// database itself.
export function buildCreateChartViewBody(schema, input = {}) {
  const errs = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errs.push("name is required");
  if (input.filter !== undefined && input.filter !== null && !isObj(input.filter)) errs.push("filter must be a Notion filter object");
  if (input.after_block_id && !input.page_id) errs.push("after_block_id only applies together with page_id");

  const configuration = buildConfigInternal(schema, input, { partial: false }, errs);
  throwIfErrors(errs);

  const body = {
    data_source_id: schema.data_source_id,
    name,
    type: "chart",
    configuration,
  };
  if (isObj(input.filter)) body.filter = input.filter;

  if (input.page_id) {
    const create_database = { parent: { type: "page_id", page_id: String(input.page_id).trim() } };
    if (input.after_block_id) create_database.position = { type: "after_block", block_id: String(input.after_block_id).trim() };
    body.create_database = create_database;
  } else {
    body.database_id = schema.database_id;
  }
  return body;
}

// ---------------------------------------------------------------------------
// PATCH /v1/views/{id} body. Only provided fields are included. Notion needs
// `configuration.type` and `chart_type` whenever configuration is sent, so
// pass existingChartType (from the retrieved view) -- input.chart_type
// overrides it.
//
// Extra input: name; filter (object, or null to clear).
export function buildUpdateChartViewBody(schema, input = {}, existingChartType) {
  const errs = [];
  const body = {};

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) errs.push("name can't be empty"); else body.name = name;
  }
  if (input.filter !== undefined) {
    if (input.filter !== null && !isObj(input.filter)) errs.push("filter must be a Notion filter object, or null to clear it");
    else body.filter = input.filter;
  }

  const touchesConfig = CONFIG_INPUT_KEYS.some((k) => k !== "chart_type" && input[k] !== undefined);
  if (touchesConfig || input.chart_type !== undefined) {
    const chart_type = input.chart_type ?? existingChartType;
    const configuration = buildConfigInternal(schema, { ...input, chart_type }, { partial: true }, errs);
    if (configuration) body.configuration = configuration;
  }

  throwIfErrors(errs);
  if (!Object.keys(body).length) throw new ChartConfigError(["nothing to update: pass name, filter or chart settings"]);
  return body;
}

// ---------------------------------------------------------------------------
// Notion replaces the stored `configuration` wholesale on PATCH instead of
// merging it. Verified live: sending only { color_theme } is rejected for a
// grouped chart (missing x_axis), and sending x_axis/y_axis/color_theme
// silently drops every other saved setting (height, show_data_labels, ...).
// So an update must re-send the whole configuration: keep everything from the
// chart's existing configuration that the caller didn't set. Returns a new
// object; keys in `config` (including explicit nulls, which clear a setting)
// always win.
//
// Only done when the chart type is unchanged: a type switch (e.g. column ->
// number) changes which settings are valid, so nothing is carried over then.
// `property_name` is read-only output from Notion and is stripped from the
// axis/value/stack objects.
export function fillConfigFromExisting(config, existingConfig) {
  if (!isObj(config) || !isObj(existingConfig)) return config;
  if (existingConfig.chart_type !== config.chart_type) return config;
  const out = { ...config };
  for (const [key, value] of Object.entries(existingConfig)) {
    if (out[key] !== undefined) continue;
    if (isObj(value)) {
      const { property_name, ...rest } = value; // eslint-disable-line no-unused-vars
      out[key] = rest;
    } else {
      out[key] = value;
    }
  }
  return out;
}
