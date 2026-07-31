// ---------------------------------------------------------------------------
// test/frontend-agent-tools.test.js
//
// Unit coverage for connectors/frontend/agent_tools.js (delegate_designer
// v2, issue #61, step 1: "Tools layer"). Covers read_file, applyPatch,
// write_file, and the re-exported validate -- independently of the step-2
// agent loop, per the implementation sequence in the Notion design doc.
//
// githubRequest/toBase64/fromBase64 are mocked -- same style as
// test/github-files.test.js (handler-level unit test, not a live-network
// test).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  toBase64: (str) => Buffer.from(str, "utf-8").toString("base64"),
  fromBase64: (b64) => Buffer.from(b64, "base64").toString("utf-8"),
}));

import { githubRequest } from "../connectors/github/client.js";
import { readFile, writeFile, applyPatch, validate } from "../connectors/frontend/agent_tools.js";
import { validateByExtension } from "../connectors/frontend/validate.js";

const OWNER = "allocsys";
const REPO = "madmcp";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readFile", () => {
  it("returns content and sha together for an allowed extension", async () => {
    githubRequest.mockResolvedValueOnce({
      content: Buffer.from("<div>hi</div>").toString("base64"),
      sha: "blob-sha-123",
    });

    const result = await readFile(OWNER, REPO, "index.html", "feature-branch");

    expect(result).toEqual({ path: "index.html", content: "<div>hi</div>", sha: "blob-sha-123" });
    expect(githubRequest).toHaveBeenCalledWith(
      `/repos/${OWNER}/${REPO}/contents/index.html?ref=feature-branch`
    );
  });

  it("omits the ref query param when no ref is given", async () => {
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("body{}").toString("base64"), sha: "s1" });
    await readFile(OWNER, REPO, "a.css");
    expect(githubRequest).toHaveBeenCalledWith(`/repos/${OWNER}/${REPO}/contents/a.css`);
  });

  it("rejects a path outside the allowed frontend extensions before calling GitHub", async () => {
    await expect(readFile(OWNER, REPO, "config.js")).rejects.toThrow(/not in the allowed frontend extensions/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("throws if the path resolves to a directory", async () => {
    githubRequest.mockResolvedValueOnce([{ name: "a.html" }, { name: "b.html" }]);
    await expect(readFile(OWNER, REPO, "some.html")).rejects.toThrow(/directory, not a file/i);
  });

  it("throws if GitHub returns no inline content (e.g. file too large)", async () => {
    githubRequest.mockResolvedValueOnce({ sha: "s1", encoding: "none" });
    await expect(readFile(OWNER, REPO, "big.html")).rejects.toThrow(/no inline content/i);
  });
});

describe("applyPatch", () => {
  it("applies a single find/replace", () => {
    expect(applyPatch("alpha\nbeta\n", [{ find: "beta", replace: "BETA" }])).toBe("alpha\nBETA\n");
  });

  it("applies multiple find/replace operations sequentially", () => {
    const result = applyPatch("one\ntwo\nthree\n", [
      { find: "one", replace: "ONE" },
      { find: "three", replace: "THREE" },
    ]);
    expect(result).toBe("ONE\ntwo\nTHREE\n");
  });

  it("throws (and applies nothing) if a find string is not present", () => {
    expect(() => applyPatch("hello\n", [{ find: "missing", replace: "x" }])).toThrow(/not found/i);
  });

  it("throws (and applies nothing) if a find string is ambiguous", () => {
    expect(() => applyPatch("dup\ndup\n", [{ find: "dup", replace: "x" }])).toThrow(/found 2 times/i);
  });
});

describe("writeFile", () => {
  it("rejects when neither content nor patch is given", async () => {
    await expect(writeFile(OWNER, REPO, "a.html", { branch: "b" })).rejects.toThrow(/exactly one of/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("rejects when both content and patch are given", async () => {
    await expect(writeFile(OWNER, REPO, "a.html", {
      content: "x", patch: [{ find: "a", replace: "b" }], branch: "b",
    })).rejects.toThrow(/exactly one of/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("rejects patch mode without base_sha", async () => {
    await expect(writeFile(OWNER, REPO, "a.html", {
      patch: [{ find: "a", replace: "b" }], branch: "b",
    })).rejects.toThrow(/base_sha is required/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("rejects a write_path outside the allowed frontend extensions", async () => {
    await expect(writeFile(OWNER, REPO, "config.js", { content: "x", branch: "b" }))
      .rejects.toThrow(/not in the allowed frontend extensions/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("content mode with no base_sha creates a new file (sha omitted from PUT)", async () => {
    githubRequest.mockResolvedValueOnce({ content: { sha: "new-blob-sha" }, commit: { sha: "commit123" } });

    const result = await writeFile(OWNER, REPO, "new.html", { content: "<p>new</p>", branch: "feature" });

    expect(result).toEqual({ path: "new.html", content: "<p>new</p>", sha: "new-blob-sha", commitSha: "commit123" });
    const putCall = githubRequest.mock.calls[0];
    expect(putCall[0]).toBe(`/repos/${OWNER}/${REPO}/contents/new.html`);
    expect(putCall[1].method).toBe("PUT");
    expect(putCall[1].body.sha).toBeUndefined();
    expect(putCall[1].body.branch).toBe("feature");
    expect(putCall[1].body.content).toBe(Buffer.from("<p>new</p>").toString("base64"));
  });

  it("content mode with base_sha sends that sha on the PUT (matching read_file's contract)", async () => {
    githubRequest.mockResolvedValueOnce({ content: { sha: "updated-sha" }, commit: { sha: "commit456" } });

    await writeFile(OWNER, REPO, "existing.html", {
      content: "<p>updated</p>", baseSha: "original-sha", branch: "feature",
    });

    const putCall = githubRequest.mock.calls[0];
    expect(putCall[1].body.sha).toBe("original-sha");
  });

  it("patch mode fetches the blob at base_sha, applies the patch, and PUTs the result with that sha", async () => {
    githubRequest
      .mockResolvedValueOnce({ content: Buffer.from("<div>old</div>").toString("base64") }) // blob fetch
      .mockResolvedValueOnce({ content: { sha: "new-sha" }, commit: { sha: "commit789" } }); // PUT

    const result = await writeFile(OWNER, REPO, "a.html", {
      patch: [{ find: "old", replace: "new" }],
      baseSha: "base-sha-1",
      branch: "feature",
    });

    expect(githubRequest.mock.calls[0][0]).toBe(`/repos/${OWNER}/${REPO}/git/blobs/base-sha-1`);
    const putCall = githubRequest.mock.calls[1];
    expect(putCall[1].body.sha).toBe("base-sha-1");
    expect(Buffer.from(putCall[1].body.content, "base64").toString("utf-8")).toBe("<div>new</div>");
    expect(result.content).toBe("<div>new</div>");
  });

  it("surfaces a 409 sha mismatch as a labeled conflict error instead of a generic failure", async () => {
    githubRequest.mockRejectedValueOnce(new Error('GitHub API error (409): {"message":"a.html does not match sha"}'));

    const err = await writeFile(OWNER, REPO, "a.html", {
      content: "x", baseSha: "stale-sha", branch: "feature",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.conflict).toBe(true);
    expect(err.message).toMatch(/write conflict/i);
    expect(err.message).toMatch(/stale-sha/);
  });

  it("does not relabel a non-conflict error", async () => {
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (500): Internal Server Error"));

    const err = await writeFile(OWNER, REPO, "a.html", {
      content: "x", baseSha: "sha-1", branch: "feature",
    }).catch((e) => e);

    expect(err.conflict).toBeUndefined();
    expect(err.message).toMatch(/500/);
  });

  it("does not relabel a plain GitHub error when there is no base_sha to be stale", async () => {
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (409): unrelated conflict"));

    const err = await writeFile(OWNER, REPO, "a.html", { content: "x", branch: "feature" }).catch((e) => e);

    expect(err.conflict).toBeUndefined();
  });

  it("labels a missing-sha error as a conflict when content mode is used with no base_sha on a file that already exists", async () => {
    githubRequest.mockRejectedValueOnce(new Error('GitHub API error (422): {"message":"a.html sha was not supplied"}'));

    const err = await writeFile(OWNER, REPO, "a.html", { content: "x", branch: "feature" }).catch((e) => e);

    expect(err.conflict).toBe(true);
    expect(err.message).toMatch(/already exists/i);
    expect(err.message).toMatch(/read_file/);
  });
});

describe("validate (re-export)", () => {
  it("is the same function as validateByExtension", () => {
    expect(validate).toBe(validateByExtension);
  });

  it("still works end-to-end through the re-export", async () => {
    const result = await validate("a.css", ".x { color: red; }");
    expect(result.valid).toBe(true);
  });
});
