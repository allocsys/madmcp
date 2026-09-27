import 'dotenv/config';
import express from 'express';
import { requireSharedSecret } from './auth.js';
import { enqueueScan, getJobStatus, runLoop } from './scan/queue.js';
import { queryChunks, queryGraph } from './query/index.js';
import { embedNotionPage } from './notion/embed_notion.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(requireSharedSecret);

// Kick off (or enqueue) a scan for a repo. Returns immediately with a job id.
app.post('/scan', async (req, res) => {
  const { owner, repo, ref, cloneToken } = req.body || {};
  if (!owner || !repo) {
    return res.status(400).json({ error: 'owner and repo are required' });
  }
  try {
    const job = await enqueueScan({ owner, repo, ref, cloneToken });
    res.status(202).json({ jobId: job.id, status: job.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Poll job status
app.get('/status/:jobId', async (req, res) => {
  try {
    const job = await getJobStatus(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Semantic search: top-k similar chunks for a repo
app.post('/query/search', async (req, res) => {
  const { owner, repo, query, topK } = req.body || {};
  try {
    const results = await queryChunks({ owner, repo, query, topK: topK || 10 });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Graph traversal: callers/callees/importers of a symbol or file
app.post('/query/graph', async (req, res) => {
  const { owner, repo, symbol, file, direction, depth } = req.body || {};
  try {
    const results = await queryGraph({ owner, repo, symbol, file, direction, depth: depth || 1 });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drains the queue: claims and processes any queued jobs, then returns.
// Intended to be hit by an external cron (e.g. cron-job.org) every few
// minutes on hosts (like Render's free tier) that sleep the process after
// a period of no HTTP traffic -- this both counts as traffic that keeps
// the container awake, and takes over the stuck-job-recovery role the
// in-process setInterval poll (see queue.js) plays on hosts that stay warm.
app.get('/tick', async (_req, res) => {
  try {
    await runLoop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Embed-on-write for the Notion connector (Phase 2, plan-madmcp-notion-
// overhaul on Notion): madmcp (Vercel) only holds a read-only Neon role, so
// doCreatePage/doUpdatePage there call this route rather than writing to
// notion_page_embeddings directly -- same worker-does-the-writing split the
// /scan pipeline already uses for repos/files/chunks. Also used lazily by
// notion_find's rerank path to backfill a candidate page's embedding the
// first time it's touched, rather than a one-time batch backfill job (see
// the Notion plan page's 2026-09-27 Phase 2 decisions).
app.post('/notion/embed', async (req, res) => {
  const { page_id, content } = req.body || {};
  if (!page_id) {
    return res.status(400).json({ error: 'page_id is required' });
  }
  try {
    const result = await embedNotionPage({ pageId: page_id, content });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`repo-map-worker listening on :${port}`));
