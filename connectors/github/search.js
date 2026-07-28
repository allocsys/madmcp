// ---------------------------------------------------------------------------
// connectors/github/search.js — search tools
// ---------------------------------------------------------------------------

import { z } from "zod";
import zlib from "node:zlib";
import { githubRequest, githubFetchTarball } from "./client.js";

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
// real search API comes back empty, fall back to a direct content search of
// that repo instead.
//
// 2026-07-28 fix: this fallback used to walk the repo's git tree and fetch
// each eligible file individually via the Blobs API, one file per throttled
// request (up to FALLBACK_MAX_FILES of them) -- for a 500-file scan, that's
// roughly 500 * GITHUB_MIN_REQUEST_INTERVAL_MS of pure enforced pacing alone
// (~150s), on top of per-request round-trip time. It now fetches the whole
// repo ONCE as a tarball (githubFetchTarball, client.js) and greps the
// decompressed contents locally instead -- one network request instead of
// hundreds, with the repo@sha result cached in-process so a follow-up search
// against an unchanged branch head doesn't refetch anything.
const FALLBACK_MAX_BYTES = 400000; // skip individual files bigger than this (~400KB) when grepping
// Safety cap on how many eligible files the local grep loop will walk. Since
// files are already decompressed in memory by this point, this exists only
// to bound worst-case CPU time on a pathologically large monorepo -- not to
// limit network cost the way it used to.
const FALLBACK_MAX_FILES = 20000;
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "tiff",
  "pdf", "zip", "tar", "gz", "bz2", "7z", "rar",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "mov", "avi", "webm", "ogg", "wav",
  "exe", "dll", "so", "dylib", "class", "jar", "wasm",
  "sqlite", "db", "bin", "pyc", "lock",
]);

// In-process cache of parsed tarball entries, keyed by `owner/repo@sha`
// (sha makes the key immutable, so no TTL/invalidation is needed -- a new
// commit just gets a new key). Capped at a small number of repos since
// each entry holds full decompressed file contents in memory.
const TARBALL_CACHE_MAX_REPOS = 5;
const tarballCache = new Map();

function cacheEntries(key, entries) {
  tarballCache.set(key, entries);
  if (tarballCache.size > TARBALL_CACHE_MAX_REPOS) {
    tarballCache.delete(tarballCache.keys().next().value); // evict oldest
  }
}

export function extractRepoQualifier(query) {
  const m = query.match(/(?:^|\s)repo:([^/\s]+)\/([^\s]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Strips `qualifier:value` tokens (repo:, filename:, extension:, language:,
// etc. -- and their `-qualifier:` negated forms) out of a search query,
// leaving just the free-text search term(s) a plain grep can use.
export function stripQualifiers(query) {
  return query.replace(/(^|\s)-?[a-zA-Z]+:\S+/g, " ").replace(/\s+/g, " ").trim();
}

function parseOctal(buf) {
  const str = buf.toString("ascii").replace(/\0.*$/, "").trim();
  if (!str) return 0;
  const n = parseInt(str, 8);
  return Number.isNaN(n) ? 0 : n;
}

// Parses a PAX extended-header block's content into its key/value fields.
// Format is a sequence of `"<len> key=value\n"` records, where <len> is the
// decimal byte length of the WHOLE record (including itself and the
// trailing newline). Used for filenames longer than tar's classic 100-byte
// field, which show up in some repos (deeply nested paths, long generated
// filenames, etc).
export function parsePaxHeader(text) {
  const fields = {};
  let offset = 0;
  while (offset < text.length) {
    const spaceIdx = text.indexOf(" ", offset);
    if (spaceIdx === -1) break;
    const len = parseInt(text.slice(offset, spaceIdx), 10);
    if (!len || Number.isNaN(len) || len <= 0) break;
    const record = text.slice(offset, offset + len);
    const firstSpace = record.indexOf(" ");
    const kv = record.slice(firstSpace + 1).replace(/\n$/, "");
    const eq = kv.indexOf("=");
    if (eq !== -1) fields[kv.slice(0, eq)] = kv.slice(eq + 1);
    offset += len;
  }
  return fields;
}

// Minimal USTAR/PAX/GNU tar parser -- just enough to extract regular file
// entries with their name and content from GitHub's tarball archives.
// Deliberately hand-rolled rather than a dependency: it's a small, stable
// format, and this repo can't rely on `npm install` picking up new packages
// in every environment it runs in.
export function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  let pendingLongName = null; // set by a preceding PAX ('x') or GNU ('L') header

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const nameRaw = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "");
    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156]);
    const prefixRaw = header.subarray(345, 500).toString("utf-8").replace(/\0.*$/, "");
    offset += 512;

    const content = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512; // advance past the padded data blocks

    if (typeFlag === "x" || typeFlag === "X") {
      const fields = parsePaxHeader(content.toString("utf-8"));
      if (fields.path) pendingLongName = fields.path;
      continue; // applies to the next entry, not a file itself
    }
    if (typeFlag === "L") {
      pendingLongName = content.toString("utf-8").replace(/\0.*$/, "");
      continue; // GNU long-name header, also applies to the next entry
    }
    if (typeFlag === "g") continue; // global PAX header, not needed here

    const name = pendingLongName || (prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw);
    pendingLongName = null;

    if (typeFlag === "0" || typeFlag === "\u0000") {
      // Regular file -- directories ('5'), symlinks ('2'), etc. are skipped.
      entries.push({ name, size, content });
    }
  }

  return entries;
}

