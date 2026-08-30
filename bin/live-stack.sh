#!/usr/bin/env bash
# Manage the live production event-runtime stack (OPS-233, WM-60).
#
#   factory up                   # start live api (7381), worker(s), and web UI (7382)
#   factory up --fake            # start with fake adapter (for staging/testing on live db)
#   factory up --dev             # live-reload stack: serve --watch, vite HMR web,
#                                # drain-aware worker (WM-213)
#   factory up --no-build        # serve the existing web bundle without checking it
#   factory up --workers 1:3     # supervised worker pool instead of one worker (WM-226)
#   factory down                 # cleanly stop live daemons (drains the pool first)
#   factory tail                 # tail all live logs (serve.log, worker.log, web.log)
#   factory tail worker          # tail a specific daemon log
#
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"

# `up` can start several detached daemons before an endpoint health check
# proves the stack is usable. Keep this invocation's pidfiles separate from
# pre-existing daemons: an error must clean up what we started, but never tear
# down a daemon an operator already had running.
UP_STARTED_PIDFILES=()
UP_STARTED_LABELS=()
UP_PREEXISTING_PIDFILES=()
UP_PREEXISTING_PIDS=()
# Only an `up` that has taken its snapshot may clean up on `die`. Every other
# action (down, tail, a bad option, the __supervise-* loops) has an empty
# snapshot, and an empty snapshot would make every pidfile in RUN_DIR look like
# ours — `factory tail nosuchlog` must never stop the operator's live stack.
UP_SNAPSHOT_TAKEN=0

