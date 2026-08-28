// ---------------------------------------------------------------------------
// connectors/github/editor_tool_functions.js -- plan.md step 3, "Build the
// tools layer" for delegate_editor ("Limited GitHub write access for
// delegate_agent (non-default-branch only)").
//
// Exposes read_file/write_file against the GENERAL GitHub Contents API
// (not the frontend-specific helper designer_tool_functions.js uses),
// enforcing guardrails #2 (default-branch refusal, looked up live -- never
// trust a caller's claim that a branch is "safe"), #3/#4 (allow/deny via
// editor_policy.js's isWriteAllowed, including the package.json
// scripts/dependencies content check) AT THIS LAYER, not just via prompt
// instructions -- same posture designer_delegate.js's own file header
// insists on for its narrower scope.
//
// NOT YET WIRED to any agent loop or MCP tool registration (steps 5/7).
// Unit tested independently of both, per the plan's own step ordering --
// see test/editor-tool-functions.test.js.
//
// Write function shape is modeled on the stress-tested edit_file MCP tool
// (connectors/github/files.js): two mutually-exclusive modes --
//   `content`      -- full overwrite, creates the file if it doesn't exist.
//   `replacements` -- targeted find/replace, each `find` must appear
//                     exactly once in the file or the whole call is
//                     rejected and nothing is committed. Requires the file
//                     to already exist. Returns a unified diff.
// ---------------------------------------------------------------------------

import { githubRequest, toBase64, fromBase64 } from "./client.js";
import { isWriteAllowed } from "./editor_policy.js";
import {
  EDITOR_ALLOWED_EXTENSIONS,
  EDITOR_ALLOWED_PATH_PREFIXES,
  EDITOR_DENY_PATH_PATTERNS,
} from "../../config.js";

const POLICY_OPTIONS = {
  allowedExtensions: EDITOR_ALLOWED_EXTENSIONS,
  allowedPathPrefixes: EDITOR_ALLOWED_PATH_PREFIXES,
  denyPatterns: EDITOR_DENY_PATH_PATTERNS,
};

function assertPolicyAllowed(path, extraOptions = {}) {
  const result = isWriteAllowed(path, { ...POLICY_OPTIONS, ...extraOptions });
  if (!result.allowed) {
    throw new Error(result.reason);
  }
}

function is404(err) {
  return /\(404\)/.test(err?.message || "");
}

// Detects the two shapes GitHub's Contents API uses to report a sha
// mismatch on a PUT: a plain 409, or (observed in practice, see plan.md
// step 3's writeFile note on the read-then-write race) a 422 whose message
// mentions "sha" -- e.g. when an earlier read said 404 but the file was
// created concurrently, so the blind create-without-sha PUT is rejected.
function isShaConflictError(err) {
  const msg = err?.message || "";
  const statusMatch = /\((\d+)\)/.exec(msg);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 409) return true;
  if (status === 422 && /sha/i.test(msg)) return true;
  return false;
}

function conflictError(message) {
  const err = new Error(message);
  err.conflict = true;
  return err;
}

async function rawGetContents(owner, repo, path, ref) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  return githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`);
}

function decodeContentsResponse(path, data) {
  if (Array.isArray(data)) {
    throw new Error(`${path} is a directory, not a file.`);
  }
  if (data.content === undefined) {
    throw new Error(
      `${path} has no inline content available (e.g. the file is too large) -- GitHub returned encoding "${data.encoding}".`
    );
  }
  return { content: fromBase64(data.content), sha: data.sha };
}

// Reads a file WITHOUT enforcing the allow/deny policy -- used internally by
// writeFile to fetch "before" content/sha for a path whose policy check
// hasn't happened yet (or has already failed), since guardrail #4's
// package.json content check needs the before/after comparison, and a
// blind-create race (see isShaConflictError) needs to know whether the file
// already existed regardless of policy. Tolerates a 404 (file doesn't
// exist) by returning { content: undefined, sha: undefined } instead of
// throwing; any other error propagates.
async function tryReadExistingRaw(owner, repo, path, branch) {
  try {
    const data = await rawGetContents(owner, repo, path, branch);
    return decodeContentsResponse(path, data);
  } catch (err) {
    if (is404(err)) return { content: undefined, sha: undefined };
    throw err;
  }
}

// --- read_file ---------------------------------------------------------

export async function readFile(owner, repo, path, ref) {
  assertPolicyAllowed(path);
  const data = await rawGetContents(owner, repo, path, ref);
  const { content, sha } = decodeContentsResponse(path, data);
  return { path, content, sha };
}

// --- applyReplacements --------------------------------------------------
// Synchronous, pure: applies each { find, replace } sequentially against
// `content`. Throws (and applies nothing further) if a find string is
// absent or ambiguous -- same "whole call rejected, nothing committed"
// contract as edit_file's replacements mode in files.js.

export function applyReplacements(content, replacements) {
  let updated = content;
  for (const { find, replace } of replacements) {
    const count = updated.split(find).length - 1;
    if (count === 0) {
      throw new Error(`Replacement string not found: ${JSON.stringify(find)}`);
    }
    if (count > 1) {
      throw new Error(`Replacement string found ${count} times (must be unique): ${JSON.stringify(find)}`);
    }
    updated = updated.replace(find, replace);
  }
  return updated;
}

// --- buildUnifiedDiff ----------------------------------------------------
// Same LCS-based diff algorithm as edit_file's inline diff builder in
// files.js, factored out here so it's independently testable and reusable
// by writeFile's replacements mode. Header format deliberately says
// "(before)"/"(after)" rather than reusing files.js's bare-path headers, to
// read unambiguously in a tool result that isn't itself a git diff.

export function buildUnifiedDiff(path, before, after) {
  const aLines = before.split("\n");
  const bLines = after.split("\n");
  const diffLines = [`--- ${path} (before)`, `+++ ${path} (after)`];

  const m = aLines.length;
  const n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      hunks.push({ t: "ctx", l: aLines[i] });
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      hunks.push({ t: "add", l: bLines[j] });
      j++;
    } else {
      hunks.push({ t: "del", l: aLines[i] });
      i++;
    }
  }

  const CONTEXT = 3;
  const changed = new Set(hunks.map((h, idx) => (h.t !== "ctx" ? idx : -1)).filter((x) => x >= 0));
  const shown = new Set();
  for (const idx of changed) {
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(hunks.length - 1, idx + CONTEXT); k++) {
      shown.add(k);
    }
  }

  let last = -1;
  for (const idx of [...shown].sort((a, b) => a - b)) {
    if (last !== -1 && idx > last + 1) diffLines.push("@@ ... @@");
    const h = hunks[idx];
    diffLines.push(`${h.t === "add" ? "+" : h.t === "del" ? "-" : " "}${h.l}`);
    last = idx;
  }

  if (diffLines.length === 2) diffLines.push("(no differences)");
  return diffLines.join("\n");
}

// --- assertNotDefaultBranch ---------------------------------------------
// Guardrail #2: looks up the repo's ACTUAL default branch via the GitHub
// API (never trusts a caller-supplied branch name to self-report as safe)
// and throws if it matches. Returns the repo info on success so callers
// that already need it (none yet, but future steps might) don't have to
// re-fetch it.

export async function assertNotDefaultBranch(owner, repo, branch) {
  const info = await githubRequest(`/repos/${owner}/${repo}`);
  if (branch === info.default_branch) {
    throw new Error(
      `refusing to write to ${owner}/${repo}'s default branch ("${info.default_branch}") -- ` +
      `delegate_editor guardrail #2 only allows writes to a non-default branch, regardless of any argument.`
    );
  }
  return info;
}

