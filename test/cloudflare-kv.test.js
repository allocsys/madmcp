import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/cloudflare/client.js", () => ({
  cfAccountRequest: vi.fn(),
}));

import { cfAccountRequest } from "../connectors/cloudflare/client.js";
import { register as registerKv } from "../connectors/cloudflare/kv.js";

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

describe("Cloudflare connector - consolidated KV tools", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerKv(server);
  });

  it("registers the new KV tools and drops the old names", () => {
    expect(server.names).toEqual(["cf_kv_read", "cf_kv_manage"]);
    for (const old of ["cf_kv_namespace", "cf_kv_namespace_create", "cf_kv_namespace_update", "cf_kv_namespace_delete"]) {
      expect(server.names).not.toContain(old);
    }
  });

  describe("cf_kv_read 'get'", () => {
    it("requires namespace_id", async () => {
      const result = await server.tools.cf_kv_read({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires namespace_id");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("requests /storage/kv/namespaces/{id} and returns pretty-printed JSON", async () => {
      const data = { id: "ns1", title: "t" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_kv_read({ action: "get", namespace_id: "ns1" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/storage/kv/namespaces/ns1");
      expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("404 not found"));
      await expect(server.tools.cf_kv_read({ action: "get", namespace_id: "x" })).rejects.toThrow("404 not found");
    });
  });

  describe("cf_kv_read 'list'", () => {
    it("requests /storage/kv/namespaces with no query string by default", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_kv_read({ action: "list" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/storage/kv/namespaces");
    });

    it("passes page, per_page, order and direction as query params", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_kv_read({ action: "list", page: 2, per_page: 5, order: "title", direction: "desc" });
      expect(cfAccountRequest).toHaveBeenCalledWith(
        "/storage/kv/namespaces?page=2&per_page=5&order=title&direction=desc"
      );
    });

    it("ignores namespace_id when listing", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_kv_read({ action: "list", namespace_id: "ns1" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/storage/kv/namespaces");
    });
  });

  describe("cf_kv_manage 'create'", () => {
    it("requires title", async () => {
      const result = await server.tools.cf_kv_manage({ action: "create" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires title");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("POSTs title", async () => {
      const data = { id: "new" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_kv_manage({ action: "create", title: "my-ns" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/storage/kv/namespaces", {
        method: "POST",
        body: { title: "my-ns" },
      });
      expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
    });
  });

  describe("cf_kv_manage 'update'", () => {
    it("names both missing params", async () => {
      const result = await server.tools.cf_kv_manage({ action: "update" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("namespace_id and title");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("names only the missing param", async () => {
      const result = await server.tools.cf_kv_manage({ action: "update", namespace_id: "ns1" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires title");
      expect(result.content[0].text).not.toContain("namespace_id");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("PUTs title to /storage/kv/namespaces/{id}", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await server.tools.cf_kv_manage({ action: "update", namespace_id: "ns1", title: "renamed" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/storage/kv/namespaces/ns1", {
        method: "PUT",
        body: { title: "renamed" },
      });
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("403 forbidden"));
      await expect(
        server.tools.cf_kv_manage({ action: "update", namespace_id: "ns1", title: "t" })
      ).rejects.toThrow("403 forbidden");
    });
  });
});
