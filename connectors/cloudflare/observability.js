// ---------------------------------------------------------------------------
// connectors/cloudflare/observability.js — Workers Logs / Traces / Events
// Wraps the Workers Observability "telemetry" API. This single dataset holds
// invocation logs, custom logs, traces, and the raw event stream — the same
// data backing the Observability dashboard's Overview/Invocations/Events tabs
// and the Query Builder.
//
// Registers ONE tool, cf_workers_observability, with action: query | keys |
// values | compare. It consolidates the former cf_workers_observability_query,
// _keys, _values and _compare. Requests and output are unchanged; required-ness
// of per-action params moved from zod into the handler.
//
// Docs: https://developers.cloudflare.com/workers/observability/query-builder/
// API:  POST /accounts/{account_id}/workers/observability/telemetry/{query,keys,values}
//
// NOT included: real-time `wrangler tail` streaming — that's a websocket
// session, not a request/response REST call, so it doesn't fit this tool
// model. Logpush (export to R2/S3/etc.) is also out of scope here since it's
// a push-configuration resource rather than a query.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { cfAccountRequest } from "./client.js";
import { compareScripts } from "./observability_compare.js";
import { textResult, pickFields } from "../output.js";

// Default number of events returned by action 'query'. Raw event streams are
// large (each event is a nested JSON object) so callers must opt in to more.
export const DEFAULT_QUERY_LIMIT = 20;

// Keep only the listed top-level keys of each event (e.g. ['timestamp', '$metadata'])
// in a telemetry query result. Result shape: { events: { events: [...] }, ... }.
export function projectEventFields(result, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return result;
  const events = result?.events?.events;
  if (!Array.isArray(events)) return result;
  return { ...result, events: { ...result.events, events: pickFields(events, fields) } };
}

// Default number of events fetched when action 'query' runs with summarize.
// Only aggregates are returned, so a larger window is cheap for the caller.
export const DEFAULT_SUMMARIZE_LIMIT = 200;

const TOP_N = 5;
const MAX_MESSAGE_CHARS = 120;

function bump(map, key) {
  if (key === undefined || key === null || key === "") return;
  const k = String(key);
  map.set(k, (map.get(k) || 0) + 1);
}

function topEntries(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

// Collapse a telemetry query result into aggregates instead of raw events:
// count, time range, and top levels / statuses / errors / messages.
// Result shape: { events: { events: [...] }, ... }.
export function summarizeEvents(result) {
  const events = result?.events?.events;
  if (!Array.isArray(events)) return result;

  const levels = new Map();
  const statuses = new Map();
  const errors = new Map();
  const messages = new Map();
  let first;
  let last;

  for (const ev of events) {
    const meta = ev?.$metadata || {};
    bump(levels, meta.level);
    bump(statuses, ev?.$workers?.event?.response?.status);
    bump(errors, meta.error);
    const msg = meta.message;
    if (typeof msg === "string") bump(messages, msg.slice(0, MAX_MESSAGE_CHARS));
    const ts = ev?.timestamp;
    if (typeof ts === "number") {
      if (first === undefined || ts < first) first = ts;
      if (last === undefined || ts > last) last = ts;
    }
  }

  return {
    summary: {
      event_count: events.length,
      ...(first !== undefined ? { first_timestamp: first, last_timestamp: last } : {}),
      levels: topEntries(levels, TOP_N),
      statuses: topEntries(statuses, TOP_N),
      errors: topEntries(errors, TOP_N),
      top_messages: topEntries(messages, TOP_N),
    },
    note: `Aggregated over ${events.length} fetched events (no raw events returned). Raise limit for a wider sample, or rerun without summarize to see events.`,
  };
}

// Cloudflare's telemetry query/values endpoints require timeframe bounds as
// epoch millis (numbers), not ISO strings — accept either from callers and
// normalize here.
export function toEpochMillis(ts) {
  if (typeof ts === "number") return ts;
  if (/^\d+$/.test(ts)) return Number(ts);
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) throw new Error(`Invalid timeframe value: ${ts}`);
  return parsed;
}

