# Plan: Reduce context/token bloat in delegate_agent's investigation loop

## Status (2026-08-31)

Feature is implemented and shipped on `feat/history-compaction-bai`
(merged to `main` via PR #119, squashed at `e0a8ee3`). All known bugs
(see changelog below) are fixed. Full suite verified via fresh clone of
`main` @ `e0a8ee3`: **468/468 passing, 38/38 files**.

### Post-merge spot-check findings (2026-08-31, fresh clone of `main`)

- `deleteCheckpoint`'s side-store GC (plan.md step 5) is correct in
  isolation — reads `preCompactionResultIds` from meta, batch-deletes
  `precompact:{runId}:{id}` alongside `contents`/`meta`. **But it is
  never actually called anywhere in the gemini connector's production
  code path** (`agent_delegate.js`, `agent_worker.js`,
  `qstash_client.js`, `agent_tools.js` all checked) — only unit tests
  call it directly. `finishRun` saves the checkpoint with `status:
  "done"` and leaves it for polling; cleanup of both the checkpoint and
  its side-store keys currently happens entirely via the shared 1hr
  `CHECKPOINT_TTL_SECONDS`, not an explicit sweep. Not a leak (TTL is a
  real backstop) and not mid-run eviction (the thing step 1 removed),
  but worth a decision on whether something should call
  `deleteCheckpoint` once a caller has polled and retrieved the final
  answer.
- No mid-run eviction of `preCompactionResults` found anywhere —
  confirmed via grep (`MAX_PRE_COMPACTION`, `evict`, stray `.delete(`)
  and `git log`, which shows the 2eea726 eviction block added then
  explicitly reverted (`2e3bf54`). Bug stays fixed.
- `findUnverifiedClaims`/`lineIsVerbatimInToolResults` correctly fall
  back to the side-store on Map miss, batched via one `MGET`
  (`findCompactedIdsMissingFromMap` + `getPreCompactionResults`) —
  matches plan.md step 4 as written.

### Live `bai` run (2026-08-31, real `delegate_agent` call, `provider:
"bai"`, task: summarize agent_delegate.js/agent_checkpoint.js/
agent_worker.js/bai client/adapter)

Not a controlled token-count comparison — the run failed before
reaching that point — but it did surface two things worth tracking:

- **Repeat-call pattern:** steps 5–6 re-issued byte-for-byte identical
  `github_read_file` calls (same path + same `char_offset`) already
  made in steps 1–2. `resultCache` is supposed to serve a repeat call
  from cache instead of re-fetching; this run's transcript doesn't show
  that happening. Worth checking whether `resultCache` keys on
  something (e.g. call ordering/step number) that doesn't match here,
  or whether this is expected behavior for a different reason.
- **Key exhaustion at step 7:** run failed with all 3
  `BAI_API_KEYS` unavailable (key #0: 429 capacity limit, keys #1/#2:
  55s timeouts) after only 6 steps / ~20 tool calls, most of which was
  re-reading the same files (see repeat-call point above). Consistent
  with the original bug report ("burned through all 3 keys' quota by
  step 16") — if the repeat-call issue is real, it's plausibly making
  quota exhaustion worse, independent of the compaction fix itself.
  Run did not survive long enough to observe compaction actually
  triggering (`HISTORY_FULL_DETAIL_STEPS = 3` should engage by step 4+).

### Follow-up small `bai` run (2026-08-31, live `delegate_agent`,
`max_steps: 4`, task: read config.js, summarize
HISTORY_COMPACTION_PROVIDERS + BAI_MODEL)

Completed cleanly in 4 steps, no key exhaustion — confirms the earlier
failure really was B.AI quota/capacity exhaustion at the time, not a
code bug; a small task on the same keys went through fine shortly after.
Also double-checked the resume-provider question this session raised:
read `runInvestigation`'s resume path directly —
`effectiveProvider = checkpoint.provider || provider` (agent_delegate.js)
makes the checkpoint's own recorded provider authoritative on resume,
not whatever the caller passes. Confirmed in practice too: every resume
call on the earlier failed run was made without a `provider` arg, and
both failures came back as B.AI errors (key timeouts/429s), not Gemini
errors — so the run correctly stayed on `bai` throughout. The
`checkpoint.provider || provider` fallback only matters for checkpoints
saved before the `provider` field existed; every checkpoint from this
feature onward always has it set, so that fallback branch is effectively
dead code going forward. Not a gap.

New item surfaced by this run's own answer, unrelated to compaction:
`config.js`'s comment on `BAI_MODEL`'s default (`"glm-5.3-flash"`) said
it was **not yet live-verified** — B.AI's docs never state the literal
model-ID string, so the default was a guess from their doc URL slug, not
confirmed against `GET https://api.b.ai/v1/models` with a real key.

**Update (2026-08-31):** verified directly against `GET
https://api.b.ai/v1/models` with a real key — `"glm-5.3-flash"` is
correct. config.js's "NOT YET LIVE-VERIFIED" comment on `BAI_MODEL` is
now stale and can be removed/updated next time that file is touched.

Remaining work — **not started, out of scope unless explicitly asked
for**:
- Manual validation: a real multi-step `bai` run, comparing input
  tokens/step and answer quality against an uncompacted baseline, plus
  confirming a parallel `gemini` run is fully unaffected. (Two attempts
  so far: the first multi-file run failed on key exhaustion before
  completing; a smaller follow-up completed cleanly but was too short
  to exercise compaction or produce a real token comparison. Still
  needs a proper multi-step run that survives long enough to compare
  against an uncompacted baseline.)
- Threshold tuning (`HISTORY_FULL_DETAIL_STEPS`, the char threshold) —
  current values are starting guesses, meant to be revisited only after
  the manual validation above.
- ~~Investigate whether `resultCache` is missing the repeat calls~~
  **Confirmed bug (2026-08-31):** `repeatCounts` is restored from the
  checkpoint on resume (`agent_delegate.js:1556`,
  `new Map(Object.entries(checkpoint.repeatCounts || {}))`) but
  `resultCache` is not — it's unconditionally reinitialized as
  `let resultCache = new Map()` (line 1484) with no corresponding
  restore anywhere in the resume path. Effect: on a resumed invocation,
  `isRepeat = repeatCounts.has(signature)` correctly comes back `true`,
  but the serve-from-cache check
  (`isRepeat && resultCache.has(signature)`, line 1998) fails because
  the cache is empty in this fresh invocation — the call falls through
  to the `else` branch and is **silently re-executed for real**, no
  `[CACHED]` tag in the transcript, full network round-trip spent.
  Reproduced live: steps 5–6 of the first live `bai` run above
  re-issued byte-for-byte identical `github_read_file` calls already
  made in steps 1–2, none tagged `[CACHED]`.
  This matters more than an ordinary edge case because
  `agent_worker.js` (the QStash self-chaining path, its own header
  comment calls this the production mechanism for multi-step runs)
  calls `runInvestigation` with `resume_run_id + singleStep: true`
  **once per step** — each call is a fresh serverless invocation, so
  `resultCache` is wiped every single step under normal async
  execution, not just on rare crash-recovery resumes. Any repeat call
  spanning a step boundary re-executes for real, amplifying the exact
  API-quota burn this whole feature exists to reduce.
  The comment justifying the non-persistence (“a correctness no-op,
  not worth the extra checkpoint weight”) assumed resumes are rare
  exceptional events; under `agent_worker.js` they're the normal unit
  of execution, so the assumption doesn't hold.
  **Fix constraint:** cannot just add `resultCache:
  Object.fromEntries(resultCache)` to the checkpoint's `meta` blob —
  that's exactly the unbounded-growth shape `preCompactionResults` had
  before the side-store fix this whole feature is about. Any fix needs
  the same side-store pattern (Redis key per signature, ids-only in
  meta, fetch-on-demand), not a return to inlining full result text
  into the checkpoint blob. Being fixed on a debug branch — see repo
  for current status.

## Context

`connectors/gemini/agent_delegate.js`'s investigation loop resends its
whole `contents` array on every `providerChat` call, and nothing in it is
ever pruned. Per-tool caps (e.g. `github_read_file` at 30k chars) bound a
single response but not what accumulates over a 30-step run.

Surfaced concretely: a `delegate_agent` run on `provider: "bai"` burned
through all 3 `BAI_API_KEYS`' free-tier quota by step 16 on a task that
repeatedly read large files. Confirmed via B.AI's docs
(https://docs.b.ai/llmservice/api/) this is ordinary re-sent history, not
a hidden reasoning-token cost.

## Hard constraint

Gemini/OpenAI-shaped chat APIs require strict role alternation and every
`functionCall` part paired with a matching `functionResponse`. **Deleting
or reordering turns in `contents` is not safe** — malformed sequences get
requests rejected. Any fix edits part *content* in place, never
removes/reorders whole turns.

## Approach: compact historical tool-result text in place (not deleted)

Once a turn ages past a small "recent" window (`HISTORY_FULL_DETAIL_STEPS
= 3`), replace the stored text of large, known-bulky tool results
(`github_read_file`, `github_get_file_tree`, log/CI tools) with a short
pointer string. Turn structure, roles, and functionCall/functionResponse
id pairing stay untouched — only the inner text changes. `resultCache`
already dedupes repeat calls, so a re-request of a compacted file is
served from cache, not re-fetched.

Rejected/deferred alternatives: sliding-window truncation of whole turns
(risks losing findings the model hasn't acted on yet) and aggressive
dedup of repeated reads (additive, worth doing later on top of this, not
instead of it).

## Switchable per-provider, default only "bai"

`config.js` exports `HISTORY_COMPACTION_PROVIDERS` (comma-separated,
default `"bai"`). `agent_delegate.js` checks
`HISTORY_COMPACTION_PROVIDERS.includes(provider)` before compacting; if
the provider isn't listed, behavior is unchanged (full history, as
before this feature). Gemini/GLM/Groq are untouched by default.

## Implementation steps (original feature)

1. Bulky-tool list: `github_read_file`, `github_get_file_tree`, log/CI
   tools — matches existing per-tool cap list. Small/structured results
   (`github_get_commit`, `github_list_branches`) are never compacted.
2. `HISTORY_FULL_DETAIL_STEPS = 3` constant in `agent_delegate.js`,
   alongside `HARD_MAX_STEPS = 30`.
3. Compact on write (not on read), gated on provider opt-in. Threshold:
   500+ char stored text on a turn older than the recent window →
   replace with a fixed-format pointer string.
4. Rely on `resultCache` as the re-fetch safety net (see above).
5. Tests: bulky result stays full within the window, compacts once aged
   out, non-bulky never compacted, compacted-then-re-requested served
   from cache — all under `provider: "bai"`; `provider: "gemini"` run
   confirms byte-for-byte unchanged history.
6. **Not started.** Manual validation — see Status above.

Steps 1–5 done and tested. Step 6 is the open item tracked in Status.

## Bugs found and fixed during implementation (changelog)

Condensed to the lessons that matter for future changes in this area —
see git history for full narrative if needed.

- Compaction broke `findUnverifiedClaims` and
  `lineIsVerbatimInToolResults` (both substring-match against raw tool
  text, which compaction had already overwritten). Fixed by capturing
  pre-compaction text before overwriting and checking it as a fallback.
- Pre-compaction text lives in a dedicated Map (now a Redis side-store,
  see below) — never in `resultCache`, which doesn't survive checkpoint
  resume.
- Compaction must be re-applied to restored `contents` immediately after
  `loadCheckpoint`, before the loop's first `providerChat` call, or a
  resumed run silently re-sends uncompacted history.
- The full-detail window is computed relative to `currentStep` meaning
  "the step about to run," consistently at every call site — get this
  wrong and you under/over-count the recent window by one.
- `functionResponse.id` is not guaranteed unique across a whole run;
  pre-compaction storage keys must disambiguate collisions (`${id}#2`,
  ...) rather than overwrite.

## Resolved: `preCompactionResults` checkpoint-bloat (side-store fix)

Previously tracked as "Current outstanding issue" (2026-08-31). **Closed
— fixed and verified, 468/468 tests pass on this branch.**

Root cause: commit `2eea726` added mid-run eviction of
`preCompactionResults` once it exceeded 200 entries, which silently
reopened the `findUnverifiedClaims`/`lineIsVerbatimInToolResults` bug
above for any run compacting more than 200 results.

Fix (implemented in `connectors/gemini/agent_checkpoint.js` and
`agent_delegate.js`):

1. Removed the `2eea726` eviction block and its cap constant. No
   mid-run deletion of verification data, ever — this is the core
   invariant; don't reintroduce it by tuning the cap or eviction order.
2. Full compacted text is written once to a Redis side-store key
   `precompact:{runId}:{id}` (`savePreCompactionResult`) instead of
   living only in memory.
3. Checkpoint `meta` now stores only the *ids* of compacted results, not
   their text. This shrinks the per-write cost substantially (an id vs.
   up to 30k chars) but `meta` is still one full overwrite per
   `saveCheckpoint` call — O(total ids so far), not O(delta). A true
   append-only ids store (mirroring `contents`' `RPUSH`) would be needed
   for O(delta) writes on very long runs; not implemented, flagged as a
   possible follow-up.
4. `findUnverifiedClaims`/`lineIsVerbatimInToolResults` fall back to the
   side-store (`getPreCompactionResult`) on a Map miss. Both are now
   async as a result; lookups are batched via a single `MGET` per
   verification pass rather than one round trip per id.
5. `deleteCheckpoint` batch-deletes all `precompact:{runId}:*` keys
   alongside `contents`/`meta`. GC only fires at genuine run completion,
   never mid-run.
6. Tests added (`test/history-compaction.test.js`): GC removes
   side-store entries; `meta` stays flat (ids only, no text) over a long
   run; a 250-entry run round-trips fully through save/load with no
   loss (regression guard against the removed 200-cap). Also added: an
   integration test exercising the real
   `loadCheckpoint` → recompaction → `providerChat` resume path, which
   was previously only unit-tested against hand-built arrays.

The exact compaction thresholds are still unvalidated starting guesses —
see Status above, not part of this fix.

## Caveat found (2026-08-31): visible reasoning text in `content` is not compacted

Confirmed via a live `/v1/chat/completions` call against `glm-5.3-flash`
that B.AI returns reasoning as a separate `message.reasoning_content`
field, sibling to `message.content` (confirmed by
`usage.completion_tokens_details.reasoning_tokens` being nonzero on that
call). `fromOpenAIChoice()` (`connectors/openai_shape/adapter.js`) only
ever reads `message.content`, so `reasoning_content` is already never
pushed into `contents` and never resent — **no bug there, nothing to
fix on that front.**

The actual gap: the model sometimes also writes a visible step-by-step
reasoning section *inside* `message.content` itself (confirmed on the
same live call — a `# Step-by-Step Reasoning` block ahead of the actual
answer). That text is real assistant-authored content, not a
structured field the adapter is failing to filter, so it does get
stored in `contents` and resent on every later step. Existing
bulky-tool-result compaction doesn't apply here at all — it only ever
targets tool-result turns, never the model's own `content` turns.

Two options, not yet implemented, not started:

1. **Prompt-level (try first).** Add a line to `SYSTEM_PREAMBLE`
   (`connectors/gemini/agent_delegate.js`) telling the model to give its
   final answer directly rather than restating a step-by-step reasoning
   section in `content` — `reasoning_content` already captures that
   internally and is already excluded from resend. Cheap, one-line
   change, testable via the same kind of live call used to confirm this
   caveat. Not guaranteed: it's a compliance ask to an open model, not a
   structural fix.
2. **Compaction-level (only if #1 proves unreliable).** Extend
   compaction to assistant `content` turns above a char threshold once
   aged out of the recent window — but **not** a blanket pointer-replace
   like tool-result compaction. Unlike tool results (recoverable via the
   side-store, and not something the model needs to "remember" beyond
   having read them), an assistant's own past answer may be a finding
   the model needs to build on in later steps. Naive pointer-replacement
   here risks the same failure mode the plan already rejected for
   whole-turn truncation ("risks losing findings the model hasn't acted
   on yet"). If pursued, must strip only the reasoning preamble and
   preserve the actual concluding answer, not replace the whole turn.

Neither option started. Try #1 first; only reach for #2 if the model
keeps restating full reasoning despite being told not to.
