// ---------------------------------------------------------------------------
// test/commit-log.test.js
// ---------------------------------------------------------------------------
// Unit tests for connectors/notion/commit_log.js's recordCommit. Only the two
// I/O helpers it imports from client.js (notionRequest, findPageByEntityId)
// are mocked -- commit_log.js imports them from ANOTHER module, so vi.mock
// intercepts them (unlike the same-file references described in
// test/notion-checkpoint.test.js's header).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordCommit } from "../connectors/notion/commit_log.js";
import * as client from "../connectors/notion/client.js";
import { COMMIT_LOG_MARKER_TEXT } from "../connectors/notion/client.js";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notionRequest: vi.fn(),
    findPageByEntityId: vi.fn(),
  };
});

const para = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });

function blockText(block) {
  return block.paragraph.rich_text.map((t) => t.text.content).join("");
}

function appendCalls() {
  return client.notionRequest.mock.calls.filter(
    ([path, opts]) => /^\/blocks\/[\w-]+\/children$/.test(path) && opts?.method === "PATCH"
  );
}

describe("recordCommit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.findPageByEntityId.mockResolvedValue({ pageId: "page-1", url: "https://notion.so/page-1" });
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      if (path.startsWith("/blocks/page-1/children") && (opts.method || "GET") === "GET") {
        return {
          results: [
            para("key-1", "🔑 entity_id: checkpoint-latest"),
            para("log-marker", COMMIT_LOG_MARKER_TEXT),
            para("start-1", "✅ Checkpoint saved with MCP tool call, don't edit manually (updated: 2026-09-30T00:00:00.000Z)"),
          ],
        };
      }
      if (path === "/blocks/page-1/children" && opts.method === "PATCH") return {};
      throw new Error(`Unexpected notionRequest call: ${opts.method || "GET"} ${path}`);
    });
  });

  it("appends one paragraph right after the log marker (newest first) in the documented format", async () => {
    await recordCommit({
      sha: "abcdef1234567890",
      message: "fix the thing\n\nlong body that must not be logged",
      files: ["a.js", "b.js"],
      branch: "feat/x",
      ts: "2026-09-30T12:00:00.000Z",
    });

    const calls = appendCalls();
    expect(calls).toHaveLength(1);
    const [path, opts] = calls[0];
    expect(path).toBe("/blocks/page-1/children");
    expect(opts.body.after).toBe("log-marker");
    expect(opts.body.children).toHaveLength(1);
    expect(blockText(opts.body.children[0])).toBe(
      "abcdef1 · fix the thing · feat/x · a.js, b.js · 2026-09-30T12:00:00.000Z"
    );
  });

  it("looks the page up under the default 'checkpoint-latest' key only", async () => {
    await recordCommit({ sha: "abcdef1234567890", message: "m", files: ["a.js"], branch: "b", ts: "t" });
    expect(client.findPageByEntityId).toHaveBeenCalledWith("checkpoint-latest");
  });

  it("truncates a long first line and summarizes more than three files", async () => {
    await recordCommit({
      sha: "1234567890abcdef",
      message: "x".repeat(300),
      files: ["1.js", "2.js", "3.js", "4.js", "5.js"],
      branch: "feat/x",
      ts: "2026-09-30T12:00:00.000Z",
    });

    const text = blockText(appendCalls()[0][1].body.children[0]);
    expect(text).toContain("1.js, 2.js, 3.js +2 more");
    const msgPart = text.split(" · ")[1];
    expect(msgPart.length).toBeLessThanOrEqual(100);
    expect(msgPart.endsWith("…")).toBe(true);
  });

  it("no-ops when no checkpoint page exists", async () => {
    client.findPageByEntityId.mockResolvedValue(null);
    await recordCommit({ sha: "abcdef1234567890", message: "m", files: ["a.js"], branch: "b", ts: "t" });
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("no-ops when the page has no log marker", async () => {
    client.notionRequest.mockImplementation(async (path, opts = {}) => {
      if (path.startsWith("/blocks/page-1/children") && (opts.method || "GET") === "GET") {
        return { results: [para("start-1", "✅ Checkpoint saved with MCP tool call, don't edit manually (updated: t)")] };
      }
      throw new Error(`Unexpected notionRequest call: ${opts.method || "GET"} ${path}`);
    });
    await recordCommit({ sha: "abcdef1234567890", message: "m", files: ["a.js"], branch: "b", ts: "t" });
    expect(appendCalls()).toHaveLength(0);
  });

  it("swallows Notion errors so a failed log write never surfaces to the caller", async () => {
    client.notionRequest.mockRejectedValue(new Error("Notion is down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recordCommit({ sha: "abcdef1234567890", message: "m", files: ["a.js"], branch: "b", ts: "t" })
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("recordCommit with COMMIT_LOG_ENABLED=false", () => {
  it("makes no Notion calls at all", async () => {
    vi.resetModules();
    const findPageByEntityId = vi.fn();
    const notionRequest = vi.fn();
    vi.doMock("../config.js", async (importOriginal) => ({ ...(await importOriginal()), COMMIT_LOG_ENABLED: false }));
    vi.doMock("../connectors/notion/client.js", async (importOriginal) => ({
      ...(await importOriginal()),
      notionRequest,
      findPageByEntityId,
    }));

    const { recordCommit: recordCommitOff } = await import("../connectors/notion/commit_log.js");
    await recordCommitOff({ sha: "abcdef1234567890", message: "m", files: ["a.js"], branch: "b", ts: "t" });

    expect(findPageByEntityId).not.toHaveBeenCalled();
    expect(notionRequest).not.toHaveBeenCalled();

    vi.doUnmock("../config.js");
    vi.doUnmock("../connectors/notion/client.js");
    vi.resetModules();
  });
});
