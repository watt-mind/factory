#!/usr/bin/env bash
# Tear down a worktree demo environment (OPS-217).
#
#   bin/worktree-down.sh OPS-123           # stop daemons, remove the worktree
#   bin/worktree-down.sh OPS-123 --force   # ...even with uncommitted changes
#   bin/worktree-down.sh --here            # stop the current checkout's demo
#                                          # daemons and delete its demo state
#
# Branches are never deleted here — merged branches are cleaned up by the
# merge flow, unmerged ones are someone's work.
source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"

TICKET=""
HERE=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --here) HERE=1 ;;
    --force) FORCE=1 ;;
    -h | --help)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option '$1'" ;;
    *) [[ -z "$TICKET" ]] && TICKET="$1" || die "too many arguments" ;;
  esac
  shift
done

REPO="$(repo_root)"

if [[ "$HERE" -eq 1 ]]; then
  [[ -z "$TICKET" ]] || die "--here takes no ticket"
  WT="$REPO"
else
  [[ -n "$TICKET" ]] || die "usage: worktree-down.sh <TICKET-ID> [--force] | --here"
  WT="$WT_ROOT/$TICKET"
  [[ -d "$WT" ]] || die "no worktree at $WT"
fi

RUN_DIR="$(run_dir "$WT")"
term_daemon "$RUN_DIR/web.pid" "web server"
term_daemon "$RUN_DIR/worker.pid" "worker"
term_daemon "$RUN_DIR/serve.pid" "event runtime"
await_daemon "$RUN_DIR/web.pid" "web server"
await_daemon "$RUN_DIR/worker.pid" "worker"
await_daemon "$RUN_DIR/serve.pid" "event runtime"
release_port_reservation "$WT"

if [[ "$HERE" -eq 1 ]]; then
  info "removing demo state $(event_home "$WT")"
  rm -rf "$(event_home "$WT")" "$RUN_DIR"
  info "done — current checkout's demo environment is down"
  exit 0
fi

if [[ -n "$(git -C "$WT" status --porcelain)" && "$FORCE" -ne 1 ]]; then
  die "$WT has uncommitted changes — commit/stash them, or re-run with --force"
fi

info "removing worktree $WT"
# macOS bash 3.2: an empty array under `set -u` is an unbound variable, so
# branch instead of expanding a maybe-empty args array.
if [[ "$FORCE" -eq 1 ]]; then
  git -C "$REPO" worktree remove --force "$WT" || die "git worktree remove failed (git worktree list)"
else
  git -C "$REPO" worktree remove "$WT" || die "git worktree remove failed (git worktree list)"
fi
git -C "$REPO" worktree prune
info "done — branch left in place for the merge flow"
