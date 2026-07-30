// ---------------------------------------------------------------------------
// connectors/gemini/delegate.js — read-only investigation loop.
//
// Lets Gemini run its OWN multi-step tool-use loop server-side (via Gemini
// function calling) to answer an open-ended question, instead of the
// calling model doing 5-10 separate manual tool round-trips. One
// delegate_agent call in, one synthesized answer out.
//
// SCOPE: every delegated function below is READ-ONLY. Gemini is never given
// a write-capable function here -- writes stay confined to the fixed
// GEMINI_NOTION_ROOT_PAGE_ID path in tools.js, same isolation rule as
// delegate_research. This file only reaches into GitHub/Cloudflare/Notion's
// existing client-layer functions (not the MCP tool layer) to avoid
// round-tripping through the MCP server for its own internal calls.
//
// IMPORTANT -- INDEPENDENT FROM THE MCP-FACING TOOL DESCRIPTIONS:
// The `description` strings on FUNCTIONS below are what GEMINI sees during
// its own tool-calling loop. They are entirely separate from the
// server.tool(...) descriptions the CALLING MODEL (e.g. Claude) sees for
// read_file/get_file_tree/list_directory/etc. in connectors/github/files.js
// (and equivalents in other connectors/*/tools.js files). Editing one set
// does NOT affect the other -- they are different objects read by different
// models for different purposes.
// Concretely: connectors/github/files.js's read_file/get_file_tree descriptions
// carry "RULE for the calling model: ... use delegate_agent instead" text
// aimed at steering Claude away from manual multi-file loops. Do NOT copy
// that kind of "use delegate_agent instead" language onto github_read_file/
// github_get_file_tree/etc. below -- Gemini calling one of these FUNCTIONS
// *is* delegate_agent already running; a self-referential "delegate to
// delegate_agent" hint here would be nonsensical and could confuse Gemini
// into stalling instead of just calling the function. Keep these
// descriptions plain and factual, matching what they actually do.
//
// STEP CAP: HARD_MAX_STEPS bounds the loop regardless of the caller's
// max_steps argument -- both to bound Gemini API cost and because a
// synchronous madmcp tool call has to fit inside the hosting platform's
// request duration limit (a real constraint on Vercel -- see the Notion
// plan page for the "known constraint" note; unresolved as of writing).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { geminiChat } from "./client.js";
import { saveCheckpoint, loadCheckpoint, deleteCheckpoint } from "./checkpoint.js";
import { isRedisConfigured } from "./cooldown.js";
import { githubRequest } from "../github/client.js";
import { readFileViaBlob } from "../github/helpers.js";
import { queryTelemetry, toEpochMillis } from "../cloudflare/observability.js";
import { cfAccountRequest } from "../cloudflare/client.js";
import { context7Request } from "../context7/client.js";
import { mem0Request } from "../mem/client.js";
import { notionRequest, notionRichTextToString, notionPageTitle, notionDatabaseTitle, notionBlocksToText } from "../notion/client.js";
import { DEFAULT_OWNER } from "../../config.js";

const HARD_MAX_STEPS = 30;

// 429 (rate limit) and 503 (overloaded/high demand) are the only cases
// documented as transient -- see client.js's own model-fallback cascade,
// which deliberately only retries a different model on a 429 for the same
// reason. Everything else (400 malformed request, 401/403 auth, 404 unknown
// model, or no err.status at all -- e.g. "GEMINI_API_KEY is not set" thrown
// locally in client.js, or "Gemini returned no candidates" from a
// safety/recitation block) is a config or request problem that will
// reproduce identically on a resume, not something retrying fixes.
function isTransientGeminiError(err) {
  return err?.status === 429 || err?.status === 503 || err?.transient === true;
}

// Minimal line-based diff (LCS backtrace) -- good enough for investigation
// summaries, not a full unified-diff implementation. Capped so a huge file
// pair can't blow up the O(n*m) table.
function simpleLineDiff(aText, bText) {
  const a = aText.split("\n");
  const b = bText.split("\n");
  if (a.length > 2000 || b.length > 2000) {
    return a.join("\n") === b.join("\n") ? "(files identical)" : "(files differ -- too large for line diff, showing lengths only: " + a.length + " vs " + b.length + " lines)";
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push(`-${a[i]}`); i++; }
    else { lines.push(`+${b[j]}`); j++; }
  }
  while (i < a.length) { lines.push(`-${a[i]}`); i++; }
  while (j < b.length) { lines.push(`+${b[j]}`); j++; }
  return lines.length ? lines.join("\n") : "(files identical)";
}

// ---------------------------------------------------------------------------
// Delegated function declarations -- Gemini's "tools" param (a subset of
// OpenAPI schema: type/properties/required, no $ref/oneOf/etc support).
// Each entry pairs the Gemini-facing declaration with a local `execute`
// that calls the real connector client function.
// ---------------------------------------------------------------------------

