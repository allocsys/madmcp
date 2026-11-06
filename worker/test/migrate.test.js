import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runMigrations } from '../src/db/migrate.js';

const SCHEMA_URL = new URL('../src/db/schema.sql', import.meta.url);

function fakePool({ failOn } = {}) {
  const calls = [];
  let released = 0;
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (failOn && text === failOn) throw new Error('boom');
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  return { pool: { connect: async () => client }, calls, released: () => released };
}

test('runMigrations applies schema.sql in one transaction under an advisory lock', async () => {
  const schema = await readFile(SCHEMA_URL, 'utf8');
  const { pool, calls, released } = fakePool();

  await runMigrations({ pool });

  assert.equal(calls[0].text, 'BEGIN');
  assert.match(calls[1].text, /pg_advisory_xact_lock/);
  assert.equal(calls[2].text, schema);
  assert.equal(calls[3].text, 'COMMIT');
  assert.equal(calls.length, 4);
  assert.equal(released(), 1);
});

test('runMigrations rolls back, releases the client and rethrows on failure', async () => {
  const schema = await readFile(SCHEMA_URL, 'utf8');
  const { pool, calls, released } = fakePool({ failOn: schema });

  await assert.rejects(() => runMigrations({ pool }), /boom/);

  assert.equal(calls.at(-1).text, 'ROLLBACK');
  assert.ok(!calls.some((c) => c.text === 'COMMIT'));
  assert.equal(released(), 1);
});

test('schema.sql is safe to re-run on an existing database', async () => {
  const sql = await readFile(SCHEMA_URL, 'utf8');
  const code = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

  assert.doesNotMatch(code, /CREATE TABLE (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(code, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(code, /ADD COLUMN (?!IF NOT EXISTS)/i);
  assert.match(code, /ADD COLUMN IF NOT EXISTS callee_name/i);
  assert.match(code, /ADD COLUMN IF NOT EXISTS import_specifier/i);
  assert.match(code, /dst_symbol_id INTEGER REFERENCES symbols\(id\) ON DELETE SET NULL/);
});
