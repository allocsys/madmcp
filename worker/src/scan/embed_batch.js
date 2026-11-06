import { embedTexts } from '../embed/gemini.js';

// Embeds the chunks of several files together so embedTexts can fill its
// batches (up to 100 texts each) across file boundaries, instead of making one
// small call per file.
//
// items: [{ path, chunks: [{ content, ... }] }]
// returns Map path -> { embeddings } on success, or { error } on failure.
//
// Failure isolation is preserved: if the combined call throws (e.g. one
// oversized chunk hitting Gemini's input limit, or rate-limited keys), each
// file is retried on its own so only the file(s) that actually fail are
// reported as failed and the rest still get indexed.
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
  } catch {
    // fall through to per-file retries
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
