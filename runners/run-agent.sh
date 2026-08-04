#!/usr/bin/env bash
# Run one factory command as a headless Claude Code session, inside a repo.
#
#   runners/run-agent.sh --repo bj29 --command factory-triage --read-only
#   runners/run-agent.sh --repo bj29 --command factory-work --args "CLNT-616"
#   runners/run-agent.sh --repo bj29,legalease --command factory-triage --dry
#
# Headless CLI rather than the Agent SDK on purpose: this is the same agent that
# works interactively, just unattended, so plugins, hooks and MCP config load
# from the repo exactly as they do when you run `claude` yourself.
#
# macOS ships bash 3.2, which errors on "${arr[@]}" under `set -u` and mangles
# embedded JS. So: no arrays here, and envelope parsing lives in report.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="" ; COMMAND="" ; BUDGET="" ; DRY=0 ; ARGS="" ; READONLY=0 ; USE_API=0 ; MODEL="" ; HARNESS="claude"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)      REPO="$2"; shift 2 ;;
    --command)   COMMAND="$2"; shift 2 ;;
    --budget)    BUDGET="$2"; shift 2 ;;
    --args)      ARGS="$2"; shift 2 ;;
    --dry)       DRY=1; shift ;;
    --read-only) READONLY=1; shift ;;
    --use-api)   USE_API=1; shift ;;
    --model)     MODEL="$2"; shift 2 ;;
    --harness)   HARNESS="$2"; shift 2 ;;
    -h|--help)   sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO"    ]] || { echo "--repo is required"    >&2; exit 2; }
[[ -n "$COMMAND" ]] || { echo "--command is required" >&2; exit 2; }

# --repo takes a list. Repos run SEQUENTIALLY: parallelism belongs inside a repo
# (one ticket, one worktree, Owned Paths keeping them apart), not across repos,
# where concurrent sessions contend for one machine and one usage window.
case "$REPO" in
  *,*)
    rc=0
    for r in ${REPO//,/ }; do
      echo
      echo "=============================== $r ==============================="
      # Rebuild argv with `set --` (bash 3.2 has no arrays under set -u) rather
      # than eval on a string — an --args value containing a quote must survive.
      set -- --repo "$r" --command "$COMMAND"
      [[ -n "$BUDGET"     ]] && set -- "$@" --budget "$BUDGET"
      [[ -n "$ARGS"       ]] && set -- "$@" --args "$ARGS"
      [[ "$DRY"      == 1 ]] && set -- "$@" --dry
      [[ "$READONLY" == 1 ]] && set -- "$@" --read-only
      [[ "$USE_API"  == 1 ]] && set -- "$@" --use-api
      [[ -n "$MODEL"      ]] && set -- "$@" --model "$MODEL"
      [[ "$HARNESS" != "claude" ]] && set -- "$@" --harness "$HARNESS"
      "$0" "$@" || rc=$?
    done
    exit $rc
    ;;
esac

# Repo facts and budget come from config/, so the runner has no opinions of its
# own to drift from policy.
REPO_PATH="$(cd "$ROOT" && bun -e '
  const c = Bun.YAML.parse(await Bun.file("config/repos.yaml").text());
  const r = (c.repos ?? []).find((x) => x.name === process.argv[1]);
  if (!r) { console.error("no repo in config/repos.yaml: " + process.argv[1]); process.exit(2); }
  console.log(r.path.replace("~", process.env.HOME));
' "$REPO")"
REPO_TEAM="$(cd "$ROOT" && bun -e '
  const c = Bun.YAML.parse(await Bun.file("config/repos.yaml").text());
  console.log((c.repos ?? []).find((x) => x.name === process.argv[1]).team);
' "$REPO")"
[[ -d "$REPO_PATH" ]] || { echo "repo path does not exist: $REPO_PATH" >&2; exit 2; }

# Hard cap, from policy. `timeout` sends TERM at the limit and KILL 30s later,
# so a wedged harness cannot hold a slot indefinitely.
MAX_MIN="$(cd "$ROOT" && bun -e '
  const p = Bun.YAML.parse(await Bun.file("config/policy.yaml").text());
  console.log(p?.limits?.max_run_minutes ?? 45);
')"
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[[ -n "$TIMEOUT_BIN" ]] && RUN_CAP="$TIMEOUT_BIN -k 30s ${MAX_MIN}m" || RUN_CAP=""
[[ -z "$TIMEOUT_BIN" ]] && echo "  ! no timeout(1) on PATH — a wedged run will not be capped"

if [[ -z "$BUDGET" ]]; then
  BUDGET="$(cd "$ROOT" && bun -e '
    const p = Bun.YAML.parse(await Bun.file("config/policy.yaml").text());
    const key = process.argv[1] === "factory-merge" ? "merge_usd" : "per_ticket_usd";
    console.log(p?.budget?.[key] ?? p?.budget?.per_ticket_usd ?? 15);
  ' "$COMMAND")"
fi

PROMPT="/${COMMAND}${ARGS:+ $ARGS}"

# Left empty, each command's own frontmatter decides its model (triage/audit
# sonnet, merge opus, work sonnet orchestrating opus subagents). --model
# overrides the whole session — the blunt instrument; prefer the frontmatter.
MODEL_ARGS=""
if [[ -n "$MODEL" ]]; then
  MODEL_ARGS="--model $MODEL"
fi

# Read-only stages run in the MAIN checkout — triage needs the code to write
# file pointers but has no business changing it, and that checkout routinely
# holds the human's uncommitted work. Bash stays available (exploration needs
# it), so this raises the bar rather than sealing it.
READONLY_ARGS=""
if [[ "$READONLY" == "1" ]]; then
  if [[ "$HARNESS" == "claude" ]]; then
    READONLY_ARGS="--disallowedTools Edit Write NotebookEdit"
  elif [[ "$HARNESS" == "pi" ]]; then
    READONLY_ARGS="-r"
  elif [[ "$HARNESS" == "codex" ]]; then
    READONLY_ARGS="-s read-only"
  else
    # Don't let --read-only look enforced when it isn't. agy has no
    # per-tool deny list; --sandbox restricts the terminal but would also break
    # the exploration triage depends on. So the guard here is the prompt plus
    # the fact that the stage has no reason to write — say so out loud rather
    # than implying a restriction that does not exist.
    echo "  ! --read-only is not enforceable on $HARNESS (no per-tool deny list) — relying on the command's instructions"
  fi
fi

# All LLM API keys are unset by default so agents run under subscription/login auth:
# runs draw on subscription allowances instead of API per-token billing.
UNSET_KEYS=("-u" "ANTHROPIC_API_KEY" "-u" "GEMINI_API_KEY" "-u" "GOOGLE_API_KEY" "-u" "GOOGLE_GENAI_API_KEY" "-u" "OPENAI_API_KEY" "-u" "MISTRAL_API_KEY" "-u" "DEEPSEEK_API_KEY" "-u" "GROQ_API_KEY")

# Stages run inside a repo, not inside this checkout, so `bun tools/linear.mjs`
# does not resolve for them. The floor tells agents to use
# "$FACTORY_ROOT/tools/linear.mjs"; this is what makes that path real. Without
# it, --strict-mcp-config removes the Linear MCP and leaves no replacement.
export FACTORY_ROOT="$ROOT"

if [[ "$USE_API" == "1" ]]; then
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] || { echo "--use-api given but ANTHROPIC_API_KEY is not set" >&2; exit 2; }
  AUTH_NOTE="ANTHROPIC_API_KEY (billed per token; connectors disabled)"
  ENV_PREFIX="env"
