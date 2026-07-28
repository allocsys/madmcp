// ---------------------------------------------------------------------------
// connectors/notion/linking.js
// ---------------------------------------------------------------------------
// Deterministic (no-LLM) related-page detection for notion_create_page.
//
// Decision context (2026-07-21): this was originally going to route through
// the mem0->Notion Memory Index (sync/mem0_notion.js output), but scope was
// corrected -- Notion tooling is meant to become independent of mem0. This
// module uses ONLY notion_search + page content already reachable via
// existing Notion API calls (notionRequest), plus the Entity Index database
// (NOTION_INDEX_DATABASE_ID, via queryAllIndexEntries) for Signal 3 -- see
// the structural-fix comment on findTagOverlapCandidates below. No mem0
// read, no LLM call, no external API key. See Notion plan page (entity_id: plan-notion-autolink-heuristic) for
// the full writeup and tradeoffs.
//
// KNOWN LIMITATION: purely syntactic, no semantic/conceptual matching. Will
// miss related pages that share no identifier, explicit cross-reference, or
// tags (e.g. two investigations into related bugs worded differently, in
// different repos). Accepted tradeoff for zero added latency/cost -- see
// plan page for the "workers-sdk RPC leak wouldn't have been caught" example.
// ---------------------------------------------------------------------------

import { notionRequest, notionPageTitle, notionBlocksToText, parseMarkers, queryAllIndexEntries } from "./client.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with",
  "is", "are", "pr", "status", "update", "fix", "issue", "bug",
]);

// repo#123 or repo-123 (dash form requires 3+ digits to avoid matching
// ordinary hyphenated words like "co-op" or version strings like "v2-1").
const ID_PATTERNS = [
  /([a-zA-Z0-9_.-]+)#(\d+)/g,
  /([a-zA-Z0-9_.-]+)-(\d{3,})/g,
];

export function extractIdentifiers(text = "") {
  const found = new Set();
  for (const pat of ID_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text))) {
      found.add(`${m[1].toLowerCase()}#${m[2]}`);
    }
  }
  return found;
}

export function titleTokens(title = "") {
  return new Set(
    (title.toLowerCase().match(/[a-z]+/g) || [])
      .filter((w) => !STOPWORDS.has(w) && w.length > 2)
  );
}

// Pages in this system carry tags as a visible "Tags: a, b, c" text line
// (see e.g. the contribution-candidates pages) rather than a real Notion
// property, so tag comparison has to be scraped from body text.
export function extractTags(content = "") {
  const tags = new Set();
  const re = /Tags:\s*(.+)/gi;
  let m;
  while ((m = re.exec(content))) {
    m[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).forEach((t) => tags.add(t));
  }
  return tags;
}

function idKey(idStr) {
  const [repo, num] = idStr.split("#");
  return { repo, num: Number(num) };
}

function bodyMentionsId(body, idStr) {
  const { repo, num } = idKey(idStr);
  const haystack = (body || "").toLowerCase();
  return haystack.includes(`${repo}#${num}`) || haystack.includes(`${repo}-${num}`);
}

