#!/usr/bin/env bash
# Tear down a worktree demo environment (OPS-217).
#
#   bin/worktree-down.sh OPS-123           # stop daemons, remove the worktree
#   bin/worktree-down.sh OPS-123 --force   # ...even with uncommitted changes
#   bin/worktree-down.sh --here            # stop the current checkout's demo
#                                          # daemons and delete its demo state
#   bin/worktree-down.sh --prune           # remove clean, inactive worktrees
#                                          # whose ticket is Done or PR merged
#
# Branches are never deleted here — merged branches are cleaned up by the
# merge flow, unmerged ones are someone's work.
source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"

TICKET=""
HERE=0
FORCE=0
PRUNE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --here) HERE=1 ;;
    --force) FORCE=1 ;;
    --prune) PRUNE=1 ;;
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
WORKTREE_LIFECYCLE_LOCK=""

worktree_lifecycle_lock_path() { # <ticket>
  local common
  common=$(git -C "$REPO" rev-parse --git-common-dir)
  [[ "$common" == /* ]] || common="$REPO/$common"
  printf '%s/factory-worktree-locks/%s.lock' "$common" "$(ticket_slug "$1")"
}

try_worktree_lifecycle_lock() { # <ticket>
  local lock holder=""
  lock=$(worktree_lifecycle_lock_path "$1")
  mkdir -p "$(dirname "$lock")"
  if ! mkdir "$lock" 2>/dev/null; then
    holder=$(cat "$lock/pid" 2>/dev/null || true)
    if [[ "$holder" =~ ^[0-9]+$ ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lock"
      mkdir "$lock" 2>/dev/null || return 1
    else
      return 1
    fi
  fi
  printf '%s\n' "$$" >"$lock/pid"
  WORKTREE_LIFECYCLE_LOCK="$lock"
}

release_worktree_lifecycle_lock() {
  if [[ -n "$WORKTREE_LIFECYCLE_LOCK" && "$(cat "$WORKTREE_LIFECYCLE_LOCK/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -rf "$WORKTREE_LIFECYCLE_LOCK"
  fi
  WORKTREE_LIFECYCLE_LOCK=""
}

# A ticket is terminal for cleanup when Linear says Done or GitHub has a
# merged PR mentioning its identifier. Lookup failures fail closed: an
# unreachable control plane leaves the worktree in place.
ticket_is_terminal() { # <ticket> <branch>
  local ticket="$1" branch="$2" json="" state="" merged=""
  if json=$(bun "$REPO/tools/linear.mjs" get "$ticket" --json 2>/dev/null); then
    state=$(printf '%s\n' "$json" | awk '
      {
        line=$0
        if (!in_state && line ~ /"state"[[:space:]]*:[[:space:]]*\{/) {
          in_state=1
          sub(/^.*"state"[[:space:]]*:[[:space:]]*\{/, "", line)
        }
        if (in_state && line ~ /"name"[[:space:]]*:/) {
          sub(/^.*"name"[[:space:]]*:[[:space:]]*"/, "", line)
          sub(/".*$/, "", line)
          print line
          exit
        }
      }
    ')
    [[ "$state" == "Done" ]] && return 0
  fi

  if command -v gh >/dev/null 2>&1; then
    merged=$(cd "$REPO" && gh pr list --state merged --head "$branch" --json number --limit 1 --jq 'length' 2>/dev/null || true)
    [[ "$merged" =~ ^[1-9][0-9]*$ ]] && return 0
  fi
  return 1
}

if [[ "$PRUNE" -eq 1 ]]; then
  [[ "$HERE" -eq 0 && "$FORCE" -eq 0 && -z "$TICKET" ]] \
    || die "--prune takes no ticket and cannot be combined with --here or --force"
  pruned=0
  for WT in "$WT_ROOT"/*; do
    [[ -d "$WT" ]] || continue
    ticket=$(basename "$WT")
    [[ "$ticket" =~ ^[A-Z]+-[0-9]+(-[A-Za-z0-9][A-Za-z0-9-]*)?$ ]] || continue

    status=$(git -C "$WT" status --porcelain 2>/dev/null) || {
      warn "skipping $ticket — cannot inspect worktree status"
      continue
    }
    if [[ -n "$status" ]]; then
      warn "skipping $ticket — worktree has uncommitted changes"
      continue
    fi

    RUN_DIR="$(run_dir "$WT")"
    if pid_alive "$RUN_DIR/web.pid" || pid_alive "$RUN_DIR/worker.pid" || pid_alive "$RUN_DIR/serve.pid"; then
      warn "skipping $ticket — worktree has live daemons"
      continue
    fi
    branch=$(git -C "$WT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    [[ -n "$branch" ]] || {
      warn "skipping $ticket — worktree is detached"
      continue
    }
    ticket_is_terminal "$ticket" "$branch" || continue

    if ! try_worktree_lifecycle_lock "$ticket"; then
      warn "skipping $ticket — worktree lifecycle is busy"
      continue
    fi
    trap release_worktree_lifecycle_lock EXIT
    trap 'release_worktree_lifecycle_lock; exit 130' INT
    trap 'release_worktree_lifecycle_lock; exit 143' TERM

    # Revalidate under the same per-ticket lifecycle lock used by bring-up and
    # ordinary teardown. Nothing using the paved road can dirty or start this
    # worktree between these checks and removal.
    status=$(git -C "$WT" status --porcelain 2>/dev/null) || {
      warn "skipping $ticket — cannot re-check worktree status"
      release_worktree_lifecycle_lock
      continue
    }
    if [[ -n "$status" ]] || pid_alive "$RUN_DIR/web.pid" || pid_alive "$RUN_DIR/worker.pid" || pid_alive "$RUN_DIR/serve.pid"; then
      warn "skipping $ticket — worktree became dirty or live"
      release_worktree_lifecycle_lock
      continue
    fi

    FACTORY_WORKTREE_LOCK_HELD="$WORKTREE_LIFECYCLE_LOCK" /bin/bash "${BASH_SOURCE[0]}" "$ticket" \
      || die "failed to prune terminal worktree $ticket"
    release_worktree_lifecycle_lock
    pruned=$((pruned + 1))
  done
  git -C "$REPO" worktree prune
  info "pruned $pruned terminal worktree(s)"
  exit 0
fi

if [[ "$HERE" -eq 1 ]]; then
  [[ -z "$TICKET" ]] || die "--here takes no ticket"
  WT="$REPO"
else
  [[ -n "$TICKET" ]] || die "usage: worktree-down.sh <TICKET-ID> [--force] | --here | --prune"
  # Same slug as worktree-up.sh, or a GitHub-id worktree can be created and
  # never torn down — which leaks disk and a port lease (#881).
  ticket_is_valid "$TICKET" || die "ticket must look like OPS-123 or owner/repo#123 (got '$TICKET')"
  TICKET="$(ticket_slug "$TICKET")"
  WT="$WT_ROOT/$TICKET"
  [[ -d "$WT" ]] || die "no worktree at $WT"

  expected_lock=$(worktree_lifecycle_lock_path "$TICKET")
  if [[ "${FACTORY_WORKTREE_LOCK_HELD:-}" != "$expected_lock" ]]; then
    try_worktree_lifecycle_lock "$TICKET" \
      || die "worktree_lifecycle_busy: another process is provisioning or removing $TICKET"
    trap release_worktree_lifecycle_lock EXIT
    trap 'release_worktree_lifecycle_lock; exit 130' INT
    trap 'release_worktree_lifecycle_lock; exit 143' TERM
  fi
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

# Backstop for daemons the pidfiles no longer describe (#1379): a killed
# handoff gate or an aborted bring-up leaves a detached `serve
# --adapter-override fake` with no pidfile, still holding this worktree as its
# cwd, a loopback port and a SQLite handle. Sweep every cwd-bound process
# group immediately before the checkout is deleted, and log what was stopped.
# Only the committed removal path runs this — `--here` keeps the checkout, a
# refused dirty teardown keeps it too, and the operator's own shells live
# there; nothing may be signalled unless the worktree is actually going away.
kill_worktree_cwd_processes "$WT"

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
