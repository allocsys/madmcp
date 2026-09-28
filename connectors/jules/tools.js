// ---------------------------------------------------------------------------
// connectors/jules/tools.js — delegate autonomous coding tasks to Jules
// (Google's async coding agent), fire-and-forget style: create a session
// against a connected GitHub repo, walk away, poll for status/output later.
//
// Three action-dispatched tools:
//   jules_find     (sources | sessions)    read-only lists
//   jules_inspect  (session | activities)  read one session
//   jules_write    (create | message)      mutating
//
// Distinct from delegate_agent/delegate_designer in this repo: those are
// synchronous, read-only (or frontend-fenced) loops that return one answer
// within a single tool call. A Jules session is asynchronous and can WRITE
// arbitrary code across a whole repo over several minutes in its own
// sandboxed VM, independent of this server's request lifecycle — you create
// it, then check back with jules_inspect.
//
// jules_write action 'message' adds a supervised escape hatch: nudge a
// still-running session with extra instructions or a question. It only works
// on a LIVE session (RUNNING / AWAITING_PLAN_APPROVAL / AWAITING_USER_FEEDBACK)
// -- there's no API for messaging a session that has already COMPLETED or
// FAILED, since the underlying sandboxed VM is gone by then.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { julesRequest } from "./client.js";