// Scores one candidate page against the new page being created.
// Returns { tier, reason } where tier is "strong" | "medium" | "weak" | null.
// Only "strong" and "medium" are meant to be acted on by callers -- "weak"
// is returned for visibility/testing but should be treated as noise.
export function scoreCandidate({ title, content, tags, createdAt }, candidate) {
  const newIds  = new Set([...extractIdentifiers(title), ...extractIdentifiers(content || "")]);
  const candIds = new Set([...extractIdentifiers(candidate.title), ...extractIdentifiers(candidate.content || "")]);

  // Signal 1: identifier overlap -- same repo, same or adjacent number.
  for (const a of newIds) {
    const { repo: r1, num: n1 } = idKey(a);
    for (const b of candIds) {
      const { repo: r2, num: n2 } = idKey(b);
      if (r1 === r2 && Math.abs(n1 - n2) <= 1) {
        return { tier: "strong", reason: `identifier overlap: ${a} ~ ${b}` };
      }
    }
  }

  // Signal 2: cross-reference text scan -- either page's body literally
  // mentions the other's identifier (mirrors how GitHub auto-links "fixes #N").
  for (const b of candIds) {
    if (bodyMentionsId(content, b)) return { tier: "strong", reason: `new page body references ${b}` };
  }
  for (const a of newIds) {
    if (bodyMentionsId(candidate.content, a)) return { tier: "strong", reason: `candidate body references ${a}` };
  }

  // Signal 3: tag overlap within a 7-day window. Medium confidence only --
  // never auto-linked, just surfaced as a candidate. NOTE: this in-memory
  // path only ever fires when both pages happen to already be in hand (e.g.
  // a candidate surfaced via the Signal 1/2 notion_search pass also happens
  // to share tags). The primary, reliable path for Signal 3 is
  // findTagOverlapCandidates below, which reads the dedup index directly
  // instead of depending on notion_search turning the candidate up at all.
  const candTags = candidate.tags || extractTags(candidate.content || "");
  const shared = [...(tags || new Set())].filter((t) => candTags.has(t));
  if (shared.length >= 2 && createdAt && candidate.createdAt) {
    const days = Math.abs((new Date(createdAt) - new Date(candidate.createdAt)) / 86400000);
    if (days <= 7) return { tier: "medium", reason: `shared tags [${shared.join(", ")}], ${Math.round(days)}d apart` };
  }

  // Signal 4: title token Jaccard similarity. Weak by design -- crude and
  // prone to false positives (generic words like "PR"/"status" recur across
  // unrelated pages), so this is informational only and never actionable.
  const t1 = titleTokens(title), t2 = titleTokens(candidate.title);
  if (t1.size && t2.size) {
    const union = new Set([...t1, ...t2]).size;
    const inter = [...t1].filter((w) => t2.has(w)).length;
    const jaccard = inter / union;
    if (jaccard > 0.3) return { tier: "weak", reason: `title token overlap (jaccard=${jaccard.toFixed(2)})` };
  }

  return { tier: null, reason: null };
}

const MAX_CANDIDATES_TO_SCORE = 8;
const MAX_TAG_CANDIDATES_TO_RESOLVE = 8;
const TAG_OVERLAP_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// STRUCTURAL FIX FOR SIGNAL 3 (2026-07-21, see Notion plan page entity_id:
// plan-notion-autolink-heuristic).
//
// ROOT CAUSE (confirmed via live test): Notion's /search endpoint matches on
// page TITLE, not body full-text. Tags live only in body text ("Tags: a, b,
// c" lines), never in titles -- so a tag string can never be found by
// notion_search, no matter how the query is built. The earlier fix attempt
// (commit a558fff, querying notion_search per tag) is harmless but
// ineffective and is superseded by this function.
//
// FIX: reuse this codebase's existing precedent for the exact same class of
// problem -- findPageByEntityId (tools.js) already solved "notion_search has
// real lag / doesn't reliably find things" for entity_id dedup by
// maintaining a dedicated index, read directly rather than searched. Signal
// 3 gets the same fix: index entries carry each tracked page's tags, so
// tag-overlap discovery reads the index directly instead of calling
// notion_search at all.
//
// UPDATE (2026-07-24): the index itself moved from a page (read via
// /blocks/{id}/children, capped at ~100 blocks) to a real database (read via
// queryAllIndexEntries in client.js, not subject to that cap) -- see
// config.js's NOTION_INDEX_DATABASE_ID comment. This function was updated to
// match; the underlying fix rationale above (direct read, not search) is
// unchanged.
//
// SCOPE LIMIT (accepted tradeoff): this only makes tag overlap discoverable
// for entity_id-tracked pages, since only those get an index entry at all.
// A freeform/untracked (one_off) page can't participate in tag-based
// discovery -- same limitation relations/auto-linking already have.
// Consistent with the rest of this system's design (tracking is opt-in via
// entity_id).
export async function findTagOverlapCandidates({ tags, createdAt }) {
  if (!tags || !tags.size) return [];

  let indexEntries;
  try {
    indexEntries = await queryAllIndexEntries();
  } catch {
    // Best-effort, same as the rest of findLinkCandidates -- an unreachable
    // index shouldn't block page creation, it just means Signal 3 finds
    // nothing this time.
    return [];
  }

  const overlapping = [];
  for (const entry of indexEntries) {
    if (!entry.tags.length) continue;
    const shared = entry.tags.filter((t) => tags.has(t));
    if (shared.length >= 2) overlapping.push({ entry, shared });
  }
  if (!overlapping.length) return [];

  const candidates = [];
  for (const { entry, shared } of overlapping.slice(0, MAX_TAG_CANDIDATES_TO_RESOLVE)) {
    let page;
    try {
      page = await notionRequest(`/pages/${entry.page_id}`);
    } catch {
      continue; // stale index entry (target page deleted/archived) -- skip, same as findPageByEntityId
    }
    if (createdAt && page.created_time) {
      const days = Math.abs((new Date(createdAt) - new Date(page.created_time)) / 86400000);
      if (days > TAG_OVERLAP_WINDOW_DAYS) continue; // same 7-day window as the in-memory scoreCandidate path
    }
    candidates.push({
      pageId: entry.page_id,
      title: notionPageTitle(page),
      url: entry.url || page.url,
      entity_id: entry.entity_id,
      reason: `shared tags [${shared.join(", ")}] (via dedup index)`,
    });
  }
  return candidates;
}

