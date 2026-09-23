// ---------------------------------------------------------------------------
// connectors/repomap/tools.js — repo_map_scan (index a repo) + repo_map
// (semantic search / graph traversal over an already-scanned repo).
// Backed by the repo_map worker (worker/, deployed separately on Railway) --
// see client.js for the HTTP layer.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { DEFAULT_OWNER } from "../../config.js";
import { startScan, getScanStatus, searchChunks, queryGraph } from "./client.js";

export function register(server) {

  server.tool(
    "repo_map_scan",
    "DOES: Index (or re-index) a repo into repo_map's code graph + embeddings so repo_map can search/traverse it -- OR, if jobId is given, poll the status of a scan already in progress.\n" +
    "RULE: call this before repo_map on a repo that's never been scanned. repo_map itself now checks the repo's current HEAD against the last scan on every query and fires an incremental re-scan in the background on a mismatch, so you no longer need to call this yourself just because it 'might be stale' -- the read still answers immediately from whatever's indexed and picks up the fresh data on the next call. Still call this explicitly when you want to wait for a scan to finish before querying (e.g. right after pointing repo_map at a brand-new repo), or to check progress via jobId. Re-scans are incremental (only changed files are re-parsed/re-embedded), so it's cheap to call again.\n" +
    "ASYNC: scanning runs in the background on the worker. This returns a jobId immediately -- call again with that jobId to poll status ('queued' | 'running' | 'done' | 'failed'). A fresh large repo can take a while; a re-scan with few changed files is fast.",
    {
      owner: z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:  z.string().optional().describe("Repository name. Required unless jobId is given (polling doesn't need it)."),
      ref:   z.string().optional().describe("Branch, tag, or commit to scan (default: repo's default branch)."),
      jobId: z.string().optional().describe("A jobId returned from a previous repo_map_scan call, to poll its status instead of starting a new scan."),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref, jobId }) => {
      try {
        if (jobId) {
          const job = await getScanStatus(jobId);
          const summary = job.status === "done"
            ? ` (${job.files_scanned ?? "?"} files scanned, ${job.files_changed ?? "?"} changed, ${job.chunks_embedded ?? "?"} chunks embedded)`
            : job.status === "failed" ? ` -- ${job.error || "unknown error"}` : "";
          return { content: [{ type: "text", text: `Job ${jobId}: ${job.status}${summary}` }] };
        }
        if (!repo) {
          return { content: [{ type: "text", text: "repo is required when jobId is not given." }], isError: true };
        }
        const job = await startScan({ owner, repo, ref });
        return { content: [{ type: "text", text: `Scan started for ${owner}/${repo}${ref ? `@${ref}` : ""}. jobId: ${job.jobId} (status: ${job.status}). Call repo_map_scan again with this jobId to check progress.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    }
  );

  server.tool(
    "repo_map",
    "DOES: Query an already-scanned repo's code graph -- EITHER semantic search over functions/classes (mode: \"search\") OR graph traversal of calls/imports (mode: \"graph\").\n" +
    "RULE: repo must have been indexed first via repo_map_scan, or this returns empty results, not an error.\n" +
    "search mode: finds the functions/classes most semantically relevant to a natural-language query -- good for \"where is X handled\" style questions.\n" +
    "graph mode: given a symbol name (or a file, for imports) walks callers/callees/importers/imports up to `depth` hops -- good for \"what calls this\" / \"what does this depend on\" style questions.",
    {
      owner:     z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:      z.string().describe("Repository name (must already be scanned via repo_map_scan)."),
      mode:      z.enum(["search", "graph"]).describe("\"search\" for semantic search, \"graph\" for call/import traversal."),
      query:     z.string().optional().describe("search mode: natural-language description of what you're looking for."),
      topK:      z.number().optional().describe("search mode: max results to return (default 10)."),
      symbol:    z.string().optional().describe("graph mode: function/class/method name (or ClassName.methodName) to start from. Required for direction callers/callees, unless file is given instead."),
      file:      z.string().optional().describe("graph mode: file path (repo-relative) to start from -- required for direction importers/imports, or usable in place of symbol to mean \"all symbols in this file\"."),
      direction: z.enum(["callers", "callees", "importers", "imports"]).optional().describe("graph mode: which edges to walk (default: callees)."),
      depth:     z.number().optional().describe("graph mode: how many hops to walk (default 1, max 5)."),
    },
    async ({ owner = DEFAULT_OWNER, repo, mode, query, topK, symbol, file, direction, depth }) => {
      try {
        if (mode === "search") {
          if (!query) return { content: [{ type: "text", text: "query is required for mode \"search\"." }], isError: true };
          const { results } = await searchChunks({ owner, repo, query, topK });
          if (!results?.length) return { content: [{ type: "text", text: `No results. Has ${owner}/${repo} been scanned yet? (repo_map_scan)` }] };
          const lines = results.map((r) =>
            `${r.filePath}${r.symbolName ? ` — ${r.qualifiedName || r.symbolName}` : ""}${r.startLine ? ` (L${r.startLine}-${r.endLine})` : ""} [dist ${r.distance?.toFixed(3)}]`
          );
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // mode === "graph"
        if (!symbol && !file) {
          return { content: [{ type: "text", text: "symbol or file is required for mode \"graph\"." }], isError: true };
        }
        const { results } = await queryGraph({ owner, repo, symbol, file, direction, depth });
        if (!results?.length) return { content: [{ type: "text", text: `No results. Has ${owner}/${repo} been scanned yet? (repo_map_scan)` }] };
        const lines = results.map((r) =>
          r.filePath !== undefined && r.name === undefined
            ? `${r.filePath} (depth ${r.depth})`
            : `${r.qualifiedName || r.name} — ${r.filePath}${r.startLine ? ` (L${r.startLine}-${r.endLine})` : ""} [depth ${r.depth}]`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
    }
  );
}
