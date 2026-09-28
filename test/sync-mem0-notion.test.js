// ---------------------------------------------------------------------------
// test/sync-mem0-notion.test.js -- coverage for connectors/sync/mem0_notion.js,
// including the 2026-09-28 audit fixes (PR #245):
//   A1  listAllMemories reads until an empty page, de-dupes, and the
//       hard-deletion pass is skipped when the listing can't be trusted
//   A2  archived Notion pages: superseded -> already-archived, live memory ->
//       skip-page-archived
//   A8  no-op status is not reported as a change; dry run can say
//       would-skip-unchanged
//
// Mocking strategy: only the I/O boundaries are mocked (mem0Request, the
// Notion client lookups, and the tools.js write functions). The real sync
// logic in register()'s handler runs against them.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mem0Request } from "../connectors/mem/client.js";
import {
  notionRequest,
  queryAllIndexEntries,
  findPageByEntityId,
  buildSyncStartText,
  buildSyncEndText,
} from "../connectors/notion/client.js";
import { doCreatePage, doUpdatePage, replaceSyncedRange } from "../connectors/notion/tools.js";
import { register } from "../connectors/sync/mem0_notion.js";

vi.mock("../connectors/mem/client.js", () => ({ mem0Request: vi.fn() }));

vi.mock("../connectors/notion/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notionRequest: vi.fn(),
    queryAllIndexEntries: vi.fn(),
    findPageByEntityId: vi.fn(),
  };
});

vi.mock("../connectors/notion/tools.js", () => ({
  doCreatePage: vi.fn(),
  doUpdatePage: vi.fn(),
  replaceSyncedRange: vi.fn(),
}));

function makeFakeServer() {
  const tools = {};
  return { tool: (name, _d, _s, handler) => { tools[name] = handler; }, tools };
}

function getSync() {
  const server = makeFakeServer();
  register(server);
  return server.tools["sync_mem0_to_notion"];
}

const textOf = (result) => result.content[0].text;

const UPDATED_AT = "2026-09-01T00:00:00.000Z";

function mem(entityId, { status, relations, tags, updated_at = UPDATED_AT } = {}) {
  return {
    id: `id-${entityId}`,
    memory: `memory text for ${entityId}`,
    updated_at,
    metadata: { entity_id: entityId, ...(status ? { status } : {}), ...(relations ? { relations } : {}), ...(tags ? { tags } : {}) },
  };
}

// mem0Request impl that serves `pages[page-1]` and an empty page after that.
function mem0Pages(pages) {
  return async (_path, { body }) => ({ results: pages[body.page - 1] || [] });
}

function notionPage({ archived = false, status } = {}) {
  return {
    pageId: "page-1",
    title: "t",
    url: "https://notion.so/page-1",
    archived,
    markers: { entity_id: "mem0:e1", status: status ?? null },
  };
}

const paraBlock = (id, text) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });

beforeEach(() => {
  vi.resetAllMocks();
  queryAllIndexEntries.mockResolvedValue([]);
  findPageByEntityId.mockResolvedValue(null);
  doCreatePage.mockResolvedValue({ id: "new-page", url: "https://notion.so/new-page" });
  doUpdatePage.mockResolvedValue([]);
  replaceSyncedRange.mockResolvedValue({ action: "replaced" });
  notionRequest.mockResolvedValue({ results: [] });
});