// Searches Notion for plausible candidates and scores them against the new
// page. Signals 1/2 (identifier overlap, cross-reference) run via
// notion_search on the identifier's repo name -- unchanged, and confirmed
// working live for both title-adjacency and body-only cross-reference
// cases. Signal 3 (tag overlap) runs separately via findTagOverlapCandidates
// above, reading the dedup index directly instead of notion_search, since a
// tag-overlapping page may share no identifier at all with the new page.
//
// If the new page has neither an identifier nor any tags, there's nothing
// deterministic to search on -- notion_search would just return keyword
// noise -- so we skip straight to "no candidates" instead of guessing.
//
// Returns { strong: [...], medium: [...] } -- weak/null candidates are
// dropped entirely, not surfaced to callers.
export async function findLinkCandidates({ title, content }) {
  const idTokens = [...extractIdentifiers(title), ...extractIdentifiers(content || "")];
  const newTags  = extractTags(content || "");
  if (!idTokens.length && !newTags.size) return { strong: [], medium: [] };

  const strong = [];
  const medium = [];
  const seenPageIds = new Set();
  const nowIso = new Date().toISOString();

  if (idTokens.length) {
    // Repo name is the most specific short deterministic query we can build
    // from an identifier -- Notion's search is keyword-based and a full
    // sentence dilutes relevance.
    const [primaryRepo] = idTokens[0].split("#");
    let searchData = { results: [] };
    try {
      searchData = await notionRequest("/search", {
        method: "POST",
        body: { query: primaryRepo, page_size: MAX_CANDIDATES_TO_SCORE },
      });
    } catch {
      // Search unreachable -- fall through with no identifier-based
      // candidates rather than aborting the whole create.
    }
    for (const hit of searchData.results || []) {
      if (hit.object !== "page" || seenPageIds.has(hit.id)) continue;
      seenPageIds.add(hit.id);
      let candContent, candMarkers;
      try {
        const blocksData = await notionRequest(`/blocks/${hit.id}/children?page_size=100`);
        const blocks = blocksData.results || [];
        candContent = notionBlocksToText(blocks);
        candMarkers = parseMarkers(blocks);
      } catch {
        continue; // unreadable candidate (archived/permissions) -- skip, don't fail the create
      }
      const candTitle = notionPageTitle(hit);
      const { tier, reason } = scoreCandidate(
        { title, content, tags: newTags, createdAt: nowIso },
        { title: candTitle, content: candContent, createdAt: hit.created_time }
      );
      const entryObj = { pageId: hit.id, title: candTitle, url: hit.url, entity_id: candMarkers.entity_id || null, reason };
      if (tier === "strong") strong.push(entryObj);
      else if (tier === "medium") medium.push(entryObj);
    }
  }

  // Signal 3, structural fix -- see findTagOverlapCandidates above.
  try {
    const tagMatches = await findTagOverlapCandidates({ tags: newTags, createdAt: nowIso });
    for (const c of tagMatches) {
      if (seenPageIds.has(c.pageId)) continue;
      seenPageIds.add(c.pageId);
      medium.push(c);
    }
  } catch {
    // swallow -- best-effort, mirrors the rest of this function
  }

  return { strong, medium };
}
