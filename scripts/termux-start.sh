#!/data/data/com.termux/files/usr/bin/bash
# ---------------------------------------------------------------------------
# scripts/termux-start.sh -- one-step setup + launcher for madmcp's Termux
# agent. Runs INSIDE Termux.
#
#   bash termux-start.sh          install deps, ask for config once, run agent
#   bash termux-start.sh bg       same, but in a detached tmux session
#   bash termux-start.sh stop     stop the tmux session
#   bash termux-start.sh config   re-enter the server URL / secret
#   bash termux-start.sh update   re-download termux-agent.mjs
#
# Files live in ~/madmcp-agent/ (env = URL + secret, chmod 600).
#
# Env for the download step:
#   MADMCP_REF        git ref to fetch the agent from (default: main)
#   MADMCP_AGENT_SRC  full URL override for termux-agent.mjs
#   GITHUB_TOKEN      only needed if the repo is private
# If termux-agent.mjs sits next to this script, it is used instead.
# ---------------------------------------------------------------------------
set -eu

DIR="$HOME/madmcp-agent"
CONF="$DIR/env"
AGENT="$DIR/termux-agent.mjs"
REF="${MADMCP_REF:-main}"
SRC="${MADMCP_AGENT_SRC:-https://raw.githubusercontent.com/allocsys/madmcp/${REF}/scripts/termux-agent.mjs}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SESSION="madmcp-agent"

install_deps() {
  local need=()
  command -v node >/dev/null 2>&1 || need+=(nodejs)
  command -v curl >/dev/null 2>&1 || need+=(curl)
  command -v termux-battery-status >/dev/null 2>&1 || need+=(termux-api)
  if [ "${#need[@]}" -gt 0 ]; then
    echo "Installing: ${need[*]}"
    pkg update -y
    pkg install -y "${need[@]}"
  fi
}

# Copies a sibling termux-agent.mjs if there is one, otherwise downloads it.
# With "force" it refreshes even if ~/madmcp-agent/termux-agent.mjs exists.
ensure_agent() {
  mkdir -p "$DIR"
  local sibling
  sibling="$(dirname "$SELF")/termux-agent.mjs"
  if [ -f "$sibling" ]; then
    [ "$sibling" = "$AGENT" ] || cp "$sibling" "$AGENT"
    return
  fi
  if [ -f "$AGENT" ] && [ "${1:-}" != "force" ]; then
    return
  fi
  echo "Downloading agent from $SRC"
  local auth=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth=(-H "Authorization: token ${GITHUB_TOKEN}")
  fi
  if ! curl -fsSL "${auth[@]}" -o "$AGENT.tmp" "$SRC"; then
    rm -f "$AGENT.tmp"
    echo "Download failed. If the repo is private, export GITHUB_TOKEN first; if the branch isn't merged yet, set MADMCP_REF=<branch>." >&2
    exit 1
  fi
  mv "$AGENT.tmp" "$AGENT"
}

configure() {
  mkdir -p "$DIR"
  local url secret
  read -r -p "madmcp server URL (https://...): " url
  url="${url%/}"
  case "$url" in
    https://*) ;;
    *) echo "The URL must start with https://" >&2; exit 1 ;;
  esac
  read -r -s -p "TERMUX_AGENT_SECRET (hidden): " secret
  echo
  if [ -z "$secret" ]; then
    echo "The secret cannot be empty." >&2
    exit 1
  fi
  (
    umask 077
    {
      printf 'export MADMCP_URL=%q\n' "$url"
      printf 'export TERMUX_AGENT_SECRET=%q\n' "$secret"
    } > "$CONF"
  )
  chmod 600 "$CONF"
  echo "Saved to $CONF"
}

run_agent() {
  [ -f "$CONF" ] || configure
  ensure_agent
  # shellcheck disable=SC1090
  . "$CONF"
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
    trap 'termux-wake-unlock' EXIT
  fi
  while true; do
    set +e
    node "$AGENT"
    code=$?
    set -e
    # 0 = clean stop (Ctrl-C), 1 = bad config; anything else is a crash.
    if [ "$code" -eq 0 ] || [ "$code" -eq 1 ]; then
      break
    fi
    echo "Agent exited with code $code; restarting in 5s" >&2
    sleep 5
  done
}

start_bg() {
  command -v tmux >/dev/null 2>&1 || pkg install -y tmux
  [ -f "$CONF" ] || configure
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Already running (tmux session '$SESSION')."
    return
  fi
  tmux new-session -d -s "$SESSION" "bash '$SELF' run"
  echo "Started in tmux session '$SESSION'."
  echo "View logs:  tmux attach -t $SESSION   (detach with Ctrl-b then d)"
  echo "Stop:       bash $SELF stop"
}

case "${1:-run}" in
  run)    install_deps; run_agent ;;
  bg)     install_deps; start_bg ;;
  stop)   tmux kill-session -t "$SESSION" && echo "Stopped." ;;
  config) configure ;;
  update) install_deps; ensure_agent force; echo "Agent updated." ;;
  *)      echo "Usage: bash termux-start.sh [run|bg|stop|config|update]" >&2; exit 2 ;;
esac
