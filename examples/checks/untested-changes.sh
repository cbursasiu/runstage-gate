#!/usr/bin/env bash
# Optional policy check: fail when source files change but no test file does.
# Not enabled in this repository's .runstage/gate.yml (see docs/config.md).
#
# Inputs (set by the runner):
#   RUNSTAGE_DIFF_FILE  unified diff of the change (merge-base..head)
#   RUNSTAGE_BASE / RUNSTAGE_HEAD  commit SHAs, used if no diff file is given
# Standalone use:  untested-changes.sh <base> <head>
set -euo pipefail

if [[ -n "${RUNSTAGE_DIFF_FILE:-}" && -f "${RUNSTAGE_DIFF_FILE}" ]]; then
  files="$(awk '
    /^\+\+\+ b\// { print substr($0, 7) }
  ' "$RUNSTAGE_DIFF_FILE")"
else
  base="${1:-${RUNSTAGE_BASE:?set RUNSTAGE_BASE or pass <base> <head>}}"
  head="${2:-${RUNSTAGE_HEAD:-HEAD}}"
  files="$(git diff --name-only --diff-filter=ACMR "$base" "$head")"
fi

is_test() {
  case "$1" in
    *.test.js|*.test.ts|*.test.jsx|*.test.tsx|*.spec.js|*.spec.ts|*.spec.jsx|*.spec.tsx) return 0 ;;
    */test/*|*/tests/*|*/__tests__/*) return 0 ;;
    *) return 1 ;;
  esac
}

is_source() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx) return 0 ;;
    *) return 1 ;;
  esac
}

source_hits=""
test_hits=""
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if is_test "$path"; then
    test_hits="${test_hits}${path}
"
  elif is_source "$path"; then
    source_hits="${source_hits}${path}
"
  fi
done <<EOF
$files
EOF

if [[ -n "$source_hits" && -z "$test_hits" ]]; then
  echo "Source files changed without any test file changing:"
  printf '%s' "$source_hits"
  echo "Add or update a test for this change, or skip this check if you do not want that policy."
  exit 1
fi

if [[ -z "$source_hits" ]]; then
  echo "No source files changed."
else
  echo "Source changes are accompanied by test file changes."
fi
exit 0
