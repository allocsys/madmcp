#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/termux-agent.mjs — the phone-side agent for madmcp's Termux
// connector. Runs INSIDE Termux. No dependencies; needs Node 18+.
//
// It only ever makes OUTBOUND HTTPS requests: it polls madmcp for a queued
// job, runs it, and posts the result back. No open ports, no tunnel.
//
// Setup (see docs/TERMUX.md for the full walkthrough):
//   pkg install nodejs termux-api
//   export MADMCP_URL=https://your-madmcp-host
//   export TERMUX_AGENT_SECRET=<same value as on the server>
//   termux-wake-lock
//   node termux-agent.mjs
//
// Optional env: POLL_IDLE_MS (10000), POLL_ACTIVE_MS (1000),
// ACTIVE_WINDOW_MS (120000), MAX_OUTPUT_CHARS (50000), TERMUX_AGENT_SHELL (sh).
//
// Approval gate (needs the Termux:API app + package for the notification):
//   TERMUX_APPROVAL=smart|all|off   smart (default) auto-runs plainly read-only
//                                   commands and asks on the phone for the rest;
//                                   all asks for every job; off never asks.
//   TERMUX_APPROVAL_TIMEOUT_S=60    how long to wait for a tap before refusing
//   TERMUX_APPROVAL_DIR             marker-file dir (default ~/.madmcp-approvals)
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.MADMCP_URL || "").replace(/\/+$/, "");
const SECRET = process.env.TERMUX_AGENT_SECRET || "";
const IDLE_MS = Number(process.env.POLL_IDLE_MS) || 10000;
const ACTIVE_MS = Number(process.env.POLL_ACTIVE_MS) || 1000;
const ACTIVE_WINDOW_MS = Number(process.env.ACTIVE_WINDOW_MS) || 120000;
const MAX_OUTPUT = Number(process.env.MAX_OUTPUT_CHARS) || 50000;
const SHELL = process.env.TERMUX_AGENT_SHELL || "sh";
const REQUEST_TIMEOUT_MS = 20000;