// ---------------------------------------------------------------------------
describe("A1: listing memories from mem0", () => {
  it("reads until an empty page even when pages come back shorter than 100", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1"), mem("e2"), mem("e3")], [mem("e4"), mem("e5")]]));

    const result = await getSync()({ dry_run: true });

    expect(textOf(result)).toContain("Synced 5 memories.");
    expect(textOf(result)).toContain("would-create: 5");
    expect(mem0Request).toHaveBeenCalledTimes(3); // page 3 is the empty page that ends the loop
    expect(mem0Request.mock.calls.map(([, o]) => o.body.page)).toEqual([1, 2, 3]);
  });

  it("de-dupes by id and stops when a server ignores `page` and repeats itself", async () => {
    mem0Request.mockImplementation(async () => ({ results: [mem("e1"), mem("e2")] }));

    const result = await getSync()({ dry_run: true });

    expect(textOf(result)).toContain("Synced 2 memories.");
    expect(mem0Request).toHaveBeenCalledTimes(2); // page 2 added nothing new
  });

  it("accepts the alternative `memories` response shape", async () => {
    mem0Request.mockImplementation(async (_p, { body }) => ({ memories: body.page === 1 ? [mem("e1")] : [] }));

    const result = await getSync()({ dry_run: true });

    expect(textOf(result)).toContain("Synced 1 memory.");
  });

  it("filters to the requested entity_ids and skips the hard-deletion check", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1"), mem("e2"), mem("e3")]]));
    queryAllIndexEntries.mockResolvedValue([{ entity_id: "mem0:gone", page_id: "p-gone", url: "u", tags: [] }]);

    const result = await getSync()({ dry_run: false, entity_ids: ["e2"] });

    expect(textOf(result)).toContain("Synced 1 memory.");
    expect(textOf(result)).toContain("Hard-deletion check skipped — entity_ids filter was used.");
    expect(queryAllIndexEntries).not.toHaveBeenCalled();
    expect(doUpdatePage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("A1: hard-deletion pass safety", () => {
  const orphan = { entity_id: "mem0:removed", page_id: "p-removed", url: "https://notion.so/p-removed", tags: [] };

  it("archives index entries whose memory no longer exists (normal case)", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
    queryAllIndexEntries.mockResolvedValue([{ entity_id: "mem0:e1", page_id: "p1", url: "u1", tags: [] }, orphan]);

    const result = await getSync()({ dry_run: false });

    expect(doUpdatePage).toHaveBeenCalledWith({ page_id: "p-removed", archived: true });
    expect(doUpdatePage).not.toHaveBeenCalledWith({ page_id: "p1", archived: true });
    expect(textOf(result)).toContain("archived (source deleted from mem0): mem0:removed");
  });

  it("dry run reports would-archive for an orphan without writing", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
    queryAllIndexEntries.mockResolvedValue([orphan]);

    const result = await getSync()({ dry_run: true });

    expect(textOf(result)).toContain("would-archive (source deleted from mem0): mem0:removed");
    expect(doUpdatePage).not.toHaveBeenCalled();
  });

  it("only considers mem0:-prefixed index entries", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
    queryAllIndexEntries.mockResolvedValue([{ entity_id: "manual-page", page_id: "p-manual", url: "u", tags: [] }]);

    await getSync()({ dry_run: false });

    expect(doUpdatePage).not.toHaveBeenCalled();
  });

  it("SKIPS the pass with a warning when mem0 returns nothing but synced pages exist (bad user id / outage)", async () => {
    mem0Request.mockImplementation(mem0Pages([]));
    queryAllIndexEntries.mockResolvedValue([orphan, { entity_id: "mem0:other", page_id: "p-other", url: "u", tags: [] }]);

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("hard-deletion pass skipped");
    expect(textOf(result)).toContain("mem0 returned no memories");
    expect(textOf(result)).not.toContain("archived (source deleted from mem0)");
    expect(doUpdatePage).not.toHaveBeenCalled();
  });

  it("does not warn when mem0 is empty and there are no synced pages either", async () => {
    mem0Request.mockImplementation(mem0Pages([]));

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("Synced 0 memories.");
    expect(textOf(result)).not.toContain("hard-deletion pass skipped");
  });

  it("SKIPS the pass with a warning when the listing hit the 10-page cap (may be incomplete)", async () => {
    // every page returns 2 brand-new memories, so the loop only ends at the cap
    mem0Request.mockImplementation(async (_p, { body }) => ({ results: [mem(`m${body.page}a`), mem(`m${body.page}b`)] }));
    queryAllIndexEntries.mockResolvedValue([orphan]);

    const result = await getSync()({ dry_run: true });

    expect(mem0Request).toHaveBeenCalledTimes(10);
    expect(textOf(result)).toContain("Synced 20 memories.");
    expect(textOf(result)).toContain("hard-deletion pass skipped");
    expect(textOf(result)).toContain("page cap");
    expect(textOf(result)).not.toContain("would-archive (source deleted from mem0)");
  });

  it("with an entity_ids filter, a capped listing adds a 'some memories may not have been found' note", async () => {
    mem0Request.mockImplementation(async (_p, { body }) => ({ results: [mem(`m${body.page}a`), mem(`m${body.page}b`)] }));

    const result = await getSync()({ dry_run: true, entity_ids: ["m1a"] });

    expect(textOf(result)).toContain("some requested memories may not have been found");
  });

  it("a failing archive of an orphan is reported and does not stop the other orphans", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
    queryAllIndexEntries.mockResolvedValue([
      orphan,
      { entity_id: "mem0:removed2", page_id: "p-removed2", url: "u2", tags: [] },
    ]);
    doUpdatePage.mockImplementation(async ({ page_id }) => {
      if (page_id === "p-removed") throw new Error("Notion API error (500): boom");
      return [];
    });

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("✗ failed to archive mem0:removed");
    expect(textOf(result)).toContain("archived (source deleted from mem0): mem0:removed2");
  });

  it("an orphan that is already archived counts as done, not as a failure", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
    queryAllIndexEntries.mockResolvedValue([orphan]);
    doUpdatePage.mockRejectedValue(new Error("Notion API error (400): Can't edit block that is archived"));

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("already archived (no change needed): mem0:removed");
    expect(textOf(result)).not.toContain("✗ failed to archive");
  });
});

