// ---------------------------------------------------------------------------
// test/editor-tool-functions.test.js
//
// Unit coverage for connectors/github/editor_tool_functions.js (delegate_editor,
// plan.md step 3: "Build the tools layer"). Covers read_file, applyReplacements,
// buildUnifiedDiff, and write_file -- including guardrail #2 (default-branch
// refusal, looked up live) and guardrails #3/#4 (allow/deny via
// editor_policy.js) -- independently of any agent loop, per the plan's own
// step ordering ("Unit test each independently of the agent loop").
//
// githubRequest/toBase64/fromBase64 are mocked -- same style as
// test/frontend-agent-tools.test.js.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../connectors/github/client.js", () => ({
  githubRequest: vi.fn(),
  toBase64: (str) => Buffer.from(str, "utf-8").toString("base64"),
  fromBase64: (b64) => Buffer.from(b64, "base64").toString("utf-8"),
}));

import { githubRequest } from "../connectors/github/client.js";
import {
  readFile,
  writeFile,
  applyReplacements,
  buildUnifiedDiff,
  assertNotDefaultBranch,
} from "../connectors/github/editor_tool_functions.js";

const OWNER = "allocsys";
const REPO = "madmcp";
const DEFAULT_BRANCH_INFO = { default_branch: "main" };

