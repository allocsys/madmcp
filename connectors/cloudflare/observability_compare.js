// ---------------------------------------------------------------------------
// connectors/cloudflare/observability_compare.js
//
// cf_workers_observability_compare — fetches Workers Observability telemetry
// for TWO scripts over the SAME timeframe and returns a normalized,
// side-by-side diff, instead of two raw event dumps that have to be eyeballed
// separately.
//
// Why this exists: raw event counts between two workers aren't comparable
// unless normalized, because the two queries can span very different amounts
// of actual wall-clock time even with the same `limit` (e.g. a busier worker
// fills its event quota over a much shorter window). Every ad-hoc comparison
// done manually against cf_workers_observability_query had to redo this
// normalization by hand and was easy to get wrong (see: a same-day comparison
// that used differing sample windows and produced an apparently-contradictory
// result versus an earlier, larger-sample comparison).
//
// What this tool normalizes:
//   - event rate (events/sec, computed off actual min/max timestamp span of
//     the returned sample — NOT off the requested timeframe window, since a
//     `limit` cutoff usually means the sample covers less time than requested)
//   - loadShed / error / exception rate (per second, same basis)
//   - a "stuck socket" heuristic flag: events where wall-clock duration is
//     wildly larger than CPU time (the workerd#2060 stuck-TCP-connect
//     signature: connection holds a slot ~21s after close() even though the
//     Worker's own code barely ran) — surfaced as a count + example events
//     rather than requiring a human to spot it in a wall of JSON.
//
// What this tool deliberately does NOT try to normalize (confounds that need
// a human, per DumbCodesOnly's own past findings): different test-server
// geography (e.g. SG vs DE testmy.net endpoints), client-side network
// conditions, and time-of-day traffic differences. The output includes a
// caveat noting these aren't a controlled A/B.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { queryTelemetry, toEpochMillis } from "./observability.js";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function firstDefined(obj, paths) {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

// Different dataset views (cloudflare-workers "fetch" events vs "otel" spans)
// place outcome/timing fields at different paths. Try the known locations
// rather than assuming one schema.
const OUTCOME_PATHS = ["$workers.event.outcome", "source.cloudflare.outcome"];
const DURATION_PATHS = ["$metadata.traceDuration", "source.durationMS", "$workers.event.durationMS"];
const CPU_MS_PATHS = ["source.cpu_time_ms", "$workers.event.cpu_time_ms"];
const LEVEL_PATHS = ["$metadata.level"];
const MESSAGE_PATHS = ["$metadata.message", "source.message"];
const TIMESTAMP_PATHS = ["timestamp", "$metadata.startTime"];

// Heuristic thresholds for flagging the workerd#2060 stuck-connect signature:
// wall time much larger than CPU time, and large enough in absolute terms to
// matter (avoids flagging trivially small durations).
const STUCK_RATIO_THRESHOLD = 15;
const STUCK_MIN_DURATION_MS = 1000;

