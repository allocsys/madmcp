// Builds edges from a parsed file: imports (resolved to other files where
// possible) and calls (resolved to other symbols where possible; left
// unresolved — dstSymbolId/dstFileId null — when the target can't be
// determined from single-file parsing alone. A cross-file resolution pass
// can backfill these once all files in a scan are parsed).

const IMPORT_NODE_TYPES = new Set(['import_statement', 'import_declaration', 'require_call']);
const CALL_NODE_TYPES = new Set(['call_expression', 'call']);

export function buildEdges({ filePath, content, tree, symbolLocalIdByNodeId }) {
  const edges = [];
  if (!tree) return edges; // language without a loaded grammar — no edges, still walked/hashed

  function visit(node, enclosingSymbolLocalId) {
    if (IMPORT_NODE_TYPES.has(node.type)) {
      const raw = content.slice(node.startIndex, node.endIndex);
      const specifierMatch = raw.match(/['"]([^'"]+)['"]/);
      if (specifierMatch) {
        edges.push({
          edgeType: 'imports',
          srcLocalId: null, // file-level edge, not tied to a symbol
          importSpecifier: specifierMatch[1], // resolved to dstFileId by the caller (queue.js) after all files are known
        });
      }
    }

    if (CALL_NODE_TYPES.has(node.type) && enclosingSymbolLocalId != null) {
      const calleeNode = node.childForFieldName?.('function') || node.children?.[0];
      const calleeName = calleeNode ? content.slice(calleeNode.startIndex, calleeNode.endIndex) : null;
      if (calleeName) {
        edges.push({
          edgeType: 'calls',
          srcLocalId: enclosingSymbolLocalId,
          calleeName, // resolved to dstSymbolId by the caller if a matching symbol name exists in-repo
        });
      }
    }

    // Descending into a function/class/method node switches "enclosing
    // symbol" to that node's own localId (looked up from parse.js's map);
    // otherwise keep carrying whatever symbol we were already inside.
    const nextEnclosing = symbolLocalIdByNodeId.has(node.id)
      ? symbolLocalIdByNodeId.get(node.id)
      : enclosingSymbolLocalId;
    for (const child of node.children || []) visit(child, nextEnclosing);
  }

  visit(tree.rootNode, null);
  return edges;
}
