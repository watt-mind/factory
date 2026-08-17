#!/usr/bin/env bash
# Provision an isolated, seeded event-runtime demo environment (OPS-217).
#
#   bin/worktree-up.sh OPS-123                 # worktree + branch feat/OPS-123
#   bin/worktree-up.sh OPS-123 fix modal-bug   # branch fix/OPS-123-modal-bug
#   bin/worktree-up.sh OPS-123 --checkout-only # git worktree only (no daemons/install)
#   bin/worktree-up.sh --here                  # demo env in the CURRENT checkout
#   bin/worktree-up.sh OPS-123 --no-seed       # start empty (no demo data)
#   bin/worktree-up.sh OPS-123 --no-fetch      # skip git fetch when base ref exists
#   bin/worktree-up.sh OPS-123 --reseed        # seed again under a fresh prefix
#   bin/worktree-up.sh OPS-123 --resume        # preserve an existing branch as-is
#
# What it isolates that `git worktree add` does not: the control-API and web
# ports (hashed from the full ticket id, persisted in .factory/run/ports) and
# FACTORY_EVENT_HOME (inside the worktree's gitignored .factory/). Bring-up
# verifies /health env.home is this checkout and env.adapter matches the
# requested mode before it seeds. The runtime always starts with
# --adapter-override fake — approving a demo proposal never spawns a real
# agent — and is seeded with one of everything (event-runtime/demo/seed.mjs)
# so e2e and styling sessions have a deterministic fixture, verified by
# event-runtime/demo/verify.mjs before the script reports ready.
#
# Idempotent: re-running leaves live daemons and your uncommitted work alone,
# reinstalls only what bun decides is stale, and re-seeds only on --reseed.
source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"

TICKET=""
TYPE="feat"
SLUG=""
HERE=0
SEED=1
RESEED=0
LIVE=0
CHECKOUT_ONLY=0
NO_FETCH=0
RESUME="${FACTORY_WORKTREE_RESUME:-0}"
POS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --here) HERE=1 ;;
    --live) LIVE=1; SEED=0 ;;
    --no-seed) SEED=0 ;;
    --no-fetch) NO_FETCH=1 ;;
    --reseed) RESEED=1 ;;
    --resume) RESUME=1 ;;
    --checkout-only) CHECKOUT_ONLY=1 ;;
    -h | --help)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option '$1' (see: bin/worktree-up.sh --help)" ;;
    *)
      POS=$((POS + 1))
      case "$POS" in
        1) TICKET="$1" ;;
        2) TYPE="$1" ;;
        3) SLUG="$1" ;;
        *) die "too many arguments (got '$1')" ;;
      esac
      ;;
  esac
  shift
done

[[ "$RESUME" == "0" || "$RESUME" == "1" ]] \
  || die "FACTORY_WORKTREE_RESUME must be 0 or 1 (got '$RESUME')"

REPO="$(repo_root)"
WORKTREE_LIFECYCLE_LOCK=""

