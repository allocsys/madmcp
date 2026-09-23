import { randomUUID } from 'node:crypto';
import { cloneRepo } from './clone.js';
import { walkRepo } from './walk.js';
import { diffFiles } from './hash.js';
import { parseFile } from './parse.js';
import { buildChunks } from './chunk.js';
import { buildEdges } from './graph.js';
import { embedTexts } from '../embed/gemini.js';
import {
  upsertRepo,
  getRepoById,
  updateRepoCommit,
  createScanJob,
  getScanJob,
  claimNextQueuedJob,
  finishScanJob,
  getKnownFileHashes,
  upsertFile,
  deleteFile,
  deleteFileArtifacts,
  insertSymbols,
  insertEdges,
  insertChunks,
  getSymbolIndex,
  getFileIndex,
  markFileIndexed,
  setJobFilesTotal,
  incrementJobFilesDone,
} from '../db/queries.js';

// RAILWAY_REPLICA_ID identifies a specific running instance; falls back to
// RAILWAY_DEPLOYMENT_ID (shared across replicas of one deploy) then 'local'
// (e.g. running outside Railway). Only used as a human-readable label on
// scan_jobs.claimed_by -- claimNextQueuedJob's actual concurrency safety
// comes from SELECT ... FOR UPDATE SKIP LOCKED, not from this being unique.
const WORKER_ID = `${process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_DEPLOYMENT_ID || 'local'}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 5000;

// Extensions tried (in order, with no extension first) when resolving a
// relative import specifier that omits its extension, e.g. './foo' could be
// './foo.js' or './foo/index.ts'.
const RESOLVE_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rb'];

// clone tokens are short-lived and per-request (minted by madmcp via
// get_repo_clone_token) and are NOT persisted to scan_jobs. They're stashed
// here keyed by job id so the worker loop can pick them up when it processes
// the job it was just asked to run. If the process restarts before that
// happens, a recovered queued job falls back to a public (unauthenticated)
// clone — fine for public repos, will fail fast for private ones.
const pendingCloneTokens = new Map();

export async function enqueueScan({ owner, repo, ref, cloneToken }) {
  const repoRow = await upsertRepo({ owner, name: repo, defaultRef: ref });
  const job = await createScanJob({ repoId: repoRow.id, ref: ref || repoRow.default_ref });
  if (cloneToken) pendingCloneTokens.set(job.id, cloneToken);

  // Fire-and-forget: kick the loop so this job (and anything else queued)
  // gets picked up immediately rather than waiting for the next poll tick.
  runLoop().catch((err) => console.error('repo-map worker loop error:', err));

  return job;
}

export async function getJobStatus(jobId) {
  return getScanJob(jobId);
}

// Drains the queue: claims and processes queued jobs one at a time until
// none are left. Safe to call concurrently — claimNextQueuedJob uses
// SELECT ... FOR UPDATE SKIP LOCKED, so overlapping loop invocations (e.g.
// one kicked by enqueueScan, one from the poll timer) just race harmlessly
// for who gets the next job.
let looping = false;
async function runLoop() {
  if (looping) return;
  looping = true;
  try {
    let job = await claimNextQueuedJob(WORKER_ID);
    while (job) {
      await processJob(job);
      job = await claimNextQueuedJob(WORKER_ID);
    }
  } finally {
    looping = false;
  }
}

async function processJob(job) {
  const cloneToken = pendingCloneTokens.get(job.id);
  pendingCloneTokens.delete(job.id);

  let cloned;
  try {
    const repoRow = await getRepoById(job.repo_id);
    cloned = await cloneRepo({ owner: repoRow.owner, repo: repoRow.name, ref: job.ref, cloneToken });

    const freshFiles = await walkRepo(cloned.dir);
    const knownHashes = await getKnownFileHashes(job.repo_id);
    const { changed, unchanged, deleted } = diffFiles(knownHashes, freshFiles);

    // Set once diffing is done so getScanStatus can report X/Y progress
    // while this job is still 'running' -- see setJobFilesTotal's docstring.
    await setJobFilesTotal(job.id, changed.length);

    for (const path of deleted) {
      await deleteFile(job.repo_id, path);
    }

    // Pass 1: parse every changed file and insert its files+symbols rows.
    // This has to happen for ALL changed files before pass 2, because
    // resolving a cross-file `calls` or `imports` edge requires the target
    // symbol/file to already have a real database id.
    const parsedByPath = new Map();
    for (const { path, content, contentHash } of changed) {
      const { language, tree, symbols, symbolLocalIdByNodeId } = await parseFile(path, content);
      const fileRow = await upsertFile({ repoId: job.repo_id, path, language, contentHash });
      await deleteFileArtifacts(fileRow.id);
      const symbolIdByLocal = await insertSymbols({ repoId: job.repo_id, fileId: fileRow.id, symbols });
      parsedByPath.set(path, { fileId: fileRow.id, content, tree, symbols, symbolLocalIdByNodeId, symbolIdByLocal });
    }

    // Pass 2: build a repo-wide name/path index (covers both the symbols
    // just inserted above and anything from unchanged files already in the
    // db), then resolve edges, embed chunks, and write both.
    const symbolIndex = await getSymbolIndex(job.repo_id); // name -> [{symbolId, fileId, qualifiedName}]
    const fileIndex = await getFileIndex(job.repo_id); // path -> fileId

    // Each file's pass-2 work (edges + chunks/embeddings) is isolated in its
    // own try/catch. Previously a single file's embedTexts() call throwing
    // (e.g. an oversized chunk hitting Gemini's input-size limit -- see
    // chunk.js) propagated straight out of this loop, aborting the ENTIRE
    // job. That was bad in two ways: (1) every OTHER changed file in this
    // scan -- including ones already successfully processed earlier in this
    // same loop -- got marked 'failed' along with it, and (2) because pass 1
    // already committed this file's content_hash unconditionally, the next
    // scan's diff would see "unchanged" and skip it forever, permanently
    // stranding it half-indexed (symbols present, edges/chunks never
    // inserted). Isolating the failure here means: other files still get
    // fully indexed this run, and the failed file's fully_indexed_at stays
    // NULL (upsertFile reset it in pass 1, and markFileIndexed below is only
    // reached on success) so getKnownFileHashes won't trust its hash next
    // time -- it keeps getting retried on every future scan instead of
    // silently vanishing from the index.
    let chunksEmbedded = 0;
    const failedFiles = [];
    for (const [path, parsed] of parsedByPath) {
      try {
        const rawEdges = buildEdges({
          filePath: path,
          content: parsed.content,
          tree: parsed.tree,
          symbolLocalIdByNodeId: parsed.symbolLocalIdByNodeId,
        });
        const resolvedEdges = rawEdges.map((e) =>
          resolveEdge(e, path, parsed.symbolIdByLocal, symbolIndex, fileIndex)
        );

        const chunks = buildChunks({ filePath: path, content: parsed.content, symbols: parsed.symbols });
        const embeddings = await embedTexts(chunks.map((c) => c.content));
        const chunksWithEmbedding = chunks.map((c, i) => ({
          symbolId: c.localId != null ? parsed.symbolIdByLocal.get(c.localId) : null,
          content: c.content,
          embedding: embeddings[i],
          contentHash: c.contentHash,
        }));

        await insertEdges({ repoId: job.repo_id, fileId: parsed.fileId, edges: resolvedEdges });
        await insertChunks({ repoId: job.repo_id, fileId: parsed.fileId, chunks: chunksWithEmbedding });
        await markFileIndexed(parsed.fileId);
        chunksEmbedded += chunksWithEmbedding.length;
      } catch (err) {
        console.error(`repo-map scan job ${job.id}: pass 2 failed for ${path} (will retry next scan):`, err);
        failedFiles.push(`${path}: ${err.message}`);
      } finally {
        // Counts as "done" either way -- see incrementJobFilesDone's docstring.
        await incrementJobFilesDone(job.id);
      }
    }

    await updateRepoCommit(job.repo_id, cloned.commit);
    await finishScanJob(job.id, {
      // Still 'done' -- real forward progress was made on every file that
      // didn't fail, and failed files aren't lost, just deferred to the next
      // scan (see fully_indexed_at). A job-level 'failed' status here would
      // wrongly suggest nothing was accomplished and nothing recoverable.
      status: 'done',
      filesScanned: freshFiles.size,
      filesChanged: changed.length,
      chunksEmbedded,
      error: failedFiles.length ? `${failedFiles.length} file(s) failed pass 2, will retry next scan:\n${failedFiles.join('\n')}` : null,
    });
  } catch (err) {
    console.error(`repo-map scan job ${job.id} failed:`, err);
    await finishScanJob(job.id, { status: 'failed', error: err.message });
  } finally {
    if (cloned) await cloned.cleanup();
  }
}

// Fills in dstSymbolId (for `calls`) or dstFileId (for `imports`) where the
// target can be determined; leaves them null otherwise (e.g. calls into a
// third-party package, or an ambiguous name that matches multiple symbols).
function resolveEdge(edge, filePath, symbolIdByLocal, symbolIndex, fileIndex) {
  if (edge.edgeType === 'calls') {
    const srcSymbolId = edge.srcLocalId != null ? symbolIdByLocal.get(edge.srcLocalId) : null;
    const candidates = symbolIndex.get(edge.calleeName);
    // Multiple symbols share this name across the repo — resolving to one
    // of them would likely be wrong, so leave it unresolved rather than guess.
    const dstSymbolId = candidates && candidates.length === 1 ? candidates[0].symbolId : null;
    return { edgeType: 'calls', srcSymbolId, dstSymbolId: dstSymbolId || null };
  }

  // imports
  const dstFileId = resolveImportSpecifier(edge.importSpecifier, filePath, fileIndex);
  return { edgeType: 'imports', srcSymbolId: null, dstFileId };
}

function resolveImportSpecifier(specifier, fromPath, fileIndex) {
  if (!specifier || !specifier.startsWith('.')) return null; // bare/package specifier — not in-repo
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const base = normalizePath(dir ? `${dir}/${specifier}` : specifier);

  for (const ext of RESOLVE_EXTENSIONS) {
    if (fileIndex.has(base + ext)) return fileIndex.get(base + ext);
    if (fileIndex.has(`${base}/index${ext}`)) return fileIndex.get(`${base}/index${ext}`);
  }
  return null;
}

// Collapses '.' and '..' segments in a joined relative path, e.g.
// 'src/scan/../db/client' -> 'src/db/client'.
function normalizePath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// Recover any jobs left `queued` across a restart, and keep polling so a job
// enqueued without a fresh runLoop() kick (shouldn't normally happen, but
// cheap insurance) doesn't sit stuck.
runLoop().catch((err) => console.error('repo-map worker loop error:', err));
setInterval(() => {
  runLoop().catch((err) => console.error('repo-map worker loop error:', err));
}, POLL_INTERVAL_MS);
