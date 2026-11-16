#!/usr/bin/env bash
# Scan the change (base..head) for secrets with gitleaks.
# Always pass --redact=100 so secret values never appear in logs or check output.
#
# Inputs (set by the runner):
#   RUNSTAGE_BASE / RUNSTAGE_HEAD  commit SHAs of the range to scan
#   RUNSTAGE_REPO                  worktree of the PR head (optional; cwd is already that tree)
# Standalone use:  secret-scan.sh <base> <head>
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed or not on PATH."
  echo "Install it with Homebrew: brew install gitleaks"
  exit 1
fi

base="${1:-${RUNSTAGE_BASE:?set RUNSTAGE_BASE or pass <base> <head>}}"
head="${2:-${RUNSTAGE_HEAD:-HEAD}}"
source_dir="${RUNSTAGE_REPO:-.}"

# Commit-range scan judges only the PR's commits, not history already on the base branch.
# --redact=100 is required: never print secret values. --no-banner/--no-color keep output tidy.
set +e
gitleaks detect \
  --source "$source_dir" \
  --log-opts="${base}..${head}" \
  --redact=100 \
  --no-banner \
  --no-color \
  --verbose \
  --exit-code 1
status=$?
set -e

base_short="$(printf '%s' "$base" | cut -c1-12)"
head_short="$(printf '%s' "$head" | cut -c1-12)"

if [[ "$status" -eq 0 ]]; then
  echo "No secrets found in ${base_short}..${head_short}."
  exit 0
fi
if [[ "$status" -eq 1 ]]; then
  echo "gitleaks found secrets in ${base_short}..${head_short}. Values are redacted."
  exit 1
fi
echo "gitleaks failed with exit code ${status}."
exit "$status"
