// ---------------------------------------------------------------------------
// worker/src/notion/embed_notion.js -- embeds a Notion page's text and
// writes it to notion_page_embeddings (see worker/src/db/schema.sql for the
// table and the read/write split rationale). This module is the ONLY writer
// of that table -- madmcp's Vercel deployment only has a read-only Neon
// role, so doCreatePage/doUpdatePage (connectors/notion/tools.js) call this
// worker's /notion/embed route instead of writing directly, same pattern
// the scan pipeline already uses for repos/files/chunks.
//
// Reuses embedTexts() from ../embed/gemini.js as-is (same model, same
// outputDimensionality, same multi-key rotation + cooldown behavior) --
// deliberately not a separate embedding call path, so Notion embeddings and
// repo-map chunk embeddings share one quota/rotation story rather than two.
// ---------------------------------------------------------------------------

import { embedTexts } from '../embed/gemini.js';
import { hashContent } from '../scan/hash.js';
import { query } from '../db/client.js';
import pgvector from 'pgvector';

// Embeds `content` for a Notion page and upserts it into
// notion_page_embeddings, skipping the actual Gemini call if the content is
// unchanged since the last embed (content_hash match) -- same no-op-skip
// reasoning as files.content_hash in the repo-map scan pipeline. Returns
// { skipped: true } on a no-op, or { skipped: false, contentHash } once the
// row is written.
export async function embedNotionPage({ pageId, content }) {
  if (!pageId) throw new Error('pageId is required');
  const text = content || '';
  const contentHash = hashContent(text);

  const { rows } = await query(
    `SELECT content_hash FROM notion_page_embeddings WHERE page_id = $1`,
    [pageId]
  );
  if (rows[0]?.content_hash === contentHash) {
    return { skipped: true, contentHash };
  }

  // embedTexts always returns [] for an empty list and otherwise batches
  // internally -- a single page is always exactly one text, well under its
  // BATCH_SIZE, so no batching concern here.
  const [embedding] = await embedTexts([text]);
  const vec = pgvector.toSql(embedding);

  await query(
    `INSERT INTO notion_page_embeddings (page_id, content_hash, embedding, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (page_id) DO UPDATE
       SET content_hash = EXCLUDED.content_hash,
           embedding = EXCLUDED.embedding,
           updated_at = now()`,
    [pageId, contentHash, vec]
  );

  return { skipped: false, contentHash };
}
