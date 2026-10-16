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
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";

const BASE = (process.env.MADMCP_URL || "").replace(/\/+$/, "");
const SECRET = process.env.TERMUX_AGENT_SECRET || "";
const IDLE_MS = Number(process.env.POLL_IDLE_MS) || 10000;
const ACTIVE_MS = Number(process.env.POLL_ACTIVE_MS) || 1000;
const ACTIVE_WINDOW_MS = Number(process.env.ACTIVE_WINDOW_MS) || 120000;
const MAX_OUTPUT = Number(process.env.MAX_OUTPUT_CHARS) || 50000;
const SHELL = process.env.TERMUX_AGENT_SHELL || "sh";
const REQUEST_TIMEOUT_MS = 20000;

if (!BASE || !SECRET) {
  console.error("Set MADMCP_URL and TERMUX_AGENT_SECRET before starting the agent.");
  process.exit(1);
}

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

async function handle(job) {
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
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

async function main() {
  console.log(`termux-agent polling ${BASE} (idle ${IDLE_MS}ms, active ${ACTIVE_MS}ms)`);
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

main();
