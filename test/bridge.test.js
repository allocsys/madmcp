// ---------------------------------------------------------------------------
// test/bridge.test.js
// Unit tests for connectors/bridge/tools.js's bridge_post -- the one
// append-only write shared by Claude and Muse.
//
// Mocking note: bridge/tools.js imports notionRequest from
// connectors/notion/client.js (ANOTHER module), so vi.mock intercepts it
// -- same pattern as test/commit-log.test.js. But BRIDGE_PAGE_ID is read
// by config.js at import time, so the module under test is loaded via
// dynamic import in beforeAll, AFTER the env var is set (and after
// vi.resetModules, so each describe block gets a fresh config read) --
// same pattern as test/server-e2e.test.js / test/muse-server-e2e.test.js.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = "test";

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notionRequest: vi.fn(),
  };
});

const BRIDGE_PAGE_ID = "bridge-page-1";

function blockText(block) {
  return block.paragraph.rich_text.map((t) => t.text.content).join("");
}

describe("doBridgePost — append-only to the configured page", () => {
  let doBridgePost;
  let client;

  beforeAll(async () => {
    process.env.BRIDGE_PAGE_ID = BRIDGE_PAGE_ID;
    vi.resetModules();
    ({ doBridgePost } = await import("../connectors/bridge/tools.js"));
    client = await import("../connectors/notion/client.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    client.notionRequest.mockResolvedValue({});
  });

  it("appends a header line plus one paragraph per message line, to the bridge page only", async () => {
    const text = await doBridgePost({
      message: "hello\nworld",
      sender: "muse",
      at: new Date("2026-11-09T16:50:00.000Z"),
    });

    expect(client.notionRequest).toHaveBeenCalledTimes(1);
    const [path, opts] = client.notionRequest.mock.calls[0];
    expect(path).toBe(`/blocks/${BRIDGE_PAGE_ID}/children`);
    expect(opts.method).toBe("PATCH");
    expect(opts.body.children.map(blockText)).toEqual([
      "💬 muse · 2026-11-09T16:50:00.000Z · general",
      "hello",
      "world",
    ]);
    expect(text).toContain(`id: ${BRIDGE_PAGE_ID}`);
    expect(text).toContain("as muse at 2026-11-09T16:50:00.000Z");
  });

  it("labels the thread in the header when one is given", async () => {
    await doBridgePost({ message: "hi", thread: "floral-rings", sender: "claude", at: new Date("2026-11-09T16:50:00.000Z") });
    const [, opts] = client.notionRequest.mock.calls[0];
    expect(blockText(opts.body.children[0])).toBe("💬 claude · 2026-11-09T16:50:00.000Z · floral-rings");
  });

  it("never posts to any other page: there is no page_id input to redirect", async () => {
    await doBridgePost({ message: "hi", sender: "muse" });
    for (const [path] of client.notionRequest.mock.calls) {
      expect(path).toBe(`/blocks/${BRIDGE_PAGE_ID}/children`);
    }
  });

  it("rejects an empty message and never calls Notion", async () => {
    await expect(doBridgePost({ message: "   ", sender: "muse" })).rejects.toThrow(/non-empty/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("rejects an over-long message instead of truncating it", async () => {
    await expect(doBridgePost({ message: "x".repeat(4001), sender: "muse" })).rejects.toThrow(/over the 4000-char/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });

  it("rejects a bad thread label and an invalid sender", async () => {
    await expect(doBridgePost({ message: "hi", thread: "has spaces", sender: "muse" })).rejects.toThrow(/Invalid thread/);
    await expect(doBridgePost({ message: "hi", sender: "mallory" })).rejects.toThrow(/Invalid sender/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });
});

describe("bridge_post registration — sender is bound by the server, not the caller", () => {
  let register;
  let client;

  beforeAll(async () => {
    process.env.BRIDGE_PAGE_ID = BRIDGE_PAGE_ID;
    vi.resetModules();
    ({ register } = await import("../connectors/bridge/tools.js"));
    client = await import("../connectors/notion/client.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    client.notionRequest.mockResolvedValue({});
  });

  it("a tool registered with sender 'muse' posts as muse, with no sender in its schema", async () => {
    const tool = vi.fn();
    register({ tool }, "muse");
    expect(tool).toHaveBeenCalledTimes(1);
    const [name, , schema, handler] = tool.mock.calls[0];
    expect(name).toBe("bridge_post");
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(["message", "thread"]));
    expect(Object.keys(schema)).not.toContain("sender");
    expect(Object.keys(schema)).not.toContain("page_id");

    await handler({ message: "replying" });
    const [, opts] = client.notionRequest.mock.calls[0];
    expect(blockText(opts.body.children[0])).toMatch(/^💬 muse · /);
  });

  it("a tool registered with no sender defaults to claude", async () => {
    const tool = vi.fn();
    register({ tool });
    const handler = tool.mock.calls[0][3];
    await handler({ message: "hello from claude" });
    const [, opts] = client.notionRequest.mock.calls[0];
    expect(blockText(opts.body.children[0])).toMatch(/^💬 claude · /);
  });

  it("the handler turns a validation failure into an isError result, not a throw", async () => {
    const tool = vi.fn();
    register({ tool }, "muse");
    const handler = tool.mock.calls[0][3];
    const result = await handler({ message: "   " });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty/);
    expect(client.notionRequest).not.toHaveBeenCalled();
  });
});

describe("doBridgePost — fail-closed when BRIDGE_PAGE_ID is unset", () => {
  let doBridgePost;

  beforeAll(async () => {
    delete process.env.BRIDGE_PAGE_ID;
    vi.resetModules();
    ({ doBridgePost } = await import("../connectors/bridge/tools.js"));
  });

  afterAll(() => {
    process.env.BRIDGE_PAGE_ID = BRIDGE_PAGE_ID;
  });

  it("throws a 'not configured' error instead of posting anywhere", async () => {
    await expect(doBridgePost({ message: "hi", sender: "muse" })).rejects.toThrow(/not configured/);
  });
});
