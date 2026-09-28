// ---------------------------------------------------------------------------
// connectors/github/repo_inspect.js — repo inspection tool
//
// Consolidated per plan-madmcp-github-tools-overhaul (group 3): merges
//   get_file_at_commit (was repo_mgmt.js), diff_files (was diff.js),
//   search_code (was search.js), get_branch_protection (was review_control.js),
//   list_branches / create_branch / list_commits / get_commit (was branches.js)
// into one repo_inspect tool dispatched on `action`.
//
// NOTE: search_code's implementation (fallbackCodeSearch, tarball parsing,
// GraphQL line resolution) deliberately STAYS in search.js, exported as
// runSearchCode(). search.js is imported by other modules and tests
// (agent_delegate.js, test/github-search.test.js) and still hosts
// search_issues until group 6, so the helpers were not copied or moved.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";
import { runSearchCode } from "./search.js";

// ---------------------------------------------------------------------------
// diff helpers (moved verbatim from diff.js)
// ---------------------------------------------------------------------------

// Minimal unified diff between two strings
function unifiedDiff(aText, bText, aLabel, bLabel) {
  const aLines = aText.split("\n");
  const bLines = bText.split("\n");

  const diff = [];
  diff.push(`--- ${aLabel}`);
  diff.push(`+++ ${bLabel}`);

  const m = aLines.length;
  const n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const hunks = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      hunks.push({ type: "ctx", line: aLines[i] });
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      hunks.push({ type: "add", line: bLines[j] });
      j++;
    } else {
      hunks.push({ type: "del", line: aLines[i] });
      i++;
    }
  }

  const CONTEXT = 3;
  const changed = new Set(
    hunks.map((h, idx) => (h.type !== "ctx" ? idx : -1)).filter((x) => x >= 0)
  );
  const shown = new Set();
  for (const idx of changed)
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(hunks.length - 1, idx + CONTEXT); k++)
      shown.add(k);

  let lastShown = -1;
  for (const idx of [...shown].sort((a, b) => a - b)) {
    if (lastShown !== -1 && idx > lastShown + 1) diff.push("@@ ... @@");
    const h = hunks[idx];
    diff.push(`${h.type === "add" ? "+" : h.type === "del" ? "-" : " "}${h.line}`);
    lastShown = idx;
  }

  if (diff.length === 2) diff.push("(no differences)");
  return diff.join("\n");
}

// Helper: read file via Blobs API (no 1MB limit)
async function readFileBlobForDiff(owner, repo, filePath, ref) {
  const repoInfo = await githubRequest(`/repos/${owner}/${repo}`);
  const branch = ref || repoInfo.default_branch;
  let treeSha;
  try {
    const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    treeSha = refData.object.sha;
  } catch {
    treeSha = branch;
  }
  const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const entry = tree.tree.find((item) => item.path === filePath && item.type === "blob");
  if (!entry) throw new Error(`File not found in tree: ${filePath}`);
  const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
  return fromBase64(blob.content.replace(/\n/g, ""));
}

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

