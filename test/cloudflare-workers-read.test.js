import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/cloudflare/client.js", () => ({
  cfAccountRequest: vi.fn(),
}));

import { cfAccountRequest } from "../connectors/cloudflare/client.js";
import { register as registerWorkers } from "../connectors/cloudflare/workers.js";

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

describe("Cloudflare connector - consolidated cf_workers_read (list/get/code)", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerWorkers(server);
  });

  it("registers cf_workers_read once and no longer registers the old workers tools", () => {
    expect(server.names).toEqual(["cf_workers_read"]);
    for (const old of ["cf_workers_list", "cf_workers_get_worker", "cf_workers_get_worker_code"]) {
      expect(server.names).not.toContain(old);
    }
  });

  describe("action 'list'", () => {
    it("requests /workers/scripts and returns compact JSON", async () => {
      const data = [{ id: "a" }, { id: "b" }];
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_workers_read({ action: "list" });
      expect(cfAccountRequest).toHaveBeenCalledTimes(1);
      expect(cfAccountRequest).toHaveBeenCalledWith("/workers/scripts");
      expect(result.content[0].text).toBe(JSON.stringify(data));
      expect(result.isError).toBeUndefined();
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("403 forbidden"));
      await expect(server.tools.cf_workers_read({ action: "list" })).rejects.toThrow("403 forbidden");
    });
  });

  describe("action 'get'", () => {
    it("requires scriptName", async () => {
      const result = await server.tools.cf_workers_read({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires scriptName");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("requests /workers/scripts/{name}/settings", async () => {
      const data = { compatibility_date: "2026-01-01" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_workers_read({ action: "get", scriptName: "my-worker" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/workers/scripts/my-worker/settings");
      expect(result.content[0].text).toBe(JSON.stringify(data));
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("404 not found"));
      await expect(
        server.tools.cf_workers_read({ action: "get", scriptName: "nope" })
      ).rejects.toThrow("404 not found");
    });
  });

  describe("action 'code'", () => {
    it("requires scriptName", async () => {
      const result = await server.tools.cf_workers_read({ action: "code" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires scriptName");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("requests /workers/scripts/{name} and passes string source through unchanged", async () => {
      const source = "export default { fetch() { return new Response('hi'); } };";
      cfAccountRequest.mockResolvedValueOnce(source);
      const result = await server.tools.cf_workers_read({ action: "code", scriptName: "my-worker" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/workers/scripts/my-worker");
      expect(result.content[0].text).toBe(source);
    });

    it("pages large source with offset/limit and reports the next offset", async () => {
      const source = "a".repeat(25000) + "b".repeat(5000);
      cfAccountRequest.mockResolvedValueOnce(source);
      let text = (await server.tools.cf_workers_read({ action: "code", scriptName: "w" })).content[0].text;
      expect(text.startsWith("a".repeat(20000))).toBe(true);
      expect(text).toContain("showing characters 0-20000 of 30000");
      expect(text).toContain("offset=20000");

      cfAccountRequest.mockResolvedValueOnce(source);
      text = (await server.tools.cf_workers_read({ action: "code", scriptName: "w", offset: 20000 })).content[0].text;
      expect(text.startsWith("a".repeat(5000) + "b".repeat(5000))).toBe(true);
      expect(text).toContain("showing characters 20000-30000 of 30000");
      expect(text).toContain("End of content");
    });

    it("honours a custom limit and reports an offset past the end", async () => {
      cfAccountRequest.mockResolvedValueOnce("0123456789");
      let text = (await server.tools.cf_workers_read({ action: "code", scriptName: "w", limit: 4 })).content[0].text;
      expect(text.startsWith("0123\n")).toBe(true);
      expect(text).toContain("offset=4");

      cfAccountRequest.mockResolvedValueOnce("0123456789");
      text = (await server.tools.cf_workers_read({ action: "code", scriptName: "w", offset: 50 })).content[0].text;
      expect(text).toContain("past the end");
    });

    it("JSON-stringifies non-string responses", async () => {
      const data = { result: "x" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_workers_read({ action: "code", scriptName: "w" });
      expect(result.content[0].text).toBe(JSON.stringify(data));
    });
  });
});