else
  ENV_PREFIX="env ${UNSET_KEYS[*]}"
  AUTH_NOTE="subscription"
fi

if [[ "$DRY" == "1" ]]; then
  # Must mirror the real invocation below. A --dry that omits flags is worse
  # than no --dry: it is the thing people check before trusting a run.
  MCP_NOTE=""
  [[ "$HARNESS" == "claude" ]] && MCP_NOTE="--mcp-config $ROOT/config/mcp/claude.json --strict-mcp-config"
  echo "would run in $REPO_PATH:"
  echo "  $HARNESS -p '$PROMPT' --max-budget-usd $BUDGET $MCP_NOTE $MODEL_ARGS $READONLY_ARGS"
  echo "  auth: $AUTH_NOTE   FACTORY_ROOT=$ROOT"
  [[ -n "$MCP_NOTE" ]] && echo "  mcp:  strict — only servers declared in config/mcp/claude.json (no claude.ai connectors)"
  exit 0
fi

if [[ "$HARNESS" == "pi" ]]; then
  command -v pi >/dev/null || command -v npx >/dev/null || { echo "neither pi nor npx CLI on PATH" >&2; exit 127; }
else
  command -v "$HARNESS" >/dev/null || { echo "$HARNESS CLI not on PATH" >&2; exit 127; }
fi

LOG_DIR="$HOME/.factory/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/${REPO}-${COMMAND}-$(date +%Y%m%d-%H%M%S).jsonl"

echo "→ $REPO ($REPO_TEAM)  $PROMPT"
echo "  cwd:    $REPO_PATH"
echo "  harness: $HARNESS   auth: $AUTH_NOTE   cap ~\$$BUDGET notional / ${MAX_MIN}m wall"

