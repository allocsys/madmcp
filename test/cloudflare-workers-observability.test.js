import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/cloudflare/client.js", () => ({
  cfAccountRequest: vi.fn(),
}));

import { cfAccountRequest } from "../connectors/cloudflare/client.js";
import { register as registerObservability } from "../connectors/cloudflare/observability.js";

function makeFakeServer() {
  const tools = {};
  const names = [];
  return {
    tool: (name, _description, _schema, handler) => {
      names.push(name);
      tools[name] = handler;
    },
    tools,
    names,
  };
}

const FROM = "2026-07-01T00:00:00Z";
const TO = "2026-07-02T00:00:00Z";
const FROM_MS = Date.parse(FROM);
const TO_MS = Date.parse(TO);

describe("Cloudflare connector - consolidated cf_workers_observability", () => {
  let server;
  let call;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerObservability(server);
    call = (args) => server.tools.cf_workers_observability(args);
  });

  it("registers cf_workers_observability once and no longer registers the old tools", () => {
    expect(server.names).toEqual(["cf_workers_observability"]);
    for (const old of [
      "cf_workers_observability_query",
      "cf_workers_observability_keys",
      "cf_workers_observability_values",
      "cf_workers_observability_compare",
    ]) {
      expect(server.names).not.toContain(old);
    }
  });

  it("rejects unknown actions without calling the API", async () => {
    const result = await call({ action: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown action");
    expect(cfAccountRequest).not.toHaveBeenCalled();
  });

  describe("action 'keys'", () => {
    it("requires timeframe_from and timeframe_to", async () => {
      const result = await call({ action: "keys" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("action 'keys' requires timeframe_from, timeframe_to.");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("POSTs to /telemetry/keys with default dataset and epoch-millis timeframe", async () => {
      const data = { keys: ["a"] };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await call({ action: "keys", timeframe_from: FROM, timeframe_to: TO });
      expect(cfAccountRequest).toHaveBeenCalledTimes(1);
      expect(cfAccountRequest).toHaveBeenCalledWith("/workers/observability/telemetry/keys", {
        method: "POST",
        body: { dataset: "cloudflare-workers", timeframe: { from: FROM_MS, to: TO_MS } },
      });
      expect(result.content[0].text).toBe(JSON.stringify(data));
    });

    it("passes a custom dataset and accepts epoch-millis strings", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await call({ action: "keys", dataset: "otel", timeframe_from: "1000", timeframe_to: "2000" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/workers/observability/telemetry/keys", {
        method: "POST",
        body: { dataset: "otel", timeframe: { from: 1000, to: 2000 } },
      });
    });

    it("throws on an invalid timeframe and on API errors", async () => {
      await expect(call({ action: "keys", timeframe_from: "garbage", timeframe_to: TO })).rejects.toThrow("Invalid timeframe value: garbage");
      cfAccountRequest.mockRejectedValueOnce(new Error("400 bad"));
      await expect(call({ action: "keys", timeframe_from: FROM, timeframe_to: TO })).rejects.toThrow("400 bad");
    });
  });

  describe("action 'values'", () => {
    it("requires key, timeframe_from and timeframe_to", async () => {
      const result = await call({ action: "values" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("action 'values' requires key, timeframe_from, timeframe_to.");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("POSTs to /telemetry/values with datasets array and default type 'string'", async () => {
      cfAccountRequest.mockResolvedValueOnce({ values: [] });
      await call({ action: "values", key: "$workers.event.response.status", timeframe_from: FROM, timeframe_to: TO });
      expect(cfAccountRequest).toHaveBeenCalledWith("/workers/observability/telemetry/values", {
        method: "POST",
        body: {
          datasets: ["cloudflare-workers"],
          key: "$workers.event.response.status",
          type: "string",
          timeframe: { from: FROM_MS, to: TO_MS },
        },
      });
    });

    it("passes explicit type and dataset", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await call({ action: "values", key: "k", type: "number", dataset: "otel", timeframe_from: FROM, timeframe_to: TO });
      expect(cfAccountRequest.mock.calls[0][1].body).toMatchObject({ datasets: ["otel"], type: "number" });
    });
  });

  describe("action 'query'", () => {
    it("requires timeframe_from and timeframe_to", async () => {
      const result = await call({ action: "query", timeframe_from: FROM });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("action 'query' requires timeframe_to.");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("sends defaults: events view, default dataset, no filters, generated queryId, default limit 20", async () => {
      cfAccountRequest.mockResolvedValueOnce({ events: [] });
      await call({ action: "query", timeframe_from: FROM, timeframe_to: TO });
      const [path, opts] = cfAccountRequest.mock.calls[0];
      expect(path).toBe("/workers/observability/telemetry/query");
      expect(opts.method).toBe("POST");
      expect(opts.body.queryId).toMatch(/^madmcp-\d+$/);
      expect(opts.body).toMatchObject({
        view: "events",
        datasets: ["cloudflare-workers"],
        timeframe: { from: FROM_MS, to: TO_MS },
        parameters: { filters: [] },
      });
      expect(opts.body.limit).toBe(20);
    });

    it("prepends the script_name filter and normalizes filters (operator->operation, inferred type)", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await call({
        action: "query",
        timeframe_from: FROM,
        timeframe_to: TO,
        script_name: "w",
        view: "invocations",
        dataset: "otel",
        limit: 10,
        query_id: "q1",
        filters: [{ key: "$workers.event.response.status", operator: "gt", value: 500 }],
      });
      expect(cfAccountRequest.mock.calls[0][1].body).toEqual({
        queryId: "q1",
        view: "invocations",
        datasets: ["otel"],
        timeframe: { from: FROM_MS, to: TO_MS },
        parameters: {
          filters: [
            { key: "$metadata.service", operation: "eq", type: "string", value: "w" },
            { key: "$workers.event.response.status", operation: "gt", type: "number", value: 500 },
          ],
        },
        limit: 10,
      });
    });

    it("projects events to `fields` when given", async () => {
      const data = { events: { events: [{ timestamp: 1, "$metadata": { level: "error" }, big: { x: "y".repeat(100) } }] }, count: 1 };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await call({ action: "query", timeframe_from: FROM, timeframe_to: TO, fields: ["timestamp", "$metadata"] });
      expect(JSON.parse(result.content[0].text)).toEqual({
        events: { events: [{ timestamp: 1, "$metadata": { level: "error" } }] },
        count: 1,
      });
    });

    it("truncates oversized output with a notice", async () => {
      cfAccountRequest.mockResolvedValueOnce({ events: { events: [{ blob: "z".repeat(50000) }] } });
      const result = await call({ action: "query", timeframe_from: FROM, timeframe_to: TO });
      expect(result.content[0].text).toContain("[truncated: showing 20000 of");
    });

    it("returns compact JSON and lets API errors throw", async () => {
      const data = { events: { events: [{ a: 1 }] } };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await call({ action: "query", timeframe_from: FROM, timeframe_to: TO });
      expect(result.content[0].text).toBe(JSON.stringify(data));
      cfAccountRequest.mockRejectedValueOnce(new Error("500 boom"));
      await expect(call({ action: "query", timeframe_from: FROM, timeframe_to: TO })).rejects.toThrow("500 boom");
    });
  });

  describe("action 'compare'", () => {
    it("requires script_a, script_b and timeframes", async () => {
      const result = await call({ action: "compare", timeframe_from: FROM });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("action 'compare' requires script_a, script_b, timeframe_to.");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("queries both scripts with limit 1000 over the same timeframe and returns a normalized comparison", async () => {
      const evA = [
        { timestamp: 1000, "$metadata": { level: "error", message: "Exception reference = abc123" } },
        { timestamp: 3000, "$workers": { event: { outcome: "loadShed" } } },
      ];
      cfAccountRequest.mockResolvedValueOnce({ events: { events: evA } });
      cfAccountRequest.mockResolvedValueOnce({ events: { events: [] } });

      const result = await call({ action: "compare", script_a: "new", script_b: "old", timeframe_from: FROM, timeframe_to: TO });

      expect(cfAccountRequest).toHaveBeenCalledTimes(2);
      const [bodyA, bodyB] = cfAccountRequest.mock.calls.map((c) => c[1].body);
      expect(bodyA).toMatchObject({
        view: "events",
        datasets: ["cloudflare-workers"],
        timeframe: { from: FROM_MS, to: TO_MS },
        limit: 1000,
      });
      expect(bodyA.parameters.filters[0]).toEqual({ key: "$metadata.service", operation: "eq", type: "string", value: "new" });
      expect(bodyB.parameters.filters[0].value).toBe("old");
      expect(bodyB.limit).toBe(1000);

      const out = JSON.parse(result.content[0].text);
      expect(out.timeframe).toEqual({ from: FROM_MS, to: TO_MS });
      expect(out.scripts).toEqual({ a: "new", b: "old" });
      expect(out.a.sampleSize).toBe(2);
      expect(out.a.sampleSpanSeconds).toBe(2);
      expect(out.a.outcomeCounts).toEqual({ loadShed: 1 });
      expect(out.a.ratesPerSecond).toEqual({ events: 1, loadShed: 0.5, errorLike: 0.5 });
      expect(out.a.topErrorMessages).toEqual([{ message: "Exception reference = <id>", count: 1 }]);
      expect(out.b.sampleSize).toBe(0);
      expect(out.b.ratesPerSecond.events).toBeNull();
      expect(out.note).toContain("NOT a controlled A/B");
    });

    it("flags stuck-socket suspects (wall time >> cpu time)", async () => {
      const ev = { timestamp: 1, source: { durationMS: 21000, cpu_time_ms: 2 } };
      cfAccountRequest.mockResolvedValueOnce({ events: { events: [ev] } });
      cfAccountRequest.mockResolvedValueOnce({ events: { events: [] } });
      const result = await call({ action: "compare", script_a: "a", script_b: "b", timeframe_from: FROM, timeframe_to: TO });
      const out = JSON.parse(result.content[0].text);
      expect(out.a.stuckSocketSuspects.count).toBe(1);
      expect(out.a.stuckSocketSuspects.examples[0]).toMatchObject({ durationMS: 21000, cpuMs: 2, ratio: 10500 });
    });

    it("passes custom dataset, view and limit to both queries", async () => {
      cfAccountRequest.mockResolvedValue({ events: { events: [] } });
      await call({ action: "compare", script_a: "a", script_b: "b", dataset: "otel", view: "invocations", limit: 50, timeframe_from: FROM, timeframe_to: TO });
      for (const [, opts] of cfAccountRequest.mock.calls) {
        expect(opts.body).toMatchObject({ datasets: ["otel"], view: "invocations", limit: 50 });
      }
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValue(new Error("429 slow down"));
      await expect(
        call({ action: "compare", script_a: "a", script_b: "b", timeframe_from: FROM, timeframe_to: TO })
      ).rejects.toThrow("429 slow down");
    });
  });
});
