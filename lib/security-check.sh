#!/usr/bin/env bash
# Local security harness (OPS-165) — invoked as `factory security`.
#
# Runs Gitleaks, Semgrep, and Actionlint against a repo before pushing.
# Fast local complement to the CI security scan
# (see hdkiller docs/guides/code-security.md).
#
# Usage:
#   factory security [options] [path]
#
# Options:
#   --history        Gitleaks scans full git history instead of the working tree (slow)
#   --skip-semgrep   Skip the Semgrep scan (the slowest tool)
#   -h, --help       Show this help
#
# Runs from any git repo/worktree; [path] defaults to the repo containing $PWD.
#
# Per-repo tuning comes from config/repos.yaml `security:` blocks — the factory
# dispatcher resolves the repo and exports SEMGREP_ARGS / GITLEAKS_ARGS before
# exec'ing this script (tools/security-env.mjs). A repo-root `.gitleaks.toml`
# is picked up by gitleaks automatically and is the right home for allowlists,
# because CI and the pre-commit hook need it too.
set -uo pipefail

HISTORY=0
SKIP_SEMGREP=0
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --history) HISTORY=1 ;;
    --skip-semgrep) SKIP_SEMGREP=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

if [ -n "$TARGET" ]; then
  ROOT=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null)
else
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
fi
if [ -z "${ROOT:-}" ]; then
  echo "error: not inside a git repository (or path is not one)" >&2
  exit 2
fi

BOLD=$(tput bold 2>/dev/null || true); RESET=$(tput sgr0 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true); RED=$(tput setaf 1 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true)

echo "${BOLD}factory security${RESET} → $ROOT"
[ -n "${SEMGREP_ARGS:-}${GITLEAKS_ARGS:-}" ] && echo "  (repo config from config/repos.yaml)"

RESULTS=()
FAILED=0

run_tool() {
  local name="$1"; shift
  if ! command -v "$1" >/dev/null 2>&1; then
    echo; echo "${YELLOW}● $name: SKIPPED (not installed — brew install $1)${RESET}"
    RESULTS+=("${YELLOW}SKIP${RESET}  $name (not installed)")
    return
  fi
  echo; echo "${BOLD}● $name${RESET}"
  local start=$SECONDS
  if "$@"; then
    RESULTS+=("${GREEN}PASS${RESET}  $name ($((SECONDS - start))s)")
  else
    RESULTS+=("${RED}FAIL${RESET}  $name ($((SECONDS - start))s)")
    FAILED=1
  fi
}

# 1. Gitleaks — secrets in the working tree (or full history with --history)
# shellcheck disable=SC2086
if [ "$HISTORY" = 1 ]; then
  run_tool "gitleaks (git history)" gitleaks git "$ROOT" --no-banner --redact ${GITLEAKS_ARGS:-}
else
  run_tool "gitleaks (working tree)" gitleaks dir "$ROOT" --no-banner --redact ${GITLEAKS_ARGS:-}
fi

# 2. Semgrep — SAST, security ruleset only (respects .gitignore)
if [ "$SKIP_SEMGREP" = 1 ]; then
  RESULTS+=("${YELLOW}SKIP${RESET}  semgrep (--skip-semgrep)")
else
  # shellcheck disable=SC2086
  run_tool "semgrep (p/security-audit)" semgrep scan --config p/security-audit \
    --metrics=off --quiet --error ${SEMGREP_ARGS:-} "$ROOT"
fi

# 3. Actionlint — only when the repo has GitHub workflows
if [ -d "$ROOT/.github/workflows" ]; then
  cd "$ROOT" && run_tool "actionlint" actionlint -color
else
  RESULTS+=("${YELLOW}SKIP${RESET}  actionlint (no .github/workflows)")
fi

echo; echo "${BOLD}Summary${RESET}"
for r in "${RESULTS[@]}"; do echo "  $r"; done

if [ "$FAILED" = 1 ]; then
  echo; echo "${RED}${BOLD}Security check FAILED${RESET} — fix findings before pushing."
  exit 1
fi
echo; echo "${GREEN}${BOLD}Security check passed.${RESET}"
