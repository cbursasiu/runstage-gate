#!/usr/bin/env bash
# Install npm dependencies in a clean check worktree, then run an npm command.
# The runner starts each job in a fresh worktree of the PR head, so node_modules is
# absent until something installs it. Checks share that worktree and run in order,
# so a later check skips npm ci when node_modules already exists.
#
# Usage (from gate.yml):  bash .runstage/checks/with-npm.sh test
#                         bash .runstage/checks/with-npm.sh run lint
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: with-npm.sh <npm-args...>" >&2
  exit 2
fi

if [[ ! -d node_modules ]]; then
  echo "npm ci (clean worktree has no node_modules)"
  npm ci
fi

exec npm "$@"