// The telemetry query API's `parameters.filters` entries are a discriminated
// union of either a "group" node ({kind:"group", filterCombination, filters})
// or a leaf filter node. A leaf node requires `operation` (not `operator`)
// and a `type` describing the value's type — both were previously missing,
// which caused every query with any filter (including the script_name
// convenience filter) to fail Cloudflare's schema validation with a 400.
function inferValueType(value) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function normalizeFilter(f) {
  // Accept both the tool's public `operator` param name and, defensively,
  // an already-correct `operation` field if a caller supplies one directly.
  const operation = f.operation || f.operator;
  const type = f.type || inferValueType(f.value);
  return { key: f.key, operation, type, value: f.value };
}

const filterSchema = z.object({
  key: z.string().describe("Field to filter on, e.g. '$workers.event.response.status' or '$metadata.service'. Use action 'keys' to discover valid keys."),
  operator: z.string().describe("Comparison operator, e.g. 'eq', 'neq', 'gt', 'lt', 'includes'"),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to compare against"),
}).passthrough();

// Shared query function — used directly by action 'query' and reused by
// action 'compare' (via compareScripts) so both stay in sync on
// filter-normalization and timeframe handling.
export async function queryTelemetry({
  timeframe_from,
  timeframe_to,
  script_name,
  view = "events",
  dataset = "cloudflare-workers",
  filters = [],
  limit,
  query_id,
}) {
  const rawFilters = script_name
    ? [{ key: "$metadata.service", operator: "eq", value: script_name }, ...filters]
    : filters;

  const allFilters = rawFilters.map(normalizeFilter);

  const body = {
    queryId: query_id || `madmcp-${Date.now()}`,
    view,
    datasets: [dataset],
    timeframe: { from: toEpochMillis(timeframe_from), to: toEpochMillis(timeframe_to) },
    parameters: { filters: allFilters },
    ...(limit ? { limit } : {}),
  };

  return cfAccountRequest("/workers/observability/telemetry/query", { method: "POST", body });
}

// Params each action needs (zod marks them all optional so one schema can serve
// every action; required-ness is enforced here). Only `undefined` counts as
// missing, so an empty string still reaches toEpochMillis and throws exactly
// as it did before consolidation.
const REQUIRED = {
  query: ["timeframe_from", "timeframe_to"],
  keys: ["timeframe_from", "timeframe_to"],
  values: ["key", "timeframe_from", "timeframe_to"],
  compare: ["script_a", "script_b", "timeframe_from", "timeframe_to"],
};

