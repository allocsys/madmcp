# Plan: delegate_agent reliability & quota fixes

## Status (2026-09-01)

| Item | State |
|---|---|
| History compaction (bai token-bloat) | Done — PR #119, merged `main`@`e0a8ee3` |
| `resultCache` not persisted on resume | Fixed — PR #120, merged `main`@`b48e57f` |
| Async poll could silently drive 20 steps | Fixed — PR #121, merged `main` |
| Heartbeat / in-flight step tracking | Done — PR #123, merged `main`@`95e83a7`, live-validated 2026-09-01 |
| `deleteCheckpoint` GC never called in prod path | Open, undecided |
| Visible reasoning text not compacted | Open, try prompt fix first |
| Manual token-count validation vs baseline | Not completed |

## Resolved: Heartbeat / in-flight step tracking

### Problem

`agent_tools.js`'s poll-freshness check only reads `lastStepAt`, the
timestamp of the last *completed* step. A step that is merely slow (bai
key-rotation retries up to 55s per key, QStash delivery lag, Redis round
trips) is indistinguishable from a genuinely broken worker chain. PR
#121 stopped a stale poll from silently driving up to 20 real steps, but
it didn't close this detection gap — a poll now correctly *reports* a
stall, but the report itself can be wrong.

Live repro (2026-09-01): a real `bai` run reported "stalled" at 101s
idle after step 19; resuming with `max_steps: 21` completed step 20
immediately with a valid final answer. Not dead, just slow — plausibly
one bai key-rotation retry (~55s) plus normal step time.

### Approach

1. `agent_worker.js` writes `stepStartedAt` to the checkpoint *before*
   calling `runInvestigation({ singleStep: true })`, not just after it
   returns.
