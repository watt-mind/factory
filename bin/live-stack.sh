#!/usr/bin/env bash
# Manage the live production event-runtime stack (OPS-233, WM-60).
#
#   factory up                   # start live api (7381), worker, and web UI (7382)
#   factory up --fake            # start with fake adapter (for staging/testing on live db)
#   factory up --dev             # live-reload stack: serve --watch, vite HMR web,
#                                # drain-aware worker (WM-213)
#   factory down                 # cleanly stop live daemons
#   factory tail                 # tail all live logs (serve.log, worker.log, web.log)
#   factory tail worker          # tail a specific daemon log
#
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"

ACTION="${1:-up}"
shift || true

HOME_DIR="${FACTORY_EVENT_HOME:-$HOME/.factory/event-runtime}"
RUN_DIR="${FACTORY_RUN_DIR:-$HOME/.factory/run}"
API_PORT="${FACTORY_EVENT_PORT:-7381}"
WEB_PORT="${FACTORY_EVENT_WEB_PORT:-7382}"

mkdir -p "$RUN_DIR" "$HOME_DIR"
REPO="$(repo_root)"

case "$ACTION" in
  up)
    ADAPTER_FLAG=()
    DEV=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --fake) ADAPTER_FLAG=("--adapter-override" "fake") ;;
        --adapter-override) ADAPTER_FLAG=("--adapter-override" "$2"); shift ;;
        --port) API_PORT="$2"; shift ;;
        --web-port) WEB_PORT="$2"; shift ;;
        --dev) DEV=1 ;;
        -h|--help)
          echo "usage: factory up [--fake] [--dev] [--port 7381] [--web-port 7382]"
          echo "  --dev  live reload: serve --watch, vite HMR web UI, worker restarts when idle"
          exit 0
          ;;
        *) die "unknown option '$1' (see: factory up --help)" ;;
      esac
      shift
    done

    # --dev swaps each of the three daemons for its reloading twin and changes
    # nothing else. SERVE_ARGS/WORKER_ARGS are built rather than branched so the
    # non-dev command stays exactly what it was before this flag existed. (They
    # are never empty, which keeps "${arr[@]}" safe under bash 3.2 + set -u.)
    SERVE_ARGS=(serve --port "$API_PORT")
    if [[ ${#ADAPTER_FLAG[@]} -gt 0 ]]; then
      SERVE_ARGS+=("${ADAPTER_FLAG[@]}")
    fi
    WORKER_ARGS=(bun "$REPO/event-runtime/cli.mjs" work)
    if [[ "$DEV" -eq 1 ]]; then
      SERVE_ARGS+=(--watch)
      # The worker is supervised rather than watched: it exits 75 at an idle
      # poll boundary and this same script re-execs it (see __supervise-worker).
      WORKER_ARGS=(bash "$REPO/bin/live-stack.sh" __supervise-worker --reload-on-change)
      if [[ ! -d "$REPO/event-runtime/web/node_modules" ]]; then
        die "--dev needs the web deps for vite — run: (cd $REPO/event-runtime/web && bun install)"
      fi
    fi

    # 1. Start or verify event runtime API server
    if pid_alive "$RUN_DIR/serve.pid"; then
      info "event runtime already running (pid $(cat "$RUN_DIR/serve.pid"), port $API_PORT)"
    else
      info "starting event runtime on $API_PORT (home $HOME_DIR)"
      spawn_daemon "$RUN_DIR/serve.pid" "$RUN_DIR/serve.log" "$REPO" \
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
      info "starting worker"
      spawn_daemon "$RUN_DIR/worker.pid" "$RUN_DIR/worker.log" "$REPO" \
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
        spawn_daemon "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$REPO/event-runtime/web" \
          env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
          bunx vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort
      else
        spawn_daemon "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$REPO/event-runtime/web" \
          env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
          bun "$REPO/event-runtime/web/serve.mjs"
      fi
    fi

    # 5. Wait for web server (vite has to boot a dep-optimize pass on a cold cache)
    WEB_TRIES=30
    if [[ "$DEV" -eq 1 ]]; then WEB_TRIES=150; fi
    for i in $(seq "$WEB_TRIES"); do
      if curl -sf -m 1 "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done

    if [[ "$DEV" -eq 1 ]]; then
      printf '\n\033[32m==>\033[0m \033[1mready — live factory stack (dev, live reload)\033[0m\n\n'
    else
      printf '\n\033[32m==>\033[0m \033[1mready — live factory stack\033[0m\n\n'
    fi
    printf '  event home %s\n' "$HOME_DIR"
    printf '  control    http://127.0.0.1:%s\n' "$API_PORT"
    printf '  web UI     http://127.0.0.1:%s\n' "$WEB_PORT"
    printf '  logs       %s/{serve,worker,web}.log\n\n' "$RUN_DIR"
    if [[ "$DEV" -eq 1 ]]; then
      printf '  reload     serve: bun --watch  |  web: vite HMR  |  worker: on exit 75 when idle\n'
      printf '             agents/schemas need: bun event-runtime/cli.mjs update-pins\n\n'
    fi
    printf '  status:  factory events status\n'
    printf '  tail:    factory tail\n'
    printf '  down:    factory down\n\n'
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
    term_daemon "$RUN_DIR/web.pid" "web server"
    term_daemon "$RUN_DIR/worker.pid" "worker"
    term_daemon "$RUN_DIR/serve.pid" "event runtime"
    await_daemon "$RUN_DIR/web.pid" "web server"
    await_daemon "$RUN_DIR/worker.pid" "worker"
    await_daemon "$RUN_DIR/serve.pid" "event runtime"
    rm -f "$RUN_DIR"/*.pid
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
