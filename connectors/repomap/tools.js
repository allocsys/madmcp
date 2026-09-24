// ---------------------------------------------------------------------------
// connectors/repomap/tools.js — `map`: hybrid index+query tool over the
// code graph. Formerly two tools (map.index / map.query) -- merged because
// the name similarity caused repeated mix-ups between polling a scan and
// querying the graph, and because staleness used to be silently healed in
// the background instead of being visible to the caller. Backed by the
// repo_map worker (worker/, deployed separately on Railway) -- see
// client.js for the HTTP/DB layer.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { DEFAULT_OWNER } from "../../config.js";
import { startScan, getScanStatus, getFreshness, searchChunks, queryGraph } from "./client.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderBar(done = 0, total = 0) {
  if (!total) return "";
  const pct = Math.round((done / total) * 100);
  const filled = Math.round(pct / 5);
  return `[${"■".repeat(filled)}${"□".repeat(20 - filled)}] ${pct}% (${done}/${total})`;
}

function jobLine(job) {
  if (job.status === "done") {
    return `done (${job.files_scanned ?? "?"} files scanned, ${job.files_changed ?? "?"} changed, ${job.chunks_embedded ?? "?"} chunks embedded)`;
  }
  if (job.status === "failed") return `failed -- ${job.error || "unknown error"}`;
  if (job.status === "running" && job.files_total) {
    return `running ${renderBar(job.files_done ?? 0, job.files_total)}`;
  }
  return job.status; // queued
}

// Polls a jobId to completion or until budgetMs elapses (default ~45s, kept
// under typical MCP/HTTP client timeouts). Returns the last job payload seen
// either way -- caller checks job.status to know whether it actually finished.
async function pollToBudget(jobId, budgetMs = 45000, intervalMs = 3000) {
  const deadline = Date.now() + budgetMs;
  let job = await getScanStatus(jobId);
  while (job.status !== "done" && job.status !== "failed" && Date.now() < deadline) {
    await sleep(intervalMs);
    job = await getScanStatus(jobId);
  }
  return job;
}

function formatSearchResults(results) {
  if (!results?.length) return "No results.";
  return results.map((r) =>
    `${r.filePath}${r.symbolName ? ` — ${r.qualifiedName || r.symbolName}` : ""}${r.startLine ? ` (L${r.startLine}-${r.endLine})` : ""} [dist ${r.distance?.toFixed(3)}]`
  ).join("\n");
}

function formatGraphResults(results) {
  if (!results?.length) return "No results.";
  return results.map((r) =>
    r.filePath !== undefined && r.name === undefined
      ? `${r.filePath} (depth ${r.depth})`
      : `${r.qualifiedName || r.name} — ${r.filePath}${r.startLine ? ` (L${r.startLine}-${r.endLine})` : ""} [depth ${r.depth}]`
  ).join("\n");
}

