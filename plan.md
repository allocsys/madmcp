# Codespace Exec Access — Implementation Plan

Goal: give the agent full, unrestrained access to run commands inside a
GitHub Codespace it manages (create/start/stop/delete already exist —
this adds actual execution).

Owner supervises all runs; no command allowlist/denylist by request.

## Steps

1. **Transport research**
   - Confirm how to open a shell channel into a running Codespace.
     GitHub Codespaces expose SSH via the `gh codespace ssh` flow and a
     REST-issued connection token (`/user/codespaces/{name}/machines` +
     the codespace's `connection.sessionToken` / port-forwarding info).
   - Decide: shell out to `gh cli` under the hood, or hit the Codespaces
     REST/SSH endpoints directly from the MCP server process.
     *Implemented approach:* Used `gh codespace ssh` wrapped via Node's `child_process.exec`, combining `githubRequest` for lifecycle state verification/auto-start and `gh codespace ssh` for secure shell execution with `GITHUB_TOKEN` passed via `GH_TOKEN`.

2. **Add tool definition** [x] (Done)
   - New tool: `exec_in_codespace(codespace_name, command, cwd?, timeout_seconds?)`.
   - No path/command restrictions per owner's instruction.
   - Default timeout 300s (overridable).

3. **Server-side implementation** [x] (Done)
   - Established SSH/exec session to the target codespace via `gh codespace ssh`.
   - Captured stdout, stderr, and exit code.
   - Added auto-start logic for stopped codespaces using `githubRequest` to poll until available.

4. **Wire into MCP tool registry** [x] (Done)
   - Added to `connectors/github/codespaces.js` and registered alongside other tools.

5. **Auth/credentials** [x] (Done - static analysis & risk documented)
   - Confirmed `GITHUB_TOKEN` scope requirements: `gh codespace ssh` requires OAuth / Fine-grained PAT scopes with Codespaces read/write permissions (`codespace` or `codespaces:write`). Standard repo-only PATs will fail SSH authentication against GitHub's Codespace ssh gateway. Documented this requirement and risk.

6. **Testing** [~] (Done, but NOT verified passing -- see "Bugs found in review" below)
   - Added `test/github-codespaces-exec.test.js` covering successful command execution, non-zero exit code handling, timeout handling (`killed = true`, exit code 124), and auto-start-when-stopped behavior with status polling.
   - CAVEAT: CI never got far enough to run these tests (blocked by lint failure), so "added" is not the same as "passing."

7. **Docs** [x] (Done)
   - Updated `codespaces.js` tool description string for `exec_in_codespace` to surface auth caveats (`codespace` scope required for `gh codespace ssh`). Updated `plan.md`.

## Bugs found in review (2026-08-30) -- RESOLVED

1. **Lint failure**: [Resolved] Removed dead `stdout`/`stderr` initializations in `codespaces.js`.
2. **Tests never actually ran**: [Resolved] Fix #1 allows CI linting to pass; subsequent CI runs will now correctly execute the test step.
3. **Command-injection bug via `cwd`**: [Resolved] Now using `JSON.stringify(cwd)` to pass the directory as a quoted/escaped shell argument.
4. **`gh` CLI dependency**: [Resolved] Added clear requirement note to `README.md` (near the GitHub connector section).
5. **Weak test mocking**: [Resolved] Refactored `test/github-codespaces-exec.test.js` to use `[util.promisify.custom]` and added a specific regression test case that verifies `cwd` is safely quoted.

8. **Merge** (Open -- ready for final CI validation)
   - PR from `feat/codespace-exec-access` -> `main` once all 5 items above
     are resolved and CI is green (lint passes AND the test step actually
     runs and passes, not just "skipped").

## Open questions for owner
- Auto-start a stopped codespace on exec, or error out? *(Resolved: auto-starts and polls)*
- Any output size cap, or truly unbounded? *(Resolved: 10MB maxBuffer cap)*
- Should exec results be logged anywhere (Notion/Mem0) for audit trail,
  even though there's no command restriction?
