#!/usr/bin/env bash
# Provision an isolated, seeded event-runtime demo environment (OPS-217).
#
#   bin/worktree-up.sh OPS-123                 # worktree + branch feat/OPS-123
#   bin/worktree-up.sh OPS-123 fix modal-bug   # branch fix/OPS-123-modal-bug
#   bin/worktree-up.sh OPS-123 --checkout-only # git worktree only (no daemons/install)
#   bin/worktree-up.sh --here                  # demo env in the CURRENT checkout
#   bin/worktree-up.sh OPS-123 --no-seed       # start empty (no demo data)
#   bin/worktree-up.sh OPS-123 --reseed        # seed again under a fresh prefix
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
POS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --here) HERE=1 ;;
    --live) LIVE=1; SEED=0 ;;
    --no-seed) SEED=0 ;;
    --reseed) RESEED=1 ;;
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

REPO="$(repo_root)"

# `git worktree add` from concurrent bring-ups contends on git's internal
# locks and the loser exits 1 with the reason only on stderr (WM-113).
# Capture stderr so the die names the actual failure, and retry briefly when
# it looks like lock contention; any other error dies immediately. Branch
# existence is re-checked per attempt: a lock-interrupted `-b` add can leave
# the branch created, and a blind `-b` retry would then die on "already
# exists" instead of finishing the checkout.
worktree_add() { # <worktree> <branch> <base-ref>
  local wt="$1" branch="$2" base="$3"
  local attempt=1 max_attempts=3 err=""
  local delays=(0.5 1)
  while :; do
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
      err=$(git -C "$REPO" worktree add --quiet "$wt" "$branch" 2>&1 >/dev/null) && return 0
    else
      err=$(git -C "$REPO" worktree add --quiet "$wt" -b "$branch" "$base" 2>&1 >/dev/null) && return 0
    fi
    if [[ $attempt -lt $max_attempts ]] \
      && grep -qiE '\.lock|could not lock|unable to create|another git process' <<<"$err"; then
      warn "git worktree add hit lock contention (attempt $attempt/$max_attempts) — retrying"
      sleep "${delays[$((attempt - 1))]}"
      attempt=$((attempt + 1))
      continue
    fi
    die "git worktree add failed: $err"
  done
}

if [[ "$HERE" -eq 1 ]]; then
  [[ -z "$TICKET" ]] || die "--here takes no ticket — it provisions the current checkout"
  WT="$REPO"
  LABEL="here"
