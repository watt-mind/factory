#!/usr/bin/env bash
# Worktree daemon supervision, health checking, and liveness monitoring (OPS-461).
#
#   bin/worktree-daemons.sh status [WT]       # report pid liveness, /health status & anomalies
#   bin/worktree-daemons.sh check [WT]        # exit 0 if healthy, non-zero on dead daemon / anomaly
#   bin/worktree-daemons.sh anomalies [WT]    # print list of anomalies
#   bin/worktree-daemons.sh supervise [WT]    # watch daemons and restart dead workers with bounded retries
#   bin/worktree-daemons.sh rotate-logs [WT]  # copy-truncate live daemon logs; rename stopped logs
#
set -euo pipefail

# Guard against multiple sourcing
if [[ -z "${_WORKTREE_DAEMONS_LOADED:-}" ]]; then
  _WORKTREE_DAEMONS_LOADED=1

  # Source common helpers if not already loaded
  if [[ -z "${_WORKTREE_COMMON_LOADED:-}" ]]; then
    source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"
  fi

  # Rotate a single daemon log through the shared live-owner-aware helper.
  # A live daemon keeps its original file descriptor, so it must be
  # copy-truncated rather than renamed.
  # Resolve the archive retention count. Mirrors live-stack.sh's guard: a 0 or
  # non-numeric value would make the prune loop delete every archive.
  daemon_log_keep() {
    local keep="${FACTORY_LOG_KEEP:-3}"
    [[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "FACTORY_LOG_KEEP must be a positive integer"
    printf '%s\n' "$keep"
  }

  rotate_log_file() { # <logfile> [max_bytes]
    local logfile="$1"
    local max_bytes="${2:-10485760}" # 10MB default
    local keep
    keep="$(daemon_log_keep)" || exit 1
    rotate_run_log "$logfile" "$max_bytes" "$keep"
  }

  # Rotate all daemon logs through the shared helper, retaining generations.
  rotate_daemon_logs() { # <worktree> [max_bytes]
    local wt="$1"
    local max_bytes="${2:-10485760}"
    local rdir keep
    keep="$(daemon_log_keep)" || exit 1
    rdir="$(run_dir "$wt")"
    rotate_run_logs "$rdir" "$max_bytes" "$keep"
  }

  # Check status of daemons in a worktree.
  # Returns formatted status output, and exits 0 if all expected daemons are running, 1 otherwise.
  check_daemon_health() { # <worktree>
    local wt="$1"
    local rdir hdir api_port="" web_port=""
    rdir="$(run_dir "$wt")"
    hdir="$(event_home "$wt")"

    if recorded=$(read_ports "$wt" 2>/dev/null); then
      api_port="${recorded%% *}"
      web_port="${recorded##* }"
    elif [[ -f "$rdir/ports" ]]; then
      api_port=$(awk -F= '$1=="api"{print $2}' "$rdir/ports" 2>/dev/null || true)
      web_port=$(awk -F= '$1=="web"{print $2}' "$rdir/ports" 2>/dev/null || true)
    fi
    [[ -n "$api_port" ]] || api_port="$HERE_API_PORT"
    [[ -n "$web_port" ]] || web_port="$HERE_WEB_PORT"

    local serve_pid="" worker_pid="" web_pid=""
    local serve_alive=0 worker_alive=0 web_alive=0

    if pid_alive "$rdir/serve.pid"; then
      serve_pid="$(cat "$rdir/serve.pid" 2>/dev/null || true)"
      serve_alive=1
    fi
    if pid_alive "$rdir/worker.pid"; then
      worker_pid="$(cat "$rdir/worker.pid" 2>/dev/null || true)"
      worker_alive=1
    fi
    if pid_alive "$rdir/web.pid"; then
      web_pid="$(cat "$rdir/web.pid" 2>/dev/null || true)"
      web_alive=1
    fi

    local hjson="" hstatus="unreachable"
    if [[ "$serve_alive" -eq 1 ]]; then
      hjson=$(health_json "$api_port")
      if [[ -n "$hjson" ]]; then
        hstatus="ok"
      fi
    fi

    # Anomalies detection
    local anomalies=()
    if [[ "$serve_alive" -eq 0 && -f "$rdir/serve.pid" ]]; then
      anomalies+=("serve daemon died (stale pid $(cat "$rdir/serve.pid" 2>/dev/null || true))")
    elif [[ "$serve_alive" -eq 0 ]]; then
      anomalies+=("serve daemon not running")
    fi

    if [[ "$worker_alive" -eq 0 && -f "$rdir/worker.pid" ]]; then
      anomalies+=("worker daemon died (stale pid $(cat "$rdir/worker.pid" 2>/dev/null || true))")
    elif [[ "$worker_alive" -eq 0 && "$serve_alive" -eq 1 ]]; then
      anomalies+=("worker daemon not running (work will stall)")
    fi

    if [[ "$web_alive" -eq 0 && -f "$rdir/web.pid" ]]; then
      anomalies+=("web server died (stale pid $(cat "$rdir/web.pid" 2>/dev/null || true))")
    fi

    if [[ "$serve_alive" -eq 1 && "$hstatus" == "unreachable" ]]; then
      anomalies+=("serve control API unreachable on port $api_port")
    fi

    if [[ -n "$hjson" ]]; then
      local hhome
      hhome=$(health_field "$hjson" home)
      if [[ -n "$hhome" && "$hhome" != "$hdir" ]]; then
        anomalies+=("control API on port $api_port reports env.home=$hhome (expected $hdir)")
      fi
      # Extract any API reported anomalies if present
      local api_anomalies
      api_anomalies=$(FACTORY_HEALTH_JSON="$hjson" bun --eval '
        let d;
        try { d = JSON.parse(process.env.FACTORY_HEALTH_JSON); } catch { process.exit(0); }
        if (Array.isArray(d?.anomalies) && d.anomalies.length > 0) {
          process.stdout.write(d.anomalies.join("; "));
        } else if (d?.noWorkers) {
          process.stdout.write("no workers active with queued work");
        } else if (d?.stalledWorkers) {
          process.stdout.write("stalled workers detected");
        }
      ' 2>/dev/null || true)
      if [[ -n "$api_anomalies" ]]; then
        anomalies+=("runtime API anomaly: $api_anomalies")
      fi
    fi

    # Output status report
    printf 'Worktree: %s\n' "$wt"
    printf '  serve:   %s\n' "$([[ $serve_alive -eq 1 ]] && echo "running (pid $serve_pid, port $api_port)" || echo "DEAD")"
    printf '  worker:  %s\n' "$([[ $worker_alive -eq 1 ]] && echo "running (pid $worker_pid)" || echo "DEAD")"
    printf '  web:     %s\n' "$([[ $web_alive -eq 1 ]] && echo "running (pid $web_pid, port $web_port)" || echo "DEAD")"
    printf '  health:  %s\n' "$hstatus"
    if [[ ${#anomalies[@]} -gt 0 ]]; then
      printf '  anomalies (%d):\n' "${#anomalies[@]}"
      local a
      for a in "${anomalies[@]}"; do
        printf '    - %s\n' "$a"
      done
      return 1
    else
      printf '  anomalies: none\n'
      return 0
    fi
  }

  # List anomalies as newline-separated strings
  daemon_anomalies() { # <worktree>
    local wt="$1"
    local rdir
    rdir="$(run_dir "$wt")"
    local serve_alive=0 worker_alive=0 web_alive=0
    pid_alive "$rdir/serve.pid" && serve_alive=1
    pid_alive "$rdir/worker.pid" && worker_alive=1
    pid_alive "$rdir/web.pid" && web_alive=1

    if [[ "$serve_alive" -eq 0 && -f "$rdir/serve.pid" ]]; then
      printf 'serve daemon died (pid %s)\n' "$(cat "$rdir/serve.pid" 2>/dev/null || true)"
    fi
    if [[ "$worker_alive" -eq 0 && -f "$rdir/worker.pid" ]]; then
      printf 'worker daemon died (pid %s)\n' "$(cat "$rdir/worker.pid" 2>/dev/null || true)"
    elif [[ "$worker_alive" -eq 0 && "$serve_alive" -eq 1 ]]; then
      printf 'worker daemon not running\n'
    fi
    if [[ "$web_alive" -eq 0 && -f "$rdir/web.pid" ]]; then
      printf 'web server died (pid %s)\n' "$(cat "$rdir/web.pid" 2>/dev/null || true)"
    fi
  }

  # Helper to restart a specific daemon
  restart_daemon() { # <worktree> <daemon_name: serve|worker|web>
    local wt="$1" daemon="$2"
    local rdir hdir api_port="" web_port="" adapter_override=""
    local ADAPTER_ARGS=()
    rdir="$(run_dir "$wt")"
    hdir="$(event_home "$wt")"

    if recorded=$(read_ports "$wt" 2>/dev/null); then
      api_port="${recorded%% *}"
      web_port="${recorded##* }"
    fi
    [[ -n "$api_port" ]] || api_port="$HERE_API_PORT"
    [[ -n "$web_port" ]] || web_port="$HERE_WEB_PORT"

    if [[ "$daemon" == "worker" || "$daemon" == "serve" ]]; then
      adapter_override="$(resolve_adapter_override "$wt" "$api_port")"
      if [[ -n "$adapter_override" ]]; then
        ADAPTER_ARGS=(--adapter-override "$adapter_override")
      fi
    fi

    local timestamp
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    case "$daemon" in
      worker)
        printf '%s [supervisor] restarting dead worker\n' "$timestamp" >> "$rdir/worker.log"
        spawn_daemon "$rdir/worker.pid" "$rdir/worker.log" "$wt" \
          env FACTORY_EVENT_HOME="$hdir" FACTORY_EVENT_PORT="$api_port" \
          bun event-runtime/cli.mjs work ${ADAPTER_ARGS[@]+"${ADAPTER_ARGS[@]}"}
        info "restarted worker (new pid $(cat "$rdir/worker.pid" 2>/dev/null || true))"
        ;;
      serve)
        printf '%s [supervisor] restarting dead serve daemon\n' "$timestamp" >> "$rdir/serve.log"
        spawn_daemon "$rdir/serve.pid" "$rdir/serve.log" "$wt" \
          env FACTORY_EVENT_HOME="$hdir" FACTORY_EVENT_PORT="$api_port" \
          bun event-runtime/cli.mjs serve ${ADAPTER_ARGS[@]+"${ADAPTER_ARGS[@]}"}
        info "restarted serve daemon (new pid $(cat "$rdir/serve.pid" 2>/dev/null || true))"
        ;;
      web)
        printf '%s [supervisor] restarting dead web server\n' "$timestamp" >> "$rdir/web.log"
        spawn_daemon "$rdir/web.pid" "$rdir/web.log" "$wt/event-runtime/web" \
          env FACTORY_EVENT_PORT="$api_port" FACTORY_EVENT_WEB_PORT="$web_port" \
          bun "$wt/event-runtime/web/serve.mjs"
        info "restarted web server (new pid $(cat "$rdir/web.pid" 2>/dev/null || true))"
        ;;
      *)
        die "unknown daemon '$daemon' for restart"
        ;;
    esac
  }

  # Single supervisor tick. Checks daemons and restarts dead ones if under max_restarts.
  # Uses state_file to record restart counts and timestamps.
  supervise_tick() { # <worktree> [state_file] [max_restarts] [window_seconds]
    local wt="$1"
    local rdir
    rdir="$(run_dir "$wt")"
    local state_file="${2:-$rdir/supervisor-state.json}"
    local max_restarts="${3:-5}"
    local window_seconds="${4:-60}"

    mkdir -p "$(dirname "$state_file")"
    local now
    now=$(date +%s)

    local daemons=("serve" "worker" "web")
    local d
    for d in "${daemons[@]}"; do
      local pidfile="$rdir/$d.pid"
      if [[ -f "$pidfile" ]] && ! pid_alive "$pidfile"; then
        # Daemon was tracked by pidfile but is dead!
        local stale_pid
        stale_pid=$(cat "$pidfile" 2>/dev/null || echo "unknown")
        warn "detected dead daemon '$d' (former pid $stale_pid)"

        # Check restart count in sliding window via bun script
        local restart_decision
        restart_decision=$(SUPERVISOR_STATE="$state_file" DAEMON="$d" NOW="$now" MAX="$max_restarts" WINDOW="$window_seconds" bun --eval '
          import { readFileSync, writeFileSync, existsSync } from "node:fs";
          const file = process.env.SUPERVISOR_STATE;
          const daemon = process.env.DAEMON;
          const now = Number(process.env.NOW);
          const max = Number(process.env.MAX);
          const window = Number(process.env.WINDOW);

          let state = {};
          if (existsSync(file)) {
            try { state = JSON.parse(readFileSync(file, "utf8")); } catch {}
          }
          if (!state[daemon]) state[daemon] = [];
          // Filter timestamps within window
          state[daemon] = state[daemon].filter(t => (now - t) < window);

          if (state[daemon].length >= max) {
            process.stdout.write("EXCEEDED:" + state[daemon].length);
          } else {
            state[daemon].push(now);
            writeFileSync(file, JSON.stringify(state, null, 2));
            process.stdout.write("RESTART:" + state[daemon].length);
          }
        ' 2>/dev/null || echo "ERROR")

        if [[ "$restart_decision" =~ ^RESTART:([0-9]+) ]]; then
          local attempt="${BASH_REMATCH[1]}"
          warn "restarting daemon '$d' (attempt $attempt/$max_restarts in ${window_seconds}s window)"
          restart_daemon "$wt" "$d"
        elif [[ "$restart_decision" =~ ^EXCEEDED:([0-9]+) ]]; then
          local count="${BASH_REMATCH[1]}"
          warn "daemon '$d' exceeded max restarts ($count >= $max_restarts in ${window_seconds}s) — crash-loop circuit breaker engaged"
        else
          warn "supervisor state error for daemon '$d' — attempting fallback restart"
          restart_daemon "$wt" "$d"
        fi
      fi
    done
  }

  # Supervisor loop
  supervise_daemons() { # <worktree> [interval] [max_restarts] [window_seconds]
    local wt="$1"
    local interval="${2:-2}"
    local max_restarts="${3:-5}"
    local window_seconds="${4:-60}"
    local rdir
    rdir="$(run_dir "$wt")"
    local state_file="$rdir/supervisor-state.json"

    info "starting daemon supervisor for $wt (interval: ${interval}s, max restarts: $max_restarts in ${window_seconds}s)"
    while true; do
      supervise_tick "$wt" "$state_file" "$max_restarts" "$window_seconds"
      rotate_daemon_logs "$wt"
      sleep "$interval"
    done
  }

fi

# If executed directly as a script (not sourced)
if [[ -z "${BASH_SOURCE[1]:-}" ]]; then
  cmd="${1:-status}"
  shift || true

  wt_arg=""
  once_flag=0
  interval_arg=2
  max_restarts_arg=5
  window_arg=60

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --once) once_flag=1 ;;
      --interval) interval_arg="$2"; shift ;;
      --max-restarts) max_restarts_arg="$2"; shift ;;
      --window) window_arg="$2"; shift ;;
      -h|--help)
        cat <<EOF
