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

## Live test evidence (2026-09-25)

Ran a real `delegate_agent` call against this repo before building anything,
to check whether the discovery-step problem is real:

> Task: "In the allocsys/madmcp repo, explain how the delegate_agent tool
> handles a Gemini API rate-limit (429) error mid-investigation: what
> retry/backoff logic exists, where checkpoints get saved, and what the
> caller is told. Cite the actual file(s) and function name(s) involved."

Run id `c8a235f2-2d9f-4460-adf8-d36fca308b3e`, async mode, 17 steps taken.

**Result: the final answer was correct** (matched a manual read: cascade in
`connectors/gemini/client.js` -> `connectors/llm/router.js` ->
`isTransientGeminiError`/catch in `agent_delegate.js`'s `runInvestigation`
-> `saveCheckpoint`). So this run did **not** reproduce the
"confidently-wrong-guess" failure mode the original problem statement was
framed around.

**What it did show: `github_get_file_tree` wasn't called until step 14 of
17.** Steps 1-13 were spent on:
- one reasonable orientation `github_search_code` call (step 1),
- paginating `agent_delegate.js` out of order by char_offset (0 -> 120000
  -> 150000 -> 90000 across steps 2/7/8/11) because it didn't know the
  file's actual structure/length upfront,
- 6 more `github_search_code` calls (steps 3,4,5,6,9,10,12,13) hunting for
  symbols it suspected existed (`isTransientGeminiError`, `saveCheckpoint`,
  `runInvestigation`, `providerChat`, `geminiClient`) -- several of which
  were re-finding things already inside the file it had partially read,
  and one (`geminiClient`) was a flat-out wrong guess, zero results.

Step 14: `github_get_file_tree` finally called. Steps 15-16, immediately
after: reads `connectors/llm/router.js` and `connectors/gemini/client.js`
-- both correct paths, no guessing, 2 clean calls -- because it now had the
repo's actual shape instead of hunting for it piecemeal via search.

**Conclusion: the discovery-step idea is validated, but for a different
reason than originally framed.** The problem this run demonstrates isn't
hallucinated/wrong answers -- it's **step-budget waste from lack of
upfront orientation**. 13 of 17 steps were spent groping before one
`get_file_tree` call unlocked the 2 steps that actually solved the task. If
discovery had come first, this run plausibly finishes in ~5-6 steps instead
of 17 -- meaningful headroom, especially since this run used 17 of a
~20-step default budget and was one unlucky step away from hitting the cap
on a task that isn't even particularly complex.

### Test 2: targeting a wrong-path guess specifically

Ran a second task deliberately targeting a non-obvious nested path
(`connectors/delegate/designer/designer_tools.js`) to see if `delegate_agent`
would guess a wrong flat path instead of checking the tree first:

> Task: "In the allocsys/madmcp repo, explain exactly how the
> delegate_designer tool enforces its read/write file scope: which file
> extensions are allowed, whether there's a path-prefix restriction, how
> the branch requirement (must not be the default branch) is checked, and
> whether checks are live-verified against GitHub or trusted from the
> argument. Name the exact file path(s) and function name(s) involved."

Run id `5c5e34f6-974d-4b5e-bd86-9575478abcd8`, **6 steps taken, `github_get_file_tree` never called at all**:
- Step 1: one `github_search_code` orientation call.
- Step 2: **guessed** `connectors/frontend/designer_tool_functions.js` --
  manually re-verified against `designer_delegate.js`'s real imports after
  the run finished: this guess was **correct**, not a decoy/stale file as
  suspected going in.
- Step 3: **guessed** `connectors/delegate/designer/designer_tools.js` --
  also correct on the first try, no tree lookup needed.
- Steps 4-5: read `designer_delegate.js` and `config.js` directly (both
  already-known-correct paths from step 2/3's content).
- Step 6: forced-final synthesis, no tool call.

**Final answer was correct**, including one subtlety verified by hand:
`designer_delegate.js`'s own header comment claims the branch check lives
in `designer_tools.js`, but the actual code shows it executing inside
`designer_delegate.js`'s own `runDesignAgent` (a live `GET /repos/{owner}/{repo}`
call compared against the `branch` argument). The model's answer matched
the real code, not the stale comment -- a good sign about how it weighs a
direct read over other information.

**This complicates the discovery-step case.** Gemini pattern-matched the
repo's naming convention (likely generalizing from `editor_tool_functions.js`'s
analogous structure, visible in other tool descriptions it had access to)
and got two structural guesses right on the first try, with zero tree/list
calls, in 6 total steps -- more efficient than test 1's 17-step run, and
more efficient than a mandatory-discovery version of *this* run would have
been (a forced `get_file_tree` step here is a pure +1-step tax with no
correctness upside, since the guesses were already right).

**Net across both tests:** test 1 (no guessing, but wasteful --
discovery-too-late) argues for a discovery step; test 2 (guessing, correct,
efficient) argues against forcing one unconditionally. Neither test
reproduced a genuine wrong-path hallucination yet -- both times Gemini
either searched conservatively or guessed correctly. This is a small sample
(n=2) and both tasks were read-only investigations in the same repo
Gemini apparently has decent structural priors for; still worth more runs,
ideally on a less internally-consistent/predictable repo, before deciding
unconditional vs conditional (open question 1 below) -- but the current
evidence leans toward **conditional**, not unconditional: an always-on
discovery step would have made test 2 strictly worse for no benefit.

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