# Read-only stages (triage) read the MAIN CHECKOUT, so a stale one produces
# specs against code that moved. Dispatch does not care: worktree-up.sh fetches
# and branches from origin/<base>, so ticket work always starts current.
#
# Policy: always fetch. Fast-forward only when the tree is CLEAN — --ff-only
# cannot create a merge commit or lose work, so it is safe to do unattended.
# When the tree is dirty, do nothing and say so: the main checkout routinely
# holds uncommitted human work, and touching it to save a slightly stale spec is
# a far worse trade.
(
  cd "$REPO_PATH"
  git fetch --quiet 2>/dev/null || true
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  BEHIND="$(git rev-list --count "HEAD..@{upstream}" 2>/dev/null || echo 0)"
  DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

  if [[ "$BEHIND" != "0" && "$DIRTY" == "0" ]]; then
    if git pull --ff-only --quiet 2>/dev/null; then
      echo "  branch: $BRANCH  fast-forwarded $BEHIND commit(s) — now current"
      BEHIND=0
    else
      echo "  branch: $BRANCH  behind: $BEHIND  ! fast-forward refused (diverged) — fix by hand"
    fi
  else
    echo "  branch: $BRANCH  behind: $BEHIND  uncommitted: $DIRTY"
  fi

  [[ "$BEHIND" != "0" && "$DIRTY" != "0" ]] && \
    echo "  ! $DIRTY uncommitted file(s) — not pulling, they would be clobbered; specs may reference moved code"
  true
)
echo

# A session launched from inside a Claude Code session inherits these and the
# child exits 1 with no useful message.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

# stream-json / json output format. report.mjs renders each step live and
# still parses the final envelope for the exit code.
set +e
if [[ "$HARNESS" == "claude" ]]; then
  # --strict-mcp-config makes config/mcp/claude.json the ONLY source of MCP
  # servers: no user scope, no project .mcp.json, no claude.ai connectors. What
  # an unattended agent can reach is now declared in git and moves by PR.
  #
  # That deliberately drops the Linear MCP too — tools/linear.mjs replaces it,
  # which is why FACTORY_ROOT above is load-bearing rather than a convenience.
  # It also drops what nobody chose to grant: sessions were loading a client law
  # firm's connector (51 tools) and Gmail (16) into agents running unattended
  # under bypassPermissions.
  (
    cd "$REPO_PATH"
    $RUN_CAP $ENV_PREFIX claude -p "$PROMPT" \
      --output-format stream-json --verbose \
      --max-budget-usd "$BUDGET" \
      --fallback-model sonnet \
      --mcp-config "$ROOT/config/mcp/claude.json" --strict-mcp-config \
      $MODEL_ARGS $READONLY_ARGS
  ) 2>&1 | (cd "$ROOT" && bun runners/report.mjs --log "$LOG" --harness claude)
else
  # Other harnesses do not read .claude/commands, so the slash command would
  # not resolve. Pass the command BODY as the prompt instead — it is plain
  # markdown, which is why the content was made harness-neutral in the first
  # place.
  BODY="$(cd "$ROOT" && FACTORY_CMD="$COMMAND" FACTORY_ARGS="$ARGS" bun -e '
    const f = `shared/commands/${process.env.FACTORY_CMD}.md`;
    let t = await Bun.file(f).text();
    t = t.replace(/^---\n[\s\S]*?\n---\n/, "");            // drop frontmatter
    t = t.replaceAll("$ARGUMENTS", process.env.FACTORY_ARGS ?? "");
    console.log(t);
  ')"

  if [[ "$HARNESS" == "codex" ]]; then
    (
      cd "$REPO_PATH"
      printf "%s\n" "$BODY" | $RUN_CAP $ENV_PREFIX codex exec --json \
        --dangerously-bypass-approvals-and-sandbox \
        -C "$REPO_PATH" \
        $MODEL_ARGS $READONLY_ARGS \
        -
    ) 2>&1 | (cd "$ROOT" && bun runners/report.mjs --log "$LOG" --harness codex)
  elif [[ "$HARNESS" == "pi" ]]; then
    PI_BIN="pi"
    command -v pi >/dev/null || PI_BIN="npx pi"
    (
      cd "$REPO_PATH"
      printf "%s\n" "$BODY" | $RUN_CAP $ENV_PREFIX $PI_BIN -p \
        --mode json \
        $MODEL_ARGS $READONLY_ARGS
    ) 2>&1 | (cd "$ROOT" && bun runners/report.mjs --log "$LOG" --harness pi)
  else
    (
      cd "$REPO_PATH"
      printf "%s\n" "$BODY" | $RUN_CAP $ENV_PREFIX "$HARNESS" -p - \
        --output-format stream-json \
        --dangerously-skip-permissions \
        --add-dir "$REPO_PATH" \
        --print-timeout "$(( MAX_MIN - 2 ))m" \
        $MODEL_ARGS
    ) 2>&1 | (cd "$ROOT" && bun runners/report.mjs --log "$LOG" --harness "$HARNESS")
  fi
fi
STATUS=${PIPESTATUS[1]}
set -e

exit "$STATUS"
