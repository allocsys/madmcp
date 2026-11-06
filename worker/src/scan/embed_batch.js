import { embedTexts } from '../embed/gemini.js';

// Auth failures (401/403) and rate limits (429, including a recorded
// cooldown) are about the API keys, not about any one file's content, so
// retrying file by file can't help and would just burn calls.
function isKeyLevelError(err) {
  return err?.status === 401 || err?.status === 403 || err?.status === 429;
}

// Embeds the chunks of several files together so embedTexts can fill its
// batches (up to 100 texts each) across file boundaries, instead of making one
// small call per file.
//
// items: [{ path, chunks: [{ content, ... }] }]
// returns Map path -> { embeddings } on success, or { error } on failure.
//
// Failure isolation is preserved for content-related errors: if the combined
// call throws (e.g. one oversized chunk hitting Gemini's input limit), each
// file is retried on its own so only the file(s) that actually fail are
// reported as failed and the rest still get indexed. Key-level errors skip
// the retries (see isKeyLevelError).
export async function embedFileChunks(items, embed = embedTexts) {
  const results = new Map();
  const withChunks = [];
  for (const item of items) {
    if (item.chunks.length) withChunks.push(item);
    else results.set(item.path, { embeddings: [] });
  }
  if (!withChunks.length) return results;

  try {
    const all = await embed(withChunks.flatMap((it) => it.chunks.map((c) => c.content)));
    let offset = 0;
    for (const it of withChunks) {
      results.set(it.path, { embeddings: all.slice(offset, offset + it.chunks.length) });
      offset += it.chunks.length;
    }
    return results;
  } catch (batchErr) {
    if (isKeyLevelError(batchErr)) {
      // Fail the whole window fast; these files retry on the next scan.
      for (const it of withChunks) results.set(it.path, { error: batchErr });
      return results;
    }
    // Otherwise fall through to per-file retries.
  }

  for (const it of withChunks) {
    try {
      results.set(it.path, { embeddings: await embed(it.chunks.map((c) => c.content)) });
    } catch (error) {
      results.set(it.path, { error });
    }
  }
  return results;
}