export function register(server) {
  server.tool(
    "cf_workers_observability",
    "DOES: Query Workers Observability telemetry (invocation logs, console.log output, exceptions, request/response metadata, trace spans) -- same data as the Observability dashboard's Overview/Invocations/Events tabs. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'keys' needs timeframe_from + timeframe_to and lists the field names you can filter/group by. Call it before 'query' if you don't already know the field names.\n" +
    "RULE: action 'values' needs key + timeframe_from + timeframe_to and lists distinct values seen for that key (e.g. all $workers.event.response.status values), for building filters. Optional type (default 'string').\n" +
    "RULE: action 'query' needs timeframe_from + timeframe_to; optional script_name, view, filters, limit, query_id. Returns the matching events.\n" +
    "RULE: action 'compare' needs script_a + script_b + timeframe_from + timeframe_to and compares TWO scripts over the SAME timeframe: normalized rates (events/sec, loadShed/sec, error/sec), not raw counts, plus a 'stuck socket' heuristic (high wall-time vs low CPU-time) with example events per side. Use it for a deploy vs baseline instead of two separate 'query' calls -- raw counts aren't comparable across differing sample time-spans. NOT a controlled A/B: traffic mix, client geography and time-of-day aren't normalized (the output includes that caveat).\n" +
    "RULE: dataset (default 'cloudflare-workers') applies to every action; view applies to 'query' and 'compare'; limit applies to 'query' (default 20) and 'compare' (default 1000, applied to both scripts). fields (top-level event keys, e.g. ['timestamp','$metadata']) applies to 'query' and trims each event. summarize (boolean) applies to 'query': returns aggregates (event count, time range, top levels/statuses/errors/messages) instead of raw events, fetching up to 200 events by default; use it first to see what is happening, then query narrowly. Output is compact JSON, capped in size with a truncation notice -- prefer small limits, filters and fields over raising the cap.",

    {
      action: z.enum(["query", "keys", "values", "compare"]).describe("Which operation to perform"),
      timeframe_from: z.string().optional().describe("Start of time range, ISO 8601 (e.g. '2026-07-01T00:00:00Z') or epoch millis. Required for every action; for 'compare' it is applied identically to both scripts."),
      timeframe_to: z.string().optional().describe("End of time range, ISO 8601 or epoch millis. Required for every action."),
      dataset: z.string().optional().describe("Telemetry dataset (default: 'cloudflare-workers'). For 'compare', pass 'otel' to compare span/exception data instead."),
      key: z.string().optional().describe("'values' only (required): the telemetry key to list values for, e.g. '$workers.event.response.status'"),
      type: z.enum(["string", "boolean", "number"]).optional().describe("'values' only: the value type of the key being listed (required by the Cloudflare API). Default: 'string'."),
      script_name: z.string().optional().describe("'query' only: convenience filter scoping results to one Worker script. Adds a filter on '$metadata.service' -- if that key doesn't match your account's schema, use 'filters' directly instead (check action 'keys')."),
      view: z.string().optional().describe("'query' and 'compare': result grouping mode, e.g. 'events' (raw event stream) or 'invocations' (grouped by invocation). Default: 'events'."),
      filters: z.array(filterSchema).optional().describe("'query' only: additional structured filters, e.g. [{key: '$workers.event.response.status', operator: 'gt', value: 500}]"),
      limit: z.number().optional().describe("'query': max number of results (default: 20). 'compare': max events fetched per script (default: 1000)."),
      fields: z.array(z.string()).optional().describe("'query' only: keep only these top-level keys of each event (e.g. ['timestamp','$metadata']) to shrink the output."),
      summarize: z.boolean().optional().describe("'query' only: if true, return aggregate counts (event count, time range, top levels/statuses/errors/messages) instead of raw events. Default limit becomes 200. Ignores fields."),
      query_id: z.string().optional().describe("'query' only: optional query identifier for the request (any string); Cloudflare uses this to tag/save the query"),
      script_a: z.string().optional().describe("'compare' only (required): first Worker script name, e.g. the post-deploy / current version"),
      script_b: z.string().optional().describe("'compare' only (required): second Worker script name, e.g. the pre-deploy / baseline version"),
    },
    async (args) => {
      const { action } = args;
      const required = REQUIRED[action];
      if (!required) {
        return { content: [{ type: "text", text: `Unknown action '${action}'.` }], isError: true };
      }
      const missing = required.filter((name) => args[name] === undefined);
      if (missing.length) {
        return { content: [{ type: "text", text: `action '${action}' requires ${missing.join(", ")}.` }], isError: true };
      }

      const { timeframe_from, timeframe_to } = args;

      if (action === "keys") {
        const { dataset = "cloudflare-workers" } = args;
        return textResult(await cfAccountRequest("/workers/observability/telemetry/keys", {
          method: "POST",
          body: { dataset, timeframe: { from: toEpochMillis(timeframe_from), to: toEpochMillis(timeframe_to) } },
        }));
      }

      if (action === "values") {
        const { key, dataset = "cloudflare-workers", type = "string" } = args;
        return textResult(await cfAccountRequest("/workers/observability/telemetry/values", {
          method: "POST",
          body: {
            datasets: [dataset],
            key,
            type,
            timeframe: { from: toEpochMillis(timeframe_from), to: toEpochMillis(timeframe_to) },
          },
        }));
      }

      if (action === "query") {
        const { script_name, view, dataset, filters, summarize, query_id, fields } = args;
        const limit = args.limit ?? (summarize ? DEFAULT_SUMMARIZE_LIMIT : DEFAULT_QUERY_LIMIT);
        const result = await queryTelemetry({ timeframe_from, timeframe_to, script_name, view, dataset, filters, limit, query_id });
        if (summarize) return textResult(summarizeEvents(result));
        return textResult(projectEventFields(result, fields));
      }

      // action === "compare"
      const { script_a, script_b, dataset, view, limit } = args;
      return textResult(await compareScripts({ script_a, script_b, timeframe_from, timeframe_to, dataset, view, limit }));
    }
  );
}
