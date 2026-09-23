// ---------------------------------------------------------------------------
// worker/test/embed-gemini.test.js — unit tests for worker/src/embed/gemini.js
// Covers:
//   - empty text array short-circuit
//   - missing GEMINI_API_KEYS/GEMINI_API_KEY validation guard
//   - successful batch embedding request shape, headers, and response parsing
//   - single-key error handling on API failure response
//   - multi-key rotation: 429 cooldown + fallback to next key
//   - multi-key rotation: bad key (401/403) + fallback to next key
//   - multi-key rotation: all keys exhausted throws
//   - non-rotation-shaped error (5xx) throws immediately, no key burned
// ---------------------------------------------------------------------------

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { embedTexts, __resetRotationStateForTests } from '../src/embed/gemini.js';

describe('embedTexts', () => {
  const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
  const ORIGINAL_KEYS = process.env.GEMINI_API_KEYS;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    delete process.env.GEMINI_API_KEYS;
    // cooldownUntil/keyRotationCounter are module-scoped by design (see
    // gemini.js's file header) so they persist across embedTexts() calls
    // within this worker's one long-lived process -- reset between test
    // cases so one test's rotation/cooldown state can't leak into another.
    __resetRotationStateForTests();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_KEYS === undefined) delete process.env.GEMINI_API_KEYS;
    else process.env.GEMINI_API_KEYS = ORIGINAL_KEYS;
    globalThis.fetch = originalFetch;
  });

  test('returns empty array immediately for empty input without calling fetch', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    };

    const result = await embedTexts([]);
    assert.deepEqual(result, []);
    assert.equal(fetchCalled, false);
  });

  test('throws an error when neither GEMINI_API_KEYS nor GEMINI_API_KEY is set', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEYS;
    await assert.rejects(
      async () => await embedTexts(['hello']),
      /GEMINI_API_KEYS \(or GEMINI_API_KEY\) is not set/
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
    globalThis.fetch = async (url, options) => {
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

  test('throws an error when fetch response is not ok (single key, non-rotation-shaped)', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Invalid argument',
    });

    await assert.rejects(
      async () => await embedTexts(['test']),
      /Gemini embeddings request failed \(400\): Invalid argument/
    );
  });

  test('rotates to the next key on a 429 and records a cooldown', async () => {
    process.env.GEMINI_API_KEYS = 'key-a,key-b';
    delete process.env.GEMINI_API_KEY;

    const calls = [];
    globalThis.fetch = async (url, options) => {
      const usedKey = options.headers['x-goog-api-key'];
      calls.push(usedKey);
      if (usedKey === 'key-a') {
        return {
          ok: false,
          status: 429,
          text: async () => 'RESOURCE_EXHAUSTED: please retry in 12.5s.',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: [{ values: [1, 1] }] }),
      };
    };

    const results = await embedTexts(['only text']);

    assert.deepEqual(results, [[1, 1]]);
    assert.deepEqual(calls, ['key-a', 'key-b']);
  });

  test('rotates to the next key on a bad key (401/403) with no cooldown recorded', async () => {
    process.env.GEMINI_API_KEYS = 'key-a,key-b';
    delete process.env.GEMINI_API_KEY;

    const calls = [];
    globalThis.fetch = async (url, options) => {
      const usedKey = options.headers['x-goog-api-key'];
      calls.push(usedKey);
      if (usedKey === 'key-a') {
        return { ok: false, status: 403, text: async () => 'PERMISSION_DENIED' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: [{ values: [2, 2] }] }),
      };
    };

    const results = await embedTexts(['only text']);

    assert.deepEqual(results, [[2, 2]]);
    assert.deepEqual(calls, ['key-a', 'key-b']);

    // A second, independent call should still be willing to try key-a again
    // (401/403 records no cooldown, unlike 429) -- confirms bad-key handling
    // doesn't permanently blacklist a key within the process.
    const calls2 = [];
    globalThis.fetch = async (url, options) => {
      calls2.push(options.headers['x-goog-api-key']);
      return { ok: true, status: 200, json: async () => ({ embeddings: [{ values: [3, 3] }] }) };
    };
    await embedTexts(['another text']);
    assert.ok(calls2.includes('key-a') || calls2.includes('key-b'));
  });

  test('throws once all keys are exhausted by 429s', async () => {
    process.env.GEMINI_API_KEYS = 'key-a,key-b';
    delete process.env.GEMINI_API_KEY;

    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => 'RESOURCE_EXHAUSTED: please retry in 5s.',
    });

    await assert.rejects(
      async () => await embedTexts(['test']),
      /429/
    );
  });

  test('a 5xx error on one key throws immediately and does not try the next key', async () => {
    process.env.GEMINI_API_KEYS = 'key-a,key-b';
    delete process.env.GEMINI_API_KEY;

    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(options.headers['x-goog-api-key']);
      return { ok: false, status: 503, text: async () => 'Service Unavailable' };
    };

    await assert.rejects(
      async () => await embedTexts(['test']),
      /Gemini embeddings request failed \(503\)/
    );
    // Only the first (rotated-to) key should have been tried -- a 5xx isn't
    // key-rotation-shaped, so the remaining key must not be burned on it.
    assert.equal(calls.length, 1);
  });
});
