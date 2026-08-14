#!/usr/bin/env bash
# Shared helpers for bin/worktree-up.sh / bin/worktree-down.sh (OPS-217).
# Modelled on coach-wattz's worktree tooling: git isolation does not isolate
# ports or state directories — these scripts do.
set -euo pipefail

_WORKTREE_COMMON_LOADED=1

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
HERE_API_PORT=7391
HERE_WEB_PORT=7392

die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }

[[ "$PORT_BASE" =~ ^[0-9]+$ ]] || die "FACTORY_PORT_BASE must be numeric (got '$PORT_BASE')"
[[ "$PORT_SPAN" =~ ^[0-9]+$ ]] || die "FACTORY_PORT_SPAN must be numeric (got '$PORT_SPAN')"

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

# Listening TCP port for a pidfile, or fail. Used to recover ports from a
# daemon started before .factory/run/ports existed.
listen_tcp_port() { # <pidfile>
  pid_alive "$1" || return 1
  command -v lsof >/dev/null || return 1
  local port
  port=$(lsof -nP -iTCP -sTCP:LISTEN -p "$(cat "$1")" 2>/dev/null \
    | awk 'NR>1 {print $9; exit}' | awk -F: '{print $NF}')
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
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

# First even port at or after preferred in the ticket band that is free or
# already serving expected_home. Dies if the whole band is someone else's.
allocate_api_port() { # <preferred> <expected_home>
  local preferred="$1" expected="$2"
  local port="$preferred" i=0 json occupant=""
  [[ "$preferred" =~ ^[0-9]+$ ]] || die "invalid preferred port '$preferred'"
  while [[ $i -lt $PORT_SPAN ]]; do
    if port_listening "$port"; then
      json=$(health_json "$port")
      occupant=$(health_field "$json" home)
      if [[ -n "$occupant" && "$occupant" == "$expected" ]]; then
        printf '%s' "$port"
        return 0
      fi
      warn "port $port is owned by ${occupant:-unknown process} — trying next"
    else
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 2))
    if [[ $port -ge $((PORT_BASE + 2 * PORT_SPAN)) ]]; then
      port=$PORT_BASE
    fi
    i=$((i + 1))
  done
  die "no free API port in $PORT_BASE–$((PORT_BASE + 2 * PORT_SPAN - 2)); $preferred is owned by ${occupant:-unknown}"
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
    info "stopping $2 (pid $(cat "$1"))"
    kill "$(cat "$1")" 2>/dev/null || true
  fi
}

await_daemon() { # <pidfile> <label>
  for _ in {1..30}; do
    pid_alive "$1" || break
    sleep 0.1
  done
  if pid_alive "$1"; then
    warn "$2 ignored SIGTERM — killing"
    kill -9 "$(cat "$1")" 2>/dev/null || true
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

# File-locked bun install with retry on SQLITE_BUSY (OPS-322).
# Prevents concurrent worktree bring-ups from racing on bun's global cache DB.
locked_bun_install() { # <dir>
  local target_dir="$1"
  local lock_dir="${FACTORY_LOCK_DIR:-$HOME/.factory/locks/bun-install.lock}"
  local max_wait="${FACTORY_LOCK_MAX_WAIT:-120}"
  local start_time
  start_time=$(date +%s)

  mkdir -p "$(dirname "$lock_dir")"

  while ! mkdir "$lock_dir" 2>/dev/null; do
    if [[ -f "$lock_dir/pid" ]]; then
      local holder
      holder=$(cat "$lock_dir/pid" 2>/dev/null || true)
      if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
        local stale_candidate="${lock_dir}.stale.$$.$RANDOM"
        if mv "$lock_dir" "$stale_candidate" 2>/dev/null; then
          local stale_holder
          stale_holder=$(cat "$stale_candidate/pid" 2>/dev/null || true)
          if [[ -n "$stale_holder" ]] && kill -0 "$stale_holder" 2>/dev/null; then
            mv "$stale_candidate" "$lock_dir" 2>/dev/null || rm -rf "$stale_candidate"
          else
            rm -rf "$stale_candidate"
          fi
          continue
        fi
      fi
    fi
    local now
    now=$(date +%s)
    if (( now - start_time >= max_wait )); then
      die "timed out waiting for bun install lock ($lock_dir)"
    fi
    sleep 0.1
  done
  echo $$ > "$lock_dir/pid"

  local attempt=1 max_attempts=5 out code=0
  while [[ $attempt -le $max_attempts ]]; do
    out=$(cd "$target_dir" && bun install --frozen-lockfile 2>&1) && code=0 || code=$?
    if [[ $code -eq 0 ]]; then
      if [[ -f "$lock_dir/pid" ]] && [[ "$(cat "$lock_dir/pid" 2>/dev/null || true)" == "$$" ]]; then
        rm -rf "$lock_dir" 2>/dev/null || true
      fi
      return 0
    fi
    if [[ "$out" =~ "SQLITE_BUSY" || "$out" =~ "database is locked" ]]; then
      warn "bun install in $target_dir hit SQLITE_BUSY (attempt $attempt/$max_attempts) — retrying"
      sleep $(( attempt ))
      attempt=$(( attempt + 1 ))
    else
      if [[ -f "$lock_dir/pid" ]] && [[ "$(cat "$lock_dir/pid" 2>/dev/null || true)" == "$$" ]]; then
        rm -rf "$lock_dir" 2>/dev/null || true
      fi
      printf '%s\n' "$out" >&2
      return $code
    fi
  done
  if [[ -f "$lock_dir/pid" ]] && [[ "$(cat "$lock_dir/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -rf "$lock_dir" 2>/dev/null || true
  fi
  printf '%s\n' "$out" >&2
  return $code
}

source "$(dirname "${BASH_SOURCE[0]}")/worktree-daemons.sh"


