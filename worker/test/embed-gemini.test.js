// ---------------------------------------------------------------------------
// worker/test/embed-gemini.test.js — unit tests for worker/src/embed/gemini.js
// Covers:
//   - empty text array short-circuit
//   - missing GEMINI_API_KEY validation guard
//   - successful batch embedding request shape, headers, and response parsing
//   - error handling on API failure response
// ---------------------------------------------------------------------------

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { embedTexts } from '../src/embed/gemini.js';

describe('embedTexts', () => {
  const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
    global.fetch = originalFetch;
  });

  test('returns empty array immediately for empty input without calling fetch', async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    };

    const result = await embedTexts([]);
    assert.deepEqual(result, []);
    assert.equal(fetchCalled, false);
  });

  test('throws an error when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(
      async () => await embedTexts(['hello']),
      /GEMINI_API_KEY is not set/
    );
  });

  test('successfully sends batch embedding request and parses returned values', async () => {
    const mockEmbeddingsResponse = {
      embeddings: [
        { values: [0.1, 0.2] },
        { values: [0.3, 0.4] },
      ],
    };

    let capturedUrl;
    let capturedOptions;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => mockEmbeddingsResponse,
      };
    };

    const results = await embedTexts(['text one', 'text two']);

    assert.deepEqual(results, [
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    assert.match(capturedUrl, /batchEmbedContents/);
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['x-goog-api-key'], 'test-gemini-key');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.requests.length, 2);
    assert.equal(body.requests[0].content.parts[0].text, 'text one');
    assert.equal(body.requests[0].outputDimensionality, 1536);
  });

  test('throws an error when fetch response is not ok', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Invalid argument',
    });

    await assert.rejects(
      async () => await embedTexts(['test']),
      /Gemini embeddings request failed \(400\): Invalid argument/
    );
  });
});
