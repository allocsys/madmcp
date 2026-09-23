-- repo_map schema (Neon Postgres + pgvector)

CREATE EXTENSION IF NOT EXISTS vector;

-- one row per repo being tracked
CREATE TABLE IF NOT EXISTS repos (
  id            SERIAL PRIMARY KEY,
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,
  default_ref   TEXT NOT NULL DEFAULT 'main',
  last_scanned_commit TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

-- scan job tracking (queue + status, polled by madmcp)
CREATE TABLE IF NOT EXISTS scan_jobs (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ref           TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  error         TEXT,
  claimed_by    TEXT,                            -- machine/instance id, for SKIP LOCKED safety
  files_scanned INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  chunks_embedded INTEGER DEFAULT 0,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs (status);

-- one row per file, keyed by content hash for incremental re-scans
CREATE TABLE IF NOT EXISTS files (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  language      TEXT,
  content_hash  TEXT NOT NULL,
  last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, path)
);
CREATE INDEX IF NOT EXISTS idx_files_repo ON files (repo_id);

-- one row per symbol (function/class/method/const-fn, language-agnostic)
CREATE TABLE IF NOT EXISTS symbols (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,       -- function | class | method | interface | ...
  name          TEXT NOT NULL,
  qualified_name TEXT,               -- e.g. ClassName.methodName
  start_line    INTEGER,
  end_line      INTEGER,
  signature     TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols (repo_id);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols (file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols (name);

-- graph edges between symbols/files: calls, imports, inherits, references
CREATE TABLE IF NOT EXISTS edges (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  src_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  dst_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  src_file_id   INTEGER REFERENCES files(id) ON DELETE CASCADE,
  dst_file_id   INTEGER REFERENCES files(id) ON DELETE CASCADE,
  edge_type     TEXT NOT NULL         -- calls | imports | inherits | references
);
CREATE INDEX IF NOT EXISTS idx_edges_repo ON edges (repo_id);
CREATE INDEX IF NOT EXISTS idx_edges_src_symbol ON edges (src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst_symbol ON edges (dst_symbol_id);

-- per-function/class chunk text + embedding, for semantic search
CREATE TABLE IF NOT EXISTS chunks (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  symbol_id     INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  embedding     vector(1536),         -- text-embedding-3-small dimension
  content_hash  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks (repo_id);
-- ivfflat requires ANALYZE after bulk load; fine to add once table has data
-- CREATE INDEX idx_chunks_embedding ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
