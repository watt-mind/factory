#!/usr/bin/env bash
# Shared helpers for bin/worktree-up.sh / bin/worktree-down.sh (OPS-217).
# Modelled on coach-wattz's worktree tooling: git isolation does not isolate
# ports or state directories — these scripts do.
set -euo pipefail

_WORKTREE_COMMON_LOADED=1

# `git fetch` from concurrent bring-ups contends on git's internal locks
# (.git/FETCH_HEAD.lock, refs/remotes/origin locks, etc.).
# Capture stderr, retry with exponential backoff on lock contention or transient
# errors, and safely skip or fallback to the existing base ref when present (WM-117).
git_fetch() { # <repo> <remote> <ref>
  local repo="$1" remote="$2" ref="$3"
  if [[ "${FACTORY_SKIP_FETCH:-0}" -eq 1 || "${SKIP_FETCH:-0}" -eq 1 ]]; then
    if git -C "$repo" rev-parse --verify --quiet "refs/remotes/$remote/$ref" >/dev/null 2>&1 \
      || git -C "$repo" rev-parse --verify --quiet "$remote/$ref" >/dev/null 2>&1; then
      return 0
    fi
  fi

  local attempt=1 max_attempts=5 err=""
  local delays=(0.1 0.2 0.5 1 2)
  while :; do
    err=$(git -C "$repo" fetch "$remote" "$ref" --quiet 2>&1) && return 0
    if [[ $attempt -lt $max_attempts ]] \
      && grep -qiE '\.lock|could not lock|cannot lock|unable to create|another git process|temporarily unavailable|resource deadlock|resource temporarily unavailable|device or resource busy|permission denied' <<<"$err"; then
      local delay_idx=$((attempt - 1))
      [[ $delay_idx -ge ${#delays[@]} ]] && delay_idx=$((${#delays[@]} - 1))
      warn "git fetch hit lock contention (attempt $attempt/$max_attempts) — retrying in ${delays[$delay_idx]}s"
      sleep "${delays[$delay_idx]}"
      attempt=$((attempt + 1))
      continue
    fi
    # If fetch failed (e.g. offline, CI without remote, transient network) but base ref exists, fallback
    if git -C "$repo" rev-parse --verify --quiet "refs/remotes/$remote/$ref" >/dev/null 2>&1 \
      || git -C "$repo" rev-parse --verify --quiet "$remote/$ref" >/dev/null 2>&1; then
      warn "git fetch failed ($err); using existing $remote/$ref"
      return 0
    fi
    die "could not fetch $remote/$ref: $err"
  done
}

# `git worktree add` from concurrent bring-ups contends on git's internal
# locks and the loser exits 1 with the reason only on stderr (WM-113, WM-117).
# Capture stderr so the die names the actual failure, and retry briefly with
# backoff when it looks like lock contention; any other error dies immediately.
# Branch existence is re-checked per attempt: a lock-interrupted `-b` add can
# leave the branch created, and a blind `-b` retry would then die on "already
# exists" instead of finishing the checkout.
worktree_add() { # <worktree> <branch> <base-ref> [repo]
  local wt="$1" branch="$2" base="$3"
  local repo="${4:-$(repo_root)}"
  local attempt=1 max_attempts=6 err=""
  local delays=(0.1 0.2 0.5 1 2)
  while :; do
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
      err=$(git -C "$repo" worktree add --quiet "$wt" "$branch" 2>&1 >/dev/null) && return 0
    else
      err=$(git -C "$repo" worktree add --quiet "$wt" -b "$branch" "$base" 2>&1 >/dev/null) && return 0
    fi
    if [[ -d "$wt/.git" || -f "$wt/.git" ]] && git -C "$wt" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      return 0
    fi
    if [[ $attempt -lt $max_attempts ]] \
      && grep -qiE '\.lock|could not lock|cannot lock|unable to create|another git process|temporarily unavailable|resource deadlock|resource temporarily unavailable|device or resource busy|already exists|failed to read .*\.git/worktrees|commondir' <<<"$err"; then
      local delay_idx=$((attempt - 1))
      [[ $delay_idx -ge ${#delays[@]} ]] && delay_idx=$((${#delays[@]} - 1))
      warn "git worktree add hit lock contention (attempt $attempt/$max_attempts) — retrying in ${delays[$delay_idx]}s"
      sleep "${delays[$delay_idx]}"
      attempt=$((attempt + 1))
      continue
    fi
    die "git worktree add failed: $err"
  done
}

# Preserve a dirty, abandoned zero-ahead ticket branch before re-dispatch.
# The caller has already proved no other live run owns the tree and holds the
# per-ticket lifecycle lock. The report is consumed by event-runtime so the
# durable workspace marker and Linear both name the recovery ref.
preserve_abandoned_worktree() { # <worktree> <ticket> <ticket-branch> <report-path>
  local wt="$1" ticket="$2" ticket_branch="$3" report="$4"
  local timestamp wip_branch suffix=1 commit_sha push_status push_error_file push_error=""
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  wip_branch="wip/$ticket-$timestamp"
  while git -C "$wt" show-ref --verify --quiet "refs/heads/$wip_branch"; do
    suffix=$((suffix + 1))
    wip_branch="wip/$ticket-$timestamp-$suffix"
  done

  git -C "$wt" switch -c "$wip_branch" >/dev/null \
    || die "worktree_wip_preserve_failed: could not create '$wip_branch'"
  if ! git -C "$wt" add -A; then
    git -C "$wt" switch "$ticket_branch" >/dev/null 2>&1 || true
    git -C "$wt" branch -D "$wip_branch" >/dev/null 2>&1 || true
    die "worktree_wip_preserve_failed: could not stage dirty worktree on '$wip_branch'"
  fi
  if ! git -C "$wt" \
    -c user.name="Factory Worktree Recovery" \
    -c user.email="factory@users.noreply.github.com" \
    commit -m "chore(wip): preserve $ticket worktree changes ($ticket)" >/dev/null; then
    # Both refs still point at the same commit, so switching back carries the
    # staged/unstaged files with it and restores the exact dirty ticket tree.
    git -C "$wt" switch "$ticket_branch" >/dev/null 2>&1 || true
    git -C "$wt" branch -D "$wip_branch" >/dev/null 2>&1 || true
    die "worktree_wip_preserve_failed: could not commit dirty worktree on '$wip_branch'"
  fi
  commit_sha=$(git -C "$wt" rev-parse HEAD)

  push_error_file="${report}.push-error.$$"
  if git -C "$wt" push -u origin "$wip_branch" > /dev/null 2>"$push_error_file"; then
    push_status="pushed"
  else
    push_status="local_only"
    push_error=$(tail -c 4096 "$push_error_file" 2>/dev/null || true)
    warn "could not push preserved branch '$wip_branch'; keeping it locally${push_error:+: $push_error}"
  fi
  rm -f "$push_error_file"

  git -C "$wt" switch "$ticket_branch" >/dev/null \
    || die "worktree_wip_preserve_failed: preserved changes on '$wip_branch' but could not return to '$ticket_branch'"
  [[ -z "$(git -C "$wt" status --porcelain)" ]] \
    || die "worktree_wip_preserve_failed: '$ticket_branch' remained dirty after preserving changes on '$wip_branch'"

  PRESERVATION_REPORT="$report" PRESERVATION_REF="$wip_branch" \
    PRESERVATION_COMMIT="$commit_sha" PRESERVATION_PUSH="$push_status" \
    PRESERVATION_PUSH_ERROR="$push_error" bun --eval '
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.PRESERVATION_REPORT, JSON.stringify({
        ref: process.env.PRESERVATION_REF,
        commit: process.env.PRESERVATION_COMMIT,
        push: process.env.PRESERVATION_PUSH,
        ...(process.env.PRESERVATION_PUSH_ERROR ? { pushError: process.env.PRESERVATION_PUSH_ERROR } : {}),
      }) + "\n");
    '
  info "preserved abandoned worktree changes on $wip_branch ($push_status)"
}


WT_ROOT="${FACTORY_WT_ROOT:-$HOME/Develop/.worktrees/factory}"
BASE_BRANCH="${FACTORY_BASE_BRANCH:-develop}"

# Port allocation. Interactive instances use the 7381+ band (7381 default API,
# 7382 default web, 7383/7384 seen in ad-hoc second instances); the --here
# demo env and per-ticket worktrees live above it:
#   --here demo:      API 7391, web 7392
#   ticket worktrees: even API port in 7400–7798 from a hash of the *full*
#                     ticket string (OPS-123 ≠ OPS-123-scratch, OPS-201 ≠
#                     OPS-401), persisted in .factory/run/ports. Occupied
#                     slots walk forward. web = API + 1.
# The band is env-overridable (WM-113) so tests can run in a private range
# instead of colliding with real runtimes or concurrent CI jobs; defaults
# are unchanged for real use.
PORT_BASE="${FACTORY_PORT_BASE:-7400}"
PORT_SPAN="${FACTORY_PORT_SPAN:-200}"
PORT_RESERVATION_ROOT="${FACTORY_PORT_RESERVATION_ROOT:-$HOME/.factory/locks/worktree-ports}"
HERE_API_PORT=7391
HERE_WEB_PORT=7392

die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }

# Local config is intentionally gitignored, but a delegated checkout needs
# the active instance's routing, policy, and schedule rather than examples.
# Skip a checkout without the ignore rule so an agent can never stage it.
provision_instance_local_configs() { # <checkout> [primary-checkout]
  local checkout="$1" primary="${2:-${FACTORY_ROOT:-$(repo_root)}}"
  local name source destination rel
  for name in repos policy schedule; do
    source="$primary/config/$name.yaml"
    [[ -f "$source" ]] || continue
    destination="$checkout/config/$name.yaml"
    rel="config/$name.yaml"
    [[ "$(realpath -m "$source")" == "$(realpath -m "$destination")" ]] && continue
    if git -C "$checkout" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      && ! git -C "$checkout" check-ignore -q -- "$rel"; then
      continue
    fi
    mkdir -p "$checkout/config"
    cp -f "$source" "$destination"
  done
}

[[ "$PORT_BASE" =~ ^[0-9]+$ ]] || die "FACTORY_PORT_BASE must be numeric (got '$PORT_BASE')"
[[ "$PORT_SPAN" =~ ^[0-9]+$ ]] || die "FACTORY_PORT_SPAN must be numeric (got '$PORT_SPAN')"
(( PORT_BASE % 2 == 0 )) || die "FACTORY_PORT_BASE must be even so API/web pairs stay aligned (got '$PORT_BASE')"

repo_root() { git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel; }

ticket_number() {
  [[ "$1" =~ ^[A-Z]+-([0-9]+) ]] || die "ticket must look like OPS-123 (got '$1')"
  printf '%s' "${BASH_REMATCH[1]}"
}

# Preferred even API port for a ticket. Hashes the full id so a numeric
# collision (N and N+200) or a -scratch suffix cannot share a port.
ticket_api_port() {
  local hash
  hash=$(printf '%s' "$1" | cksum | awk '{print $1}')
  printf '%s' "$((PORT_BASE + 2 * (hash % PORT_SPAN)))"
}

# Runtime state for a checkout lives under its own .factory/ (gitignored):
#   .factory/event-runtime/   FACTORY_EVENT_HOME (db + workspaces)
#   .factory/run/             pidfiles + logs + ports
run_dir() { printf '%s/.factory/run' "$1"; }
event_home() { printf '%s/.factory/event-runtime' "$1"; }

pid_alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Spawn a detached daemon in its own process group (setsid) so it survives the
# parent shell exiting (OPS-306).
spawn_daemon() { # <pidfile> <logfile> <workdir> <cmd...>
  local pidfile="$1" logfile="$2" workdir="$3"
  shift 3
  mkdir -p "$(dirname "$pidfile")" "$(dirname "$logfile")"
  local pid
  pid=$(
    SPAWN_CWD="$workdir" SPAWN_LOG="$logfile" bun --eval '
      import { spawn } from "node:child_process";
      import { openSync } from "node:fs";
      const out = openSync(process.env.SPAWN_LOG, "a");
      const args = process.argv.slice(1);
      const child = spawn(args[0], args.slice(1), {
        cwd: process.env.SPAWN_CWD,
        detached: true,
        stdio: ["ignore", out, out],
        env: process.env,
      });
      child.unref();
      process.stdout.write(String(child.pid));
    ' "$@"
  )
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$pid" >"$pidfile"
  else
    die "failed to spawn daemon: $*"
  fi
}

# Persist / restore the ports this checkout actually bound (OPS-460).
read_ports() { # <worktree> → prints "api web"
  local f api="" web="" k v
  f="$(run_dir "$1")/ports"
  [[ -f "$f" ]] || return 1
  while IFS='=' read -r k v; do
    case "$k" in
      api) api="$v" ;;
      web) web="$v" ;;
    esac
  done <"$f"
  [[ "$api" =~ ^[0-9]+$ && "$web" =~ ^[0-9]+$ ]] || return 1
  printf '%s %s\n' "$api" "$web"
}

write_ports() { # <worktree> <api> <web>
  mkdir -p "$(run_dir "$1")"
  printf 'api=%s\nweb=%s\n' "$2" "$3" >"$(run_dir "$1")/ports"
}

# Persist the adapter override separately from daemon pidfiles so a supervisor
# can safely reconstruct a dead serve command. An empty value explicitly means
# live adapters; a missing file is different and defaults to fake below.
write_adapter_override() { # <worktree> <adapter-or-empty>
  mkdir -p "$(run_dir "$1")"
  printf 'adapter=%s\n' "$2" >"$(run_dir "$1")/adapter"
}

read_adapter_override() { # <worktree> → prints adapter, including empty for live
  local f line
  f="$(run_dir "$1")/adapter"
  [[ -f "$f" ]] || return 1
  IFS= read -r line <"$f" || true
  [[ "$line" == adapter=* ]] || return 1
  printf '%s' "${line#adapter=}"
}

# Prefer the running control API because it is the effective configuration,
# and refresh the persistent state while it is available. If serve is already
# dead, use the last recorded configuration. Legacy worktrees have no adapter
# file, so fail closed to the harmless fake adapter.
resolve_adapter_override() { # <worktree> <api_port>
  local wt="$1" api_port="$2" hjson="" reported_home="" adapter=""
  hjson="$(health_json "$api_port")"
  if [[ -n "$hjson" ]]; then
    reported_home="$(health_field "$hjson" home)"
    if [[ "$reported_home" == "$(event_home "$wt")" ]]; then
      adapter="$(health_field "$hjson" adapter)"
      write_adapter_override "$wt" "$adapter"
      printf '%s' "$adapter"
      return 0
    fi
  fi
  if adapter="$(read_adapter_override "$wt")"; then
    printf '%s' "$adapter"
  else
    printf 'fake'
  fi
}

# Port selection and reservation are separate from TCP bind: dependency
# installation and the web build can take long enough for a second worktree to
# observe the selected pair as still free. A short global allocator lock makes
# selection atomic, while one persistent directory per API/web pair bridges
# that bind gap and records which checkout owns the pair.
port_allocation_lock_dir() { printf '%s/allocation.lock' "$PORT_RESERVATION_ROOT"; }
port_reservation_dir() { printf '%s/%s.lock' "$PORT_RESERVATION_ROOT" "$1"; }

acquire_port_allocation_lock() {
  local lock start now holder age mtime stale
  lock="$(port_allocation_lock_dir)"
  mkdir -p "$PORT_RESERVATION_ROOT"
  start=$(date +%s)
  while ! mkdir "$lock" 2>/dev/null; do
    holder=$(cat "$lock/pid" 2>/dev/null || true)
    now=$(date +%s)
    stale=0
    if [[ "$holder" =~ ^[0-9]+$ ]]; then
      kill -0 "$holder" 2>/dev/null || stale=1
    else
      if stat -f '%m' "$lock" >/dev/null 2>&1; then
        mtime=$(stat -f '%m' "$lock" 2>/dev/null || printf '0')
      else
        mtime=$(stat -c '%Y' "$lock" 2>/dev/null || printf '0')
      fi
      [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=0
      age=$((now - mtime))
      (( age >= 2 )) && stale=1
    fi
    if [[ "$stale" -eq 1 ]]; then
      local stale_lock="${lock}.stale.$$.$RANDOM"
      if mv "$lock" "$stale_lock" 2>/dev/null; then
        rm -rf "$stale_lock"
        continue
      fi
    fi
    (( now - start < 10 )) || die "timed out waiting for worktree port allocation lock ($lock)"
    sleep 0.05
  done
  local pid_tmp="$lock/pid.$$.$RANDOM"
  printf '%s\n' "$$" >"$pid_tmp"
  mv "$pid_tmp" "$lock/pid"
}

release_port_allocation_lock() {
  local lock holder
  lock="$(port_allocation_lock_dir)"
  holder=$(cat "$lock/pid" 2>/dev/null || true)
  [[ "$holder" == "$$" ]] && rm -rf "$lock" || true
}

# A reservation remains active while its allocating shell is alive, or after
# that shell exits while the recorded checkout still owns live daemons/ports.
# Otherwise it is stale residue from a failed or killed startup and can be
# reclaimed under the allocator lock. Both API and web ports get reservation
# directories so odd --here pairs cannot overlap an even ticket pair.
port_reservation_active() { # <reserved-port>
  local port="$1" dir owner claimant api web rdir
  dir="$(port_reservation_dir "$port")"
  [[ -d "$dir" ]] || return 1
  claimant=$(cat "$dir/pid" 2>/dev/null || true)
  if [[ "$claimant" =~ ^[0-9]+$ ]] && kill -0 "$claimant" 2>/dev/null; then
    return 0
  fi
  owner=$(cat "$dir/worktree" 2>/dev/null || true)
  api=$(awk -F= '$1 == "api" { print $2 }' "$dir/ports" 2>/dev/null || true)
  web=$(awk -F= '$1 == "web" { print $2 }' "$dir/ports" 2>/dev/null || true)
  [[ -n "$owner" && -d "$owner" && "$api" =~ ^[0-9]+$ && "$web" =~ ^[0-9]+$ ]] || return 1
  rdir="$(run_dir "$owner")"
  if pid_alive "$rdir/serve.pid" || pid_alive "$rdir/web.pid" \
    || port_listening "$api" || port_listening "$web"; then
    return 0
  fi
  return 1
}

port_pair_reserved_by_other() { # <api-port> <worktree>
  local api="$1" wt="$2" port dir owner
  for port in "$api" "$((api + 1))"; do
    dir="$(port_reservation_dir "$port")"
    [[ -d "$dir" ]] || continue
    if ! port_reservation_active "$port"; then
      rm -rf "$dir"
      continue
    fi
    owner=$(cat "$dir/worktree" 2>/dev/null || true)
    [[ "$owner" == "$wt" ]] || return 0
  done
  return 1
}

reserve_port_pair() { # <worktree> <api-port> <web-port>; allocator lock held
  local wt="$1" api="$2" web="$3" port dir owner tmp
  [[ "$web" -eq $((api + 1)) ]] || return 1
  port_pair_reserved_by_other "$api" "$wt" && return 1
  for port in "$api" "$web"; do
    dir="$(port_reservation_dir "$port")"
    if [[ -d "$dir" ]]; then
      owner=$(cat "$dir/worktree" 2>/dev/null || true)
      if [[ "$owner" != "$wt" ]]; then
        rm -rf "$(port_reservation_dir "$api")" "$(port_reservation_dir "$web")"
        return 1
      fi
    else
      if ! mkdir "$dir"; then
        rm -rf "$(port_reservation_dir "$api")" "$(port_reservation_dir "$web")"
        return 1
      fi
    fi
    tmp="$dir/worktree.$$.$RANDOM"
    printf '%s\n' "$wt" >"$tmp"
    mv "$tmp" "$dir/worktree"
    tmp="$dir/pid.$$.$RANDOM"
    printf '%s\n' "$$" >"$tmp"
    mv "$tmp" "$dir/pid"
    printf 'api=%s\nweb=%s\n' "$api" "$web" >"$dir/ports"
  done
}

release_port_reservation() { # <worktree> [api-port]
  local wt="$1" api="${2:-}" web="" recorded dir owner port
  if [[ -z "$api" ]]; then
    recorded=$(read_ports "$wt" 2>/dev/null || true)
    if [[ -n "$recorded" ]]; then
      api="${recorded%% *}"
      web="${recorded##* }"
    elif [[ "${API_PORT:-}" =~ ^[0-9]+$ ]]; then
      api="$API_PORT"
    else
      return 0
    fi
  fi
  if [[ -z "$web" ]]; then
    dir="$(port_reservation_dir "$api")"
    web=$(awk -F= '$1 == "web" { print $2 }' "$dir/ports" 2>/dev/null || true)
    [[ "$web" =~ ^[0-9]+$ ]] || web=$((api + 1))
  fi
  acquire_port_allocation_lock
  for port in "$api" "$web"; do
    dir="$(port_reservation_dir "$port")"
    owner=$(cat "$dir/worktree" 2>/dev/null || true)
    [[ "$owner" == "$wt" ]] && rm -rf "$dir" || true
  done
  release_port_allocation_lock
}

# Failed bring-up calls this after stopping only the daemons it started. Keep
# an established checkout's reservation, but remove dead partial pid/port
# state so the next invocation can retry the same preferred pair.
release_worktree_ports_if_idle() { # <worktree>
  local wt="$1" rdir
  rdir="$(run_dir "$wt")"
  if pid_alive "$rdir/serve.pid" || pid_alive "$rdir/worker.pid" || pid_alive "$rdir/web.pid"; then
    return 0
  fi
  release_port_reservation "$wt"
  rm -f "$rdir/serve.pid" "$rdir/worker.pid" "$rdir/web.pid" "$rdir/ports"
}

# Listening TCP port for a pidfile, or fail. Used to recover ports from a
# daemon started before .factory/run/ports existed.
listen_tcp_port() { # <pidfile>
  [[ -f "$1" ]] || return 1
  command -v lsof >/dev/null || return 1
  local pid port
  pid=$(cat "$1" 2>/dev/null) || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  port=$(lsof -nP -a -iTCP -sTCP:LISTEN -p "$pid" 2>/dev/null \
    | awk -v pid="$pid" 'NR > 1 && $2 == pid {name=$9; sub(/^.*:/, "", name); print name; exit}') \
    || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  if [[ "$port" -ne "$HERE_API_PORT" && "$port" -ne "$HERE_WEB_PORT" ]]; then
    (( port >= PORT_BASE && port < PORT_BASE + 2 * PORT_SPAN )) || return 1
  fi
  printf '%s' "$port"
}

port_listening() { # <port>
  (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  return 1
}

health_json() { # <port>
  curl -sf -m 1 "http://127.0.0.1:$1/health" 2>/dev/null || true
}

# Extract env.<field> from a /health JSON body. Empty if missing/null/unparseable.
health_field() { # <json> <field>
  local json="$1" field="$2"
  [[ -n "$json" ]] || return 0
  FACTORY_HEALTH_JSON="$json" FACTORY_HEALTH_FIELD="$field" bun --eval '
    let d;
    try { d = JSON.parse(process.env.FACTORY_HEALTH_JSON); } catch { process.exit(0); }
    const v = d?.env?.[process.env.FACTORY_HEALTH_FIELD];
    if (v != null) process.stdout.write(String(v));
  '
}

# First API port at or after preferred that is free or already serving
# expected_home. When worktree is supplied, its adjacent web port must also
# be free or owned by that worktree's recorded web daemon.
allocate_api_port() { # <preferred> <expected_home> [worktree]
  local preferred="$1" expected="$2" wt="${3:-}"
  local port="$preferred" i=0 json occupant="" api_available web_port web_pid_port
  [[ "$preferred" =~ ^[0-9]+$ ]] || die "invalid preferred port '$preferred'"
  while [[ $i -lt $PORT_SPAN ]]; do
    api_available=0
    if [[ -n "$wt" ]] && port_pair_reserved_by_other "$port" "$wt"; then
      warn "port pair $port/$((port + 1)) is reserved by another worktree — trying next"
    elif port_listening "$port"; then
      json=$(health_json "$port")
      occupant=$(health_field "$json" home)
      if [[ -n "$occupant" && "$occupant" == "$expected" ]]; then
        api_available=1
      else
        warn "port $port is owned by ${occupant:-unknown process} — trying next"
      fi
    else
      api_available=1
    fi

    if [[ "$api_available" -eq 1 ]]; then
      if [[ -z "$wt" ]]; then
        printf '%s' "$port"
        return 0
      fi
      web_port=$((port + 1))
      if ! port_listening "$web_port"; then
        printf '%s' "$port"
        return 0
      fi
      web_pid_port=""
      if pid_alive "$(run_dir "$wt")/web.pid"; then
        web_pid_port=$(listen_tcp_port "$(run_dir "$wt")/web.pid" || true)
      fi
      if [[ "$web_pid_port" == "$web_port" ]]; then
        printf '%s' "$port"
        return 0
      fi
      warn "web port $web_port is owned by another process — trying next pair"
    fi

    if [[ $port -lt $PORT_BASE ]]; then
      port=$PORT_BASE
    else
      port=$((port + 2))
      if [[ $port -ge $((PORT_BASE + 2 * PORT_SPAN)) ]]; then
        port=$PORT_BASE
      fi
    fi
    i=$((i + 1))
  done
  die "no free API/web port pair in $PORT_BASE–$((PORT_BASE + 2 * PORT_SPAN - 1)); $preferred is unavailable"
}

# Resolve and persist a checkout's API/web pair. Recorded ports win when the
# API slot is free or already serves this checkout. Otherwise recover a live
# daemon's ports when possible, then walk from the preferred API slot.
# Sets API_PORT and WEB_PORT for the caller.
resolve_worktree_ports() { # <worktree> <preferred-api-port> <expected-home>
  local wt="$1" preferred="$2" expected="$3"
  local rdir resolved=0 recorded occupant sp wp recorded_web_pid_port api_reusable web_reusable pair_available stale_port stale_dir stale_owner
  rdir="$(run_dir "$wt")"
  acquire_port_allocation_lock

  if recorded=$(read_ports "$wt"); then
    API_PORT="${recorded%% *}"
    WEB_PORT="${recorded##* }"
    api_reusable=0
    web_reusable=0
    pair_available=1
    if [[ "$WEB_PORT" -ne $((API_PORT + 1)) ]] || port_pair_reserved_by_other "$API_PORT" "$wt"; then
      pair_available=0
    fi

    if port_listening "$API_PORT"; then
      occupant=$(health_field "$(health_json "$API_PORT")" home)
      [[ "$occupant" == "$expected" ]] && api_reusable=1
    else
      api_reusable=1
    fi

    if ! port_listening "$WEB_PORT"; then
      web_reusable=1
    elif pid_alive "$rdir/web.pid"; then
      recorded_web_pid_port=$(listen_tcp_port "$rdir/web.pid" || true)
      [[ "$recorded_web_pid_port" == "$WEB_PORT" ]] && web_reusable=1
    fi

    if [[ "$pair_available" -eq 1 && "$api_reusable" -eq 1 && "$web_reusable" -eq 1 ]] \
      && reserve_port_pair "$wt" "$API_PORT" "$WEB_PORT"; then
      info "reusing recorded ports $API_PORT / $WEB_PORT"
      resolved=1
    else
      warn "recorded ports $API_PORT / $WEB_PORT are occupied or reserved by another process — allocating a free pair"
      for stale_port in "$API_PORT" "$WEB_PORT"; do
        stale_dir="$(port_reservation_dir "$stale_port")"
        stale_owner=$(cat "$stale_dir/worktree" 2>/dev/null || true)
        [[ "$stale_owner" == "$wt" ]] && rm -rf "$stale_dir" || true
      done
    fi
  fi

  if [[ "$resolved" -eq 0 ]] && pid_alive "$rdir/serve.pid"; then
    if sp=$(listen_tcp_port "$rdir/serve.pid"); then
      API_PORT="$sp"
      WEB_PORT=$((API_PORT + 1))
      if pid_alive "$rdir/web.pid" && wp=$(listen_tcp_port "$rdir/web.pid"); then
        if [[ "$wp" -ne "$WEB_PORT" ]]; then
          release_port_allocation_lock
          die "live daemon ports $API_PORT / $wp are not an adjacent API/web pair"
        fi
      elif port_listening "$WEB_PORT"; then
        release_port_allocation_lock
        die "adjacent web port $WEB_PORT is occupied by a process not owned by this worktree"
      fi
      if port_pair_reserved_by_other "$API_PORT" "$wt"; then
        release_port_allocation_lock
        die "live daemon port pair $API_PORT/$WEB_PORT is reserved by another worktree"
      fi
      if reserve_port_pair "$wt" "$API_PORT" "$WEB_PORT"; then
        info "reusing live daemon ports $API_PORT / $WEB_PORT"
        write_ports "$wt" "$API_PORT" "$WEB_PORT"
        resolved=1
      fi
    fi
  fi

  if [[ "$resolved" -eq 0 ]]; then
    API_PORT="$(allocate_api_port "$preferred" "$expected" "$wt")"
    WEB_PORT=$((API_PORT + 1))
    reserve_port_pair "$wt" "$API_PORT" "$WEB_PORT" \
      || die "port pair $API_PORT/$WEB_PORT was claimed during allocation"
    write_ports "$wt" "$API_PORT" "$WEB_PORT"
    info "allocated ports $API_PORT / $WEB_PORT (preferred $preferred)"
  fi
  release_port_allocation_lock
}

# Refuse to proceed (and never seed) when /health is a different event home.
assert_event_home() { # <health_json> <expected_home> <port>
  local json="$1" expected="$2" port="$3" got
  got=$(health_field "$json" home)
  if [[ "$got" != "$expected" ]]; then
    die "port $port is owned by another runtime (env.home=${got:-unknown}, this worktree=$expected) — refusing to seed"
  fi
}

# live_flag=1 means --live (no adapter override → env.adapter is null).
# live_flag=0 means fake (env.adapter must be "fake").
assert_event_adapter() { # <health_json> <live_flag> <port>
  local json="$1" live="$2" port="$3" got
  got=$(health_field "$json" adapter)
  if [[ "$live" -eq 1 ]]; then
    if [[ -n "$got" ]]; then
      die "port $port reports adapter '$got' but --live requested no override"
    fi
  else
    if [[ "$got" != "fake" ]]; then
      die "port $port reports adapter '${got:-none}' but fake-adapter mode was requested (restart without --live, or with --adapter-override fake)"
    fi
  fi
}

adapter_banner() { # <adapter from /health>
  case "$1" in
    fake) printf '%s' "(fake adapter — approvals are harmless)" ;;
    "")   printf '%s' "(live adapters)" ;;
    *)    printf '%s' "(adapter $1)" ;;
  esac
}

# Teardown is two-phase so the waits overlap: term_daemon every pidfile first,
# then await_daemon each — total cost is the slowest daemon's exit, not the
# sum of three sequential timeouts.
term_daemon() { # <pidfile> <label>
  if pid_alive "$1"; then
    local pid
    pid="$(cat "$1")"
    info "stopping $2 (pid $pid)"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  fi
}

await_daemon() { # <pidfile> <label>
  local pid
  pid="$(cat "$1" 2>/dev/null || true)"
  for _ in {1..30}; do
    pid_alive "$1" || break
    sleep 0.1
  done
  if pid_alive "$1"; then
    warn "$2 ignored SIGTERM — killing"
    if [[ -n "$pid" ]]; then
      kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$1"
}

# Content hash of everything that feeds the web bundle (names + contents, so
# renames count). The inputs are a handful of source files — well under 0.1s.
web_build_hash() { # <web-dir>
  (
    cd "$1" || exit 1
    cat package.json bun.lock vite.config.ts tsconfig.json index.html 2>/dev/null
    find src public -type f 2>/dev/null | LC_ALL=C sort
    find src public -type f -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 cat 2>/dev/null
  ) | shasum | cut -d' ' -f1
}

# Remove a bun-install lock only when its published owner is this process.
# A pid-less directory may be a new holder's pre-publication generation.
release_bun_install_lock() { # <lock-dir> <owner-pid>
  local lock_dir="$1" owner_pid="$2" holder=""
  [[ -d "$lock_dir" ]] || return 0
  holder=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [[ "$holder" == "$owner_pid" ]]; then
    rm -rf "$lock_dir" 2>/dev/null || true
  fi
}

# Invoke the action from Bash's shell-escaped `trap -p` output.
run_bun_install_trap() { # <trap-definition>
  local definition="$1"
  [[ -n "$definition" ]] || return 0
  eval "set -- ${definition#trap -- }"
  eval "$1"
}

# File-locked bun install with retry on SQLITE_BUSY (OPS-322).
# Prevents concurrent worktree bring-ups from racing on bun's global cache DB.
locked_bun_install() { # <dir>
  local target_dir="$1"
  local lock_dir="${FACTORY_LOCK_DIR:-$HOME/.factory/locks/bun-install.lock}"
  local max_wait="${FACTORY_LOCK_MAX_WAIT:-120}"
  local stale_after="${FACTORY_LOCK_STALE_AFTER:-2}"
  local start_time
  start_time=$(date +%s)

  [[ "$max_wait" =~ ^[0-9]+$ ]] || die "FACTORY_LOCK_MAX_WAIT must be numeric (got '$max_wait')"
  [[ "$stale_after" =~ ^[0-9]+$ ]] || die "FACTORY_LOCK_STALE_AFTER must be numeric (got '$stale_after')"
  mkdir -p "$(dirname "$lock_dir")"

  while ! mkdir "$lock_dir" 2>/dev/null; do
    local holder="" now lock_mtime=0 lock_age=0 reclaim=0
    holder=$(cat "$lock_dir/pid" 2>/dev/null || true)
    now=$(date +%s)

    if [[ "$holder" =~ ^[0-9]+$ ]]; then
      if ! kill -0 "$holder" 2>/dev/null; then
        reclaim=1
      fi
    else
      # A new holder needs a moment between mkdir and publishing its pid. Only
      # reclaim a pid-less/malformed lock once that grace period has elapsed.
      if stat -f '%m' "$lock_dir" >/dev/null 2>&1; then
        lock_mtime=$(stat -f '%m' "$lock_dir" 2>/dev/null || printf '0')
      else
        lock_mtime=$(stat -c '%Y' "$lock_dir" 2>/dev/null || printf '0')
      fi
      [[ "$lock_mtime" =~ ^[0-9]+$ ]] || lock_mtime=0
      lock_age=$(( now - lock_mtime ))
      if (( lock_age >= stale_after )); then
        reclaim=1
      fi
    fi

    if [[ "$reclaim" -eq 1 ]]; then
      local stale_candidate="${lock_dir}.stale.$$.$RANDOM"
      if mv "$lock_dir" "$stale_candidate" 2>/dev/null; then
        local stale_holder
        stale_holder=$(cat "$stale_candidate/pid" 2>/dev/null || true)
        if [[ "$stale_holder" =~ ^[0-9]+$ ]] && kill -0 "$stale_holder" 2>/dev/null; then
          mv "$stale_candidate" "$lock_dir" 2>/dev/null || rm -rf "$stale_candidate"
        else
          rm -rf "$stale_candidate"
        fi
        continue
      fi
    fi

    if (( now - start_time >= max_wait )); then
      die "timed out waiting for bun install lock ($lock_dir)"
    fi
    sleep 0.1
  done

  # Publish ownership atomically so contenders never observe a partially
  # written pid file. Traps are restored before returning to the caller.
  local pid_tmp="$lock_dir/pid.$$.$RANDOM"
  printf '%s\n' "$$" > "$pid_tmp"
  mv "$pid_tmp" "$lock_dir/pid"
  local previous_exit_trap previous_int_trap previous_term_trap
  previous_exit_trap=$(trap -p EXIT || true)
  previous_int_trap=$(trap -p INT || true)
  previous_term_trap=$(trap -p TERM || true)
  local exit_handler
  printf -v exit_handler 'code=$?; release_bun_install_lock %q %q; trap - EXIT; run_bun_install_trap %q; exit "$code"' \
    "$lock_dir" "$$" "$previous_exit_trap"
  trap "$exit_handler" EXIT
  trap 'release_bun_install_lock "$lock_dir" "$$"; trap - EXIT INT; [[ -n "$previous_exit_trap" ]] && eval "$previous_exit_trap"; run_bun_install_trap "$previous_int_trap"; exit 130' INT
  trap 'release_bun_install_lock "$lock_dir" "$$"; trap - EXIT TERM; [[ -n "$previous_exit_trap" ]] && eval "$previous_exit_trap"; run_bun_install_trap "$previous_term_trap"; exit 143' TERM

  local attempt=1 max_attempts=5 out="" code=0
  while [[ $attempt -le $max_attempts ]]; do
    out=$(cd "$target_dir" && bun install --frozen-lockfile 2>&1) && code=0 || code=$?
    [[ $code -eq 0 ]] && break
    if [[ "$out" =~ "SQLITE_BUSY" || "$out" =~ "database is locked" ]]; then
      warn "bun install in $target_dir hit SQLITE_BUSY (attempt $attempt/$max_attempts) — retrying"
      sleep $(( attempt ))
      attempt=$(( attempt + 1 ))
    else
      break
    fi
  done

  release_bun_install_lock "$lock_dir" "$$"
  trap - EXIT INT TERM
  [[ -n "$previous_exit_trap" ]] && eval "$previous_exit_trap"
  [[ -n "$previous_int_trap" ]] && eval "$previous_int_trap"
  [[ -n "$previous_term_trap" ]] && eval "$previous_term_trap"
  if [[ $code -ne 0 ]]; then
    printf '%s\n' "$out" >&2
  fi
  return $code
}

source "$(dirname "${BASH_SOURCE[0]}")/worktree-daemons.sh"