const FUNCTIONS = [
  {
    name: "github_read_file",
    description: "Read a file's full contents from a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: `Repository owner (default "${DEFAULT_OWNER}" if omitted)` },
        repo:  { type: "string", description: "Repository name" },
        path:  { type: "string", description: "File path within the repo" },
        ref:   { type: "string", description: "Branch, tag, or commit SHA (default: repo default branch)" },
      },
      required: ["repo", "path"],
    },
    execute: async ({ owner = DEFAULT_OWNER, repo, path, ref }) => {
      const content = await readFileViaBlob(owner, repo, path, ref);
      // Keep the loop's own context bounded -- this is server-side content
      // feeding back into Gemini's next turn, not returned to the caller.
      return content.length > 30000 ? content.slice(0, 30000) + "\n...[truncated]" : content;
    },
  },
  {
    name: "github_get_file_tree",
    description: "Recursively list all files and folders in a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo:  { type: "string", description: "Repository name" },
        ref:   { type: "string", description: "Branch, tag, or commit SHA (default: repo default branch)" },
      },
      required: ["owner", "repo"],
    },
    execute: async ({ owner, repo, ref }) => {
      let treeSha;
      if (ref) {
        try {
          const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
          treeSha = refData.object.sha;
        } catch { treeSha = ref; }
      } else {
        const repoData   = await githubRequest(`/repos/${owner}/${repo}`);
        const branchData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`);
        treeSha = branchData.object.sha;
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
      return data.tree.map((item) => `${item.type === "tree" ? "dir " : "file"} ${item.path}`).join("\n");
    },
  },
  {
    name: "github_list_commits",
    description: "List recent commits on a branch in a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        owner:    { type: "string", description: `Repository owner (default "${DEFAULT_OWNER}" if omitted)` },
        repo:     { type: "string", description: "Repository name" },
        branch:   { type: "string", description: "Branch name (default: repo default branch)" },
        per_page: { type: "number", description: "Number of commits to return (default 20, max 100)" },
      },
      required: ["repo"],
    },
    execute: async ({ owner = DEFAULT_OWNER, repo, branch, per_page = 20 }) => {
      const query = new URLSearchParams({ per_page: String(Math.min(per_page, 100)) });
      if (branch) query.set("sha", branch);
      const data = await githubRequest(`/repos/${owner}/${repo}/commits?${query}`);
      return data.map((c) => `${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]} (${c.commit.author?.name}, ${c.commit.author?.date?.slice(0, 10)})`).join("\n");
    },
  },
  {
    name: "github_search_issues",
    description: "Search issues and pull requests across GitHub using GitHub's issue-search syntax (label:, is:issue, is:open, stars:>N, org:, repo:, -repo:, -org:, no:assignee, etc., combined with spaces as AND). Useful for cross-repo discovery like good-first-issue scanning -- github_read_file/github_get_file_tree only work within a single already-known repo.",
    parameters: {
      type: "object",
      properties: {
        query:    { type: "string", description: "GitHub issue-search query string, e.g. 'label:\"good first issue\" is:open is:issue no:assignee stars:>2000 -org:someorg'" },
        sort:     { type: "string", description: "Sort field: created, updated, or comments (default: best-match relevance)" },
        order:    { type: "string", description: "Sort order: asc or desc (default: desc)" },
        per_page: { type: "number", description: "Number of results to return, max 100 (default 20)" },
      },
      required: ["query"],
    },
    execute: async ({ query, sort, order = "desc", per_page = 20 }) => {
      let path = `/search/issues?q=${encodeURIComponent(query)}&order=${order}&per_page=${Math.min(per_page, 100)}`;
      if (sort) path += `&sort=${sort}`;
      const data = await githubRequest(path);
      if (!data.items?.length) return "No results found.";
      const lines = data.items.map((item) => {
        const kind = item.pull_request ? "PR" : "Issue";
        const labels = item.labels?.length ? ` [${item.labels.map((l) => l.name).join(", ")}]` : "";
        const assignee = item.assignee ? ` (assigned: ${item.assignee.login})` : " (unassigned)";
        return `${kind} #${item.number} [${item.state}] ${item.title}${labels}${assignee} -- ${item.repository_url.replace("https://api.github.com/repos/", "")} | created ${item.created_at.slice(0, 10)} | ${item.html_url}`;
      });
      const text = `Found ${data.total_count} total result(s), showing ${data.items.length}:\n${lines.join("\n")}`;
      return text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
    },
  },
  {
    name: "cf_query_logs",
    description: "Query Cloudflare Workers Observability logs/traces/events for a time range.",
    parameters: {
      type: "object",
      properties: {
        timeframe_from: { type: "string", description: "Start of time range, ISO 8601 or epoch millis" },
        timeframe_to:   { type: "string", description: "End of time range, ISO 8601 or epoch millis" },
        script_name:    { type: "string", description: "Optional: scope to one Worker script" },
        limit:          { type: "number", description: "Max results (default ~100)" },
      },
      required: ["timeframe_from", "timeframe_to"],
    },
    execute: async ({ timeframe_from, timeframe_to, script_name, limit }) => {
      const data = await queryTelemetry({ timeframe_from, timeframe_to, script_name, limit });
      return JSON.stringify(data).slice(0, 30000);
    },
  },
  {
    name: "notion_get_page",
    description: "Read a Notion page's title and text content by page ID (read-only). Use this after notion_search finds a candidate page, to actually see what's on it -- notion_search only returns titles/ids, not content.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Notion page ID, e.g. from notion_search results" },
      },
      required: ["page_id"],
    },
    execute: async ({ page_id }) => {
      const [page, blocksData] = await Promise.all([
        notionRequest(`/pages/${page_id}`),
        notionRequest(`/blocks/${page_id}/children?page_size=100`),
      ]);
      const title   = notionPageTitle(page);
      const blocks  = blocksData.results || [];
      const content = notionBlocksToText(blocks) || "(no content)";
      const hasMore = blocksData.has_more ? "\n[note: page has more than 100 blocks, only the first 100 are shown]" : "";
      const text = `# ${title}\n${content}${hasMore}`;
      return text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
    },
  },
  {
    name: "notion_search",
    description: "Search pages and databases in the Notion workspace (read-only).",
    parameters: {
      type: "object",
      properties: {
        query:       { type: "string", description: "Search query string" },
        filter_type: { type: "string", description: "Restrict to 'page' or 'database' (optional)" },
        page_size:   { type: "number", description: "Number of results (default 10, max 100)" },
      },
      required: ["query"],
    },
    execute: async ({ query, filter_type, page_size = 10 }) => {
      const body = { query, page_size };
      if (filter_type) body.filter = { value: filter_type, property: "object" };
      const data = await notionRequest("/search", { method: "POST", body });
      if (!data.results?.length) return "No results found.";
      return data.results.map((r) => {
        const title = r.object === "page" ? notionPageTitle(r) : (notionDatabaseTitle(r) || "(untitled)");
        return `[${r.object}] ${title} — id: ${r.id}`;
      }).join("\n");
    },
  },
  {
    name: "notion_query_database",
    description: "Query rows from a Notion database (read-only), with an optional filter.",
    parameters: {
      type: "object",
      properties: {
        database_id: { type: "string", description: "Notion database ID" },
        page_size:   { type: "number", description: "Number of rows (default 20, max 100)" },
      },
      required: ["database_id"],
    },
    execute: async ({ database_id, page_size = 20 }) => {
      const data = await notionRequest(`/databases/${database_id}/query`, { method: "POST", body: { page_size } });
      if (!data.results?.length) return "No rows found.";
      return data.results.map((row) => {
        const props = Object.entries(row.properties || {}).map(([name, val]) => {
          if (val.type === "title") return `${name}: ${notionRichTextToString(val.title)}`;
          if (val.type === "rich_text") return `${name}: ${notionRichTextToString(val.rich_text)}`;
          return `${name}: ${JSON.stringify(val[val.type] ?? "")}`;
        }).join(" | ");
        return `- ${props}`;
      }).join("\n");
    },
  },

  // -- GitHub: issues / PRs --------------------------------------------
  {
    name: "github_get_issue",
    description: "Read a single GitHub issue's full body, labels, assignees, and (optionally) comments.",
    parameters: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" },
      include_comments: { type: "boolean" },
    }, required: ["repo", "issue_number"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, issue_number, include_comments = false }) => {
      const issue = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}`);
      let text = `#${issue.number} [${issue.state}] ${issue.title}\nLabels: ${(issue.labels || []).map(l => l.name).join(", ") || "none"}\nAssignees: ${(issue.assignees || []).map(a => a.login).join(", ") || "none"}\n\n${issue.body || "(no body)"}`;
      if (include_comments && issue.comments > 0) {
        const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=50`);
        text += "\n\n--- comments ---\n" + comments.map(c => `${c.user?.login}: ${c.body}`).join("\n---\n");
      }
      return text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
    },
  },
  {
    name: "github_list_pull_requests",
    description: "List pull requests in a repo, optionally filtered by state.",
    parameters: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", description: "open, closed, or all (default open)" }, per_page: { type: "number" },
    }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, state = "open", per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${Math.min(per_page, 100)}`);
      return data.map(pr => `#${pr.number} [${pr.state}${pr.draft ? " draft" : ""}] ${pr.title} (${pr.head?.ref} -> ${pr.base?.ref}) by ${pr.user?.login}`).join("\n") || "No pull requests found.";
    },
  },
  {
    name: "github_get_pull_request",
    description: "Get a single pull request's details, optionally including comments, reviews, and commits.",
    parameters: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" },
      include_comments: { type: "boolean" }, include_reviews: { type: "boolean" }, include_commits: { type: "boolean" },
    }, required: ["repo", "pull_number"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, pull_number, include_comments, include_reviews, include_commits }) => {
      const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
      let text = `#${pr.number} [${pr.state}] ${pr.title}\n${pr.head?.ref} -> ${pr.base?.ref} by ${pr.user?.login}\nMergeable: ${pr.mergeable} (${pr.mergeable_state})\n\n${pr.body || "(no body)"}`;
      if (include_comments) {
        const c = await githubRequest(`/repos/${owner}/${repo}/issues/${pull_number}/comments?per_page=50`);
        text += "\n\n--- comments ---\n" + c.map(x => `${x.user?.login}: ${x.body}`).join("\n---\n");
      }
      if (include_reviews) {
        const r = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=50`);
        text += "\n\n--- reviews ---\n" + r.map(x => `${x.user?.login}: ${x.state} -- ${x.body || "(no comment)"}`).join("\n");
      }
      if (include_commits) {
        const cm = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/commits?per_page=50`);
        text += "\n\n--- commits ---\n" + cm.map(x => `${x.sha.slice(0, 7)} ${x.commit.message.split("\n")[0]}`).join("\n");
      }
      return text.length > 25000 ? text.slice(0, 25000) + "\n...[truncated]" : text;
    },
  },
  {
    name: "github_get_pr_comments",
    description: "Get the conversation comments on a pull request.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" }, per_page: { type: "number" } }, required: ["repo", "pull_number"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, pull_number, per_page = 50 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/issues/${pull_number}/comments?per_page=${Math.min(per_page, 100)}`);
      return data.map(c => `${c.user?.login} (${c.created_at?.slice(0, 10)}): ${c.body}`).join("\n---\n") || "No comments.";
    },
  },
  {
    name: "github_get_pr_reviews",
    description: "Get the formal reviews (approve/request-changes/comment) on a pull request.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" }, per_page: { type: "number" } }, required: ["repo", "pull_number"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, pull_number, per_page = 50 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=${Math.min(per_page, 100)}`);
      return data.map(r => `${r.user?.login}: ${r.state} -- ${r.body || "(no comment)"}`).join("\n") || "No reviews.";
    },
  },
  {
    name: "github_get_pr_mergeability",
    description: "Check whether a pull request can be merged (mergeable state, conflicts). GitHub computes this async, so this retries briefly if the result isn't ready yet.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" } }, required: ["repo", "pull_number"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, pull_number }) => {
      let pr;
      for (let i = 0; i < 3; i++) {
        pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
        if (pr.mergeable !== null) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      return `mergeable: ${pr.mergeable}\nmergeable_state: ${pr.mergeable_state}\nrebaseable: ${pr.rebaseable}`;
    },
  },

  // -- GitHub: CI / checks -----------------------------------------------
  {
    name: "github_get_check_runs",
    description: "Get CI check-run results (pass/fail dots) for a commit or ref.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, ref: { type: "string" }, per_page: { type: "number" } }, required: ["repo", "ref"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, ref, per_page = 50 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=${Math.min(per_page, 100)}`);
      return `${data.total_count} check run(s):\n` + data.check_runs.map(c => `${c.name}: ${c.status}/${c.conclusion}`).join("\n");
    },
  },
  {
    name: "github_get_combined_status",
    description: "Get the combined commit status (overall pass/fail/pending rollup) for a ref.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, ref: { type: "string" } }, required: ["repo", "ref"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, ref }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/commits/${ref}/status`);
      return `Overall state: ${data.state} (${data.total_count} statuses)\n` + (data.statuses || []).map(s => `${s.context}: ${s.state} -- ${s.description || ""}`).join("\n");
    },
  },
  {
    name: "github_list_workflow_runs",
    description: "List recent GitHub Actions workflow runs for a repo, optionally scoped to one workflow.",
    parameters: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" }, workflow_id: { type: "string" }, branch: { type: "string" }, status: { type: "string" }, per_page: { type: "number" },
    }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, workflow_id, branch, status, per_page = 20 }) => {
      const qs = new URLSearchParams({ per_page: String(Math.min(per_page, 100)) });
      if (branch) qs.set("branch", branch);
      if (status) qs.set("status", status);
      const path = workflow_id ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow_id)}/runs?${qs}` : `/repos/${owner}/${repo}/actions/runs?${qs}`;
      const data = await githubRequest(path);
      return data.workflow_runs.map(r => `#${r.run_number} [${r.status}/${r.conclusion}] ${r.name} on ${r.head_branch} (${r.created_at?.slice(0, 10)}) -- run_id ${r.id}`).join("\n") || "No runs found.";
    },
  },
  {
    name: "github_get_workflow_run_logs",
    description: "Get a summary of a workflow run's jobs and steps (status/conclusion per step). For raw log text, use github_get_job_logs with a job_id from this result.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" } }, required: ["repo", "run_id"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, run_id }) => {
      const [run, jobsData] = await Promise.all([
        githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}`),
        githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`),
      ]);
      let text = `Run #${run.run_number} [${run.status}/${run.conclusion}] ${run.name} on ${run.head_branch}\n\n`;
      text += jobsData.jobs.map(j => `Job ${j.id} "${j.name}": ${j.status}/${j.conclusion}\n` + (j.steps || []).map(s => `  - ${s.name}: ${s.status}/${s.conclusion}`).join("\n")).join("\n\n");
      return text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
    },
  },
  {
    name: "github_get_job_logs",
    description: "Get raw log text for a specific workflow job (find the job_id via github_get_workflow_run_logs first, or pass job_name to look it up).",
    parameters: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" }, run_id: { type: "number" }, job_id: { type: "number" }, job_name: { type: "string" },
    }, required: ["repo", "run_id"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, run_id, job_id, job_name }) => {
      let id = job_id;
      if (!id) {
        const jobsData = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
        const match = job_name ? jobsData.jobs.find(j => j.name === job_name) : jobsData.jobs[0];
        if (!match) return `No job found${job_name ? ` matching "${job_name}"` : ""}.`;
        id = match.id;
      }
      const logs = await githubRequest(`/repos/${owner}/${repo}/actions/jobs/${id}/logs`, { accept: "application/vnd.github+json" });
      const text = typeof logs === "string" ? logs : JSON.stringify(logs);
      return text.length > 25000 ? "...[truncated, showing tail]...\n" + text.slice(-25000) : text;
    },
  },

  // -- GitHub: repo metadata / discovery ----------------------------------
  {
    name: "github_list_issues",
    description: "List issues in a repo (excludes pull requests), optionally filtered by state/labels/assignee.",
    parameters: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, labels: { type: "string" }, assignee: { type: "string" }, per_page: { type: "number" },
    }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, state = "open", labels, assignee, per_page = 20 }) => {
      const qs = new URLSearchParams({ state, per_page: String(Math.min(per_page, 100)) });
      if (labels) qs.set("labels", labels);
      if (assignee) qs.set("assignee", assignee);
      const data = await githubRequest(`/repos/${owner}/${repo}/issues?${qs}`);
      const issues = data.filter(i => !i.pull_request);
      return issues.map(i => `#${i.number} [${i.state}] ${i.title}`).join("\n") || "No issues found.";
    },
  },
  {
    name: "github_list_releases",
    description: "List releases in a repo.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, per_page: { type: "number" } }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, per_page = 10 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/releases?per_page=${Math.min(per_page, 100)}`);
      return data.map(r => `${r.tag_name}${r.name ? ` (${r.name})` : ""} -- ${r.prerelease ? "prerelease" : r.draft ? "draft" : "release"}, published ${r.published_at?.slice(0, 10) || "n/a"}`).join("\n") || "No releases found.";
    },
  },
  {
    name: "github_list_tags",
    description: "List tags in a repo.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, per_page: { type: "number" } }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/tags?per_page=${Math.min(per_page, 100)}`);
      return data.map(t => `${t.name} -- ${t.commit?.sha?.slice(0, 7)}`).join("\n") || "No tags found.";
    },
  },
  {
    name: "github_list_contributors",
    description: "List contributors to a repo with commit counts.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, per_page: { type: "number" } }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, per_page = 20 }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/contributors?per_page=${Math.min(per_page, 100)}`);
      return data.map(c => `${c.login}: ${c.contributions} commits`).join("\n") || "No contributors found.";
    },
  },
  {
    name: "github_get_repo",
    description: "Get repo metadata: description, default branch, language, stars, topics, etc.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo }) => {
      const r = await githubRequest(`/repos/${owner}/${repo}`);
      return `${r.full_name} (${r.visibility})\n${r.description || "(no description)"}\nDefault branch: ${r.default_branch} | Language: ${r.language} | Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Open issues: ${r.open_issues_count}\nTopics: ${(r.topics || []).join(", ") || "none"}\nURL: ${r.html_url}`;
    },
  },
  {
    name: "github_get_branch_protection",
    description: "Get branch protection rules for a branch (required checks, required reviews, etc.). Returns a note if the branch is unprotected or the caller lacks access.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } }, required: ["repo", "branch"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, branch }) => {
      try {
        const data = await githubRequest(`/repos/${owner}/${repo}/branches/${branch}/protection`);
        return JSON.stringify(data, null, 2).slice(0, 8000);
      } catch (err) {
        return `No accessible branch protection for "${branch}": ${err.message}`;
      }
    },
  },
  {
    name: "github_list_branches",
    description: "List branches in a repo.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/branches`);
      return data.map(b => `${b.name}${b.protected ? " (protected)" : ""}`).join("\n") || "No branches found.";
    },
  },
  {
    name: "github_get_repo_topics",
    description: "Get the topics/tags set on a repo.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo }) => {
      const data = await githubRequest(`/repos/${owner}/${repo}/topics`, { accept: "application/vnd.github.mercy-preview+json" });
      return (data.names || []).join(", ") || "No topics set.";
    },
  },
  {
    name: "github_list_directory",
    description: "List files and folders at a specific path in a repo (non-recursive; use github_get_file_tree for the full recursive tree).",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, required: ["repo"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, path = "", ref }) => {
      const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const data = await githubRequest(`/repos/${owner}/${repo}/contents/${path}${qs}`);
      const entries = Array.isArray(data) ? data : [data];
      return entries.map(e => `${e.type === "dir" ? "dir " : "file"} ${e.path}`).join("\n") || "(empty)";
    },
  },

  // -- GitHub: commits / diffs / code search ------------------------------
  {
    name: "github_get_commit",
    description: "Get a commit's message, author, and changed files.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, sha: { type: "string" } }, required: ["repo", "sha"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, sha }) => {
      const c = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
      const files = (c.files || []).map(f => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
      return `${c.sha.slice(0, 7)} by ${c.commit.author?.name} on ${c.commit.author?.date?.slice(0, 10)}\n${c.commit.message}\n\nFiles changed:\n${files || "(none)"}`;
    },
  },
  {
    name: "github_get_file_at_commit",
    description: "Read a file's contents as it existed at a specific commit SHA.",
    parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, commit: { type: "string" } }, required: ["repo", "path", "commit"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, path, commit }) => {
      const content = await readFileViaBlob(owner, repo, path, commit);
      return content.length > 30000 ? content.slice(0, 30000) + "\n...[truncated]" : content;
    },
  },
  {
    name: "github_diff_files",
    description: "Compare the same file (or two different files) between two refs/branches/commits and return a line-based diff.",
    parameters: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" }, path: { type: "string", description: "File path (used for both sides unless base_path/head_path given)" },
      base_ref: { type: "string" }, head_ref: { type: "string" }, base_path: { type: "string" }, head_path: { type: "string" },
    }, required: ["repo", "path", "base_ref", "head_ref"] },
    execute: async ({ owner = DEFAULT_OWNER, repo, path, base_ref, head_ref, base_path, head_path }) => {
      const [a, b] = await Promise.all([
        readFileViaBlob(owner, repo, base_path || path, base_ref),
        readFileViaBlob(owner, repo, head_path || path, head_ref),
      ]);
      const diff = simpleLineDiff(a, b);
      return diff.length > 20000 ? diff.slice(0, 20000) + "\n...[truncated]" : diff;
    },
  },
  {
    name: "github_search_code",
    description: "Search code across GitHub using GitHub's code-search syntax (e.g. 'foo repo:owner/name', 'extension:js useState').",
    parameters: { type: "object", properties: { query: { type: "string" }, per_page: { type: "number" } }, required: ["query"] },
    execute: async ({ query, per_page = 20 }) => {
      const data = await githubRequest(`/search/code?q=${encodeURIComponent(query)}&per_page=${Math.min(per_page, 100)}`);
      if (!data.items?.length) return "No results found.";
      const text = `Found ${data.total_count} total, showing ${data.items.length}:\n` + data.items.map(i => `${i.repository.full_name}: ${i.path}`).join("\n");
      return text.length > 15000 ? text.slice(0, 15000) + "\n...[truncated]" : text;
    },
  },

  // -- Cloudflare: Workers / D1 / KV / R2 / Hyperdrive ---------------------
  {
    name: "cf_workers_list",
    description: "List all Cloudflare Workers scripts in the account.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const data = await cfAccountRequest("/workers/scripts");
      return (data || []).map(w => `${w.id} (modified ${w.modified_on?.slice(0, 10)})`).join("\n") || "No workers found.";
    },
  },
  {
    name: "cf_workers_get_worker",
    description: "Get settings/metadata for a single Cloudflare Worker.",
    parameters: { type: "object", properties: { scriptName: { type: "string" } }, required: ["scriptName"] },
    execute: async ({ scriptName }) => JSON.stringify(await cfAccountRequest(`/workers/scripts/${scriptName}/settings`), null, 2).slice(0, 8000),
  },
  {
    name: "cf_workers_get_worker_code",
    description: "Get the source code of a Cloudflare Worker.",
    parameters: { type: "object", properties: { scriptName: { type: "string" } }, required: ["scriptName"] },
    execute: async ({ scriptName }) => {
      const data = await cfAccountRequest(`/workers/scripts/${scriptName}`);
      const text = typeof data === "string" ? data : JSON.stringify(data);
      return text.length > 30000 ? text.slice(0, 30000) + "\n...[truncated]" : text;
    },
  },
  {
    name: "cf_d1_databases_list",
    description: "List D1 databases in the account.",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    execute: async ({ name }) => {
      const qs = name ? `?name=${encodeURIComponent(name)}` : "";
      const data = await cfAccountRequest(`/d1/database${qs}`);
      return (data || []).map(d => `${d.name} -- ${d.uuid}`).join("\n") || "No databases found.";
    },
  },
  {
    name: "cf_d1_database_get",
    description: "Get details for a single D1 database.",
    parameters: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"] },
    execute: async ({ database_id }) => JSON.stringify(await cfAccountRequest(`/d1/database/${database_id}`), null, 2).slice(0, 5000),
  },
  {
    name: "cf_kv_namespaces_list",
    description: "List KV namespaces in the account.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const data = await cfAccountRequest("/storage/kv/namespaces");
      return (data || []).map(n => `${n.title} -- ${n.id}`).join("\n") || "No namespaces found.";
    },
  },
  {
    name: "cf_kv_namespace_get",
    description: "Get details for a single KV namespace.",
    parameters: { type: "object", properties: { namespace_id: { type: "string" } }, required: ["namespace_id"] },
    execute: async ({ namespace_id }) => JSON.stringify(await cfAccountRequest(`/storage/kv/namespaces/${namespace_id}`), null, 2).slice(0, 5000),
  },
  {
    name: "cf_r2_buckets_list",
    description: "List R2 buckets in the account.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const data = await cfAccountRequest("/r2/buckets");
      return (data?.buckets || data || []).map(b => `${b.name} (created ${b.creation_date?.slice(0, 10) || "n/a"})`).join("\n") || "No buckets found.";
    },
  },
  {
    name: "cf_r2_bucket_get",
    description: "Get details for a single R2 bucket.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: async ({ name }) => JSON.stringify(await cfAccountRequest(`/r2/buckets/${name}`), null, 2).slice(0, 5000),
  },
  {
    name: "cf_hyperdrive_configs_list",
    description: "List Hyperdrive configurations in the account.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const data = await cfAccountRequest("/hyperdrive/configs");
      return (data || []).map(h => `${h.name} -- ${h.id}`).join("\n") || "No Hyperdrive configs found.";
    },
  },
  {
    name: "cf_hyperdrive_config_get",
    description: "Get details for a single Hyperdrive configuration.",
    parameters: { type: "object", properties: { hyperdrive_id: { type: "string" } }, required: ["hyperdrive_id"] },
    execute: async ({ hyperdrive_id }) => JSON.stringify(await cfAccountRequest(`/hyperdrive/configs/${hyperdrive_id}`), null, 2).slice(0, 5000),
  },
  {
    name: "cf_workers_observability_keys",
    description: "List available telemetry keys (log/trace/event fields) for a time range.",
    parameters: { type: "object", properties: { timeframe_from: { type: "string" }, timeframe_to: { type: "string" }, dataset: { type: "string" } }, required: ["timeframe_from", "timeframe_to"] },
    execute: async ({ timeframe_from, timeframe_to, dataset = "cloudflare-workers" }) => {
      const data = await cfAccountRequest("/workers/observability/telemetry/keys", { method: "POST", body: { dataset, timeframe: { from: toEpochMillis(timeframe_from), to: toEpochMillis(timeframe_to) } } });
      return JSON.stringify(data).slice(0, 8000);
    },
  },
  {
    name: "cf_workers_observability_values",
    description: "List the distinct values seen for a given telemetry key over a time range.",
    parameters: { type: "object", properties: {
      key: { type: "string" }, timeframe_from: { type: "string" }, timeframe_to: { type: "string" }, dataset: { type: "string" }, valueType: { type: "string", description: "string, boolean, or number (default string)" },
    }, required: ["key", "timeframe_from", "timeframe_to"] },
    execute: async ({ key, timeframe_from, timeframe_to, dataset = "cloudflare-workers", valueType = "string" }) => {
      const data = await cfAccountRequest("/workers/observability/telemetry/values", { method: "POST", body: { datasets: [dataset], key, type: valueType, timeframe: { from: toEpochMillis(timeframe_from), to: toEpochMillis(timeframe_to) } } });
      return JSON.stringify(data).slice(0, 8000);
    },
  },

  // -- Context7 -----------------------------------------------------------
  {
    name: "context7_search_library",
    description: "Search Context7's index for a library/framework by name to get its library ID.",
    parameters: { type: "object", properties: { libraryName: { type: "string" }, query: { type: "string" } }, required: ["libraryName", "query"] },
    execute: async ({ libraryName, query }) => {
      const data = await context7Request("/libs/search", { libraryName, query });
      return (data.results || []).map(r => `${r.id} -- ${r.title} (trust ${r.trustScore})`).join("\n") || "No libraries found.";
    },
  },
  {
    name: "context7_get_library_docs",
    description: "Fetch version-specific documentation and code examples for a library by its Context7 library ID (from context7_search_library).",
    parameters: { type: "object", properties: { libraryId: { type: "string" }, query: { type: "string" }, tokens: { type: "number" } }, required: ["libraryId", "query"] },
    execute: async ({ libraryId, query, tokens }) => {
      const data = await context7Request("/context", { libraryId, query, tokens });
      const text = typeof data === "string" ? data : (data.context || data.text || JSON.stringify(data));
      return text.length > 25000 ? text.slice(0, 25000) + "\n...[truncated]" : text;
    },
  },

  // -- Mem0 -----------------------------------------------------------------
  {
    name: "mem0_search",
    description: "Search memories in the Mem0 workspace using hybrid semantic + keyword retrieval.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    execute: async ({ query, limit = 10 }) => {
      const data = await mem0Request("/v3/memories/search/", { method: "POST", body: { query, limit } });
      const results = data.results || data || [];
      return results.map(m => `[${m.score?.toFixed?.(2) ?? "?"}] ${m.memory || m.content}`).join("\n---\n") || "No memories found.";
    },
  },
  {
    name: "mem0_list",
    description: "List recent memories from the Mem0 workspace.",
    parameters: { type: "object", properties: { page_size: { type: "number" } } },
    execute: async ({ page_size = 20 }) => {
      const data = await mem0Request("/v3/memories/", { method: "POST", body: { page_size } });
      const results = data.results || data.memories || data || [];
      return results.map(m => `${m.id}: ${m.memory || m.content}`).join("\n") || "No memories found.";
    },
  },
  {
    name: "mem0_get",
    description: "Get the full content of a specific Mem0 memory by ID.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async ({ id }) => {
      const m = await mem0Request(`/v1/memories/${id}/`);
      return `${m.memory}\ncreated: ${m.created_at} | updated: ${m.updated_at}\nmetadata: ${JSON.stringify(m.metadata || {})}`;
    },
  },
  {
    name: "mem0_get_history",
    description: "Get the version/audit history of a Mem0 memory by ID.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async ({ id }) => {
      const data = await mem0Request(`/v1/memories/${id}/history/`);
      return (data || []).map(h => `${h.event} @ ${h.timestamp}: ${h.old_memory || ""} -> ${h.new_memory || ""}`).join("\n") || "No history found.";
    },
  },

  // -- Notion ---------------------------------------------------------------
  {
    name: "notion_get_database",
    description: "Get a Notion database's schema (title and property definitions) and basic info. Use this before notion_query_database to see what properties are available and their types.",
    parameters: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"] },
    execute: async ({ database_id }) => {
      const data = await notionRequest(`/databases/${database_id}`);
      const title = notionDatabaseTitle(data);
      const propLines = Object.entries(data.properties || {}).map(([name, def]) => `  ${name}: ${def.type}`);
      return `# ${title}\nID: ${data.id}\nURL: ${data.url}\nCreated: ${data.created_time?.slice(0, 10)} | Last edited: ${data.last_edited_time?.slice(0, 10)}\n\nProperties:\n${propLines.join("\n") || "(none)"}`;
    },
  },
  {
    name: "notion_list",
    description: "List recent pages and/or databases in the Notion workspace, sorted by most recently edited first -- no search query needed. Use this (not notion_search) when the task is 'find the latest X' or 'what's changed recently in Notion' -- notion_search requires a keyword and doesn't guarantee recency ordering.",
    parameters: { type: "object", properties: {
      filter_type: { type: "string", description: "Restrict to 'page' or 'database' (optional, default both)" },
      page_size:   { type: "number", description: "Number of results (default 10, max 100)" },
    } },
    execute: async ({ filter_type, page_size = 10 }) => {
      const body = { query: "", sort: { direction: "descending", timestamp: "last_edited_time" }, page_size };
      if (filter_type) body.filter = { value: filter_type, property: "object" };
      const data = await notionRequest("/search", { method: "POST", body });
      if (!data.results?.length) return "No pages or databases found.";
      return data.results.map(r => {
        const title = r.object === "page" ? notionPageTitle(r) : (notionRichTextToString(r.title) || "(untitled)");
        return `[${r.object}] ${title} — id: ${r.id} — last edited ${r.last_edited_time?.slice(0, 16)}`;
      }).join("\n");
    },
  },
  {
    name: "notion_get_page_history",
    description: "Get the changelog/version history entries recorded on a Notion page (read-only; looks for logged changelog blocks, not Notion's native edit history).",
    parameters: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
    execute: async ({ page_id }) => {
      const data = await notionRequest(`/blocks/${page_id}/children?page_size=100`);
      const text = notionBlocksToText(data.results || []) || "(no content)";
      return text.length > 10000 ? text.slice(0, 10000) + "\n...[truncated]" : text;
    },
  },
];