snapshot_up_pidfiles() {
  local pidfile
  for pidfile in "$RUN_DIR"/*.pid; do
    [[ -f "$pidfile" ]] || continue
    UP_PREEXISTING_PIDFILES+=("$pidfile")
    UP_PREEXISTING_PIDS+=("$(cat "$pidfile" 2>/dev/null || true)")
  done
  UP_SNAPSHOT_TAKEN=1
}

up_pidfile_preexisted_unchanged() { # <pidfile>
  local pidfile="$1" i current
  current="$(cat "$pidfile" 2>/dev/null || true)"
  # Empty-array guards keep "${arr[@]}" safe under bash 3.2 + set -u.
  [[ ${#UP_PREEXISTING_PIDFILES[@]} -gt 0 ]] || return 1
  for i in "${!UP_PREEXISTING_PIDFILES[@]}"; do
    if [[ "${UP_PREEXISTING_PIDFILES[$i]}" == "$pidfile" \
      && "${UP_PREEXISTING_PIDS[$i]}" == "$current" ]]; then
      return 0
    fi
  done
  return 1
}

track_up_pidfile() { # <label> <pidfile>
  local label="$1" pidfile="$2" existing
  if [[ ${#UP_STARTED_PIDFILES[@]} -gt 0 ]]; then
    for existing in "${UP_STARTED_PIDFILES[@]}"; do
      [[ "$existing" == "$pidfile" ]] && return 0
    done
  fi
  UP_STARTED_PIDFILES+=("$pidfile")
  UP_STARTED_LABELS+=("$label")
}

track_up_pool_pidfiles() {
  local pidfile label
  for pidfile in "$RUN_DIR/supervisor.pid" "$RUN_DIR"/worker-[0-9]*.pid; do
    [[ -f "$pidfile" ]] || continue
    up_pidfile_preexisted_unchanged "$pidfile" && continue
    label="worker pool $(basename "${pidfile%.pid}")"
    track_up_pidfile "$label" "$pidfile"
  done
}

cleanup_up_daemons() {
  local round i pidfile label
  [[ "$UP_SNAPSHOT_TAKEN" -eq 1 ]] || return 0
  # The pool supervisor creates its own supervisor/worker-N pidfiles after the
  # top-level worker daemon is spawned. Discover those before teardown so its
  # detached worker groups are terminated too, while snapshot-matched files
  # belonging to a pre-existing stack remain untouched.
  track_up_pool_pidfiles
  [[ ${#UP_STARTED_PIDFILES[@]} -gt 0 ]] || return 0

  warn "up failed — stopping daemons started by this invocation"
  # Re-scan after the first await: a just-spawned pool supervisor can publish
  # its detached worker pidfiles while the top-level supervisor is stopping.
  for round in 1 2; do
    track_up_pool_pidfiles
    for i in "${!UP_STARTED_PIDFILES[@]}"; do
      pidfile="${UP_STARTED_PIDFILES[$i]}"
      label="${UP_STARTED_LABELS[$i]}"
      term_daemon "$pidfile" "$label" || true
    done
    for i in "${!UP_STARTED_PIDFILES[@]}"; do
      pidfile="${UP_STARTED_PIDFILES[$i]}"
      label="${UP_STARTED_LABELS[$i]}"
      await_daemon "$pidfile" "$label" || true
      # await_daemon normally removes this itself. Keep the invariant even for
      # a platform-specific implementation that only waits, or a dead child
      # whose pidfile was never valid.
      rm -f "$pidfile"
      if [[ "$(basename "$pidfile")" == worker-[0-9]*.pid ]]; then
        rm -f "${pidfile%.pid}.drain" "${pidfile%.pid}.id"
      fi
    done
  done
  UP_STARTED_PIDFILES=()
  UP_STARTED_LABELS=()
}

die() {
  cleanup_up_daemons
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

spawn_daemon_tracked() { # <label> <pidfile> <logfile> <workdir> <cmd...>
  local label="$1" pidfile="$2"
  shift 2
  spawn_daemon "$pidfile" "$@" || die "failed to start $label — check logs at $1"
  track_up_pidfile "$label" "$pidfile"
}

print_daemon_command() { # <label> <cmd...>
  local label="$1"
  shift
  printf '  %s: ' "$label"
  printf '%q ' "$@"
  printf '\n'
}

ACTION="${1:-up}"
shift || true

HOME_DIR="${FACTORY_EVENT_HOME:-$HOME/.factory/event-runtime}"
RUN_DIR="${FACTORY_RUN_DIR:-$HOME/.factory/run}"
API_PORT="${FACTORY_EVENT_PORT:-7381}"
WEB_PORT="${FACTORY_EVENT_WEB_PORT:-7382}"

# `up` creates these itself once `--dry-run` has had its chance to exit: a dry
# run must leave no trace on disk.
if [[ "$ACTION" != "up" ]]; then mkdir -p "$RUN_DIR" "$HOME_DIR"; fi
REPO="$(repo_root)"

elapsed_seconds() {
  local elapsed="${1//[[:space:]]/}" days=0 rest hours=0 minutes=0 seconds=0
  rest="$elapsed"
  if [[ "$rest" == *-* ]]; then
    days="${rest%%-*}"
    rest="${rest#*-}"
  fi
  local parts=()
  IFS=: read -r -a parts <<<"$rest"
  case "${#parts[@]}" in
    2) minutes="${parts[0]}"; seconds="${parts[1]}" ;;
    3) hours="${parts[0]}"; minutes="${parts[1]}"; seconds="${parts[2]}" ;;
    *) return 1 ;;
  esac
  printf '%s\n' $((10#$days * 86400 + 10#$hours * 3600 + 10#$minutes * 60 + 10#$seconds))
}

cleanup_stale_fake_runtimes() {
  local max_age_minutes="${FACTORY_FAKE_RUNTIME_MAX_AGE_MINUTES:-30}"
  [[ "$max_age_minutes" =~ ^[0-9]+$ ]] || {
    warn "ignoring invalid FACTORY_FAKE_RUNTIME_MAX_AGE_MINUTES=$max_age_minutes"
    return 0
  }

  local pid pgid elapsed command age_seconds process_with_env seen_groups=" " processes
  local current_pgid
  current_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d '[:space:]')"
  # A captured stream works in minimal chroots that expose /proc but omit the
  # conventional /dev/fd symlink Bash process substitution relies on.
  processes="$(ps -axo pid=,pgid=,etime=,command= 2>/dev/null || true)"
  while read -r pid pgid elapsed command; do
    [[ "$pid" =~ ^[0-9]+$ && "$pid" -ne $$ ]] || continue
    [[ "$pgid" =~ ^[0-9]+$ ]] || continue
    [[ -z "$current_pgid" || "$pgid" != "$current_pgid" ]] || continue
    [[ "$command" =~ event-runtime/cli\.mjs[[:space:]]+(serve|work)([[:space:]]|$) ]] || continue
    [[ " $command " == *" --adapter-override fake "* ]] || continue
    if [[ "$command" != *"factory-test-"* ]]; then
      process_with_env="$(ps eww -p "$pid" -o command= 2>/dev/null || true)"
      [[ "$process_with_env" =~ FACTORY_TEST_TRACKED_PROCESS=[^[:space:]]+ ]] || continue
    fi
    age_seconds="$(elapsed_seconds "$elapsed")" || continue
    (( age_seconds >= max_age_minutes * 60 )) || continue
    [[ "$seen_groups" == *" $pgid "* ]] && continue
    seen_groups+="$pgid "

    warn "killing stale fake-adapter test runtime pid $pid (age $elapsed): $command"
    # The explicit test-owner marker prevents --fake live/staging stacks from
    # being mistaken for test debris. Marked runtimes are detached group
    # leaders, so a group kill also removes wrappers and grandchildren.
    kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done <<<"$processes"
}

# PIDs listening on <port> that THIS checkout started (WM-657, #1068). Ownership
# is decided by the process argv naming this checkout ($REPO): every daemon we
# spawn runs an absolute $REPO/... path, so a sibling worktree's stack or the
# operator's own live stack on the same port is never matched — the reap stays
# scoped to processes we are responsible for, which is what makes it safe to run
# on the shared operator box.
owned_port_holders() { # <port>
  command -v lsof >/dev/null 2>&1 || return 0
  local pid cmd holders
  holders="$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ && "$pid" -ne $$ ]] || continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    [[ "$cmd" == *"$REPO/"* ]] || continue
    printf '%s\n' "$pid"
  done <<<"$holders"
}

# Reap an orphan of ours still holding <port> after the pidfile teardown, or
# before `up` binds it. The recorded owner has already been dealt with (down) or
# is known dead (up's pre-flight) by the time this runs, so anything of ours
# still on the port is a leak: a serve.mjs the web supervisor re-exec'd into a
# pid the group-kill missed, or a daemon whose process group split. SIGTERM
# first, then SIGKILL what ignores it. A holder we do not own is left untouched
# for the bind to reject with its existing diagnostic.
reap_owned_port() { # <port> <label>
  command -v lsof >/dev/null 2>&1 || return 0
  local port="$1" label="$2" pid deadline holders
  holders="$(owned_port_holders "$port")"
  [[ -n "$holders" ]] || return 0
  for pid in $holders; do
    warn "reaping orphaned $label still holding port $port (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
  done
  deadline=$(( $(date +%s) + 3 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    holders="$(owned_port_holders "$port")"
    [[ -n "$holders" ]] || return 0
    sleep 0.1
  done
  for pid in $(owned_port_holders "$port"); do
    warn "$label on port $port ignored SIGTERM — killing (pid $pid)"
    kill -KILL "$pid" 2>/dev/null || true
  done
}

# Final backstop for `down` (#1068): after the pidfile teardown, sweep for any
# serve, worker, or web process THIS checkout started that still survives — a
# daemon whose process group split, or a serve.mjs re-exec'd into a pid the
# group-kill missed. Scoped to this checkout's own paths ($REPO) and excluding
# our own process group, so a sibling worktree's stack or the operator's own is
# never touched. This is the acceptance guarantee that no cli.mjs serve/work or
# web/serve.mjs the stack owns remains after `down`.
reap_owned_processes() {
  local pid pgid cmd current_pgid processes
  current_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d '[:space:]')"
  processes="$(ps -axo pid=,pgid=,command= 2>/dev/null || true)"
  while read -r pid pgid cmd; do
    [[ "$pid" =~ ^[0-9]+$ && "$pid" -ne $$ ]] || continue
    [[ "$pgid" =~ ^[0-9]+$ ]] || continue
    [[ -z "$current_pgid" || "$pgid" != "$current_pgid" ]] || continue
    case "$cmd" in
      *"$REPO/event-runtime/cli.mjs "*) ;;
      *"$REPO/event-runtime/web/serve.mjs"*) ;;
      *"$REPO/bin/live-stack.sh __supervise"*) ;;
      *) continue ;;
    esac
    warn "reaping orphaned stack process pid $pid: $cmd"
    kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done <<<"$processes"
}

case "$ACTION" in
  up)
    ADAPTER_FLAG=()
    DEV=0
    NO_BUILD=0
    DRY_RUN=0
    WEB_BUILD_MESSAGE=""
    WORKERS_SPEC=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --fake) ADAPTER_FLAG=("--adapter-override" "fake") ;;
        --adapter-override) ADAPTER_FLAG=("--adapter-override" "$2"); shift ;;
        --port) API_PORT="$2"; shift ;;
        --web-port) WEB_PORT="$2"; shift ;;
        --dev) DEV=1 ;;
        --no-build) NO_BUILD=1 ;;
        --dry-run) DRY_RUN=1 ;;
        --workers) WORKERS_SPEC="$2"; shift ;;
        -h|--help)
          echo "usage: factory up [--fake] [--dev] [--no-build] [--dry-run] [--workers min:max] [--port 7381] [--web-port 7382]"
          echo "  --dev       live reload: serve --watch, vite HMR web UI, worker restarts when idle"
          echo "  --no-build  serve the existing web bundle without checking whether it is stale"
          echo "  --dry-run   print resolved ports and daemon commands without starting anything"
          echo "  --workers   supervised pool scaling between min and max on queue depth (WM-226);"
          echo "             without it, a workers: block in config/policy.yaml selects the pool"
          exit 0
          ;;
        *) die "unknown option '$1' (see: factory up --help)" ;;
      esac
      shift
    done

    # A supervised pool and --dev both want to own the worker slot, and they
    # want it for different reasons (scale vs. reload). Saying so beats silently
    # picking one — WM-213's reload supervisor drives a single worker by design.
    if [[ "$DEV" -eq 1 && -n "$WORKERS_SPEC" ]]; then
      die "--workers and --dev both replace the worker daemon — run the pool without --dev"
    fi

    # Policy-driven by default: the presence of a workers: block is the switch,
    # so a checkout without one keeps starting exactly one plain worker (the
    # pre-WM-226 behavior, unchanged).
    POOL=0
    if [[ -n "$WORKERS_SPEC" ]]; then
      POOL=1
    elif [[ "$DEV" -eq 0 && -f "$REPO/config/policy.yaml" ]] && grep -qE '^workers:[[:space:]]*(#.*)?$' "$REPO/config/policy.yaml"; then
      POOL=1
    fi

    # --dev swaps each of the three daemons for its reloading twin and changes
    # nothing else. SERVE_ARGS/WORKER_ARGS are built rather than branched so the
    # non-dev command stays exactly what it was before this flag existed. (They
    # are never empty, which keeps "${arr[@]}" safe under bash 3.2 + set -u.)
    SERVE_ARGS=(serve --port "$API_PORT")
    if [[ ${#ADAPTER_FLAG[@]} -gt 0 ]]; then
      SERVE_ARGS+=("${ADAPTER_FLAG[@]}")
    fi
    WORKER_ARGS=(bun "$REPO/event-runtime/cli.mjs" work)
    if [[ "$POOL" -eq 1 ]]; then
      # The supervisor takes the worker.pid slot; the workers it spawns get
      # their own worker-N.pid files in the same run dir, so `down`, `tail`, and
      # `factory events status` all keep working on the pool as a whole.
      WORKER_ARGS=(bun "$REPO/event-runtime/cli.mjs" supervise)
      if [[ -n "$WORKERS_SPEC" ]]; then
        WORKER_ARGS+=(--workers "$WORKERS_SPEC")
      fi
    fi
    if [[ "$DEV" -eq 1 ]]; then
      SERVE_ARGS+=(--watch)
      # The worker is supervised rather than watched: it exits 75 at an idle
      # poll boundary and this same script re-execs it (see __supervise-worker).
      WORKER_ARGS=(bash "$REPO/bin/live-stack.sh" __supervise-worker --reload-on-change)
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf 'dry run — no daemons will be started\n'
      printf 'RUN_DIR=%s\nAPI_PORT=%s\nWEB_PORT=%s\n' "$RUN_DIR" "$API_PORT" "$WEB_PORT"
      printf 'daemon commands:\n'
      if [[ -n "${FACTORY_GH_APP_ID:-}" && -n "${FACTORY_GH_APP_PRIVATE_KEY_PATH:-}" ]]; then
        print_daemon_command "GitHub App token daemon" \
          bun "$REPO/lib/control-plane/gh-app-auth.mjs" --daemon
      fi
      print_daemon_command "event runtime" \
        env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
        bun "$REPO/event-runtime/cli.mjs" "${SERVE_ARGS[@]}"
      print_daemon_command "worker" \
        env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
        "${WORKER_ARGS[@]}"
      if [[ "$DEV" -eq 1 ]]; then
        print_daemon_command "web server" \
          env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
          bunx vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort
      else
        print_daemon_command "web server" \
          env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
          bun "$REPO/event-runtime/web/serve.mjs"
      fi
      print_daemon_command "web supervisor" \
        env FACTORY_RUN_DIR="$RUN_DIR" FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
        bash "$REPO/bin/live-stack.sh" __supervise-web "$DEV"
      exit 0
    fi

    mkdir -p "$RUN_DIR" "$HOME_DIR"
    # Record what was already running before this invocation starts anything,
    # so a failed `up` can tell its own daemons from the operator's.
    snapshot_up_pidfiles

    # Dependency freshness (WM-312). A runtime dependency added to the repo does
    # not exist on the running stack until someone remembers `bun install` after
    # pulling, and nothing detected the gap: on 2026-08-15 the Gondolin sandbox
    # SDK shipped, CI went green on it (CI installs fresh every run), and the
    # live fleet ran the rest of the day with `sandbox doctor` reporting
    # unavailable and no signal anywhere. CI green plus production dark is the
    # failure worth closing, not the missing package.
    #
    # A stamp file rather than node_modules' mtime: `bun install` leaves the
    # directory untouched when nothing changes, so an mtime comparison would
    # report stale forever and install on every single start.
    # Gated on a LOCKFILE, not on package.json: a lockfile is what makes a
    # directory a dependency tree we own. Without one there is nothing to be
    # stale against, and installing anyway would run `bun install` over any
    # directory that merely happens to contain a package.json — including the
    # synthetic fixtures bin/live-stack.test.mjs builds, whose package.json is
    # deliberately not valid JSON.
    ensure_deps() {
      local label="$1" dir="$2"
      local lock=""
      for candidate in "$dir/bun.lock" "$dir/bun.lockb"; do
        [[ -f "$candidate" ]] && { lock="$candidate"; break; }
      done
      [[ -n "$lock" ]] || return 0
      local stamp="$dir/node_modules/.factory-deps-stamp"
      if [[ -d "$dir/node_modules" && -f "$stamp" && ! "$lock" -nt "$stamp" ]]; then
        [[ -f "$dir/package.json" && "$dir/package.json" -nt "$stamp" ]] || return 0
      fi
      info "installing $label dependencies (lockfile newer than the last install)"
      (cd "$dir" && bun install) || die "bun install failed in $dir — refusing to start on stale dependencies"
      mkdir -p "$dir/node_modules" && : > "$stamp"
    }
    ensure_deps "root" "$REPO"
    ensure_deps "event-runtime/web" "$REPO/event-runtime/web"

    if [[ "$DEV" -eq 1 ]]; then
      if [[ ! -d "$REPO/event-runtime/web/node_modules" ]]; then
        die "--dev needs the web deps for vite — run: (cd $REPO/event-runtime/web && bun install)"
      fi
    elif [[ "$NO_BUILD" -eq 1 ]]; then
      warn "--no-build: served web bundle may be stale or missing; rerun without --no-build to rebuild"
    else
      WEB_DIR="$REPO/event-runtime/web"
      DIST_INDEX="$WEB_DIR/dist/index.html"
      WEB_BUNDLE_STALE=0
      WEB_BUNDLE_REASON="stale"
      if [[ ! -f "$DIST_INDEX" ]]; then
        WEB_BUNDLE_STALE=1
        WEB_BUNDLE_REASON="missing"
      elif [[ -n "$(find "$WEB_DIR/src" -type f -newer "$DIST_INDEX" -print -quit)" ]]; then
        WEB_BUNDLE_STALE=1
      else
        for WEB_BUILD_INPUT in "$WEB_DIR/index.html" "$WEB_DIR/vite.config.ts" "$WEB_DIR/package.json"; do
          if [[ -f "$WEB_BUILD_INPUT" && "$WEB_BUILD_INPUT" -nt "$DIST_INDEX" ]]; then
            WEB_BUNDLE_STALE=1
            break
          fi
        done
      fi

      if [[ "$WEB_BUNDLE_STALE" -eq 1 ]]; then
        info "web bundle $WEB_BUNDLE_REASON — rebuilding"
        WEB_BUILD_STARTED=$(date +%s)
        if ! (cd "$WEB_DIR" && bun run build); then
          die "web bundle build failed — run it manually: cd $WEB_DIR && bun run build"
        fi
        [[ -f "$DIST_INDEX" ]] || die "web bundle build completed without creating $DIST_INDEX"
        WEB_BUILD_SECONDS=$(( $(date +%s) - WEB_BUILD_STARTED ))
        WEB_BUILD_MESSAGE="web bundle $WEB_BUNDLE_REASON — rebuilt in ${WEB_BUILD_SECONDS}s"
      fi
    fi

    # Pre-flight port reclaim (#1068). A crashed or half-completed previous run
    # can leave a process THIS checkout started still holding :API_PORT/:WEB_PORT
    # after its pidfile is gone — the classic symptom is a web serve.mjs that
    # held :7382 across restarts. `up` stays idempotent: a live daemon that still
    # owns its pidfile is left to the "already running" checks below, so we only
    # reclaim a port when its recorded owner is dead. reap_owned_port never
    # touches a holder we do not own.
    if ! pid_alive "$RUN_DIR/serve.pid"; then
      reap_owned_port "$API_PORT" "event runtime"
    fi
    if ! pid_alive "$RUN_DIR/web.pid"; then
      reap_owned_port "$WEB_PORT" "web server"
    fi

    # 0. Start or verify the GitHub App token-refresh daemon (#1148, epic #1136).
    # When the App is configured, gh-app-auth.mjs --daemon mints a fresh
    # installation token into ~/.factory/gh-app-token.json (~every 45 min; tokens
    # expire hourly) and github.mjs reads that file per gh call. Supervising it
    # here means a stack restart no longer strands the token: without the daemon
    # the file goes stale within the hour and the control-plane silently falls
    # back to the operator PAT — the rate contention the App exists to remove.
    #
    # Gated on both App vars: absent either, no daemon starts and nothing changes
    # (no regression — the PAT path is still the default). Mint once in the
    # foreground first so the token file exists before serve makes its first gh
    # call; a failed mint warns rather than aborts, because serve's PAT fallback
    # still lets the stack come up while the daemon retries.
    if [[ -n "${FACTORY_GH_APP_ID:-}" && -n "${FACTORY_GH_APP_PRIVATE_KEY_PATH:-}" ]]; then
      if pid_alive "$RUN_DIR/gh-app-auth.pid"; then
        info "GitHub App token daemon already running (pid $(cat "$RUN_DIR/gh-app-auth.pid"))"
      else
        info "minting initial GitHub App installation token"
        if ! (cd "$REPO" && bun "$REPO/lib/control-plane/gh-app-auth.mjs" >>"$RUN_DIR/gh-app-auth.log" 2>&1); then
          warn "initial GitHub App token mint failed — control-plane falls back to the operator PAT until the daemon succeeds (see $RUN_DIR/gh-app-auth.log)"
        fi
        info "starting GitHub App token-refresh daemon"
        spawn_daemon_tracked "GitHub App token daemon" "$RUN_DIR/gh-app-auth.pid" "$RUN_DIR/gh-app-auth.log" "$REPO" \
          bun "$REPO/lib/control-plane/gh-app-auth.mjs" --daemon
      fi
    fi

    # 1. Start or verify event runtime API server
    if pid_alive "$RUN_DIR/serve.pid"; then
      info "event runtime already running (pid $(cat "$RUN_DIR/serve.pid"), port $API_PORT)"
    else
      info "starting event runtime on $API_PORT (home $HOME_DIR)"
      spawn_daemon_tracked "event runtime" "$RUN_DIR/serve.pid" "$RUN_DIR/serve.log" "$REPO" \
        env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
        bun "$REPO/event-runtime/cli.mjs" "${SERVE_ARGS[@]}"
    fi

    # 2. Wait for API to respond
    for i in $(seq 30); do
      if curl -sf -m 1 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done
    if ! curl -sf -m 1 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
      die "event runtime failed to start on $API_PORT — check logs at $RUN_DIR/serve.log"
    fi

    # 3. Start or verify worker
    if pid_alive "$RUN_DIR/worker.pid"; then
      info "worker already running (pid $(cat "$RUN_DIR/worker.pid"))"
    else
      if [[ "$POOL" -eq 1 ]]; then
        info "starting worker pool supervisor${WORKERS_SPEC:+ (workers $WORKERS_SPEC)}"
      else
        info "starting worker"
      fi
      spawn_daemon_tracked "worker" "$RUN_DIR/worker.pid" "$RUN_DIR/worker.log" "$REPO" \
        env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
        "${WORKER_ARGS[@]}"
    fi

    # 4. Start or verify web server
    if pid_alive "$RUN_DIR/web.pid"; then
      info "web server already running (pid $(cat "$RUN_DIR/web.pid"), port $WEB_PORT)"
    else
      info "starting web server on $WEB_PORT"
      if [[ "$DEV" -eq 1 ]]; then
        # vite's own dev server, not the static serve.mjs: HMR replaces the
        # module in the open tab, so no `bun run build` step in the loop. It
        # proxies /api to FACTORY_EVENT_PORT exactly as serve.mjs does.
        spawn_daemon_tracked "web server" "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$REPO/event-runtime/web" \
          env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
          bunx vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort
      else
        spawn_daemon_tracked "web server" "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$REPO/event-runtime/web" \
          env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
          bun "$REPO/event-runtime/web/serve.mjs"
      fi
    fi

    # Keep the web endpoint available if serve.mjs exits on an unexpected
    # process-level failure. The supervisor only runs while the API daemon is
    # alive, so `factory down` cannot turn into a restart race.
    if pid_alive "$RUN_DIR/web-supervisor.pid"; then
      info "web supervisor already running (pid $(cat "$RUN_DIR/web-supervisor.pid"))"
    else
      info "starting web supervisor"
      spawn_daemon_tracked "web supervisor" "$RUN_DIR/web-supervisor.pid" "$RUN_DIR/web.log" "$REPO" \
        env FACTORY_RUN_DIR="$RUN_DIR" FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
        bash "$REPO/bin/live-stack.sh" __supervise-web "$DEV"
    fi

    # 5. Wait for web server (vite has to boot a dep-optimize pass on a cold cache)
    WEB_TRIES=30
    if [[ "$DEV" -eq 1 ]]; then WEB_TRIES=150; fi
    for i in $(seq "$WEB_TRIES"); do
      if curl -sf -m 1 "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done
    # Warn, never die: the runtime and worker pool are healthy by now, and the
    # web supervisor keeps retrying the static server. Tearing down a working
    # stack because the UI bound slowly on a loaded box would be the worse
    # outcome (#1396 review).
    if ! curl -sf -m 1 "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then
      warn "web server not responding on $WEB_PORT yet — the web supervisor keeps retrying; check logs at $RUN_DIR/web.log"
    fi

    if [[ "$DEV" -eq 1 ]]; then
      printf '\n\033[32m==>\033[0m \033[1mready — live factory stack (dev, live reload)\033[0m\n\n'
    else
      printf '\n\033[32m==>\033[0m \033[1mready — live factory stack\033[0m\n\n'
    fi
    if [[ -n "$WEB_BUILD_MESSAGE" ]]; then
      printf '  %s\n\n' "$WEB_BUILD_MESSAGE"
    fi
    printf '  event home %s\n' "$HOME_DIR"
    printf '  control    http://127.0.0.1:%s\n' "$API_PORT"
    printf '  web UI     http://127.0.0.1:%s\n' "$WEB_PORT"
    printf '  logs       %s/{serve,worker,web}.log\n\n' "$RUN_DIR"
    if [[ "$POOL" -eq 1 ]]; then
      printf '  workers    supervised pool%s — per-worker logs %s/worker-N.log\n' \
        "${WORKERS_SPEC:+ ($WORKERS_SPEC)}" "$RUN_DIR"
      printf '             scale-down drains; a worker holding a run finishes it first\n\n'
    fi
    if [[ "$DEV" -eq 1 ]]; then
      printf '  reload     serve: bun --watch  |  web: vite HMR  |  worker: on exit 75 when idle\n'
      printf '             agents/schemas need: bun event-runtime/cli.mjs update-pins\n\n'
    fi
    printf '  status:  factory events status\n'
    printf '  tail:    factory tail\n'
    printf '  down:    factory down\n\n'
    ;;

  __supervise-web)
    # The static server normally survives API restarts. If an unrelated
    # uncaught process error does terminate it, keep the UI reachable while the
    # API daemon is still alive. A bounded one-second check avoids crash-looping
    # while still recovering before the next operator pulse.
    WEB_DEV="${1:-0}"
    WEB_CHILD_PID=""
    # A replacement stays in this supervisor's process group rather than being
    # detached. `factory down` can therefore stop the whole group atomically,
    # including a child spawned just before SIGTERM reaches this shell.
    trap 'if [[ -n "$WEB_CHILD_PID" ]]; then kill -TERM "$WEB_CHILD_PID" 2>/dev/null || true; fi; exit 0' TERM INT
    while pid_alive "$RUN_DIR/serve.pid"; do
      if ! pid_alive "$RUN_DIR/web.pid"; then
        printf '%s [web-supervisor] web server down; restarting\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        if [[ "$WEB_DEV" -eq 1 ]]; then
          (
            cd "$REPO/event-runtime/web"
            exec env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
              bunx vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort
          ) >>"$RUN_DIR/web.log" 2>&1 &
        else
          (
            cd "$REPO/event-runtime/web"
            exec env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
              bun "$REPO/event-runtime/web/serve.mjs"
          ) >>"$RUN_DIR/web.log" 2>&1 &
        fi
        WEB_CHILD_PID=$!
        printf '%s\n' "$WEB_CHILD_PID" >"$RUN_DIR/web.pid"
      fi
      sleep "${FACTORY_WEB_SUPERVISOR_INTERVAL:-1}"
    done
    printf '%s [web-supervisor] event runtime stopped; supervisor exiting\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;

  __supervise-worker)
    # Dev worker supervisor (WM-213). `work --reload-on-change` exits 75 at an
    # idle poll boundary when event-runtime code changed; this re-execs it.
    #
    # Only on 75: exit 0 is a clean drain and must stay down, and any other code
    # is a real failure the developer needs to see rather than a crash loop.
    CHILD_PID=""
    SUPERVISOR_STOPPING=0
    # Declared before the trap: a signal arriving early must not hit an unbound
    # variable under `set -u`.
    trap 'SUPERVISOR_STOPPING=1; if [[ -n "$CHILD_PID" ]]; then kill -TERM "$CHILD_PID" 2>/dev/null || true; fi' TERM INT
    while true; do
      bun "$REPO/event-runtime/cli.mjs" work "$@" &
      CHILD_PID=$!
      # A trap interrupts `wait`; loop until the child is really gone so the
      # supervisor outlives its worker's drain and `factory down` waits for both.
      CODE=0
      while true; do
        wait "$CHILD_PID" || CODE=$?
        kill -0 "$CHILD_PID" 2>/dev/null || break
      done
      CHILD_PID=""
      if [[ "$SUPERVISOR_STOPPING" -eq 1 ]]; then
        # `wait` interrupted by the trap reports 128+signal, not what the worker
        # actually exited with — reporting that number would just be noise. The
        # operator asked for a stop and got one.
        printf '[supervisor] worker drained after signal — supervisor stopping\n'
        exit 0
      fi
      if [[ "$CODE" -eq 75 ]]; then
        printf '[supervisor] worker reloaded (exit 75) — restarting on new code\n'
        continue
      fi
      printf '[supervisor] worker exited %s — supervisor stopping\n' "$CODE"
      exit "$CODE"
    done
    ;;

  down)
    info "stopping live factory stack..."
    # A supervised pool (WM-226) needs its own wait: await_daemon gives a daemon
    # three seconds and then SIGKILLs it, which is right for a web server and
    # wrong for a supervisor whose workers are still finishing agent runs. Term
    # it first and wait properly — it drains its pool, escalates on its own
    # schedule, and only then exits. FACTORY_POOL_DRAIN_TIMEOUT bounds our
    # patience; past it we fall through to the ordinary teardown, which is the
    # operator's "stop now" and says so.
    if [[ -f "$RUN_DIR/supervisor.pid" ]] && pid_alive "$RUN_DIR/worker.pid"; then
      POOL_WAIT="${FACTORY_POOL_DRAIN_TIMEOUT:-180}"
      info "draining worker pool (up to ${POOL_WAIT}s — runs in flight finish first)"
      term_daemon "$RUN_DIR/worker.pid" "worker pool supervisor"
      DEADLINE=$(( $(date +%s) + POOL_WAIT ))
      while pid_alive "$RUN_DIR/worker.pid" && [[ $(date +%s) -lt $DEADLINE ]]; do
        sleep 0.5
      done
      if pid_alive "$RUN_DIR/worker.pid"; then
        warn "worker pool still draining after ${POOL_WAIT}s — stopping it anyway; the reaper requeues any lease left behind"
      fi
    fi
    # Stop and reap the web supervisor before terminating the web process, or
    # it could observe the planned shutdown as a crash and replace the daemon.
    if [[ -f "$RUN_DIR/web-supervisor.pid" ]]; then
      term_daemon "$RUN_DIR/web-supervisor.pid" "web supervisor"
      await_daemon "$RUN_DIR/web-supervisor.pid" "web supervisor"
    fi
    term_daemon "$RUN_DIR/web.pid" "web server"
    term_daemon "$RUN_DIR/worker.pid" "worker"
    term_daemon "$RUN_DIR/serve.pid" "event runtime"
    # Reap the App token daemon by pidfile too (#1148). term_daemon/await_daemon
    # are no-ops when the pidfile is absent, so a stack that never started it
    # (App env unset) tears down exactly as before.
    term_daemon "$RUN_DIR/gh-app-auth.pid" "GitHub App token daemon"
    await_daemon "$RUN_DIR/web.pid" "web server"
    await_daemon "$RUN_DIR/worker.pid" "worker"
    await_daemon "$RUN_DIR/serve.pid" "event runtime"
    await_daemon "$RUN_DIR/gh-app-auth.pid" "GitHub App token daemon"
    # Backstop the pidfile teardown: reclaim the ports and sweep any serve /
    # worker / web process of ours that outlived its recorded pid, so a restart
    # never inherits an orphan holding :7381/:7382 or a lease (#1068).
    reap_owned_port "$WEB_PORT" "web server"
    reap_owned_port "$API_PORT" "event runtime"
    reap_owned_processes
    rm -f "$RUN_DIR"/*.pid "$RUN_DIR"/*.drain "$RUN_DIR"/*.id
    cleanup_stale_fake_runtimes
    info "done — live factory stack is down (durable state preserved at $HOME_DIR)"
    ;;

  tail)
    if [[ $# -gt 0 ]]; then
      TARGET="$1"
      LOG_FILE="$RUN_DIR/$TARGET.log"
      [[ -f "$LOG_FILE" ]] || die "log file does not exist: $LOG_FILE"
      exec tail -n 50 -f "$LOG_FILE"
    else
      LOGS=()
      for f in "$RUN_DIR"/{serve,worker,web}.log; do
        [[ -f "$f" ]] && LOGS+=("$f")
      done
      if [[ ${#LOGS[@]} -eq 0 ]]; then
        touch "$RUN_DIR/serve.log" "$RUN_DIR/worker.log" "$RUN_DIR/web.log"
        LOGS=("$RUN_DIR/serve.log" "$RUN_DIR/worker.log" "$RUN_DIR/web.log")
      fi
      exec tail -n 50 -f "${LOGS[@]}"
    fi
    ;;

  *)
    die "unknown action '$ACTION' (expected: up, down, tail)"
    ;;
esac
