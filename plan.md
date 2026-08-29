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

## Bugs found in review (2026-08-30) -- BLOCK MERGE until resolved

Found via two independent verification passes (one direct read of live CI logs/diff, one via delegate_agent's static review). Do not proceed to step 8 until all five items below are addressed.

1. **CI is currently red.** `list_workflow_runs` on this branch shows the
   latest pushes failing. ESLint fails on `connectors/github/codespaces.js`
   lines 222-223: `no-useless-assignment` -- `stdout`/`stderr` are
   pre-initialized to `""` but that initial value is never read before
   being overwritten in both the try and catch branches. Trivial fix (drop
   the dead initializers), but it currently blocks the pipeline entirely.

2. **Tests never actually ran.** Because lint runs before the test step in
   CI, "Run unit tests" shows as skipped, not passed, on every recent run.
   Nothing about `test/github-codespaces-exec.test.js` has been confirmed
   to actually pass -- fix #1, then re-run CI and check the test step
   specifically before trusting it.

3. **Command-injection bug via `cwd` (real, not the intentional
   no-restrictions design).** The command string is built as:
   ```js
   let fullCommand = command;
   if (cwd) { fullCommand = `cd ${cwd} && ${command}`; }
   ```
   `command` and `codespace_name` are safely wrapped via `JSON.stringify`
   before being placed into the outer `gh codespace ssh ... sh -c ...`
   string, but `cwd` is interpolated raw and unquoted. A `cwd` like
   `"x; rm -rf /"` breaks out of the intended `cd` context before `sh -c`
   even runs. This is distinct from the deliberate "no command
   allowlist/denylist" design decision at the top of this doc -- that was
   about the `command` param being unrestricted by choice; this is an
   unintended gap in a different param. Fix: quote/escape `cwd` the same
   way `command` already is, e.g. `` `cd ${JSON.stringify(cwd)} && ${command}` ``
   (adjust to whatever quoting is correct for the target shell).

4. **`gh` CLI is an undocumented hard runtime dependency.** `exec_in_codespace`
   shells out to `gh codespace ssh`, but nothing outside `plan.md` says the
   `gh` CLI must be installed and authenticated wherever this MCP server
   actually runs. Not in `README.md`, not in `package.json`, not in the
   tool's own description string. If the deployment environment (e.g. a
   bare Node container or serverless target) doesn't have `gh` installed,
   this fails with a cryptic "command not found" at call time. Needs an
   explicit note in README/docs and ideally a startup check.

5. **Test mocking doesn't actually exercise real `exec` behavior.** The
   implementation does `const execAsync = promisify(exec);` -- this only
   destructures cleanly into `{ stdout, stderr }` because Node's real
   `child_process.exec` has a `util.promisify.custom` implementation
   attached to it. The test's `vi.mock("node:child_process", () => ({ exec:
   vi.fn() }))` replaces `exec` with a bare mock that has no such custom
   symbol, so `promisify()` falls back to generic behavior that does not
   reliably produce a `{stdout, stderr}`-shaped object. The tests may be
   passing for the wrong reason (verifying response formatting only) rather
   than actually proving the exec path works -- which is likely how bug #3
   above went unnoticed. Needs a test that either uses a promisify-custom-
   aware mock, or asserts on the literal command string passed to `exec`
   (which would have caught the unquoted `cwd`).

8. **Merge** (Open -- blocked, see "Bugs found in review" above)
   - PR from `feat/codespace-exec-access` -> `main` once all 5 items above
     are resolved and CI is green (lint passes AND the test step actually
     runs and passes, not just "skipped").

## Open questions for owner
- Auto-start a stopped codespace on exec, or error out? *(Resolved: auto-starts and polls)*
- Any output size cap, or truly unbounded? *(Resolved: 10MB maxBuffer cap)*
- Should exec results be logged anywhere (Notion/Mem0) for audit trail,
  even though there's no command restriction?
