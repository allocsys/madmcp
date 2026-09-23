// ---------------------------------------------------------------------------
// worker/src/query/index.js — read-side of repo_map: semantic search over
// embedded chunks, and graph traversal (callers/callees/importers) over the
// symbols/edges tables. Both are scoped to a single repo (owner/name).
// ---------------------------------------------------------------------------

import pgvector from 'pgvector';
import { query } from '../db/client.js';
import { embedTexts } from '../embed/gemini.js';

async function getRepoRow(owner, repo) {
  const { rows } = await query(`SELECT id FROM repos WHERE owner = $1 AND name = $2`, [owner, repo]);
  return rows[0] || null;
}

// Semantic search: embeds `query` text, returns the top-K most similar
// chunks in the repo ordered by cosine distance (pgvector's <=> operator).
export async function queryChunks({ owner, repo, query: text, topK = 10 }) {
  if (!owner || !repo) throw new Error('owner and repo are required');
  if (!text) throw new Error('query text is required');

  const repoRow = await getRepoRow(owner, repo);
  if (!repoRow) return [];

  const [embedding] = await embedTexts([text]);
  const vec = pgvector.toSql(embedding);

  const { rows } = await query(
    `SELECT c.id, c.content, c.embedding <=> $2 AS distance,
            f.path AS file_path, s.name AS symbol_name, s.qualified_name,
            s.kind, s.start_line, s.end_line
     FROM chunks c
     JOIN files f ON f.id = c.file_id
     LEFT JOIN symbols s ON s.id = c.symbol_id
     WHERE c.repo_id = $1
     ORDER BY c.embedding <=> $2
     LIMIT $3`,
    [repoRow.id, vec, topK]
  );

  return rows.map((r) => ({
    filePath: r.file_path,
    symbolName: r.symbol_name,
    qualifiedName: r.qualified_name,
    kind: r.kind,
    startLine: r.start_line,
    endLine: r.end_line,
    content: r.content,
    distance: r.distance,
  }));
}

// Graph traversal: given a symbol name or a file path, walk `depth` hops of
// edges in `direction` ('callers' | 'callees' | 'importers' | 'imports') and
// return the reached symbols/files. Uses a recursive CTE over the edges
// table per the plan's "plain adjacency tables + recursive CTEs" decision.
export async function queryGraph({ owner, repo, symbol, file, direction = 'callees', depth = 1 }) {
  if (!owner || !repo) throw new Error('owner and repo are required');
  if (!symbol && !file) throw new Error('symbol or file is required');

  const repoRow = await getRepoRow(owner, repo);
  if (!repoRow) return [];

  const hops = Math.max(1, Math.min(Number(depth) || 1, 5));
  const fileMode = direction === 'importers' || direction === 'imports';

  // Resolve the starting node id(s).
  let startIds;
  if (fileMode) {
    const { rows } = await query(`SELECT id FROM files WHERE repo_id = $1 AND path = $2`, [repoRow.id, file]);
    startIds = rows.map((r) => r.id);
  } else if (symbol) {
    const { rows } = await query(
      `SELECT id FROM symbols WHERE repo_id = $1 AND (name = $2 OR qualified_name = $2)`,
      [repoRow.id, symbol]
    );
    startIds = rows.map((r) => r.id);
  } else {
    // file given but direction is calls/callers — resolve all symbols in that file
    const { rows } = await query(
      `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.repo_id = $1 AND f.path = $2`,
      [repoRow.id, file]
    );
    startIds = rows.map((r) => r.id);
  }
  if (!startIds.length) return [];

  // direction -> which edge_type(s) to follow and which end is "forward"
  const edgeTypes = fileMode ? ['imports'] : ['calls', 'inherits', 'references'];
  const forward = direction === 'callees' || direction === 'imports'; // src -> dst
  const srcCol = fileMode ? 'src_file_id' : 'src_symbol_id';
  const dstCol = fileMode ? 'dst_file_id' : 'dst_symbol_id';
  const fromCol = forward ? srcCol : dstCol;
  const toCol = forward ? dstCol : srcCol;

  const { rows } = await query(
    `WITH RECURSIVE walk(node_id, depth) AS (
       SELECT unnest($1::int[]), 0
       UNION
       SELECT e.${toCol}, w.depth + 1
       FROM edges e
       JOIN walk w ON e.${fromCol} = w.node_id
       WHERE e.repo_id = $2 AND e.edge_type = ANY($3::text[]) AND w.depth < $4
         AND e.${toCol} IS NOT NULL
     )
     SELECT DISTINCT node_id, MIN(depth) AS depth FROM walk WHERE depth > 0
     GROUP BY node_id`,
    [startIds, repoRow.id, edgeTypes, hops]
  );
  const nodeIds = rows.map((r) => r.node_id);
  if (!nodeIds.length) return [];
  const depthById = new Map(rows.map((r) => [r.node_id, r.depth]));

  if (fileMode) {
    const { rows: files } = await query(`SELECT id, path, language FROM files WHERE id = ANY($1::int[])`, [nodeIds]);
    return files.map((f) => ({ filePath: f.path, language: f.language, depth: depthById.get(f.id) }));
  }

  const { rows: symbols } = await query(
    `SELECT s.id, s.name, s.qualified_name, s.kind, s.start_line, s.end_line, f.path AS file_path
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.id = ANY($1::int[])`,
    [nodeIds]
  );
  return symbols.map((s) => ({
    name: s.name,
    qualifiedName: s.qualified_name,
    kind: s.kind,
    filePath: s.file_path,
    startLine: s.start_line,
    endLine: s.end_line,
    depth: depthById.get(s.id),
  }));
}
