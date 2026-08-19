#!/usr/bin/env bash
# Provision an isolated git worktree for one demo ticket.
#
#   bin/worktree-up.sh DEMO-1
#
# Writes .worktree.json in the new checkout and prints its absolute path.
# Idempotent: a live worktree for the same ticket is reused.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TICKET="${1:-}"
if [[ -z "$TICKET" || "$TICKET" == -* ]]; then
  echo "usage: bin/worktree-up.sh TICKET" >&2
  exit 2
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "worktree-up: $ROOT is not a git checkout" >&2
  exit 1
fi

WT_ROOT="${DEMO_WORKTREE_ROOT:-$ROOT/.worktrees}"
DEST="$WT_ROOT/$TICKET"
BRANCH="feat/$TICKET"

if [[ -d "$DEST" ]]; then
  if git worktree list --porcelain | grep -qx "worktree $DEST"; then
    printf '%s\n' "$DEST"
    exit 0
  fi
  rm -rf "$DEST"
fi

mkdir -p "$WT_ROOT"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$DEST" "$BRANCH"
else
  git worktree add -b "$BRANCH" "$DEST" HEAD
fi

printf '%s\n' "{\"ticket\":\"$TICKET\",\"path\":\"$DEST\",\"branch\":\"$BRANCH\"}" >"$DEST/.worktree.json"
printf '%s\n' "$DEST"
