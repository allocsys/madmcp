// Resolves raw edges from graph.js's buildEdges into DB-ready edges: fills in
// dstSymbolId (for `calls`) or dstFileId (for `imports`) where the target can
// be determined, leaves them null otherwise (e.g. calls into a third-party
// package, or a name that stays ambiguous after disambiguation).
//
// Kept free of DB/worker side effects (queue.js starts the worker loop on
// import) so it can be unit tested directly -- see test/resolve.test.js.

// Extensions tried (in order, with no extension first) when resolving a
// relative import specifier that omits its extension, e.g. './foo' could be
// './foo.js' or './foo/index.ts'.
const RESOLVE_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rb'];

// ctx (optional): { fileId, importedFileIds } for the file the edge lives in.
// Only used to disambiguate calls whose name is defined more than once in the
// repo. Ids are compared as strings since the DB driver may return bigint ids
// as strings in one query and numbers in another.
export function resolveEdge(edge, filePath, symbolIdByLocal, symbolIndex, fileIndex, ctx = {}) {
  if (edge.edgeType === 'calls') {
    const srcSymbolId = edge.srcLocalId != null ? symbolIdByLocal.get(edge.srcLocalId) : null;
    const dstSymbolId = lookupCallee(edge.calleeName, symbolIndex, ctx);
    return { edgeType: 'calls', srcSymbolId, dstSymbolId: dstSymbolId ?? null };
  }

  // imports
  const dstFileId = resolveImportSpecifier(edge.importSpecifier, filePath, fileIndex);
  return { edgeType: 'imports', srcSymbolId: null, dstFileId };
}

// Picks the callee symbol among same-named candidates:
//   1. a single candidate repo-wide -> that one
//   2. otherwise a definition in the calling file shadows everything else
//      (exactly one local match resolves; several local matches stay ambiguous)
//   3. otherwise the candidates living in files the caller imports; resolves
//      only if exactly one remains
// Anything else is left unresolved rather than guessed.
function pickCallee(candidates, ctx) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].symbolId;

  if (ctx.fileId != null) {
    const local = candidates.filter((c) => String(c.fileId) === String(ctx.fileId));
    if (local.length) return local.length === 1 ? local[0].symbolId : null;
  }

  if (ctx.importedFileIds && ctx.importedFileIds.size) {
    const imported = new Set([...ctx.importedFileIds].map(String));
    const hits = candidates.filter((c) => imported.has(String(c.fileId)));
    if (hits.length === 1) return hits[0].symbolId;
  }

  return null;
}

const SELF_RECEIVERS = new Set(['this', 'self']);

// A class/object method rather than a free function. The parser marks
// JS/TS/Java/Go/C# methods with kind 'method' and gives Python methods (kind
// 'function') a `Class.name` qualified name.
function isMethod(c) {
  return (
    c.kind === 'method' ||
    (c.qualifiedName != null && c.qualifiedName !== c.name && c.qualifiedName.endsWith(`.${c.name}`))
  );
}

// Resolves the callee text of a call edge to a symbol id, or null.
//   helper         -> pickCallee (unique / same-file / imported-file)
//   this.x, self.x -> a method named x defined in the calling file (exactly one)
//   super.x        -> unresolved (the parent class is not known here)
//   Foo.bar        -> the symbol whose qualified name is exactly Foo.bar, if unique
//   obj.x          -> a METHOD named x in the calling file or in a file it imports,
//                     exactly one. Never a repo-wide guess: the receiver is usually a
//                     value of unknown type (arr.map, db.query).
//   a.b.x, calls on call results, anything that is not a plain identifier chain
//                  -> unresolved (an exact qualified-name hit still resolves).
// ctx: { fileId, importedFileIds } of the calling file, as for pickCallee.
export function lookupCallee(calleeName, symbolIndex, ctx = {}) {
  if (storableCalleeName(calleeName) == null) return null;
  if (!calleeName.includes('.')) return pickCallee(symbolIndex.get(calleeName), ctx);

  const parts = calleeName.split('.');
  const candidates = symbolIndex.get(parts[parts.length - 1]);
  if (!candidates || candidates.length === 0) return null;

  const sameFile = (c) => ctx.fileId != null && String(c.fileId) === String(ctx.fileId);
  const imported =
    ctx.importedFileIds && ctx.importedFileIds.size ? new Set([...ctx.importedFileIds].map(String)) : null;
  const inScope = (c) => sameFile(c) || (imported != null && imported.has(String(c.fileId)));

  if (parts.length === 2 && parts[0] === 'super') return null;

  if (parts.length === 2 && SELF_RECEIVERS.has(parts[0])) {
    const own = candidates.filter((c) => sameFile(c) && isMethod(c));
    return own.length === 1 ? own[0].symbolId : null;
  }

  const exact = candidates.filter((c) => c.qualifiedName === calleeName);
  if (exact.length === 1) return exact[0].symbolId;

  if (parts.length !== 2) return null;
  const methods = candidates.filter((c) => isMethod(c) && inScope(c));
  return methods.length === 1 ? methods[0].symbolId : null;
}

