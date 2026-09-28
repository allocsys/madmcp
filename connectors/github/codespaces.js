// ---------------------------------------------------------------------------
// connectors/github/codespaces.js — exec_in_codespace (gated)
//
// The seven lifecycle tools that used to live here (list/get/machines/create/
// start/stop/delete) were consolidated into codespace_manage
// (connectors/github/codespace_manage.js). Only the gated exec tool remains:
// it is conditionally registered (CODE_EXEC_ENABLED) and deliberately kept
// out of the always-registered codespace_manage tool.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { githubRequest } from "./client.js";
import { GITHUB_TOKEN, CODE_EXEC_ENABLED } from "../../config.js";

const execFileAsync = promisify(execFile);

// POSIX single-quote escaping: wrap in '...' and turn each embedded '
// into '\'' (close quote, escaped literal quote, reopen quote). Unlike
// JSON.stringify (double-quote escaping), single quotes suppress ALL
// shell expansion -- $(...), backticks, $VAR, etc -- not just breakout
// via unescaped " or \. This matters here because the quoted result is
// interpolated into a `sh -c "..."` string that a shell parses again
// remotely, and double-quoted $(...) would still be evaluated there.
function posixSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

export function register(server) {

  // ── Execute command in codespace ─────────────────────────────────────────
  // Gated behind CODE_EXEC_ENABLED (default off) -- broken/unsafe, not
  // registered at all unless a human flips the flag on deliberately. Same
  // posture as editor_tools.js's EDITOR_AGENT_ENABLED gate.
  if (!CODE_EXEC_ENABLED) return;

  server.tool(
    "exec_in_codespace",
    "Execute a shell command inside a running GitHub Codespace. Captures stdout, stderr, and exit code. No command restrictions — owner supervises all runs. Automatically starts the codespace if stopped.",
    {
      codespace_name:  z.string().describe("The codespace's name (e.g. from codespace_manage 'list')"),
      command:         z.string().describe("The shell command to execute"),
      cwd:             z.string().optional().describe("Optional working directory path relative to repository root inside the codespace"),
      timeout_seconds: z.number().optional().describe("Command execution timeout in seconds (default: 300)"),
    },
    async ({ codespace_name, command, cwd, timeout_seconds = 300 }) => {
      const cs = await githubRequest(`/user/codespaces/${codespace_name}`);
      if (!cs) {
        throw new Error(`Codespace ${codespace_name} not found.`);
      }

      if (cs.state !== "Available") {
        await githubRequest(`/user/codespaces/${codespace_name}/start`, { method: "POST" });
        let currentCs = cs;
        for (let attempt = 0; attempt < 30 && currentCs.state !== "Available"; attempt++) {
          await new Promise((r) => setTimeout(r, 3000));
          currentCs = await githubRequest(`/user/codespaces/${codespace_name}`);
        }
        if (currentCs.state !== "Available") {
          throw new Error(`Codespace ${codespace_name} is in state '${currentCs.state}' and failed to become Available.`);
        }
      }

      const timeoutMs = timeout_seconds * 1000;
      let fullCommand = command;
      if (cwd) {
        fullCommand = `cd ${posixSingleQuote(cwd)} && ${command}`;
      }

      const env = { ...process.env };
      if (GITHUB_TOKEN) {
        env.GH_TOKEN = GITHUB_TOKEN;
        env.GITHUB_TOKEN = GITHUB_TOKEN;
      }

      let stdout;
      let stderr;
      let exitCode = 0;

      try {
        // execFile (argv array) instead of exec (single string): this
        // spawns `gh` directly with its arguments, with no local shell
        // parsing/re-expanding them in between. Only the remote `sh -c
        // fullCommand`, run inside the codespace via ssh, sees a shell at
        // all -- which is where `command`'s intentionally-unrestricted
        // shell semantics are supposed to apply, not on this host.
        const { stdout: out, stderr: err } = await execFileAsync(
          "gh",
          ["codespace", "ssh", "-c", codespace_name, "--", "sh", "-c", fullCommand],
          {
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env,
          }
        );
        stdout = out;
        stderr = err;
      } catch (error) {
        stdout = error.stdout || "";
        stderr = error.stderr || error.message || "";
        exitCode = error.code !== undefined ? error.code : 1;
        if (error.killed) {
          stderr += `\n[Command timed out after ${timeout_seconds}s]`;
          exitCode = 124;
        }
      }

      const text = [
        `Exit code: ${exitCode}`,
        stdout ? `Stdout:\n${stdout}` : null,
        stderr ? `Stderr:\n${stderr}` : null,
      ].filter(Boolean).join("\n\n");

      return {
        content: [{ type: "text", text }],
        isError: exitCode !== 0,
      };
    }
  );
}
