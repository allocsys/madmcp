import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// Directory/file exceptions — broad by default, extend per-repo later if needed.
export const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'vendor', 'target', '.venv', 'venv', '__pycache__', '.cache',
  'coverage', '.turbo', '.parcel-cache', 'bin', 'obj',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
];

const MAX_FILE_BYTES = 500_000; // skip generated/huge files past this size

export async function walkRepo(rootDir, { excludes = DEFAULT_EXCLUDES } = {}) {
  const files = new Map(); // relative path -> content

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (excludes.includes(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const s = await stat(fullPath);
        if (s.size > MAX_FILE_BYTES) continue;
        try {
          const content = await readFile(fullPath, 'utf8');
          files.set(relative(rootDir, fullPath), content);
        } catch {
          // binary/unreadable file — skip
        }
      }
    }
  }

  await walk(rootDir);
  return files;
}
