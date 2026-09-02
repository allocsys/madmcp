#!/data/data/com.termux/files/usr/bin/bash
# test-bai-timeout.sh
#
# Probes whether LARGE INPUT or UNCAPPED OUTPUT is the bigger driver of the
# step-3 timeouts seen in madmcp's delegate_agent(provider: "bai") runs, and
# whether the `reasoning_effort` param (low/high/max) can shrink the hidden
# reasoning tail on glm-5.3-flash directly.
#
# Setup in Termux:
#   pkg install curl python -y
#   export BAI_API_KEY="sk-..."      # one real key from BAI_API_KEYS
#   bash test-bai-timeout.sh
#
# What it does: fires requests directly at api.b.ai (bypassing madmcp
# entirely) and times each one against the 55s BAI_REQUEST_TIMEOUT_MS ceiling
# used in connectors/bai/client.js:
#   1. baseline           - small in / small out
#   2. large input        - ~120k chars in / normal out
#   3. uncapped output    - small in / "write as much as you can", no max_tokens
#   4. capped output      - same prompt as #3, but max_tokens=300 (control)
#                            -- now runs CASE4_REPEATS times (default 5) since
#                               a single run already flipped pass/fail on
#                               identical params; see Open Question #1.
#   5. reasoning_effort=low  - trivial prompt, generous max_tokens (2000)
#   6. reasoning_effort=high - trivial prompt, generous max_tokens (2000)
#   7. reasoning_effort=max  - trivial prompt, generous max_tokens (2000)
#   8. reasoning_effort=low  - essay prompt, max_tokens=300 (real-world-ish cap)
#   9. reasoning_effort=low  - essay prompt, max_tokens=1200 (find natural
#                              settle point without hitting the ~55-65s
#                              server-side kill seen in case 3)
#                            -- now runs CASE9_REPEATS times (default 5) to
#                               see how often the 1200 cap still gets fully
#                               consumed by reasoning with zero answer, as
#                               happened in case 8.
#
# Cases 4 and 9 write per-iteration CSVs to $TMPD/case4_repeats.csv and
# $TMPD/case9_repeats.csv (label,iter,http_code,curl_exit,elapsed_s,
# finish_reason,reasoning_tokens,completion_tokens,answer_tokens,
# has_answer_content) plus a printed distribution summary, per the
# handoff's "Immediate next step." Override repeat counts with
# CASE4_REPEATS / CASE9_REPEATS env vars if you want more/fewer than 5.
#
# If #2 is the slow one -> input/context processing is the bottleneck.
# If #3 is the slow one (and #4 is fast) -> uncapped output length is the
# bottleneck, and capping max_tokens on the final step is a valid fix.
# Cases 5-7 compare reasoning_tokens spent at each effort level on the SAME
# trivial prompt -- if low/high meaningfully cut reasoning_tokens vs max,
# that's a cleaner fix than just raising max_tokens (per case 3's finding
# that glm-5.3-flash spends 89-99% of its budget on hidden reasoning).
# Case 8 checks whether a low-effort + realistically-sized cap actually lets
# the model finish with real answer content instead of getting cut off
# mid-reasoning like case 4 did.
# Case 9 removes the tight 300-token cap to find where reasoning_effort=low
# naturally stops on a hard prompt -- that number is the real input for
# sizing BAI_DEFAULT_MAX_OUTPUT_TOKENS, not a guess or a copy-paste default.
# IMPORTANT: case 3 showed B.AI kills the connection at ~55-65s regardless
# of max_tokens -- a TIME cutoff, not a token-count one. At the ~20-25
# tok/s generation rate seen in cases 1/4, that window caps out around
# 1100-1600 output tokens. So max_tokens=1200 here is chosen to plausibly
# finish before that kill, not because it's expected to be the true settle
# point. If finish_reason still comes back "length" (cap exhausted) rather
# than "stop" (model finished on its own), that means the natural settle
# point is even higher than what the server's time window allows in one
# call -- which is itself an important finding: it'd mean no single
# max_tokens value both (a) lets the model finish this kind of hard prompt
# and (b) completes before the server's own timeout, and the real fix needs
# a request-level workaround (e.g. streaming, or raising reasoning_effort
# constraints on delegate_agent's prompts) rather than just a bigger cap.

