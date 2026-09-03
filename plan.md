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
   | qstash_client.js | agent_tools.js, agent_worker.js (same dir, relative import) **and** `connectors/github/editor_tools.js` (`from "../gemini/qstash_client.js"`) **and** server.js (`isQStashConfigured`, `isEditorQStashConfigured`); tests: agent-delegate-loop (mocked), agent-worker.test (mocked), editor-worker.test (mocked), qstash-client-publish.test (direct) |

   Confirmed NOT moving / already correctly neutral (no change needed):
   - `connectors/llm/router.js` — already shared by designer_delegate.js, agent_delegate.js, AND editor_delegate.js. Good home already.
   - `connectors/shared/cooldown.js` (Redis) — already shared by every provider client.js plus both checkpoint modules.
   - `connectors/frontend/designer_delegate.js` / `designer_tool_functions.js` — only reference agent_delegate.js in comments as a design pattern they parallel; NOT an actual import. No coupling to undo there.

   Cross-directory import confirmed as the concrete coupling to fix: `connectors/github/editor_tools.js` currently imports `qstash_client.js` via a `../gemini/` relative path — this is the literal case of "can't touch bai/editor async plumbing without reaching into connectors/gemini/" the whole plan exists to fix.

   Editor-side files (already outside connectors/gemini/, confirmed for completeness, no move needed):
   - `connectors/github/editor_delegate.js` — imported by editor_worker.js, editor_tools.js; tests: editor-delegate-async-checkpoint, editor-delegate.test (mocked), editor-tools.test (mocked), editor-worker.test
   - `connectors/github/editor_checkpoint.js`, `editor_tools.js`, `editor_worker.js` — all already in connectors/github/, no move planned (step 3 only fixes their qstash_client.js import path)

   No code changes made in this step.

2. **Move the read-only agent loop out of connectors/gemini/**
   - Move `agent_delegate.js`, `agent_checkpoint.js`, `agent_worker.js`,
     `agent_tools.js` to a new neutral home: `connectors/delegate/agent/`.
   - Update all imports across the repo (server.js, tests, etc.) to the new
     paths.
   - `connectors/gemini/` keeps only `client.js` (the actual Gemini API
     wrapper) and anything strictly Gemini-request-shaped.

2a. **Move qstash_client.js to the neutral delegate dir**
   - CONFIRMED not Gemini-specific: it already backs BOTH the agent worker
     chain (`publishAgentStep`, `AGENT_WORKER_URL`) and the editor worker
     chain (`publishEditorStep`, `EDITOR_WORKER_URL`) side by side, and its
     own file header notes it's the same Upstash account as Redis
     checkpointing, just a different product (QStash vs Redis).
   - Move `connectors/gemini/qstash_client.js` -> `connectors/delegate/qstash_client.js`
     (one shared file, not agent/editor-split, since it already serves both).
   - Update imports in `agent_worker.js`, `agent_tools.js`, `editor_worker.js`,
     `editor_tools.js`, and any tests that mock this module's path.
   - Note for contrast: `connectors/shared/cooldown.js` (Upstash Redis,
     backs checkpointing) is ALREADY correctly neutral -- it lives under
     `connectors/shared/` and is imported directly by every provider's own
     client.js (gemini/glm/groq/bai) plus the agent/editor checkpoint
     modules. No move needed there, just confirm during step 9 that nothing
     new accidentally reintroduces a gemini-specific Redis path.

3. **Move the editor loop to a neutral home**
   - `connectors/github/editor_delegate.js`, `editor_tools.js`,
     `editor_worker.js`, `editor_checkpoint.js` (if present) are already
     outside `connectors/gemini/`, but audit for any direct
     `connectors/gemini/*` imports beyond `client.js` and cut those over to
     the new `connectors/delegate/agent/` equivalents or to router.js.
   - Rename to `connectors/delegate/editor/` if it clarifies the split from
     GitHub-specific tooling; otherwise leave in place and just fix imports.

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
     (`test/agent-delegate*.test.js`, `test/editor-delegate*.test.js`, etc.).
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
- [ ] Step 2
- [ ] Step 2a
- [ ] Step 3
- [ ] Step 4
- [ ] Step 5
- [ ] Step 6
- [ ] Step 7
- [ ] Step 8
- [ ] Step 9
