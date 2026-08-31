# Plan: Reduce context/token bloat in delegate_agent's investigation loop

## Context

`connectors/gemini/agent_delegate.js`'s investigation loop accumulates a
single `contents` array across all steps and re-sends it *in full* on
every subsequent `providerChat` call:

- Model turns (`{ role: "model", parts }`, including `functionCall`
  parts) are pushed every step.
- Tool results are pushed every step as
  `{ role: "user", parts: [functionResponse, ...] }`.
- Nothing is ever pruned, summarized, or truncated once it's in
  `contents` — large payloads (e.g. `github_read_file` results up to
  30,000 chars) stay in history verbatim for the rest of the run and get
  re-transmitted, and re-billed as input tokens, on every later step.

Per-tool output caps exist (`github_read_file` chunks at 30k chars,
`github_search_issues` caps at 20k, logs at 25–30k), but those only bound
a *single* tool response, not what accumulates in `contents` over a
30-step run. There is currently no history-length guard, no token budget
check, and no summarization.

This was surfaced concretely: a `delegate_agent` run on `provider: "bai"`
burned through all 3 configured `BAI_API_KEYS`' free-tier quota by
roughly step 16, on a task that repeatedly read large files
(`agent_delegate.js` itself, 128,411 chars, chunk-read across 5 calls).
Confirmed via B.AI's docs (https://docs.b.ai/llmservice/api/) that this
is not a hidden reasoning-token issue — `/v1/chat/completions` doesn't
return a separate `reasoning_content`/`thinking` field, only a
`completion_tokens_details.reasoning_tokens` *count*. The bloat is
ordinary re-sent history, nothing more exotic.

## Hard constraint: this is NOT free-form trimming

Gemini/OpenAI-shaped chat APIs enforce strict `user` → `model` → `user`
role alternation, and every `functionCall` part must be paired with a
matching `functionResponse` part (by name/id) later in the same or next
turn. **Deleting messages from the middle of `contents` is not safe** —
it will produce malformed sequences and get requests rejected outright.
Any fix must edit the *content* of a part in place, never remove/reorder
whole turns.

## Approach chosen: compact historical tool-result storage (in place, not deleted)

Keep every `functionResponse`'s full, real output on the step it's
freshly returned — the model needs the complete content when it's
actively reasoning about it. Once a turn ages past a small "recent"
window (e.g. more than ~3 steps old), replace the stored text of large,
known-bulky tool results in `contents` with a short pointer/summary,
while leaving the surrounding turn structure (roles, functionCall id
pairing) untouched.

This was chosen over two rejected/deferred alternatives:
- **Sliding-window truncation of whole older turns** — higher risk of
  "state amnesia" (losing findings the model hasn't yet acted on) and of
  forcing redundant re-reads; deferred as a possible later optimization,
  not a first step.
- **Aggressive dedup of repeated file reads** — reasonable but additive;
  worth doing on top of the compaction approach below once it's proven
  out, not instead of it.

## Decision: switchable per-provider, default only "bai"

Gemini's native context window is large and there's no evidence it needs
this compaction -- applying it universally is unnecessary risk for zero
proven benefit there. Instead of a blanket rollout, this ships as an
opt-in switch, config-driven per provider:

- New `config.js` export, e.g. `HISTORY_COMPACTION_PROVIDERS` -- a
  comma-separated env-driven list (same `.split/map/filter` pattern as
  `BAI_API_KEYS` etc.), default value `"bai"` only.
- `agent_delegate.js`'s compaction step (see below) checks whether the
  current run's `provider` is in that set before doing any compaction;
  if not, behavior is 100% unchanged from today (full history, as now).
- This means Gemini/GLM/Groq runs are provider-untouched by default, and
  `bai` gets compaction on immediately. Any provider can be added to or
  removed from the list later purely via config, no code change, once
  we have real before/after data per provider.

## Steps

1. **Identify "bulky" tool types to compact** — start narrow:
   `github_read_file`, `github_get_file_tree`, log/CI-output tools
   (matches the existing per-tool cap list in `agent_delegate.js`). Do
   not touch small/structured results (e.g. `github_get_commit` metadata,
   `github_list_branches`).

2. **Add a "recent window" constant** (e.g. `HISTORY_FULL_DETAIL_STEPS =
   3`, named/tuned alongside the existing `HARD_MAX_STEPS = 30`) in
   `connectors/gemini/agent_delegate.js`.

3. **Compact on write, not on read, and only when the provider opts in**
   — check `HISTORY_COMPACTION_PROVIDERS.includes(provider)` first; if
   the current run's provider isn't in the list, skip compaction
   entirely and behave exactly as today. When it IS enabled, before
   appending a new step's
   turns to `contents`, walk back over turns older than the recent
   window and, for any `functionResponse` part whose tool name is in the
   bulky list and whose stored text exceeds a small threshold (e.g. 500
   chars), replace it with a fixed-format pointer, e.g.:
   `[Earlier tool result compacted: github_read_file on
   connectors/gemini/agent_delegate.js, originally 30000 chars — call
   the tool again if the exact content is needed; resultCache will serve
   it without a new network round trip.]`
   Keep `finishReason`/role structure and `functionCall`/`functionResponse`
   id pairing completely intact — only the inner text changes.

4. **Rely on the existing `resultCache`** (already dedupes identical
   tool calls within a run) as the safety net for approach's main risk:
   if the model asks for a compacted file again, it's served from cache,
   not a wasted new network call — so compaction can't cause the "runs
   out of budget re-fetching" failure mode.

5. **Tests** — add cases to whatever exercises `agent_delegate.js`'s loop
   (or a new focused test) covering: with `provider: "bai"` (compaction
   on) a bulky result stays full within the recent window, gets
   compacted once it ages out, non-bulky results are never compacted,
   and a compacted-then-re-requested file is served from `resultCache`
   rather than re-fetched; AND with `provider: "gemini"` (compaction
   off, default) confirm history is untouched -- same behavior as before
   this change, byte-for-byte.

6. **Manual validation** — run a real multi-step `delegate_agent`
   investigation with `provider: "bai"` that reads several large files,
   and confirm (a) total input tokens per step levels off instead of
   growing linearly step over step, and (b) the final answer's
   quality/accuracy is unaffected versus an uncompacted baseline run on
   the same task. Separately confirm a `provider: "gemini"` run on the
   same task is completely unaffected (compaction never triggers).

## Open questions going into implementation

- Exact threshold values (`HISTORY_FULL_DETAIL_STEPS`, per-part char
  threshold) are starting guesses — should be tuned after step 6's
  manual comparison, not treated as final.
- Whether compaction should apply per-provider (e.g. skip it entirely
  for Gemini native calls, which may have much larger context windows
  and cheaper/no token cost pressure) or uniformly across all providers
  via the shared loop. Default to uniform first since the loop itself is
  provider-agnostic; revisit only if Gemini-specific runs show no real
  benefit from it.
