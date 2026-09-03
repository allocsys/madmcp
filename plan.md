# Decouple Gemini delegation from other LLM providers

## Goal
`delegate_agent` and `delegate_editor` currently live inside `connectors/gemini/`,
even though the loop logic (checkpointing, tool-call dispatch, worker chaining)
is provider-agnostic and already branches out to bai/glm/groq via
`connectors/llm/router.js`. This means debugging or changing bai-specific
behavior (e.g. `HISTORY_COMPACTION_PROVIDERS`, the bai forced-final-step
`reasoningEffort` handling) currently requires editing files under
`connectors/gemini/`, which is misleading and couples the two concerns.

Non-goal: we are NOT removing bai/glm/groq support. Gemini stays the default
and only fully-wired provider; other providers keep working exactly as they
do today, but their code no longer lives inside (or has to be touched inside)
the gemini directory. Each non-gemini provider also gets its own enable flag
so it can be turned off independently without touching gemini code.

## Why both connectors/llm/ AND connectors/delegate/ (not redundant)
These are two different layers, not two names for the same thing:
- `connectors/llm/` (router.js, cascade_log.js) = the PROVIDER DISPATCH
  layer -- "given a provider name, how do I actually call it and get back a
  Gemini-shaped candidate". No looping, no checkpointing, no tool-call
  bookkeeping. Already correctly neutral (step 1 confirmed all three loops
  share it).
- `connectors/delegate/` (new) = the AGENT LOOP layer -- "run N steps of
  tool-calling, checkpoint between steps, chain a background worker" --
  built ON TOP of `providerChat()` from `connectors/llm/`, not a
  replacement for it.
`connectors/delegate/*` will import from `connectors/llm/router.js`, same
as today; the dependency direction doesn't change, only where the loop
files themselves live. Confirmed during step 1 that all three delegate
loops (agent/gemini, editor, designer) already share router.js -- this
plan keeps that shared layer as-is and only consolidates the loops that
sit above it.

## Consolidation scope: all three delegate loops, not just agent+editor
Step 1 also found that `connectors/frontend/designer_delegate.js` /
`designer_checkpoint.js` / `designer_tools.js` (backing `delegate_designer`)
are structurally the SAME kind of thing as the agent/editor loops --
step-bounded, checkpointable, providerChat-driven tool-calling loop, just
write-scoped to frontend files instead of read-only or general-repo-write.
The file-header comments in designer_delegate.js/designer_tools.js already
say explicitly that they were modeled on connectors/gemini's loop. So this
refactor folds delegate_designer's LOOP files into `connectors/delegate/`
too, for the same reason as editor: nobody debugging or changing the
designer loop's checkpointing/step-cap/resume behavior should need to
understand or touch connectors/gemini/, and vice versa.

NOT moving: `designer_tool_functions.js` and `validate.js` stay in
`connectors/frontend/` -- these are the DOMAIN-SPECIFIC tool
implementations (frontend file-extension allowlist, HTML/CSS/SCSS
validation), analogous to how editor's own read/write/policy logic stays
in `connectors/github/` rather than moving into `connectors/delegate/`.
Only the generic loop scaffolding moves; the concrete tools a given loop
calls stay with their domain.

## Target layout after this refactor
```
connectors/
  llm/            <- provider dispatch only (router.js, cascade_log.js) -- unchanged
  delegate/
    qstash_client.js        <- shared by agent + editor async chains (designer is sync-only, confirmed step 1)
    agent/                  <- was connectors/gemini/{agent_delegate,agent_checkpoint,agent_worker,agent_tools}.js
    editor/                 <- was connectors/github/{editor_delegate,editor_checkpoint,editor_worker,editor_tools}.js
    designer/                <- was connectors/frontend/{designer_delegate,designer_checkpoint,designer_tools}.js
  gemini/         <- client.js only (Gemini API wrapper)
  bai/ glm/ groq/  <- unchanged, each provider's own client.js (+ new delegate_hooks.js for bai, step 4)
  github/          <- domain tools (files.js, files write policy, etc.) minus the editor loop
  frontend/        <- designer_tool_functions.js, validate.js (domain tools) minus the designer loop
```

