// test/resolve.test.js -- unit coverage for src/scan/resolve.js's resolveEdge.
// Pure function: no DB, no worker loop. The symbol/file indexes are plain
// Maps shaped like db/queries.js's getSymbolIndex()/getFileIndex().
//
// Regression target: a call to a name defined in several files (e.g.
// loadCheckpoint in agent/designer/editor checkpoint modules) used to be left
// unresolved, so `map` graph callers returned nothing for it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEdge } from '../src/scan/resolve.js';

const AGENT_FILE = 10;
const DESIGNER_FILE = 20;
const EDITOR_FILE = 30;
const CALLER_FILE = 40;

// name -> [{ symbolId, fileId, qualifiedName }]
function indexOf(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!m.has(e.name)) m.set(e.name, []);
    m.get(e.name).push({ symbolId: e.symbolId, fileId: e.fileId, qualifiedName: e.name });
  }
  return m;
}

const callEdge = (calleeName) => ({ edgeType: 'calls', srcLocalId: 0, calleeName });
const symbolIdByLocal = new Map([[0, 999]]);
const fileIndex = new Map();

describe('resolveEdge: calls', () => {
  test('resolves a uniquely named callee (existing behavior)', () => {
    const symbolIndex = indexOf([{ name: 'helper', symbolId: 1, fileId: AGENT_FILE }]);
    const out = resolveEdge(callEdge('helper'), 'x.js', symbolIdByLocal, symbolIndex, fileIndex, {
      fileId: CALLER_FILE,
      importedFileIds: new Set(),
    });
    assert.deepEqual(out, { edgeType: 'calls', srcSymbolId: 999, dstSymbolId: 1 });
  });

  test('returns null dst for an unknown callee', () => {
    const out = resolveEdge(callEdge('nope'), 'x.js', symbolIdByLocal, new Map(), fileIndex, {
      fileId: CALLER_FILE,
      importedFileIds: new Set(),
    });
    assert.equal(out.dstSymbolId, null);
  });

  test('duplicate names: prefers the candidate defined in the same file', () => {
    const symbolIndex = indexOf([
      { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
      { name: 'loadCheckpoint', symbolId: 2, fileId: DESIGNER_FILE },
      { name: 'loadCheckpoint', symbolId: 3, fileId: EDITOR_FILE },
    ]);
    const out = resolveEdge(callEdge('loadCheckpoint'), 'designer_checkpoint.js', symbolIdByLocal, symbolIndex, fileIndex, {
      fileId: DESIGNER_FILE,
      importedFileIds: new Set(),
    });
    assert.equal(out.dstSymbolId, 2);
  });

  test('duplicate names: resolves to the candidate in the one imported file', () => {
    const symbolIndex = indexOf([
      { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
      { name: 'loadCheckpoint', symbolId: 2, fileId: DESIGNER_FILE },
      { name: 'loadCheckpoint', symbolId: 3, fileId: EDITOR_FILE },
    ]);
    const out = resolveEdge(callEdge('loadCheckpoint'), 'agent_tools.js', symbolIdByLocal, symbolIndex, fileIndex, {
      fileId: CALLER_FILE,
      importedFileIds: new Set([AGENT_FILE]),
    });
    assert.equal(out.dstSymbolId, 1);
  });

  test('duplicate names: same-file definition wins over an imported one', () => {
    const symbolIndex = indexOf([
      { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
      { name: 'loadCheckpoint', symbolId: 2, fileId: CALLER_FILE },
    ]);
    const out = resolveEdge(callEdge('loadCheckpoint'), 'x.js', symbolIdByLocal, symbolIndex, fileIndex, {
      fileId: CALLER_FILE,
      importedFileIds: new Set([AGENT_FILE]),
    });
    assert.equal(out.dstSymbolId, 2);
  });

  test('duplicate names: stays unresolved when no candidate is local or imported', () => {
    const symbolIndex = indexOf([
      { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
      { name: 'loadCheckpoint', symbolId: 2, fileId: DESIGNER_FILE },
    ]);
    const out = resolveEdge(callEdge('loadCheckpoint'), 'x.js', symbolIdByLocal, symbolIndex, fileIndex, {
      fileId: CALLER_FILE,
      importedFileIds: new Set([EDITOR_FILE]),
    });
    assert.equal(out.dstSymbolId, null);
  });

  test('duplicate names: stays unresolved when several imported files still match', () => {
    const symbolIndex = indexOf([
      { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
      { name: 'loadCheckpoint', symbolId: 2, fileId: DESIGNER_FILE },
    ]);
    const out = resolveEdge(callEdge('loadCheckpoint'), 'x.js', symbolIdByLocal, symbolIndex, fileIndex, {
      fileId: CALLER_FILE,
      importedFileIds: new Set([AGENT_FILE, DESIGNER_FILE]),
    });
    assert.equal(out.dstSymbolId, null);
  });

  test('works without a ctx argument (falls back to unique-name behavior)', () => {
    const symbolIndex = indexOf([{ name: 'helper', symbolId: 1, fileId: AGENT_FILE }]);
    const out = resolveEdge(callEdge('helper'), 'x.js', symbolIdByLocal, symbolIndex, fileIndex);
    assert.equal(out.dstSymbolId, 1);
  });
});

describe('resolveEdge: imports', () => {
  const files = new Map([
    ['connectors/delegate/agent/agent_checkpoint.js', 10],
    ['connectors/delegate/agent/index.js', 11],
  ]);

  test('resolves a relative specifier to a file id', () => {
    const out = resolveEdge(
      { edgeType: 'imports', srcLocalId: null, importSpecifier: './agent_checkpoint.js' },
      'connectors/delegate/agent/agent_tools.js',
      new Map(),
      new Map(),
      files,
    );
    assert.deepEqual(out, { edgeType: 'imports', srcSymbolId: null, dstFileId: 10 });
  });

  test('resolves a directory specifier through index.js', () => {
    const out = resolveEdge(
      { edgeType: 'imports', srcLocalId: null, importSpecifier: './agent' },
      'connectors/delegate/x.js',
      new Map(),
      new Map(),
      files,
    );
    assert.equal(out.dstFileId, 11);
  });

  test('leaves bare package specifiers unresolved', () => {
    const out = resolveEdge(
      { edgeType: 'imports', srcLocalId: null, importSpecifier: 'node:crypto' },
      'a.js',
      new Map(),
      new Map(),
      files,
    );
    assert.equal(out.dstFileId, null);
  });
});