// --- write_file ------------------------------------------------------------

export async function writeFile(owner, repo, path, options = {}) {
  const { content, replacements, branch, baseSha, message } = options;

  if ((content === undefined) === (replacements === undefined)) {
    throw new Error("Provide exactly one of `content` (full overwrite) or `replacements` (targeted find/replace).");
  }
  if (!branch) {
    throw new Error("`branch` is required -- delegate_editor never writes to a repo's default branch (guardrail #2) or to an unspecified one.");
  }

  // Guardrail #2, checked before any content is read or written.
  await assertNotDefaultBranch(owner, repo, branch);

  // Read "before" state, tolerating a 404 (new file). This happens before
  // the policy check because guardrail #4's package.json content check
  // needs both before/after content, and a blind-create race needs to know
  // whether the file already existed regardless of the policy outcome.
  const existing = await tryReadExistingRaw(owner, repo, path, branch);
  const existingContent = existing.content;
  const existingSha = existing.sha;

  let afterContent;
  let diff = null;
  if (content !== undefined) {
    afterContent = content;
  } else {
    if (existingContent === undefined) {
      throw new Error(`${path} does not exist on branch ${branch} -- replacements mode requires an existing file. Use content mode to create it.`);
    }
    afterContent = applyReplacements(existingContent, replacements);
    diff = buildUnifiedDiff(path, existingContent, afterContent);
  }

  // Guardrails #3/#4 (allow/deny + package.json risky-fields content check).
  assertPolicyAllowed(path, { beforeContent: existingContent, afterContent });

  // Optimistic-concurrency check: a caller-supplied baseSha that doesn't
  // match what we just read means the file changed since the caller last
  // looked at it.
  if (baseSha !== undefined && baseSha !== existingSha) {
    throw conflictError(
      `write conflict: base_sha ${JSON.stringify(baseSha)} does not match ${path}'s current sha ` +
      `${existingSha === undefined ? "(file does not exist)" : JSON.stringify(existingSha)} on branch ${branch} -- ` +
      `call read_file to get the current content/sha and retry.`
    );
  }

  // No-op: the resulting content is identical to what's already there --
  // most relevant for replacements mode, but applies equally if a content-
  // mode caller happens to submit the unchanged file.
  if (existingContent !== undefined && afterContent === existingContent) {
    return { path, content: afterContent, sha: existingSha, commitSha: null, diff, created: false, noop: true };
  }

  const body = {
    message: message || `edit ${path}`,
    content: toBase64(afterContent),
    branch,
  };
  if (existingSha !== undefined) body.sha = existingSha;

  let result;
  try {
    result = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body,
    });
  } catch (err) {
    if (isShaConflictError(err)) {
      if (existingSha === undefined) {
        // We believed the file didn't exist (blind create, no sha sent),
        // but GitHub disagrees -- it was created concurrently since our
        // read above (race condition), not a stale-edit conflict.
        throw conflictError(
          `write conflict: ${path} already exists on branch ${branch} but was not found by an earlier read (race condition) -- ` +
          `call read_file to get its current content/sha, then retry (optionally with baseSha set).`
        );
      }
      throw conflictError(
        `write conflict: ${path} on branch ${branch} was modified since it was last read (sha mismatch) -- ` +
        `call read_file to get the current content/sha and retry.`
      );
    }
    throw err;
  }

  return {
    path,
    content: afterContent,
    sha: result.content.sha,
    commitSha: result.commit.sha,
    diff,
    created: existingSha === undefined,
    noop: false,
  };
}