## Sequential steps

1. **Inventory & freeze current behavior** ✅ DONE

   Files that WILL move (all currently under connectors/gemini/):
   - agent_delegate.js
   - agent_checkpoint.js
   - agent_worker.js
   - agent_tools.js
   - qstash_client.js (step 2a)

   Confirmed consumers of each, by direct import (not just comment mentions):

   | Moving file | Imported by |
   |---|---|
   | agent_delegate.js | agent_tools.js, agent_worker.js; tests: agent-delegate-async-checkpoint, agent-delegate-loop (mocked), agent-resultcache-resume, agent-tool-call-leakage, agent-worker-tool-withholding-regression, agent-worker.test, history-compaction.test |
   | agent_checkpoint.js | agent_delegate.js, agent_tools.js, agent_worker.js; tests: agent-checkpoint, agent-delegate-async-checkpoint, agent-delegate-loop (mocked), agent-worker-tool-withholding-regression, agent-worker.test |
   | agent_worker.js | server.js (`handleAgentWorker`, `handleAgentWorkerFailure`); tests: agent-worker.test (direct) |
   | agent_tools.js | server.js (`import * as agent`); tests: agent-delegate-loop, agent-seedrun-max-steps-regression, agent-tools-async |
   | qstash_client.js | agent_tools.js, agent_worker.js (same dir, relative import) **and** `connectors/github/editor_tools.js` (`from "../gemini/qstash_client.js"`) **and** `connectors/github/editor_worker.js` (same import, missed in this table originally) **and** server.js (`isQStashConfigured`, `isEditorQStashConfigured`); tests: agent-delegate-loop (mocked), agent-worker.test (mocked), editor-worker.test (mocked), qstash-client-publish.test (direct), **and** agent-tools-async.test.js / editor-tools-async.test.js (both via `vi.doMock`, not `vi.mock` -- missed in this table originally, caught only during step 2a's actual execution by a follow-up repo-wide grep after the first edit pass) |

   Confirmed NOT moving / already correctly neutral (no change needed):
   - `connectors/llm/router.js` — already shared by designer_delegate.js, agent_delegate.js, AND editor_delegate.js. Good home already.
   - `connectors/shared/cooldown.js` (Redis) — already shared by every provider client.js plus both checkpoint modules.
   - `connectors/frontend/designer_delegate.js` / `designer_tool_functions.js` — only reference agent_delegate.js in comments as a design pattern they parallel; NOT an actual import, so there's no broken-import coupling to fix for designer. (It's still in scope for the move in step 3b below, for structural consistency -- see "Consolidation scope" section above -- just not because anything is currently cross-importing gemini/ code.)

   Designer loop files and their consumers (for step 3b):

   | File | Imported by |
   |---|---|
   | designer_delegate.js (`runDesignAgent`) | designer_tools.js |
   | designer_checkpoint.js | designer_delegate.js, designer_tools.js |
   | designer_tools.js | server.js (`import * as frontend`) |

   designer_tool_functions.js and validate.js are NOT moving (domain-specific tools, see "Consolidation scope" above) -- confirmed designer_delegate.js imports `readFile, writeFile, validate` from designer_tool_functions.js, which stays in connectors/frontend/.

   Cross-directory import confirmed as the concrete coupling to fix: `connectors/github/editor_tools.js` currently imports `qstash_client.js` via a `../gemini/` relative path — this is the literal case of "can't touch bai/editor async plumbing without reaching into connectors/gemini/" the whole plan exists to fix.

   Editor-side files (already outside connectors/gemini/, confirmed for completeness, no move needed):
   - `connectors/github/editor_delegate.js` — imported by editor_worker.js, editor_tools.js; tests: editor-delegate-async-checkpoint, editor-delegate.test (mocked), editor-tools.test (mocked), editor-worker.test
   - `connectors/github/editor_checkpoint.js`, `editor_tools.js`, `editor_worker.js` — all already in connectors/github/, no move planned (step 3 only fixes their qstash_client.js import path)

   No code changes made in this step.