export function register(server) {

  server.tool(
    "jules_find",
    "DOES: List Jules resources. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'sources' lists the GitHub repositories connected to your Jules account, each with its resource name (e.g. 'sources/github-owner-repo') needed for jules_write action 'create'. Call this first if you don't already know the exact source name for the repo you want to target.\n" +
    "RULE: action 'sessions' lists recent Jules sessions with state (e.g. RUNNING, AWAITING_PLAN_APPROVAL, COMPLETED, FAILED) and, for finished sessions, output PR URLs. 'has anything Jules is working on finished' / 'what's Jules doing' -> this, instead of guessing from a single session ID.\n" +
    "RULE: page_size and page_token (pagination) apply to both actions.",
    {
      action: z.enum(["sources", "sessions"]).describe("Which list to fetch: 'sources' (connected repos) or 'sessions' (recent Jules sessions)"),
      page_size: z.number().optional().describe("Max items to return per page (default: server default)"),
      page_token: z.string().optional().describe("Pagination token from a previous call's response, to fetch the next page"),
    },
    async ({ action, page_size, page_token }) => {
      if (action === "sources") return listSources({ page_size, page_token });
      return listSessions({ page_size, page_token });
    }
  );

  server.tool(
    "jules_inspect",
    "DOES: Read one Jules session by resource name. READ-ONLY. Use `action` to pick.\n" +
    "RULE: action 'session' returns full details of the session — state, the original prompt, session URL, and (once available) outputs such as the created pull request's URL. Checking whether a specific fire-and-forget session has finished -> this, rather than jules_find action 'sessions', once you have its name.\n" +
    "RULE: action 'activities' lists the activity timeline for the session — plan generation, progress updates, messages, completion, and (with full detail) failures — in chronological order. Failed activities include the failure reason; activities with artifacts include code diffs (git patch) and bash command output Jules produced. Want to see WHAT Jules actually did, why a session failed, or its resulting diff/output -> this, in addition to action 'session'.\n" +
    "RULE: page_size and page_token (pagination) apply to action 'activities' only.",
    {
      action: z.enum(["session", "activities"]).describe("What to read: 'session' (details of one session) or 'activities' (its activity timeline)"),
      session: z.string().describe("Resource name of the session, e.g. 'sessions/1234567' (returned by jules_write action 'create' or jules_find action 'sessions')"),
      page_size: z.number().optional().describe("Max activities to return per page (default: server default). Used by 'activities' only."),
      page_token: z.string().optional().describe("Pagination token from a previous call's response. Used by 'activities' only."),
    },
    async ({ action, session, page_size, page_token }) => {
      const name = sessionName(session);
      if (action === "session") return getSession(name);
      return getActivities(name, { page_size, page_token });
    }
  );

  server.tool(
    "jules_write",
    "DOES: Start or steer a Jules session. MUTATES: 'create' launches a real autonomous run that can open a PR. Use `action` to pick.\n" +
    "RULE: action 'create' requires source + prompt. It hands off a coding task (prompt) against a connected repo to run autonomously in Jules's own sandboxed VM. Fire-and-forget by default: automation_mode defaults to AUTO_CREATE_PR and plans auto-approve, so the session runs unattended and opens a PR when done, with no approval step required from this tool. Need the source resource name first -> jules_find (action 'sources'), UNLESS you already know it (format: 'sources/github-owner-repo'). This only STARTS the session — it does not wait for completion. Poll jules_inspect (action 'session' or 'activities') afterward to check progress and retrieve the resulting PR URL.\n" +
    "RULE: action 'message' requires session + message. It sends a message from the user into an active Jules session (extra instructions, an answer to a question Jules asked, or a course correction), via POST /sessions/{id}:sendMessage. Only works while the session is still live (state RUNNING, AWAITING_PLAN_APPROVAL, or AWAITING_USER_FEEDBACK) -- once a session is COMPLETED or FAILED its sandbox is gone and there is no way to message it further; check jules_inspect (action 'session') first if you're unsure of the current state. It only sends the message -- it does not wait for a reply. Poll jules_inspect (action 'activities') afterward (look for a new agentMessaged entry) to see Jules's response.\n" +
    "RULE: source/prompt/title/starting_branch/automation_mode/require_plan_approval apply to 'create' only; session/message apply to 'message' only.",
    {
      action: z.enum(["create", "message"]).describe("What to do: 'create' (start a new session) or 'message' (send a message into a live session)"),
      source: z.string().optional().describe("Resource name of the source repo, e.g. 'sources/github-owner-repo' (from jules_find action 'sources'). Required for 'create'."),
      prompt: z.string().optional().describe("The coding task for Jules to execute, described with enough detail to act on without further clarification (Jules cannot ask follow-up questions mid-session unless you send one via a later message). Required for 'create'."),
      title: z.string().optional().describe("Optional session title. If omitted, Jules generates one from the prompt. Used by 'create' only."),
      starting_branch: z.string().optional().describe("Branch to start the session from (default: the repo's default branch). Used by 'create' only."),
      automation_mode: z.enum(["AUTO_CREATE_PR", "AUTOMATION_MODE_UNSPECIFIED"]).optional().describe("AUTO_CREATE_PR (default here) opens a PR automatically once code changes are ready — the fire-and-forget path. AUTOMATION_MODE_UNSPECIFIED leaves PR creation manual. Used by 'create' only."),
      require_plan_approval: z.boolean().optional().describe("If true, the session pauses in AWAITING_PLAN_APPROVAL until a plan is explicitly approved. Default false (plans auto-approve) — set true only for a supervised, non-fire-and-forget run. Used by 'create' only."),
      session: z.string().optional().describe("Resource name of the session, e.g. 'sessions/1234567'. Required for 'message'."),
      message: z.string().optional().describe("The message to send to the session -- instructions, an answer, or feedback. Required for 'message'."),
    },
    async (args) => {
      if (args.action === "create") {
        if (args.source === undefined || args.prompt === undefined) {
          throw new Error("jules_write action 'create' requires source and prompt.");
        }
        return createSession(args);
      }
      if (args.session === undefined || args.message === undefined) {
        throw new Error("jules_write action 'message' requires session and message.");
      }
      return sendMessage(args);
    }
  );
}

// Bare id '42' -> 'sessions/42'; already-qualified names pass through.
function sessionName(session) {
  return session.startsWith("sessions/") ? session : `sessions/${session}`;
}

