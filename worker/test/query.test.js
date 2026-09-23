// test/query.test.js -- unit coverage for src/query/index.js's queryGraph,
// specifically the symbol+file scoping fix (see connectors/repomap/queries.js's
// queryGraphDb for madmcp's twin copy of the same bug and the same fix).
//
// Uses node:test's built-in module mocking (--experimental-test-module-mocks,
// enabled in package.json's test script) to stub db/client.js's `query` so
// this runs without a real Postgres connection.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('queryGraph', () => {
  test('scopes the symbol lookup to file when both symbol and file are given (previously file was silently ignored)', async () => {
    let capturedSql;
    let capturedParams;

    const queryMock = mock.fn(async (sql, params) => {
      if (sql.includes('FROM repos WHERE')) {
        return { rows: [{ id: 42 }] };
      }
      if (sql.includes('SELECT s.id FROM symbols s JOIN files f') && sql.includes('f.path = $3')) {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [{ id: 777 }] };
      }
      if (sql.includes('WITH RECURSIVE walk')) {
        return { rows: [] };
      }
      throw new Error('unexpected sql: ' + sql);
    });

    mock.module('../src/db/client.js', {
      namedExports: {
        query: queryMock,
        getPool: mock.fn(),
        withTransaction: mock.fn(),
      },
    });

    const { queryGraph } = await import('../src/query/index.js');

    const results = await queryGraph({
      owner: 'o',
      repo: 'r',
      symbol: 'register',
      file: 'connectors/repomap/tools.js',
      direction: 'callers',
    });

    assert.deepEqual(results, []);
    assert.match(
      capturedSql,
      /WHERE s\.repo_id = \$1 AND \(s\.name = \$2 OR s\.qualified_name = \$2\) AND f\.path = \$3/
    );
    assert.deepEqual(capturedParams, [42, 'register', 'connectors/repomap/tools.js']);

    mock.reset();
  });
});