function mockDefaultBranchLookup() {
  githubRequest.mockResolvedValueOnce(DEFAULT_BRANCH_INFO);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readFile", () => {
  it("returns content and sha together for an allowed path", async () => {
    githubRequest.mockResolvedValueOnce({
      content: Buffer.from("console.log('hi')").toString("base64"),
      sha: "blob-sha-123",
    });

    const result = await readFile(OWNER, REPO, "src/a.js", "feature-branch");

    expect(result).toEqual({ path: "src/a.js", content: "console.log('hi')", sha: "blob-sha-123" });
    expect(githubRequest).toHaveBeenCalledWith(
      `/repos/${OWNER}/${REPO}/contents/src%2Fa.js?ref=feature-branch`
    );
  });

  it("omits the ref query param when no ref is given", async () => {
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("# hi").toString("base64"), sha: "s1" });
    await readFile(OWNER, REPO, "README2.md");
    expect(githubRequest).toHaveBeenCalledWith(`/repos/${OWNER}/${REPO}/contents/README2.md`);
  });

  it("rejects a path outside the allowed extensions before calling GitHub", async () => {
    await expect(readFile(OWNER, REPO, "logo.png")).rejects.toThrow(/not in the allowed list/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("rejects a path that matches the deny list even if its extension is allowed", async () => {
    await expect(readFile(OWNER, REPO, ".github/workflows/ci.yml")).rejects.toThrow(/deny pattern/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("throws if the path resolves to a directory", async () => {
    githubRequest.mockResolvedValueOnce([{ name: "a.js" }, { name: "b.js" }]);
    await expect(readFile(OWNER, REPO, "src/dir.js")).rejects.toThrow(/directory, not a file/i);
  });

  it("throws if GitHub returns no inline content (e.g. file too large)", async () => {
    githubRequest.mockResolvedValueOnce({ sha: "s1", encoding: "none" });
    await expect(readFile(OWNER, REPO, "big.json")).rejects.toThrow(/no inline content/i);
  });
});

describe("applyReplacements", () => {
  it("applies a single find/replace", () => {
    expect(applyReplacements("alpha\nbeta\n", [{ find: "beta", replace: "BETA" }])).toBe("alpha\nBETA\n");
  });

  it("applies multiple find/replace operations sequentially", () => {
    const result = applyReplacements("one\ntwo\nthree\n", [
      { find: "one", replace: "ONE" },
      { find: "three", replace: "THREE" },
    ]);
    expect(result).toBe("ONE\ntwo\nTHREE\n");
  });

  it("throws (and applies nothing) if a find string is not present", () => {
    expect(() => applyReplacements("hello\n", [{ find: "missing", replace: "x" }])).toThrow(/not found/i);
  });

  it("throws (and applies nothing) if a find string is ambiguous", () => {
    expect(() => applyReplacements("dup\ndup\n", [{ find: "dup", replace: "x" }])).toThrow(/found 2 times/i);
  });
});

describe("buildUnifiedDiff", () => {
  it("produces a diff with additions and deletions marked", () => {
    const diff = buildUnifiedDiff("a.txt", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain("--- a.txt (before)");
    expect(diff).toContain("+++ a.txt (after)");
  });

  it("reports no differences when before and after are identical", () => {
    expect(buildUnifiedDiff("a.txt", "same\n", "same\n")).toContain("(no differences)");
  });
});

describe("assertNotDefaultBranch", () => {
  it("throws when the branch matches the repo's actual default branch", async () => {
    mockDefaultBranchLookup();
    await expect(assertNotDefaultBranch(OWNER, REPO, "main")).rejects.toThrow(/default branch/i);
  });

  it("does not throw for a non-default branch, and returns the repo info", async () => {
    mockDefaultBranchLookup();
    const info = await assertNotDefaultBranch(OWNER, REPO, "feature/x");
    expect(info).toEqual(DEFAULT_BRANCH_INFO);
  });
});

describe("writeFile", () => {
  it("rejects when neither content nor replacements is given", async () => {
    await expect(writeFile(OWNER, REPO, "a.js", { branch: "b" })).rejects.toThrow(/exactly one of/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("rejects when both content and replacements are given", async () => {
    await expect(writeFile(OWNER, REPO, "a.js", {
      content: "x", replacements: [{ find: "a", replace: "b" }], branch: "b",
    })).rejects.toThrow(/exactly one of/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("rejects a missing branch before touching the network", async () => {
    await expect(writeFile(OWNER, REPO, "a.js", { content: "x" })).rejects.toThrow(/branch is required/i);
    expect(githubRequest).not.toHaveBeenCalled();
  });

  it("refuses to write to the repo's default branch (guardrail #2), before any content is fetched", async () => {
    mockDefaultBranchLookup();
    await expect(writeFile(OWNER, REPO, "a.js", { content: "x", branch: "main" })).rejects.toThrow(/default branch/i);
    expect(githubRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a write path outside the allowed extensions (guardrail #3), before any PUT", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found")); // existing-file lookup, file doesn't exist
    await expect(writeFile(OWNER, REPO, "logo.png", { content: "x", branch: "feature" }))
      .rejects.toThrow(/not in the allowed list/i);
  });

  it("rejects a write path on the deny list (guardrail #4) even with an allowed extension", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));
    await expect(writeFile(OWNER, REPO, ".github/workflows/ci.yml", { content: "x", branch: "feature" }))
      .rejects.toThrow(/deny pattern/i);
  });

  it("content mode creates a new file when none exists (no sha sent on the PUT)", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found")); // existing-file lookup
    githubRequest.mockResolvedValueOnce({ content: { sha: "new-blob-sha" }, commit: { sha: "commit123" } }); // PUT

    const result = await writeFile(OWNER, REPO, "docs/new.md", { content: "# new", branch: "feature" });

    expect(result).toEqual({
      path: "docs/new.md", content: "# new", sha: "new-blob-sha", commitSha: "commit123",
      diff: null, created: true, noop: false,
    });
    const putCall = githubRequest.mock.calls[2];
    expect(putCall[0]).toBe(`/repos/${OWNER}/${REPO}/contents/docs%2Fnew.md`);
    expect(putCall[1].method).toBe("PUT");
    expect(putCall[1].body.sha).toBeUndefined();
    expect(putCall[1].body.branch).toBe("feature");
  });

  it("content mode overwrites an existing file, sending its current sha on the PUT", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("old").toString("base64"), sha: "existing-sha" });
    githubRequest.mockResolvedValueOnce({ content: { sha: "updated-sha" }, commit: { sha: "commit456" } });

    const result = await writeFile(OWNER, REPO, "a.js", { content: "new", branch: "feature" });

    const putCall = githubRequest.mock.calls[2];
    expect(putCall[1].body.sha).toBe("existing-sha");
    expect(result.created).toBe(false);
  });

  it("replacements mode applies the patch against the current branch content and returns a diff", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("const x = 1;").toString("base64"), sha: "sha-1" });
    githubRequest.mockResolvedValueOnce({ content: { sha: "sha-2" }, commit: { sha: "commit789" } });

    const result = await writeFile(OWNER, REPO, "a.js", {
      replacements: [{ find: "x = 1", replace: "x = 2" }],
      branch: "feature",
    });

    expect(result.content).toBe("const x = 2;");
    expect(result.diff).toContain("-const x = 1;");
    expect(result.diff).toContain("+const x = 2;");
  });

  it("replacements mode on a nonexistent file is rejected with a clear message", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found"));

    await expect(writeFile(OWNER, REPO, "missing.js", {
      replacements: [{ find: "a", replace: "b" }], branch: "feature",
    })).rejects.toThrow(/does not exist on branch/i);
  });

  it("replacements mode is a no-op (no PUT) when the replacement produces identical content", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("same").toString("base64"), sha: "sha-1" });

    const result = await writeFile(OWNER, REPO, "a.js", {
      replacements: [{ find: "same", replace: "same" }], branch: "feature",
    });

    expect(result.noop).toBe(true);
    expect(githubRequest).toHaveBeenCalledTimes(2); // default-branch lookup + existing-file read only, no PUT
  });

  it("rejects when base_sha does not match the file's current sha (stale read)", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("current").toString("base64"), sha: "current-sha" });

    const err = await writeFile(OWNER, REPO, "a.js", {
      content: "x", baseSha: "stale-sha", branch: "feature",
    }).catch((e) => e);

    expect(err.conflict).toBe(true);
    expect(err.message).toMatch(/write conflict/i);
  });

  it("surfaces a 409 sha mismatch from the PUT itself as a labeled conflict error", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("old").toString("base64"), sha: "existing-sha" });
    githubRequest.mockRejectedValueOnce(new Error('GitHub API error (409): {"message":"a.js does not match sha"}'));

    const err = await writeFile(OWNER, REPO, "a.js", { content: "x", branch: "feature" }).catch((e) => e);

    expect(err.conflict).toBe(true);
    expect(err.message).toMatch(/write conflict/i);
  });

  it("does not relabel a non-conflict PUT error", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockResolvedValueOnce({ content: Buffer.from("old").toString("base64"), sha: "existing-sha" });
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (500): Internal Server Error"));

    const err = await writeFile(OWNER, REPO, "a.js", { content: "x", branch: "feature" }).catch((e) => e);

    expect(err.conflict).toBeUndefined();
    expect(err.message).toMatch(/500/);
  });

  it("labels a missing-sha 409 on the PUT as a conflict when creating blind on a file that already exists", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockRejectedValueOnce(new Error("GitHub API error (404): Not Found")); // existing-file lookup says "not found"...
    githubRequest.mockRejectedValueOnce(new Error('GitHub API error (422): {"message":"a.js sha was not supplied"}')); // ...but the PUT disagrees (race)

    const err = await writeFile(OWNER, REPO, "a.js", { content: "x", branch: "feature" }).catch((e) => e);

    expect(err.conflict).toBe(true);
    expect(err.message).toMatch(/already exists/i);
    expect(err.message).toMatch(/read_file/);
  });

  it("blocks a package.json write that would change scripts/dependencies (guardrail #4 content check)", async () => {
    mockDefaultBranchLookup();
    githubRequest.mockResolvedValueOnce({
      content: Buffer.from(JSON.stringify({ name: "x", scripts: { test: "vitest" } })).toString("base64"),
      sha: "pkg-sha",
    });

    await expect(writeFile(OWNER, REPO, "package.json", {
      content: JSON.stringify({ name: "x", scripts: { test: "vitest", build: "webpack" } }),
      branch: "feature",
    })).rejects.toThrow(/scripts/i);
  });
});