async function createSession({ source, prompt, title, starting_branch, automation_mode, require_plan_approval }) {
  // Jules's API rejects sessions.create with a 400 if sourceContext.githubRepoContext
  // is omitted entirely -- despite the docs' own type reference listing it as
  // optional, every real request sample (quickstart, sources, sessions pages)
  // always includes it. Always send it; when no starting_branch is given, send
  // an empty object so Jules falls back to the repo's own default branch rather
  // than us needing to look that branch up ourselves via jules_find.
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
    `Check back with jules_inspect (action: "session", session: "${session.name}") or action "activities" to track progress.`,
  ].filter(Boolean);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function sendMessage({ session, message }) {
  const name = sessionName(session);
  await julesRequest(`/${name}:sendMessage`, { method: "POST", body: { prompt: message } });
  return { content: [{ type: "text", text: `Message sent to ${name}. Check jules_inspect (action: "activities") shortly for Jules's response.` }] };
}

async function getSession(name) {
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

async function getActivities(name, { page_size, page_token }) {
  const data = await julesRequest(`/${name}/activities`, { params: { pageSize: page_size, pageToken: page_token } });
  const activities = data?.activities || [];
  if (!activities.length) {
    return { content: [{ type: "text", text: "No activities recorded yet for this session." }] };
  }
  const lines = activities.map((a) => `[${a.createTime}] ${a.originator}: ${describeActivity(a)}`);
  const more = data?.nextPageToken ? `\n\n(more available — next page_token: ${data.nextPageToken})` : "";
  return { content: [{ type: "text", text: lines.join("\n") + more }] };
}

// Render the one populated event field on an Activity (per the API's
// oneof-style shape), plus any artifacts (diffs / bash output / media)
// attached to it. Falls back to `description` or a bare "(event)" only
// if none of the known event fields are present, e.g. for a future event
// type this hasn't been taught about yet.
function describeActivity(a) {
  const parts = [];

  if (a.planGenerated) {
    const steps = (a.planGenerated.plan?.steps || [])
      .map((s, i) => `    ${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ""}`)
      .join("\n");
    parts.push(`Plan generated${steps ? ":\n" + steps : ""}`);
  } else if (a.planApproved) {
    parts.push(`Plan approved (planId: ${a.planApproved.planId})`);
  } else if (a.userMessaged) {
    parts.push(`User message: ${a.userMessaged.userMessage}`);
  } else if (a.agentMessaged) {
    parts.push(`Agent message: ${a.agentMessaged.agentMessage}`);
  } else if (a.progressUpdated) {
    parts.push(`Progress: ${a.progressUpdated.title}${a.progressUpdated.description ? ` — ${a.progressUpdated.description}` : ""}`);
  } else if (a.sessionCompleted) {
    parts.push("Session completed");
  } else if (a.sessionFailed) {
    parts.push(`SESSION FAILED — ${a.sessionFailed.reason || "(no reason given by Jules)"}`);
  } else {
    parts.push(a.description || "(event)");
  }

  for (const artifact of a.artifacts || []) {
    if (artifact.changeSet?.gitPatch) {
      const gp = artifact.changeSet.gitPatch;
      const label = gp.suggestedCommitMessage ? ` (${gp.suggestedCommitMessage})` : "";
      parts.push(`  Diff${label}:\n${indent(truncate(gp.unidiffPatch, 3000))}`);
    }
    if (artifact.bashOutput) {
      const bo = artifact.bashOutput;
      parts.push(`  $ ${bo.command}  (exit ${bo.exitCode})\n${indent(truncate(bo.output, 2000))}`);
    }
    if (artifact.media) {
      parts.push(`  [media artifact: ${artifact.media.mimeType}]`);
    }
  }

  return parts.join("\n");
}

async function listSources({ page_size, page_token }) {
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

async function listSessions({ page_size, page_token }) {
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

function indent(text) {
  return text.split("\n").map((l) => `    ${l}`).join("\n");
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated, ${text.length - max} more chars)`;
}
