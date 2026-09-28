// ---------------------------------------------------------------------------
// test/github-helpers.test.js
//
// Direct coverage for connectors/github/helpers.js (previously every test
// mocked this module away). Covers the audit fixes:
//   - no wasted GET /repos/{owner}/{repo} when a ref is supplied
//   - default branch is still resolved when no ref is supplied
//   - '/' in branch names stays literal in the ref lookup
//   - a not-found error mentions tree truncation when GitHub truncated the tree
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  fromBase64: (str) => Buffer.from(str, "base64").toString("utf-8"),
}));

import { githubRequest } from "../connectors/github/client.js";
import { getFileBlobSha, readFileWithSha } from "../connectors/github/helpers.js";

describe("connectors/github/helpers.js", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("getFileBlobSha", () => {
    it("skips the repo-info GET when a ref is given", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "commit-sha" } }) // ref lookup
        .mockResolvedValueOnce({ tree: [{ path: "a.txt", type: "blob", sha: "blob-1" }] }); // tree

      const result = await getFileBlobSha("o", "r", "a.txt", "main");

      expect(result).toEqual({ blobSha: "blob-1", treeSha: "commit-sha" });
      expect(githubRequest).toHaveBeenCalledTimes(2);
      expect(githubRequest.mock.calls[0][0]).toBe("/repos/o/r/git/ref/heads/main");
      expect(githubRequest.mock.calls.some((c) => c[0] === "/repos/o/r")).toBe(false);
    });

    it("looks up the default branch when no ref is given", async () => {
      githubRequest
        .mockResolvedValueOnce({ default_branch: "trunk" })        // repo info
        .mockResolvedValueOnce({ object: { sha: "commit-sha" } })  // ref lookup
        .mockResolvedValueOnce({ tree: [{ path: "a.txt", type: "blob", sha: "blob-1" }] });

      await getFileBlobSha("o", "r", "a.txt");

      expect(githubRequest.mock.calls[0][0]).toBe("/repos/o/r");
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/o/r/git/ref/heads/trunk");
    });

    it("keeps '/' literal in a branch name", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "commit-sha" } })
        .mockResolvedValueOnce({ tree: [{ path: "a.txt", type: "blob", sha: "blob-1" }] });

      await getFileBlobSha("o", "r", "a.txt", "feature/x");

      expect(githubRequest.mock.calls[0][0]).toBe("/repos/o/r/git/ref/heads/feature/x");
    });

    it("treats a ref that is not a branch (e.g. a commit sha) as the tree-ish itself", async () => {
      githubRequest
        .mockRejectedValueOnce(new Error("GitHub API error (404): Not Found")) // not a branch
        .mockResolvedValueOnce({ tree: [{ path: "a.txt", type: "blob", sha: "blob-1" }] });

      const result = await getFileBlobSha("o", "r", "a.txt", "abc123");

      expect(result.treeSha).toBe("abc123");
      expect(githubRequest.mock.calls[1][0]).toBe("/repos/o/r/git/trees/abc123?recursive=1");
    });

    it("throws a plain not-found error when the tree is complete", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "c" } })
        .mockResolvedValueOnce({ tree: [], truncated: false });

      const err = await getFileBlobSha("o", "r", "missing.txt", "main").catch((e) => e);
      expect(err.message).toBe("File not found in tree: missing.txt");
    });

    it("mentions truncation in the not-found error when GitHub truncated the tree", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "c" } })
        .mockResolvedValueOnce({ tree: [], truncated: true });

      await expect(getFileBlobSha("o", "r", "deep/file.txt", "main")).rejects.toThrow(/truncated/i);
    });
  });

  describe("readFileWithSha", () => {
    it("returns decoded content together with the blob sha it was read at", async () => {
      githubRequest
        .mockResolvedValueOnce({ object: { sha: "c" } })
        .mockResolvedValueOnce({ tree: [{ path: "a.txt", type: "blob", sha: "blob-1" }] })
        .mockResolvedValueOnce({ content: Buffer.from("hello\nworld").toString("base64") });

      const result = await readFileWithSha("o", "r", "a.txt", "main");

      expect(result).toEqual({ content: "hello\nworld", blobSha: "blob-1" });
      expect(githubRequest.mock.calls[2][0]).toBe("/repos/o/r/git/blobs/blob-1");
    });
  });
});
