// ---------------------------------------------------------------------------
// connectors/github/search.js — search tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest, fromBase64 } from "./client.js";

// --- search_code fallback ---------------------------------------------------
// GitHub's REST /search/code endpoint reliably indexes public repos, but has
// a long-documented gap for private repos: it returns an empty, 200-OK
// result set even when the token has full read access to the repo's
// contents (see e.g. github.com/orgs/community/discussions/113651). This
// isn't a permissions or config issue on our end -- the same token's
// contents/tree/blob endpoints (used elsewhere in this connector) work fine
// against the same repos. There's no request header or query tweak that
// fixes it; the only real workaround is to not depend on GitHub's search
// index for private repos at all.
//
// So: when a query scopes to a single repo via `repo:owner/name` and the
// real search API comes back empty, fall back to walking that repo's git
// tree and grepping file contents directly through the blobs API instead.
const FALLBACK_MAX_FILES = 500;    // cap how many blobs we'll fetch and scan
const FALLBACK_MAX_BYTES = 400000; // skip files bigger than this (~400KB)
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "tiff",
  "pdf", "zip", "tar", "gz", "bz2", "7z", "rar",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "mov", "avi", "webm", "ogg", "wav",
  "exe", "dll", "so", "dylib", "class", "jar", "wasm",
  "sqlite", "db", "bin", "pyc", "lock",
]);

