# Plan: Limited GitHub write access for delegate_agent (non-default-branch only)

Status: not started -- design doc only, no code written yet.
Date: 2026-08-28

## Context

`delegate_agent` (connectors/gemini/agent_delegate.js) is deliberately READ-ONLY
-- see that file's own header: "every delegated function below is READ-ONLY
... writes stay confined to the fixed GEMINI_NOTION_ROOT_PAGE_ID path in
agent_tools.js." That boundary was a considered design choice, not an
oversight, and this doc does not propose removing it.

A write-capable sibling already exists: `delegate_designer`
(connectors/frontend/designer_delegate.js, backing `runDesignAgent`).
It proves out the pattern this doc wants to generalize -- multi-step Gemini
loop, but WRITE-capable, made safe by fencing enforced AT THE TOOL LAYER,
not by prompt instructions alone:

- owner/repo/branch fixed for the whole run, bound into closures -- not a
  parameter the model can set via function call, so there is no code path
  for the model to redirect a write at a different repo/branch than the
  one the run was started against.
- default-branch writes refused up front, before the loop even starts.
- writes restricted to an extension allowlist (FRONTEND_ALLOWED_EXTENSIONS).
- only 3 tightly-scoped tools exposed (read_file/write_file/validate), not
  delegate_agent's full cross-system surface.

**This was already considered and rejected as a flag on delegate_agent
itself** (2026-08-28 conversation): an opt-in `allow_write` boolean on the
existing tool would need to reinvent all of the above fencing per-call, on
top of a much bigger attack surface (GitHub + Notion + Cloudflare +
Context7 + Mem0, arbitrary repos/pages) than delegate_designer's 3-tool,
single-repo scope. A single boolean is also exactly the kind of argument a
model could pass by mistake, or be prompt-injected into passing. Baking
"read-only" and "write-capable" into two separate tools (already the
pattern delegate_designer established) keeps the blast radius of a mistake
bounded to whichever tool was actually invoked.

**Gap this doc addresses:** delegate_designer's write access is scoped to
frontend file extensions only (.html/.css/.scss/.jsx/.tsx/.vue, per
FRONTEND_ALLOWED_EXTENSIONS in config.js). There's no equivalent for
general-purpose repo edits -- docs, config, backend code, tests, etc. --
on a caller-chosen feature branch. This plan is for a NEW tool
(`delegate_editor`, name open to bikeshedding) that generalizes
delegate_designer's fencing pattern beyond the frontend file-type
restriction, without touching delegate_agent's read-only guarantee at all.

## Goal

A new, separately-registered MCP tool that lets Gemini run a multi-step
tool-use loop with real GitHub write access (read_file/write_file, and
whatever else step 2 below decides), but ONLY ever writing to:

- a single repo, fixed for the whole run
- a single branch, fixed for the whole run, and never the repo's default
  branch (checked before the loop starts, same as delegate_designer)

Every guardrail from delegate_designer's model is required here too, at a
minimum -- this plan does not lower that bar, only broadens the file-type
scope it applies to. Where broadening scope changes risk, this doc adds
NEW guardrails to compensate (see "Guardrails" below) rather than
loosening existing ones.

## Non-goals

- No writes to the default branch, ever, from this tool, regardless of any
  argument. If someone wants a default-branch write, that stays a
  human-in-the-loop action via the existing github_* MCP tools (create_pull_request,
  merge_pull_request, etc.), not something this agent does autonomously.
- No new write surface on delegate_agent itself. That tool stays
  read-only, full stop -- this plan's tool is additive, not a modification
  to agent_delegate.js's FUNCTIONS list.
- No unrestricted file-type/path access on day one. Start narrow (step 2),
  widen deliberately later if the narrow version proves insufficient in
  practice -- same posture the original delegate_designer scope took with
  FRONTEND_ALLOWED_EXTENSIONS.
- Not a replacement for human PR review. This tool can commit to a branch;
  it does not open, approve, or merge pull requests. A human still reviews
  the diff before anything reaches the default branch.

## Guardrails (required, not optional -- carried over from delegate_designer
## unless noted, plus new ones this broader scope needs)

1. **Repo + branch fixed per run, bound into tool closures.** Not a model-
   settable function-call parameter. (Carried over from delegate_designer.)
