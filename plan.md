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

2. **Add tool definition**
   - New tool, e.g. `exec_in_codespace(codespace_name, command, cwd?, timeout_seconds?)`.
   - No path/command restrictions per owner's instruction.
   - Default timeout only for hygiene (not a permission control) — e.g. 300s,
     overridable.

3. **Server-side implementation**
   - Establish SSH/exec session to the target codespace.
   - Stream stdout/stderr back, capture exit code.
   - Handle codespace not running (auto `start_codespace` first?) —
     decide default behavior.

4. **Wire into MCP tool registry**
   - Add to the same file/module where `create_codespace`,
     `start_codespace`, etc. are defined.
   - Update tool description so the calling model knows this is a real
     shell, not a sandboxed one.

5. **Auth/credentials**
   - Confirm the existing GitHub token used by other Codespace tools has
     scope for Codespaces SSH/exec (may need `codespace` scope beyond
     `repo`).

6. **Testing**
   - Create a throwaway codespace, run a few commands (`ls`, `echo`,
     a short build) end-to-end.
   - Verify long-running command handling and timeout behavior.
   - Verify output size limits / truncation so huge output doesn't blow
     up the response.

7. **Docs**
   - Update tool description block to reflect the new capability so
     future sessions know it exists (currently the description explicitly
     says "management only, no shell").

8. **Merge**
   - PR from `feat/codespace-exec-access` → `main` once tested.

## Open questions for owner
- Auto-start a stopped codespace on exec, or error out?
- Any output size cap, or truly unbounded?
- Should exec results be logged anywhere (Notion/Mem0) for audit trail,
  even though there's no command restriction?
