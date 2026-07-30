// ---------------------------------------------------------------------------
// test/github-files.test.js
//
// Direct unit coverage for connectors/github/files.js. Previously the only
// coverage touching this module was mcp-integration.test.js exercising
// get_repo (a different connector) through the Zod/schema path -- none of
// the actual file-tool handlers (create_repo_file, edit_file, delete_file,
// rename_file, overwrite_files) had a single test.
//
// This matters most for `edit_file`, which absorbed both the old
// `str_replace`-style targeted find/replace tool and the old
// `overwrite_files`-style single-file full-content write into one tool with
// two mutually-exclusive modes. Both modes, the guard that enforces
// mutual exclusivity, and the unified-diff builder used by the
// `replacements` mode are covered here.
//
// githubRequest/toBase64/readFileViaBlob are mocked -- this is a handler
// unit test, not a live-network test (see mcp-integration.test.js /
// server-e2e.test.js for tests that go through the real MCP/HTTP stack).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  toBase64: (str) => Buffer.from(str, "utf-8").toString("base64"),
}));

vi.mock("../connectors/github/helpers.js", () => ({
  readFileViaBlob: vi.fn(),
  CHUNK_SIZE: 20000,
  CHUNK_THRESHOLD: 100000,
}));

import { githubRequest } from "../connectors/github/client.js";
import { readFileViaBlob } from "../connectors/github/helpers.js";
import { register } from "../connectors/github/files.js";

// Minimal fake MCP server: just captures the handler function for each
// registered tool name so tests can call it directly.
function makeFakeServer() {
  const tools = {};
  return {
    tool: (name, _description, _schema, handler) => {
      tools[name] = handler;
    },
    tools,
  };
}