try_worktree_lifecycle_lock() { # <ticket>
  local common root lock holder=""
  common=$(git -C "$REPO" rev-parse --git-common-dir)
  [[ "$common" == /* ]] || common="$REPO/$common"
  root="$common/factory-worktree-locks"
  lock="$root/$1.lock"
  mkdir -p "$root"
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

if [[ "$HERE" -eq 1 ]]; then
  [[ -z "$TICKET" ]] || die "--here takes no ticket — it provisions the current checkout"
  WT="$REPO"
  LABEL="here"
else
  [[ -n "$TICKET" ]] || die "usage: worktree-up.sh <TICKET-ID> [type] [slug] | --here   (--checkout-only, --no-seed, --no-fetch, --reseed, --resume)"
  [[ "$TICKET" =~ ^[A-Z]+-[0-9]+(-[A-Za-z0-9][A-Za-z0-9-]*)?$ ]] || die "ticket must look like OPS-123 or OPS-123-scratch"
  WT="$WT_ROOT/$TICKET"
  LABEL="$TICKET"
  BRANCH="$TYPE/$TICKET${SLUG:+-$SLUG}"

  try_worktree_lifecycle_lock "$TICKET" \
    || die "worktree_lifecycle_busy: another process is provisioning or removing $TICKET"
  trap release_worktree_lifecycle_lock EXIT
  trap 'release_worktree_lifecycle_lock; exit 130' INT
  trap 'release_worktree_lifecycle_lock; exit 143' TERM

  BASE_REF="origin/$BASE_BRANCH"
  BRANCH_EXISTS=0
  RESUMING=0
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH" && BRANCH_EXISTS=1

  # An explicit resume is a promise not to refresh or inspect the existing
  # branch against the base. Auto-resume still fetches so its unique-commit
  # and open-PR checks use the current remote base.
  if [[ "$BRANCH_EXISTS" -eq 1 && "$RESUME" -eq 1 ]]; then
    RESUMING=1
  else
    [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "fetching origin/$BASE_BRANCH"
    if [[ "$NO_FETCH" -eq 1 ]]; then
      FACTORY_SKIP_FETCH=1 git_fetch "$REPO" "origin" "$BASE_BRANCH"
    else
      git_fetch "$REPO" "origin" "$BASE_BRANCH"
    fi
  fi

  if [[ "$BRANCH_EXISTS" -eq 1 ]]; then
    BRANCH_SHA=$(git -C "$REPO" rev-parse "refs/heads/$BRANCH") \
      || die "worktree_branch_inspection_failed: could not resolve branch '$BRANCH'"

    if [[ "$RESUMING" -eq 0 ]]; then
      BASE_SHA=$(git -C "$REPO" rev-parse "$BASE_REF") \
        || die "worktree_branch_inspection_failed: could not resolve $BASE_REF"
      UNIQUE_COMMITS=$(git -C "$REPO" rev-list --count "$BASE_REF..$BRANCH") \
        || die "worktree_branch_inspection_failed: could not compare branch '$BRANCH' with $BASE_REF"
    fi

    if [[ "$RESUMING" -eq 0 && "$UNIQUE_COMMITS" -gt 0 ]]; then
      OPEN_PR_COUNT=$(cd "$REPO" && gh pr list --head "$BRANCH" --state open --json number --limit 1 --jq 'length' 2>/dev/null) \
        || die "worktree_pr_inspection_failed: could not check for an open PR on branch '$BRANCH'"
      [[ "$OPEN_PR_COUNT" == "1" ]] && RESUMING=1
    fi

    if [[ "$RESUMING" -eq 1 ]]; then
      if [[ -d "$WT" ]]; then
        CURRENT_BRANCH=$(git -C "$WT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
        [[ "$CURRENT_BRANCH" == "$BRANCH" ]] \
          || die "worktree_branch_mismatch: $WT is on '${CURRENT_BRANCH:-detached HEAD}', expected '$BRANCH'"
      fi
      [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "resuming branch $BRANCH as-is"
    else
      if [[ "$UNIQUE_COMMITS" -gt 0 ]]; then
        die "worktree_branch_has_commits: branch '$BRANCH' has $UNIQUE_COMMITS unique commit(s) beyond $BASE_REF — re-run with --resume or remove branch '$BRANCH' explicitly before re-dispatch"
      fi

      if [[ -d "$WT" ]]; then
        CURRENT_BRANCH=$(git -C "$WT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
        [[ "$CURRENT_BRANCH" == "$BRANCH" ]] \
          || die "worktree_branch_mismatch: $WT is on '${CURRENT_BRANCH:-detached HEAD}', expected '$BRANCH'"
        [[ -z "$(git -C "$WT" status --porcelain)" ]] \
          || die "worktree_branch_dirty: $WT has uncommitted work — re-run with --resume or clean it explicitly before re-dispatch"
        # `merge --ff-only` is non-destructive if another process commits after
        # inspection; unlike reset --hard, it can never discard that commit.
        git -C "$WT" merge --ff-only "$BASE_REF" >/dev/null \
          || die "worktree_branch_update_failed: branch '$BRANCH' changed while moving to $BASE_REF"
      else
        # Compare-and-swap the ref so a concurrent commit cannot be overwritten.
        git -C "$REPO" update-ref "refs/heads/$BRANCH" "$BASE_SHA" "$BRANCH_SHA" \
          || die "worktree_branch_update_failed: branch '$BRANCH' changed while moving to $BASE_REF"
      fi

      UNIQUE_COMMITS=$(git -C "$REPO" rev-list --count "$BASE_REF..$BRANCH") \
        || die "worktree_branch_inspection_failed: could not re-check branch '$BRANCH'"
      [[ "$UNIQUE_COMMITS" -eq 0 ]] \
        || die "worktree_branch_has_commits: branch '$BRANCH' gained $UNIQUE_COMMITS unique commit(s) while moving to $BASE_REF — refusing re-dispatch"
    fi
  elif [[ -d "$WT" ]]; then
    die "worktree_branch_missing: $WT exists but branch '$BRANCH' does not"
  fi

  if [[ -d "$WT" ]]; then
    if [[ "$RESUMING" -eq 1 ]]; then
      [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "worktree already exists on resumed branch: $WT"
    else
      [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "worktree already exists at current $BASE_REF: $WT"
    fi
  else
    [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "creating worktree $WT on $BRANCH"
    worktree_add "$WT" "$BRANCH" "$BASE_REF" "$REPO"
  fi
fi

if [[ "$CHECKOUT_ONLY" -eq 1 ]]; then
  printf '%s\n' "$WT"
  exit 0
fi

command -v bun >/dev/null || die "bun is required (https://bun.sh)"
command -v lsof >/dev/null || die "lsof is required to verify daemon port ownership"

RUN_DIR="$(run_dir "$WT")"
HOME_DIR="$(event_home "$WT")"
mkdir -p "$RUN_DIR"

# `worktree_up` has two failure classes (WM-334). Provisioning failures still
# exit non-zero. A project check that is already red is reported to the runtime
# through this per-invocation file and bring-up continues with a usable tree.
# The runtime supplies a workspace-confined path; --here callers get a local
# fallback so the same behavior is visible when provisioning manually.
BASELINE_REPORT="${FACTORY_WORKTREE_REPORT:-$RUN_DIR/baseline.json}"
rm -f "$BASELINE_REPORT"
record_red_baseline() {
  local check="$1"
  local command="$2"
  local exit_code="$3"
  local output_file="$4"
  bun -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const [report, check, command, exitCode, outputFile] = process.argv.slice(1);
    const raw = readFileSync(outputFile, "utf8");
    const output = raw.length > 65536 ? raw.slice(-65536) : raw;
    writeFileSync(report, JSON.stringify({ status: "red", check, command, exitCode: Number(exitCode), output }, null, 2) + "\n");
  ' -- "$BASELINE_REPORT" "$check" "$command" "$exit_code" "$output_file"
}

# Resolve API/web ports only after the checkout exists so we can persist them.
# --here prefers 7391/7392 but follows the same recorded-port reuse and
# collision fallback path as named ticket worktrees. If anything after the
# reservation fails, stop only daemons created by this invocation and release
# dead partial pid/port state so a retry can claim the pair.
STARTED_SERVE=0
STARTED_WORKER=0
STARTED_WEB=0
WORKTREE_UP_OK=0
cleanup_worktree_up() {
  local code=$?
  trap - EXIT INT TERM
  release_port_allocation_lock
  if [[ "$code" -ne 0 && "$WORKTREE_UP_OK" -ne 1 ]]; then
    [[ "$STARTED_WEB" -eq 1 ]] && term_daemon "$RUN_DIR/web.pid" "web server"
    [[ "$STARTED_WORKER" -eq 1 ]] && term_daemon "$RUN_DIR/worker.pid" "worker"
    [[ "$STARTED_SERVE" -eq 1 ]] && term_daemon "$RUN_DIR/serve.pid" "event runtime"
    [[ "$STARTED_WEB" -eq 1 ]] && await_daemon "$RUN_DIR/web.pid" "web server"
    [[ "$STARTED_WORKER" -eq 1 ]] && await_daemon "$RUN_DIR/worker.pid" "worker"
    [[ "$STARTED_SERVE" -eq 1 ]] && await_daemon "$RUN_DIR/serve.pid" "event runtime"
    release_worktree_ports_if_idle "$WT"
  fi
  exit "$code"
}
trap cleanup_worktree_up EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$HERE" -eq 1 ]]; then
  preferred="$HERE_API_PORT"
else
  preferred="$(ticket_api_port "$TICKET")"
fi
resolve_worktree_ports "$WT" "$preferred" "$HOME_DIR"

# ------------------------------------------------------------ dependencies ---
info "installing dependencies (bun install, root + web)"
locked_bun_install "$WT" || die "bun install failed in $WT"
locked_bun_install "$WT/event-runtime/web" || die "bun install failed in $WT/event-runtime/web"


# Rebuild only when the build inputs changed since the last successful build.
# The stamp lives inside dist/, so vite wiping the output dir also wipes the
# stamp and a half-finished build can never masquerade as current. build:fast
# skips `tsc --noEmit` — type-checking belongs to verification/CI, not env
# bring-up (`bun run build` in ci.yml still type-checks).
WEB_DIR="$WT/event-runtime/web"
WEB_HASH="$(web_build_hash "$WEB_DIR")"
if [[ -f "$WEB_DIR/dist/index.html" && "$(cat "$WEB_DIR/dist/.buildstamp" 2>/dev/null)" == "$WEB_HASH" ]]; then
  info "web bundle up to date — skipping build"
else
  info "building the web bundle"
  WEB_BUILD_OUTPUT="$RUN_DIR/baseline-web-build.log"
  if (cd "$WEB_DIR" && bun run build:fast >"$WEB_BUILD_OUTPUT" 2>&1); then
    printf '%s\n' "$WEB_HASH" >"$WEB_DIR/dist/.buildstamp"
    rm -f "$WEB_BUILD_OUTPUT"
  else
    build_status=$?
    cat "$WEB_BUILD_OUTPUT" >&2
    warn "baseline is red: web_build failed (exit $build_status) — continuing with the usable worktree"
    record_red_baseline "web_build" "cd event-runtime/web && bun run build:fast" "$build_status" "$WEB_BUILD_OUTPUT"
  fi
fi

WEB_AVAILABLE=1
if [[ -f "$BASELINE_REPORT" && ! -f "$WEB_DIR/dist/index.html" ]]; then
  WEB_AVAILABLE=0
  warn "web UI unavailable because the baseline web build failed; control API and worker remain usable"
fi

# ---------------------------------------------------------------- daemons ---
FRESH=0
[[ -f "$HOME_DIR/runtime.db" ]] || FRESH=1

ADAPTER_ARGS=()
if [[ "$LIVE" -ne 1 ]]; then
  ADAPTER_ARGS=(--adapter-override fake)
fi

# Last line of defence before bind: if the chosen port already serves a
# different event home, refuse now (naming both homes) instead of starting a
# serve that dies at bind and then mistaking the stranger's /health for ours.
if port_listening "$API_PORT"; then
  occupant=$(health_field "$(health_json "$API_PORT")" home)
  if [[ "$occupant" != "$HOME_DIR" ]]; then
    if ! pid_alive "$RUN_DIR/serve.pid"; then
      die "port $API_PORT is owned by another runtime (env.home=${occupant:-unknown}, this worktree=$HOME_DIR) — refusing to seed"
    fi
  fi
fi

if pid_alive "$RUN_DIR/serve.pid"; then
  info "event runtime already running (pid $(cat "$RUN_DIR/serve.pid"), port $API_PORT)"
else
  info "starting event runtime on $API_PORT ($([[ "$LIVE" -eq 1 ]] && echo "live adapters" || echo "fake adapter"), home $HOME_DIR)"
  spawn_daemon "$RUN_DIR/serve.pid" "$RUN_DIR/serve.log" "$WT" \
    env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
    bun event-runtime/cli.mjs serve ${ADAPTER_ARGS[@]+"${ADAPTER_ARGS[@]}"}
  STARTED_SERVE=1
fi

# Wait for /health BEFORE starting the worker: on a fresh DB, serve and worker
# opening the database concurrently race on the WAL journal-mode switch and
# the loser dies with SQLITE_BUSY (OPS-376). Health up ⇒ serve owns a settled
# DB, so the worker joins an existing WAL.
#
dump_daemon_log() { # <logfile> <label>
  local logfile="$1" label="$2"
  if [[ -f "$logfile" ]]; then
    warn "$label log ($logfile):"
    cat "$logfile" >&2
  fi
}

# Ownership, not liveness (OPS-460): a stranger answering /health must not
# count as ready. If our recorded pid died at bind, say so from serve.log
# instead of adopting the process that won the port.
HEALTH_JSON=""
for _ in {1..50}; do
  HEALTH_JSON=$(curl -sf -m 1 "http://127.0.0.1:$API_PORT/health" 2>/dev/null) && break
  HEALTH_JSON=""
  if ! pid_alive "$RUN_DIR/serve.pid"; then
    dump_daemon_log "$RUN_DIR/serve.log" "event runtime"
    die "event runtime died during startup on $API_PORT — see $RUN_DIR/serve.log"
  fi
  sleep 0.1
done
if ! pid_alive "$RUN_DIR/serve.pid"; then
  dump_daemon_log "$RUN_DIR/serve.log" "event runtime"
  die "event runtime died during startup on $API_PORT — see $RUN_DIR/serve.log"
fi
if [[ -z "$HEALTH_JSON" ]]; then
  dump_daemon_log "$RUN_DIR/serve.log" "event runtime"
  HEALTH_JSON=$(curl -sf -m 2 "http://127.0.0.1:$API_PORT/health") \
    || die "control API never came up on $API_PORT — see $RUN_DIR/serve.log"
fi
assert_event_home "$HEALTH_JSON" "$HOME_DIR" "$API_PORT"
assert_event_adapter "$HEALTH_JSON" "$LIVE" "$API_PORT"
HEALTH_ADAPTER=$(health_field "$HEALTH_JSON" adapter)

# The worker is its own process (OPS-233): restarting the runtime or the web
# server must never interrupt a running agent.
if pid_alive "$RUN_DIR/worker.pid"; then
  info "worker already running (pid $(cat "$RUN_DIR/worker.pid"))"
else
  info "starting worker ($([[ "$LIVE" -eq 1 ]] && echo "live adapters" || echo "fake adapter"))"
  spawn_daemon "$RUN_DIR/worker.pid" "$RUN_DIR/worker.log" "$WT" \
    env FACTORY_EVENT_HOME="$HOME_DIR" FACTORY_EVENT_PORT="$API_PORT" \
    bun event-runtime/cli.mjs work ${ADAPTER_ARGS[@]+"${ADAPTER_ARGS[@]}"}
  STARTED_WORKER=1
fi

if [[ "$WEB_AVAILABLE" -eq 1 ]]; then
  if pid_alive "$RUN_DIR/web.pid"; then
    info "web server already running (pid $(cat "$RUN_DIR/web.pid"), port $WEB_PORT)"
  else
    info "starting web server on $WEB_PORT"
    spawn_daemon "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$WT" \
      env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
      bun event-runtime/web/serve.mjs
    STARTED_WEB=1
  fi

  # A listener alone is insufficient: an alien process could have occupied the
  # adjacent port after allocation. Require the recorded web daemon itself to own
  # the persisted port before reporting the environment ready.
  WEB_PID_PORT=""
  for _ in {1..50}; do
    if ! pid_alive "$RUN_DIR/web.pid"; then
      dump_daemon_log "$RUN_DIR/web.log" "web server"
      die "web server died during startup on $WEB_PORT — see $RUN_DIR/web.log"
    fi
    WEB_PID_PORT=$(listen_tcp_port "$RUN_DIR/web.pid" || true)
    [[ "$WEB_PID_PORT" == "$WEB_PORT" ]] && break
    sleep 0.1
  done
  if [[ "$WEB_PID_PORT" != "$WEB_PORT" ]]; then
    dump_daemon_log "$RUN_DIR/web.log" "web server"
    die "web server pid $(cat "$RUN_DIR/web.pid") did not bind reserved port $WEB_PORT"
  fi
fi

# ------------------------------------------------------------------- seed ---
if [[ "$SEED" -eq 1 && ( "$FRESH" -eq 1 || "$RESEED" -eq 1 ) ]]; then
  PREFIX="demo"
  [[ "$RESEED" -eq 1 && "$FRESH" -eq 0 ]] && PREFIX="demo-$(date +%s)"
  info "seeding demo data (prefix $PREFIX)"
  seed_attempt=1
  max_seed_attempts=5
  seed_ok=0
  seed_out=""
  while [[ $seed_attempt -le $max_seed_attempts ]]; do
    if seed_out=$(cd "$WT" && bun event-runtime/demo/seed.mjs --port "$API_PORT" --prefix "$PREFIX" 2>&1); then
      printf '%s\n' "$seed_out"
      seed_ok=1
      break
    fi
    if [[ "$seed_out" =~ "SQLITE_BUSY" || "$seed_out" =~ "database is locked" || "$seed_out" =~ "locked" || "$seed_out" =~ "internal_error" || "$seed_out" =~ "500" || "$seed_out" =~ "409" ]]; then
      backoff_delay=$(( 1 << (seed_attempt - 1) ))
      warn "demo seed hit transient lock/error (attempt $seed_attempt/$max_seed_attempts) — retrying in ${backoff_delay}s"
      sleep "$backoff_delay"
      seed_attempt=$(( seed_attempt + 1 ))
    else
      printf '%s\n' "$seed_out" >&2
      die "seed failed — see output above"
    fi
  done
  if [[ "$seed_ok" -ne 1 ]]; then
    printf '%s\n' "$seed_out" >&2
    die "seed failed after $max_seed_attempts attempts — see output above"
  fi
elif [[ "$SEED" -eq 1 ]]; then
  info "existing database found — not reseeding (use --reseed for a fresh set)"
else
  warn "skipping demo seed (--no-seed)"
fi

# Verify only when this run actually (re)seeded — on an idempotent re-run the
# fixture was already verified when it was created, and /health above is the
# liveness signal. `bun ... verify.mjs` stays in the report for on-demand use.
if [[ "$SEED" -eq 1 && ( "$FRESH" -eq 1 || "$RESEED" -eq 1 ) ]]; then
  info "verifying the e2e fixture"
  (cd "$WT" && bun event-runtime/demo/verify.mjs --port "$API_PORT") || die "fixture verification failed"
fi

# ----------------------------------------------------------------- report ---
if [[ "$WEB_AVAILABLE" -eq 1 ]]; then
  WEB_UI_REPORT="http://127.0.0.1:$WEB_PORT"
else
  WEB_UI_REPORT="unavailable (baseline web build failed)"
fi
WORKTREE_UP_OK=1
cat <<EOF

$(info "ready — $LABEL")

  checkout   $WT
  event home $HOME_DIR
  control    http://127.0.0.1:$API_PORT      $(adapter_banner "$HEALTH_ADAPTER")
  web UI     $WEB_UI_REPORT
  logs       $RUN_DIR/{serve,worker,web}.log

  status:  FACTORY_EVENT_PORT=$API_PORT bun event-runtime/cli.mjs status
  verify:  cd $WT && bun test event-runtime/ && bun event-runtime/demo/verify.mjs --port $API_PORT
  down:    bin/worktree-down.sh $([[ "$HERE" -eq 1 ]] && echo "--here" || echo "$TICKET")
EOF
