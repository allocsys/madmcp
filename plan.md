# Plan: Reduce context/token bloat in delegate_agent's investigation loop

## Status (2026-08-31)

Feature is implemented and shipped on `feat/history-compaction-bai`. All
known bugs (see changelog below) are fixed. Full suite verified via fresh
clone: **468/468 passing**.

Remaining work — **not started, out of scope unless explicitly asked
for**:
- Manual validation: a real multi-step `bai` run, comparing input
  tokens/step and answer quality against an uncompacted baseline, plus
  confirming a parallel `gemini` run is fully unaffected.
- Threshold tuning (`HISTORY_FULL_DETAIL_STEPS`, the char threshold) —
  current values are starting guesses, meant to be revisited only after
  the manual validation above.

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
