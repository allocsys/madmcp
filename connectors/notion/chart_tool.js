// ---------------------------------------------------------------------------
// connectors/notion/chart_tool.js
//
// The `notion_chart` MCP tool (Step 4 of the plan "Plan: Native Notion charts
// in madmcp", entity_id: plan-madmcp-notion-charts). Glue only: views.js does
// the I/O (Views API, Notion-Version 2026-03-11), chart_config.js builds and
// validates the request bodies.
//
// Actions: create | update | get | list | delete. `dry_run` returns the exact
// request body without sending the write. Dry runs still do the READ-ONLY
// lookups they need (database schema to resolve property names; the existing
// view on update to learn its chart_type) -- nothing is created, changed or
// deleted.
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  VIEWS_API_VERSION, createView, retrieveView, updateView, deleteView, listViews, getDatabaseSchema,
} from "./views.js";
import {
  CHART_TYPES, AGGREGATORS, buildCreateChartViewBody, buildUpdateChartViewBody,
} from "./chart_config.js";

const ACTIONS = ["create", "update", "get", "list", "delete"];
const MAX_LIST_DETAILS = 25; // retrieveView calls per list (Notion rate-limits ~3 req/s)

// Update inputs that need property-name resolution (and so a schema lookup).
const SCHEMA_KEYS = ["x", "y_aggregator", "y_property", "stack_by"];

function requireString(value, name, action) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required for action "${action}"`);
  }
  return value.trim();
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function describeView(v) {
  const kind = v.type === "chart"
    ? `chart/${v.configuration?.chart_type ?? "?"}`
    : (v.type || "unknown");
  return `${v.name || "(unnamed)"} \u2014 ${kind} \u2014 id: ${v.id}${v.url ? `, url: ${v.url}` : ""}`;
}

function dryRunText(method, path, body) {
  return `DRY RUN \u2014 nothing was written.\n${method} /v1${path} (Notion-Version ${VIEWS_API_VERSION})${body === undefined ? "" : `\n${json(body)}`}`;
}

// Turns any error from this tool into a message that says what to do next.
export function explainChartError(err) {
  if (err?.name === "ChartConfigError") {
    return `Invalid chart settings (${err.errors.length}):\n${err.errors.map((e) => `- ${e}`).join("\n")}`;
  }
  const msg = err?.message || String(err);
  if (/validation_error/i.test(msg)) {
    return `${msg}\nHint: Notion rejected the request body. Re-run with dry_run: true to inspect the exact payload.`;
  }
  if (/restricted_resource|\(403\)|insufficient|capabilit/i.test(msg)) {
    return `${msg}\nHint: the integration may lack the capability to create/update views, or the database isn't shared with it.`;
  }
  if (/\(404\)|object_not_found/i.test(msg)) {
    return `${msg}\nHint: check the id, and that the database/page is shared with the integration.`;
  }
  if (/\(402\)|payment|upgrade|plan/i.test(msg)) {
    return `${msg}\nHint: charts need a paid Notion plan (free workspaces are limited to one chart).`;
  }
  return msg;
}

async function doCreate(args) {
  const database_id = requireString(args.database_id, "database_id", "create");
  const schema = await getDatabaseSchema(database_id, { data_source_id: args.data_source_id });
  const body = buildCreateChartViewBody(schema, args);
  if (args.dry_run) return dryRunText("POST", "/views", body);

  const view = await createView(body);
  const where = args.page_id ? `inline on page ${args.page_id}` : `as a view tab on database ${database_id}`;
  return `\u2713 Created chart "${body.name}" ${where}.\nview id: ${view?.id ?? "(not returned)"}${view?.url ? `\nurl: ${view.url}` : ""}`;
}

async function doUpdate(args) {
  const view_id = requireString(args.view_id, "view_id", "update");
  const existing = await retrieveView(view_id);
  if (existing?.type && existing.type !== "chart") {
    throw new Error(`View ${view_id} is a ${existing.type} view, not a chart; notion_chart only edits chart views`);
  }

  let schema = { properties: {}, propertiesById: {} };
  if (SCHEMA_KEYS.some((k) => args[k] !== undefined)) {
    const database_id = requireString(args.database_id, "database_id", "update (needed to resolve property names when changing x, y_aggregator, y_property or stack_by)");
    schema = await getDatabaseSchema(database_id, { data_source_id: args.data_source_id });
  }

  const body = buildUpdateChartViewBody(schema, args, existing?.configuration?.chart_type);
  if (args.dry_run) return dryRunText("PATCH", `/views/${view_id}`, body);

  await updateView(view_id, body);
  return `\u2713 Updated chart ${view_id} (changed: ${Object.keys(body).join(", ")}).`;
}

async function doGet(args) {
  const view_id = requireString(args.view_id, "view_id", "get");
  const view = await retrieveView(view_id);
  return `${describeView(view)}\n${json(view)}`;
}

async function doList(args) {
  if (!args.database_id && !args.data_source_id) {
    throw new Error('database_id (or data_source_id) is required for action "list"');
  }
  const page = await listViews({
    database_id: args.database_id,
    data_source_id: args.data_source_id,
    start_cursor: args.cursor,
    page_size: args.page_size,
  });
  const refs = page?.results || [];
  if (!refs.length) return "No views found.";

  const lines = [];
  for (const ref of refs.slice(0, MAX_LIST_DETAILS)) {
    try {
      lines.push(`- ${describeView(await retrieveView(ref.id))}`);
    } catch (err) {
      lines.push(`- id: ${ref.id} \u2014 (details unavailable: ${err.message})`);
    }
  }
  for (const ref of refs.slice(MAX_LIST_DETAILS)) lines.push(`- id: ${ref.id} \u2014 (details not fetched)`);

  const more = page.has_more && page.next_cursor
    ? `\n\n\u26a0\ufe0f More views exist \u2014 call again with cursor: "${page.next_cursor}".`
    : "";
  return `${refs.length} view(s):\n${lines.join("\n")}${more}`;
}