usage: worktree-daemons.sh <command> [worktree] [options]

Commands:
  status [WT]       Check and display daemon liveness and anomalies
  check [WT]        Exit 0 if healthy, 1 if any daemon is dead or anomalous
  anomalies [WT]    Print list of anomalies
  supervise [WT]    Run supervisor loop (or --once for single pass)
  rotate-logs [WT]  Copy-truncate live daemon logs or rename stopped logs (> 10MB)

Options:
  --once            Run a single supervisor tick and exit
  --interval N      Supervisor poll interval in seconds (default: 2)
  --max-restarts N  Max restarts in window before circuit breaker (default: 5)
  --window N        Sliding window in seconds for restart count (default: 60)
EOF
        exit 0
        ;;
      *)
        if [[ -z "$wt_arg" ]]; then
          wt_arg="$1"
        fi
        ;;
    esac
    shift
  done

  # Resolve worktree
  WT="${wt_arg:-$PWD}"
  if [[ ! -d "$WT/.factory" && -d "$WT_ROOT/$WT" ]]; then
    WT="$WT_ROOT/$WT"
  fi

  case "$cmd" in
    status)
      check_daemon_health "$WT"
      ;;
    check)
      if [[ -n "$(daemon_anomalies "$WT")" ]]; then
        exit 1
      fi
      check_daemon_health "$WT" >/dev/null 2>&1 || exit 1
      exit 0
      ;;
    anomalies)
      daemon_anomalies "$WT"
      ;;
    supervise)
      if [[ "$once_flag" -eq 1 ]]; then
        supervise_tick "$WT" "$(run_dir "$WT")/supervisor-state.json" "$max_restarts_arg" "$window_arg"
      else
        supervise_daemons "$WT" "$interval_arg" "$max_restarts_arg" "$window_arg"
      fi
      ;;
    rotate-logs|rotate)
      rotate_daemon_logs "$WT"
      ;;
    *)
      die "unknown command '$cmd' (see: bin/worktree-daemons.sh --help)"
      ;;
  esac
fi
