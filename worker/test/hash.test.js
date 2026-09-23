// test/hash.test.js -- unit coverage for src/scan/hash.js (content hashing
// + the changed/unchanged/deleted diff used for incremental re-scans).
// Pure functions, no DB/network -- uses node's built-in test runner.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashContent, diffFiles } from '../src/scan/hash.js';

describe('hashContent', () => {
  test('is deterministic for identical content', () => {
    assert.equal(hashContent('const x = 1;'), hashContent('const x = 1;'));
  });

  test('differs for different content', () => {
    assert.notEqual(hashContent('const x = 1;'), hashContent('const x = 2;'));
  });

  test('returns a 64-char lowercase hex sha256 digest', () => {
    const h = hashContent('anything');
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('diffFiles', () => {
  test('marks a file with no prior hash as changed', () => {
    const known = new Map();
    const fresh = new Map([['a.js', 'content-a']]);
    const { changed, unchanged, deleted } = diffFiles(known, fresh);

    assert.equal(changed.length, 1);
    assert.equal(changed[0].path, 'a.js');
    assert.equal(changed[0].content, 'content-a');
    assert.equal(changed[0].contentHash, hashContent('content-a'));
    assert.deepEqual(unchanged, []);
    assert.deepEqual(deleted, []);
  });

  test('marks a file with a matching hash as unchanged', () => {
    const known = new Map([['a.js', hashContent('content-a')]]);
    const fresh = new Map([['a.js', 'content-a']]);
    const { changed, unchanged, deleted } = diffFiles(known, fresh);

    assert.deepEqual(changed, []);
    assert.deepEqual(unchanged, ['a.js']);
    assert.deepEqual(deleted, []);
  });

  test('marks a file with a stale hash as changed, not unchanged', () => {
    const known = new Map([['a.js', hashContent('old-content')]]);
    const fresh = new Map([['a.js', 'new-content']]);
    const { changed, unchanged } = diffFiles(known, fresh);

    assert.equal(changed.length, 1);
    assert.equal(changed[0].path, 'a.js');
    assert.deepEqual(unchanged, []);
  });

  test('reports a known file missing from the fresh walk as deleted', () => {
    const known = new Map([['a.js', hashContent('content-a')], ['b.js', hashContent('content-b')]]);
    const fresh = new Map([['a.js', 'content-a']]);
    const { deleted } = diffFiles(known, fresh);

    assert.deepEqual(deleted, ['b.js']);
  });

  test('handles a mixed batch: one changed, one unchanged, one deleted, one new', () => {
    const known = new Map([
      ['unchanged.js', hashContent('same')],
      ['changed.js', hashContent('before')],
      ['deleted.js', hashContent('gone')],
    ]);
    const fresh = new Map([
      ['unchanged.js', 'same'],
      ['changed.js', 'after'],
      ['new.js', 'brand new'],
    ]);
    const { changed, unchanged, deleted } = diffFiles(known, fresh);

    assert.deepEqual(unchanged, ['unchanged.js']);
    assert.deepEqual(changed.map((c) => c.path).sort(), ['changed.js', 'new.js']);
    assert.deepEqual(deleted, ['deleted.js']);
  });

  test('empty known + empty fresh yields all-empty result', () => {
    const { changed, unchanged, deleted } = diffFiles(new Map(), new Map());
    assert.deepEqual(changed, []);
    assert.deepEqual(unchanged, []);
    assert.deepEqual(deleted, []);
  });
});
