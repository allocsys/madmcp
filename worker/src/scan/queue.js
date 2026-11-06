import { randomUUID } from 'node:crypto';
import { cloneRepo } from './clone.js';
import { walkRepo } from './walk.js';
import { diffFiles } from './hash.js';
import { parseFile } from './parse.js';
import { buildChunks } from './chunk.js';
import { buildEdges } from './graph.js';
import { resolveEdge, collectImportedFileIds, withEdgeNames } from './resolve.js';
import { reResolveRepoEdges } from './reresolve.js';
import { mapLimit } from './concurrency.js';
import { embedFileChunks } from './embed_batch.js';
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

// How many files pass 1 (parse + symbols) and pass 2 (edges, chunk inserts)
// work on at once. Kept small: each in-flight file holds a DB connection, and
// the db pool is shared with query traffic. Override with SCAN_CONCURRENCY.
const SCAN_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY) || 4);
// Pass 2 handles files in windows of this many: edges for the window are
// written concurrently, then the window's chunks are embedded together (full
// 100-text Gemini batches across files) and inserted. Bounds how many chunk
// texts + embeddings sit in memory at once.
const PASS2_WINDOW_FILES = 16;

// clone tokens are short-lived and per-request (minted by madmcp via
// gh_token) and are NOT persisted to scan_jobs. They're stashed
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
export async function runLoop() {
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
    // symbol/file to already have a real database id. Files are independent
    // of each other here, so a few run at once; results come back in input
    // order so pass 2 still sees files in a stable order.
    const pass1Results = await mapLimit(changed, SCAN_CONCURRENCY, async ({ path, content, contentHash }) => {
      const { language, tree, symbols, symbolLocalIdByNodeId } = await parseFile(path, content);
      const fileRow = await upsertFile({ repoId: job.repo_id, path, language, contentHash });
      await deleteFileArtifacts(fileRow.id);
      const symbolIdByLocal = await insertSymbols({ repoId: job.repo_id, fileId: fileRow.id, symbols });
      return [path, { fileId: fileRow.id, content, tree, symbols, symbolLocalIdByNodeId, symbolIdByLocal }];
    });
    const parsedByPath = new Map(pass1Results);

    // Pass 2: build a repo-wide name/path index (covers both the symbols
    // just inserted above and anything from unchanged files already in the
    // db), then resolve edges, embed chunks, and write both.
    const symbolIndex = await getSymbolIndex(job.repo_id); // name -> [{symbolId, fileId, qualifiedName}]
    const fileIndex = await getFileIndex(job.repo_id); // path -> fileId

    // Each file's pass-2 work (edges + chunks/embeddings) is isolated so one
    // file failing never aborts the job. Previously a single file's
    // embedTexts() call throwing (e.g. an oversized chunk hitting Gemini's
    // input-size limit -- see chunk.js) propagated straight out of the loop,
    // aborting the ENTIRE job. That was bad in two ways: (1) every OTHER
    // changed file in this scan -- including ones already successfully
    // processed earlier in the same loop -- got marked 'failed' along with
    // it, and (2) because pass 1 already committed this file's content_hash
    // unconditionally, the next scan's diff would see "unchanged" and skip it
    // forever, permanently stranding it half-indexed (symbols present,
    // edges/chunks never inserted). With isolation: other files still get
    // fully indexed this run, and a failed file's fully_indexed_at stays NULL
    // (upsertFile reset it in pass 1, and markFileIndexed below is only
    // reached on success) so getKnownFileHashes won't trust its hash next
    // time -- it keeps getting retried on every future scan instead of
    // silently vanishing from the index.
    let chunksEmbedded = 0;
    const failedFiles = [];
    const recordFailure = (path, err) => {
      console.error(`repo-map scan job ${job.id}: pass 2 failed for ${path} (will retry next scan):`, err);
      failedFiles.push(`${path}: ${err.message}`);
    };

    const entries = [...parsedByPath];
    for (let w = 0; w < entries.length; w += PASS2_WINDOW_FILES) {
      const windowEntries = entries.slice(w, w + PASS2_WINDOW_FILES);

      // 2a: edges + chunk building, a few files at a time. Edges don't depend
      // on embeddings, so they are written BEFORE any embedding call. If
      // embedding fails later (rate-limited/bad Gemini keys), the file is still
      // reported as failed and retried next scan (its fully_indexed_at stays
      // NULL), but its graph edges survive instead of being lost along with
      // the chunks.
      const prepared = await mapLimit(windowEntries, SCAN_CONCURRENCY, async ([path, parsed]) => {
        try {
          const rawEdges = buildEdges({
            filePath: path,
            content: parsed.content,
            tree: parsed.tree,
            symbolLocalIdByNodeId: parsed.symbolLocalIdByNodeId,
          });
          // Import context lets resolveEdge disambiguate calls to names that are
          // defined in several files (same-file, then imported-file candidates).
          const edgeCtx = {
            fileId: parsed.fileId,
            importedFileIds: collectImportedFileIds(rawEdges, path, fileIndex),
          };
          const resolvedEdges = rawEdges.map((e) =>
            withEdgeNames(e, resolveEdge(e, path, parsed.symbolIdByLocal, symbolIndex, fileIndex, edgeCtx))
          );
          await insertEdges({ repoId: job.repo_id, fileId: parsed.fileId, edges: resolvedEdges });

          const chunks = buildChunks({ filePath: path, content: parsed.content, symbols: parsed.symbols });
          return { path, parsed, chunks };
        } catch (err) {
          recordFailure(path, err);
          // Counts as "done" either way -- see incrementJobFilesDone's docstring.
          await incrementJobFilesDone(job.id);
          return null;
        }
      });
      const ready = prepared.filter(Boolean);

      // 2b: embed the window's chunks together (full batches across files),
      // then insert + mark indexed per file, a few files at a time.
      const embedded = await embedFileChunks(ready);
      await mapLimit(ready, SCAN_CONCURRENCY, async ({ path, parsed, chunks }) => {
        try {
          const result = embedded.get(path);
          if (result.error) throw result.error;
          const chunksWithEmbedding = chunks.map((c, i) => ({
            symbolId: c.localId != null ? parsed.symbolIdByLocal.get(c.localId) : null,
            content: c.content,
            embedding: result.embeddings[i],
            contentHash: c.contentHash,
          }));
          await insertChunks({ repoId: job.repo_id, fileId: parsed.fileId, chunks: chunksWithEmbedding });
          await markFileIndexed(parsed.fileId);
          chunksEmbedded += chunksWithEmbedding.length;
        } catch (err) {
          recordFailure(path, err);
        } finally {
          await incrementJobFilesDone(job.id);
        }
      });
    }

    // Heal edges that have no target yet (callee file changed, or the target
    // appeared in this scan) from DB state. Its own try/catch: a failure here
    // must not fail the job, but it is reported in scan_jobs.error.
    let reResolveError = null;
    if (changed.length || deleted.length) {
      try {
        const healed = await reResolveRepoEdges({ repoId: job.repo_id, symbolIndex, fileIndex });
        console.log(`repo-map scan job ${job.id}: re-resolved edges`, healed);
      } catch (err) {
        console.error(`repo-map scan job ${job.id}: edge re-resolve failed:`, err);
        reResolveError = `edge re-resolve failed: ${err.message}`;
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
      error:
        [
          failedFiles.length ? `${failedFiles.length} file(s) failed pass 2, will retry next scan:\n${failedFiles.join('\n')}` : null,
          reResolveError,
        ]
          .filter(Boolean)
          .join('\n') || null,
    });
  } catch (err) {
    console.error(`repo-map scan job ${job.id} failed:`, err);
    await finishScanJob(job.id, { status: 'failed', error: err.message });
  } finally {
    if (cloned) await cloned.cleanup();
  }
}

// Recover any jobs left `queued` across a restart, and keep polling so a job
// enqueued without a fresh runLoop() kick (shouldn't normally happen, but
// cheap insurance) doesn't sit stuck.
runLoop().catch((err) => console.error('repo-map worker loop error:', err));
setInterval(() => {
  runLoop().catch((err) => console.error('repo-map worker loop error:', err));
}, POLL_INTERVAL_MS);