set -euo pipefail

TMPD="${TMPDIR:-$HOME/tmp}"
mkdir -p "$TMPD"

: "${BAI_API_KEY:?Set BAI_API_KEY first: export BAI_API_KEY=sk-...}"

BAI_API="https://api.b.ai/v1/chat/completions"
BAI_MODEL="${BAI_MODEL:-glm-5.3-flash}"

run_case() {
  local label="$1"
  local body_file="$2"
  # Optional: pass a CSV file path as $3 and an iteration number as $4 to
  # additionally append a machine-readable row (used by run_repeated below).
  local csv_file="${3:-}"
  local iter="${4:-}"

  echo "=== $label ==="
  rm -f "$TMPD/bai_resp.json"
  local t0 t1 elapsed http_code curl_exit
  t0=$(date +%s.%N)
  set +e
  http_code=$(curl -s -o "$TMPD/bai_resp.json" -w "%{http_code}" \
    -X POST "$BAI_API" \
    -H "Authorization: Bearer $BAI_API_KEY" \
    -H "Content-Type: application/json" \
    --max-time 90 \
    -d @"$body_file")
  curl_exit=$?
  set -e
  t1=$(date +%s.%N)
  elapsed=$(python3 -c "print(f'{$t1 - $t0:.2f}')")
  if [ "$curl_exit" -ne 0 ]; then
    echo "curl exited with code $curl_exit after ${elapsed}s (see 'man curl' exit codes; 28=timeout, 52/56=server closed connection)"
    echo
    if [ -n "$csv_file" ]; then
      echo "${label},${iter},,${curl_exit},${elapsed},,,,," >> "$csv_file"
    fi
    return
  fi
  echo "HTTP $http_code in ${elapsed}s"

  LABEL="$label" ITER="$iter" HTTP_CODE="$http_code" CURL_EXIT="$curl_exit" ELAPSED="$elapsed" \
  RESP_FILE="$TMPD/bai_resp.json" CSV_FILE="$csv_file" python3 - <<'PY' 2>/dev/null || (echo "raw response:" && head -c 300 "$TMPD/bai_resp.json" 2>/dev/null || echo "(no response file written)")
import json, os, csv

label = os.environ.get("LABEL", "")
iter_ = os.environ.get("ITER", "")
http_code = os.environ.get("HTTP_CODE", "")
curl_exit = os.environ.get("CURL_EXIT", "")
elapsed = os.environ.get("ELAPSED", "")
csv_file = os.environ.get("CSV_FILE", "")

finish_reason = reasoning_tokens = completion_tokens = answer_tokens = has_answer = ""
try:
    d = json.load(open(os.environ["RESP_FILE"]))
    choice = (d.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    usage = d.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    reasoning_tokens_v = details.get("reasoning_tokens")
    completion_tokens_v = usage.get("completion_tokens")
    content = (msg.get("content") or "").strip()
    reasoning_content = (msg.get("reasoning_content") or "").strip()

    finish_reason = choice.get("finish_reason")
    print("finish_reason:", finish_reason)
    print("usage:", usage)
    if reasoning_tokens_v is not None and completion_tokens_v:
        answer_tokens_v = completion_tokens_v - reasoning_tokens_v
        pct = (reasoning_tokens_v / completion_tokens_v * 100) if completion_tokens_v else 0
        print(f"reasoning_tokens: {reasoning_tokens_v} / completion_tokens: {completion_tokens_v} "
              f"({pct:.0f}% reasoning, {answer_tokens_v} answer tokens)")
        reasoning_tokens, completion_tokens, answer_tokens = reasoning_tokens_v, completion_tokens_v, answer_tokens_v
    print("answer content:", repr(content[:150]) if content else "(empty)")
    has_answer = "1" if content else "0"
    if reasoning_content:
        print("reasoning_content snippet:", repr(reasoning_content[:100]))
except Exception as e:
    print("parse error:", e)

if csv_file:
    with open(csv_file, "a", newline="") as f:
        w = csv.writer(f)
        w.writerow([label, iter_, http_code, curl_exit, elapsed, finish_reason,
                    reasoning_tokens, completion_tokens, answer_tokens, has_answer])
PY
  echo
}

# Runs `run_case` N times for the same body_file, logging one CSV row per
# iteration to $TMPD/<csv_name>, then prints a distribution summary.
# CSV columns: label,iter,http_code,curl_exit,elapsed_s,finish_reason,
#              reasoning_tokens,completion_tokens,answer_tokens,has_answer_content
run_repeated() {
  local label_prefix="$1"
  local body_file="$2"
  local n="$3"
  local csv_name="$4"
  local csv_file="$TMPD/$csv_name"

  rm -f "$csv_file"
  echo "label,iter,http_code,curl_exit,elapsed_s,finish_reason,reasoning_tokens,completion_tokens,answer_tokens,has_answer_content" > "$csv_file"

  local i
  for i in $(seq 1 "$n"); do
    run_case "${label_prefix} [run $i/$n]" "$body_file" "$csv_file" "$i"
  done

  echo "--- Distribution summary: $label_prefix ($n runs) ---"
  CSV_FILE="$csv_file" python3 - <<'PY'
import csv, os, statistics as stats

rows = list(csv.DictReader(open(os.environ["CSV_FILE"])))
n = len(rows)
curl_fail = [r for r in rows if r["curl_exit"] not in ("0", "")]
ok = [r for r in rows if r not in curl_fail]

print(f"runs: {n}")
print(f"curl exit != 0 (server-killed / timed out): {len(curl_fail)}/{n}"
      + (f"  (exit codes: {[r['curl_exit'] for r in curl_fail]})" if curl_fail else ""))

if ok:
    finishes = [r["finish_reason"] for r in ok if r["finish_reason"]]
    stop_ct = finishes.count("stop")
    length_ct = finishes.count("length")
    print(f"finish_reason=stop: {stop_ct}/{len(ok)}, finish_reason=length: {length_ct}/{len(ok)}")

    empty_answer = [r for r in ok if r["has_answer_content"] == "0"]
    print(f"empty answer content (0 answer tokens reached user): {len(empty_answer)}/{len(ok)}")

    reasoning = [int(r["reasoning_tokens"]) for r in ok if r["reasoning_tokens"]]
    if reasoning:
        print(f"reasoning_tokens: min={min(reasoning)} max={max(reasoning)} "
              f"mean={stats.mean(reasoning):.0f} "
              f"stdev={stats.stdev(reasoning):.0f}" if len(reasoning) > 1 else
              f"reasoning_tokens: {reasoning}")

    elapsed = [float(r["elapsed_s"]) for r in ok if r["elapsed_s"]]
    if elapsed:
        print(f"elapsed_s: min={min(elapsed):.1f} max={max(elapsed):.1f} mean={stats.mean(elapsed):.1f}")
else:
    print("(no successful HTTP responses to summarize)")

print(f"raw CSV: {os.environ['CSV_FILE']}")
PY
  echo
}

run_effort_case() {
  local label="$1"
  local prompt="$2"
  local effort="$3"
  local max_tokens="$4"
  local body_file="$TMPD/case_effort_$$.json"

  python3 -c "
import json
print(json.dumps({
    'model': '$BAI_MODEL',
    'messages': [{'role': 'user', 'content': '''$prompt'''}],
    'reasoning_effort': '$effort',
    'max_tokens': $max_tokens
}))
" > "$body_file"
  run_case "$label" "$body_file"
  rm -f "$body_file"
}

# Same as run_effort_case, but runs the identical request N times via
# run_repeated to get a distribution instead of a single data point.
run_effort_case_repeated() {
  local label_prefix="$1"
  local prompt="$2"
  local effort="$3"
  local max_tokens="$4"
  local n="$5"
  local csv_name="$6"
  local body_file="$TMPD/case_effort_repeated_$$.json"

  python3 -c "
import json
print(json.dumps({
    'model': '$BAI_MODEL',
    'messages': [{'role': 'user', 'content': '''$prompt'''}],
    'reasoning_effort': '$effort',
    'max_tokens': $max_tokens
}))
" > "$body_file"
  run_repeated "$label_prefix" "$body_file" "$n" "$csv_name"
  rm -f "$body_file"
}

# --- Case 1: baseline ---
cat > "$TMPD/case1.json" <<JSON
{"model":"$BAI_MODEL","messages":[{"role":"user","content":"Say OK."}]}
JSON
run_case "1. baseline (small in / small out)" "$TMPD/case1.json"

# --- Case 2: large input, normal output ---
python3 -c "
import json
big = 'x' * 120000  # order-of-magnitude match to the two truncated 30k-char
                     # file reads + repo scan results in the stalled run
msg = 'Here is some repo context:\n' + big + '\nBased on the above, briefly say OK.'
print(json.dumps({'model': '$BAI_MODEL', 'messages':[{'role':'user','content': msg}]}))
" > "$TMPD/case2.json"
run_case "2. large input (~120k chars) / normal output" "$TMPD/case2.json"

# --- Case 3: small input, uncapped output ---
cat > "$TMPD/case3.json" <<JSON
{"model":"$BAI_MODEL","messages":[{"role":"user","content":"Write an extremely long, exhaustive, maximally detailed essay comparing every major programming language in depth. Go as long as you possibly can. Do not stop early or summarize -- be maximally verbose."}]}
JSON
run_case "3. small input / UNCAPPED output (no max_tokens set)" "$TMPD/case3.json"

# --- Case 4: same prompt, capped output (control) ---
# Per Open Question #1 in the handoff, a single run of this case already
# flipped (200/finished vs curl-56/server-killed) on identical params, so
# this now runs N times to get a distribution instead of one data point.
CASE4_REPEATS="${CASE4_REPEATS:-5}"
python3 -c "
import json
print(json.dumps({
    'model': '$BAI_MODEL',
    'messages': [{'role':'user','content':'Write an extremely long, exhaustive, maximally detailed essay comparing every major programming language in depth. Go as long as you possibly can. Do not stop early or summarize -- be maximally verbose.'}],
    'max_tokens': 300
}))
" > "$TMPD/case4.json"
run_repeated "4. same prompt, max_tokens=300 (control)" "$TMPD/case4.json" "$CASE4_REPEATS" "case4_repeats.csv"

# --- Case 5-7: reasoning_effort low/high/max, trivial prompt, generous cap ---
# Generous max_tokens (2000) so effort level -- not the token cap -- is what
# determines whether we get real answer content back.
run_effort_case "5. reasoning_effort=low (trivial prompt, max_tokens=2000)" \
  "Say OK." "low" 2000

run_effort_case "6. reasoning_effort=high (trivial prompt, max_tokens=2000)" \
  "Say OK." "high" 2000

run_effort_case "7. reasoning_effort=max (trivial prompt, max_tokens=2000)" \
  "Say OK." "max" 2000

# --- Case 8: reasoning_effort=low + realistic cap, essay prompt ---
# Same demanding prompt as cases 3/4, but now paired with low reasoning
# effort instead of just a bare max_tokens cap. If this finishes with real
# answer content (unlike case 4, which got cut off mid-reasoning), that
# confirms reasoning_effort is the more targeted fix.
run_effort_case "8. reasoning_effort=low + max_tokens=300 (essay prompt)" \
  "Write an extremely long, exhaustive, maximally detailed essay comparing every major programming language in depth. Go as long as you possibly can. Do not stop early or summarize -- be maximally verbose." \
  "low" 300

# --- Case 9: reasoning_effort=low, essay prompt, larger-but-safe cap ---
# See comment block above for why 1200 (not something huge like 8000) is
# the right ceiling to test here. Run 1 found 68/1200 reasoning tokens and
# finished at 39s, but case 8 showed 300/300 reasoning tokens (zero answer)
# is also possible for this same effort level on this same prompt -- so
# this now runs N times to see how often the 1200 cap still gets fully
# consumed by reasoning with zero answer content.
CASE9_REPEATS="${CASE9_REPEATS:-5}"
run_effort_case_repeated "9. reasoning_effort=low + max_tokens=1200 (essay prompt, sizing run)" \
  "Write an extremely long, exhaustive, maximally detailed essay comparing every major programming language in depth. Go as long as you possibly can. Do not stop early or summarize -- be maximally verbose." \
  "low" 1200 "$CASE9_REPEATS" "case9_repeats.csv"

echo "-----------------------------------------------------------"
echo "Compare elapsed times above against:"
echo "  - BAI_REQUEST_TIMEOUT_MS = 55000ms (client.js's own abort ceiling)"
echo "  - QStash's step execution window (the thing that actually timed"
echo "    out in run 1ab84bfd, per its failureCallback message)"
echo ""
echo "If case 2 is disproportionately slow -> input size is the driver."
echo "If case 3 is disproportionately slow relative to case 4 -> uncapped"
echo "output length is the driver, and capping max_tokens on the final"
echo "delegate_agent step is a valid, targeted fix."
echo ""
echo "Compare reasoning_tokens across cases 5/6/7 (same trivial prompt,"
echo "only reasoning_effort differs):"
echo "  - If low << high << max -> reasoning_effort is a real, controllable"
echo "    lever; set it explicitly instead of relying on a bare max_tokens cap."
echo "  - If they're all similar -> reasoning_effort may not be honored by"
echo "    B.AI's API even though it's a documented GLM param; fall back to"
echo "    sizing BAI_DEFAULT_MAX_OUTPUT_TOKENS generously instead."
echo "Check case 8's 'answer content' line: if it's non-empty (unlike case 4,"
echo "which got cut off mid-reasoning at max_tokens=300), reasoning_effort=low"
echo "is the fix to ship -- it lets a small cap still produce a real answer."
echo ""
echo "Case 9 (max_tokens=1200, $CASE9_REPEATS runs) sizing read -- see the"
echo "distribution summary printed above case 9's block, and the raw CSV at"
echo "\$TMPD/case9_repeats.csv:"
echo "  - If finish_reason=stop in most/all runs -> take the max"
echo "    completion_tokens seen across runs as your real"
echo "    BAI_DEFAULT_MAX_OUTPUT_TOKENS floor (add headroom, don't ship the"
echo "    exact number, since case 8 showed a >4x swing is possible)."
echo "  - If finish_reason=length / empty-answer shows up in more than a"
echo "    rare outlier of the $CASE9_REPEATS runs -> 1200 isn't reliable either;"
echo "    check elapsed times against the ~55-65s server-kill window. If"
echo "    it's common, no single max_tokens value can both finish this kind"
echo "    of prompt AND avoid the server timeout -- the fix isn't a bigger"
echo "    cap, it's reducing what delegate_agent asks the bai provider to do"
echo "    in one shot (e.g. smaller per-step asks, or streaming), or adding"
echo "    a detect-empty-answer-and-retry-with-bigger-budget path."
echo ""
echo "Case 4 (max_tokens=300, $CASE4_REPEATS runs) variance read -- this is"
echo "the input to Open Question #1 in the handoff:"
echo "  - curl exit 56 in 0 or 1 of $CASE4_REPEATS runs -> run 2's failure was"
echo "    likely a rare outlier; reasoning_effort=low + a headroom-sized cap"
echo "    (per case 9's read above) is probably sufficient."
echo "  - curl exit 56 in 2+ of $CASE4_REPEATS runs -> variance is common, not"
echo "    a fluke; a fixed max_tokens cap alone (even with reasoning_effort"
echo "    set) may not reliably avoid both truncated answers and server-side"
echo "    timeout kills -- lean toward the architectural fix instead."
