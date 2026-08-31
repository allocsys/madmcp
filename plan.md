# Plan: Reduce context/token bloat in delegate_agent's investigation loop

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
6. Manual validation: real multi-step `bai` run — input tokens/step level
   off, answer quality unaffected vs. uncompacted baseline; parallel
   `gemini` run on the same task fully unaffected.

Open question: exact thresholds (`HISTORY_FULL_DETAIL_STEPS`, char
threshold) are starting guesses, tune after step 6, not final.

## Bugs found and fixed during implementation review (changelog)

- **Compaction broke `findUnverifiedClaims`** (substring-matches claims
  against raw tool text, which compaction had replaced). Fixed: capture
  pre-compaction text into a `preCompactionResults` Map before
  overwriting; check both current + pre-compaction text.
- **`preCompactionResults` piggybacked on `resultCache`**, which doesn't
  survive checkpoint resume — silently re-broke the bug above on resumed
  `bai` runs. Fixed: dedicated Map, threaded through
  `saveCheckpoint`/`loadCheckpoint` like `repeatCounts`.
- **Compaction didn't survive a checkpoint resume** — `contents`' Redis
  list is append-only, so an in-memory-only compacted turn came back
  uncompacted after a resume, re-sending full bloat on the next
  `providerChat` call. Fixed: re-run `compactHistoryInPlace` on restored
  `contents`/`preCompactionResults` immediately after `loadCheckpoint`,
  before the loop's first `providerChat` call.
- **Off-by-one in the full-detail window** — `compactHistoryInPlace` runs
  before the current step is appended, so the window formula silently
  kept 2 full-detail steps instead of 3. Fixed: threshold corrected to
  `stepIndex <= (currentStep - 1) - fullDetailSteps`, `currentStep`
  consistently meaning "the step about to run" at every call site.
- **`functionResponse.id` isn't guaranteed unique across a whole run** —
  a reused id could let compaction overwrite an earlier turn's saved
  text. Fixed: `setPreCompactionResult` helper stores under a
  disambiguated key (`${id}#2`, ...) instead of overwriting.
- **`lineIsVerbatimInToolResults` was never updated for compaction**
  (same class of bug as `findUnverifiedClaims` above, fixed later).
  Fixed: threaded `preCompactionResults` through it the same way.
  Regression tests in `test/history_compaction_test.js` cover both the
  false-positive and true-positive cases.
- **False alarm, checked, do not re-raise without new evidence**:
  `setPreCompactionResult`'s `#2`/`#3` collision suffixing does not
  depend on Map/object iteration order (it resolves via explicit
  `.has()`/`.get()` on specific keys), so the `Object.fromEntries` ->
  JSON -> `Object.entries` -> `Map` round-trip through checkpoints does
  not affect its correctness.

## Current outstanding issue (2026-08-31): `preCompactionResults` checkpoint-bloom

**Bug**: commit `2eea726` ("Fix #1: Bound preCompactionResults") added
mid-run eviction in `agent_checkpoint.js`'s `saveCheckpoint` — deletes the
oldest `preCompactionResults` entries once `size > 200`
(`MAX_PRE_COMPACTION_RESULTS_ENTRIES`). **This reopens the
findUnverifiedClaims/lineIsVerbatimInToolResults false-fail bug** (see
changelog above) for any run compacting >200 results — exactly the long
`bai` runs this feature targets. Root cause: `saveCheckpoint` writes
`meta` (which includes `preCompactionResults`) as one full JSON blob on
every call, unlike `contents`, which is append-delta via `RPUSH` — so an
unbounded Map means unbounded per-step write cost, and `2eea726` "fixed"
that by evicting live verification data instead of changing the storage
shape.

**Do not fix by tuning the cap or eviction order** — any mid-run deletion
of verification data is the bug, regardless of threshold. Fix with a
side-store instead:

1. **Remove the `2eea726` eviction block** in `saveCheckpoint` (the
   `size > MAX_PRE_COMPACTION_RESULTS_ENTRIES` loop and that constant).
2. **Side-store writes**: in `compactHistoryInPlace`, when a result is
   first compacted, write its full text once to Redis key
   `precompact:{runId}:{id}` via a new `agent_checkpoint.js` helper
   (`savePreCompactionResult(runId, id, text)`) — not just the in-memory
   Map.
3. **Shrink `meta`**: serialize `preCompactionResults` as just the set of
   ids with a side-store entry, not the text. **Correction (2026-08-31
   review): this is not O(new entries this step) and does not match
   `contents`' `RPUSH` pattern** — `saveCheckpoint` still writes `meta`
   as one full `client.set()` overwrite every call, so the ids-set is
   re-serialized in full each time regardless of how it's stored. The
   real win is a much smaller per-entry cost (an id vs. up to 30k chars
   of text), not a change in growth order — `meta` write size is still
   O(total ids compacted so far), just with a far smaller constant. If
   O(delta) writes are actually needed for very long runs, `meta`'s ids
   set would itself need to move to an append-only structure (e.g. a
   Redis SET/RPUSH of ids, mirroring `contents`), which this fix does
   not attempt — call that out as a possible follow-up, not implied as
   already solved here.
4. **Fetch-on-demand**: thread `runId` through `findUnverifiedClaims` and
   `lineIsVerbatimInToolResults` (new `getPreCompactionResult(runId, id)`)
   so a Map miss falls back to the side-store. **Two implementation
   details the plan glossed over (2026-08-31 review):**
   - `lineIsVerbatimInToolResults` is currently called inside a
     synchronous predicate (`quotedLines.filter(q =>
     !lineIsVerbatimInToolResults(...))`). Making its side-store lookup
     async means that call site needs restructuring — e.g. resolve all
     lookups first via `Promise.all`, then `filter` on the resolved
     results — not a drop-in `async`/`await` on the existing signature.
   - A naive per-id `GET` on every compacted id, on every verification
     pass, is a real latency cost on exactly the long `bai` runs this
     targets (runs compacting 200+ ids). Batch the fetch with a single
     `MGET` across all ids needed for that pass instead of one round
     trip per id.
5. **GC only at run completion**: extend `deleteCheckpoint` to
   batch-delete all `precompact:{runId}:*` keys, mirroring its existing
   `contentsKey`/`metaKey` cleanup. No mid-run deletion, ever.
6. **Tests**: side-store populates correctly across save/resume;
   checkpoint `meta` write size stays flat over a long run; no entry is
   ever lost mid-run regardless of compacted-result count.

**Also confirmed, not yet fixed**: no test exercises the real
resume → recompaction path end-to-end. `test/history_compaction_test.js`'s
round-trip test only calls `compactHistoryInPlace` directly on hand-built
arrays, never the actual `loadCheckpoint`/`saveCheckpoint`/
`runInvestigation` resume path. Fold into step 6 above (integration test
via mocked or real test Redis: save checkpoint mid-run, resume via
`runInvestigation`, assert resumed `contents` sent to `providerChat` is
already compacted).
