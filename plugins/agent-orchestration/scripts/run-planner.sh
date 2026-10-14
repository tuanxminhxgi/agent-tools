#!/usr/bin/env bash
#
# PLANNER running in the background — in parallel with workers (run-backlog.sh / Stop hook).
# Design: docs/agent-orchestration.md §4.
#
#   scripts/agent-queue/run-planner.sh [max-rounds]
#
# Each round: `planner sync` (harvest answers, unblock, draft → todo) → `planner next`
# → one clean-context `claude -p` process doing exactly one job. Stops when:
#   - out of work: no unsplit requirement, no draft task needing revision;
#   - the same job comes back two rounds in a row — the planner is stuck, needs a human look;
#   - the round cap is reached.
# Never stops to WAIT for a human: an open question only blocks its own task.
#
# The planner's model and permissions come from the `roles` table (A-025), not hard-coded here:
#   - model: AGENT_QUEUE_PLANNER_MODEL (passed by the conductor) or `roles.planner.model`;
#   - permissions: the role's allow-list (Q-001 = C) + git push/commit/rm -rf blocked. Explicit escape hatch:
#     AGENT_QUEUE_SKIP_PERMISSIONS=1 → `--dangerously-skip-permissions` instead of the allow-list (with a warning).
# Prompt goes via stdin: `--allowedTools` takes a list, and a prompt placed after it would be swallowed.

set -euo pipefail

# Code lives next to this script; the PROJECT root is CLAUDE_PROJECT_DIR or the git root of
# the current directory — the same place in the source repo, different when run from the plugin.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

MAX="${1:-20}"
LOG_DIR="${AGENT_QUEUE_LOG_DIR:-logs/agent-queue}/planner"
TASK="node $HERE/cli.mjs"
EXEC="node $HERE/conductor-exec.mjs"
CLAUDE_RUN="node $HERE/claude-run.mjs"

mkdir -p "$LOG_DIR"

# AGENT_QUEUE_CLAUDE_BIN (tests) may point to something other than `claude`; check its first word.
CLAUDE_BIN="${AGENT_QUEUE_CLAUDE_BIN:-claude}"
if ! command -v "${CLAUDE_BIN%% *}" >/dev/null 2>&1; then
  echo "Command \`claude\` not found. The Claude Code CLI is required for headless runs." >&2
  exit 127
fi

# One argument per line → array (macOS bash 3.2 has no `mapfile`).
CLAUDE_ARGS=()
while IFS= read -r arg; do CLAUDE_ARGS+=("$arg"); done < <($EXEC claude-args planner)
if [ -n "${AGENT_QUEUE_PLANNER_MODEL:-}" ]; then
  for i in "${!CLAUDE_ARGS[@]}"; do
    if [ "${CLAUDE_ARGS[$i]}" = "--model" ]; then CLAUDE_ARGS[$((i + 1))]="$AGENT_QUEUE_PLANNER_MODEL"; fi
  done
fi
if [ "${AGENT_QUEUE_SKIP_PERMISSIONS:-0}" = "1" ]; then
  echo "WARNING: AGENT_QUEUE_SKIP_PERMISSIONS=1 — planner runs with --dangerously-skip-permissions." >&2
fi
MODEL="$(printf '%s\n' "${CLAUDE_ARGS[@]}" | sed -n '3p')"
echo "Planner: model $MODEL"

# Event log (A-037). When the conductor calls this script it already has its own run (AGENT_QUEUE_RUN_ID) — the
# planner just joins that run as a child of the conductor agent. Run standalone, the script opens/closes its own run.
# A broken log never stops it.
RUN_ID="${AGENT_QUEUE_RUN_ID:-}"
# A single token (no spaces) → no array needed; an empty array under `set -u` makes macOS bash 3.2 error out.
PARENT_FLAG=""
if [ -n "${AGENT_QUEUE_AGENT_ID:-}" ]; then PARENT_FLAG="--parent-id=$AGENT_QUEUE_AGENT_ID"; fi
STOP_REASON="abnormal exit"
if [ -z "$RUN_ID" ]; then
  RUN_ID="run-$(date +%Y%m%d%H%M%S)-$$"
  $CLAUDE_RUN event run.start --source run-planner --run-id "$RUN_ID" || true
  finish_run() {
    $CLAUDE_RUN event run.end --source run-planner --run-id "$RUN_ID" --stop-reason "$STOP_REASON" || true
  }
  trap finish_run EXIT
fi

count=0
last=""
while [ "$count" -lt "$MAX" ]; do
  $TASK planner sync

  set +e
  WORK="$($TASK planner next)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "Planner is out of work."
    STOP_REASON="out of work"
    break
  fi
  if [ "$WORK" = "$last" ]; then
    echo "Stopped — planner made no progress on: $WORK" >&2
    STOP_REASON="planner made no progress on: $WORK"
    break
  fi
  last="$WORK"

  count=$((count + 1))
  echo "▸ [$count] $WORK"
  log="$LOG_DIR/$(date +%Y%m%dT%H%M%S)-$count.log"
  # Clean context each round; the rules live in the subagent file, not here.
  # Goes through `claude-run.mjs`: `agent.start/end` + usage into the log, session text into $log. `-p`… comes BEFORE
  # the prompt, and `claude-run` always appends `--output-format` AFTER the `--allowedTools` list so the prompt isn't swallowed.
  AGENT_QUEUE_DISABLE=1 $CLAUDE_RUN --kind planner --role planner --model "$MODEL" --run-id "$RUN_ID" $PARENT_FLAG \
    --log "$log" -- "${CLAUDE_ARGS[@]}" "You are the planner. Read .claude/agents/planner.md and do EXACTLY ONE job, following its rules: $WORK
CLI command: $TASK" || {
    echo "  (claude exited non-zero — see $log)"
    # Log tail to stdout: the conductor reads this output to detect "Claude usage limit reached" and STOP, instead of
    # relaunching the planner every round (2026-10-10: 494 planner sessions exited 1 after 3 s, for 66 min, until the 500-round cap).
    tail -n 5 "$log" 2>/dev/null | sed 's/^/  │ /' || true
  }
done

if [ "$count" -ge "$MAX" ]; then STOP_REASON="reached $MAX round(s)"; fi
$TASK planner sync >/dev/null
$TASK inbox
