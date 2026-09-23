// ---------------------------------------------------------------------------
// connectors/repomap/db.js — madmcp's own read-side connection to the same
// Neon/pgvector database the repo_map worker writes to (worker/src/db/).
//
// Deliberately a SEPARATE connection string (REPO_MAP_DATABASE_URL) from the
// one the worker uses (DATABASE_URL, Railway-only) -- point this at a
// read-only Postgres role in Neon, not the worker's read-write credential.
// That way "madmcp only reads, the worker only writes" is enforced by the
// database itself, not just by which functions happen to be called from
// here. A stray write attempt from this pool will fail at the DB with a
// permission error rather than silently succeeding.
// ---------------------------------------------------------------------------

import pg from "pg";
import { REPO_MAP_DATABASE_URL } from "../../config.js";

const { Pool } = pg;

let pool;

function getPool() {
  if (!REPO_MAP_DATABASE_URL) {
    throw new Error("REPO_MAP_DATABASE_URL is not set -- required to query map.query directly from madmcp. Use a read-only Neon role's connection string here, distinct from the worker's read-write DATABASE_URL.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: REPO_MAP_DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon requires SSL
      max: 5, // conservative -- shared across concurrent Vercel invocations of a warm container
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}
