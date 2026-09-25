# Plan: mandatory discovery pre-step for `delegate_agent`

Status: **discussion only — not implemented yet.**

## Problem

`delegate_agent`'s Gemini loop (`agent_delegate.js`) can batch multiple
function calls into a single turn. Calls batched in the same turn are
decided **blind** — Gemini writes all of them before seeing any result — so
it can (and does) guess a `github_read_file` path instead of checking
`github_get_file_tree`/`github_list_directory` first. Parallelizing those
already-batched calls (see the 2026-07-26 PARALLELIZED change) doesn't fix
this: it only changes wall-clock time, not what information is available to
each call, since the calls were already decided blind before either the
parallel or the old sequential execution model.

## Options considered and rejected

- **Force every step to 1 tool call.** Rejected: `MAX_TOOL_CALLS_PER_STEP`
  (8) currently only applies to provider `"bai"` — Gemini is uncapped today.
  Forcing 1-per-turn would multiply the number of steps needed for any
  multi-call investigation, and step budgets are small
  (`stepBudgetForComplexity`: trivial=3, simple=8, moderate=20, complex=30
  hard cap). A task that finishes in 3 steps today could need 10+ at
  1-call-per-step and blow the budget on tasks that currently work fine.
  Also penalizes genuinely independent calls (file tree + commit list +
  issue list) that don't need to be sequential at all.
- **Prompt-only fix** (tell Gemini in the preamble to look before it reads).
  Cheapest option, not mutually exclusive with the plan below, but no
  structural guarantee — still worth trying independently.

## Current plan

Add a single mandatory **discovery pre-step** (step 1 only) to
`runInvestigation`, GitHub-only for now (not extending to Notion/Cloudflare/
Mem0/Context7 at this time):

- **Step 1**: Gemini may only call a restricted tool subset:
  - `github_get_file_tree`
  - `github_list_directory`
  - `github_search_code` (**correction, 2026-09-25: already exposed to
    Gemini** — a full `FUNCTIONS` entry with its own declaration + `execute`
    exists in `agent_delegate.js` already, same `fallbackCodeSearch`
    tarball-grep behavior as the calling-model version in
    `connectors/github/search.js`. Missed on first read of the file — no
    porting work needed here after all, just the step-1 gate itself.)
  - Explicitly **not** `github_read_file` — that's the whole point of the
    gate; `read_file` only becomes available from step 2 onward.
- **Step 2+**: full `FUNCTIONS` list unchanged, as today.
- Mechanism: reuse the existing `withholdTools`-style per-step gating
  pattern already in the loop (`isFinalStep`/`stuckLoopForce` already swap
  tool availability by step) — swap in a restricted `FUNCTION_DECLARATIONS`
  subset when `step === 1` instead of the full set. `step` is already an
  absolute counter that survives checkpoint resume, so this naturally fires
  once per run, not once per call.
- Batching is **preserved** within the discovery step — this restricts
  *which* tools are callable, not how many calls can be batched together.
  So step 1 can still batch `github_get_file_tree` + `github_search_code`
  in parallel; no loss of the wall-clock win from the parallelization
  change.

### Cost

Flat **+1 step** per run, regardless of task size. Meaningful for trivial
tasks (1 of a 3-step budget, ~33%) but negligible for moderate/complex.
Chosen over the +2-step version specifically to keep this cost down.

### New requirement (this session): scope discovery to the target repo/branch

`delegate_agent` currently has **no `owner`/`repo`/`branch` parameter at
all** — unlike `delegate_editor`, which already takes explicit
`owner`/`repo`/`branch` args (see `editor_tools.js`). `delegate_agent`'s
only input is a free-text `task` string, and Gemini has to infer which
repo(s) to touch from that text.

Requirement: gate `github_search_code` (and ideally the other discovery
tools) in the step-1 discovery step to the repo/branch the **caller**
specifies for the delegation, so Gemini can't wander into a stray/unrelated
repo during discovery.

This means `delegate_agent`'s tool schema likely needs new optional
`owner`/`repo`/`ref` (or `branch`) parameters, following the
`delegate_editor` precedent, which then get threaded through to the
discovery-step tool declarations/execute functions to scope
`github_search_code`'s query (and `get_file_tree`/`list_directory`'s
target) to that repo/ref rather than trusting whatever repo Gemini decides
to search.

**Open question, not yet resolved:** if `owner`/`repo` is provided, should
`github_get_file_tree`/`list_directory`/`search_code` be *hard-scoped*
(owner/repo forced into the call regardless of what Gemini passes) or just
*defaulted* (Gemini can still override)? Hard-scoping is the only way to
actually guarantee no stray-repo search; defaulting only reduces the odds
of it.

## Still open / not decided

1. **Unconditional vs conditional**: should the discovery step always fire,
   or be skipped when the task already names an exact path/PR/commit (so
   there's nothing to discover)? Not decided — leaning toward unconditional
   for simplicity given the cost is now just 1 step, but not settled.
2. **`github_search_code` cost profile differs from the other two**: unlike
   `get_file_tree`/`list_directory` (single API call each), `search_code`
   can fall back to `fallbackCodeSearch` — fetching the whole repo as a
   tarball and grepping locally — when GitHub's search index misses, which
   the tool's own description says is a *known, not edge-case, gap for
   private repos*. So the discovery step could occasionally be a full
   tarball fetch, not a quick orientation call. Not blocking, but worth
   watching once implemented.
3. **Does Gemini actually use step 1's output**, or does it still guess a
   path in step 2 without reading the tree closely? A structural gate
   doesn't guarantee this — may still need a preamble note to close the
   loop (see "prompt-only fix" above; may end up wanting both).
4. Non-GitHub connectors (Notion/Cloudflare/Mem0/Context7) intentionally
   out of scope for this plan per current direction — revisit later if
   needed.
