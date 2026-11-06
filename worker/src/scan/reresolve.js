import { planReResolution } from './resolve.js';
import {
  getUnresolvedImportEdges,
  getResolvedImportTargets,
  getUnresolvedCallEdges,
  setEdgeDstFiles,
  setEdgeDstSymbols,
} from '../db/queries.js';

// Runs after a scan's pass 2. Edges whose target did not exist when they were
// written, or whose target symbol was deleted and reinserted by a later scan
// (edges.dst_symbol_id is ON DELETE SET NULL), are re-resolved from the stored
// callee_name / import_specifier against the current repo-wide indexes -- no
// re-parsing of the caller's file. symbolIndex and fileIndex are the ones the
// scan already built after pass 1 (getSymbolIndex / getFileIndex).
export async function reResolveRepoEdges({ repoId, symbolIndex, fileIndex }) {
  const [unresolvedImports, importedFileIds, unresolvedCalls] = await Promise.all([
    getUnresolvedImportEdges(repoId),
    getResolvedImportTargets(repoId),
    getUnresolvedCallEdges(repoId),
  ]);

  const { importUpdates, callUpdates } = planReResolution({
    unresolvedImports,
    importedFileIds,
    unresolvedCalls,
    symbolIndex,
    fileIndex,
  });

  await setEdgeDstFiles(importUpdates);
  await setEdgeDstSymbols(callUpdates);

  return {
    importsResolved: importUpdates.length,
    callsResolved: callUpdates.length,
    importsStillUnresolved: unresolvedImports.length - importUpdates.length,
    callsStillUnresolved: unresolvedCalls.length - callUpdates.length,
  };
}
