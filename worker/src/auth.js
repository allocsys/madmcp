// Shared-secret auth between madmcp (Vercel) and this worker.
// madmcp must send: Authorization: Bearer <REPO_MAP_SHARED_SECRET>

export function requireSharedSecret(req, res, next) {
  if (req.path === '/health') return next();

  const expected = process.env.REPO_MAP_SHARED_SECRET;
  if (!expected) {
    console.error('REPO_MAP_SHARED_SECRET is not set on the worker');
    return res.status(500).json({ error: 'server misconfigured' });
  }

  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token || token !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
