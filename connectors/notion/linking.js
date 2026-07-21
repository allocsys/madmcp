// ---------------------------------------------------------------------------
// connectors/notion/linking.js
// ---------------------------------------------------------------------------
// Deterministic (no-LLM) related-page detection for notion_create_page.
//
// Decision context (2026-07-21): this was originally going to route through
// the mem0->Notion Memory Index (sync/mem0_notion.js output), but scope was
// corrected -- Notion tooling is meant to become independent of mem0. This
// module uses ONLY notion_search + page content already reachable via
// existing Notion API calls (notionRequest). No mem0 read, no LLM call, no
// external API key. See Notion plan page (entity_id:
// plan-notion-autolink-heuristic) for the full writeup and tradeoffs.
//
// KNOWN LIMITATION: purely syntactic, no semantic/conceptual matching. Will
// miss related pages that share no identifier, explicit cross-reference, or
// tags (e.g. two investigations into related bugs worded differently, in
// different repos). Accepted tradeoff for zero added latency/cost -- see
// plan page for the "workers-sdk RPC leak wouldn't have been caught" example.
// ---------------------------------------------------------------------------

import { notionRequest, notionPageTitle, notionBlocksToText, parseMarkers } from "./client.js";

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
  // never auto-linked, just surfaced as a candidate.
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
const MAX_TAG_QUERIES = 2;

// Searches Notion for plausible candidates and scores them against the new
// page. Runs one search per "anchor" -- the identifier's repo name (if any)
// plus up to MAX_TAG_QUERIES of the new page's own tags -- and merges the
// results, deduped by page ID, before scoring.
//
// FIX (2026-07-21, live-test bug): originally only searched on the
// identifier's repo name, which meant Signal 3 (tag overlap) could only
// ever fire as an accidental side effect of that search also surfacing a
// tag-sharing page for unrelated reasons -- a candidate under a different
// repo/identifier had no path into the pool at all, even with 2+ shared
// tags. The tag-anchored queries below give it one.
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

  const queries = [];
  if (idTokens.length) {
    // Repo name is the most specific short deterministic query we can build
    // from an identifier -- Notion's search is keyword-based and a full
    // sentence dilutes relevance.
    const [primaryRepo] = idTokens[0].split("#");
    queries.push(primaryRepo);
  }
  for (const tag of [...newTags].slice(0, MAX_TAG_QUERIES)) {
    queries.push(tag);
  }

  const seenPageIds = new Set();
  const hits = [];
  for (const q of queries) {
    let searchData;
    try {
      searchData = await notionRequest("/search", {
        method: "POST",
        body: { query: q, page_size: MAX_CANDIDATES_TO_SCORE },
      });
    } catch {
      // This query failed -- try the remaining anchors rather than aborting
      // the whole candidate search over one bad call.
      continue;
    }
    for (const hit of searchData.results || []) {
      if (hit.object !== "page" || seenPageIds.has(hit.id)) continue;
      seenPageIds.add(hit.id);
      hits.push(hit);
    }
  }
  if (!hits.length) return { strong: [], medium: [] };

  const strong = [];
  const medium = [];
  for (const hit of hits) {
    let candContent = "", candMarkers = {};
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
      { title, content, tags: newTags, createdAt: new Date().toISOString() },
      { title: candTitle, content: candContent, createdAt: hit.created_time }
    );
    const entry = { pageId: hit.id, title: candTitle, url: hit.url, entity_id: candMarkers.entity_id || null, reason };
    if (tier === "strong") strong.push(entry);
    else if (tier === "medium") medium.push(entry);
  }
  return { strong, medium };
}
