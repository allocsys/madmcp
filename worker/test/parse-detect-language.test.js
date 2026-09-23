// test/parse-detect-language.test.js -- unit coverage for src/scan/parse.js's
// detectLanguage/LANGUAGE_BY_EXT mapping. Deliberately does NOT exercise
// parseFile itself, since that requires the vendored tree-sitter .wasm
// grammars (worker/grammars/, produced by scripts/copy-grammars.js at build
// time) which aren't present in a plain `npm install` checkout -- see the
// Dockerfile's grammars step. detectLanguage is pure path-extension lookup
// and needs none of that.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, LANGUAGE_BY_EXT } from '../src/scan/parse.js';

describe('detectLanguage', () => {
  test('maps common extensions to their language', () => {
    assert.equal(detectLanguage('src/index.js'), 'javascript');
    assert.equal(detectLanguage('src/App.tsx'), 'tsx');
    assert.equal(detectLanguage('src/App.ts'), 'typescript');
    assert.equal(detectLanguage('main.py'), 'python');
    assert.equal(detectLanguage('main.go'), 'go');
    assert.equal(detectLanguage('lib.rs'), 'rust');
  });

  test('is case-sensitive on extension, per path.extname semantics', () => {
    // path.extname('a.JS') === '.JS', which is not a key in LANGUAGE_BY_EXT.
    assert.equal(detectLanguage('weird.JS'), null);
  });

  test('returns null for an unsupported/unknown extension', () => {
    assert.equal(detectLanguage('README.md'), null);
    assert.equal(detectLanguage('data.json'), null);
    assert.equal(detectLanguage('noextension'), null);
  });

  test('every LANGUAGE_BY_EXT entry starts with a dot', () => {
    for (const ext of Object.keys(LANGUAGE_BY_EXT)) {
      assert.ok(ext.startsWith('.'), `expected extension key "${ext}" to start with "."`);
    }
  });
});
