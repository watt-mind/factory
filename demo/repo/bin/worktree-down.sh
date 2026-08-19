#!/usr/bin/env bash
# Tear down the isolated worktree created by worktree-up.sh.
#
#   bin/worktree-down.sh DEMO-1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TICKET="${1:-}"
if [[ -z "$TICKET" || "$TICKET" == -* ]]; then
  echo "usage: bin/worktree-down.sh TICKET" >&2
  exit 2
fi

WT_ROOT="${DEMO_WORKTREE_ROOT:-$ROOT/.worktrees}"
DEST="$WT_ROOT/$TICKET"
BRANCH="feat/$TICKET"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git worktree list --porcelain | grep -qx "worktree $DEST"; then
    git worktree remove --force "$DEST"
  fi
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git branch -D "$BRANCH" >/dev/null
  fi
fi

rm -rf "$DEST"
git worktree prune >/dev/null 2>&1 || true