async function doDelete(args) {
  const view_id = requireString(args.view_id, "view_id", "delete");
  if (args.dry_run) return dryRunText("DELETE", `/views/${view_id}`);
  await deleteView(view_id);
  return `\u2713 Deleted view ${view_id}.`;
}

// Exported for tests; returns the text to show, throws on any failure.
export async function runChartAction(args) {
  switch (args.action) {
    case "create": return doCreate(args);
    case "update": return doUpdate(args);
    case "get":    return doGet(args);
    case "list":   return doList(args);
    case "delete": return doDelete(args);
    default: throw new Error(`invalid action "${args.action}" (expected ${ACTIONS.join(", ")})`);
  }
}

export function register(server) {
  server.tool(
    "notion_chart",
    "DOES: Create and manage native Notion chart views (Views API) on a database. Use `action` to pick: 'create' makes a chart (column, bar, line, donut or number); 'update' changes name/filter/chart settings of an existing chart; 'get' returns one view; 'list' lists a database's views with name and type; 'delete' removes a view. 'create' and 'delete' MUTATE Notion state.\nRULE: 'create' needs database_id + name + chart_type; grouped charts (column/bar/line/donut) also need x (property to group by); number charts must not have x. y_aggregator defaults to 'count' (no y_property); every other aggregator needs y_property (sum/average/median/min/max/range need a number property). Properties can be given by name or id.\nRULE: placement -- without page_id the chart becomes a view tab on the database; with page_id it is placed inline on that page as a linked database view (optional after_block_id).\nRULE: 'update' needs view_id; pass only what changes. database_id is also needed when changing x, y_aggregator, y_property or stack_by (to resolve property names). 'get' and 'delete' need view_id; 'list' needs database_id (or data_source_id).\nRULE: dry_run: true returns the exact request body without writing (it still does read-only lookups of the database schema / existing view). Use it first when unsure.\nEXAMPLE: {action:'create', database_id:'...', name:'Tasks by status', chart_type:'column', x:'Status'} | {action:'create', database_id:'...', name:'Revenue by month', chart_type:'line', x:'Date', x_group_by:'month', y_aggregator:'sum', y_property:'Amount', options:{smooth_line:true}}\nNOTE: charts need a paid Notion plan (free: 1 chart); the integration needs capability to create views.",
    {
      action:          z.enum(["create", "update", "get", "list", "delete"]).describe("Which operation to perform."),
      database_id:     z.string().optional().describe("Database to chart. Required for 'create' and 'list'; for 'update' only when changing x/y_aggregator/y_property/stack_by."),
      data_source_id:  z.string().optional().describe("Pick a data source when the database has several (otherwise it's an error). 'list' accepts it instead of database_id."),
      view_id:         z.string().optional().describe("Chart view ID. Required for 'update', 'get' and 'delete'."),
      page_id:         z.string().optional().describe("'create' only: place the chart inline on this page (linked database view) instead of as a database view tab."),
      after_block_id:  z.string().optional().describe("'create' only, with page_id: insert after this block."),
      name:            z.string().optional().describe("Chart name. Required for 'create'."),
      filter:          z.record(z.any()).optional().describe("Notion filter object limiting the rows charted. On 'update', null clears it."),
      chart_type:      z.enum(CHART_TYPES).optional().describe("column | bar | line | donut | number. Required for 'create'; on 'update' defaults to the chart's current type."),
      x:               z.string().optional().describe("Property (name or id) to group by. Required for column/bar/line/donut; not allowed for number."),
      x_group_by:      z.string().optional().describe("How to group x. status: group|option; date: relative|day|week|month|year; text/title/url/email/phone: exact|alphabet_prefix."),
      x_sort:          z.enum(["manual", "ascending", "descending"]).optional().describe("Sort order of the x groups."),
      x_range:         z.object({ start: z.number().optional(), end: z.number().optional(), size: z.number().optional() }).optional().describe("Bucketing for a number x property: {start, end, size}."),
      y_aggregator:    z.enum(AGGREGATORS).optional().describe("Aggregation for the y value (the single value for number charts). Default 'count'."),
      y_property:      z.string().optional().describe("Property for y_aggregator (not allowed with 'count')."),
      stack_by:        z.string().optional().describe("Property to stack/split by (column, bar, line only)."),
      stack_group_by:  z.string().optional().describe("Same meaning as x_group_by, for stack_by."),
      options:         z.record(z.any()).optional().describe("Format options: sort, color_theme, height, legend_position, axis_labels, grid_lines, group_style, donut_labels, hide_empty_groups, show_data_labels, color_by_value, cumulative, smooth_line, hide_line_fill_area, hide_title, y_axis_min, y_axis_max, caption, reference_lines ([{value,label,color,dash_style}]). Some apply to specific chart types only; errors say which."),
      cursor:          z.string().optional().describe("'list' only: pagination cursor from a previous call."),
      page_size:       z.number().optional().describe("'list' only: views per page, 1-100."),
      dry_run:         z.boolean().optional().describe("Return the exact request without writing to Notion (read-only lookups still happen)."),
    },
    async (args) => {
      try {
        return { content: [{ type: "text", text: await runChartAction(args) }] };
      } catch (err) {
        return { content: [{ type: "text", text: explainChartError(err) }], isError: true };
      }
    }
  );
}