// Fetches (or returns from cache) every regular file in a repo's default
// branch as { name, size, content } entries, with GitHub's single wrapping
// top-level directory (`<owner>-<repo>-<sha7>/...`) stripped off each name.
async function getRepoEntries(owner, repo) {
  const repoInfo = await githubRequest(`/repos/${owner}/${repo}`);
  const branchData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${repoInfo.default_branch}`);
  const sha = branchData.object.sha;
  const cacheKey = `${owner}/${repo}@${sha}`;

  const cached = tarballCache.get(cacheKey);
  if (cached) return cached;

  const gzipped = await githubFetchTarball(owner, repo, sha);
  const tarBuffer = zlib.gunzipSync(gzipped);
  const rawEntries = parseTar(tarBuffer);
  const entries = rawEntries.map((e) => ({ ...e, name: e.name.replace(/^[^/]+\//, "") }));

  cacheEntries(cacheKey, entries);
  return entries;
}

async function fallbackCodeSearch({ owner, repo, query, per_page }) {
  const searchTerm = stripQualifiers(query);
  if (!searchTerm) return null; // qualifier-only query -- nothing to grep for

  const entries = await getRepoEntries(owner, repo);

  const eligible = entries.filter((item) => {
    if (item.size > FALLBACK_MAX_BYTES) return false;
    const ext = item.name.includes(".") ? item.name.split(".").pop().toLowerCase() : "";
    return !BINARY_EXTENSIONS.has(ext);
  });
  const candidates = eligible.slice(0, FALLBACK_MAX_FILES);

  const needle = searchTerm.toLowerCase();
  const matches = [];
  for (const entry of candidates) {
    if (matches.length >= per_page) break;
    let text;
    try { text = entry.content.toString("utf-8"); } catch { continue; }
    // Skip anything that doesn't decode to plausible text (binary sneaking
    // in without a recognized extension).
    if (text.includes("\u0000")) continue;
    const lines = text.split("\n");
    const lineIdx = lines.findIndex((l) => l.toLowerCase().includes(needle));
    if (lineIdx !== -1) {
      matches.push({ path: entry.name, line: lineIdx + 1, snippet: lines[lineIdx].trim().slice(0, 200) });
    }
  }

  return {
    matches,
    scanned: candidates.length,
    truncated: eligible.length > FALLBACK_MAX_FILES,
  };
}

export function register(server) {
  server.tool(
    "search_issues",
    "DOES: Search issues/PRs cross-repo via GitHub issue-search syntax (label:, is:issue, is:pr, stars:>N, org:, -repo:, etc). Returns title, repo, state, labels, assignee, date, URL per result.\n" +
    "RULE: cross-repo discovery (bounty hunting, good-first-issue scanning) -> this tool. Single known repo -> list_issues instead.\n" +
    "RULE: broader open-ended hunt (many searches -> read candidates -> narrow down) -> delegate_gemini instead of chaining this manually.",
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
    "DOES: Search code across GitHub repos.\n" +
    "RULE: query scoped via repo:owner/name AND index returns nothing -> auto-falls back to a direct content search of that repo (handles GitHub's known private-repo search-index gap; fetches the repo as a tarball and greps it locally -- see fallbackCodeSearch).\n" +
    "RULE: tracing something across many back-to-back searches (e.g. a symbol across a codebase) -> delegate_gemini instead of chaining this manually.",
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