function analyzeEvents(events) {
  const timestamps = [];
  const levelCounts = {};
  const outcomeCounts = {};
  const messageCounts = {};
  const stuckSocketEvents = [];
  let errorLikeCount = 0;

  for (const e of events) {
    const ts = firstDefined(e, TIMESTAMP_PATHS);
    if (typeof ts === "number") timestamps.push(ts);

    const level = firstDefined(e, LEVEL_PATHS) || "none";
    levelCounts[level] = (levelCounts[level] || 0) + 1;

    const outcome = firstDefined(e, OUTCOME_PATHS);
    if (outcome) outcomeCounts[outcome] = (outcomeCounts[outcome] || 0) + 1;

    const message = firstDefined(e, MESSAGE_PATHS);
    if (level === "error" || (typeof message === "string" && /exception|error/i.test(message))) {
      errorLikeCount += 1;
      if (typeof message === "string") {
        // Collapse dynamic reference IDs so repeated error types group together.
        const normalized = message.replace(/reference = [a-z0-9]+/gi, "reference = <id>");
        messageCounts[normalized] = (messageCounts[normalized] || 0) + 1;
      }
    }

    const durationMS = firstDefined(e, DURATION_PATHS);
    const cpuMs = firstDefined(e, CPU_MS_PATHS);
    if (typeof durationMS === "number" && typeof cpuMs === "number" && cpuMs >= 0) {
      const safeCpu = Math.max(cpuMs, 1);
      const ratio = durationMS / safeCpu;
      if (durationMS >= STUCK_MIN_DURATION_MS && ratio >= STUCK_RATIO_THRESHOLD) {
        stuckSocketEvents.push({
          timestamp: ts,
          durationMS,
          cpuMs,
          ratio: Math.round(ratio * 10) / 10,
          message: typeof message === "string" ? message : undefined,
          outcome,
        });
      }
    }
  }

  const minTs = timestamps.length ? Math.min(...timestamps) : null;
  const maxTs = timestamps.length ? Math.max(...timestamps) : null;
  const spanSeconds = minTs !== null && maxTs !== null ? Math.max((maxTs - minTs) / 1000, 0.001) : null;

  const rate = (count) => (spanSeconds ? Math.round((count / spanSeconds) * 1000) / 1000 : null);

  const loadShedCount = outcomeCounts.loadShed || 0;

  return {
    sampleSize: events.length,
    sampleSpanSeconds: spanSeconds,
    sampleSpanCaveat: spanSeconds && spanSeconds < 60
      ? "Sample covers under a minute of wall-clock time — rates from this small a window are noisy; prefer a larger limit or narrower script-specific timeframe for a firmer read."
      : undefined,
    levelCounts,
    outcomeCounts,
    ratesPerSecond: {
      events: rate(events.length),
      loadShed: rate(loadShedCount),
      errorLike: rate(errorLikeCount),
    },
    topErrorMessages: Object.entries(messageCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([message, count]) => ({ message, count })),
    stuckSocketSuspects: {
      count: stuckSocketEvents.length,
      rate: rate(stuckSocketEvents.length),
      examples: stuckSocketEvents
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 5),
    },
  };
}

export function register(server) {
  server.tool(
    "cf_workers_observability_compare",
    "DOES: Compare Workers Observability telemetry between TWO scripts over the SAME timeframe -- normalized rates (events/sec, loadShed/sec, error/sec), not raw counts, plus a 'stuck socket' heuristic (high wall-time vs low CPU-time) with example events per side.\n" +
    "RULE: comparing a deploy against a baseline -> this, not two separate cf_workers_observability_query calls -- raw counts aren't comparable across differing sample time-spans (see file header for why).\n" +
    "NOT a controlled A/B: traffic mix, client geography, time-of-day aren't normalized -- output includes that caveat.",
    {
      script_a: z.string().describe("First Worker script name, e.g. the post-deploy / current version"),
      script_b: z.string().describe("Second Worker script name, e.g. the pre-deploy / baseline version"),
      timeframe_from: z.string().describe("Start of time range, ISO 8601 (e.g. '2026-07-01T00:00:00Z') or epoch millis — applied identically to both scripts"),
      timeframe_to: z.string().describe("End of time range, ISO 8601 or epoch millis — applied identically to both scripts"),
      dataset: z.string().optional().describe("Telemetry dataset (default: 'cloudflare-workers'). Pass 'otel' to compare span/exception data instead."),
      view: z.string().optional().describe("Result grouping mode, e.g. 'events' or 'invocations'. Default: 'events'."),
      limit: z.number().optional().describe("Max events fetched per script (default: 1000). Same limit applied to both sides for a fair comparison."),
    },
    async ({ script_a, script_b, timeframe_from, timeframe_to, dataset = "cloudflare-workers", view = "events", limit = 1000 }) => {
      const from = toEpochMillis(timeframe_from);
      const to = toEpochMillis(timeframe_to);

      const [resultA, resultB] = await Promise.all([
        queryTelemetry({ timeframe_from: from, timeframe_to: to, script_name: script_a, dataset, view, limit }),
        queryTelemetry({ timeframe_from: from, timeframe_to: to, script_name: script_b, dataset, view, limit }),
      ]);

      const eventsA = resultA?.events?.events || [];
      const eventsB = resultB?.events?.events || [];

      const analysisA = analyzeEvents(eventsA);
      const analysisB = analyzeEvents(eventsB);

      return textResult({
        timeframe: { from, to },
        scripts: { a: script_a, b: script_b },
        a: analysisA,
        b: analysisB,
        note: "Rates are normalized per-second off each sample's own observed timestamp span, not off the requested timeframe — a `limit` cutoff usually means the returned sample covers less wall-clock time than requested, especially for a busier script. This is NOT a controlled A/B: differing traffic mix, client geography, and time-of-day are not accounted for here and can still explain rate differences on their own.",
      });
    }
  );
}