// ---------------------------------------------------------------------------
describe("A2: archived Notion pages", () => {
  beforeEach(() => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1", { status: "superseded" })]]));
  });

  it("superseded + no page -> skip-superseded-no-page", async () => {
    findPageByEntityId.mockResolvedValue(null);

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("skip-superseded-no-page");
    expect(doUpdatePage).not.toHaveBeenCalled();
  });

  it("superseded + live page -> archives it", async () => {
    findPageByEntityId.mockResolvedValue(notionPage());

    const result = await getSync()({ dry_run: false });

    expect(doUpdatePage).toHaveBeenCalledWith({ page_id: "page-1", archived: true });
    expect(textOf(result)).toContain("archived — mem0:e1");
  });

  it("superseded + live page in a dry run -> would-archive, no write", async () => {
    findPageByEntityId.mockResolvedValue(notionPage());

    const result = await getSync()({ dry_run: true });

    expect(textOf(result)).toContain("would-archive — mem0:e1");
    expect(doUpdatePage).not.toHaveBeenCalled();
  });

  it("superseded + already-archived page -> already-archived, and Notion is not called again", async () => {
    findPageByEntityId.mockResolvedValue(notionPage({ archived: true }));

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("already-archived — mem0:e1");
    expect(doUpdatePage).not.toHaveBeenCalled();
  });

  it("superseded: Notion's 'already archived' rejection (stale flag / race) is treated as done", async () => {
    findPageByEntityId.mockResolvedValue(notionPage());
    doUpdatePage.mockRejectedValue(new Error("Notion API error (400): Can't edit block that is archived"));

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("already-archived — mem0:e1");
    expect(textOf(result)).not.toContain("✗");
  });

  it("superseded: any other archive failure is reported as an error", async () => {
    findPageByEntityId.mockResolvedValue(notionPage());
    doUpdatePage.mockRejectedValue(new Error("Notion API error (500): boom"));

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("✗ mem0:e1 — Notion API error (500): boom");
  });

  it("live memory whose page is archived -> skip-page-archived, nothing is written", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
    findPageByEntityId.mockResolvedValue(notionPage({ archived: true }));

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("skip-page-archived — mem0:e1");
    expect(replaceSyncedRange).not.toHaveBeenCalled();
    expect(doUpdatePage).not.toHaveBeenCalled();
    expect(doCreatePage).not.toHaveBeenCalled();
  });

  it("a lookup error for one memory is reported for that memory and the rest still sync (A3 interplay)", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1"), mem("e2")]]));
    findPageByEntityId.mockImplementation(async (id) => {
      if (id === "mem0:e1") throw new Error("Could not read Notion page page-1 for entity_id \"mem0:e1\": Notion API error (429): rate limited");
      return null;
    });

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).toContain("✗ mem0:e1 — Could not read Notion page");
    expect(textOf(result)).toContain("created-and-replaced — mem0:e2");
    expect(doCreatePage).toHaveBeenCalledTimes(1); // no duplicate page created for e1
  });
});

