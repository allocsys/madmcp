// ---------------------------------------------------------------------------
// connectors/cloudflare/observability.js — Workers Logs / Traces / Events
// Wraps the Workers Observability "telemetry" API. This single dataset holds
// invocation logs, custom logs, traces, and the raw event stream — the same
// data backing the Observability dashboard's Overview/Invocations/Events tabs
// and the Query Builder.
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

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// Cloudflare's telemetry query/values endpoints require timeframe bounds as
// epoch millis (numbers), not ISO strings — accept either from callers and
// normalize here.
function toEpochMillis(ts) {
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
  key: z.string().describe("Field to filter on, e.g. '$workers.event.response.status' or '$metadata.service'. Use cf_workers_observability_keys to discover valid keys."),
  operator: z.string().describe("Comparison operator, e.g. 'eq', 'neq', 'gt', 'lt', 'includes'"),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to compare against"),
}).passthrough();

export function register(server) {
  server.tool(
    "cf_workers_observability_keys",
    "List all the keys available in your Workers Observability telemetry (logs, traces, events) so you know what fields you can filter/group by.",
    {
      dataset: z.string().optional().describe("Telemetry dataset (default: 'cloudflare-workers')"),
      timeframe_from: z.string().describe("Start of time range, ISO 8601 (e.g. '2026-07-01T00:00:00Z') or epoch millis"),
      timeframe_to: z.string().describe("End of time range, ISO 8601 or epoch millis"),
    },
    async ({ dataset = "cloudflare-workers", timeframe_from, timeframe_to }) =>
      textResult(await cfAccountRequest("/workers/observability/telemetry/keys", {
        method: "POST",
        body: { dataset, timeframe: { from: timeframe_from, to: timeframe_to } },
      }))
  );

  server.tool(
    "cf_workers_observability_values",
    "List the unique values seen for a given telemetry key (logs/traces/events), useful for building filters — e.g. see all distinct $workers.event.response.status values in range.",
    {
      key: z.string().describe("The telemetry key to list values for, e.g. '$workers.event.response.status'"),
      dataset: z.string().optional().describe("Telemetry dataset (default: 'cloudflare-workers')"),
      timeframe_from: z.string().describe("Start of time range, ISO 8601 or epoch millis"),
      timeframe_to: z.string().describe("End of time range, ISO 8601 or epoch millis"),
      type: z.enum(["string", "boolean", "number"]).optional().describe("The value type of the key being listed (required by the Cloudflare API). Default: 'string'."),
    },
    async ({ key, dataset = "cloudflare-workers", timeframe_from, timeframe_to, type = "string" }) =>
      textResult(await cfAccountRequest("/workers/observability/telemetry/values", {
        method: "POST",
        body: {
          datasets: [dataset],
          key,
          type,
          timeframe: { from: toEpochMillis(timeframe_from), to: toEpochMillis(timeframe_to) },
        },
      }))
  );

  server.tool(
    "cf_workers_observability_query",
    "Query Workers Logs, traces, and events (invocation logs, console.log output, exceptions, request/response metadata, trace spans). Covers the same data as the Observability dashboard's Overview, Invocations, and Events tabs. Use cf_workers_observability_keys first to discover filterable fields.",
    {
      timeframe_from: z.string().describe("Start of time range, ISO 8601 (e.g. '2026-07-01T00:00:00Z') or epoch millis"),
      timeframe_to: z.string().describe("End of time range, ISO 8601 or epoch millis"),
      script_name: z.string().optional().describe("Convenience filter: scope results to one Worker script. Adds a filter on '$metadata.service' — if that key doesn't match your account's schema, use the 'filters' param directly instead (check cf_workers_observability_keys)."),
      view: z.string().optional().describe("Result grouping mode, e.g. 'events' (raw event stream) or 'invocations' (grouped by invocation). Default: 'events'."),
      dataset: z.string().optional().describe("Telemetry dataset (default: 'cloudflare-workers')"),
      filters: z.array(filterSchema).optional().describe("Additional structured filters, e.g. [{key: '$workers.event.response.status', operator: 'gt', value: 500}]"),
      limit: z.number().optional().describe("Max number of results (default: server default, typically 100)"),
      query_id: z.string().optional().describe("Optional query identifier for the request (any string); Cloudflare uses this to tag/save the query"),
    },
    async ({ timeframe_from, timeframe_to, script_name, view = "events", dataset = "cloudflare-workers", filters = [], limit, query_id }) => {
      const rawFilters = script_name
        ? [{ key: "$metadata.service", operator: "eq", value: script_name }, ...filters]
        : filters;

      const allFilters = rawFilters.map(normalizeFilter);

      const body = {
        queryId: query_id || `manufact-${Date.now()}`,
        view,
        datasets: [dataset],
        timeframe: { from: toEpochMillis(timeframe_from), to: toEpochMillis(timeframe_to) },
        parameters: { filters: allFilters },
        ...(limit ? { limit } : {}),
      };

      return textResult(await cfAccountRequest("/workers/observability/telemetry/query", { method: "POST", body }));
    }
  );
}
