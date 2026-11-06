import { readFile } from 'node:fs/promises';
import { getPool } from './client.js';

// schema.sql is written to be idempotent (CREATE ... IF NOT EXISTS, ALTER ...
// ADD COLUMN IF NOT EXISTS, and a guarded DO block for the edges foreign key),
// so applying the whole file on every start brings both a fresh database and an
// already-deployed one up to the current schema. No migration history table is
// needed as long as every change added to schema.sql stays safe to re-run.
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);

// Arbitrary constant. Serializes concurrent starts (deploy overlap, several
// replicas) so two workers never run the DDL at the same moment.
const MIGRATION_LOCK_KEY = 727001;

// Applies schema.sql in a single transaction under a transaction-level advisory
// lock. If anything fails the transaction rolls back and the error is thrown.
// `pool` and `schemaPath` are injectable for tests.
export async function runMigrations({ pool = getPool(), schemaPath = SCHEMA_PATH } = {}) {
  const sql = await readFile(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(sql); // no params -> simple query protocol, multiple statements allowed
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be broken; the original error is what matters
    }
    throw err;
  } finally {
    client.release();
  }
}
