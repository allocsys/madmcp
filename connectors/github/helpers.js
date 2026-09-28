// ---------------------------------------------------------------------------
// connectors/github/helpers.js — shared helpers for GitHub connector modules
// ---------------------------------------------------------------------------

import { githubRequest, fromBase64 } from "./client.js";
import { encodeRef } from "./encode.js";

export async function getFileBlobSha(owner, repo, filePath, ref) {
  // Only look up the default branch when the caller gave no ref.
  const branch = ref || (await githubRequest(`/repos/${owner}/${repo}`)).default_branch;
  let treeSha;
  try {
    const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeRef(branch)}`);
    treeSha = refData.object.sha;
  } catch {
    treeSha = branch;
  }
  const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const entry = tree.tree.find((item) => item.path === filePath && item.type === "blob");
  if (!entry) {
    throw new Error(`File not found in tree: ${filePath}${tree.truncated ? " (repository tree was truncated by GitHub; the file may exist beyond the limit)" : ""}`);
  }
  return { blobSha: entry.sha, treeSha };
}

// Returns the file's text AND the blob sha it was read at. Writers pass that
// sha to the contents API PUT so a commit that lands between read and write
// is rejected (409) instead of being silently overwritten.
export async function readFileWithSha(owner, repo, filePath, ref) {
  const { blobSha } = await getFileBlobSha(owner, repo, filePath, ref);
  const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${blobSha}`);
  return { content: fromBase64(blob.content.replace(/\n/g, "")), blobSha };
}

export async function readFileViaBlob(owner, repo, filePath, ref) {
  const { content } = await readFileWithSha(owner, repo, filePath, ref);
  return content;
}

export const CHUNK_SIZE = 20000;
export const CHUNK_THRESHOLD = 100000;
