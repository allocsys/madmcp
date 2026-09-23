// test/walk.test.js -- unit coverage for src/scan/walk.js's walkRepo.
// Uses real temp directories (node:fs) rather than mocking fs, since
// walkRepo's whole job is directory traversal + exclude-list filtering.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkRepo, DEFAULT_EXCLUDES } from '../src/scan/walk.js';

describe('walkRepo', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'walk-test-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('walks nested directories and returns relative paths -> content', async () => {
    await mkdir(join(root, 'src', 'lib'), { recursive: true });
    await writeFile(join(root, 'index.js'), 'console.log(1);');
    await writeFile(join(root, 'src', 'lib', 'util.js'), 'export const x = 1;');

    const files = await walkRepo(root);

    assert.equal(files.get('index.js'), 'console.log(1);');
    assert.equal(files.get(join('src', 'lib', 'util.js')), 'export const x = 1;');
    assert.equal(files.size, 2);
  });

  test('skips DEFAULT_EXCLUDES directories entirely, including their contents', async () => {
    const excludedRoot = await mkdtemp(join(tmpdir(), 'walk-test-excl-'));
    try {
      await mkdir(join(excludedRoot, 'node_modules', 'some-pkg'), { recursive: true });
      await writeFile(join(excludedRoot, 'node_modules', 'some-pkg', 'index.js'), 'should not appear');
      await writeFile(join(excludedRoot, 'real.js'), 'should appear');

      const files = await walkRepo(excludedRoot);

      assert.equal(files.size, 1);
      assert.equal(files.get('real.js'), 'should appear');
      assert.equal(files.has(join('node_modules', 'some-pkg', 'index.js')), false);
    } finally {
      await rm(excludedRoot, { recursive: true, force: true });
    }
  });

  test('skips excluded lockfiles by exact name at any depth', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'walk-test-lock-'));
    try {
      await writeFile(join(lockRoot, 'package-lock.json'), '{}');
      await writeFile(join(lockRoot, 'package.json'), '{}');

      const files = await walkRepo(lockRoot);

      assert.equal(files.has('package-lock.json'), false);
      assert.equal(files.has('package.json'), true);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  test('skips files larger than the max-size cutoff', async () => {
    const bigRoot = await mkdtemp(join(tmpdir(), 'walk-test-big-'));
    try {
      const big = 'x'.repeat(500_001); // just over MAX_FILE_BYTES
      const small = 'y'.repeat(1000);
      await writeFile(join(bigRoot, 'huge.js'), big);
      await writeFile(join(bigRoot, 'small.js'), small);

      const files = await walkRepo(bigRoot);

      assert.equal(files.has('huge.js'), false);
      assert.equal(files.has('small.js'), true);
    } finally {
      await rm(bigRoot, { recursive: true, force: true });
    }
  });

  test('respects a custom excludes list, overriding DEFAULT_EXCLUDES', async () => {
    const customRoot = await mkdtemp(join(tmpdir(), 'walk-test-custom-'));
    try {
      await mkdir(join(customRoot, 'node_modules'), { recursive: true });
      await writeFile(join(customRoot, 'node_modules', 'kept.js'), 'kept because custom excludes does not list node_modules');
      await mkdir(join(customRoot, 'skip_me'), { recursive: true });
      await writeFile(join(customRoot, 'skip_me', 'dropped.js'), 'dropped');

      const files = await walkRepo(customRoot, { excludes: ['skip_me'] });

      assert.equal(files.has(join('node_modules', 'kept.js')), true);
      assert.equal(files.has(join('skip_me', 'dropped.js')), false);
    } finally {
      await rm(customRoot, { recursive: true, force: true });
    }
  });

  test('DEFAULT_EXCLUDES includes the expected common noise directories', () => {
    for (const name of ['node_modules', '.git', 'dist', '__pycache__', 'package-lock.json']) {
      assert.ok(DEFAULT_EXCLUDES.includes(name), `expected DEFAULT_EXCLUDES to include ${name}`);
    }
  });
});
