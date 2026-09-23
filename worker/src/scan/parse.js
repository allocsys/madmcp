import path from 'node:path';
import Parser from 'web-tree-sitter';

// Broad language support via tree-sitter WASM grammars.
// Each entry needs the corresponding tree-sitter-<lang>.wasm file available
// (fetch at build time into worker/grammars/ — see README TODO).
export const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'c_sharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
};

// Symbol node types we care about, per language grammar's node-type names.
// This is intentionally coarse — refine per-language as real repos surface gaps.
const SYMBOL_NODE_TYPES = new Set([
  'function_declaration', 'function_definition', 'function_item',
  'method_definition', 'method_declaration',
  'class_declaration', 'class_definition',
  'interface_declaration',
  'arrow_function', // only kept when assigned to a name — filtered in extractSymbols
]);

let initialized = false;
const parserCache = new Map();

export function detectLanguage(filePath) {
  return LANGUAGE_BY_EXT[path.extname(filePath)] || null;
}

async function initTreeSitter() {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
}

async function getParserFor(language) {
  await initTreeSitter();
  if (parserCache.has(language)) return parserCache.get(language);

  const wasmPath = new URL(`../../grammars/tree-sitter-${language}.wasm`, import.meta.url);
  const Lang = await Parser.Language.load(wasmPath.pathname);
  const parser = new Parser();
  parser.setLanguage(Lang);
  parserCache.set(language, parser);
  return parser;
}

// Parses a file's source into symbols with line ranges + a rough signature.
// Returns [] for unsupported/undetected languages rather than throwing —
// unsupported files still get walked and hashed, just not graph-indexed.
export async function parseFile(filePath, content) {
  const language = detectLanguage(filePath);
  if (!language) return { language: null, tree: null, symbols: [], symbolLocalIdByNodeId: new Map() };

  const parser = await getParserFor(language);
  const tree = parser.parse(content);
  const symbols = [];
  // Maps a tree-sitter AST node id (function/class/method node) to the small
  // integer localId assigned to its symbol, so graph.js can track "which
  // symbol am I currently inside" while walking the tree for call edges.
  const symbolLocalIdByNodeId = new Map();
  let localId = 0;

  function visit(node, enclosingClass) {
    if (SYMBOL_NODE_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName?.('name');
      const name = nameNode ? content.slice(nameNode.startIndex, nameNode.endIndex) : null;
      if (name) {
        const id = localId++;
        symbolLocalIdByNodeId.set(node.id, id);
        symbols.push({
          localId: id,
          kind: node.type.includes('class') ? 'class' : node.type.includes('method') ? 'method' : 'function',
          name,
          qualifiedName: enclosingClass ? `${enclosingClass}.${name}` : name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 200)).split('\n')[0],
        });
      }
    }

    const nextEnclosing = node.type.includes('class') ? (node.childForFieldName?.('name')
      ? content.slice(node.childForFieldName('name').startIndex, node.childForFieldName('name').endIndex)
      : enclosingClass) : enclosingClass;

    for (const child of node.children) visit(child, nextEnclosing);
  }

  visit(tree.rootNode, null);
  return { language, tree, symbols, symbolLocalIdByNodeId };
}
