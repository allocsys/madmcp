// ---------------------------------------------------------------------------
// connectors/shared/lock.js -- in-process mutual exclusion keyed by string.
//
// Serializes callers inside one server instance with a per-key promise chain.
// Deliberately NO external store (Redis etc.): cross-instance duplicates are
// instead caught after the fact by doCreatePage's index reconciliation
// (oldest Entity Index row wins, the loser archives its own page).
// ---------------------------------------------------------------------------

const chains = new Map();

export async function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  chains.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}
