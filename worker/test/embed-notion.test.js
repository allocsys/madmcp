// worker/test/embed-notion.test.js -- unit coverage for
// worker/src/notion/embed_notion.js's embedNotionPage(), the only writer of
// notion_page_embeddings (see that module's file header for the read/write
// split rationale between this worker and madmcp's Vercel deployment).
//
// Uses node:test's built-in module mocking (--experimental-test-module-mocks,
// enabled in package.json's test script) to stub db/client.js's `query` and
// embed/gemini.js's `embedTexts`, same pattern as worker/test/query.test.js,
// so this runs without a real Postgres connection or a real Gemini call.

import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('embedNotionPage', () => {
  beforeEach(() => {
    mock.reset();
  });

  test('throws if pageId is missing', async () => {
    mock.module('../src/db/client.js', { namedExports: { query: mock.fn() } });
    mock.module('../src/embed/gemini.js', { namedExports: { embedTexts: mock.fn() } });
    const { embedNotionPage } = await import('../src/notion/embed_notion.js');

    await assert.rejects(
      async () => await embedNotionPage({ pageId: undefined, content: 'hello' }),
      /pageId is required/
    );
  });

  test('skips the Gemini call and the write when content_hash is unchanged', async () => {
    const { hashContent } = await import('../src/scan/hash.js');
    const expectedHash = hashContent('same content');

    const queryMock = mock.fn(async (sql) => {
      if (sql.includes('SELECT content_hash FROM notion_page_embeddings')) {
        return { rows: [{ content_hash: expectedHash }] };
      }
      throw new Error('unexpected query: ' + sql);
    });
    const embedTextsMock = mock.fn(async () => {
      throw new Error('embedTexts should not be called on a no-op update');
    });

    mock.module('../src/db/client.js', { namedExports: { query: queryMock } });
    mock.module('../src/embed/gemini.js', { namedExports: { embedTexts: embedTextsMock } });
    const { embedNotionPage } = await import('../src/notion/embed_notion.js');

    const result = await embedNotionPage({ pageId: 'page-1', content: 'same content' });

    assert.deepEqual(result, { skipped: true, contentHash: expectedHash });
    assert.equal(embedTextsMock.mock.calls.length, 0);
  });

  test('embeds and upserts when content_hash differs (or the page has never been embedded)', async () => {
    const { hashContent } = await import('../src/scan/hash.js');
    const calls = [];
    const queryMock = mock.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT content_hash FROM notion_page_embeddings')) {
        return { rows: [] }; // never embedded before
      }
      if (sql.includes('INSERT INTO notion_page_embeddings')) {
        return { rows: [] };
      }
      throw new Error('unexpected query: ' + sql);
    });
    const embedTextsMock = mock.fn(async (texts) => {
      assert.deepEqual(texts, ['new content']);
      return [[0.1, 0.2, 0.3]];
    });

    mock.module('../src/db/client.js', { namedExports: { query: queryMock } });
    mock.module('../src/embed/gemini.js', { namedExports: { embedTexts: embedTextsMock } });
    const { embedNotionPage } = await import('../src/notion/embed_notion.js');

    const result = await embedNotionPage({ pageId: 'page-2', content: 'new content' });

    assert.equal(result.skipped, false);
    assert.equal(result.contentHash, hashContent('new content'));
    assert.equal(embedTextsMock.mock.calls.length, 1);

    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO notion_page_embeddings'));
    assert.ok(insertCall, 'expected an INSERT INTO notion_page_embeddings call');
    assert.equal(insertCall.params[0], 'page-2');
    assert.equal(insertCall.params[1], hashContent('new content'));
    // pgvector.toSql format: '[0.1,0.2,0.3]'
    assert.equal(insertCall.params[2], '[0.1,0.2,0.3]');
    assert.match(insertCall.sql, /ON CONFLICT \(page_id\) DO UPDATE/);
  });

  test('treats missing content as an empty string rather than throwing', async () => {
    const queryMock = mock.fn(async (sql) => {
      if (sql.includes('SELECT content_hash')) return { rows: [] };
      if (sql.includes('INSERT INTO notion_page_embeddings')) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    });
    const embedTextsMock = mock.fn(async (texts) => {
      assert.deepEqual(texts, ['']);
      return [[0, 0]];
    });

    mock.module('../src/db/client.js', { namedExports: { query: queryMock } });
    mock.module('../src/embed/gemini.js', { namedExports: { embedTexts: embedTextsMock } });
    const { embedNotionPage } = await import('../src/notion/embed_notion.js');

    const result = await embedNotionPage({ pageId: 'page-3', content: undefined });
    assert.equal(result.skipped, false);
  });
});
