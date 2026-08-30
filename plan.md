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
     *Implemented approach:* `gh codespace ssh`, invoked via Node's
     `child_process.execFile` (argv array — see bug #3 below for why this
     replaced the original `child_process.exec` + string-interpolation
     approach), combined with `githubRequest` for lifecycle state
     verification/auto-start. `GITHUB_TOKEN` passed via `GH_TOKEN`.

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

6. **Testing** [x] (Done and passing — see verification log below)
   - `test/github-codespaces-exec.test.js` covers: successful command
     execution, non-zero exit code handling, timeout handling
     (`killed = true`, exit code 124), auto-start-when-stopped with status
     polling, argv-array/no-local-shell invocation, and single-quote
     escaping of `cwd` against `$()`/backtick/embedded-quote payloads.

7. **Docs** [x] (Done)
   - `codespaces.js` tool description surfaces the auth caveat (`codespace`
     scope required for `gh codespace ssh`).
   - README documents the `gh` CLI runtime requirement.

## Review round 1 (2026-08-30) — bugs found, claimed resolved, actually weren't

A prior pass through this plan marked five review bugs "RESOLVED." On
independent verification against the actual repo state and a real CI run
(not just re-reading the diff), that was wrong for three of them:

1. **Lint failure (dead `stdout`/`stderr` init)** — genuinely fixed.
2. **Tests never ran** — **not fixed.** The new test file itself crashed
   the whole suite: it called `require("vitest")` inside `vi.hoisted()`,
   which Vitest hard-rejects under ESM (`"Vitest cannot be imported in a
   CommonJS module using require()"`). This failed every CI run through
   #1185, including all pre-existing tests in the repo, not just the new
   file.
3. **Command-injection via `cwd`** — **only partially fixed.** The
   original fix wrapped `cwd` in `JSON.stringify(cwd)`, which escapes `"`
   and `\` but not `$` or backticks. Since the result still sat inside a
   double-quoted shell argument, `$(...)`/backtick command substitution in
   `cwd` remained live. Worse, the entire `gh codespace ssh ... sh -c
   "..."` invocation was built as one interpolated string and run through
   `child_process.exec`, which itself spawns a **local** shell to parse
   that string — so a crafted `cwd` (or `command`, which is
   intentionally unrestricted) could execute arbitrary code on the host
   running the MCP server, not just inside the target codespace. The
   review's own regression test only tried a `;`-separated payload, which
   double-quoting happens to neutralize, so it didn't catch this.
4. **`gh` CLI dependency undocumented** — genuinely fixed (README).
5. **Weak test mocking** — **not fixed as claimed.** The
   `[util.promisify.custom]` symbol was attached to the mock *after*
   `codespaces.js` was imported, but `codespaces.js` calls
   `promisify(exec)` once, at its own module-evaluation time, and caches
   the result — so the customization never took effect even before the
   `require("vitest")` crash made it moot.

## Review round 2 (2026-08-30) — actual fixes, verified against a real CI run

- **Command injection (real fix):** Replaced `child_process.exec` (string,
  local-shell-parsed) with `child_process.execFile` (argv array, no local
  shell at all) — `gh` is spawned directly, so nothing on the MCP host can
  re-parse or expand `$()`/backticks/`;` in `codespace_name` or `command`.
  `cwd` is now escaped with POSIX single-quoting (wrap in `'...'`, turn
  each embedded `'` into `'\''`) instead of `JSON.stringify`, which
  suppresses all shell expansion rather than just quote-breakout.
  `command` remains intentionally unrestricted per the owner's
  requirement — it still runs as arbitrary shell *inside* the codespace,
  via the remote `sh -c`, which is the documented, supervised behavior.
  Only the local-execution and cwd-injection vectors were closed.
- **Test suite (real fix):** Removed the `require("vitest")` call; used
  `vi.hoisted(() => vi.fn())` instead (the documented pattern — `vi` is
  safe to reference directly inside `vi.hoisted()`). Rebuilt the
  `[util.promisify.custom]` mock entirely inside `vi.hoisted()` (using
  `require("node:util")`, an unrelated built-in, not the package that
  triggered the original error) so it's attached before `codespaces.js`
  ever calls `promisify(execFile)`. Replaced the `;`-only injection
  regression test with tests that actually exercise `$(...)` and
  backtick/embedded-quote payloads.
- **Two more pre-existing test bugs surfaced once the suite could finally
  run at all**, both fixed:
  - `exec_in_codespace` always sets `isError: exitCode !== 0` (an
    explicit boolean), never an omitted key — tests wrongly asserted
    `toBeUndefined()` on success instead of `toBe(false)`. Fixed the
    assertions; the code's behavior was already correct.
  - The auto-start poll loop awaits a real 3000ms `setTimeout` per
    attempt (not a mocked timer). The success-path test needs 3 real
    iterations (~9s), which exceeded Vitest's 5000ms default test
    timeout. Raised that one test's timeout to 15000ms rather than fake
    the wait away.
- **Verified, not assumed:** pushed each fix and watched actual CI runs
  rather than trusting the diff. Runs #1186–#1190 on this round's commits
  failed for the specific reasons listed above (including two of my own
  intermediate mistakes — a leftover placeholder in one commit, and the
  timing bug in another). Run **#1191 (commit `167126f`) is green**:
  https://github.com/allocsys/madmcp/actions/runs/33282751319

## Merge readiness

CI is green on `feat/codespace-exec-access` at commit `167126f`
(verified via `get_check_runs`, not just the workflow list). Logic was
additionally independently re-verified via a separate read-only
investigation (execFile/argv safety, posixSingleQuote edge cases, poll
loop bounds, exit-code/timeout handling, and test mock ordering all
confirmed correct — no new issues found). The audit-logging question
below is now resolved. No open items remain before opening the PR to
`main`.

## Open questions for owner
- Auto-start a stopped codespace on exec, or error out? *(Resolved: auto-starts and polls)*
- Any output size cap, or truly unbounded? *(Resolved: 10MB maxBuffer cap)*
- Should exec results be logged anywhere (Notion/Mem0) for audit trail,
  even though there's no command restriction? *(Resolved: owner decided no
  audit logging needed.)*
