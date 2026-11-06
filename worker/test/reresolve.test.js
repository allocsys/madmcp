// test/reresolve.test.js -- planReResolution from src/scan/resolve.js.
// Pure function over plain rows: no DB, no worker loop.
//
// Regression target: call edges from unchanged files lost their target when a
// callee file was re-indexed (symbols deleted + reinserted with new ids) and
// were never resolved again.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planReResolution } from '../src/scan/resolve.js';

const AGENT_FILE = 10;
const DESIGNER_FILE = 20;
const CALLER_FILE = 40;

function indexOf(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!m.has(e.name)) m.set(e.name, []);
    m.get(e.name).push({ symbolId: e.symbolId, fileId: e.fileId, qualifiedName: e.name });
  }
  return m;
}

const files = new Map([
  ['connectors/delegate/agent/agent_checkpoint.js', AGENT_FILE],
  ['connectors/delegate/designer/designer_checkpoint.js', DESIGNER_FILE],
]);

const plan = (over = {}) =>
  planReResolution({
    unresolvedImports: [],
    importedFileIds: new Map(),
    unresolvedCalls: [],
    symbolIndex: new Map(),
    fileIndex: files,
    ...over,
  });

describe('planReResolution: calls', () => {
  test('heals a call whose target symbol was recreated with a new id', () => {
    const out = plan({
      unresolvedCalls: [{ id: 1, srcFileId: CALLER_FILE, calleeName: 'helper' }],
      symbolIndex: indexOf([{ name: 'helper', symbolId: 77, fileId: AGENT_FILE }]),
    });
    assert.deepEqual(out.callUpdates, [{ id: 1, dstSymbolId: 77 }]);
  });

  test('disambiguates duplicate names through an already-resolved import', () => {
    const out = plan({
      unresolvedCalls: [{ id: 1, srcFileId: CALLER_FILE, calleeName: 'loadCheckpoint' }],
      importedFileIds: new Map([[CALLER_FILE, new Set([AGENT_FILE])]]),
      symbolIndex: indexOf([
        { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
        { name: 'loadCheckpoint', symbolId: 2, fileId: DESIGNER_FILE },
      ]),
    });
    assert.deepEqual(out.callUpdates, [{ id: 1, dstSymbolId: 1 }]);
  });

  test('uses an import healed in the same pass to disambiguate a call', () => {
    const out = plan({
      unresolvedImports: [
        {
          id: 5,
          srcFileId: CALLER_FILE,
          srcPath: 'connectors/delegate/agent/agent_tools.js',
          importSpecifier: './agent_checkpoint.js',
        },
      ],
      unresolvedCalls: [{ id: 1, srcFileId: CALLER_FILE, calleeName: 'loadCheckpoint' }],
      symbolIndex: indexOf([
        { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
        { name: 'loadCheckpoint', symbolId: 2, fileId: DESIGNER_FILE },
      ]),
    });
    assert.deepEqual(out.importUpdates, [{ id: 5, dstFileId: AGENT_FILE }]);
    assert.deepEqual(out.callUpdates, [{ id: 1, dstSymbolId: 1 }]);
  });

  test('leaves an ambiguous call unresolved', () => {
    const out = plan({
      unresolvedCalls: [{ id: 1, srcFileId: CALLER_FILE, calleeName: 'loadCheckpoint' }],
      symbolIndex: indexOf([
        { name: 'loadCheckpoint', symbolId: 1, fileId: AGENT_FILE },
        { name: 'loadCheckpoint', symbolId: 2, fileId: DESIGNER_FILE },
      ]),
    });
    assert.deepEqual(out.callUpdates, []);
  });

  test('leaves a call to an unknown name unresolved', () => {
    const out = plan({ unresolvedCalls: [{ id: 1, srcFileId: CALLER_FILE, calleeName: 'nope' }] });
    assert.deepEqual(out.callUpdates, []);
  });

  test('skips dotted (member) callees', () => {
    const out = plan({
      unresolvedCalls: [{ id: 1, srcFileId: CALLER_FILE, calleeName: 'this.helper' }],
      symbolIndex: indexOf([{ name: 'helper', symbolId: 77, fileId: CALLER_FILE }]),
    });
    assert.deepEqual(out.callUpdates, []);
  });

  test('does not mutate the caller-supplied import map', () => {
    const importedFileIds = new Map([[CALLER_FILE, new Set([DESIGNER_FILE])]]);
    plan({
      unresolvedImports: [
        {
          id: 5,
          srcFileId: CALLER_FILE,
          srcPath: 'connectors/delegate/agent/agent_tools.js',
          importSpecifier: './agent_checkpoint.js',
        },
      ],
      importedFileIds,
    });
    assert.deepEqual([...importedFileIds.get(CALLER_FILE)], [DESIGNER_FILE]);
  });
});

describe('planReResolution: imports', () => {
  test('resolves a relative specifier whose target file now exists', () => {
    const out = plan({
      unresolvedImports: [
        {
          id: 5,
          srcFileId: CALLER_FILE,
          srcPath: 'connectors/delegate/agent/agent_tools.js',
          importSpecifier: './agent_checkpoint.js',
        },
      ],
    });
    assert.deepEqual(out.importUpdates, [{ id: 5, dstFileId: AGENT_FILE }]);
  });

  test('leaves bare package specifiers and missing files unresolved', () => {
    const out = plan({
      unresolvedImports: [
        { id: 1, srcFileId: CALLER_FILE, srcPath: 'a.js', importSpecifier: 'node:crypto' },
        { id: 2, srcFileId: CALLER_FILE, srcPath: 'a.js', importSpecifier: './missing.js' },
      ],
    });
    assert.deepEqual(out.importUpdates, []);
  });
});
