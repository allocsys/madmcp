// test/edge-names.test.js -- storableCalleeName / withEdgeNames from
// src/scan/resolve.js. Pure functions, no DB.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { storableCalleeName, withEdgeNames } from '../src/scan/resolve.js';

describe('storableCalleeName', () => {
  test('keeps plain identifiers and dotted chains', () => {
    assert.equal(storableCalleeName('helper'), 'helper');
    assert.equal(storableCalleeName('this.loadCheckpoint'), 'this.loadCheckpoint');
    assert.equal(storableCalleeName('Foo.bar.baz'), 'Foo.bar.baz');
    assert.equal(storableCalleeName('$el._priv'), '$el._priv');
  });

  test('drops anything that is not a name', () => {
    assert.equal(storableCalleeName('(function () { run(); })'), null);
    assert.equal(storableCalleeName('getThing().run'), null);
    assert.equal(storableCalleeName('a["b"]'), null);
    assert.equal(storableCalleeName(''), null);
    assert.equal(storableCalleeName(null), null);
    assert.equal(storableCalleeName(undefined), null);
  });

  test('drops names longer than the limit', () => {
    assert.equal(storableCalleeName('a'.repeat(201)), null);
    assert.equal(storableCalleeName('a'.repeat(200)), 'a'.repeat(200));
  });
});

describe('withEdgeNames', () => {
  test('adds callee_name to a call edge and leaves the resolution untouched', () => {
    const raw = { edgeType: 'calls', srcLocalId: 0, calleeName: 'loadCheckpoint' };
    const resolved = { edgeType: 'calls', srcSymbolId: 5, dstSymbolId: null };
    assert.deepEqual(withEdgeNames(raw, resolved), {
      edgeType: 'calls',
      srcSymbolId: 5,
      dstSymbolId: null,
      calleeName: 'loadCheckpoint',
      importSpecifier: null,
    });
  });

  test('stores NULL callee_name when the callee is not a plain name', () => {
    const raw = { edgeType: 'calls', srcLocalId: 0, calleeName: '(async () => {})' };
    const out = withEdgeNames(raw, { edgeType: 'calls', srcSymbolId: 5, dstSymbolId: null });
    assert.equal(out.calleeName, null);
  });

  test('adds import_specifier to an import edge, resolved or not', () => {
    const raw = { edgeType: 'imports', srcLocalId: null, importSpecifier: './agent_checkpoint.js' };
    assert.deepEqual(withEdgeNames(raw, { edgeType: 'imports', srcSymbolId: null, dstFileId: 10 }), {
      edgeType: 'imports',
      srcSymbolId: null,
      dstFileId: 10,
      calleeName: null,
      importSpecifier: './agent_checkpoint.js',
    });
    const pkg = { edgeType: 'imports', srcLocalId: null, importSpecifier: 'node:crypto' };
    assert.equal(withEdgeNames(pkg, { edgeType: 'imports', srcSymbolId: null, dstFileId: null }).importSpecifier, 'node:crypto');
  });

  test('drops an oversized import specifier', () => {
    const raw = { edgeType: 'imports', srcLocalId: null, importSpecifier: './' + 'a'.repeat(600) };
    assert.equal(withEdgeNames(raw, { edgeType: 'imports', srcSymbolId: null, dstFileId: null }).importSpecifier, null);
  });
});
