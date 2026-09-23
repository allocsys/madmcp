import { createHash } from 'node:crypto';

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Given known hashes (path -> hash) and freshly-walked files (path -> content),
// return which paths are new/changed and which are unchanged (skip re-embedding).
export function diffFiles(knownHashes, freshFiles) {
  const changed = [];
  const unchanged = [];

  for (const [path, content] of freshFiles) {
    const newHash = hashContent(content);
    const oldHash = knownHashes.get(path);
    if (oldHash === newHash) {
      unchanged.push(path);
    } else {
      changed.push({ path, content, contentHash: newHash });
    }
  }

  const freshPaths = new Set(freshFiles.keys());
  const deleted = [...knownHashes.keys()].filter((p) => !freshPaths.has(p));

  return { changed, unchanged, deleted };
}