2. **Default-branch refusal, checked before the loop starts.** Look up the
   repo's actual default branch via the GitHub API and hard-refuse if the
   caller-supplied branch matches it -- do not trust a caller's claim that
   a branch is "safe." (Carried over.)
3. **Path/extension allowlist, configurable per run rather than hardcoded
   to frontend types.** Needs its own config surface (new env var or
   caller argument -- open question below) since "general edit access"
   can't reuse a fixed frontend-only list. Path allowlisting (e.g. glob
   patterns, or a caller-supplied list of allowed path prefixes) is likely
   necessary IN ADDITION to extension allowlisting once scope broadens
   past frontend files -- an extension check alone doesn't stop a write to
   e.g. .github/workflows/*.yml or server.js just because .yml or .js
   happens to be in the allowlist. (NEW guardrail, broader-scope-specific.)
4. **Hard-deny list, independent of and layered on top of any allowlist.**
   Regardless of what's allowed: never write to .github/workflows/** (CI
   definitions -- a write there is a privilege-escalation vector, since CI
   often runs with more trust than a branch push does), never write
   package.json's scripts or dependencies fields without a distinct
   explicit flag (supply-chain risk), never write anything under
   connectors/security.js or auth-adjacent files (app_auth.js,
   clone_token.js) without the same. This is new -- delegate_designer
   never needed a deny list because its allowlist was already narrow
   enough (.html/.css/.scss/.jsx/.tsx/.vue can't touch CI or auth code).
   A broader tool needs the deny list as a second, independent layer, not
   as a substitute for a narrower allowlist. (NEW guardrail.)
5. **validate() equivalent before write, where a validator exists.**
   delegate_designer's per-file-type syntax validator generalizes
   naturally to more file types (JSON, YAML, and existing JS lint tooling
   via eslint.config.js already in this repo) but not all of them --
   define what "validated" means per allowed file type explicitly rather
   than silently skipping validation for types outside the original set.
   (Carried over + extended.)
6. **Per-run and per-file write caps**, mirroring delegate_designer's
   FRONTEND_MAX_VALIDATE_CALLS pattern -- a cap on total files touched per
   run and total writes per file, to bound the blast radius of a stuck or
   misbehaving loop before a human ever looks at the branch.
7. **Checkpoint/resume contract identical to delegate_designer's**, not a
   new one -- reuse designer_checkpoint.js's shape (or a close sibling of
   it) rather than inventing a fourth checkpoint schema alongside
   agent_checkpoint.js and designer_checkpoint.js.
8. **No merge/PR-opening capability in this tool's own function set.**
   Enforced by simply not including create_pull_request/merge_pull_request
   among the tool's FUNCTIONS, the same way delegate_designer's 3-tool
   surface enforces its restrictions -- not a runtime check, a structural
   omission. A human (or a separate, explicitly-invoked MCP call) opens
   the PR once the branch looks right.
9. **Every write attributable and auditable.** Reuse delegate_designer's
   transcript/writtenFiles reporting as the audit trail for this tool.
   Mandatory Notion logging was considered and dropped -- redundant with
   the transcript/writtenFiles reporting this guardrail already relies on.

## Sequenced implementation steps

These are ordered -- later steps depend on earlier ones being in place and
tested. Deliberately modeled on delegate_designer's own build order (issue
#61's steps), since that's the closest prior art in this repo for a
write-capable agent loop.

1. **Design doc sign-off on scope.** Resolve the open questions below
   (config surface for the allowlist, default-on audit logging, tool
   name) before writing code -- delegate_designer's own history (the
   isFinalStep bug in the async work, the repeat-detection gaps) shows
   that fixing a fenced-write agent's edge cases after the fact is more
   expensive than getting the fencing right up front.
2. **Define the allowlist/deny-list config surface.** New config.js
   constants (naming TBD, e.g. `EDITOR_ALLOWED_EXTENSIONS`,
   `EDITOR_DENY_PATH_PATTERNS`) plus whatever caller-facing shape lets a
   run narrow (never widen) the default allowlist per-call. Unit test the
   allow/deny logic in isolation, before it's wired into any tool
   function -- mirrors how designer_tool_functions.js's extension check
   was built and tested independently of the agent loop.
3. **Build the tools layer** (new file, e.g.
   connectors/github/editor_tool_functions.js): read_file/write_file
   against the general GitHub write API (not the frontend-specific
   helper), enforcing guardrails #2/#3/#4 at this layer -- same "not just
   prompt instructions" posture as designer_delegate.js's file header
   insists on for its own scope. Unit test each independently of the
   agent loop (same order as delegate_designer's step 1).

   Model the write function's shape on the stress-tested, already-working
   edit_file MCP tool's two-mode design: `content` (full overwrite,
   creates the file if it doesn't exist) vs. `replacements` (targeted
   find/replace, each `find` must appear exactly once or the whole call
   is rejected and nothing is committed), mutually exclusive, with the
   replacements mode returning a unified diff. For multi-file commits
   within a single run, mirror overwrite_files' atomic all-or-nothing
   commit shape rather than inventing a new one.
4. **Build the checkpoint layer** (new file or extension of
   designer_checkpoint.js -- decide based on how much the schema actually
   needs to differ; prefer reuse per guardrail #7).
5. **Build the agent loop** (new file, e.g.
   connectors/github/editor_delegate.js), adapting
   designer_delegate.js's runDesignAgent shape: system preamble, FUNCTIONS
   closures binding owner/repo/branch, stuck-loop/repeat detection carried
   over from both existing loops, per-run/per-file write caps (guardrail
   #6). Unit test the loop independently of any MCP registration (mirrors
   delegate_designer's own step 2/"not yet wired to an MCP tool" phase).
6. **Wire the validate-before-write step** (guardrail #5) for each allowed
   file type, reusing connectors/frontend/validate.js's structure where
   file types overlap, extending it where they don't.
7. **Register the MCP tool** (new file or addition to
   connectors/github/tools.js -- decide based on whether this belongs
   alongside github's other tools or as its own connector file, matching
   how designer_tools.js sits in connectors/frontend/ rather than
   connectors/github/). Tool description must be as explicit about scope
   limits as delegate_agent's own description is about being read-only --
   the calling model needs to know from the description alone that this
   tool can only write to a non-default branch it doesn't get to choose
   past what guardrails #1/#2 allow, before it ever calls it.
8. **Audit trail wiring** (guardrail #9) -- wire up transcript/writtenFiles
   reporting per guardrail #9.
9. **Test.** End-to-end test suite covering: default-branch refusal;
   allowlist/deny-list enforcement (including the CI-workflow and
   auth-file deny cases specifically, since those are the highest-value
   guardrail to have regression coverage on); write-cap enforcement;
   checkpoint/resume; and a test asserting the tool's FUNCTIONS array
   genuinely excludes create_pull_request/merge_pull_request (guardrail
   #8's structural omission, verified rather than assumed -- same lesson
   as the async work's isFinalStep bug: a fencing claim not backed by a
   test that would fail without the fence is not a verified fence).
10. **Rollout.** Ship behind an env flag (e.g. `EDITOR_AGENT_ENABLED`),
    same reasoning as plan.md's old Scenario B rollout flag -- disable
    without a revert if real usage surfaces a guardrail gap.

## Open questions

- **Tool name.** `delegate_editor`? `delegate_write`? Something else --
  needs to read clearly as "general write access, not just frontend"
  alongside the existing delegate_agent/delegate_designer/delegate_research
  naming, per the delegation-naming-convention Notion plan referenced in
  agent_tools.js's own header.
- **Allowlist shape: extensions only, path prefixes only, or both?** Step
  2 leans toward both (guardrail #3) -- confirm before building step 3's
  enforcement logic, since retrofitting a path-prefix check onto an
  extension-only design later is more invasive than including both from
  the start.
- **Should this tool require an existing branch (caller creates it via
  create_branch first) or be allowed to create one itself?** Letting the
  agent create its own feature branch is more convenient but is itself a
  write action worth its own guardrail thought -- e.g. branch-name
  prefixing/namespacing so agent-created branches are visually
  distinguishable from human-created ones. Leaning toward requiring a
  pre-existing branch for v1 (simpler, smaller surface) and revisiting.
- **Should write caps (guardrail #6) be a fixed config constant, or a
  caller-supplied argument capped by a fixed maximum** -- same shape as
  delegate_agent's own max_steps/HARD_MAX_STEPS pattern? Leaning toward
  reusing that exact pattern for consistency.

## Progress log

(none yet -- this plan has not been implemented)
