// ---------------------------------------------------------------------------
// connectors/notion/embed_queries.js -- read-side of Phase 2's Notion
// semantic layer, run directly against Neon from madmcp (no worker hop),
// same split as connectors/repomap/queries.js: reads don't need the
// worker's write-capable Neon role, only embed-on-write does (see
// embed_client.js). Reuses connectors/repomap/db.js's query() -- the SAME
// read-only pool/connection string map.query already uses, since this is
// the same Neon database, just a different table.
// ---------------------------------------------------------------------------

import pgvector from "pgvector";
import { query } from "../repomap/db.js";
import { embedQuery } from "../repomap/embed.js";

// Looks up embeddings for a known set of page ids (e.g. a notion_find
// keyword-search candidate list), for reranking. Returns a Map of
// page_id -> embedding (number[]); ids with no row yet (never embedded) are
// simply absent from the map -- callers decide how to handle a page missing
// an embedding (fall back to keyword order, and/or lazily trigger an embed
// for next time via embed_client.js's triggerNotionEmbed).
export async function getEmbeddingsForPageIds(pageIds) {
  const ids = [...new Set((pageIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT page_id, embedding FROM notion_page_embeddings WHERE page_id = ANY($1::text[])`,
    [ids]
  );
  return new Map(rows.map((r) => [r.page_id, pgvector.fromSql(r.embedding)]));
}

// Embeds `text` (title + content of a NEW page about to be created) and
// returns any existing embedded pages within `maxDistance` cosine distance,
// most-similar first -- the fuzzy-dedup check doCreatePage runs before
// creating a page with a fresh entity_id, to catch near-duplicates that
// exact-match entity_id dedup can't see (see plan-madmcp-notion-overhaul on
// Notion for the confirmed real examples this is meant to catch).
// maxDistance default (0.15) is deliberately conservative (i.e. requires
// high similarity) -- a false positive here would incorrectly warn about
// two genuinely different pages, whereas a false negative just falls back
// to today's behavior (no fuzzy check at all). Tune based on real usage.
export async function findSimilarPages(text, { maxDistance = 0.15, limit = 3 } = {}) {
  if (!text) return [];
  const embedding = await embedQuery(text);
  const vec = pgvector.toSql(embedding);
  const { rows } = await query(
    `SELECT page_id, embedding <=> $1 AS distance
     FROM notion_page_embeddings
     WHERE embedding <=> $1 < $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [vec, maxDistance, limit]
  );
  return rows.map((r) => ({ pageId: r.page_id, distance: r.distance }));
}

// Cosine distance between two already-computed embedding vectors, computed
// in JS -- used by notion_find's rerank step, where the candidate set is
// small (a keyword-search page, typically <=100 results) and already
// resident in memory from getEmbeddingsForPageIds above, so a second round
// trip to Neon per candidate isn't worth it. Returns a value in [0, 2]
// (0 = identical direction), same scale as pgvector's <=> operator used
// server-side elsewhere in this module, so the two are directly comparable.
export function cosineDistance(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 2; // degenerate vector -- treat as maximally dissimilar rather than dividing by zero
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Convenience wrapper: embeds `text` once and reranks `candidates` (objects
// with a `pageId` field, e.g. notion_find's search results already mapped
// to {pageId, ...}) by ascending cosine distance to it. Candidates with no
// embedding on file sort AFTER every scored candidate, in their original
// relative order -- degrade to keyword rank rather than dropping them.
export async function rerankByQuery(text, candidates) {
  if (!candidates.length) return candidates;
  const queryEmbedding = await embedQuery(text);
  const embeddings = await getEmbeddingsForPageIds(candidates.map((c) => c.pageId));

  const scored = [];
  const unscored = [];
  for (const c of candidates) {
    const emb = embeddings.get(c.pageId);
    if (emb) scored.push({ ...c, distance: cosineDistance(queryEmbedding, emb) });
    else unscored.push(c);
  }
  scored.sort((a, b) => a.distance - b.distance);
  return [...scored, ...unscored];
}
