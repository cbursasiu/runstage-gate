#!/usr/bin/env bash
# RunStage Gate example check: fail if the change ADDS lines containing TODO or FIXME.
#
# Inputs (set by the runner):
#   RUNSTAGE_DIFF_FILE  unified diff of the change (merge-base..head)
#   RUNSTAGE_BASE / RUNSTAGE_HEAD  commit SHAs, used if no diff file is given
# Standalone use:  no-todo-in-diff.sh <base> <head>
set -euo pipefail

if [[ -n "${RUNSTAGE_DIFF_FILE:-}" && -f "${RUNSTAGE_DIFF_FILE}" ]]; then
  diff_text="$(cat "$RUNSTAGE_DIFF_FILE")"
else
  base="${1:-${RUNSTAGE_BASE:?set RUNSTAGE_BASE or pass <base> <head>}}"
  head="${2:-${RUNSTAGE_HEAD:-HEAD}}"
  diff_text="$(git diff --no-color "$base" "$head")"
fi

# Walk the diff, tracking the current file and new-side line numbers.
hits="$(printf '%s\n' "$diff_text" | awk '
  /^\+\+\+ / { file = substr($0, 5); sub(/^b\//, "", file); next }
  /^@@ / {
    match($0, /\+[0-9]+/); line = substr($0, RSTART + 1, RLENGTH - 1) + 0; next
  }
  /^\+/ {
    if ($0 ~ /(TODO|FIXME)/) { text = substr($0, 2); gsub(/^[ \t]+/, "", text); printf "%s:%d: %s\n", file, line, text }
    line++; next
  }
  /^-/ { next }
  /^ / { line++ }
')"

if [[ -n "$hits" ]]; then
  count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  echo "Added TODO/FIXME lines:"
  printf '%s\n' "$hits"
  echo "Found ${count} new TODO/FIXME line(s); resolve them or track them in an issue."
  exit 1
fi

echo "No new TODO/FIXME lines."
