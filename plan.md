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

3b. **Move the designer loop to connectors/delegate/designer/**
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

4. **Extract provider-specific hooks out of the shared loop**
   - `HISTORY_COMPACTION_PROVIDERS` gating and the bai `reasoningEffort`
     forced-final-step logic move out of the (now-neutral) loop file into a
     small per-provider hooks module (e.g. `connectors/bai/delegate_hooks.js`),
     called from the neutral loop via a lookup keyed on `provider`, so
     editing bai's behavior means editing bai's own files only.

5. **Add explicit per-provider enable flags**
   - `BAI_ENABLED`, `GLM_ENABLED`, `GROQ_ENABLED` in config.js, default
     matching current behavior (on, since they're already reachable).
   - `router.js` checks the flag before dispatching to that provider and
     throws a clear config error if disabled, rather than silently
     misbehaving.
   - `BAI_ENABLED=false` (etc.) must not require touching anything under
     `connectors/gemini/` or the neutral delegate loop.

6. **Update delegate_agent / delegate_editor tool schemas**
   - No change to the `provider` enum (`["gemini", "bai"]`) unless we decide
     to also expose glm/groq at the tool layer -- out of scope here.
   - Confirm error messaging when a disabled provider is requested is clear
     and surfaces to the caller.

7. **Update tests**
   - Move/rename test files to match new module locations
     (`test/agent-delegate*.test.js`, `test/editor-delegate*.test.js`,
     designer's equivalents if any exist under test/, etc.) and fix every
     mocked/imported path found in step 1's consumer tables (including the
     designer table added in step 1).
   - Add coverage for the new enable-flag behavior (disabled provider ->
     clear error, gemini unaffected).

8. **Docs**
   - Update README.md / docs/ if they reference `connectors/gemini/` paths
     for the delegation loop.

9. **Final review**
   - Confirm `connectors/gemini/` only contains Gemini API-wrapper code.
   - Confirm setting `BAI_ENABLED=false` requires zero diffs inside
     `connectors/gemini/` or the neutral delegate loop.
   - Run full test suite.

## Status
- [x] Step 1
- [x] Step 2
- [x] Step 2a
- [ ] Step 3
- [ ] Step 3b
- [ ] Step 4
- [ ] Step 5
- [ ] Step 6
- [ ] Step 7
- [ ] Step 8
- [ ] Step 9