const FUNCTION_DECLARATIONS = [{
  functionDeclarations: FUNCTIONS.map(({ name, description, parameters }) => ({ name, description, parameters })),
}];

// SCOPE NOTE (2026-07-27): this file deliberately has NO web access (no
// web_fetch, no Google Search grounding) -- that lives entirely in
// connectors/exa/research.js, behind the separate delegate_research
// tool. Keeping the two apart is a security boundary, not just a UX split:
// this loop reads private GitHub/Notion/Cloudflare/Context7/Mem0 data, and
// research.js's Exa call reads untrusted public web content -- a single loop
// with both would let a malicious page or search result Gemini encounters
// mid-investigation try to talk the model into leaking whatever it just
// read from those private systems (e.g. via a crafted outbound fetch to an
// attacker-controlled URL). Neither loop can do that, because neither ever
// has both capabilities available at once. Do NOT re-add web_fetch or a
// google_search tool here -- add web capability to research.js instead.

const SYSTEM_PREAMBLE =
  "You are a read-only investigation agent. Use the available functions to gather whatever " +
  "information you need to answer the task fully, calling as many as necessary across multiple " +
  "turns. When you have enough information, respond with a final plain-text answer and no further " +
  "function calls. Be specific and cite what you found (file paths, commit SHAs, log entries, page " +
  "titles) rather than speculating.\n\n" +
  "IMPORTANT -- cross-check, don't just aggregate: when the task touches more than one source " +
  "(e.g. a GitHub PR's status vs. a Notion tracking page, or a repo file vs. what a database row " +
  "claims), actively look for contradictions between them rather than reporting each source's claim " +
  "in isolation. A thing that LOOKS current, open, or resolved in one source can be stale or wrong " +
  "according to another -- if your task plan touches multiple sources for related claims, check them " +
  "against each other before answering, and call out any discrepancy explicitly (including which " +
  "source you consider more authoritative and why) rather than picking one silently.\n\n" +
  "IMPORTANT -- respect scope, don't let same-named symbols bleed across files: when a question is " +
  "about whether something is used, referenced, or defined WITHIN A SPECIFIC FILE OR SCOPE (e.g. an " +
  "unused-import lint warning, which is always per-file), only evidence found in THAT exact file or " +
  "scope counts. A same-named function/variable being called somewhere else in the repo -- even in a " +
  "file that imports it from the same source module -- does NOT mean it's used in the file the question " +
  "is actually about; each file's own import/declaration is independent. Before calling a usage claim a " +
  "'false positive' or asserting something IS used, quote the exact call site (file + line/snippet) " +
  "inside the specific scope in question. If you can't produce that quote from within the scope asked " +
  "about, say plainly that no such usage was found there, rather than pointing to usage elsewhere as if " +
  "it answered the question.\n\n" +
  "IMPORTANT -- re-scan your OWN retrieved text before writing a verdict word (consistent, fixed, " +
  "resolved, stale, up-to-date, matches, etc.): a long tool-use run compresses many turns of raw " +
  "file/page content into one final summary, and that compression step is itself a separate inference " +
  "that can pattern-match toward a comfortable verdict even when the contradicting text is sitting " +
  "unused in your own transcript. If your task asks you to check whether something is stale, " +
  "inconsistent, or still-accurate, before writing the verdict go back through EVERY piece of raw " +
  "content you fetched (not just the ones that confirm your leaning) and check it against the specific " +
  "claim in the question -- do not let a majority of confirming sources outvote a single contradicting " +
  "one you already retrieved. If you find a contradiction this way, quote it and flag it explicitly " +
  "even if most of what you found points the other way.";