// action -> argv. Mirrors connectors/termux/actions.js on the server. No
// shell is involved: values are passed as separate arguments.
const API = {
  battery:       () => ["termux-battery-status"],
  location:      () => ["termux-location", "-p", "network", "-r", "once"],
  clipboard_get: () => ["termux-clipboard-get"],
  clipboard_set: (a) => ["termux-clipboard-set", a.text],
  notify:        (a) => ["termux-notification", ...(a.title ? ["--title", a.title] : []), "--content", a.content],
  toast:         (a) => ["termux-toast", a.text],
  vibrate:       (a) => ["termux-vibrate", "-d", String(a.duration_ms ?? 300)],
  wifi_info:     () => ["termux-wifi-connectioninfo"],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Runs argv without a shell, capturing capped stdout/stderr and enforcing a
// timeout. detached + negative-pid kill takes the whole process group down,
// so a timed-out `sh -c` doesn't leave its children running.
function run(argv, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const kill = (signal) => {
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const cap = (current, chunk) => (current.length >= MAX_OUTPUT ? current : (current + chunk).slice(0, MAX_OUTPUT));

    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      finish({ exitCode: null, stdout, stderr, timedOut: false, error: err.message });
      return;
    }

    child.stdout.on("data", (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d.toString()); });
    child.on("error", (err) => finish({ exitCode: null, stdout, stderr, timedOut, error: err.message }));
    child.on("close", (code) => finish({ exitCode: timedOut ? 124 : code, stdout, stderr, timedOut }));

    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Approval gate. This runs ON THE PHONE, so a leaked MCP key or a compromised
// server cannot skip it. Modes (TERMUX_APPROVAL):
//   smart (default)  auto-run only plainly read-only commands; ask for the rest
//   all              ask for every job
//   off              never ask
// "Ask" = a Termux notification with Approve / Deny buttons. Anything other
// than an explicit Approve (deny, swipe-away, no answer, notification failure)
// means the job is NOT run. smart is an ALLOWLIST: it recognises a small set
// of simple read-only commands and everything it does not understand needs a
// tap. Use "all" if you want a tap for every single job.
// ---------------------------------------------------------------------------
const MODES = new Set(["smart", "all", "off"]);
const requestedMode = (process.env.TERMUX_APPROVAL || "smart").toLowerCase();
const APPROVAL_MODE = MODES.has(requestedMode) ? requestedMode : "smart"; // unknown value -> safest default
const APPROVAL_TIMEOUT_MS = (Number(process.env.TERMUX_APPROVAL_TIMEOUT_S) || 60) * 1000;
const APPROVAL_DIR = process.env.TERMUX_APPROVAL_DIR || join(process.env.HOME || ".", ".madmcp-approvals");
const MAX_REVIEW_CHARS = 800; // longer commands are refused: too long to review on a notification
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const SAFE_PROGRAMS = new Set([
  "ls", "pwd", "echo", "date", "uname", "whoami", "id", "hostname", "uptime", "free",
  "df", "du", "ps", "which", "cat", "head", "tail", "wc", "cut", "uniq", "grep", "file", "stat",
  "git", "tmux",
]);
const READERS = new Set(["cat", "head", "tail", "wc", "cut", "uniq", "grep", "file", "stat"]);
const SAFE_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files"]);
const API_NEEDS_APPROVAL = new Set(["location", "clipboard_get"]); // private data

// Anything touching secrets needs a tap, however harmless the command looks.
const SENSITIVE = /(\.ssh|\.gnupg|\.git-credentials|githelper_ssh_keys|madmcp-agent\/env|\.bash_history|\.netrc|\.aws|\.npmrc|\.env\b|id_rsa|id_ed25519|\/proc\/|\.madmcp-approvals|\.termux\/boot)/i;
const SENSITIVE_GLOB = /(^|[\s/~])\.[^\s/]*[*?[]/; // e.g. ls .*  or  cat ~/.s*/x
const NULL_REDIRECT = /(?:2>&1|[12&]?>\s*\/dev\/null)(?=\s|$|[|;&])/y;

// Splits a command into segments (separated by | ; && ||) of tokens. Returns
// null for anything that is not a plain command line: substitution, variables,
// backslashes, redirects (other than to /dev/null or 2>&1), subshells, braces,
// background jobs, newlines, unbalanced quotes.
export function parseSimpleCommand(command) {
  const s = String(command);
  if (/[\n\r\\`$]/.test(s)) return null;
  const segments = [];
  let tokens = [];
  let cur = "";
  let has = false;
  let glob = false;
  let quote = null;
  const endToken = () => {
    if (has) tokens.push({ text: cur, glob });
    cur = ""; has = false; glob = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null; else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (/\s/.test(c)) { endToken(); continue; }
    if (!has) {
      NULL_REDIRECT.lastIndex = i;
      const m = NULL_REDIRECT.exec(s);
      if (m) { i += m[0].length - 1; continue; }
    }
    if (c === "|") { endSegment(); if (s[i + 1] === "|") i++; continue; }
    if (c === ";") { endSegment(); continue; }
    if (c === "&") {
      if (s[i + 1] === "&") { endSegment(); i++; continue; }
      return null;
    }
    if ("<>(){}".includes(c)) return null;
    if ("*?[".includes(c)) glob = true;
    cur += c;
    has = true;
  }
  if (quote) return null;
  endSegment();
  return segments.length ? segments : null;
}

function isSafeSegment(tokens) {
  const [prog, ...args] = tokens;
  const name = prog.text;
  if (!SAFE_PROGRAMS.has(name)) return false; // also rejects FOO=1 cmd and /path/to/cmd
  if (name === "git") {
    return SAFE_GIT.has(args[0]?.text) && !args.some((a) => /^(--output|-o$|-O|--exec)/.test(a.text));
  }
  if (name === "tmux") {
    return args.length === 1 && ["ls", "list-sessions", "list-windows"].includes(args[0].text);
  }
  if (name === "ps") {
    // BSD-style `ps e` / `ps auxe` and `-o environ` print environments (secrets).
    if (args.some((a) => /environ|\benv\b/i.test(a.text))) return false;
    return !(args[0] && !args[0].text.startsWith("-") && /e/i.test(args[0].text));
  }
  if (READERS.has(name) && args.some((a) => a.glob)) return false; // a glob could match a secret
  if (name === "grep" && args.some((a) => /^-[A-Za-z]*[rR]/.test(a.text) || /^--(recursive|dereference-recursive|directories)/.test(a.text) || a.text === "-d")) {
    return false; // recursive grep can read every file under a directory
  }
  return true;
}

export function isSafeCommand(command) {
  const s = String(command);
  if (SENSITIVE.test(s) || SENSITIVE_GLOB.test(s)) return false;
  const segments = parseSimpleCommand(s);
  return Boolean(segments) && segments.every(isSafeSegment);
}

export function needsApproval(job, mode = APPROVAL_MODE) {
  if (mode === "off") return false;
  if (job.kind === "exec") return mode === "all" || !isSafeCommand(job.command);
  if (job.kind === "api") return mode === "all" || API_NEEDS_APPROVAL.has(job.action);
  return false;
}

export function notificationArgv(job, dir = APPROVAL_DIR) {
  const what = job.kind === "exec" ? String(job.command) : `Phone feature: ${job.action}`;
  return [
    "termux-notification",
    "--id", `madmcp-${job.id}`,
    "--title", "Approve phone command?",
    "--content", what,
    "--priority", "max",
    "--button1", "Approve", "--button1-action", `touch '${dir}/${job.id}.ok'`,
    "--button2", "Deny", "--button2-action", `touch '${dir}/${job.id}.no'`,
    "--on-delete", `touch '${dir}/${job.id}.no'`, // swiping it away counts as Deny
  ];
}

// Polls for the marker file a notification button creates. Deny wins ties.
export async function waitForDecision(id, { dir = APPROVAL_DIR, timeoutMs = APPROVAL_TIMEOUT_MS, pollMs = 500 } = {}) {
  const ok = join(dir, `${id}.ok`);
  const no = join(dir, `${id}.no`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(no)) return "denied";
    if (existsSync(ok)) return "approved";
    await sleep(pollMs);
  }
  if (existsSync(no)) return "denied";
  return existsSync(ok) ? "approved" : "timeout";
}

// Shows the notification and waits. Fails closed: only an explicit Approve
// returns { decision: "approved" }.
export async function askApproval(job, {
  dir = APPROVAL_DIR,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  notify = (argv) => run(argv, { cwd: process.env.HOME, timeoutMs: 10000 }),
  wait = waitForDecision,
} = {}) {
  const denied = (reason) => ({ decision: "denied", reason });
  if (!ID_RE.test(String(job.id))) return denied("invalid job id");
  if (dir.includes("'")) return denied("approval directory path must not contain a quote");
  const length = job.kind === "exec" ? String(job.command).length : 0;
  if (length > MAX_REVIEW_CHARS) {
    return denied(`command is ${length} chars, too long to review on the phone (max ${MAX_REVIEW_CHARS})`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clear = () => {
    for (const ext of ["ok", "no"]) rmSync(join(dir, `${job.id}.${ext}`), { force: true });
  };
  clear();
  const shown = await notify(notificationArgv(job, dir));
  if (shown.exitCode !== 0) {
    return denied("could not show the approval notification (is the Termux:API app installed?)");
  }
  const decision = await wait(job.id, { dir, timeoutMs });
  clear();
  try { await notify(["termux-notification-remove", `madmcp-${job.id}`]); } catch { /* best effort */ }
  if (decision === "approved") return { decision: "approved" };
  if (decision === "denied") return denied("denied on the phone");
  return denied(`no answer on the phone within ${Math.round(timeoutMs / 1000)}s`);
}

export async function handle(job, { approve = askApproval, mode = APPROVAL_MODE } = {}) {
  if (needsApproval(job, mode)) {
    console.log(`job ${job.id} needs approval on the phone`);
    let outcome;
    try {
      outcome = await approve(job);
    } catch (err) {
      outcome = { decision: "denied", reason: `approval failed: ${err.message}` };
    }
    if (outcome.decision !== "approved") {
      return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: `Not run: ${outcome.reason}` };
    }
  }
  const timeoutMs = Math.max(1, Number(job.timeoutSeconds) || 60) * 1000;
  const cwd = job.cwd || process.env.HOME;
  if (job.kind === "exec") {
    return run([SHELL, "-c", String(job.command)], { cwd, timeoutMs });
  }
  if (job.kind === "api") {
    const build = API[job.action];
    if (!build) return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: `unknown action '${job.action}'` };
    return run(build(job.args || {}), { cwd: process.env.HOME, timeoutMs });
  }
  return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: `unknown job kind '${job.kind}'` };
}

async function postResult(id, result) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await call(`/api/termux/result/${id}`, result);
      return;
    } catch (err) {
      console.error(`result post failed (attempt ${attempt}): ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
}

let stopping = false;

async function main() {
  if (!BASE || !SECRET) {
    console.error("Set MADMCP_URL and TERMUX_AGENT_SECRET before starting the agent.");
    process.exit(1);
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { stopping = true; });
  }
  console.log(`termux-agent polling ${BASE} (idle ${IDLE_MS}ms, active ${ACTIVE_MS}ms, approval ${APPROVAL_MODE})`);
  let lastActive = 0;
  let failures = 0;
  while (!stopping) {
    let wait = IDLE_MS;
    try {
      const { job } = await call("/api/termux/poll");
      failures = 0;
      if (job) {
        lastActive = Date.now();
        console.log(`job ${job.id} (${job.kind})`);
        await postResult(job.id, await handle(job));
        wait = 0;
      } else if (Date.now() - lastActive < ACTIVE_WINDOW_MS) {
        wait = ACTIVE_MS;
      }
    } catch (err) {
      failures++;
      wait = Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
      console.error(`poll error (${failures}): ${err.message}`);
    }
    if (wait > 0) await sleep(wait);
  }
  console.log("termux-agent stopped.");
}

// Tests import this file for the pure functions and set this to skip the loop.
if (process.env.TERMUX_AGENT_NO_AUTOSTART !== "1") {
  main();
}
