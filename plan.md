# Plan: Limited GitHub write access for delegate_agent (non-default-branch only)

Status: LIVE as of 2026-08-28 -- EDITOR_AGENT_ENABLED now defaults to true
(step 10), so delegate_editor is registered and callable by default. This
shipped ahead of step 9's full test list (checkpoint/validate-specific unit
tests and a live end-to-end smoke test were still outstanding at flip time
-- see the step 9 and step 10 progress-log entries below) at explicit
operator request, not because those gaps were closed first. Opt out via
EDITOR_AGENT_ENABLED=false if a guardrail gap surfaces.
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

## Parallel orchestration & verification

Goal (raised 2026-08-28): let the orchestrating model (Claude) fan out
several precise, independent edit or investigation tasks at once --
delegate_editor for writes, delegate_agent for read-only investigation --
and cheaply verify each result, instead of doing the work inline and
paying full token cost for it.

This does NOT mean merging the two tools or adding a new orchestration
layer/tool. It means two things, both compatible with the plan as already
scoped:

1. **Parallel dispatch is a calling-pattern, not an architecture change.**
   Because each delegate_editor run is already fenced to a single
   repo/branch/task (guardrail #1) and each delegate_agent call is
   already independently scoped, the orchestrator can issue multiple
   calls to either tool -- or both -- in the same turn, each for a
   distinct task, with no new tool or shared-state coordination needed.
   Keeping delegate_agent read-only and delegate_editor write-capable as
   two separate tools (per the Non-goals section above) is what makes
   this safe to parallelize in the first place: each call's blast radius
   stays bounded to the one tool/repo/branch/task it was invoked for.

2. **Return contract must be compact and verifiable, not a full
   transcript, or parallelizing multiplies orchestrator token cost
   instead of reducing it.** Concretely:
   - delegate_editor calls should return a unified diff (edit_file's
     replacements mode already does this) plus an explicit pass/fail on
     guardrail #5's validate-before-write step, rather than the full
     agent transcript by default. The orchestrator can verify
     correctness from the diff + pass/fail without re-reading full file
     contents.
   - delegate_agent investigation calls should return a short, structured
     findings summary (not the full transcript) as the default response
     shape, with the full transcript available on request/for debugging
     rather than returned unconditionally.
   - This is a refinement of guardrail #9's audit-trail reporting, not a
     replacement for it: the full transcript/writtenFiles record should
     still exist for audit purposes, it just shouldn't be the thing
     returned to the orchestrator by default.

### Resolution (2026-08-28): v1 goes sequential-only

Decision: drop parallel dispatch from v1. delegate_editor calls are issued
one at a time, in order, by the orchestrator -- no simultaneous-batch
case to guard against. This directly trades away the original token-
reduction-via-parallelism motivation that opened this section; that
motivation is not abandoned, just deferred past v1 (see below). Per-item
resolution:

- **Same-branch writes.** No longer a race (nothing runs concurrently),
  but sequential is not automatically safe either: GitHub's API can have
  brief read-after-write lag right after a commit, so the orchestrator
  must re-read a file's state fresh after each commit before planning the
  next edit against it, rather than reusing pre-commit content it already
  has in context. This is a rule for the orchestrator, not a new tool-
  layer guardrail.
- **CI-gated verification: rejected.** Considered and dropped as
  unnecessary -- CI runs take real minutes, and gating each sequential
  step on CI would mean blocking/polling with a timeout/give-up path
  between every single edit, which is a lot of added latency for a
  benefit guardrail #5's validate-before-write step already covers at
  the per-file level. Self-reported pass/fail from delegate_editor,
  backed by validate(), is accepted as the v1 trust boundary. If this
  proves insufficient in practice, CI-gating can be revisited later --
  same "start narrow, widen deliberately" posture as file-type scope.
- **Write caps.** Sequential removes simultaneous-batch exposure, but a
  long sequential chain (e.g. 10 edits in a row) can still touch just as
  much total surface area, spread over time instead of at once. The
  per-turn total-files/total-writes ceiling from the earlier aggregate-
  cap question still applies -- enforced across the whole sequential
  chain, not dropped just because nothing runs concurrently.
- **Interdependent tasks.** Sequential ordering resolves this cleanly --
  no race, guaranteed order. Tradeoff: dependent edits lose any chance of
  batched/parallel token savings and pay full sequential cost (one
  commit + one verification round-trip at a time), same as independent
  tasks under this v1 design.
- **Scope.** v1 = single delegate_editor call at a time, called
  repeatedly in sequence by the orchestrator as needed. No new
  concurrency-handling code, no aggregate-batch cap mechanism, no CI
  polling. The original goal (reduce orchestrator token usage via
  simultaneous dispatch) is explicitly deferred, not solved, by this
  decision -- revisit parallel dispatch as a v2 once the sequential tool
  is built and proven, consistent with Non-goals' "start narrow, widen
  deliberately" posture.

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

- 2026-08-28: **Step 2 done.** Added the EDITOR_* config surface to
  config.js (allowed extensions, allowed path prefixes, deny-list
  patterns, per-run/per-file write caps, step budget, EDITOR_AGENT_ENABLED
  rollout flag -- currently false/no-op, since nothing reads it yet).
  Added connectors/github/editor_policy.js implementing guardrails #3 and
  #4 as plain, dependency-free functions (isPathAllowed, isPathDenied,
  touchesPackageJsonRiskyFields, and the combined isWriteAllowed callers
  should actually use), built and unit-tested in isolation with no tool or
  agent-loop wiring yet, per this doc's own step ordering. test/
  editor-policy.test.js covers both allow/deny layers, including the
  .github/workflows/** and auth-file deny cases plan.md's step 9 calls out
  specifically, plus the package.json scripts/dependencies content check.
  23/23 new tests pass; full suite (415 tests) still green.

  Deliberately NOT done yet: the actual read_file/write_file tool layer
  (step 3) doesn't call isWriteAllowed() anywhere yet -- it doesn't exist.
  No agent loop, no checkpoint, no MCP registration, no tool description.
  Next step is 3 ("Build the tools layer"), which should be the first
  thing to actually use editor_policy.js's isWriteAllowed().

  Open questions from the design doc are still open -- this step didn't
  resolve tool naming, the branch-creation question, or the write-cap
  argument-shape question, since none of those affect the policy-module
  shape.

- 2026-08-28: **Steps 3-6 done** (found already committed on this branch
  when resuming work -- this progress log just hadn't been updated to
  say so until now, which is why the status header above previously
  understated things; the code itself was never actually behind). Step 3:
  connectors/github/editor_tool_functions.js (read_file/write_file against
  the general Contents API, guardrails #2/#3/#4 enforced at this layer,
  edit_file-style content/replacements modes, unified diff builder). Step
  4: connectors/github/editor_checkpoint.js (designer_checkpoint.js's
  shape, own Redis key prefix, per guardrail #7). Step 5:
  connectors/github/editor_delegate.js (the agent loop itself --
  read_file/write_file/validate, guardrail #6 write caps enforced inside
  write_file's execute() before writeFile() is called, guardrail #8's
  FUNCTIONS array structurally omitting create_pull_request/
  merge_pull_request, stuck-loop/repeat detection and checkpoint/resume
  carried over from designer_delegate.js). Step 6:
  connectors/github/editor_validate.js (JSON/YAML/JS/TS validators + reuse
  of the frontend HTML/CSS/JSX/TSX/Vue validators) wired into
  editor_delegate.js as the loop's third tool, capped per file via
  EDITOR_MAX_VALIDATE_CALLS. Tool tests for steps 3 and 2 already existed
  (test/editor-tool-functions.test.js, test/editor-policy.test.js); steps
  4-6 had no dedicated tests yet at this point (see step 9 below).

  Still NOT done as of this entry: MCP registration (step 7) -- no
  connectors/github/editor_tools.js existed yet, and connectors/github/
  tools.js's orchestrator had no registerEditor call.

- 2026-08-28: **Step 7 done.** Added connectors/github/editor_tools.js
  (delegate_editor's MCP registration, modeled on
  connectors/frontend/designer_tools.js's wrapper shape -- same
  resume_run_id/max_steps/show_transcript conventions, same
  writtenFiles/transcript response shaping). register() self-gates on
  EDITOR_AGENT_ENABLED and is a genuine no-op (server.tool() never called)
  when the flag is off, per step 10's rollout posture -- so this commit
  does NOT make delegate_editor callable yet. Wired registerEditor(server)
  into connectors/github/tools.js's orchestrator. Tool description states
  the non-default-branch and no-PR-merge scope limits explicitly, per this
  doc's own step 7 requirement.

- 2026-08-28: **Step 9 partial.** Added test/editor-delegate.test.js
  (loop-level guardrails #2/#6/#8 -- default-branch refusal checked before
  any providerChat call on a fresh run; per-run and per-file write caps
  rejected inside write_file's execute() before writeFile() is ever
  invoked, and confirmed NOT charged against the cap when the write itself
  is rejected as a policy/conflict error; a verified, not assumed, test
  that the loop's own FUNCTIONS/declarations never include
  create_pull_request or merge_pull_request, per this doc's step 9 note
  that "a fencing claim not backed by a test that would fail without the
  fence is not a verified fence") and test/editor-tools.test.js
  (EDITOR_AGENT_ENABLED gate -- register() calls server.tool() zero times
  when the flag is unset or any non-"true" value, exactly once named
  "delegate_editor" when it's "true"; basic handler arg validation).
  While running the full suite to confirm nothing regressed, found and
  fixed one pre-existing bug: test/editor-tool-functions.test.js's
  "rejects a missing branch" case asserted against /branch is required/i,
  but editor_tool_functions.js's actual message wraps the word in
  backticks (`` `branch` is required ``), so the assertion never matched
  what it thought it was checking -- fixed the regex, not the source
  message (the source message was correct; the test's pattern was stale).
  Full suite: 33 files, 457 tests, all green; `npx eslint` clean on every
  new/changed non-test file (test/ is eslint-ignored in this repo, matching
  the pattern for every other test/*.test.js file).

  Still NOT done: checkpoint/resume-specific tests for editor_checkpoint.js
  itself (step 5/6's loop tests exercise checkpointing incidentally via the
  fakeCheckpoints mock, but there's no dedicated editor-checkpoint.test.js
  mirroring test/agent-checkpoint.test.js), no dedicated
  editor-validate.test.js, and no live end-to-end smoke test against a real
  (non-default) branch -- step 9's list also calls for checkpoint/resume
  coverage specifically, which this pass only partially addresses via the
  loop tests.

- 2026-08-28: **Step 10 done, ahead of the rest of step 9.** Flipped
  EDITOR_AGENT_ENABLED's default from off to on (config.js: was
  `=== "true"`, now `!== "false"`) at explicit operator request made
  directly in conversation, not because the outstanding step 9 gaps above
  were closed first -- they were not. delegate_editor is now registered on
  every server start unless an operator explicitly sets
  EDITOR_AGENT_ENABLED=false, which remains the fast "disable without a
  revert" path (same as DELEGATE_AGENT_ASYNC's rollout posture elsewhere in
  this repo) if a guardrail gap surfaces in practice. Every guardrail #1-#9
  in this doc is still enforced in code exactly as before -- this flip only
  changes whether the tool is reachable at all, not what it's allowed to do
  once reached. No new tests were added as part of this flip itself; the
  step 9 gaps noted above (checkpoint/validate unit tests, live end-to-end
  smoke test) are now outstanding against a LIVE tool rather than a
  registered-but-disabled one.

- 2026-08-28: **Merged to main.** CI (`verify` workflow) was red on the
  first push after the EDITOR_AGENT_ENABLED default flip above --
  test/editor-tools.test.js still asserted the OLD default-off gate
  behavior ("registers no tool when unset"), which broke the moment the
  default became on. Fixed the gate tests to match the new `!== "false"`
  semantics (unset or any non-"false" value -> registered; only the
  literal string "false" -> not registered), confirmed 458/458 tests green
  locally, waited for CI to go green on the fix (run 33198146495), then
  opened PR #111 and merged it (squash-free merge commit e9da514). This
  doc (plan.md) is now on main at this path.

  **Post-merge verification (via delegate_agent):** confirmed this
  branch's 24 commits + the merge commit never touched any
  codespaces-related file -- connectors/github/codespaces.js and
  test/github-codespaces.test.js do not appear in any commit's diff or in
  PR #111's file-change list. The branch's entire footprint was the new
  delegate_editor files (config.js, connectors/github/editor_*.js,
  connectors/github/tools.js, plan.md, test/editor-*.test.js) plus the one
  test-regex fix in test/editor-tool-functions.test.js noted above --
  nothing outside that scope, codespaces tooling included, was modified.

  Still NOT done, now tracked against main rather than the feature branch:
  dedicated editor_checkpoint.js/editor_validate.js unit tests, and a live
  end-to-end smoke test against a real non-default branch (step 9's
  original list).

- 2026-08-28: **Confirmed gap: no path-prefix allowlist, only extension
  allowlist + curated deny-list.** Manually tested delegate_editor against
  a scratch repo (allocsys/editor-guardrail-tests) to check guardrails #2-#4
  and #8 empirically rather than just reading the code. Everything the
  guardrails explicitly cover held up: default-branch write refused before
  any tool call; .github/workflows/** refused (blocked even at read_file,
  stricter than documented); connectors/github/app_auth.js refused (also
  blocked at read); package.json's `dependencies` field refused at
  write_file with the exact "requires an explicit override flag (not yet
  implemented)" message step 3's code already returns; a non-allowlisted
  extension (.py) refused; a legitimate .js edit succeeded cleanly in 2
  steps; asking it to open/merge a PR was correctly declined as outside its
  tool set (guardrail #8).

  But this doc's own "Open questions" section flagged a real gap that was
  never closed: "Allowlist shape: extensions only, path prefixes only, or
  both? Step 2 leans toward both." What shipped is extension-only, per
  delegate_editor's own tool description ("no additional path restriction
  beyond the deny list"). Confirmed concretely with two fixtures that have
  an allowed extension and are NOT on the deny-list:
  - connectors/payments/client.js (a made-up credential-adjacent file, .js,
    not one of the three deny-listed auth files) -- delegate_editor read it,
    edited it, and committed the change with zero resistance.
  - infra/deploy.yml (a made-up deploy/infra config, .yml, not under
    .github/workflows/**) -- same result, edited and committed cleanly.

  So today's guardrail #4 is a curated blocklist of specific paths someone
  thought to name (security.js, app_auth.js, clone_token.js, CI workflows),
  not a positive fence. Any other backend file with an allowlisted
  extension -- payments code, infra/deploy config, other secrets-adjacent
  files not on the named list -- is writable with no guardrail resistance
  at all. This is exactly the risk guardrail #3's original text warned
  about ("an extension check alone doesn't stop a write to e.g.
  .github/workflows/*.yml or server.js just because .yml or .js happens to
  be in the allowlist") but the path-prefix half of guardrail #3 was never
  implemented -- only the deny-list half (guardrail #4) shipped, and it's
  necessarily incomplete as a substitute for a positive allowlist.

  Not yet done: deciding and implementing the path-prefix allowlist shape
  (glob patterns vs. caller-supplied prefix list, per the original open
  question), and expanding test coverage (test/editor-policy.test.js,
  test/editor-tool-functions.test.js) to include credential-adjacent and
  infra-config cases like the two fixtures above, not just the
  currently-covered CI-workflow and named-auth-file cases.

- 2026-08-28: **Known bug: failed/errored delegate_agent calls (the
  read-only investigation tool, connectors/gemini/agent_delegate.js --
  NOT delegate_editor/delegate_designer/delegate_research, which are a
  separate concern even though they share the same show_transcript-on-
  failure pattern and could plausibly get the same fix later) always dump
  the full step-by-step transcript on failure/partial runs, regardless of
  `show_transcript` (per the tool's own description: "On a failed/partial
  run the transcript is always shown regardless of this flag"). For a
  caller making several delegate_agent investigation calls in a row (e.g.
  this doc's own "Parallel orchestration & verification" section's
  point 2, which specifically calls for delegate_agent investigation
  calls to "return a short, structured findings summary (not the full
  transcript) as the default response shape, with the full transcript
  available on request/for debugging rather than returned
  unconditionally"), a failed or erroring call currently costs full
  transcript-sized context every time, not just on success -- the exact
  gap that section already anticipated but didn't close for the failure
  path specifically.

  Raised fix (2026-08-28 conversation): on failure/error, respond with
  something like "check back a little later" instead of the transcript,
  to cut the context bloat.

  Concern with that specific framing, flagged before implementing: these
  calls are synchronous -- by the time a response comes back, the run has
  already finished or failed, there is no background job still in flight
  to "check back" on. "Check back a little later" implies an async/
  pollable job model this tool doesn't have (resume_run_id exists, but it
  requires the orchestrator to explicitly re-invoke with that id, not
  passively wait and re-check). Shipping that literal phrasing risks
  misleading a future caller (human or the orchestrating model) into
  believing there's a poll-for-completion pattern to use.

  Better-fitting fix, consistent with this doc's existing compact-
  response posture for the success path: make the failure/error response
  compact by default too -- a short structured error/status summary
  (what step it got to, what failed, resume_run_id if resumable) -- and
  make `show_transcript` (or an equivalent) actually honored on the
  failure path instead of being unconditionally overridden, rather than
  introducing new "come back later" language for a call that already
  completed. Not yet implemented; this entry records the gap and the
  framing concern, not a shipped fix.

- 2026-08-28: **Fix landed on this branch, then CI-verified and corrected.**
  connectors/gemini/agent_tools.js's `result.failed` branch (the
  synchronous failed/partial path) now returns a compact structured
  summary by default -- step count, reason/error, `resume_run_id`
  ("not resumable" when there isn't one) -- and only appends the full
  tool-call transcript when `show_transcript` is explicitly true,
  replacing the old unconditional transcript dump described above.

  Two problems surfaced getting this green, both now fixed:

  1. **Unintended scope creep.** The same commit that fixed the
     `result.failed` branch also changed the async poll branch ("Still
     running (run_id: ...)", the `checkpoint.status === "running"` /
     fresh-lastStepAt case) to gate its transcript inclusion on
     `show_transcript` too. That branch was never part of the bug this
     doc described -- the bug was specifically about failed/partial
     *completed* runs, not an in-progress poll -- and the change broke
     test/agent-tools-async.test.js's existing "poll with a fresh
     checkpoint" case, which asserts (and still asserts, unchanged) that
     the transcript is included by default while polling. Reverted that
     one branch back to unconditional inclusion, matching main and
     leaving the poll path's behavior untouched -- only the
     `result.failed` branch actually changes as part of this fix.
  2. **Broken test mocks.** test/agent-delegate-loop.test.js (added
     alongside the fix) used `vi.spyOn(import("...agent_delegate.js"),
     "runInvestigation")` to stub the dependency -- this doesn't work
     under Vitest's ESM handling (each `import()` call returns a fresh
     Promise/namespace object with non-configurable exports, so spyOn
     can't attach), and CI failed both cases with "The property
     'runInvestigation' is not defined on the object." Replaced with
     `vi.mock("../connectors/gemini/agent_delegate.js", ...)` (plus
     mocking agent_checkpoint.js/qstash_client.js/notion/tools.js, the
     rest of agent_tools.js's dependencies), matching the pattern
     test/agent-tools-async.test.js already established. Also fixed the
     handler lookup itself -- `server.tool(name, description, schema,
     handler)` puts the handler at argument index 3, not 2 (index 2 is
     the non-callable zod schema) -- by switching to the same
     tools-by-name fake-server helper agent-tools-async.test.js uses,
     rather than hardcoding an index.

  CI (`verify` workflow) is green on this branch as of run 33203532631.

- 2026-08-28: **Added regression/edge-case test coverage**, still on this
  branch, before opening the PR. test/agent-delegate-loop.test.js gained
  three cases:
  1. A failed result with no `runId` renders "Resumable: not resumable"
     (the compact summary's other branch, previously untested).
  2. Two poll-branch regression tests pin the async "still running" poll
     response's transcript to stay unconditional (included regardless of
     `show_transcript`) -- direct coverage against the exact scope-creep
     mistake found and reverted earlier in this doc's log (gating that
     unrelated branch on `show_transcript`), so it can't silently
     reappear. Required mocking config.js per-test (`DELEGATE_AGENT_ASYNC:
     "qstash"`) via vi.doMock + vi.resetModules, since the file's other
     describe block relies on real config.js's "sync" default and never
     reaches the async poll branch at all.
  Refactored the file's qstash/checkpoint mocks from inline arrow
  functions into named top-level vi.fn()s (mockIsQStashConfigured,
  mockLoadCheckpoint) so both describe blocks configure them
  independently without redeclaring the mock factories. CI green as of
  run 33206840740.

- 2026-08-28: **Merged to main.** Opened and merged the PR for this
  branch's compact-failure-response fix (result.failed branch of
  delegate_agent now returns a compact structured summary by default,
  full transcript only on explicit show_transcript:true), the poll-branch
  revert, and the test coverage logged above. Not yet done: none --
  this branch's scope is complete.
