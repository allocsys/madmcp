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
// Regression coverage for the files.js audit fixes is also here:
//   - edit_file replacements: dollar-sign patterns in new_str are literal
//   - edit_file replacements: PUT carries the blob sha that was READ (a
//     concurrent commit surfaces as an error instead of being overwritten)
//   - rename_file: reuses the existing blob sha + mode (no text round-trip,
//     so binary files and exec bits survive; no blob POST)
//   - edit_file (full overwrite) / create_repo_file: only a 404 means
//     "path is free"; any other error is rethrown
//
// githubRequest/toBase64/readFileWithSha/readFileViaBlob are mocked -- this
// is a handler unit test, not a live-network test (see
// mcp-integration.test.js / server-e2e.test.js for tests that go through the
// real MCP/HTTP stack).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  toBase64: (str) => Buffer.from(str, "utf-8").toString("base64"),
}));

vi.mock("../connectors/github/helpers.js", () => ({
  readFileViaBlob: vi.fn(),
  readFileWithSha: vi.fn(),
  CHUNK_SIZE: 20000,
  CHUNK_THRESHOLD: 100000,
}));

import { githubRequest } from "../connectors/github/client.js";
import { readFileWithSha, readFileViaBlob } from "../connectors/github/helpers.js";
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

// Queues the six githubRequest responses rename_file makes, in order:
// ref, base commit, base tree (recursive), new tree, new commit, ref update.
function mockRenameRequests({ tree, truncated = false } = {}) {
  githubRequest
    .mockResolvedValueOnce({ object: { sha: "ref-sha" } })                        // ref lookup
    .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })                    // base commit
    .mockResolvedValueOnce({ tree: tree ?? [], truncated })                       // base tree (recursive)
    .mockResolvedValueOnce({ sha: "new-tree-sha" })                               // new tree
    .mockResolvedValueOnce({ sha: "new-commit-sha1234" })                         // new commit
    .mockResolvedValueOnce({});                                                   // ref update
}

