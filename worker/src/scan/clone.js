import { simpleGit } from 'simple-git';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shallow-clones a repo into a temp dir using a short-lived clone token
// (see allocsys/madmcp connectors/github/clone_token.js — madmcp mints this
// per-request via get_repo_clone_token and passes it in the /scan body).
export async function cloneRepo({ owner, repo, ref, cloneToken }) {
  const dir = await mkdtemp(join(tmpdir(), 'repo-map-'));
  const url = cloneToken
    ? `https://x-access-token:${cloneToken}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`; // public repo fallback

  const git = simpleGit();
  await git.clone(url, dir, ['--depth', '1', ...(ref ? ['--branch', ref] : [])]);

  const cloned = simpleGit(dir);
  const log = await cloned.log({ maxCount: 1 });
  const commit = log.latest?.hash;

  return { dir, commit, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