else
  [[ -n "$TICKET" ]] || die "usage: worktree-up.sh <TICKET-ID> [type] [slug] | --here   (--checkout-only, --no-seed, --reseed)"
  [[ "$TICKET" =~ ^[A-Z]+-[0-9]+(-[A-Za-z0-9][A-Za-z0-9-]*)?$ ]] || die "ticket must look like OPS-123 or OPS-123-scratch"
  WT="$WT_ROOT/$TICKET"
  LABEL="$TICKET"
  BRANCH="$TYPE/$TICKET${SLUG:+-$SLUG}"

  if [[ -d "$WT" ]]; then
    [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "worktree already exists: $WT"
  else
    [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "fetching origin/$BASE_BRANCH"
    git -C "$REPO" fetch origin "$BASE_BRANCH" --quiet || die "could not fetch origin/$BASE_BRANCH"
    [[ "$CHECKOUT_ONLY" -eq 1 ]] || info "creating worktree $WT on $BRANCH"
    worktree_add "$WT" "$BRANCH" "origin/$BASE_BRANCH"
  fi
fi

if [[ "$CHECKOUT_ONLY" -eq 1 ]]; then
  printf '%s\n' "$WT"
  exit 0
fi

command -v bun >/dev/null || die "bun is required (https://bun.sh)"

RUN_DIR="$(run_dir "$WT")"
HOME_DIR="$(event_home "$WT")"
mkdir -p "$RUN_DIR"

# Resolve API/web ports only after the checkout exists so we can persist them
# under .factory/run/ports and refuse a stranger already bound on the slot.
if [[ "$HERE" -eq 1 ]]; then
  API_PORT="$HERE_API_PORT"
  WEB_PORT="$HERE_WEB_PORT"
  write_ports "$WT" "$API_PORT" "$WEB_PORT"
else
  resolved=0
  if recorded=$(read_ports "$WT"); then
    API_PORT="${recorded%% *}"
    WEB_PORT="${recorded##* }"
    if port_listening "$API_PORT"; then
      occupant=$(health_field "$(health_json "$API_PORT")" home)
      if [[ "$occupant" == "$HOME_DIR" ]]; then
        info "reusing recorded ports $API_PORT / $WEB_PORT"
        resolved=1
      else
        if pid_alive "$RUN_DIR/serve.pid" && [[ -n "$occupant" ]]; then
          die "port $API_PORT is owned by another runtime (env.home=$occupant, this worktree=$HOME_DIR) — refusing to seed"
        fi
        warn "recorded port $API_PORT is owned by ${occupant:-unknown process} — allocating a free port"
      fi
    else
      info "reusing recorded ports $API_PORT / $WEB_PORT"
      resolved=1
    fi
  fi
  if [[ "$resolved" -eq 0 ]] && pid_alive "$RUN_DIR/serve.pid"; then
    if sp=$(listen_tcp_port "$RUN_DIR/serve.pid"); then
      API_PORT="$sp"
      if pid_alive "$RUN_DIR/web.pid" && wp=$(listen_tcp_port "$RUN_DIR/web.pid"); then
        WEB_PORT="$wp"
      else
        WEB_PORT=$((API_PORT + 1))
      fi
      info "reusing live daemon ports $API_PORT / $WEB_PORT"
      write_ports "$WT" "$API_PORT" "$WEB_PORT"
      resolved=1
    fi
  fi
  if [[ "$resolved" -eq 0 ]]; then
    preferred="$(ticket_api_port "$TICKET")"
    API_PORT="$(allocate_api_port "$preferred" "$HOME_DIR")"
    WEB_PORT=$((API_PORT + 1))
    write_ports "$WT" "$API_PORT" "$WEB_PORT"
    info "allocated ports $API_PORT / $WEB_PORT (preferred $preferred)"
  fi
fi

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
  (cd "$WEB_DIR" && bun run build:fast >/dev/null) || die "web build failed — run it manually: cd $WEB_DIR && bun run build"
  printf '%s\n' "$WEB_HASH" >"$WEB_DIR/dist/.buildstamp"
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
      rm -f "$RUN_DIR/ports"
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
fi

# Wait for /health BEFORE starting the worker: on a fresh DB, serve and worker
# opening the database concurrently race on the WAL journal-mode switch and
# the loser dies with SQLITE_BUSY (OPS-376). Health up ⇒ serve owns a settled
# DB, so the worker joins an existing WAL.
#
# Ownership, not liveness (OPS-460): a stranger answering /health must not
# count as ready. If our recorded pid died at bind, say so from serve.log
# instead of adopting the process that won the port.
HEALTH_JSON=""
for _ in {1..50}; do
  HEALTH_JSON=$(curl -sf -m 1 "http://127.0.0.1:$API_PORT/health" 2>/dev/null) && break
  HEALTH_JSON=""
  if ! pid_alive "$RUN_DIR/serve.pid"; then
    rm -f "$RUN_DIR/ports"
    die "event runtime died during startup on $API_PORT — see $RUN_DIR/serve.log"
  fi
  sleep 0.1
done
if ! pid_alive "$RUN_DIR/serve.pid"; then
  rm -f "$RUN_DIR/ports"
  die "event runtime died during startup on $API_PORT — see $RUN_DIR/serve.log"
fi
if [[ -z "$HEALTH_JSON" ]]; then
  rm -f "$RUN_DIR/ports"
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
fi

if pid_alive "$RUN_DIR/web.pid"; then
  info "web server already running (pid $(cat "$RUN_DIR/web.pid"), port $WEB_PORT)"
else
  info "starting web server on $WEB_PORT"
  spawn_daemon "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$WT" \
    env FACTORY_EVENT_PORT="$API_PORT" FACTORY_EVENT_WEB_PORT="$WEB_PORT" \
    bun event-runtime/web/serve.mjs
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
cat <<EOF

$(info "ready — $LABEL")

  checkout   $WT
  event home $HOME_DIR
  control    http://127.0.0.1:$API_PORT      $(adapter_banner "$HEALTH_ADAPTER")
  web UI     http://127.0.0.1:$WEB_PORT
  logs       $RUN_DIR/{serve,worker,web}.log

  status:  FACTORY_EVENT_PORT=$API_PORT bun event-runtime/cli.mjs status
  verify:  cd $WT && bun test event-runtime/ && bun event-runtime/demo/verify.mjs --port $API_PORT
  down:    bin/worktree-down.sh $([[ "$HERE" -eq 1 ]] && echo "--here" || echo "$TICKET")
EOF
