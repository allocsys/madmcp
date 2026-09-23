// Build-time step: copies just the tree-sitter grammars we actually need
// (per parse.js's LANGUAGE_BY_EXT) out of the tree-sitter-wasms npm package
// into worker/grammars/, where parse.js loads them from at runtime.
//
// Run after `npm install` and after src/ is in place (needs to import
// src/scan/parse.js as the source of truth for which grammars are needed) —
// see Dockerfile. tree-sitter-wasms itself is only a build-time dependency;
// its ~12MB node_modules footprint is removed again once this has run.

import { mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LANGUAGE_BY_EXT } from '../src/scan/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out');
const DEST_DIR = path.join(__dirname, '..', 'grammars');

async function main() {
  if (!existsSync(SRC_DIR)) {
    console.error(`tree-sitter-wasms not found at ${SRC_DIR} — is it installed?`);
    process.exit(1);
  }

  await mkdir(DEST_DIR, { recursive: true });

  const languages = [...new Set(Object.values(LANGUAGE_BY_EXT))];
  let copied = 0;

  for (const lang of languages) {
    const filename = `tree-sitter-${lang}.wasm`;
    const src = path.join(SRC_DIR, filename);
    const dest = path.join(DEST_DIR, filename);

    if (!existsSync(src)) {
      // tree-sitter-wasms doesn't ship every grammar we list (e.g. renamed
      // or dropped upstream) — warn and continue rather than fail the whole
      // build; that language's files just won't be graph-indexed.
      console.warn(`[copy-grammars] missing from tree-sitter-wasms: ${filename} (skipping)`);
      continue;
    }

    await copyFile(src, dest);
    copied += 1;
  }

  console.log(`[copy-grammars] copied ${copied}/${languages.length} grammars into ${DEST_DIR}`);

  if (copied === 0) {
    console.error('[copy-grammars] copied zero grammars — something is wrong, failing build');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[copy-grammars] failed:', err);
  process.exit(1);
});
