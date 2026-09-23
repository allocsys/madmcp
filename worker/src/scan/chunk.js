// Per-function/class chunking (precise granularity, per the locked decision).
// Each symbol from parse.js becomes one chunk of source text for embedding.

import { hashContent } from './hash.js';

export function buildChunks({ filePath, content, symbols }) {
  const lines = content.split('\n');

  return symbols.map((s) => {
    const body = lines.slice(s.startLine - 1, s.endLine).join('\n');
    // Prefix with file/qualified-name context so the embedding captures
    // more than just the raw function body (helps semantic search recall).
    const chunkText = `// ${filePath} :: ${s.qualifiedName || s.name}\n${body}`;
    return {
      localId: s.localId,
      content: chunkText,
      contentHash: hashContent(chunkText),
    };
  });
}
