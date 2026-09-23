// test/graph.test.js -- unit coverage for src/scan/graph.js's buildEdges.
// Builds fake tree-sitter-shaped nodes by hand (rootNode/children/type/
// startIndex/endIndex/id/childForFieldName) so this doesn't need a real
// grammar loaded -- graph.js only ever touches that generic shape.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEdges } from '../src/scan/graph.js';

let nextId = 0;
function node({ type, startIndex, endIndex, children = [], fields = {} }) {
  return {
    id: nextId++,
    type,
    startIndex,
    endIndex,
    children,
    childForFieldName: (name) => fields[name] ?? null,
  };
}

describe('buildEdges', () => {
  test('returns [] when tree is null (unsupported/undetected language)', () => {
    const edges = buildEdges({ filePath: 'a.rb', content: '', tree: null, symbolLocalIdByNodeId: new Map() });
    assert.deepEqual(edges, []);
  });

  test('extracts an import edge with the quoted specifier', () => {
    const content = `import foo from 'bar-lib';`;
    const importNode = node({ type: 'import_statement', startIndex: 0, endIndex: content.length });
    const root = node({ type: 'program', startIndex: 0, endIndex: content.length, children: [importNode] });

    const edges = buildEdges({ filePath: 'a.js', content, tree: { rootNode: root }, symbolLocalIdByNodeId: new Map() });

    assert.equal(edges.length, 1);
    assert.equal(edges[0].edgeType, 'imports');
    assert.equal(edges[0].importSpecifier, 'bar-lib');
    assert.equal(edges[0].srcLocalId, null);
  });

  test('ignores an import statement with no quoted specifier match', () => {
    const content = `import weird_syntax`;
    const importNode = node({ type: 'import_statement', startIndex: 0, endIndex: content.length });
    const root = node({ type: 'program', startIndex: 0, endIndex: content.length, children: [importNode] });

    const edges = buildEdges({ filePath: 'a.js', content, tree: { rootNode: root }, symbolLocalIdByNodeId: new Map() });

    assert.deepEqual(edges, []);
  });

  test('extracts a call edge tagged with the enclosing symbol via the field name', () => {
    const content = `function outer() { helper(); }`;
    const calleeIdx = content.indexOf('helper');
    const calleeNode = node({ type: 'identifier', startIndex: calleeIdx, endIndex: calleeIdx + 'helper'.length });
    const callNode = node({
      type: 'call_expression',
      startIndex: calleeIdx,
      endIndex: content.indexOf(';') + 1,
      fields: { function: calleeNode },
    });
    const fnNode = node({ type: 'function_declaration', startIndex: 0, endIndex: content.length, children: [callNode] });
    const root = node({ type: 'program', startIndex: 0, endIndex: content.length, children: [fnNode] });

    const symbolLocalIdByNodeId = new Map([[fnNode.id, 0]]);
    const edges = buildEdges({ filePath: 'a.js', content, tree: { rootNode: root }, symbolLocalIdByNodeId });

    assert.equal(edges.length, 1);
    assert.equal(edges[0].edgeType, 'calls');
    assert.equal(edges[0].calleeName, 'helper');
    assert.equal(edges[0].srcLocalId, 0);
  });

  test('drops a call edge with no enclosing symbol (top-level call, no fn/method around it)', () => {
    const content = `helper();`;
    const calleeIdx = 0;
    const calleeNode = node({ type: 'identifier', startIndex: calleeIdx, endIndex: 'helper'.length });
    const callNode = node({
      type: 'call_expression',
      startIndex: 0,
      endIndex: content.length,
      fields: { function: calleeNode },
    });
    const root = node({ type: 'program', startIndex: 0, endIndex: content.length, children: [callNode] });

    const edges = buildEdges({ filePath: 'a.js', content, tree: { rootNode: root }, symbolLocalIdByNodeId: new Map() });

    assert.deepEqual(edges, []);
  });

  test('falls back to children[0] for the callee when childForFieldName("function") is unavailable', () => {
    const content = `helper()`;
    const calleeNode = node({ type: 'identifier', startIndex: 0, endIndex: 'helper'.length });
    // No `fields` passed -- childForFieldName('function') resolves to null,
    // so buildEdges should fall back to node.children[0].
    const callNode = node({ type: 'call_expression', startIndex: 0, endIndex: content.length, children: [calleeNode] });
    const fnNode = node({ type: 'function_declaration', startIndex: 0, endIndex: content.length, children: [callNode] });
    const root = node({ type: 'program', startIndex: 0, endIndex: content.length, children: [fnNode] });

    const symbolLocalIdByNodeId = new Map([[fnNode.id, 3]]);
    const edges = buildEdges({ filePath: 'a.js', content, tree: { rootNode: root }, symbolLocalIdByNodeId });

    assert.equal(edges.length, 1);
    assert.equal(edges[0].calleeName, 'helper');
    assert.equal(edges[0].srcLocalId, 3);
  });

  test('nested calls inside a second function are attributed to that inner symbol, not the outer one', () => {
    const content = `function outerFn() { function innerFn() { helper(); } }`;
    const calleeIdx = content.indexOf('helper');
    const calleeNode = node({ type: 'identifier', startIndex: calleeIdx, endIndex: calleeIdx + 'helper'.length });
    const callNode = node({ type: 'call_expression', startIndex: calleeIdx, endIndex: content.indexOf(';') + 1, fields: { function: calleeNode } });
    const innerFn = node({ type: 'function_declaration', startIndex: content.indexOf('function innerFn'), endIndex: content.lastIndexOf('}'), children: [callNode] });
    const outerFn = node({ type: 'function_declaration', startIndex: 0, endIndex: content.length, children: [innerFn] });
    const root = node({ type: 'program', startIndex: 0, endIndex: content.length, children: [outerFn] });

    const symbolLocalIdByNodeId = new Map([[outerFn.id, 0], [innerFn.id, 1]]);
    const edges = buildEdges({ filePath: 'a.js', content, tree: { rootNode: root }, symbolLocalIdByNodeId });

    assert.equal(edges.length, 1);
    assert.equal(edges[0].srcLocalId, 1, 'call should be attributed to the innermost enclosing symbol');
  });
});
