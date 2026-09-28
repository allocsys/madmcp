import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/cloudflare/client.js", () => ({
  cfAccountRequest: vi.fn(),
}));

import { cfAccountRequest } from "../connectors/cloudflare/client.js";
import { register as registerHyperdrive } from "../connectors/cloudflare/hyperdrive.js";

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

describe("Cloudflare connector - consolidated Hyperdrive tools", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerHyperdrive(server);
  });

  it("registers the new Hyperdrive tools and drops the old names", () => {
    expect(server.names).toEqual(["cf_hyperdrive_read", "cf_hyperdrive_manage"]);
    for (const old of ["cf_hyperdrive_config", "cf_hyperdrive_config_update", "cf_hyperdrive_config_delete"]) {
      expect(server.names).not.toContain(old);
    }
  });

  describe("cf_hyperdrive_read 'get'", () => {
    it("requires hyperdrive_id", async () => {
      const result = await server.tools.cf_hyperdrive_read({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires hyperdrive_id");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("requests /hyperdrive/configs/{id} and returns pretty-printed JSON", async () => {
      const data = { id: "h1" };
      cfAccountRequest.mockResolvedValueOnce(data);
      const result = await server.tools.cf_hyperdrive_read({ action: "get", hyperdrive_id: "h1" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/hyperdrive/configs/h1");
      expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("404 not found"));
      await expect(
        server.tools.cf_hyperdrive_read({ action: "get", hyperdrive_id: "x" })
      ).rejects.toThrow("404 not found");
    });
  });

  describe("cf_hyperdrive_read 'list'", () => {
    it("requests /hyperdrive/configs with no query string by default", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_hyperdrive_read({ action: "list" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/hyperdrive/configs");
    });

    it("passes page, per_page, order and direction as query params", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_hyperdrive_read({ action: "list", page: 2, per_page: 5, order: "name", direction: "desc" });
      expect(cfAccountRequest).toHaveBeenCalledWith(
        "/hyperdrive/configs?page=2&per_page=5&order=name&direction=desc"
      );
    });

    it("ignores hyperdrive_id when listing", async () => {
      cfAccountRequest.mockResolvedValueOnce([]);
      await server.tools.cf_hyperdrive_read({ action: "list", hyperdrive_id: "h1" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/hyperdrive/configs");
    });
  });

  describe("cf_hyperdrive_manage 'update'", () => {
    it("requires hyperdrive_id", async () => {
      const result = await server.tools.cf_hyperdrive_manage({ action: "update", name: "n" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires hyperdrive_id");
      expect(cfAccountRequest).not.toHaveBeenCalled();
    });

    it("PATCHes an empty body when no fields are given", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await server.tools.cf_hyperdrive_manage({ action: "update", hyperdrive_id: "h1" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/hyperdrive/configs/h1", { method: "PATCH", body: {} });
    });

    it("maps name to the top level", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await server.tools.cf_hyperdrive_manage({ action: "update", hyperdrive_id: "h1", name: "renamed" });
      expect(cfAccountRequest).toHaveBeenCalledWith("/hyperdrive/configs/h1", {
        method: "PATCH",
        body: { name: "renamed" },
      });
    });

    it("nests origin fields under origin", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await server.tools.cf_hyperdrive_manage({
        action: "update",
        hyperdrive_id: "h1",
        database: "db",
        host: "h.example.com",
        port: 5432,
        scheme: "postgresql",
        user: "u",
      });
      expect(cfAccountRequest).toHaveBeenCalledWith("/hyperdrive/configs/h1", {
        method: "PATCH",
        body: { origin: { database: "db", host: "h.example.com", port: 5432, scheme: "postgresql", user: "u" } },
      });
    });

    it("nests caching fields under caching, keeping false and 0", async () => {
      cfAccountRequest.mockResolvedValueOnce({});
      await server.tools.cf_hyperdrive_manage({
        action: "update",
        hyperdrive_id: "h1",
        caching_disabled: false,
        caching_max_age: 0,
        caching_stale_while_revalidate: 15,
      });
      expect(cfAccountRequest).toHaveBeenCalledWith("/hyperdrive/configs/h1", {
        method: "PATCH",
        body: { caching: { disabled: false, max_age: 0, stale_while_revalidate: 15 } },
      });
    });

    it("lets API errors throw", async () => {
      cfAccountRequest.mockRejectedValueOnce(new Error("403 forbidden"));
      await expect(
        server.tools.cf_hyperdrive_manage({ action: "update", hyperdrive_id: "h1", name: "n" })
      ).rejects.toThrow("403 forbidden");
    });
  });
});