export function register(server) {
  server.tool(
    "map",
    "DOES: One-stop tool for the repo code map -- checks whether `repo` is freshly scanned, scans it if not (blocking, with a progress readout, up to ~45s per call), and optionally runs a query once fresh.\n" +
    "MODES: pass just `repo` to check/refresh status only. Add `mode: \"search\"` + `query`, or `mode: \"graph\"` + `symbol`/`file`, to also run a query against the now-fresh graph.\n" +
    "LONG SCANS: a brand-new large repo may not finish inside one call's budget -- the response includes a jobId and current progress; call `map` again with that jobId to keep polling (same args resume where they left off).\n" +
    "RULE: never loop this tool tightly to force progress -- each call already waits up to ~45s internally. Space repeat calls out.",
    {
      owner:     z.string().optional().describe(`Repository owner. Defaults to "${DEFAULT_OWNER}" if omitted.`),
      repo:      z.string().optional().describe("Repository name. Required unless jobId is given."),
      ref:       z.string().optional().describe("Branch, tag, or commit (default: repo's default branch)."),
      jobId:     z.string().optional().describe("Resume polling a scan started by a previous `map` call."),
      mode:      z.enum(["search", "graph"]).optional().describe("Run a query once the repo is fresh. Omit to only check/refresh status."),
      query:     z.string().optional().describe("search mode: natural-language description of what you're looking for."),
      topK:      z.number().optional().describe("search mode: max results to return (default 10)."),
      symbol:    z.string().optional().describe("graph mode: function/class/method name (or ClassName.methodName) to start from."),
      file:      z.string().optional().describe("graph mode: file path to start from -- required for importers/imports, or usable in place of symbol to mean \"all symbols in this file\"."),
      direction: z.enum(["callers", "callees", "importers", "imports"]).optional().describe("graph mode: which edges to walk (default: callees)."),
      depth:     z.number().optional().describe("graph mode: how many hops to walk (default 1, max 5)."),
    },
    async ({ owner = DEFAULT_OWNER, repo, ref, jobId, mode, query, topK, symbol, file, direction, depth }) => {
      try {
        // --- resuming a scan already in progress ---
        if (jobId) {
          const job = await pollToBudget(jobId);
          if (job.status !== "done") {
            return { content: [{ type: "text", text: `Job ${jobId}: ${jobLine(job)}\nStill in progress -- call map again with jobId "${jobId}" to keep polling.` }] };
          }
          const doneText = `Job ${jobId}: ${jobLine(job)}`;
          if (!mode) {
            return { content: [{ type: "text", text: `${doneText}\nRepo is now fresh -- call map again with mode/query to search or traverse it.` }] };
          }
          if (!repo) {
            return { content: [{ type: "text", text: `${doneText}\nPass repo (and owner if not "${DEFAULT_OWNER}") alongside mode/query to run the query now that it's fresh.` }] };
          }
          const results = await runQuery({ owner, repo, mode, query, topK, symbol, file, direction, depth });
          if (results.error) return results.error;
          return { content: [{ type: "text", text: `${doneText}\n\n${results.text}` }] };
        }

        if (!repo) {
          return { content: [{ type: "text", text: "repo is required when jobId is not given." }], isError: true };
        }

        // --- freshness gate ---
        const status = await getFreshness({ owner, repo, ref });

        if (status.scanned && status.fresh) {
          if (!mode) {
            return { content: [{ type: "text", text: `${owner}/${repo} is up to date (commit ${status.lastScannedCommit}). Pass mode: "search" or "graph" to query it.` }] };
          }
          const results = await runQuery({ owner, repo, mode, query, topK, symbol, file, direction, depth });
          if (results.error) return results.error;
          return { content: [{ type: "text", text: results.text }] };
        }

        // never scanned, or stale -- scan (blocking, bounded) before anything else
        const branch = status.scanned ? status.branch : ref;
        const job0 = await startScan({ owner, repo, ref: branch });
        const finalJob = await pollToBudget(job0.jobId);
        const header = status.scanned
          ? `${owner}/${repo} was stale -- rescanning.`
          : `${owner}/${repo} has never been scanned -- scanning now.`;
        const progress = `${header}\n${jobLine(finalJob)}`;

        if (finalJob.status !== "done") {
          return { content: [{ type: "text", text: `${progress}\nStill in progress -- call map again with jobId "${job0.jobId}"${mode ? ` (and the same repo/mode/${mode === "search" ? "query" : "symbol or file"} args)` : ""} to resume.` }] };
        }
        if (!mode) {
          return { content: [{ type: "text", text: progress }] };
        }

        const results = await runQuery({ owner, repo, mode, query, topK, symbol, file, direction, depth });
        if (results.error) return results.error;
        return { content: [{ type: "text", text: `${progress}\n\n${results.text}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `map: ${err.message}` }], isError: true };
      }
    }
  );
}

// Shared query execution + validation for both the "already fresh" and
// "just finished scanning" paths above. Returns { text } on success or
// { error: <tool result> } on a validation/runtime failure, so callers can
// just `if (results.error) return results.error;`.
async function runQuery({ owner, repo, mode, query, topK, symbol, file, direction, depth }) {
  if (mode === "search") {
    if (!query) return { error: { content: [{ type: "text", text: "query is required for mode \"search\"." }], isError: true } };
    const { results } = await searchChunks({ owner, repo, query, topK });
    return { text: formatSearchResults(results) };
  }

  // mode === "graph"
  if (!symbol && !file) {
    return { error: { content: [{ type: "text", text: "symbol or file is required for mode \"graph\"." }], isError: true } };
  }
  if ((direction === "importers" || direction === "imports") && !file) {
    return { error: { content: [{ type: "text", text: `file is required when direction is "${direction}" (symbol alone isn't enough -- importers/imports walk file-level edges).` }], isError: true } };
  }
  const { results } = await queryGraph({ owner, repo, symbol, file, direction, depth });
  return { text: formatGraphResults(results) };
}
