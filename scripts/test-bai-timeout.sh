#!/usr/bin/env bash
# scripts/test-bai-timeout.sh — reusable diagnostic for bai's forced-final-
# answer reasoning-token-budget-exhaustion failure mode (plan.md Section 25).
#
# NOTE ON PROVENANCE: the original test-bai-timeout.sh used to isolate this
# root cause was written and run in an earlier session's local environment,
# not committed to the repo at the time (see plan.md Section 25/6 -- this
# was a known, tracked gap: "test-bai-timeout.sh not yet committed to the
# repo"). That exact script's contents are not available to reconstruct
# verbatim. This is a fresh script covering the same diagnostic surface
# described in plan.md -- hitting bai's completion endpoint directly,
# bypassing the agent loop entirely -- so the finding remains reproducible
# and this repo has a durable diagnostic tool going forward, per the
# original handoff's housekeeping item ("commit test-bai-timeout.sh to the
# repo as a reusable diagnostic, distinct from the existing mocked-
# providerChat unit tests").
#
# WHAT THIS CHECKS (see plan.md Section 4/25 for the full write-up):
#   - Whether reasoning_effort is a real, honored lever on bai's API
#     (reports reasoning_tokens actually spent at each effort level).
#   - Whether a completion at a given (reasoning_effort, max_tokens) pair
#     hits finish_reason "length" with its answer content empty/near-empty
#     because the token budget went almost entirely to reasoning_tokens --
#     the exact failure connectors/bai/client.js's
#     isReasoningBudgetExhausted() now detects and retries once for, with a
#     larger max_tokens, in the real agent loop.
#   - Repeats each configuration N times (default 5) since this failure is
#     probabilistic, not deterministic at a given config -- a single clean
#     run does NOT mean a given (effort, cap) pair is safe (this was the
#     original finding's own key surprise: reasoning_effort=low still
#     failed 2/5 times at max_tokens=1200 in the investigation that led to
#     this fix).
#
# USAGE:
#   BAI_API_KEYS=key1,key2 ./scripts/test-bai-timeout.sh
#   BAI_API_KEYS=key1 RUNS_PER_CONFIG=10 ./scripts/test-bai-timeout.sh
#
# Requires: bash, curl, python3 (for JSON parsing -- avoids a jq dependency
# this repo's CI image may not have installed).
#
# This is a standalone diagnostic, deliberately NOT wired into the vitest
# suite (test/bai-client.test.js) -- it makes real network calls to bai's
# live API and costs real (if free-tier) API usage, so it's meant to be run
# on demand against the real API, not on every CI run. The vitest suite
# covers the same logic (isReasoningBudgetExhausted, the retry) against
# mocked responses instead, for fast, deterministic, offline CI coverage.

set -euo pipefail

BAI_API="${BAI_API:-https://api.b.ai/v1/chat/completions}"
BAI_MODEL="${BAI_MODEL:-glm-5.3-flash}"
RUNS_PER_CONFIG="${RUNS_PER_CONFIG:-5}"

if [[ -z "${BAI_API_KEYS:-}" ]]; then
  echo "Error: BAI_API_KEYS is not set (comma-separated list of at least one B.AI API key)." >&2
  exit 1
fi
IFS=',' read -ra KEYS <<< "$BAI_API_KEYS"
API_KEY="${KEYS[0]}"

# A prompt shaped to invite substantial internal reasoning before answering
# -- deliberately open-ended/analytical rather than a simple factual lookup,
# since a trivial prompt is unlikely to reproduce the reasoning-heavy
# completion path this diagnostic exists to probe.
PROMPT='Walk through, step by step, how you would design a rate limiter for a
high-traffic public API that needs to support both per-user and per-IP
limits, sliding windows, and graceful degradation under Redis outages.
Consider at least three different algorithmic approaches and weigh their
tradeoffs before giving a final recommendation.'

run_one() {
  local reasoning_effort="$1"
  local max_tokens="$2"

  local body
  if [[ -n "$reasoning_effort" ]]; then
    body=$(python3 -c '
import json, sys
print(json.dumps({
    "model": sys.argv[1],
    "messages": [{"role": "user", "content": sys.argv[2]}],
    "max_tokens": int(sys.argv[3]),
    "reasoning_effort": sys.argv[4],
}))
' "$BAI_MODEL" "$PROMPT" "$max_tokens" "$reasoning_effort")
  else
    body=$(python3 -c '
import json, sys
print(json.dumps({
    "model": sys.argv[1],
    "messages": [{"role": "user", "content": sys.argv[2]}],
    "max_tokens": int(sys.argv[3]),
}))
' "$BAI_MODEL" "$PROMPT" "$max_tokens")
  fi

  local response
  response=$(curl -sS -m 60 -X POST "$BAI_API" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body") || { echo "  request failed (network/timeout)"; return; }

  python3 -c '
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception as e:
    print(f"  could not parse response as JSON: {e}")
    sys.exit(0)

choice = (data.get("choices") or [{}])[0]
finish_reason = choice.get("finish_reason", "?")
content = (choice.get("message") or {}).get("content") or ""
usage = data.get("usage") or {}
completion_tokens = usage.get("completion_tokens", "?")
reasoning_tokens = usage.get("reasoning_tokens")
if reasoning_tokens is None:
    reasoning_tokens = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", "?")

exhausted = "?"
if finish_reason == "length" and isinstance(reasoning_tokens, int) and isinstance(completion_tokens, int) and completion_tokens > 0:
    exhausted = "YES" if (reasoning_tokens / completion_tokens) >= 0.9 else "no"

print(f"  finish_reason={finish_reason} completion_tokens={completion_tokens} reasoning_tokens={reasoning_tokens} answer_chars={len(content)} budget_exhausted_on_reasoning={exhausted}")
' "$response"
}

echo "=== bai reasoning-token-budget-exhaustion diagnostic (plan.md Section 25) ==="
echo "Model: $BAI_MODEL | Runs per config: $RUNS_PER_CONFIG"
echo

for effort in "" "low" "high" "max"; do
  for max_tokens in 300 1200 4096; do
    label="${effort:-<unset>}"
    echo "--- reasoning_effort=$label, max_tokens=$max_tokens ---"
    for i in $(seq 1 "$RUNS_PER_CONFIG"); do
      echo " run $i/$RUNS_PER_CONFIG:"
      run_one "$effort" "$max_tokens"
    done
    echo
  done
done

echo "=== done ==="
echo "A config is NOT safe just because one run passed -- this failure is"
echo "probabilistic (see plan.md Section 25: reasoning_effort=low still"
echo "failed 2/5 times at max_tokens=1200 in the original investigation)."
echo "Look for ANY 'budget_exhausted_on_reasoning=YES' line above."
