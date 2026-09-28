import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/cloudflare/client.js", () => ({
  cfAccountRequest: vi.fn(),
}));

import { cfAccountRequest } from "../connectors/cloudflare/client.js";
import { register as registerR2 } from "../connectors/cloudflare/r2.js";

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

describe("Cloudflare connector - consolidated R2 tools", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerR2(server);
  });

  it("registers the new R2 tools and drops the old names", () => {
    expect(server.names).toEqual(["cf_r2_read", "cf_r2_manage"]);
    for (const old of ["cf_r2_bucket", "cf_r2_bucket_create", "cf_r2_bucket_delete"]) {
      expect(server.names).not.toContain(old);
    }
  });

  describe("cf_r2_read 'get'", () => {
    it("requires name", async () => {
      const result = await server.tools.cf_r2_read({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires name");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("requests /r2/buckets/{name} and returns pretty-printed JSON", async () => {
      const data = { name: "b1" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_r2_read({ action: "get", name: "b1" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/r2/buckets/b1");
      expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("404 not found"));
      await expect(server.tools.cf_r2_read({ action: "get", name: "x" })).rejects.toThrow("404 not found");
    });
  });

  describe("cf_r2_read 'list'", () => {
    it("requests /r2/buckets with no query string by default", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_r2_read({ action: "list" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/r2/buckets");
    });

    it("passes list params as query params", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_r2_read({
        action: "list",
        cursor: "c1",
        direction: "desc",
        name_contains: "log",
        per_page: 5,
        start_after: "a",
      });
      expect(cfAccountRequest).toHaveBeenCalledWith(
        "/r2/buckets?cursor=c1&direction=desc&name_contains=log&per_page=5&start_after=a"
      );
    });

    it("ignores name when listing", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_r2_read({ action: "list", name: "b1" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/r2/buckets");
    });
  });

  describe("cf_r2_manage 'create'", () => {
    it("requires name", async () => {
      const result = await server.tools.cf_r2_manage({ action: "create" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires name");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("POSTs name", async () => {
      const data = { name: "new" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_r2_manage({ action: "create", name: "new" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/r2/buckets", {
        method: "POST",
        body: { name: "new" },
      });
      expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("409 conflict"));
      await expect(server.tools.cf_r2_manage({ action: "create", name: "new" })).rejects.toThrow("409 conflict");
    });
  });
});
