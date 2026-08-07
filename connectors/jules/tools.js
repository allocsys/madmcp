// ---------------------------------------------------------------------------
// connectors/jules/tools.js — delegate autonomous coding tasks to Jules
// (Google's async coding agent), fire-and-forget style: create a session
// against a connected GitHub repo, walk away, poll for status/output later.
//
// Distinct from delegate_agent/delegate_designer in this repo: those are
// synchronous, read-only (or frontend-fenced) loops that return one answer
// within a single tool call. A Jules session is asynchronous and can WRITE
// arbitrary code across a whole repo over several minutes in its own
// sandboxed VM, independent of this server's request lifecycle — you create
// it, then check back with jules_get_session / jules_get_activities.
//
// Deliberately NOT including plan-approval tooling (approvePlan/sendMessage)
// for this first pass — fire-and-forget implies automationMode:
// AUTO_CREATE_PR with plans auto-approved (the API's default), not a
// supervised back-and-forth. Add jules_approve_plan / jules_send_message
// later if a gated workflow is ever needed.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { julesRequest } from "./client.js";

export function register(server) {

  server.tool(
    "jules_list_sources",
    "DOES: List the GitHub repositories connected to your Jules account (sources), each with its resource name (e.g. 'sources/github-owner-repo') needed for jules_create_session.\n" +
    "RULE: call this first if you don't already know the exact source name for the repo you want to target.",
    {
      page_size: z.number().optional().describe("Max sources to return per page (default: server default)"),
      page_token: z.string().optional().describe("Pagination token from a previous call's response, to fetch the next page"),
    },
    async ({ page_size, page_token }) => {
      const data = await julesRequest("/sources", { params: { pageSize: page_size, pageToken: page_token } });
      const sources = data?.sources || [];
      if (!sources.length) {
        return { content: [{ type: "text", text: "No sources connected to this Jules account." }] };
      }
      const lines = sources.map((s) => {
        const repo = s.githubRepo;
        const repoDesc = repo ? `${repo.owner}/${repo.repo}${repo.isPrivate ? " (private)" : ""}${repo.defaultBranch?.displayName ? `, default branch: ${repo.defaultBranch.displayName}` : ""}` : "(non-GitHub source)";
        return `${s.name} — ${repoDesc}`;
      });
      const more = data?.nextPageToken ? `\n\n(more available — next page_token: ${data.nextPageToken})` : "";
      return { content: [{ type: "text", text: lines.join("\n") + more }] };
    }
  );

  server.tool(
    "jules_create_session",
    "DOES: Create a Jules session — hand off a coding task (prompt) against a connected repo to run autonomously in Jules's own sandboxed VM. Fire-and-forget by default: automation_mode defaults to AUTO_CREATE_PR and plans auto-approve, so the session runs unattended and opens a PR when done, with no approval step required from this tool.\n" +
    "RULE: need the source resource name first -> jules_list_sources, UNLESS you already know it (format: 'sources/github-owner-repo').\n" +
    "RULE: this only STARTS the session — it does not wait for completion. Poll jules_get_session or jules_get_activities afterward to check progress and retrieve the resulting PR URL.",
    {
      source: z.string().describe("Resource name of the source repo, e.g. 'sources/github-owner-repo' (from jules_list_sources)"),
      prompt: z.string().describe("The coding task for Jules to execute, described with enough detail to act on without further clarification (Jules cannot ask follow-up questions mid-session unless you send one via a later message)"),
      title: z.string().optional().describe("Optional session title. If omitted, Jules generates one from the prompt."),
      starting_branch: z.string().optional().describe("Branch to start the session from (default: the repo's default branch)"),
      automation_mode: z.enum(["AUTO_CREATE_PR", "AUTOMATION_MODE_UNSPECIFIED"]).optional().describe("AUTO_CREATE_PR (default here) opens a PR automatically once code changes are ready — the fire-and-forget path. AUTOMATION_MODE_UNSPECIFIED leaves PR creation manual."),
      require_plan_approval: z.boolean().optional().describe("If true, the session pauses in AWAITING_PLAN_APPROVAL until a plan is explicitly approved. Default false (plans auto-approve) — set true only for a supervised, non-fire-and-forget run."),
    },
    async ({ source, prompt, title, starting_branch, automation_mode, require_plan_approval }) => {
      // Jules's API rejects sessions.create with a 400 if sourceContext.githubRepoContext
      // is omitted entirely -- despite the docs' own type reference listing it as
      // optional, every real request sample (quickstart, sources, sessions pages)
      // always includes it. Always send it; when no starting_branch is given, send
      // an empty object so Jules falls back to the repo's own default branch rather
      // than us needing to look that branch up ourselves via jules_list_sources.
      const body = {
        prompt,
        sourceContext: {
          source,
          githubRepoContext: starting_branch ? { startingBranch: starting_branch } : {},
        },
        automationMode: automation_mode || "AUTO_CREATE_PR",
      };
      if (title) body.title = title;
      if (require_plan_approval !== undefined) body.requirePlanApproval = require_plan_approval;

      const session = await julesRequest("/sessions", { method: "POST", body });
      const lines = [
        `Session created: ${session.name}`,
        session.title ? `Title: ${session.title}` : null,
        `State: ${session.state}`,
        session.url ? `View in Jules: ${session.url}` : null,
        `Check back with jules_get_session (session: "${session.name}") or jules_get_activities to track progress.`,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "jules_list_sessions",
    "DOES: List recent Jules sessions for the authenticated account, with state (e.g. RUNNING, AWAITING_PLAN_APPROVAL, COMPLETED, FAILED) and, for finished sessions, output PR URLs.\n" +
    "RULE: 'has anything Jules is working on finished' / 'what's Jules doing' -> this, instead of guessing from a single session ID.",
    {
      page_size: z.number().optional().describe("Max sessions to return per page (default: server default)"),
      page_token: z.string().optional().describe("Pagination token from a previous call's response"),
    },
    async ({ page_size, page_token }) => {
      const data = await julesRequest("/sessions", { params: { pageSize: page_size, pageToken: page_token } });
      const sessions = data?.sessions || [];
      if (!sessions.length) {
        return { content: [{ type: "text", text: "No Jules sessions found." }] };
      }
      const lines = sessions.map((s) => {
        const prs = (s.outputs || []).map((o) => o.pullRequest?.url).filter(Boolean);
        return `${s.name} — "${s.title || s.prompt}" — ${s.state}${prs.length ? ` — PR: ${prs.join(", ")}` : ""}`;
      });
      const more = data?.nextPageToken ? `\n\n(more available — next page_token: ${data.nextPageToken})` : "";
      return { content: [{ type: "text", text: lines.join("\n") + more }] };
    }
  );

  server.tool(
    "jules_get_session",
    "DOES: Get full details of one Jules session by resource name — state, the original prompt, session URL, and (once available) outputs such as the created pull request's URL.\n" +
    "RULE: checking whether a specific fire-and-forget session has finished -> this, rather than jules_list_sessions, once you have its name.",
    {
      session: z.string().describe("Resource name of the session, e.g. 'sessions/1234567' (returned by jules_create_session or jules_list_sessions)"),
    },
    async ({ session }) => {
      const name = session.startsWith("sessions/") ? session : `sessions/${session}`;
      const data = await julesRequest(`/${name}`);
      const prs = (data.outputs || []).map((o) => o.pullRequest?.url).filter(Boolean);
      const lines = [
        `${data.name} — "${data.title || data.prompt}"`,
        `State: ${data.state}`,
        data.url ? `View in Jules: ${data.url}` : null,
        prs.length ? `Pull request(s): ${prs.join(", ")}` : null,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "jules_get_activities",
    "DOES: List the activity timeline for a Jules session — plan generation, progress updates, messages, and completion/failure events — in chronological order.\n" +
    "RULE: want to see WHAT Jules actually did (not just its current state) -> this, in addition to jules_get_session.",
    {
      session: z.string().describe("Resource name of the session, e.g. 'sessions/1234567'"),
      page_size: z.number().optional().describe("Max activities to return per page (default: server default)"),
      page_token: z.string().optional().describe("Pagination token from a previous call's response"),
    },
    async ({ session, page_size, page_token }) => {
      const name = session.startsWith("sessions/") ? session : `sessions/${session}`;
      const data = await julesRequest(`/${name}/activities`, { params: { pageSize: page_size, pageToken: page_token } });
      const activities = data?.activities || [];
      if (!activities.length) {
        return { content: [{ type: "text", text: "No activities recorded yet for this session." }] };
      }
      const lines = activities.map((a) => `[${a.createTime}] ${a.originator}: ${a.description || Object.keys(a).find((k) => k.endsWith("Generated") || k.endsWith("Update") || k.endsWith("Message")) || "(event)"}`);
      const more = data?.nextPageToken ? `\n\n(more available — next page_token: ${data.nextPageToken})` : "";
      return { content: [{ type: "text", text: lines.join("\n") + more }] };
    }
  );
}
