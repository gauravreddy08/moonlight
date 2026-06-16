#!/usr/bin/env bash
#
# moonlight — interval gate + single-flight background trade spawn.
#
# This is the ONLY place that spends Claude credits, and only when a trade run
# is genuinely due. Everything here up to the spawn is plain shell/node.
# Always exits 0 so it never blocks a session from closing.

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LIB="$ROOT/bin/lib.js"

DATA="$(node "$LIB" seed 2>/dev/null | tail -n1)"
[ -n "$DATA" ] || exit 0
LOCK="$DATA/run.lock"
RUNS="$DATA/runs"

get() { node "$LIB" get "$@" 2>/dev/null; }

# 1. Recursion kill-switch: a background trade session itself fires
#    SessionStart/Stop hooks. Never let it spawn another run.
[ "${MOONLIGHT_BG:-}" = "1" ] && exit 0

# 2. Globally enabled?
[ "$(get config enabled)" = "true" ] || exit 0

# 3. Single-flight: is a background run already alive?
if [ -f "$LOCK" ]; then
  pid="$(cat "$LOCK" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    exit 0 # one is running; do not spawn a second
  fi
  rm -f "$LOCK" # stale lock from a crashed run
fi

now="$(date +%s)"

# 4. Due? (agent self-schedules nextRunEpoch; 0 means "run on next activity")
next="$(get state nextRunEpoch)"
if [ -n "$next" ] && [ "$next" -gt 0 ] 2>/dev/null && [ "$now" -lt "$next" ]; then
  exit 0
fi

# 5. Min-interval floor (anti-misconfiguration): >= 60s since last run.
last="$(get state lastRunEpoch)"
if [ -n "$last" ] && [ "$last" -gt 0 ] 2>/dev/null && [ "$((now - last))" -lt 60 ]; then
  exit 0
fi

# 6. Market hours, if required.
if [ "$(get config marketHoursOnly)" = "true" ]; then
  node "$LIB" market-open || exit 0
fi

# 7. Daily cap.
node "$LIB" under-daily-cap || exit 0

# --- all gates passed: spend credits ---------------------------------------

mkdir -p "$RUNS"
ts="$(date +%Y%m%d-%H%M%S)"
log="$RUNS/run-$ts.log"
model="$(get config tradeModel)"

prompt="You are moonlight's background trading agent. Read and follow the \
instructions in $ROOT/skills/moonlight/SKILL.md exactly. Your plugin data \
directory is $DATA. Run ONE trading cycle now, then stop. Be concise; spend as \
few tokens as possible."

# Spawn detached. MOONLIGHT_BG=1 disarms the gate inside this child session.
# The child is a fresh `claude` without this plugin loaded, so put bin/ on its
# PATH — that's how the bare `moonlight` command resolves inside the run.
# Tools are scoped so the run never prompts for permission.
MOONLIGHT_BG=1 CLAUDE_PLUGIN_DATA="$DATA" CLAUDE_PLUGIN_ROOT="$ROOT" \
  PATH="$ROOT/bin:$PATH" \
  nohup claude -p "$prompt" \
  ${model:+--model "$model"} \
  --allowedTools "mcp__plugin_moonlight_robinhood-trading__*,Read,Write,Bash" \
  >"$log" 2>&1 &

echo $! >"$LOCK"
node "$LIB" record-spawn 2>/dev/null

exit 0
