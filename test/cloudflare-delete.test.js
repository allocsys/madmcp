import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/cloudflare/client.js", () => ({
  cfAccountRequest: vi.fn(),
}));

import { cfAccountRequest } from "../connectors/cloudflare/client.js";
import { register as registerDelete } from "../connectors/cloudflare/delete.js";

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

const CASES = [
  { resource: "d1", id: "abc", path: "/d1/database/abc" },
  { resource: "kv", id: "ns1", path: "/storage/kv/namespaces/ns1" },
  { resource: "r2", id: "b1", path: "/r2/buckets/b1" },
  { resource: "hyperdrive", id: "h1", path: "/hyperdrive/configs/h1" },
];

describe("Cloudflare connector - guarded cf_delete", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerDelete(server);
  });

  it("registers only cf_delete", () => {
    expect(server.names).toEqual(["cf_delete"]);
  });

  it("requires id", async () => {
    const result = await server.tools.cf_delete({ resource: "d1", confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires id");
    expect(cfAccountRequest).not.toHaveBeenCalled();
  });

  it("returns an error for an unknown resource", async () => {
    const result = await server.tools.cf_delete({ resource: "nope", id: "x", confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown resource");
    expect(cfAccountRequest).not.toHaveBeenCalled();
  });

  for (const { resource, id, path } of CASES) {
    describe(`resource '${resource}'`, () => {
      it("refuses without confirm and deletes nothing", async () => {
        const result = await server.tools.cf_delete({ resource, id });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("NOT deleted");
        expect(result.content[0].text).toContain("confirm: true");
        expect(cfAccountRequest).not.toHaveBeenCalled();
      });

      it("refuses when confirm is false", async () => {
        const result = await server.tools.cf_delete({ resource, id, confirm: false });
        expect(result.isError).toBe(true);
        expect(cfAccountRequest).not.toHaveBeenCalled();
      });

      it("refuses when confirm is not strictly true", async () => {
        const result = await server.tools.cf_delete({ resource, id, confirm: "true" });
        expect(result.isError).toBe(true);
        expect(cfAccountRequest).not.toHaveBeenCalled();
      });

      it(`DELETEs ${path} when confirm is true`, async () => {
        const data = { deleted: true };
        cfAccountRequest.mockResolvedValueOnce(data);
        const result = await server.tools.cf_delete({ resource, id, confirm: true });
        expect(cfAccountRequest).toHaveBeenCalledTimes(1);
        expect(cfAccountRequest).toHaveBeenCalledWith(path, { method: "DELETE" });
        expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
      });

      it("lets API errors throw", async () => {
        cfAccountRequest.mockRejectedValueOnce(new Error("404 not found"));
        await expect(server.tools.cf_delete({ resource, id, confirm: true })).rejects.toThrow("404 not found");
      });
    });
  }
});
