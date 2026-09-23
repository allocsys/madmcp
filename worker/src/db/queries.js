import pgvector from 'pgvector';
import { query, withTransaction } from './client.js';

export async function upsertRepo({ owner, name, defaultRef }) {
  const { rows } = await query(
    `INSERT INTO repos (owner, name, default_ref)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner, name) DO UPDATE SET default_ref = EXCLUDED.default_ref
     RETURNING *`,
    [owner, name, defaultRef || 'main']
  );
  return rows[0];
}

export async function createScanJob({ repoId, ref }) {
  const { rows } = await query(
    `INSERT INTO scan_jobs (repo_id, ref, status) VALUES ($1, $2, 'queued') RETURNING *`,
    [repoId, ref]
  );
  return rows[0];
}

export async function getScanJob(jobId) {
  const { rows } = await query(`SELECT * FROM scan_jobs WHERE id = $1`, [jobId]);
  return rows[0] || null;
}

export async function claimNextQueuedJob(workerId) {
  const { rows } = await query(
    `UPDATE scan_jobs
     SET status = 'running', claimed_by = $1, started_at = now()
     WHERE id = (
       SELECT id FROM scan_jobs
       WHERE status = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId]
  );
  return rows[0] || null;
}

export async function finishScanJob(jobId, { status, error, filesScanned, filesChanged, chunksEmbedded }) {
  await query(
    `UPDATE scan_jobs
     SET status = $2, error = $3, files_scanned = $4, files_changed = $5,
         chunks_embedded = $6, finished_at = now()
     WHERE id = $1`,
    [jobId, status, error || null, filesScanned || 0, filesChanged || 0, chunksEmbedded || 0]
  );
}

// Returns existing content_hash per path, so the scan pipeline can diff and
// only re-parse/re-embed files that actually changed.
// Only returns files where fully_indexed_at IS SET -- a file whose pass 2
// (edges+chunks) never completed for its current hash must NOT be reported
// as "known", or diffFiles would classify it as unchanged and skip it
// forever even though it's only half-indexed. See schema.sql's comment on
// fully_indexed_at for the full failure mode this prevents.
export async function getKnownFileHashes(repoId) {
  const { rows } = await query(
    `SELECT path, content_hash FROM files WHERE repo_id = $1 AND fully_indexed_at IS NOT NULL`,
    [repoId]
  );
  return new Map(rows.map((r) => [r.path, r.content_hash]));
}

// fully_indexed_at is deliberately reset to NULL on every upsert (including
// when nothing else changed) -- it's only set back by markFileIndexed once
// pass 2 actually commits this file's edges+chunks for the hash being
// written here. This closes the window where content_hash reflects NEW
// content but the OLD fully_indexed_at timestamp (from a prior successful
// scan of different content) would otherwise still read as "trustworthy".
export async function upsertFile({ repoId, path, language, contentHash }) {
  const { rows } = await query(
    `INSERT INTO files (repo_id, path, language, content_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (repo_id, path) DO UPDATE
       SET language = EXCLUDED.language, content_hash = EXCLUDED.content_hash,
           fully_indexed_at = NULL, last_scanned_at = now()
     RETURNING *`,
    [repoId, path, language, contentHash]
  );
  return rows[0];
}

// Marks a file as fully indexed for its current content_hash -- called by
// queue.js's pass 2 ONLY after that file's edges+chunks have both been
// successfully inserted. Never called if that file's pass 2 work threw (see
// queue.js's per-file try/catch), so a failed file's hash stays untrusted
// and getKnownFileHashes will keep surfacing it as "changed" on every
// subsequent scan until it actually succeeds.
export async function markFileIndexed(fileId) {
  await query(`UPDATE files SET fully_indexed_at = now() WHERE id = $1`, [fileId]);
}

export async function getRepoById(repoId) {
  const { rows } = await query(`SELECT * FROM repos WHERE id = $1`, [repoId]);
  return rows[0] || null;
}

export async function updateRepoCommit(repoId, commit) {
  await query(`UPDATE repos SET last_scanned_commit = $1 WHERE id = $2`, [commit, repoId]);
}

// A file that no longer exists on disk (per diffFiles' `deleted` list).
// symbols/edges/chunks cascade-delete via FK ON DELETE CASCADE (schema.sql).
export async function deleteFile(repoId, path) {
  await query(`DELETE FROM files WHERE repo_id = $1 AND path = $2`, [repoId, path]);
}

// --- Granular per-file helpers, used instead of replaceFileArtifacts below.
// Cross-file call/import edges can only be resolved once every changed
// file's symbols already have real DB ids, so the scan pipeline needs to
// insert symbols for ALL changed files first, then resolve + insert edges
// and chunks in a second pass -- one combined per-file transaction can't do
// that on its own.

export async function deleteFileArtifacts(fileId) {
  await query(`DELETE FROM chunks WHERE file_id = $1`, [fileId]);
  await query(`DELETE FROM edges WHERE src_file_id = $1`, [fileId]);
  await query(`DELETE FROM symbols WHERE file_id = $1`, [fileId]);
}

export async function insertSymbols({ repoId, fileId, symbols }) {
  const symbolIdByLocal = new Map();
  for (const s of symbols) {
    const { rows } = await query(
      `INSERT INTO symbols (repo_id, file_id, kind, name, qualified_name, start_line, end_line, signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [repoId, fileId, s.kind, s.name, s.qualifiedName, s.startLine, s.endLine, s.signature]
    );
    symbolIdByLocal.set(s.localId, rows[0].id);
  }
  return symbolIdByLocal;
}

export async function insertEdges({ repoId, fileId, edges }) {
  for (const e of edges) {
    await query(
      `INSERT INTO edges (repo_id, src_symbol_id, dst_symbol_id, src_file_id, dst_file_id, edge_type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [repoId, e.srcSymbolId || null, e.dstSymbolId || null, fileId, e.dstFileId || null, e.edgeType]
    );
  }
}

export async function insertChunks({ repoId, fileId, chunks }) {
  for (const c of chunks) {
    await query(
      `INSERT INTO chunks (repo_id, symbol_id, file_id, content, embedding, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      // pgvector.toSql converts the plain JS number[] into the '[0.1,0.2,...]'
      // text format Postgres' vector type expects — a raw array would be sent
      // as a Postgres array literal ('{0.1,0.2}') and fail against vector(1536).
      [repoId, c.symbolId || null, fileId, c.content, pgvector.toSql(c.embedding), c.contentHash]
    );
  }
}

// name -> [{symbolId, fileId, qualifiedName}], across the WHOLE repo (both
// files touched by this scan and untouched ones already in the db). Used to
// resolve `calls` edges (graph.js only knows the raw callee name).
export async function getSymbolIndex(repoId) {
  const { rows } = await query(
    `SELECT id, file_id, name, qualified_name FROM symbols WHERE repo_id = $1`,
    [repoId]
  );
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push({ symbolId: r.id, fileId: r.file_id, qualifiedName: r.qualified_name });
  }
  return byName;
}

// path -> file id, across the whole repo. Used to resolve relative `imports`
// edges (graph.js only knows the raw specifier string, e.g. './foo').
export async function getFileIndex(repoId) {
  const { rows } = await query(`SELECT id, path FROM files WHERE repo_id = $1`, [repoId]);
  return new Map(rows.map((r) => [r.path, r.id]));
}

// Replace all symbols/edges/chunks for a changed file in one transaction.
// Superseded by the granular helpers above for the main scan pipeline
// (queue.js), which needs symbol-insertion and edge-insertion to happen in
// separate passes; kept here as a simpler all-in-one option for callers that
// don't need cross-file edge resolution (e.g. a single-file re-index).
export async function replaceFileArtifacts({ fileId, repoId, symbols, edges, chunks }) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM chunks WHERE file_id = $1`, [fileId]);
    await client.query(`DELETE FROM edges WHERE src_file_id = $1`, [fileId]);
    await client.query(`DELETE FROM symbols WHERE file_id = $1`, [fileId]);

    const symbolIdByLocal = new Map();
    for (const s of symbols) {
      const { rows } = await client.query(
        `INSERT INTO symbols (repo_id, file_id, kind, name, qualified_name, start_line, end_line, signature)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [repoId, fileId, s.kind, s.name, s.qualifiedName, s.startLine, s.endLine, s.signature]
      );
      symbolIdByLocal.set(s.localId, rows[0].id);
    }

    for (const e of edges) {
      await client.query(
        `INSERT INTO edges (repo_id, src_symbol_id, dst_symbol_id, src_file_id, dst_file_id, edge_type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          repoId,
          e.srcLocalId ? symbolIdByLocal.get(e.srcLocalId) : null,
          e.dstSymbolId || null, // resolved cross-file target, if known
          fileId,
          e.dstFileId || null,
          e.edgeType,
        ]
      );
    }

    for (const c of chunks) {
      await client.query(
        `INSERT INTO chunks (repo_id, symbol_id, file_id, content, embedding, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          repoId,
          c.localId ? symbolIdByLocal.get(c.localId) : null,
          fileId,
          c.content,
          pgvector.toSql(c.embedding),
          c.contentHash,
        ]
      );
    }

    return { symbolCount: symbols.length, edgeCount: edges.length, chunkCount: chunks.length };
  });
}