// ---------------------------------------------------------------------------
describe("A8: status / unchanged reporting on existing pages", () => {
  it("live run: an unset mem0 status never reports [status changed] or touches the page", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1")]])); // no status in mem0
    findPageByEntityId.mockResolvedValue(notionPage({ status: "open" })); // page carries a marker

    const result = await getSync()({ dry_run: false });

    expect(textOf(result)).not.toContain("[status changed]");
    expect(doUpdatePage).not.toHaveBeenCalled();
    expect(replaceSyncedRange).toHaveBeenCalledTimes(1);
  });

  it("live run: a different explicit mem0 status is written and reported", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1", { status: "resolved" })]]));
    findPageByEntityId.mockResolvedValue(notionPage({ status: "open" }));

    const result = await getSync()({ dry_run: false });

    expect(doUpdatePage).toHaveBeenCalledWith({ page_id: "page-1", status: "resolved", relations: undefined });
    expect(textOf(result)).toContain("[status changed]");
  });

  it("live run: a matching explicit status is not rewritten", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1", { status: "open" })]]));
    findPageByEntityId.mockResolvedValue(notionPage({ status: "open" }));

    const result = await getSync()({ dry_run: false });

    expect(doUpdatePage).not.toHaveBeenCalled();
    expect(textOf(result)).not.toContain("[status changed]");
  });

  it("live run: changed relations are written and reported", async () => {
    mem0Request.mockImplementation(mem0Pages([[mem("e1", { relations: [{ to_entity_id: "e9", relation: "relates_to" }] })]]));
    findPageByEntityId.mockResolvedValue(notionPage());
    notionRequest.mockResolvedValue({ results: [] }); // page has no relation blocks yet

    const result = await getSync()({ dry_run: false });

    expect(doUpdatePage).toHaveBeenCalledWith({
      page_id: "page-1",
      status: undefined,
      relations: [{ to_entity_id: "mem0:e9", relation: "relates_to" }],
    });
    expect(textOf(result)).toContain("[relations changed]");
  });

  describe("dry run", () => {
    const syncedBlocks = (stamp) => [
      paraBlock("b-start", buildSyncStartText(stamp)),
      paraBlock("b-body", "memory text for e1"),
      paraBlock("b-end", buildSyncEndText()),
    ];

    it("would-skip-unchanged when the synced_at stamp matches and nothing else differs", async () => {
      mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
      findPageByEntityId.mockResolvedValue(notionPage());
      notionRequest.mockResolvedValue({ results: syncedBlocks(UPDATED_AT) });

      const result = await getSync()({ dry_run: true });

      expect(textOf(result)).toContain("would-skip-unchanged — mem0:e1");
      expect(replaceSyncedRange).not.toHaveBeenCalled();
      expect(doUpdatePage).not.toHaveBeenCalled();
    });

    it("would-update when the stored synced_at stamp differs", async () => {
      mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
      findPageByEntityId.mockResolvedValue(notionPage());
      notionRequest.mockResolvedValue({ results: syncedBlocks("2026-08-01T00:00:00.000Z") });

      const result = await getSync()({ dry_run: true });

      expect(textOf(result)).toContain("would-update — mem0:e1");
    });

    it("would-update when the page has no synced range yet", async () => {
      mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
      findPageByEntityId.mockResolvedValue(notionPage());
      notionRequest.mockResolvedValue({ results: [] });

      const result = await getSync()({ dry_run: true });

      expect(textOf(result)).toContain("would-update — mem0:e1");
    });

    it("would-update (with [status changed]) when content is unchanged but status differs", async () => {
      mem0Request.mockImplementation(mem0Pages([[mem("e1", { status: "resolved" })]]));
      findPageByEntityId.mockResolvedValue(notionPage({ status: "open" }));
      notionRequest.mockResolvedValue({ results: syncedBlocks(UPDATED_AT) });

      const result = await getSync()({ dry_run: true });

      expect(textOf(result)).toContain("would-update — mem0:e1");
      expect(textOf(result)).toContain("[status changed]");
    });

    it("unset mem0 status on a page with a marker stays would-skip-unchanged (no phantom status change)", async () => {
      mem0Request.mockImplementation(mem0Pages([[mem("e1")]]));
      findPageByEntityId.mockResolvedValue(notionPage({ status: "open" }));
      notionRequest.mockResolvedValue({ results: syncedBlocks(UPDATED_AT) });

      const result = await getSync()({ dry_run: true });

      expect(textOf(result)).toContain("would-skip-unchanged — mem0:e1");
      expect(textOf(result)).not.toContain("[status changed]");
    });

    it("would-update (with [relations changed]) when content is unchanged but relations differ", async () => {
      mem0Request.mockImplementation(mem0Pages([[mem("e1", { relations: [{ to_entity_id: "e9", relation: "relates_to" }] })]]));
      findPageByEntityId.mockResolvedValue(notionPage());
      notionRequest.mockResolvedValue({ results: syncedBlocks(UPDATED_AT) });

      const result = await getSync()({ dry_run: true });

      expect(textOf(result)).toContain("would-update — mem0:e1");
      expect(textOf(result)).toContain("[relations changed]");
    });

    it("dry run never writes", async () => {
      mem0Request.mockImplementation(mem0Pages([[mem("e1", { status: "resolved" }), mem("e2")]]));
      findPageByEntityId.mockImplementation(async (id) => (id === "mem0:e1" ? notionPage({ status: "open" }) : null));
      notionRequest.mockResolvedValue({ results: syncedBlocks("2026-08-01T00:00:00.000Z") });

      await getSync()({ dry_run: true });

      expect(doCreatePage).not.toHaveBeenCalled();
      expect(doUpdatePage).not.toHaveBeenCalled();
      expect(replaceSyncedRange).not.toHaveBeenCalled();
    });
  });
});