2. **Move the read-only agent loop out of connectors/gemini/** ✅ DONE
   - Move `agent_delegate.js`, `agent_checkpoint.js`, `agent_worker.js`,
     `agent_tools.js` to a new neutral home: `connectors/delegate/agent/`.
   - Update all imports across the repo (server.js, tests, etc.) to the new
     paths.
   - `connectors/gemini/` keeps only `client.js` (the actual Gemini API
     wrapper) and anything strictly Gemini-request-shaped.
   - DONE NOTE: the file moves and most import updates were already present
     on the branch when this step was picked up; the one gap found was
     `test/history-compaction.test.js`, which still had 7 stale dynamic
     imports (`await import("../connectors/gemini/agent_delegate.js")` /
     `agent_checkpoint.js`) left over from before the move. Fixed and
     verified with a repo-wide `search_code` sweep for both old paths.

2a. **Move qstash_client.js to the neutral delegate dir** ✅ DONE
   - CONFIRMED not Gemini-specific: it already backs BOTH the agent worker
     chain (`publishAgentStep`, `AGENT_WORKER_URL`) and the editor worker
     chain (`publishEditorStep`, `EDITOR_WORKER_URL`) side by side, and its
     own file header notes it's the same Upstash account as Redis
     checkpointing, just a different product (QStash vs Redis).
   - Move `connectors/gemini/qstash_client.js` -> `connectors/delegate/qstash_client.js`
     (one shared file, not agent/editor-split, since it already serves both).
   - Update imports in `agent_worker.js`, `agent_tools.js`, `editor_worker.js`,
     `editor_tools.js`, and any tests that mock this module's path.
   - DONE NOTE: moved via `rename_file`, then repointed all 5 production
     consumers (server.js, agent_tools.js, agent_worker.js, editor_tools.js,
     editor_worker.js) plus 7 test files. A first pass caught 5 test files
     (agent-worker.test.js, editor-worker.test.js, agent-delegate-loop.test.js,
     qstash-client-publish.test.js's 4 dynamic imports); a follow-up
     repo-wide `search_code` for `gemini/qstash_client` turned up 2 more
     (`agent-tools-async.test.js`, `editor-tools-async.test.js`, both using
     `vi.doMock` rather than `vi.mock`, which the first pass's targeted
     reads had missed) plus a stray explanatory comment in editor_worker.js.
     Final sweep confirmed zero remaining references outside this plan's own
     frozen step-1 inventory tables, and `connectors/gemini/` now contains
     only `client.js`.
   - Note for contrast: `connectors/shared/cooldown.js` (Upstash Redis,
     backs checkpointing) is ALREADY correctly neutral -- it lives under
     `connectors/shared/` and is imported directly by every provider's own
     client.js (gemini/glm/groq/bai) plus the agent/editor checkpoint
     modules. No move needed there, just confirm during step 9 that nothing
     new accidentally reintroduces a gemini-specific Redis path.

3. **Move the editor loop to connectors/delegate/editor/** ✅ DONE
   - Move `connectors/github/editor_delegate.js`, `editor_checkpoint.js`,
     `editor_worker.js`, `editor_tools.js` to `connectors/delegate/editor/`.
   - Fix the confirmed `../gemini/qstash_client.js` import (step 1) to point
     at `connectors/delegate/qstash_client.js` instead.
   - `connectors/github/` keeps only domain tools (files.js, GitHub API
     client, write-policy/deny-list logic, etc.) -- nothing loop-shaped.
   - Update all imports across the repo (server.js, tests, etc.) to the new
     paths.
   - DONE NOTE: the four files had already been moved to
     `connectors/delegate/editor/` on the branch, but two functional bugs
     from that move were still live: `editor_tools.js` imported
     `qstash_client.js` via `../delegate/qstash_client.js` (double
     `delegate/`, since the file itself now already lives under
     `connectors/delegate/`) and imported `config.js` via `../../config.js`
     (one level short of repo root from the new location) -- both would have
     thrown at import time. Fixed to `../qstash_client.js` and
     `../../../config.js` respectively. Also fixed the stale consumer
     imports left pointing at the old `connectors/github/` location:
     `server.js` (`handleEditorWorker`/`handleEditorWorkerFailure`) and
     `connectors/github/tools.js` (`registerEditor`). Updated every
     mocked/dynamic-import path in the five affected test files
     (`editor-delegate.test.js`, `editor-delegate-async-checkpoint.test.js`,
     `editor-tools.test.js`, `editor-tools-async.test.js`,
     `editor-worker.test.js`) and cleaned up stale header-comment paths in
     the four moved files plus an example path string in
     `agent-tool-call-leakage.test.js` via `delegate_editor`. Verified with a
     repo-wide `search_code` sweep for `await import("../connectors/github/editor_`,
     `vi.mock("../connectors/github/editor_`, and
     `vi.doMock("../connectors/github/editor_` -- zero functional hits
     remain (only cosmetic prose mentions and this plan's own frozen step-1
     inventory tables). Confirmed `connectors/github/` now contains only the
     three domain-tool files (`editor_policy.js`, `editor_tool_functions.js`,
     `editor_validate.js`) plus everything unrelated to the editor loop, with
     no duplicate loop files left behind.

3b. **Move the designer loop to connectors/delegate/designer/** ✅ DONE
   - Move `connectors/frontend/designer_delegate.js`, `designer_checkpoint.js`,
     `designer_tools.js` to `connectors/delegate/designer/`.
   - Leave `designer_tool_functions.js` and `validate.js` in
     `connectors/frontend/` -- domain-specific tools, not loop scaffolding
     (see "Consolidation scope" section above). Update designer_delegate.js's
     import of `readFile, writeFile, validate` to the new relative path back
     into `connectors/frontend/`.
   - Update server.js's `import * as frontend from "./connectors/frontend/designer_tools.js"` to the new path.
   - No qstash_client.js involvement here -- designer confirmed sync-only
     (no worker/async file exists under connectors/frontend/ today).
   - DONE NOTE: moved all three files via create+delete (content identical
     apart from import paths). Fixed imports in the moved files:
     designer_delegate.js now pulls `providerChat` from `../../llm/router.js`,
     `readFile/writeFile/validateFile` from `../../frontend/designer_tool_functions.js`,
     `isRedisConfigured` from `../../shared/cooldown.js`, `githubRequest` from
     `../../github/client.js`, and config from `../../../config.js`;
     designer_checkpoint.js's `getRedis` import updated to `../../shared/cooldown.js`;
     designer_tools.js's config import updated to `../../../config.js` (its
     same-dir import of designer_delegate.js needed no change). Updated the
     one production consumer (server.js's `import * as frontend`) and the one
     test file with real (non-cosmetic) references to the moved paths
     (test/frontend-agent-loop.test.js's `vi.mock` of designer_checkpoint.js
     and its `import` of runDesignAgent from designer_delegate.js) --
     test/frontend-agent-tools.test.js only imports designer_tool_functions.js/
     validate.js, which didn't move, so it needed no change. Verified with a
     repo-wide `search_code` sweep for the old paths afterward: zero
     functional hits remain, only cosmetic prose mentions in files that
     weren't touched by this move (editor_delegate.js, editor_policy.js,
     editor_checkpoint.js, this plan's own frozen step-1 inventory tables,
     and comments inside the moved/updated files themselves) -- left alone,
     same precedent as step 3's own sweep. Confirmed `connectors/frontend/`
     now contains only `designer_tool_functions.js` and `validate.js`.

4. **Extract provider-specific hooks out of the shared loop** ✅ DONE
   - `HISTORY_COMPACTION_PROVIDERS` gating and the bai `reasoningEffort`
     forced-final-step logic move out of the (now-neutral) loop file into a
     small per-provider hooks module (e.g. `connectors/bai/delegate_hooks.js`),
     called from the neutral loop via a lookup keyed on `provider`, so
     editing bai's behavior means editing bai's own files only.
   - DONE NOTE: added two new files rather than one, matching the plan's
     own target-layout note ("+ new delegate_hooks.js for bai, step 4" --
     only bai, not glm/groq, since neither has any delegate-loop-specific
     behavior to extract):
     - `connectors/bai/delegate_hooks.js` -- `baiDelegateHooks` exports
       `historyCompactionEnabled` (still resolved from config.js's
       operator-configurable `HISTORY_COMPACTION_PROVIDERS` env var --
       that env var itself stayed in config.js as ordinary shared config,
       per config.js's own "central place for all environment variables"
       header; only the *consumption* of it for bai specifically moved
       into bai's own file) and `getReasoningEffort(isFinalStep)` (the
       `"low"`-on-forced-final-step logic, unchanged in behavior).
     - `connectors/delegate/provider_hooks.js` -- the neutral lookup
       (`getDelegateHooks(provider)`), registry-mapping `"bai"` to
       `baiDelegateHooks` and falling through to a `DEFAULT_HOOKS` (both
       flags off/undefined) for every other provider. This is the one file
       that imports `connectors/bai/delegate_hooks.js` by name -- kept
       neutral-side (`connectors/delegate/`) rather than inside
       `connectors/bai/`, since a lookup keyed across all providers
       importing one specific provider's module the other direction would
       invert the dependency the whole plan exists to fix.
   - In `connectors/delegate/agent/agent_delegate.js`: replaced the
     `HISTORY_COMPACTION_PROVIDERS` import from config.js with
     `getDelegateHooks` from the new neutral lookup; `compactHistoryInPlace`'s
     `isEnabled` check and the forced-final-step `reasoningEffort` line both
     now call `getDelegateHooks(provider)...` instead of referencing
     `HISTORY_COMPACTION_PROVIDERS` or the literal string `"bai"` directly.
     Updated the two nearby comments that explained the old direct checks to
     describe the new lookup instead. No behavior change intended or
     observed -- confirmed via the existing (unmodified)
     `test/agent-delegate-bai-reasoning-effort.test.js` and
     `test/history-compaction.test.js`, both of which call the real
     `agent_delegate.js`/`agent_checkpoint.js` (unmocked, config.js unmocked
     in both) and already covered the bai-enabled/gemini-disabled behavior
     this refactor needed to preserve exactly.
   - Confirmed via repo-wide `search_code` sweep for `HISTORY_COMPACTION_PROVIDERS`
     afterward: only config.js (the env var's own definition) and
     connectors/bai/delegate_hooks.js (its one remaining consumer) reference
     it -- agent_delegate.js no longer imports or checks it directly.

5. **Add explicit per-provider enable flags** ✅ DONE
   - `BAI_ENABLED`, `GLM_ENABLED`, `GROQ_ENABLED` in config.js, default
     matching current behavior (on, since they're already reachable).
   - `router.js` checks the flag before dispatching to that provider and
     throws a clear config error if disabled, rather than silently
     misbehaving.
   - `BAI_ENABLED=false` (etc.) must not require touching anything under
     `connectors/gemini/` or the neutral delegate loop.
   - DONE NOTE: found already fully implemented on the branch when this
     step was picked up -- no code changes needed, just verification.
     `config.js` defines all three flags (`GLM_ENABLED`, `GROQ_ENABLED`,
     `BAI_ENABLED`), each `process.env.X_ENABLED !== "false"` (default on).
     `connectors/llm/router.js` has an `assertProviderEnabled(provider,
     enabled)` helper called at the top of the glm/groq/bai branches of
     `providerChat()`, before any client call or key lookup, throwing
     `Provider "X" is disabled (X_ENABLED=false). Set X_ENABLED=true (or
     unset it) to re-enable, or choose a different provider.` -- a clear
     config error rather than a bad/missing API key failing obscurely deep
     inside that provider's client. Gemini has no flag of its own (stays
     the always-on default/fallback branch), and neither `router.js`'s
     changes nor the flags themselves touch `connectors/gemini/` or any
     file under `connectors/delegate/` -- confirmed via `search_code` for
     `ENABLED` across the repo, only hits are the three config.js
     definitions and their three router.js call sites.

6. **Update delegate_agent / delegate_editor tool schemas** ✅ DONE
   - No change to the `provider` enum (`["gemini", "bai"]`) unless we decide
     to also expose glm/groq at the tool layer -- out of scope here.
   - Confirm error messaging when a disabled provider is requested is clear
     and surfaces to the caller.
   - DONE NOTE: verification only, no code changes needed. Confirmed both
     `connectors/delegate/agent/agent_tools.js` and
     `connectors/delegate/editor/editor_tools.js` already declare
     `provider: z.enum(["gemini", "bai"]).optional()` unchanged (no glm/groq
     exposure). Traced the call path for both: `providerChat()` (which
     throws `assertProviderEnabled`'s error, step 5) is called inside a
     `try/catch` in each loop's per-step block
     (`connectors/delegate/agent/agent_delegate.js`,
     `connectors/delegate/editor/editor_delegate.js`) -- a disabled-provider
     error is caught there, checkpointed, and returned as e.g. `(Gemini call
     failed on step N: Provider "bai" is disabled (BAI_ENABLED=false)....
     failed: true)`, which the tool-layer handler (`agent_tools.js`/
     `editor_tools.js`) surfaces to the caller as `isError: true` with the
     full message text intact. No gap found -- both tools already surface a
     clear, actionable error for a disabled provider.

7. **Update tests** ✅ DONE
   - Move/rename test files to match new module locations
     (`test/agent-delegate*.test.js`, `test/editor-delegate*.test.js`,
     designer's equivalents if any exist under test/, etc.) and fix every
     mocked/imported path found in step 1's consumer tables (including the
     designer table added in step 1).
   - Add coverage for the new enable-flag behavior (disabled provider ->
     clear error, gemini unaffected).
   - DONE NOTE: renaming turned out to be a non-issue -- every test file
     under `test/` was already named by feature (`agent-*.test.js`,
     `editor-*.test.js`, `frontend-agent-*.test.js`), never by the old
     `gemini`/`github` module path, so nothing needed renaming. The real
     work was (1) actually running the suite, which earlier steps' static
     `search_code` sweeps hadn't caught, and (2) new coverage:
     - Found and fixed 7 genuinely stale (non-cosmetic) dynamic-import/mock
       lines left over from steps 2/2a's `connectors/gemini/agent_*` ->
       `connectors/delegate/agent/agent_*` move, in two files:
       `test/agent-worker.test.js` (6 lines -- 2 inline `runInvestigation`
       imports mid-test, plus a 3-line `beforeEach` block in the
       `handleAgentWorkerFailure` describe importing `agent_worker.js`/
       `agent_delegate.js`/`agent_checkpoint.js` from the old path, plus one
       stale header comment) and `test/agent-oversized-step-cap.test.js`
       (1 line, its second test's `runInvestigation`/`MAX_TOOL_CALLS_PER_STEP`/
       `MAX_STEP_RESULT_CHARS` import). Confirmed these were real breakage,
       not just staleness: `npx vitest run` on a clean local checkout of
       this branch failed both files with `Cannot find module
       '/connectors/gemini/agent_delegate.js'` (and the same for
       `agent_worker.js`/`agent_checkpoint.js`) before the fix, plus two
       confusing swapped-looking `chained`/`done` assertion failures in
       `agent-worker.test.js` that turned out to be pure cascade noise from
       the earlier broken import in the same file, not a real bug.
     - Added a new `describe("connectors/llm/router.js — per-provider
       enable flags (step 5)")` block to `test/llm-router.test.js` (6 new
       tests): GLM_ENABLED/GROQ_ENABLED/BAI_ENABLED each false ->
       `providerChat` rejects with the exact `Provider "X" is disabled
       (X_ENABLED=false)...` message and the corresponding client
       (`glmChat`/`groqChat`/`baiChat`) is never called; gemini stays
       reachable (explicit `provider: "gemini"` and the no-`provider`
       default) even with all three others disabled at once; and a final
       regression check that GLM_ENABLED reverts to its real default once
       the per-test `vi.doMock("../config.js", ...)` override is torn down
       in `afterEach`, confirming the mock isn't sticky across tests. Each
       test mocks only the one flag under test via `vi.importActual` +
       override, so the file's existing dispatch tests (which rely on the
       real, all-enabled default) are untouched.
     - Verified via a fresh, from-scratch clone of this exact branch (not
       just the working copy these edits were made in) plus `npm install`
       and `npx vitest run`: **47/47 test files, 573/573 tests pass.**
     - Final repo-wide sweep (`grep` across `test/`, `connectors/`,
       `server.js`) for every old path pattern from step 1's tables found
       zero remaining functional references -- only cosmetic prose/header
       comments (files explaining their own lineage, e.g. "Adapts
       connectors/frontend/designer_delegate.js's shape") and the
       `agent-tool-call-leakage.test.js` example path strings, matching the
       same precedent steps 2/3/3b's own sweeps already established for
       leaving those alone.

8. **Docs** ✅ DONE
   - Update README.md / docs/ if they reference `connectors/gemini/` paths
     for the delegation loop.
   - DONE NOTE: swept README.md and docs/ (`API_KEYS.md`, `demo.html`,
     `env.html`) via `search_code` for `connectors/gemini`. README.md and
     the two HTML files don't reference module paths at all -- README
     discusses the Gemini delegation feature conceptually (env vars, tool
     names, behavior), never a file path. Found one genuinely stale
     reference in `docs/API_KEYS.md`'s Upstash Redis entry: it credited
     cooldown persistence to `connectors/gemini/cooldown.js`, which hasn't
     been the real path since before this refactor even started (it's
     `connectors/shared/cooldown.js`, already confirmed provider-neutral
     back in step 2a's notes -- shared by Gemini/GLM/Groq/B.AI's clients
     plus both checkpoint modules). Fixed the path and reworded the
     sentence to credit all four providers instead of just Gemini, so the
     doc now matches what step 2a already established about that file.
   - FOLLOW-UP (comment audit, requested separately after step 8's doc
     sweep): swept the whole repo for stale self-referencing headers and
     cross-module comments left over from steps 2/3/3b's moves -- not just
     docs/. Found and fixed ~25 stale path references across
     connectors/delegate/agent/*, connectors/delegate/editor/*,
     connectors/delegate/designer's siblings' comments, connectors/gemini/client.js,
     connectors/github/files.js, connectors/github/editor_policy.js,
     connectors/shared/cooldown.js, connectors/shared/rate-limit.js,
     connectors/frontend/designer_tool_functions.js, connectors/delegate/qstash_client.js,
     server.js, config.js, and five test/ files. editor_delegate.js alone
     had 8 separate stale mentions of the pre-move connectors/gemini/agent_delegate.js
     path. Left alone: bare mentions with no accompanying path (can't be
     stale the same way), connectors/gemini/client.js references (that file
     never moved), research_delegate.js's explicitly-historical framing
     ("from when this file lived under connectors/gemini/"), plan.md's own
     frozen step-1 tables, and one test-fixture string in
     agent-tool-call-leakage.test.js. Verified clean via a final
     repo-wide search_code sweep of every old path pattern.
   - FOLLOW-UP 2 (behavioral comment-drift audit, requested separately
     after the path-staleness sweep above): delegated a `delegate_agent`
     investigation (run_id c4b05c33-9fb3-49c6-9e17-926421bc5aba) across the
     files not yet fully manually audited, scoped specifically to genuine
     comment-vs-code BEHAVIORAL drift (wrong default, wrong gating
     condition, wrong control flow, a nonexistent function/variable name) --
     not path staleness, already covered above. It reported 3 candidates;
     each was independently re-verified against the actual file content
     before touching anything, per the same reproduce-before-fix discipline
     step 7 used for its own findings:
     - GENUINE, FIXED: `connectors/delegate/agent/agent_delegate.js`'s
       comment above `isTransientGeminiError` said 429/503 were the only
       cases treated as transient, but the function body also returns true
       on `err?.transient === true` (the adapter-level flag bai's own code
       uses to mark its errors retryable independent of HTTP status). The
       comment's own "everything else... is a config or request problem"
       framing was therefore incomplete. Fixed by describing the
       `err.transient` branch explicitly rather than silently omitting it.
     - FALSE POSITIVE, DISMISSED: `agent_tools.js`'s `max_steps` tool
       description ("hard cap 30 regardless of this value") was flagged as
       unenforced because `agent_tools.js`'s own validation only rejects
       values below 1, with no explicit upper clamp visible in that file.
       Re-verified against `test/agent-seedrun-max-steps-regression.test.js`,
       which has a passing test literally titled "max_steps above
       HARD_MAX_STEPS (30) is clamped down to 30, not passed through raw" --
       the clamp genuinely exists, just downstream in `runInvestigation`/
       `seedRun`, not in `agent_tools.js`'s own input-validation function.
       The tool description is accurate about overall behavior; no fix
       needed.
     - FALSE POSITIVE, DISMISSED: `connectors/github/editor_tool_functions.js`'s
       comment on `buildUnifiedDiff` ("Same LCS-based diff algorithm as
       edit_file's inline diff builder in files.js") was flagged as false,
       claiming files.js uses "an external utility or different approach".
       Re-read `connectors/github/files.js`'s `edit_file` replacements-mode
       diff code directly: it builds the identical m×n LCS DP table, the
       same backtrace loop, the same `CONTEXT = 3` context-window logic, and
       the same `@@ ... @@` hunk-gap marker as `buildUnifiedDiff` -- the
       comment is accurate; no fix needed.
     Net: one real fix committed (commit f9cbf7c); two flagged items
     verified as not drift and left unchanged, so as not to "fix" correct
     comments based on an unverified claim.

9. **Final review** ✅ DONE
   - Confirm `connectors/gemini/` only contains Gemini API-wrapper code.
   - Confirm setting `BAI_ENABLED=false` requires zero diffs inside
     `connectors/gemini/` or the neutral delegate loop.
   - Run full test suite.
   - DONE NOTE: verification split across a `delegate_agent` investigation
     (structural/reference checks, read-only) run in parallel with an
     actual fresh-clone test run (which delegate_agent cannot do itself,
     being read-only), then independently spot-checked rather than taken
     on trust:
     - `connectors/gemini/` contents: delegate_agent read the directory and
       reported it contains only `client.js` (pure Gemini REST wrapper --
       `callGenerateContentOnce`/`callGenerateContent`/`geminiGenerate`/
       `geminiChat`: request cascade, key rotation, cooldown tracking,
       timeouts/error handling -- no agent-loop/checkpoint/worker/dispatch
       logic). Independently re-confirmed via a direct `get_file_tree` on
       this branch: `connectors/gemini/` lists exactly one file,
       `client.js`. Matches steps 2/2a/3/3b's own end-state claims.
     - `BAI_ENABLED=false` isolation: delegate_agent confirmed `config.js`
       defines `BAI_ENABLED` as `process.env.BAI_ENABLED !== "false"`
       (default true), `connectors/llm/router.js`'s `providerChat` calls
       `assertProviderEnabled("bai", BAI_ENABLED)` before dispatching to
       `baiChat` (throwing a clear config error, not a special-cased
       failure), and that `BAI_ENABLED` is referenced nowhere else in the
       repo -- not in `connectors/gemini/`, not anywhere under
       `connectors/delegate/`. The disabled-provider error path is fully
       contained in `connectors/llm/router.js`. Consistent with step 5's
       own findings; no drift found since.
     - Full test suite: since delegate_agent has no code-execution
       capability, this was run directly -- minted a single-use
       read-write clone token via `get_repo_clone_token`, cloned this
       exact branch fresh into the sandbox (not the working copy prior
       edits were made in), `npm install`, then `npx vitest run`.
       **Result: 47 test files, 573 tests, all passing** (20.88s total).
       No failures, no skips. Matches step 7's own from-scratch-clone
       result exactly (same file/test counts), confirming nothing
       regressed between step 7 and this final review.
   - All three step-9 checks pass; no further code changes required by
     this refactor.

## Status
- [x] Step 1
- [x] Step 2
- [x] Step 2a
- [x] Step 3
- [x] Step 3b
- [x] Step 4
- [x] Step 5
- [x] Step 6
- [x] Step 7
- [x] Step 8
- [ ] Step 9
