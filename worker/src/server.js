import 'dotenv/config';
import express from 'express';
import { requireSharedSecret } from './auth.js';
import { enqueueScan, getJobStatus } from './scan/queue.js';
import { queryChunks, queryGraph } from './query/index.js';

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

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`repo-map-worker listening on :${port}`));