// File ids this file imports, from its raw `imports` edges.
export function collectImportedFileIds(rawEdges, filePath, fileIndex) {
  const ids = new Set();
  for (const e of rawEdges) {
    if (e.edgeType !== 'imports') continue;
    const id = resolveImportSpecifier(e.importSpecifier, filePath, fileIndex);
    if (id != null) ids.add(id);
  }
  return ids;
}

// Re-resolution of edges that are already in the database but have no target
// (dst_symbol_id / dst_file_id NULL). Edges end up in that state when the target
// did not exist yet at the time, or when the target's symbol was deleted and
// reinserted by a later scan (ON DELETE SET NULL). The caller's file is NOT
// re-parsed: everything needed is stored on the edge (callee_name,
// import_specifier).
//
// Inputs (plain rows, ids as returned by the DB driver):
//   unresolvedImports: [{ id, srcFileId, srcPath, importSpecifier }]
//   importedFileIds:   Map<srcFileId, Set<dstFileId>> from imports that already resolve
//   unresolvedCalls:   [{ id, srcFileId, calleeName }]
//   symbolIndex / fileIndex: same shapes as getSymbolIndex() / getFileIndex()
// Returns { importUpdates: [{ id, dstFileId }], callUpdates: [{ id, dstSymbolId }] }.
//
// Imports are resolved first and feed the import set used to disambiguate
// calls, so a call can resolve through an import that was itself healed in the
// same pass. Callee text goes through lookupCallee, so member calls follow its
// stricter rules.
export function planReResolution({ unresolvedImports, importedFileIds, unresolvedCalls, symbolIndex, fileIndex }) {
  const imported = new Map();
  for (const [fileId, set] of importedFileIds) imported.set(String(fileId), new Set(set));

  const importUpdates = [];
  for (const e of unresolvedImports) {
    const dstFileId = resolveImportSpecifier(e.importSpecifier, e.srcPath, fileIndex);
    if (dstFileId == null) continue;
    importUpdates.push({ id: e.id, dstFileId });
    const key = String(e.srcFileId);
    if (!imported.has(key)) imported.set(key, new Set());
    imported.get(key).add(dstFileId);
  }

  const callUpdates = [];
  for (const e of unresolvedCalls) {
    const dstSymbolId = lookupCallee(e.calleeName, symbolIndex, {
      fileId: e.srcFileId,
      importedFileIds: imported.get(String(e.srcFileId)),
    });
    if (dstSymbolId != null) callUpdates.push({ id: e.id, dstSymbolId });
  }

  return { importUpdates, callUpdates };
}

// A callee we can store and later re-resolve from the database: a plain
// identifier or dotted chain (`helper`, `this.load`, `Foo.bar`). Anything else
// -- an inline function expression, a call on a call result, a very long
// expression -- is not a name, so it is stored as NULL instead of as source text.
const CALLEE_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const MAX_CALLEE_LENGTH = 200;
const MAX_SPECIFIER_LENGTH = 500;

export function storableCalleeName(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CALLEE_LENGTH) return null;
  return CALLEE_CHAIN.test(raw) ? raw : null;
}

// Adds the data a later re-resolve pass needs (callee_name for calls,
// import_specifier for imports) onto an edge already returned by resolveEdge.
// Kept separate from resolveEdge so its return shape stays unchanged.
export function withEdgeNames(rawEdge, resolvedEdge) {
  if (rawEdge.edgeType === 'calls') {
    return { ...resolvedEdge, calleeName: storableCalleeName(rawEdge.calleeName), importSpecifier: null };
  }
  const spec = typeof rawEdge.importSpecifier === 'string' && rawEdge.importSpecifier.length <= MAX_SPECIFIER_LENGTH
    ? rawEdge.importSpecifier
    : null;
  return { ...resolvedEdge, calleeName: null, importSpecifier: spec };
}

function resolveImportSpecifier(specifier, fromPath, fileIndex) {
  if (!specifier || !specifier.startsWith('.')) return null; // bare/package specifier — not in-repo
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const base = normalizePath(dir ? `${dir}/${specifier}` : specifier);

  for (const ext of RESOLVE_EXTENSIONS) {
    if (fileIndex.has(base + ext)) return fileIndex.get(base + ext);
    if (fileIndex.has(`${base}/index${ext}`)) return fileIndex.get(`${base}/index${ext}`);
  }
  return null;
}

// Collapses '.' and '..' segments in a joined relative path, e.g.
// 'src/scan/../db/client' -> 'src/db/client'.
function normalizePath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
