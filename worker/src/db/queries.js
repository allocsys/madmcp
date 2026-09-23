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
export async function getKnownFileHashes(repoId) {
  const { rows } = await query(`SELECT path, content_hash FROM files WHERE repo_id = $1`, [repoId]);
  return new Map(rows.map((r) => [r.path, r.content_hash]));
}

export async function upsertFile({ repoId, path, language, contentHash }) {
  const { rows } = await query(
    `INSERT INTO files (repo_id, path, language, content_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (repo_id, path) DO UPDATE
       SET language = EXCLUDED.language, content_hash = EXCLUDED.content_hash, last_scanned_at = now()
     RETURNING *`,
    [repoId, path, language, contentHash]
  );
  return rows[0];
}

// Replace all symbols/edges/chunks for a changed file in one transaction.
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
          c.embedding, // pgvector accepts array directly via pgvector helper on the query layer
          c.contentHash,
        ]
      );
    }

    return { symbolCount: symbols.length, edgeCount: edges.length, chunkCount: chunks.length };
  });
}
