// Per-function/class chunking (precise granularity, per the locked decision).
// Each symbol from parse.js becomes one chunk of source text for embedding.

import { hashContent } from './hash.js';

// gemini-embedding-001's batchEmbedContents rejects an individual request
// whose input exceeds its token limit with a plain 400 -- embedBatchWithRotation
// (worker/src/embed/gemini.js) only treats 401/403/429 as retryable/skippable,
// so a 400 throws and aborts the WHOLE scan job (see queue.js's per-file
// try/catch for how that blast radius is now contained). A single huge
// function (e.g. a ~150-line request handler) can easily produce a chunk
// this large. Truncating here is cheap insurance against ever sending an
// oversized request in the first place -- 6000 chars is a conservative
// estimate for staying under typical embedding-model input token limits for
// source code (denser in tokens than prose), leaving headroom below the
// model's actual cap rather than hugging it exactly.
const MAX_CHUNK_CHARS = 6000;

export function buildChunks({ filePath, content, symbols }) {
  const lines = content.split('\n');

  return symbols.map((s) => {
    const body = lines.slice(s.startLine - 1, s.endLine).join('\n');
    // Prefix with file/qualified-name context so the embedding captures
    // more than just the raw function body (helps semantic search recall).
    let chunkText = `// ${filePath} :: ${s.qualifiedName || s.name}\n${body}`;
    if (chunkText.length > MAX_CHUNK_CHARS) {
      chunkText = `${chunkText.slice(0, MAX_CHUNK_CHARS)}\n// ... [truncated ${chunkText.length - MAX_CHUNK_CHARS} chars for embedding]`;
    }
    return {
      localId: s.localId,
      content: chunkText,
      contentHash: hashContent(chunkText),
    };
  });
}
