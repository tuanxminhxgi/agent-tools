#!/usr/bin/env bash
#
# LAYER 3 — headless driver: runs the whole backlog, ONE SESSION PER TASK.
#
# Differs from the Stop hook (`.claude/hooks/agent-queue.mjs`) in exactly one way, but
# a decisive one: the hook keeps a single session so context piles up task after task,
# whereas here each task is its own `claude -p` process with a clean context and its
# own log. Use it when the backlog is longer than about five tasks in a row.
#
# Both mechanisms call the SAME `npm run task` commands — that is why there are three
# layers: changing how the loop runs never touches Layer 1 (state) or Layer 2 (done condition).
#
#   scripts/agent-queue/run-backlog.sh [max-tasks]
#
# Stops immediately when: out of work · a gated task comes up · verify fails. NEVER
# ploughs on — moving past a failed task is the fastest way to break the whole chain.
#
# Every `claude -p` session goes through `claude-run.mjs` (A-036): writes `agent.start` with the pid on
# open and `agent.end` with usage to the event log `logs/agent-queue/events.jsonl`; text still goes to
# `$LOG_DIR/<id>.log`. The whole run is wrapped in `run.start`/`run.end`. A broken log never breaks `claude`.
#
# `claude -p` has nobody to click "allow": by default it silently refuses every
# Write/Edit/Bash outside the allow-list, so it can't do anything on its own. Set
# AGENT_QUEUE_SKIP_PERMISSIONS=1 to run with `--dangerously-skip-permissions` —
# as the flag name says, only enable it when you know which tasks are about to run
# and accept that nobody is watching midway.

set -euo pipefail

# Code lives next to this script; the PROJECT root is CLAUDE_PROJECT_DIR or the git root of
# the current directory — the same place in the source repo, different when run from the plugin.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

MAX="${1:-20}"
LOG_DIR="${AGENT_QUEUE_LOG_DIR:-logs/agent-queue}"
TASK="node $HERE/cli.mjs"
CLAUDE_RUN="node $HERE/claude-run.mjs"
EXEC="node $HERE/conductor-exec.mjs"

mkdir -p "$LOG_DIR"

# AGENT_QUEUE_CLAUDE_BIN (tests) may point to something other than `claude`; check its first word.
CLAUDE_BIN="${AGENT_QUEUE_CLAUDE_BIN:-claude}"
if ! command -v "${CLAUDE_BIN%% *}" >/dev/null 2>&1; then
  echo "Command \`claude\` not found. The Claude Code CLI is required for headless runs." >&2
  exit 127
fi

# `claude` arguments for the developer role — SAME source as the conductor and run-planner.sh (A-087): model, permissions
# (allow-list or `--dangerously-skip-permissions`), lean flags (no MCP/skills/Chrome, `--tools` per role) and the `--max-budget-usd` cap.
# One argument per line → array (macOS bash 3.2 has no `mapfile`; this array is never empty, so `set -u` is safe).
CLAUDE_ARGS=()
while IFS= read -r arg; do CLAUDE_ARGS+=("$arg"); done < <($EXEC claude-args developer)

# One id for the whole run; a broken event log must not stop the script (`|| true`).
RUN_ID="${AGENT_QUEUE_RUN_ID:-run-$(date +%Y%m%d%H%M%S)-$$}"
STOP_REASON="abnormal exit"
$CLAUDE_RUN event run.start --source run-backlog --run-id "$RUN_ID" --workers 1 || true
finish_run() {
  $CLAUDE_RUN event run.end --source run-backlog --run-id "$RUN_ID" --stop-reason "$STOP_REASON" || true
}
trap finish_run EXIT

echo "Running up to $MAX task(s) · logs in $LOG_DIR"
count=0
STOP_REASON="reached $MAX task(s)"

while [ "$count" -lt "$MAX" ]; do
  # The exit code tells the two stop reasons apart: 1 = out of work, 2 = hit a gate.
  set +e
  ID="$($TASK next --plain 2>"$LOG_DIR/.next.err")"
  rc=$?
  set -e

  if [ "$rc" -eq 1 ]; then
    echo "No ready tasks left."
    STOP_REASON="no ready tasks left"
    break
  fi
  if [ "$rc" -eq 2 ]; then
    echo "Stopped — the next task needs your approval:"
    sed 's/^/  /' "$LOG_DIR/.next.err"
    STOP_REASON="next task needs approval"
    break
  fi
  if [ "$rc" -ne 0 ] || [ -z "$ID" ]; then
    echo "Could not get the next task (code $rc)." >&2
    STOP_REASON="could not get the next task (code $rc)"
    break
  fi

  echo "▸ $ID"
  $TASK start "$ID" >/dev/null

  # Clean context per task. No history from the previous session is passed on.
  if ! $CLAUDE_RUN --kind worker --role developer --task "$ID" --run-id "$RUN_ID" \
      --log "$LOG_DIR/$ID.log" -- "${CLAUDE_ARGS[@]}" "$($TASK prompt "$ID")"; then
    echo "  claude exited with an error — see $LOG_DIR/$ID.log" >&2
    $TASK gate "$ID" --reason "claude session exited with an error" >/dev/null
    STOP_REASON="claude session for $ID exited with an error"
    break
  fi

  # Only Layer 2 can conclude "done". The driver never judges by itself.
  if $TASK done "$ID"; then
    count=$((count + 1))
  else
    echo "  verify failed — stopping for you to look" >&2
    $TASK gate "$ID" --reason "verify failed after the agent ran" >/dev/null
    STOP_REASON="verify for $ID failed"
    break
  fi
done

rm -f "$LOG_DIR/.next.err"
echo
$TASK report