describe("connectors/github/files.js", () => {
  let server;

  beforeEach(() => {
    // mockReset (not just clear): drops any unconsumed mockResolvedValueOnce
    // queue so one failing test can't cascade into the tests after it.
    vi.resetAllMocks();
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
        replacements: [{ old_str: "x", new_str: "y" }],
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
        content: "hello world", message: "create new.txt", branch: "main",
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
        content: "new content", message: "overwrite existing.txt", branch: "main",
      });

      expect(result.content[0].text).toMatch(/^Overwrote existing\.txt/);
      const putCall = githubRequest.mock.calls[1];
      expect(putCall[1].body.sha).toBe("existing-sha");
    });

    it("rethrows a non-404 error from the existence check instead of treating the file as new", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (403): rate limit exceeded"));

      await expect(server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "existing.txt",
        content: "new content", message: "m", branch: "main",
      })).rejects.toThrow(/403/);

      // Existence check only -- no PUT was attempted.
      expect(githubRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("edit_file — replacements (targeted str_replace) mode", () => {
    it("aborts the whole call if an old_str string is not found, without committing", async () => {
      readFileWithSha.mockResolvedValue({ content: "line one\nline two\n", blobSha: "blob-1" });

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m", branch: "main",
        replacements: [{ old_str: "does not exist", new_str: "x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/string not found/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("aborts the whole call if an old_str string appears more than once, without committing", async () => {
      readFileWithSha.mockResolvedValue({ content: "dup\ndup\n", blobSha: "blob-1" });

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m", branch: "main",
        replacements: [{ old_str: "dup", new_str: "x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/found 2 times/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("reports no changes when all replacements are no-ops, without committing", async () => {
      readFileWithSha.mockResolvedValue({ content: "same\n", blobSha: "blob-1" });

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m", branch: "main",
        replacements: [{ old_str: "same", new_str: "same" }],
      });

      expect(result.content[0].text).toMatch(/no changes/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("commits a valid unique replacement and returns a short confirmation (no diff by default)", async () => {
      readFileWithSha.mockResolvedValue({ content: "alpha\nbeta\ngamma\n", blobSha: "blob-read-sha" });
      githubRequest.mockResolvedValueOnce({ commit: { sha: "aaa1111111" } }); // PUT

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "swap beta", branch: "main",
        replacements: [{ old_str: "beta", new_str: "BETA" }],
      });

      expect(result.content[0].text).toMatch(/Committed 1 replacement/);
      expect(result.content[0].text).not.toMatch(/-beta/);
      expect(result.content[0].text).not.toMatch(/\+BETA/);
      expect(result.content[0].text).not.toMatch(/--- a\.txt/);

      expect(readFileWithSha).toHaveBeenCalledWith("allocsys", "madmcp", "a.txt", "main");
      // The PUT is the only githubRequest -- the read went through readFileWithSha.
      expect(githubRequest).toHaveBeenCalledTimes(1);
      const putCall = githubRequest.mock.calls[0];
      expect(putCall[1].method).toBe("PUT");
      const committedContent = Buffer.from(putCall[1].body.content, "base64").toString("utf-8");
      expect(committedContent).toBe("alpha\nBETA\ngamma\n");
      expect(putCall[1].body.sha).toBe("blob-read-sha");
      expect(putCall[1].body.branch).toBe("main");
    });

    it("still builds and returns the unified diff when EDIT_FILE_INCLUDE_DIFF=true", async () => {
      vi.stubEnv("EDIT_FILE_INCLUDE_DIFF", "true");
      try {
        readFileWithSha.mockResolvedValue({ content: "alpha\nbeta\ngamma\n", blobSha: "blob-1" });
        githubRequest.mockResolvedValueOnce({ commit: { sha: "aaa1111111" } });

        const result = await server.tools.edit_file({
          owner: "allocsys", repo: "madmcp", path: "a.txt", message: "swap beta", branch: "main",
          replacements: [{ old_str: "beta", new_str: "BETA" }],
        });

        expect(result.content[0].text).toMatch(/Committed 1 replacement/);
        expect(result.content[0].text).toMatch(/-beta/);
        expect(result.content[0].text).toMatch(/\+BETA/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("applies multiple replacements sequentially in one commit", async () => {
      readFileWithSha.mockResolvedValue({ content: "one\ntwo\nthree\n", blobSha: "blob-1" });
      githubRequest.mockResolvedValueOnce({ commit: { sha: "bbb2222222" } });

      const result = await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "swap two", branch: "main",
        replacements: [
          { old_str: "one", new_str: "ONE" },
          { old_str: "three", new_str: "THREE" },
        ],
      });

      expect(result.content[0].text).toMatch(/Committed 2 replacement/);
      const putCall = githubRequest.mock.calls[0];
      const committedContent = Buffer.from(putCall[1].body.content, "base64").toString("utf-8");
      expect(committedContent).toBe("ONE\ntwo\nTHREE\n");
    });

    it("treats dollar-sign patterns in new_str literally (no $& / $$ / $` / $' expansion)", async () => {
      readFileWithSha.mockResolvedValue({ content: "price: X\n", blobSha: "blob-1" });
      githubRequest.mockResolvedValueOnce({ commit: { sha: "ddd4444444" } });

      const newStr = "$& $$ $` $' $1";
      await server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m", branch: "main",
        replacements: [{ old_str: "X", new_str: newStr }],
      });

      const putCall = githubRequest.mock.calls[0];
      const committedContent = Buffer.from(putCall[1].body.content, "base64").toString("utf-8");
      expect(committedContent).toBe(`price: ${newStr}\n`);
    });

    it("propagates a 409 from the PUT when the file changed since it was read (no silent overwrite)", async () => {
      readFileWithSha.mockResolvedValue({ content: "alpha\nbeta\n", blobSha: "stale-blob-sha" });
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (409): sha does not match"));

      await expect(server.tools.edit_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", message: "m", branch: "main",
        replacements: [{ old_str: "beta", new_str: "BETA" }],
      })).rejects.toThrow(/409/);

      // Exactly one PUT, carrying the sha from the read -- no re-fetch of a fresher sha.
      expect(githubRequest).toHaveBeenCalledTimes(1);
      expect(githubRequest.mock.calls[0][1].body.sha).toBe("stale-blob-sha");
    });
  });

  describe("overwrite_files — atomic multi-file commit", () => {
    it("writes a blob per file, builds one tree, and commits once for all files", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "base-ref-sha" } })              // ref lookup
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })               // base commit
        .mockResolvedValueOnce({ sha: "blob-sha-1" })                            // blob for file 1
        .mockResolvedValueOnce({ sha: "blob-sha-2" })                            // blob for file 2
        .mockResolvedValueOnce({ sha: "new-tree-sha" })                         // new tree
        .mockResolvedValueOnce({ sha: "new-commit-sha1234" })                    // new commit
        .mockResolvedValueOnce({});                                             // ref update

      const result = await server.tools.overwrite_files({
        owner: "allocsys", repo: "madmcp", branch: "main", message: "batch update",
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
        content: "x", message: "m", branch: "main",
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
        content: "x", message: "m", branch: "main",
      });

      expect(result.content[0].text).toMatch(/^Created a\.txt/);
    });

    it("rethrows a non-404 error from the existence check instead of assuming the path is free", async () => {
      githubRequest.mockRejectedValueOnce(new Error("GitHub API error (500): Server Error"));

      await expect(server.tools.create_repo_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt",
        content: "x", message: "m", branch: "main",
      })).rejects.toThrow(/500/);

      // Existence check only -- no PUT was attempted.
      expect(githubRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete_file", () => {
    it("deletes an existing file, sending its current sha in the DELETE body", async () => {
      githubRequest
        .mockResolvedValueOnce({ sha: "file-sha-1" }) // existence/GET check
        .mockResolvedValueOnce({});                   // DELETE

      const result = await server.tools.delete_file({
        owner: "allocsys", repo: "madmcp", path: "gone.txt", message: "remove gone.txt", branch: "main",
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
        owner: "allocsys", repo: "madmcp", path: "missing.txt", message: "m", branch: "main",
      })).rejects.toThrow(/404/);

      expect(githubRequest).toHaveBeenCalledTimes(1);
    });
  });

  // NOTE: `branch` is now required (files.js) -- the handler no longer
  // falls back to a repo-info fetch + repoData.default_branch when it's
  // omitted, so every call below passes `branch` explicitly.
  //
  // rename_file resolves the file from the base commit's recursive tree and
  // reuses its existing blob sha + mode: no blob download/upload, so there
  // is NO /git/blobs request at all (binary-safe, exec-bit/symlink-safe).
  describe("rename_file", () => {
    it("moves a file by reusing its blob sha and mode, adding the new path and removing the old one", async () => {
      mockRenameRequests({
        tree: [
          { path: "other.txt", mode: "100644", type: "blob", sha: "other-sha" },
          { path: "old/name.txt", mode: "100644", type: "blob", sha: "orig-blob-sha" },
        ],
      });

      const result = await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "old/name.txt", new_path: "new/name.txt", branch: "main",
      });

      expect(result.content[0].text).toMatch(/^Renamed old\/name\.txt → new\/name\.txt/);

      const treeCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/trees") && c[1]?.method === "POST");
      expect(treeCall[1].body.base_tree).toBe("base-tree-sha");
      expect(treeCall[1].body.tree).toEqual([
        { path: "new/name.txt", mode: "100644", type: "blob", sha: "orig-blob-sha" },
        { path: "old/name.txt", mode: "100644", type: "blob", sha: null },
      ]);

      // No blob is downloaded or created -- the existing one is reused.
      expect(githubRequest.mock.calls.some((c) => c[0].includes("/git/blobs"))).toBe(false);

      const commitCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/commits") && c[1]?.method === "POST");
      expect(commitCall[1].body.message).toBe("rename old/name.txt to new/name.txt");
      expect(commitCall[1].body.parents).toEqual(["ref-sha"]);

      const refUpdateCall = githubRequest.mock.calls.find((c) => c[1]?.method === "PATCH");
      expect(refUpdateCall[1].body.sha).toBe("new-commit-sha1234");
    });

    it("preserves the file mode (e.g. executable bit) on both tree entries", async () => {
      mockRenameRequests({
        tree: [{ path: "bin/run.sh", mode: "100755", type: "blob", sha: "exec-blob-sha" }],
      });

      await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "bin/run.sh", new_path: "scripts/run.sh", branch: "main",
      });

      const treeCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/trees") && c[1]?.method === "POST");
      expect(treeCall[1].body.tree).toEqual([
        { path: "scripts/run.sh", mode: "100755", type: "blob", sha: "exec-blob-sha" },
        { path: "bin/run.sh", mode: "100755", type: "blob", sha: null },
      ]);
    });

    it("uses a custom commit message when provided", async () => {
      mockRenameRequests({ tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob-sha" }] });

      await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "a.txt", new_path: "b.txt", message: "tidy up naming", branch: "main",
      });

      const commitCall = githubRequest.mock.calls.find((c) => c[0].endsWith("/git/commits") && c[1]?.method === "POST");
      expect(commitCall[1].body.message).toBe("tidy up naming");
    });

    it("targets the given branch instead of the repo default", async () => {
      mockRenameRequests({ tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob-sha" }] });

      await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "a.txt", new_path: "b.txt", branch: "feature-y",
      });

      const refLookupCall = githubRequest.mock.calls.find((c) => c[0].includes("/git/ref/heads/"));
      expect(refLookupCall[0]).toContain("feature-y");
      const refUpdateCall = githubRequest.mock.calls.find((c) => c[1]?.method === "PATCH");
      expect(refUpdateCall[0]).toContain("feature-y");
    });

    it("throws when the file is not in the tree, without creating a tree or commit", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "ref-sha" } })
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })
        .mockResolvedValueOnce({ tree: [{ path: "other.txt", mode: "100644", type: "blob", sha: "x" }], truncated: false });

      await expect(server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "missing.txt", new_path: "b.txt", branch: "main",
      })).rejects.toThrow(/File not found in tree: missing\.txt/);

      // ref + base commit + base tree only.
      expect(githubRequest).toHaveBeenCalledTimes(3);
    });

    it("mentions tree truncation in the not-found error when GitHub truncated the tree", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "ref-sha" } })
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })
        .mockResolvedValueOnce({ tree: [], truncated: true });

      await expect(server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "deep/file.txt", new_path: "b.txt", branch: "main",
      })).rejects.toThrow(/truncated/i);
    });

    it("refuses to overwrite an existing destination, without creating a tree or commit", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "ref-sha" } })
        .mockResolvedValueOnce({ tree: { sha: "base-tree-sha" } })
        .mockResolvedValueOnce({
          tree: [
            { path: "a.txt", mode: "100644", type: "blob", sha: "a-sha" },
            { path: "b.txt", mode: "100644", type: "blob", sha: "b-sha" },
          ],
          truncated: false,
        });

      await expect(server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "a.txt", new_path: "b.txt", branch: "main",
      })).rejects.toThrow(/Destination already exists: b\.txt/);

      // ref + base commit + base tree only -- no tree POST, no commit, no ref PATCH.
      expect(githubRequest).toHaveBeenCalledTimes(3);
    });

    it("rejects old_path === new_path before making any request", async () => {
      await expect(server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "a.txt", new_path: "a.txt", branch: "main",
      })).rejects.toThrow(/identical/i);
      expect(githubRequest).not.toHaveBeenCalled();
    });

    it("defaults owner when omitted", async () => {
      mockRenameRequests({ tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob-sha" }] });

      await server.tools.rename_file({ repo: "madmcp", old_path: "a.txt", new_path: "b.txt", branch: "main" });

      expect(githubRequest.mock.calls[0][0]).toMatch(/^\/repos\/allocsys\/madmcp\/git\/ref\/heads\/main$/);
    });

    it("keeps '/' literal in branch names for the ref lookup and ref update", async () => {
      mockRenameRequests({ tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob-sha" }] });

      await server.tools.rename_file({
        owner: "allocsys", repo: "madmcp", old_path: "a.txt", new_path: "b.txt", branch: "feature/x y",
      });

      const refLookupCall = githubRequest.mock.calls.find((c) => c[0].includes("/git/ref/heads/"));
      expect(refLookupCall[0]).toMatch(/\/git\/ref\/heads\/feature\/x%20y$/);
      const refUpdateCall = githubRequest.mock.calls.find((c) => c[1]?.method === "PATCH");
      expect(refUpdateCall[0]).toMatch(/\/git\/refs\/heads\/feature\/x%20y$/);
    });
  });

  describe("overwrite_files — duplicate path guard", () => {
    it("rejects duplicate paths before making any request", async () => {
      await expect(server.tools.overwrite_files({
        owner: "allocsys", repo: "madmcp", branch: "main", message: "m",
        files: [
          { path: "a.txt", content: "one" },
          { path: "b.txt", content: "two" },
          { path: "a.txt", content: "three" },
        ],
      })).rejects.toThrow(/Duplicate path in files: a\.txt/);
      expect(githubRequest).not.toHaveBeenCalled();
    });
  });

  describe("read_file — paging argument validation", () => {
    beforeEach(() => {
      readFileViaBlob.mockResolvedValue("l1\nl2\nl3\nl4\n");
    });

    it.each([
      [{ char_offset: -5 }, /char_offset/],
      [{ char_offset: 1.5 }, /char_offset/],
      [{ char_offset: Number.NaN }, /char_offset/],
      [{ char_limit: 0 }, /char_limit/],
      [{ char_limit: -1 }, /char_limit/],
      [{ line_start: 0 }, /line_start/],
      [{ line_start: 2, line_end: 1 }, /line_end/],
      [{ line_start: 1, line_end: 0 }, /line_end/],
    ])("rejects %j without reading the file", async (args, pattern) => {
      const result = await server.tools.read_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", ref: "main", ...args,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(pattern);
      expect(readFileViaBlob).not.toHaveBeenCalled();
    });

    it("still serves valid char and line windows", async () => {
      const chars = await server.tools.read_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", ref: "main", char_offset: 3, char_limit: 2,
      });
      expect(chars.isError).toBeUndefined();
      expect(chars.content[0].text).toMatch(/Offset: 3 \| Returning: 2 chars/);

      const lines = await server.tools.read_file({
        owner: "allocsys", repo: "madmcp", path: "a.txt", ref: "main", line_start: 2, line_end: 3,
      });
      expect(lines.isError).toBeUndefined();
      expect(lines.content[0].text).toMatch(/Showing: L2-3/);
    });
  });
});