// Runs the investigation loop. Returns { answer, steps, transcript, runId,
// failed? } where transcript is a human-readable log of each function call
// made (for the Notion write in tools.js) and steps is how many model turns
// it took.
//
// CHECKPOINTING: after every step that completes its function calls, the
// NEW turns added this step are appended to Redis under a per-run UUID
// (see checkpoint.js's fix #5 -- append-delta, not a full-array overwrite;
// write cost is O(turns added this step), not O(conversation so far).
// stepsDone/transcript/task and fix #4's repeat-tracking state are small
// and get rewritten in full each time, which is cheap regardless of run
// length). If the NEXT geminiChat() call
// then fails (429/503/network blip -- exactly what killed a run in testing
// on 2026-07-25), the already-completed steps are not lost: the caller gets
// them back plus `runId`, and can pass `resume_run_id` on a follow-up call
// to continue the same conversation from where it left off instead of
// re-running (and re-paying for) steps 1..N again. Redis is best-effort
// (see checkpoint.js) -- if it's unavailable, resumption just isn't
// possible, same as before this existed; a failure still returns whatever
// transcript was gathered in-memory this call.
export async function runInvestigation({ task, max_steps = 20, resume_run_id }) {
  const cappedSteps = Math.min(max_steps, HARD_MAX_STEPS);

  let runId = resume_run_id;
  let contents;
  let transcript;
  let startStep;
  // The task text actually in effect for this run -- the caller-supplied
  // one on a fresh run, or the one restored from a resumed checkpoint.
  // Tracked (and persisted in every checkpoint below) so callers/tools.js
  // can log/title a resumed run without needing the caller to re-supply
  // task text the loop itself ignores on resume.
  let effectiveTask = task;
  // Stuck-loop detection (fix #4, 2026-07-27): repeatCounts tracks how many
  // times each exact (function name + JSON-stringified args) signature has
  // been called THIS RUN, persisted across resumes (see checkpoint.js) so a
  // resumed run doesn't forget what it already tried. resultCache holds the
  // actual result text per signature -- deliberately NOT persisted in the
  // checkpoint (only counts are, to keep checkpoint writes small per fix
  // #5): on a resume, an exact-repeat call that was cached in a prior
  // in-memory run simply re-executes once more and gets re-cached, which is
  // a correctness no-op (same call, same result), not worth the extra
  // checkpoint weight of persisting every cached result string.
  // consecutiveAllRepeatSteps counts how many steps IN A ROW consisted
  // ENTIRELY of repeat calls -- the real stuck-loop signal (a single repeat
  // mixed with new calls is normal exploration, not a stuck loop).
  let repeatCounts = new Map();
  let resultCache = new Map();
  let consecutiveAllRepeatSteps = 0;
  // How many entries of `contents` have already been pushed to the Redis
  // checkpoint list (fix #5) -- saveCheckpoint only ever needs the SLICE
  // added since the last checkpoint, not the whole array, so this cursor is
  // what makes that possible without checkpoint.js needing to diff arrays
  // itself.
  let contentsCheckpointedUpTo = 0;

  const checkpoint = resume_run_id ? await loadCheckpoint(resume_run_id) : null;
  if (checkpoint) {
    contents = checkpoint.contents;
    transcript = checkpoint.transcript;
    startStep = checkpoint.stepsDone + 1;
    // Every entry loadCheckpoint returned in `contents` was already RPUSHed
    // to Redis in a prior call -- nothing new to push until this run adds
    // more turns, so the cursor starts at the end of what was loaded.
    contentsCheckpointedUpTo = contents.length;
    // Maps aren't JSON-serializable, so saveCheckpoint stores repeatCounts
    // as a plain object and this reconstructs the Map on load. Checkpoints
    // saved before fix #4 existed won't have this field -- fall back to an
    // empty Map rather than erroring, same defensive pattern as
    // `checkpoint.task || task` below.
    repeatCounts = new Map(Object.entries(checkpoint.repeatCounts || {}));
    consecutiveAllRepeatSteps = checkpoint.consecutiveAllRepeatSteps || 0;
    // Prefer the checkpoint's own record of the original task -- `task` is
    // genuinely ignored on a live resume (see file header), so this is the
    // only reliable source once a run is past step 1. Checkpoints saved
    // before this field existed won't have it; fall back to whatever the
    // caller passed (may be undefined) rather than erroring.
    effectiveTask = checkpoint.task || task;
  } else if (resume_run_id && !task) {
    // A resume WAS requested but its checkpoint didn't load -- expired past
    // the 1-hour TTL, Redis unavailable (checkpoint.js is deliberately
    // fail-open, see its header), or an invalid/typo'd runId -- AND there is
    // no task to fall back on either. This must NEVER be silently treated as
    // "no resume was requested" and fall through to a fresh run: that
    // previously produced a conversation seeded with `Task: undefined` (task
    // is genuinely ignored on a live resume, so callers legitimately omit
    // it), and the model burned several steps hunting blind for context
    // instead of investigating (found via the 2026-07-26 checkpoint-miss
    // test). Fail loudly and distinctly instead, so the caller can tell
    // "your resume target is gone" apart from any other failure.
    //
    // If a task WAS provided alongside a resume_run_id that fails to load,
    // this branch is skipped and the fresh-run branch below runs instead --
    // a legitimate defensive-caller pattern (passing the task as a fallback
    // even on a resume call), kept intentionally per the fix plan.
    throw new Error(
      isRedisConfigured()
        ? `resume_run_id "${resume_run_id}" has no live checkpoint -- it may have expired (1 hour TTL) or the id may be wrong. ` +
          `There is no saved task to resume from. Start a new investigation by calling again with a task and no resume_run_id.`
        : `resume_run_id "${resume_run_id}" has no live checkpoint -- and Redis is NOT configured in this environment ` +
          `(UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN unset or unreachable), so no checkpoint could ever have been saved to resume from, ` +
          `regardless of the runId or how recently the original call failed. Retrying resume_run_id again will not help -- ` +
          `start a new investigation with a task instead, and expect that a future transient failure won't be resumable either until Redis is configured.`
    );
  } else {
    // Either no resume_run_id was given, or one was given with its checkpoint
    // missing but a `task` supplied as a fallback (see branch above) --
    // start a fresh run either way. Requires a real `task` (the caller-facing
    // tool in tools.js already guards against a missing task on a
    // non-resumable call, so `task` is trustworthy here).
    runId = randomUUID();
    contents = [{ role: "user", parts: [{ text: `${SYSTEM_PREAMBLE}\n\nTask: ${task}` }] }];
    transcript = [];
    startStep = 1;
  }

  // Resuming with a max_steps ceiling that's already been met or exceeded
  // by the checkpoint's own stepsDone (e.g. a checkpoint has 5 completed
  // steps and the caller resumes with max_steps: 2) -- there's no budget
  // left to take even one more step. Don't fall into the loop-and-fall-
  // through path below: that unconditionally deletes the checkpoint via
  // deleteCheckpoint(runId) once the loop exits, which would throw away a
  // still-good, still-resumable checkpoint for no reason (the loop body
  // simply never executes when startStep > cappedSteps), and the generic
  // step-cap message doesn't explain that anything was actually completed.
  // Leave the checkpoint alone -- it's still resumable with a higher
  // max_steps -- and say so explicitly instead.
  if (checkpoint && startStep > cappedSteps) {
    return {
      answer: `(This run already completed ${startStep - 1} step(s), which meets or exceeds the requested max_steps of ${cappedSteps} -- no new steps were taken this call. The checkpoint has NOT been discarded. Call delegate_agent again with resume_run_id: "${runId}" and a higher max_steps to continue, or treat the ${transcript.length} tool call(s) below as the result so far.)`,
      steps: startStep - 1,
      transcript,
      runId,
      task: effectiveTask,
      failed: true,
    };
  }

  for (let step = startStep; step <= cappedSteps; step++) {
    // On the final allowed step, withhold the function-calling tools
    // entirely instead of just reminding the model to wrap up: a text-only
    // reminder wasn't reliable enough on its own (found via the 2026-07-26
    // test -- the model spent its very last step on another tool call
    // anyway, and the run hit the cap with zero synthesized answer, not
    // even an incomplete one). Without `tools` in the request body, Gemini
    // structurally cannot return a functionCall part here, so this step is
    // guaranteed to be a real text-answer attempt rather than another read.
    const isFinalStep = step === cappedSteps;
    // Stuck-loop forced-answer (fix #4): once 3 consecutive steps have
    // consisted ENTIRELY of repeat calls (consecutiveAllRepeatSteps, updated
    // at the end of each step below), withhold tools the same way the final
    // step already does -- a text-only SYSTEM NOTE alone wasn't trusted to
    // reliably stop a model that keeps re-issuing the same call (same
    // lesson as isFinalStep's own history, see its comment above), so this
    // reuses that structural fix instead of a new mechanism.
    const stuckLoopForce = consecutiveAllRepeatSteps >= 3;
    const withholdTools = isFinalStep || stuckLoopForce;
    let candidate;
    try {
      candidate = await geminiChat(contents, { tools: withholdTools ? undefined : FUNCTION_DECLARATIONS });
    } catch (err) {
      // The step-1..N-1 work already happened and is real -- don't throw it
      // away. Persist it (redundant with the save at the end of the prior
      // iteration, but cheap and safe) and hand the caller everything they
      // need to resume instead of restarting. newContents is usually empty
      // here (this failure happens before this step's model turn is ever
      // pushed to `contents`) -- saveCheckpoint just re-writes the small
      // meta blob in that case, which is exactly the O(delta) behavior fix
      // #5 is for.
      await saveCheckpoint(runId, {
        newContents: contents.slice(contentsCheckpointedUpTo),
        transcript,
        stepsDone: step - 1,
        task: effectiveTask,
        repeatCounts: Object.fromEntries(repeatCounts),
        consecutiveAllRepeatSteps,
      });
      const errMessage = err?.message ?? String(err);
      const redisOk = isRedisConfigured();
      const resumeHint = isTransientGeminiError(err)
        ? (redisOk
            ? ` ${transcript.length} tool call(s) already completed this run are saved. Call delegate_agent again with resume_run_id: "${runId}" to continue from here instead of starting over. Checkpoint expires in 1 hour.`
            : ` ${transcript.length} tool call(s) were completed this run, but Redis is NOT configured in this environment, so nothing was actually saved -- resume_run_id: "${runId}" will NOT work no matter how soon you retry. ` +
              `The completed tool calls are listed in this run's transcript/Notion log (if log_to_notion was set) for manual reference, but the only way to continue is a fresh call with the full task text.`)
        : ` This does not look like a transient error (not a 429/503) -- resuming with resume_run_id: "${runId}" will likely reproduce the same failure, so check the underlying cause (e.g. GEMINI_API_KEY, request format, safety/recitation block) before retrying. The ${transcript.length} tool call(s) already completed are still saved if you want to resume anyway${redisOk ? "" : " (though note: Redis is NOT configured in this environment, so nothing was actually saved regardless)"}.`;
      return {
        answer: `(Gemini call failed on step ${step}: ${errMessage} --${resumeHint})`,
        steps: step - 1,
        transcript,
        runId,
        task: effectiveTask,
        failed: true,
      };
    }

    const parts = candidate.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (!functionCalls.length) {
      const answer = parts.map((p) => p.text || "").join("").trim();
      await deleteCheckpoint(runId);
      if (!answer) {
        // MALFORMED_FUNCTION_CALL on the final step specifically means: this
        // step had NO tools in the request (isFinalStep withholds them
        // entirely, see above), but the model tried to make a function call
        // anyway -- Gemini rejects that as malformed rather than falling
        // back to text. Observed concretely with max_steps: 1 on a task that
        // genuinely needed a file read: the model had no way to answer
        // without a tool, no tools were offered, and the result was this
        // opaque finishReason with zero explanation of why (2026-07-26
        // stress test). Surface the actual cause instead of just the raw
        // enum value, since "try a higher max_steps" is the fix and the
        // caller has no way to infer that from "MALFORMED_FUNCTION_CALL"
        // alone.
        const starvationNote = withholdTools && candidate.finishReason === "MALFORMED_FUNCTION_CALL"
          ? (isFinalStep
              ? ` This was the final allowed step, which never includes tools (so the model can only answer in plain text here) -- but the model attempted a function call anyway, which Gemini rejects as malformed when no tools are available. This almost always means the task genuinely requires at least one tool call and max_steps (${cappedSteps}) left no tool-enabled steps to make it in. Retry with a higher max_steps (at least 2, ideally the default of 6 for anything non-trivial).`
              : ` This step had no tools available because ${consecutiveAllRepeatSteps} consecutive steps consisted entirely of repeat calls (same function + arguments already tried this run) -- fix #4's stuck-loop guard forces a text-only answer the same way the final step does, but the model attempted a function call anyway, which Gemini rejects as malformed when no tools are available. The task likely needs to be narrowed or rephrased so it doesn't require repeating the same information-gathering calls.`)
          : "";
        return { answer: `(Gemini stopped without a final answer -- finishReason: ${candidate.finishReason || "unknown"})${starvationNote}`, steps: step, transcript, runId, task: effectiveTask };
      }
      return { answer, steps: step, transcript, runId, task: effectiveTask };
    }

    // Record the model's turn (including its functionCall parts) before
    // executing anything, so the conversation history stays accurate even
    // if a function call below throws.
    contents.push({ role: "model", parts });

    const responseParts = [];
    try {
      // PARALLELIZED (2026-07-26, confirmed via live show_transcript testing
      // that Gemini routinely batches several independent calls into one
      // turn -- e.g. file tree + commit list + issue list all landing in the
      // same step). These calls were previously await'd one at a time in a
      // for-loop for no real reason: within a single turn, Gemini already
      // committed to every one of these calls before seeing ANY of their
      // results, so none of them can depend on another's output -- executing
      // them concurrently changes wall-clock time only, not what information
      // is available to what call. Cross-step sequencing (the real
      // plan->act->observe->re-plan loop) is untouched: that dependency
      // chain lives between steps, not within one.
      //
      // Results are collected here and then pushed to transcript/
      // responseParts below in ORIGINAL (input) order, not completion order --
      // so the transcript and the conversation history sent back to Gemini
      // are byte-for-byte the same shape they'd be under sequential
      // execution, just produced faster. functionResponse.id (not array
      // position) is what actually threads each result back to its call on
      // Gemini's side, so reordering here would be safe even without this,
      // but keeping input order makes the transcript's own readability not
      // regress either.
      //
      // NOTE ON "BLIND" BATCHING: calls sharing a step number are, by
      // definition, decided without seeing each other's results -- that was
      // true before this change too (sequential execution didn't feed call
      // N's result to call N+1's args; Gemini had already written both calls
      // in the same turn). This just makes that pre-existing fact match the
      // wall-clock reality instead of an execution order that only
      // coincidentally looked sequential.
      //
      // RATE-LIMIT NOTE: connectors/github/client.js has its own burst-safe
      // throttle queue (scheduleThrottled) specifically built to absorb
      // concurrent GitHub calls, so parallelizing those is fully safe.
      // Notion (connectors/notion/client.js) and Mem0 (connectors/mem/
      // client.js) have no equivalent throttle/retry/backoff -- a step that
      // batches several Notion or Mem0 calls together is now more likely to
      // trip those APIs' own rate limits than under sequential execution.
      // Not a correctness risk (every call below is already individually
      // try/caught into an error string, same as before), just a new-ish
      // source of noisier per-call failures under heavier batching that's
      // worth watching for in practice rather than something this change
      // guards against.
      const results = await Promise.all(functionCalls.map(async (part) => {
        const { name, args, id } = part.functionCall;
        // Stuck-loop detection (fix #4): a signature identifies an exact
        // repeat of a call already made this run. `isRepeat` reflects
        // whether this signature has been SEEN before (checked before the
        // increment below); repeatCounts itself is incremented regardless
        // of whether it's a repeat, purely for observability/debugging --
        // only the boolean matters to the stuck-loop logic further down.
        const signature = `${name}:${JSON.stringify(args || {})}`;
        const isRepeat = repeatCounts.has(signature);
        repeatCounts.set(signature, (repeatCounts.get(signature) || 0) + 1);

        let resultText;
        let servedFromCache = false;
        if (isRepeat && resultCache.has(signature)) {
          // Exact repeat -- don't re-execute at all, just return what this
          // same call returned last time. This is the free win: no network
          // call, no wasted budget, regardless of whether the run as a
          // whole turns out to be stuck (see allRepeatsThisStep below).
          resultText = resultCache.get(signature);
          servedFromCache = true;
        } else {
          const fn = FUNCTIONS.find((f) => f.name === name);
          if (!fn) {
            resultText = `Error: unknown function "${name}".`;
          } else {
            try {
              resultText = await fn.execute(args || {});
            } catch (err) {
              resultText = `Error: ${err?.message ?? String(err)}`;
            }
          }
          // Defensive: every FUNCTIONS[].execute() is expected to return a
          // string. Guard against a future one accidentally returning
          // something else (object, undefined, etc.) so this can't throw
          // mid-transcript and take down the whole step -- see the outer
          // catch below for why that matters.
          if (typeof resultText !== "string") {
            resultText = `Error: ${name} returned a non-string result (${typeof resultText}); this is a bug in the function's execute().`;
          }
          resultCache.set(signature, resultText);
        }
        return { name, args, id, resultText, isRepeat, servedFromCache };
      }));

      for (const r of results) {
        const cacheNote = r.servedFromCache ? " [CACHED -- identical call already made this run, not re-executed]" : "";
        transcript.push(`[step ${step}] ${r.name}(${JSON.stringify(r.args || {})})${cacheNote} -> ${r.resultText.length > 300 ? r.resultText.slice(0, 300) + "…" : r.resultText}`);
        // Gemini 3 (current generateContent contract, verified 2026-07-25): function-result
        // turns go back with role "user" (NOT "function" -- that was the older doc convention
        // and is rejected by Gemini 3 models), and functionResponse.id echoes the model's
        // original functionCall.id so the API can thread multi-call turns correctly.
        responseParts.push({ functionResponse: { name: r.name, id: r.id, response: { result: r.resultText } } });
      }

      // Stuck-loop bookkeeping (fix #4): only counts as a stuck step if
      // EVERY call this step was an exact repeat -- see isRepeat's comment
      // above for why a partial repeat doesn't count.
      const allRepeatsThisStep = results.length > 0 && results.every((r) => r.isRepeat);
      consecutiveAllRepeatSteps = allRepeatsThisStep ? consecutiveAllRepeatSteps + 1 : 0;
      if (consecutiveAllRepeatSteps === 2) {
        // Earlier, softer nudge -- same two-steps-ahead pattern as the
        // step-budget reminder below, giving the model a chance to steer
        // away before the hard stop one step down.
        responseParts.push({
          text: `[SYSTEM NOTE: you're re-requesting information you already have -- the last 2 steps consisted entirely of repeat calls (same function + arguments as something already tried this run). Either try a different angle (a different file, query, or function) or answer now with what you've got.]`,
        });
      } else if (consecutiveAllRepeatSteps >= 3) {
        // Matches reality: withholdTools (computed at the top of the loop)
        // will be true next iteration because consecutiveAllRepeatSteps >= 3
        // here, so the next turn genuinely won't have tools available.
        responseParts.push({
          text: `[SYSTEM NOTE: 3 consecutive steps have consisted entirely of repeat calls. The next turn will NOT include any tools -- you must answer now in plain text with whatever you've already found, since repeating the same calls further will not surface new information.]`,
        });
      }
    } catch (err) {
      // Belt-and-suspenders: nothing inside the loop above should throw past
      // its own per-call try/catch or the typeof guard anymore, but if
      // something still does (a bug in a future function, an unexpected
      // JSON.stringify(args) failure on a circular/exotic args shape, etc.),
      // don't let it escape runInvestigation and land in tools.js's generic
      // catch, which has no runId to offer -- that would silently lose this
      // step's (and any prior steps') completed work. Checkpoint what's
      // already done (this step's model turn was already pushed to
      // `contents` above) and return the same resumable-failure shape as a
      // geminiChat failure.
      await saveCheckpoint(runId, {
        newContents: contents.slice(contentsCheckpointedUpTo),
        transcript,
        stepsDone: step - 1,
        task: effectiveTask,
        repeatCounts: Object.fromEntries(repeatCounts),
        consecutiveAllRepeatSteps,
      });
      const errMessage = err?.message ?? String(err);
      return {
        answer: `(Unexpected error while processing step ${step}'s function calls: ${errMessage} -- ${transcript.length} tool call(s) already completed this run are saved. Call delegate_agent again with resume_run_id: "${runId}" to continue from here instead of starting over. Checkpoint expires in 1 hour.)`,
        steps: step - 1,
        transcript,
        runId,
        task: effectiveTask,
        failed: true,
      };
    }
    // Step-budget reminder (added after the 2026-07-26 resume-truncation
    // bug): SYSTEM_PREAMBLE and the task's own formatting instructions only
    // ever appear once, in turn 1 -- by the last couple of steps before
    // cappedSteps, those instructions are many turns back in a long tool-use
    // history, and a model under a tight remaining budget has an incentive
    // to produce SOME answer rather than none, which can mean quietly
    // dropping the originally requested format/exhaustiveness. Surfacing the
    // remaining-step count explicitly turns a silent quality regression into
    // an honest one: the model is told to say it couldn't finish, rather
    // than presenting a rushed, incomplete answer as if it were complete.
    const remainingAfterThisStep = cappedSteps - step;
    if (remainingAfterThisStep === 2) {
      // Earlier, softer nudge -- gives the model a chance to steer toward
      // synthesis before the hard cutoff two notes down, instead of only
      // finding out at the last possible moment.
      responseParts.push({
        text: `[SYSTEM NOTE: only 2 step(s) remain after this one. Start wrapping up -- prioritize synthesizing what you've already found over opening new lines of investigation.]`,
      });
    } else if (remainingAfterThisStep <= 1) {
      // When remainingAfterThisStep is 0, the NEXT turn is the final step,
      // which is called with no tools at all (see isFinalStep above) -- so
      // this note can say so as a fact, not just a suggestion to wrap up.
      const noToolsNote = remainingAfterThisStep === 0
        ? " The next turn will NOT include any tools -- a function call is not possible; you must answer in plain text now."
        : "";
      responseParts.push({
        text: `[SYSTEM NOTE: only ${remainingAfterThisStep} step(s) remain before this investigation is forced to stop.${noToolsNote} If you cannot fully complete the task -- including any specific format requested (e.g. an exhaustive table, per-item breakdown) -- in the remaining budget, say so explicitly and describe what's missing, rather than presenting a partial or reformatted-for-brevity answer as if it were complete. Before you write your verdict, scroll back through the raw content you already fetched this run (not just your impression of it) and confirm nothing you retrieved contradicts what you're about to claim -- a contradiction sitting unused in your own transcript is a miss, not a non-finding.]`,
      });
    }

    contents.push({ role: "user", parts: responseParts });

    // Checkpoint after every fully-completed step, so a failure on the NEXT
    // Gemini call (or a hosting-platform timeout) doesn't lose this one.
    // newContents/contentsCheckpointedUpTo implement fix #5 (append-delta
    // instead of overwrite-whole-blob): only the turns added THIS step (the
    // model's turn + the function-response turn, normally 2 entries) are
    // pushed, not the whole conversation so far -- write cost is O(delta),
    // not O(total run length).
    await saveCheckpoint(runId, {
      newContents: contents.slice(contentsCheckpointedUpTo),
      transcript,
      stepsDone: step,
      task: effectiveTask,
      repeatCounts: Object.fromEntries(repeatCounts),
      consecutiveAllRepeatSteps,
    });
    contentsCheckpointedUpTo = contents.length;
  }

  await deleteCheckpoint(runId);
  return { answer: `(Investigation stopped after reaching the step cap of ${cappedSteps} without a final answer -- the task may need to be narrowed, or more steps requested up to the hard cap of ${HARD_MAX_STEPS}.)`, steps: cappedSteps, transcript, runId, task: effectiveTask };
}
