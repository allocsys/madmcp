// ---------------------------------------------------------------------------
// connectors/repomap/tools.js — map.index (index a repo) + map.query
// (semantic search / graph traversal over an already-scanned repo).
// Formerly named repo_map_scan / repo_map -- renamed because the name
// similarity caused repeated mix-ups between polling a scan and querying
// the graph. Backed by the repo_map worker (worker/, deployed separately on
// Railway) -- see client.js for the HTTP layer.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { DEFAULT_OWNER } from "../../config.js";
import { startScan, getScanStatus, searchChunks, queryGraph } from "./client.js";

export function register(server) {

  server.tool(
    "map.index",
    "DOES: Index (or re-index) a repo into map.query's code graph + embeddings so map.query can search/traverse it -- OR, if jobId is given, poll the status of a scan already in progress.\n" +
    "RULE: call this before map.query on a repo that's never been scanned. map.query itself now checks the repo's current HEAD against the last scan on every query and fires an incremental re-scan in the background on a mismatch, so you no longer need to call this yourself just because it 'might be stale' -- the read still answers immediately from whatever's indexed and picks up the fresh data on the next call. Still call this explicitly when you want to wait for a scan to finish before querying (e.g. right after pointing map.query at a brand-new repo), or to check progress via jobId. Re-scans are incremental (only changed files are re-parsed/re-embedded), so it's cheap to call again.\n" +
    "ASYNC: scanning runs in the background on the worker. This returns a jobId immediately -- call again with that jobId to poll status ('queued' | 'running' | 'done' | 'failed'). A fresh large repo can take a while; a re-scan with few changed files is fast.\n" +
    "RULE: poll politely -- wait at least 15-20 seconds between status checks on the same jobId instead of looping immediately. The scan doesn't finish any faster from being polled more often, and tight polling loops just waste calls.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().optional().describe("Repository name. Required unless jobId is given (polling doesn't need it)."),
      ref:   z.string().optional().describe("Branch, tag, or commit to scan (default: repo's default branch)."),
      jobId: z.string().optional().describe("A jobId returned from a previous map.index call, to poll its status instead of starting a new scan."),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref, jobId }) => {
      try {
        if (jobId) {
          const job = await getScanStatus(jobId);
          const summary = job.status === "done"
            ? ` (${job.files_scanned ?? "?"} files scanned, ${job.files_changed ?? "?"} changed, ${job.chunks_embedded ?? "?"} chunks embedded)`
            : job.status === "failed" ? ` -- ${job.error || "unknown error"}`
            : job.status === "running" && job.files_total
              ? ` -- ${job.files_done ?? 0}/${job.files_total} files (${Math.round(((job.files_done ?? 0) / job.files_total) * 100)}%)`
            : "";
          return { content: [{ type: "text", text: `Job ${jobId}: ${job.status}${summary}` }] };
        }
        if (!repo) {
          return { content: [{ type: "text", text: "repo is required when jobId is not given." }], isError: true };
        }
        const job = await startScan({ owner, repo, ref });
        return { content: [{ type: "text", text: `Scan started for ${owner}/${repo}${ref ? `@${ref}` : ""}. jobId: ${job.jobId} (status: ${job.status}). Call map.index again with this jobId to check progress.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `map.index (${jobId ? "status check" : "start scan"}): ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "map.query",
    "DOES: Query an already-scanned repo's code graph -- EITHER semantic search over functions/classes (mode: \"search\") OR graph traversal of calls/imports (mode: \"graph\").\n" +
    "RULE: repo must have been indexed first via map.index, or this returns empty results, not an error.\n" +
    "search mode: finds the functions/classes most semantically relevant to a natural-language query -- good for \"where is X handled\" style questions.\n" +
    "graph mode: given a symbol name (or a file, for imports) walks callers/callees/importers/imports up to `depth` hops -- good for \"what calls this\" / \"what does this depend on\" style questions.\n" +
    "CAVEAT: right after this repo's HEAD changes, the first read here fires a background rescan (see map.index's docstring) -- a query that lands while that rescan is still writing can see a partially-updated graph (e.g. some but not all of a changed file's edges), so a thin or empty-looking result immediately after a HEAD change isn't necessarily wrong. It self-corrects: re-run the same query a bit later once the rescan has had time to finish.\n" +
    "RULE: never loop identical calls to force fresher results -- staleness self-heals (CAVEAT: a HEAD mismatch already auto-triggers a rescan). Repeating the same query doesn't speed that up. Empty/thin result = not scanned, rescan in flight, or truly absent. Wait once, then retry at most once.",
    {
      owner:     z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:      z.string().describe("Repository name (must already be scanned via map.index)."),
      mode:      z.enum(["search", "graph"]).describe("\"search\" for semantic search, \"graph\" for call/import traversal."),
      query:     z.string().optional().describe("search mode: natural-language description of what you're looking for."),
      topK:      z.number().optional().describe("search mode: max results to return (default 10)."),
      symbol:    z.string().optional().describe("graph mode: function/class/method name (or ClassName.methodName) to start from. Required for direction callers/callees, unless file is given instead. If file is also given, the name lookup is scoped to that file -- useful when the same name (e.g. a module's own `register` export) exists in multiple files and you want a specific one, not every match repo-wide."),
      file:      z.string().optional().describe("graph mode: file path (repo-relative) to start from -- required for direction importers/imports, or usable in place of symbol to mean \"all symbols in this file\". If symbol is also given, scopes that symbol's name lookup to this file rather than searching the whole repo."),
      direction: z.enum(["callers", "callees", "importers", "imports"]).optional().describe("graph mode: which edges to walk (default: callees)."),
      depth:     z.number().optional().describe("graph mode: how many hops to walk (default 1, max 5)."),
    },
    async ({ owner = DEFAULT_OWNER, repo, mode, query, topK, symbol, file, direction, depth }) => {
      try {
        if (mode === "search") {
          if (!query) return { content: [{ type: "text", text: "query is required for mode \"search\"." }], isError: true };
          const { results } = await searchChunks({ owner, repo, query, topK });
          if (!results?.length) return { content: [{ type: "text", text: `No results. Has ${owner}/${repo} been scanned yet? (map.index)` }] };
          const lines = results.map((r) =>
            `${r.filePath}${r.symbolName ? ` — ${r.qualifiedName || r.symbolName}` : ""}${r.startLine ? ` (L${r.startLine}-${r.endLine})` : ""} [dist ${r.distance?.toFixed(3)}]`
          );
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // mode === "graph"
        if (!symbol && !file) {
          return { content: [{ type: "text", text: "symbol or file is required for mode \"graph\"." }], isError: true };
        }
        if ((direction === "importers" || direction === "imports") && !file) {
          return { content: [{ type: "text", text: `file is required when direction is "${direction}" (symbol alone isn't enough -- importers/imports walk file-level edges).` }], isError: true };
        }
        const { results } = await queryGraph({ owner, repo, symbol, file, direction, depth });
        if (!results?.length) return { content: [{ type: "text", text: `No results. Has ${owner}/${repo} been scanned yet? (map.index)` }] };
        const lines = results.map((r) =>
          r.filePath !== undefined && r.name === undefined
            ? `${r.filePath} (depth ${r.depth})`
            : `${r.qualifiedName || r.name} — ${r.filePath}${r.startLine ? ` (L${r.startLine}-${r.endLine})` : ""} [depth ${r.depth}]`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `map.query (mode: ${mode}): ${err.message}` }], isError: true };
      }
    }
  );
}