2. `agent_tools.js`'s freshness check uses `max(lastStepAt,
   stepStartedAt)` instead of `lastStepAt` alone — an in-flight step
   counts as fresh even before it completes.
3. Add a second, independent, *longer* ceiling on `stepStartedAt` itself
   (well past worst-case retry time) so a step that looks fresh only
   because the worker crashed mid-step (wrote `stepStartedAt`, never
   returned) still eventually reads as dead. This needs its own
   constant — not the same value as `AGENT_ASYNC_POLL_FRESH_SECONDS`.

### Constraints / caveats

- **Crash blind spot**: without step 3 above, a heartbeat alone trades
  false-stalled for false-alive on worker crash. Both ceilings are
  required, not either/or.
- **Clock source**: `stepStartedAt`/`lastStepAt` must share one
  consistent time source (Redis/store time, not per-caller `Date.now()`)
  or skew reintroduces false readings.
- **Idempotency interplay**: `agent_worker.js` already guards duplicate
  QStash deliveries via `afterStep`/`stepsDone` — the heartbeat write
  must sit inside that same guarded path, or a redelivered message could
  stomp a fresher `stepStartedAt` from the real in-flight attempt.
- **Doesn't diagnose root cause** — a heartbeat tells you "still
  running," not *why* it's slow (bai retry vs. QStash vs. Redis). If
  pinning that down matters later, that needs separate per-hop
  timestamps, not part of this fix.

### Implementation steps

1. [x] Add `stepStartedAt` write in `agent_worker.js`, inside the
   existing `afterStep`/`stepsDone` guard.
2. [x] Update `agent_tools.js`'s freshness check to `max(lastStepAt,
   stepStartedAt)`.
3. [x] Add a separate long-ceiling constant + check for a stuck
   `stepStartedAt` (crash case).
4. [x] Tests: fresh via `stepStartedAt` alone (no completed step yet);
   stale via the new long ceiling despite a fresh-looking
   `stepStartedAt`; duplicate-delivery race doesn't clobber a real
   in-flight heartbeat.
5. [x] Live validation: reproduce the 2026-09-01 101s-gap scenario again
   with the fix in place and confirm no false "stalled" report.

Merged via PR #123 (`main`@`95e83a7`). Full suite passing at merge:
473/473 tests. Live-validated 2026-09-01: a real `bai`-provider
delegate_agent run (run_id `7131e62e-acbe-45a5-a6f4-e799298d1489`) hit
a 40+s idle gap between steps 4 and 5 (bai key-rotation/latency, the
same class of gap as the original 101s repro) — polled repeatedly
through the gap and every poll correctly reported "still running" via
the `stepStartedAt` heartbeat, never a false "stalled." Run completed
normally (5 steps, ~104s wall clock) with a valid final answer. All
five implementation steps now closed.

## Condensed changelog (resolved)

- **History compaction (PR #119)**: replaces stored text of large tool
  results with a pointer once aged past `HISTORY_FULL_DETAIL_STEPS = 3`,
  gated to providers in `HISTORY_COMPACTION_PROVIDERS` (default `"bai"`
  only). Pre-compaction text preserved in a Redis side-store
  (`precompact:{runId}:{id}`) for `findUnverifiedClaims`/
  `lineIsVerbatimInToolResults`, never deleted. 468/468 tests passing at
  merge.
- **resultCache not persisted on resume (PR #120)**: `resultCache` was
  reinitialized empty on every resumed invocation (i.e. every step,
  under `agent_worker.js`'s per-step resume pattern) while
  `repeatCounts` correctly persisted — repeat calls silently
  re-executed instead of being served from cache. Fixed with the same
  side-store pattern as compaction (`resultcache:{runId}:{signature}`).
  Live-validated across a resume boundary and end-to-end.
- **Async poll could drive real steps (PR #121)**: a stale-checkpoint
  poll with no explicit `max_steps` used to fall through to a
  synchronous run capped at a default of 20 steps. Now a poll without
  explicit `max_steps` stays poll-only and reports the stall instead.

## Open items (not started, no active work)

- **New (2026-09-01): genuine QStash worker-chain stall observed live.**
  A second `bai`-provider audit run (run_id
  `7a9a3942-e4f0-4063-a39f-af1ebbff109e`, a full `connectors/` directory
  audit) completed 19 steps normally, then went silent for 154s (past
  the 120s `AGENT_ASYNC_STEP_DEAD_SECONDS` ceiling) and was correctly
  reported as stalled rather than "still running" forever — this is the
  crash-detection half of PR #123 working as designed, a good real-world
  validation of that path specifically (distinct from the false-stall
  fix, which was validated separately same day). All 13 connector
  subfolders had already been read by step 19, so the run was close to
  done. Not yet resumed/diagnosed. Open question: why did the QStash
  re-chain actually break here (a dropped/failed `publishAgentStep`
  call, a worker crash mid-step, a QStash-side delivery failure) —
  the heartbeat fix correctly *detects* dead chains, it doesn't explain
  *why* they die. Worth checking Cloudflare/Vercel function logs for
  this runId's timeframe if it recurs.
- `deleteCheckpoint`'s side-store GC is correct in isolation but never
  called anywhere in the production path (`agent_delegate.js`,
  `agent_worker.js`, `qstash_client.js`, `agent_tools.js`) — cleanup
  relies entirely on the 1hr Redis TTL. Undecided whether something
  should call it after a caller retrieves the final answer.
- Visible step-by-step reasoning text inside assistant `content` (not
  the separate `reasoning_content` field, which is already excluded
  from resend) is never compacted. Try a `SYSTEM_PREAMBLE` prompt fix
  first; only extend compaction to assistant turns if that proves
  unreliable, and only strip the reasoning preamble, never the
  concluding answer.
- Manual token-count validation of compaction vs. an uncompacted
  baseline still hasn't completed a run that survives long enough to
  produce a real comparison.

## Design constraints (apply to any future change in this area)

- Gemini/OpenAI-shaped chat APIs require strict role alternation and
  every `functionCall` paired with a `functionResponse` — never delete
  or reorder whole turns in `contents`; only edit part *content* in
  place.
- No mid-run eviction of verification data (`preCompactionResults` or
  equivalent) — a prior eviction attempt (`2eea726`) was reverted
  (`2e3bf54`) after it broke claim verification above a 200-entry cap.
  Don't reintroduce a cap.