export function register(server) {

  server.tool(
    "repo_inspect",
    "DOES: Inspect a GitHub repository's branches, commit history, file contents at a point in time, diffs, code search, and branch protection. Use `action` to pick. READ-ONLY except action 'create_branch'.\n" +
    "RULE: 'list_branches' needs repo. 'create_branch' needs repo + branch (the NEW branch's name) and takes optional from_branch (branch, tag, or SHA to branch from; default: repo default branch) -- it is the only mutating action here.\n" +
    "RULE: 'list_commits' needs repo; branch is optional (default branch if omitted). 'get_commit' needs repo + sha.\n" +
    "RULE: 'branch_protection' needs repo + branch (e.g. 'main'). Use it to see upfront why a PR might be gated, instead of discovering it from a rejected merge. Reading protection requires admin access on the repo.\n" +
    "RULE: 'at_commit' needs repo + path + commit, where commit MUST be a commit SHA (not a branch/tag). Equivalent concept to read_file's `ref`, which also accepts branch/tag names.\n" +
    "RULE: 'diff' needs repo plus EITHER (a) path + head_ref [+ base_ref] to compare one file across two refs, OR (b) base_path + head_path [+ ref] to compare two different files. Returns a unified diff.\n" +
    "RULE: 'search' needs query AND ref (branch, tag, or commit SHA), and query MUST contain a repo:owner/name qualifier -- the owner/repo params are IGNORED by 'search'. GitHub's real /search/code index only ever covers a repo's default branch, so every call uses the local content-search fallback directly instead (fetches the repo as a tarball at `ref` and greps it locally; also sidesteps GitHub's known private-repo search-index gap).\n" +
    "RULE: tracing something across many back-to-back searches (e.g. a symbol across a codebase) -> delegate_agent instead of chaining 'search' manually. Query is conceptual/semantic (\"where is X handled\") rather than a known literal string -> map.query (mode: search) instead.",
    {
      action:      z.enum(["at_commit", "diff", "search", "branch_protection", "list_branches", "create_branch", "list_commits", "get_commit"]).describe("Which operation to perform."),
      owner:       z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted. Ignored by 'search' (use a repo: qualifier in query).`),
      repo:        z.string().optional().describe("Repository name. Required for every action except 'search'."),
      path:        z.string().optional().describe("File path within the repo. Required for 'at_commit'. For 'diff', the file to compare across two refs (use with head_ref, optionally base_ref)."),
      commit:      z.string().optional().describe("Commit SHA to read the file from. Required for 'at_commit'."),
      sha:         z.string().optional().describe("Commit SHA. Required for 'get_commit'."),
      branch:      z.string().optional().describe("Branch name. 'create_branch': the NEW branch to create (required). 'list_commits': branch to list commits on (optional, defaults to the repo default branch). 'branch_protection': branch to read rules for (required)."),
      from_branch: z.string().optional().describe("Branch, tag, or SHA to branch from (default: repo default branch). Used by 'create_branch' only."),
      per_page:    z.number().optional().describe("Number of results to return, max 100 (default: 20). Used by 'list_commits' and 'search'."),
      base_ref:    z.string().optional().describe("Base ref (branch, tag, or SHA) for a same-file diff. Defaults to repo default branch. Used by 'diff' only."),
      head_ref:    z.string().optional().describe("Head ref to compare against base_ref. Used by 'diff' (same-file mode) only."),
      base_path:   z.string().optional().describe("Path of the base file (use with head_path for cross-file diff). Used by 'diff' only."),
      head_path:   z.string().optional().describe("Path of the head file (use with base_path for cross-file diff). Used by 'diff' only."),
      ref:         z.string().optional().describe("For 'diff' (cross-file mode): ref both files are read at (default: default branch). For 'search': branch, tag, or commit SHA to search -- REQUIRED there, and query must contain a repo:owner/name qualifier."),
      query:       z.string().optional().describe("Search query for 'search' (e.g. 'VLESS filename:worker.js repo:owner/name'). Must include a repo:owner/name qualifier."),
    },
    async ({ action, owner = DEFAULT_OWNER, repo, path, commit, sha, branch, from_branch, per_page, base_ref, head_ref, base_path, head_path, ref, query }) => {

      // ── search (repo comes from the query's repo: qualifier) ──────────────
      if (action === "search") {
        if (!query) return fail("action 'search' requires query (include a repo:owner/name qualifier).");
        if (!ref) return fail("action 'search' requires ref (branch, tag, or commit SHA). GitHub's search index only covers the default branch, so a specific ref plus a repo:owner/name qualifier in query is required for the branch-aware search.");
        return runSearchCode({ query, per_page: per_page ?? 20, ref });
      }

      if (!repo) return fail(`action '${action}' requires repo parameter.`);

      // ── list_branches ─────────────────────────────────────────────────────
      if (action === "list_branches") {
        const data  = await githubRequest(`/repos/${owner}/${repo}/branches`);
        const lines = data.map((b) => `${b.name}${b.protected ? " (protected)" : ""}`);
        return { content: [{ type: "text", text: lines.join("\n") || "(no branches)" }] };
      }

      // ── create_branch (MUTATING) ──────────────────────────────────────────
      if (action === "create_branch") {
        if (!branch) return fail("action 'create_branch' requires branch (the name of the new branch).");
        let baseSha;
        if (from_branch) {
          const baseRef = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`);
          baseSha = baseRef.object.sha;
        } else {
          const repoData = await githubRequest(`/repos/${owner}/${repo}`);
          const baseRef  = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(repoData.default_branch)}`);
          baseSha = baseRef.object.sha;
        }
        await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
          method: "POST",
          body: { ref: `refs/heads/${branch}`, sha: baseSha },
        });
        return { content: [{ type: "text", text: `Created branch '${branch}' in ${owner}/${repo} from ${baseSha.slice(0, 7)}.` }] };
      }

      // ── list_commits ──────────────────────────────────────────────────────
      if (action === "list_commits") {
        const params = new URLSearchParams({ per_page: String(per_page ?? 20) });
        // Original tool required `branch` and would have sent sha=undefined if
        // omitted; omitting sha entirely makes GitHub use the default branch.
        if (branch) params.set("sha", branch);
        const data  = await githubRequest(`/repos/${owner}/${repo}/commits?${params}`);
        const lines = data.map((c) =>
          `${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]} (${c.commit.author.name}, ${c.commit.author.date.slice(0, 10)})`
        );
        return { content: [{ type: "text", text: lines.join("\n") || "(no commits)" }] };
      }

      // ── get_commit ────────────────────────────────────────────────────────
      if (action === "get_commit") {
        if (!sha) return fail("action 'get_commit' requires sha (the commit SHA).");
        const data  = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
        const files = data.files.map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
        const text  =
          `Commit: ${data.sha.slice(0, 7)}\n` +
          `Author: ${data.commit.author.name} <${data.commit.author.email}>\n` +
          `Date:   ${data.commit.author.date}\n` +
          `Message: ${data.commit.message}\n\n` +
          `Files changed (${data.files.length}):\n${files}`;
        return { content: [{ type: "text", text }] };
      }

      // ── at_commit (was get_file_at_commit) ────────────────────────────────
      if (action === "at_commit") {
        if (!path || !commit) return fail("action 'at_commit' requires both path and commit (a commit SHA).");
        // Walk the tree at the given commit SHA
        const commitData = await githubRequest(`/repos/${owner}/${repo}/commits/${commit}`);
        const treeSha    = commitData.commit.tree.sha;
        const tree       = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
        const entry      = tree.tree.find((item) => item.path === path && item.type === "blob");
        if (!entry) {
          return fail(`File not found at commit ${commit.slice(0, 7)}: ${path}`);
        }
        const blob    = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
        const content = fromBase64(blob.content.replace(/\n/g, ""));
        const header  = `[${path} @ ${commit.slice(0, 7)} | ${commitData.commit.author.date.slice(0, 10)} | ${content.length} chars]\n\n`;
        return { content: [{ type: "text", text: header + content }] };
      }

      // ── diff (was diff_files) ─────────────────────────────────────────────
      if (action === "diff") {
        const crossFile = base_path && head_path;
        const sameFile  = path && head_ref;
        if (!crossFile && !sameFile) {
          return fail("Provide either:\n  (a) path + head_ref (and optionally base_ref) to compare a file across two refs, or\n  (b) base_path + head_path (and optionally ref) to compare two different files.");
        }

        let aLabel, bLabel, aText, bText;

        if (sameFile) {
          const resolvedBase = base_ref || (await githubRequest(`/repos/${owner}/${repo}`)).default_branch;
          [aText, bText] = await Promise.all([
            readFileBlobForDiff(owner, repo, path, resolvedBase),
            readFileBlobForDiff(owner, repo, path, head_ref),
          ]);
          aLabel = `${path} (${resolvedBase})`;
          bLabel = `${path} (${head_ref})`;
        } else {
          const resolvedRef = ref || (await githubRequest(`/repos/${owner}/${repo}`)).default_branch;
          [aText, bText] = await Promise.all([
            readFileBlobForDiff(owner, repo, base_path, resolvedRef),
            readFileBlobForDiff(owner, repo, head_path, resolvedRef),
          ]);
          aLabel = `${base_path} (${resolvedRef})`;
          bLabel = `${head_path} (${resolvedRef})`;
        }

        return { content: [{ type: "text", text: unifiedDiff(aText, bText, aLabel, bLabel) }] };
      }

      // ── branch_protection (was get_branch_protection) ─────────────────────
      // action === "branch_protection"
      if (!branch) return fail("action 'branch_protection' requires branch (e.g. 'main').");
      let data;
      try {
        data = await githubRequest(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`);
      } catch (err) {
        if (/\(404\)/.test(err.message)) {
          return { content: [{ type: "text", text: `Branch '${branch}' has no protection rules configured.` }] };
        }
        if (/\(403\)/.test(err.message)) {
          return { content: [{ type: "text", text: `Can't read branch protection for '${branch}': the token lacks permission (403). Branch protection reads require admin access on the repo, even though the rules themselves may be visible in the GitHub UI.` }] };
        }
        throw err;
      }

      const reviews = data.required_pull_request_reviews;
      const checks  = data.required_status_checks;
      const lines = [
        `Branch protection for '${branch}':`,
        `  Required approving reviews: ${reviews ? reviews.required_approving_review_count : 0}${reviews?.require_code_owner_reviews ? " (code owner review required)" : ""}`,
        `  Dismiss stale reviews on new commits: ${reviews?.dismiss_stale_reviews ? "yes" : "no"}`,
        `  Required status checks: ${checks?.contexts?.length ? checks.contexts.join(", ") : "(none)"}`,
        `  Require branches up to date before merge: ${checks?.strict ? "yes" : "no"}`,
        `  Enforce for admins: ${data.enforce_admins?.enabled ? "yes" : "no"}`,
        `  Allow force pushes: ${data.allow_force_pushes?.enabled ? "yes" : "no"}`,
        `  Allow deletions: ${data.allow_deletions?.enabled ? "yes" : "no"}`,
        `  Linear history required: ${data.required_linear_history?.enabled ? "yes" : "no"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
