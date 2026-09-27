// worker/test/embed-notion.test.js -- unit coverage for
// worker/src/notion/embed_notion.js's embedNotionPage(), the only writer of
// notion_page_embeddings (see that module's file header for the read/write
// split rationale between this worker and madmcp's Vercel deployment).
//
// Uses node:test's built-in module mocking (--experimental-test-module-mocks,
// enabled in package.json's test script) to stub db/client.js's `query` and
// embed/gemini.js's `embedTexts`.
//
// IMPORTANT mocking note (learned the hard way -- see query.test.js for the
// single-test-per-file case that never hit this): mock.module() only
// affects a specifier's resolution the FIRST time it's imported -- once
// '../src/notion/embed_notion.js' has been dynamically imported once, its
// live bindings to '../src/db/client.js'/'../src/embed/gemini.js' are fixed
// for the rest of the process; calling mock.module() again in a later test
// does NOT rebind them. So mock.module() is called exactly ONCE here (in a
// top-level `before` hook, prior to embedNotionPage's first import), with
// mock.fn() instances captured once -- each individual test then
// reconfigures those SAME mock.fn instances via `.mock.mockImplementation`
// rather than replacing them, which is what actually varies behavior
// per-test under this constraint.

import { test, describe, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('embedNotionPage', () => {
  let embedNotionPage, hashContent;
  let queryMock, embedTextsMock;

  before(async () => {
    queryMock = mock.fn();
    embedTextsMock = mock.fn();
    mock.module('../src/db/client.js', { namedExports: { query: queryMock } });
    mock.module('../src/embed/gemini.js', { namedExports: { embedTexts: embedTextsMock } });
    ({ embedNotionPage } = await import('../src/notion/embed_notion.js'));
    ({ hashContent } = await import('../src/scan/hash.js'));
  });

  beforeEach(() => {
    queryMock.mock.resetCalls();
    embedTextsMock.mock.resetCalls();
    queryMock.mock.mockImplementation(async () => {
      throw new Error('queryMock has no implementation configured for this test');
    });
    embedTextsMock.mock.mockImplementation(async () => {
      throw new Error('embedTextsMock has no implementation configured for this test');
    });
  });

  test('throws if pageId is missing', async () => {
    await assert.rejects(
      async () => await embedNotionPage({ pageId: undefined, content: 'hello' }),
      /pageId is required/
    );
    // Should fail before ever touching the DB or Gemini.
    assert.equal(queryMock.mock.calls.length, 0);
  });

  test('skips the Gemini call and the write when content_hash is unchanged', async () => {
    const expectedHash = hashContent('same content');
    queryMock.mock.mockImplementation(async (sql) => {
      if (sql.includes('SELECT content_hash FROM notion_page_embeddings')) {
        return { rows: [{ content_hash: expectedHash }] };
      }
      throw new Error('unexpected query: ' + sql);
    });

    const result = await embedNotionPage({ pageId: 'page-1', content: 'same content' });

    assert.deepEqual(result, { skipped: true, contentHash: expectedHash });
    assert.equal(embedTextsMock.mock.calls.length, 0);
    assert.equal(queryMock.mock.calls.length, 1); // only the SELECT, no INSERT
  });

  test('embeds and upserts when content_hash differs (or the page has never been embedded)', async () => {
    const calls = [];
    queryMock.mock.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT content_hash FROM notion_page_embeddings')) {
        return { rows: [] }; // never embedded before
      }
      if (sql.includes('INSERT INTO notion_page_embeddings')) {
        return { rows: [] };
      }
      throw new Error('unexpected query: ' + sql);
    });
    embedTextsMock.mock.mockImplementation(async (texts) => {
      assert.deepEqual(texts, ['new content']);
      return [[0.1, 0.2, 0.3]];
    });

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
    queryMock.mock.mockImplementation(async (sql) => {
      if (sql.includes('SELECT content_hash')) return { rows: [] };
      if (sql.includes('INSERT INTO notion_page_embeddings')) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    });
    embedTextsMock.mock.mockImplementation(async (texts) => {
      assert.deepEqual(texts, ['']);
      return [[0, 0]];
    });

    const result = await embedNotionPage({ pageId: 'page-3', content: undefined });
    assert.equal(result.skipped, false);
  });
});