describe("connectors/github/files.js", () => {
  let server;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    register(server);
  });

  describe("edit_file — mode selection", () => {
    it("rejects when neither content nor replacements is provided", async () => {
      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/exactly one of/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("rejects when both content and replacements are provided", async () => {
      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m",
        content: "full content",
        replacements: [{ find: "x", replace: "y" }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/exactly one of/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });
  });

  describe("edit_file — content (full overwrite) mode", () => {
    it("creates the file when it doesn't already exist (no sha sent)", async () => {
      githubRequest
        .mockRejectedValueOnce(new Error("GitHub API error (404): Not Found")) // existence check
        .mockResolvedValueOnce({ commit: { sha: "abc1234567" } });             // PUT

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "new.txt",
        content: "hello world", message: "create new.txt",
      });

      expect(result.content[0].text).toMatch(/^Created new\.txt/);
      const putCall = githubRequest.mock.calls[1];
      expect(putCall[1].body.sha).toBeUndefined();
      expect(putCall[1].body.content).toBe(Buffer.from("hello world").toString("base64"));
    });

    it("overwrites the file when it already exists (sha sent from existing blob)", async () => {
      githubRequest
        .mockResolvedValueOnce({ sha: "existing-sha" })            // existence check
        .mockResolvedValueOnce({ commit: { sha: "def7654321" } }); // PUT

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "existing.txt",
        content: "new content", message: "overwrite existing.txt",
      });

      expect(result.content[0].text).toMatch(/^Overwrote existing\.txt/);
      const putCall = githubRequest.mock.calls[1];
      expect(putCall[1].body.sha).toBe("existing-sha");
    });
  });

  describe("edit_file — replacements (targeted find/replace) mode", () => {
    it("aborts the whole call if a find string is not found, without committing", async () => {
      readFileViaBlob.mockResolvedValue("line one\nline two\n");

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m",
        replacements: [{ find: "does not exist", replace: "x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/string not found/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("aborts the whole call if a find string appears more than once, without committing", async () => {
      readFileViaBlob.mockResolvedValue("dup\ndup\n");

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m",
        replacements: [{ find: "dup", replace: "x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/found 2 times/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("reports no changes when all replacements are no-ops, without committing", async () => {
      readFileViaBlob.mockResolvedValue("same\n");

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m",
        replacements: [{ find: "same", replace: "same" }],
      });

      expect(result.content[0].text).toMatch(/no changes/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("commits a valid unique replacement and returns a unified diff", async () => {
      readFileViaBlob.mockResolvedValue("alpha\nbeta\ngamma\n");
      githubRequest
        .mockResolvedValueOnce({ sha: "existing-sha" })            // existence check before PUT
        .mockResolvedValueOnce({ commit: { sha: "aaa1111111" } }); // PUT

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "swap beta",
        replacements: [{ find: "beta", replace: "BETA" }],
      });

      expect(result.content[0].text).toMatch(/Committed 1 replacement/);
      expect(result.content[0].text).toMatch(/-beta/);
      expect(result.content[0].text).toMatch(/\+BETA/);

      const putCall = githubRequest.mock.calls[1];
      const committedContent = Buffer.from(putCall[1].body.content, "base64").toString("utf-8");
      expect(committedContent).toBe("alpha\nBETA\ngamma\n");
      expect(putCall[1].body.sha).toBe("existing-sha");
    });

    it("applies multiple replacements sequentially in one commit", async () => {
      readFileViaBlob.mockResolvedValue("one\ntwo\nthree\n");
      githubRequest
        .mockResolvedValueOnce({ sha: "existing-sha" })
        .mockResolvedValueOnce({ commit: { sha: "bbb2222222" } });

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "swap two",
        replacements: [
          { find: "one", replace: "ONE" },
          { find: "three", replace: "THREE" },
        ],
      });

      expect(result.content[0].text).toMatch(/Committed 2 replacement/);
      const putCall = githubRequest.mock.calls[1];
      const committedContent = Buffer.from(putCall[1].body.content, "base64").toString("utf-8");
      expect(committedContent).toBe("ONE\ntwo\nTHREE\n");
    });
  });

  describe("overwrite_files — atomic multi-file commit", () => {
    it("writes a blob per file, builds one tree, and commits once for all files", async () => {
      githubRequest
        .mockResolvedValueOnce({ default_branch: "main" })                       // repo info
        .mockResolvedValueOnce({ object: { sha: "base-ref-sha" } })              // ref lookup
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })               // base commit
        .mockResolvedValueOnce({ sha: "blob-sha-1" })                            // blob for file 1
        .mockResolvedValueOnce({ sha: "blob-sha-2" })                            // blob for file 2
        .mockResolvedValueOnce({ sha: "new-tree-sha" })                         // new tree
        .mockResolvedValueOnce({ sha: "new-commit-sha1234" })                    // new commit
        .mockResolvedValueOnce({});                                             // ref update

      const result = await server.tools.overwrite_files({
        owner: "allocsys", repo: "madmcp", message: "batch update",
        files: [
          { path: "a.txt", content: "A" },
          { path: "b.txt", content: "B" },
        ],
      });

      expect(result.content[0].text).toMatch(/Pushed 2 file\(s\)/);

      const treeCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/trees"));
      expect(treeCall[1].body.base_tree).toBe("base-tree-sha");
      expect(treeCall[1].body.tree).toEqual([
        { path: "a.txt", mode: "100644", type: "blob", sha: "blob-sha-1" },
        { path: "b.txt", mode: "100644", type: "blob", sha: "blob-sha-2" },
      ]);

      const refUpdateCall = githubRequest.mock.calls.find((c) => c[1]?.method === "PATCH");
      expect(refUpdateCall[1].body.sha).toBe("new-commit-sha1234");
    });
  });

  describe("create_repo_file", () => {
    it("refuses to overwrite a file that already exists", async () => {
      githubRequest.mockResolvedValueOnce({ sha: "already-here" }); // existence check succeeds

      await expect(server.tools.create_repo_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt",
        content: "x", message: "m",
      })).rejects.toThrow(/already exists/i);

      // Only the existence check should have run -- no PUT.
      expect(githubRequest).toHaveBeenCalledTimes(1);
    });

    it("creates the file when the path is free (404 on existence check)", async () => {
      githubRequest
        .mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"))
        .mockResolvedValueOnce({ commit: { sha: "ccc3333333" } });

      const result = await server.tools.create_repo_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt",
        content: "x", message: "m",
      });

      expect(result.content[0].text).toMatch(/^Created a\.txt/);
    });
  });

  describe("delete_file", () => {
    it("deletes an existing file, sending its current sha in the DELETE body", async () => {
      githubRequest
        .mockResolvedValueOnce({ sha: "file-sha-1" }) // existence/GET check
        .mockResolvedValueOnce({});                   // DELETE

      const result = await server.tools.delete_file({
        owner: "allocsys", repo: "madmcp", path: "gone.txt", message: "remove gone.txt",
      });

      expect(result.content[0].text).toMatch(/^Deleted gone\.txt/);
      const deleteCall = githubRequest.mock.calls[1];
      expect(deleteCall[1].method).toBe("DELETE");
      expect(deleteCall[1].body.sha).toBe("file-sha-1");
      expect(deleteCall[1].body.message).toBe("remove gone.txt");
    });

    it("passes branch through to both the existence check and the DELETE", async () => {
      githubRequest
        .mockResolvedValueOnce({ sha: "file-sha-2" })
        .mockResolvedValueOnce({});

      await server.tools.delete_file({
        owner: "allocsys", repo: "madmcp", path: "gone.txt", message: "remove", branch: "feature-x",
      });

      const getCall = githubRequest.mock.calls[0];
      expect(getCall[0]).toContain("?ref=feature-x");
      const deleteCall = githubRequest.mock.calls[1];
      expect(deleteCall[1].body.branch).toBe("feature-x");
    });

    it("propagates the error when the file does not exist", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

      await expect(server.tools.delete_file({
        owner: "allocsys", repo: "madmcp", path: "missing.txt", message: "m",
      })).rejects.toThrow(/404/);

      expect(githubRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("rename_file", () => {
    it("moves a file via blob+tree+commit, adding the new path and removing the old one", async () => {
      readFileViaBlob.mockResolvedValue("moved content\n");
      githubRequest
        .mockResolvedValueOnce({ default_branch: "main" })          // repo info
        .mockResolvedValueOnce({ object: { sha: "ref-sha" } })       // ref lookup
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })   // base commit
        .mockResolvedValueOnce({ sha: "new-blob-sha" })              // new blob
        .mockResolvedValueOnce({ sha: "new-tree-sha" })              // new tree
        .mockResolvedValueOnce({ sha: "new-commit-sha1234" })        // new commit
        .mockResolvedValueOnce({});                                  // ref update

      const result = await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "old/name.txt", new_path: "new/name.txt",
      });

      expect(result.content[0].text).toMatch(/^Renamed old\/name\.txt → new\/name\.txt/);

      const treeCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/trees"));
      expect(treeCall[1].body.base_tree).toBe("base-tree-sha");
      expect(treeCall[1].body.tree).toEqual([
        { path: "new/name.txt", mode: "100644", type: "blob", sha: "new-blob-sha" },
        { path: "old/name.txt", mode: "100644", type: "blob", sha: null },
      ]);

      const commitCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/commits") && c[1]?.method === "POST");
      expect(commitCall[1].body.message).toBe("rename old/name.txt to new/name.txt");

      const refUpdateCall = githubRequest.mock.calls.find((c) => c[1]?.method === "PATCH");
      expect(refUpdateCall[1].body.sha).toBe("new-commit-sha1234");
    });

    it("uses a custom commit message when provided", async () => {
      readFileViaBlob.mockResolvedValue("content\n");
      githubRequest
        .mockResolvedValueOnce({ default_branch: "main" })
        .mockResolvedValueOnce({ object: { sha: "ref-sha" } })
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })
        .mockResolvedValueOnce({ sha: "blob-sha" })
        .mockResolvedValueOnce({ sha: "tree-sha" })
        .mockResolvedValueOnce({ sha: "commit-sha" })
        .mockResolvedValueOnce({});

      await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "a.txt", new_path: "b.txt", message: "tidy up naming",
      });

      const commitCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/commits") && c[1]?.method === "POST");
      expect(commitCall[1].body.message).toBe("tidy up naming");
    });

    it("targets the given branch instead of the repo default", async () => {
      readFileViaBlob.mockResolvedValue("content\n");
      githubRequest
        .mockResolvedValueOnce({ default_branch: "main" })
        .mockResolvedValueOnce({ object: { sha: "ref-sha" } })
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })
        .mockResolvedValueOnce({ sha: "blob-sha" })
        .mockResolvedValueOnce({ sha: "tree-sha" })
        .mockResolvedValueOnce({ sha: "commit-sha" })
        .mockResolvedValueOnce({});

      await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "a.txt", new_path: "b.txt", branch: "feature-y",
      });

      expect(readFileViaBlob).toHaveBeenCalledWith("allocsys", "madmcp", "a.txt", "feature-y");
      const refLookupCall = githubRequest.mock.calls.find((c) => c[0].includes("/git/ref/heads/"));
      expect(refLookupCall[0]).toContain("feature-y");
      const refUpdateCall = githubRequest.mock.calls.find((c) => c[1]?.method === "PATCH");
      expect(refUpdateCall[0]).toContain("feature-y");
    });
  });
});
