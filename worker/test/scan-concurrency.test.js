import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/scan/concurrency.js';
import { embedFileChunks } from '../src/scan/embed_batch.js';

test('mapLimit never exceeds the limit and keeps result order', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `peak ${peak} exceeded limit`);
  assert.ok(peak > 1, 'expected some concurrency');
});

test('mapLimit handles empty input', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('mapLimit rejects with the first error and stops starting new items', async () => {
  const started = [];
  await assert.rejects(
    mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error('boom');
    }),
    /boom/
  );
  assert.deepEqual(started, [1, 2]);
});

test('embedFileChunks embeds across files in one call and splits results per file', async () => {
  const calls = [];
  const embed = async (texts) => {
    calls.push(texts.length);
    return texts.map((t) => [t.length]);
  };
  const items = [
    { path: 'a', chunks: [{ content: 'x' }, { content: 'yy' }] },
    { path: 'b', chunks: [] },
    { path: 'c', chunks: [{ content: 'zzz' }] },
  ];
  const res = await embedFileChunks(items, embed);
  assert.deepEqual(calls, [3]);
  assert.deepEqual(res.get('a').embeddings, [[1], [2]]);
  assert.deepEqual(res.get('b').embeddings, []);
  assert.deepEqual(res.get('c').embeddings, [[3]]);
});

test('embedFileChunks falls back per file so one bad file does not fail the others', async () => {
  const embed = async (texts) => {
    if (texts.includes('bad')) throw new Error('too big');
    return texts.map(() => [0]);
  };
  const items = [
    { path: 'good', chunks: [{ content: 'ok' }] },
    { path: 'broken', chunks: [{ content: 'bad' }] },
  ];
  const res = await embedFileChunks(items, embed);
  assert.equal(res.get('good').embeddings.length, 1);
  assert.equal(res.get('broken').error.message, 'too big');
});
