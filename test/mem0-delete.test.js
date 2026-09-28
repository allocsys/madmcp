import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/mem/client.js", () => ({
  mem0Request: vi.fn(),
}));

import { mem0Request } from "../connectors/mem/client.js";
import { MEM0_USER_ID } from "../config.js";
import { register as registerDelete } from "../connectors/mem/delete.js";
import { register as registerMem0 } from "../connectors/mem/tools.js";

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

describe("Mem0 connector - consolidated mem0_delete (one/batch/all)", () => {
  let server;

  beforeEach(() => {
    vi.resetAllMocks();
    server = makeFakeServer();
    registerDelete(server);
  });

  it("registers exactly one tool named mem0_delete", () => {
    expect(server.names).toEqual(["mem0_delete"]);
  });

  it("mem0 tools.js registers mem0_delete once and no longer registers the old delete tools", () => {
    const full = makeFakeServer();
    registerMem0(full);
    expect(full.names.filter((n) => n === "mem0_delete")).toHaveLength(1);
    expect(full.names).not.toContain("mem0_delete_batch");
    expect(full.names).not.toContain("mem0_delete_all");
    // the non-delete tools are untouched
    for (const n of ["mem0_find", "mem0_inspect", "mem0_add", "mem0_add_batch", "mem0_update"]) {
      expect(full.names).toContain(n);
    }
  });

  describe("action 'one'", () => {
    it("requires memory_id", async () => {
      const result = await server.tools.mem0_delete({ action: "one" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires memory_id");
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("deletes a single memory", async () => {
      mem0Request.mockResolvedValueOnce({});
      const result = await server.tools.mem0_delete({ action: "one", memory_id: "m1" });
      expect(mem0Request).toHaveBeenCalledWith("/v1/memories/m1/", { method: "DELETE" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Deleted memory (ID: m1).");
    });

    it("lets API errors throw (same as the original tool)", async () => {
      mem0Request.mockRejectedValueOnce(new Error("404 not found"));
      await expect(server.tools.mem0_delete({ action: "one", memory_id: "nope" })).rejects.toThrow("404 not found");
    });
  });

  describe("action 'batch'", () => {
    it("requires a non-empty memory_ids", async () => {
      for (const args of [{ action: "batch" }, { action: "batch", memory_ids: [] }]) {
        const result = await server.tools.mem0_delete(args);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("requires memory_ids");
      }
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("deletes each id and reports per-item success/failure", async () => {
      mem0Request
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({});
      const result = await server.tools.mem0_delete({ action: "batch", memory_ids: ["a", "b", "c"] });
      expect(mem0Request).toHaveBeenCalledTimes(3);
      expect(mem0Request).toHaveBeenCalledWith("/v1/memories/a/", { method: "DELETE" });
      expect(mem0Request).toHaveBeenCalledWith("/v1/memories/b/", { method: "DELETE" });
      expect(mem0Request).toHaveBeenCalledWith("/v1/memories/c/", { method: "DELETE" });
      expect(result.content[0].text).toBe(
        "2/3 deleted.\n\n✓ Deleted: a\n✗ Failed:  b — boom\n✓ Deleted: c"
      );
    });
  });

  describe("action 'all'", () => {
    it("refuses without confirm: true and makes no request", async () => {
      for (const args of [{ action: "all" }, { action: "all", confirm: false, user_id: "u" }]) {
        const result = await server.tools.mem0_delete(args);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Re-call with confirm: true");
      }
      expect(mem0Request).not.toHaveBeenCalled();
    });

    it("defaults to the default user scope when no filters are given", async () => {
      mem0Request.mockResolvedValueOnce({ message: "Memories deleted successfully!" });
      const result = await server.tools.mem0_delete({ action: "all", confirm: true });
      const expectedQs = new URLSearchParams({ user_id: MEM0_USER_ID }).toString();
      expect(mem0Request).toHaveBeenCalledWith(`/v1/memories/?${expectedQs}`, { method: "DELETE" });
      expect(result.content[0].text).toBe(`Memories deleted successfully! (scope: user_id=${MEM0_USER_ID})`);
    });

    it("passes all filters through in order and falls back to the default message", async () => {
      mem0Request.mockResolvedValueOnce({});
      const result = await server.tools.mem0_delete({
        action: "all",
        confirm: true,
        user_id: "u1",
        agent_id: "a1",
        app_id: "app1",
        run_id: "r1",
        metadata: { project: "x" },
      });
      expect(mem0Request).toHaveBeenCalledWith(
        "/v1/memories/?user_id=u1&agent_id=a1&app_id=app1&run_id=r1&metadata=%7B%22project%22%3A%22x%22%7D",
        { method: "DELETE" }
      );
      expect(result.content[0].text).toBe(
        'Memories deleted. (scope: user_id=u1, agent_id=a1, app_id=app1, run_id=r1, metadata={"project":"x"})'
      );
    });

    it("does not add the default user when only a non-user filter is given", async () => {
      mem0Request.mockResolvedValueOnce({ message: "ok" });
      await server.tools.mem0_delete({ action: "all", confirm: true, agent_id: "a1" });
      expect(mem0Request).toHaveBeenCalledWith("/v1/memories/?agent_id=a1", { method: "DELETE" });
    });

    it("adds the wildcard warning when '*' is used", async () => {
      mem0Request.mockResolvedValueOnce({ message: "done" });
      const result = await server.tools.mem0_delete({ action: "all", confirm: true, user_id: "*" });
      expect(result.content[0].text).toBe(
        "done (scope: user_id=*) — wildcard used, this may have affected multiple entities."
      );
    });
  });
});
