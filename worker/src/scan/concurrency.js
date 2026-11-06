// Runs fn(item, index) over items with at most `limit` in flight at once and
// returns results in input order. On the first rejection no new items are
// started; in-flight ones are allowed to settle, then the first error is
// thrown. Callers that need per-item failure isolation should catch inside fn.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  if (!items.length) return results;

  let next = 0;
  let failed = false;

  async function worker() {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workerCount = Math.min(Math.max(1, limit), items.length);
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, worker));
  const rejected = settled.find((s) => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}