function extractRepoQualifier(query) {
  const m = query.match(/(?:^|\s)repo:([^/\s]+)\/([^\s]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Strips `qualifier:value` tokens (repo:, filename:, extension:, language:,
// etc. -- and their `-qualifier:` negated forms) out of a search query,
// leaving just the free-text search term(s) a plain grep can use.
function stripQualifiers(query) {
  return query.replace(/(^|\s)-?[a-zA-Z]+:\S+/g, " ").replace(/\s+/g, " ").trim();
}

async function fallbackCodeSearch({ owner, repo, query, per_page }) {
  const searchTerm = stripQualifiers(query);
  if (!searchTerm) return null; // qualifier-only query -- nothing to grep for

  const repoInfo    = await githubRequest(`/repos/${owner}/${repo}`);
  const branchData  = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${repoInfo.default_branch}`);
  const tree        = await githubRequest(`/repos/${owner}/${repo}/git/trees/${branchData.object.sha}?recursive=1`);

  const allBlobs = tree.tree.filter((item) => item.type === "blob");
  const candidates = allBlobs
    .filter((item) => {
      if (item.size > FALLBACK_MAX_BYTES) return false;
      const ext = item.path.includes(".") ? item.path.split(".").pop().toLowerCase() : "";
      return !BINARY_EXTENSIONS.has(ext);
    })
    .slice(0, FALLBACK_MAX_FILES);

  const needle  = searchTerm.toLowerCase();
  const matches = [];
  for (const entry of candidates) {
    if (matches.length >= per_page) break;
    let blob;
    try {
      blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
    } catch { continue; }
    if (blob.encoding !== "base64") continue;
    let text;
    try { text = fromBase64(blob.content.replace(/\n/g, "")); } catch { continue; }
    // Skip anything that doesn't decode to plausible text (binary sneaking
    // in without a recognized extension).
    if (text.includes("\u0000")) continue;
    const lines   = text.split("\n");
    const lineIdx = lines.findIndex((l) => l.toLowerCase().includes(needle));
    if (lineIdx !== -1) {
      matches.push({ path: entry.path, line: lineIdx + 1, snippet: lines[lineIdx].trim().slice(0, 200) });
    }
  }

  return {
    matches,
    scanned: candidates.length,
    truncated: candidates.length < allBlobs.length || tree.truncated === true,
  };
}

export function register(server) {
  server.tool(
    "search_issues",
    "Search issues and pull requests across GitHub using GitHub's issue-search syntax (e.g. 'label:bounty is:issue is:open stars:>100 -repo:owner/name -org:someorg'). Returns issue/PR title, repo, state, labels, assignee, created date, and URL for each result — useful for cross-repo discovery like bounty hunting or good-first-issue scanning, which list_issues (single-repo) can't do.",
    {
      query:    z.string().describe("GitHub issue-search query string using standard qualifiers: label:, is:issue, is:pr, is:open, is:closed, stars:>N, org:, repo:, -repo: (exclude), -org: (exclude), created:, assignee:, no:assignee, etc. Combine with spaces (AND). e.g. 'label:bounty is:issue is:open stars:>100 -org:mergeos-bounties'"),
      sort:     z.enum(["created", "updated", "comments"]).optional().describe("Sort field (default: best-match relevance if omitted)"),
      order:    z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 20)"),
    },
    async ({ query, sort, order = "desc", per_page = 20 }) => {
      let path = `/search/issues?q=${encodeURIComponent(query)}&order=${order}&per_page=${per_page}`;
      if (sort) path += `&sort=${sort}`;
      const data = await githubRequest(path);
      if (!data.items?.length) return { content: [{ type: "text", text: "No results found." }] };
      const lines = data.items.map((item) => {
        const kind = item.pull_request ? "PR" : "Issue";
        const labels = item.labels?.length ? ` [${item.labels.map((l) => l.name).join(", ")}]` : "";
        const assignee = item.assignee ? ` (assigned: ${item.assignee.login})` : " (unassigned)";
        return `${kind} #${item.number} [${item.state}] ${item.title}${labels}${assignee}\n  ${item.repository_url.replace("https://api.github.com/repos/", "")} | created ${item.created_at.slice(0, 10)} | ${item.html_url}`;
      });
      return { content: [{ type: "text", text: `Found ${data.total_count} total result(s) (GitHub search caps at 1000), showing ${data.items.length}:\n\n${lines.join("\n\n")}` }] };
    }
  );

  server.tool(
    "search_code",
    "Search for code across GitHub repositories. For a query scoped to one repo via `repo:owner/name`, automatically falls back to a direct tree/blob grep of that repo if GitHub's search index returns nothing — GitHub's code-search API has a known gap where it can return empty results for private repos regardless of token permissions.",
    {
      query:    z.string().describe("Search query (e.g. 'VLESS filename:worker.js user:dumbCodesOnly')"),
      per_page: z.number().optional().describe("Number of results to return, max 100 (default: 10)"),
    },
    async ({ query, per_page = 10 }) => {
      const data = await githubRequest(`/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`);
      if (data.items?.length) {
        const lines = data.items.map((item) => `📄 ${item.repository.full_name}/${item.path} (${item.html_url})`);
        return { content: [{ type: "text", text: `Found ${data.total_count} result(s), showing ${data.items.length}:\n\n${lines.join("\n")}` }] };
      }

      const scoped = extractRepoQualifier(query);
      if (scoped) {
        const fb = await fallbackCodeSearch({ ...scoped, query, per_page }).catch(() => null);
        if (fb?.matches.length) {
          const lines = fb.matches.map((m) => `📄 ${scoped.owner}/${scoped.repo}/${m.path}:${m.line}\n  ${m.snippet}`);
          return {
            content: [{
              type: "text",
              text: `GitHub's code-search index returned nothing for this repo (a known gap for private repos), ` +
                `so this used a direct content search instead (scanned ${fb.scanned} file(s)` +
                `${fb.truncated ? ", capped — repo has more than this covers" : ""}):\n\n${lines.join("\n\n")}`,
            }],
          };
        }
        if (fb) {
          return {
            content: [{
              type: "text",
              text: `No results found. Also tried a direct content search of ${scoped.owner}/${scoped.repo} ` +
                `(GitHub's search index can return empty for private repos regardless of permissions) — ` +
                `scanned ${fb.scanned} file(s)${fb.truncated ? " (capped, repo has more)" : ""}, no match.`,
            }],
          };
        }
      }

      return { content: [{ type: "text", text: "No results found." }] };
    }
  );
}
