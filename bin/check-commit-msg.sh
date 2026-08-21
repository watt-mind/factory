#!/usr/bin/env bash
# WM-609: lefthook commit-msg hook.
#
# Enforces `type(scope): summary (ISSUE-ID)` conventional-commit format
# locally, matching AGENTS.md / linear.md §6. Dependency-free bash regex —
# no node_modules, <50ms — per the tier-4 hook rule in
# docs/guides/code-security.md §4 (heavier checks belong in CI, not here).
#
# WM-1011: the accepted ticket-reference shapes are configuration, not a
# literal. Two reasons, both about this repo going public:
#
#   1. The old pattern enumerated one workspace's tracker prefixes. An outside
#      contributor working a GitHub issue has none of them, so their only way
#      past the hook was FACTORY_NO_TICKET=1 — which trains everyone to bypass
#      the check that exists to stop untracked commits.
#   2. Those prefixes named internal team structure, including a client-facing
#      one. A public script should not carry them, in code or in comments.
#
# The default accepts both `(ABC-123)` (any 2-5 letter tracker prefix, so no
# specific workspace is named) and `(#123)` (GitHub issue form). Both at once
# is deliberate: the WM-1006 cutover has a window where historical WM-* refs
# and new #123 refs are both valid, and neither should need a hook edit.
set -euo pipefail

msg_file="${1:?usage: check-commit-msg.sh <path-to-COMMIT_EDITMSG>}"

# Built-in default. Used verbatim in a fresh clone: config/policy.yaml is
# gitignored, so the hook must work with no local config at all.
DEFAULT_TICKET_PATTERNS=('\([A-Z]{2,5}-[0-9]+\)' '\(#[0-9]+\)')

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_file="${FACTORY_COMMIT_MSG_CONFIG:-${script_dir}/../config/policy.yaml}"

# Read commitMsg.ticketPatterns out of policy.yaml. awk is POSIX and always
# present; "dependency-free" here means no node_modules and no install step,
# not no coreutils. \047 is a single quote — spelled in octal so this stays a
# single-quoted awk program with no shell quoting gymnastics.
configured_patterns() {
  [[ -r "$policy_file" ]] || return 0
  awk '
    /^[[:space:]]*#/ { next }
    /^commitMsg:[[:space:]]*$/ { in_cm = 1; next }
    in_cm && /^[^[:space:]#]/ { in_cm = 0; in_tp = 0 }
    in_cm && /^[[:space:]]+ticketPatterns:[[:space:]]*$/ { in_tp = 1; next }
    in_tp && /^[[:space:]]*-[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]*/, "", line)
      sub(/[[:space:]]+#.*$/, "", line)
      gsub(/^["\047]+|["\047]+$/, "", line)
      if (length(line)) print line
      next
    }
    in_tp && /^[[:space:]]*[^[:space:]-]/ { in_tp = 0 }
  ' "$policy_file" 2>/dev/null || true
}

ticket_patterns=()
while IFS= read -r pattern; do
  [[ -n "$pattern" ]] && ticket_patterns+=("$pattern")
done < <(configured_patterns)
# An unreadable or stanza-less policy.yaml means "no opinion", not "accept
# nothing" — a config typo must not lock every commit out of the repo.
if [[ ${#ticket_patterns[@]} -eq 0 ]]; then
  ticket_patterns=("${DEFAULT_TICKET_PATTERNS[@]}")
fi

# Combine into one alternation, and build the human-readable list the error
# messages show, so the message never drifts from what is enforced.
ticket_re=""
for pattern in "${ticket_patterns[@]}"; do
  ticket_re+="${ticket_re:+|}(${pattern})"
done
accepted_display="$(
  printf '%s\n' "${ticket_patterns[@]}" |
    sed -e 's/\\(/(/g' -e 's/\\)/)/g' \
      -e 's/\[A-Z\]{2,5}/ABC/' -e 's/\[0-9\]+/123/g' |
    paste -sd' ' -
)"

# The subject is the first line that isn't a `#`-prefixed comment (git
# strips these itself before the commit lands, but the hook sees the raw
# COMMIT_EDITMSG file, comments and all).
subject=""
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
  \#*) continue ;;
  esac
  subject="$line"
  break
done <"$msg_file"

# Commits that are never held to the conventional-commit format: merges,
# reverts, in-progress fixup/squash commits, and Dependabot's own commits
# (message or author).
case "$subject" in
Merge* | Revert* | fixup!* | squash!* | "build(deps"*)
  exit 0
  ;;
esac
if [[ "${GIT_AUTHOR_NAME:-}" == *dependabot* || "${GIT_AUTHOR_EMAIL:-}" == *dependabot* ]]; then
  exit 0
fi

type_re='^(feat|fix|chore|docs|test|refactor|perf|ci|build|style|revert|sec|maint|ui|ui-ux|spike|epic)(\([a-z0-9._/-]+\))?!?: .+'
if ! [[ "$subject" =~ $type_re ]]; then
  cat >&2 <<EOF
commit-msg: subject does not match conventional commit format.

  expected: type(scope): summary (ISSUE-ID)
  example:  fix(scope): correct off-by-one in scheduler (ABC-123)
  got:      ${subject}

  allowed types: feat fix chore docs test refactor perf ci build style revert sec maint ui ui-ux spike epic
EOF
  exit 1
fi

if ! [[ "$subject" =~ $ticket_re ]]; then
  if [[ "${FACTORY_NO_TICKET:-}" == "1" ]]; then
    echo "commit-msg: warning: no ticket ref in subject — allowed because FACTORY_NO_TICKET=1" >&2
    exit 0
  fi
  cat >&2 <<EOF
commit-msg: subject is missing a ticket reference.

  accepted: ${accepted_display}
  fix: append a ticket reference to the subject, or export FACTORY_NO_TICKET=1 for a deliberate no-ticket commit
  got: ${subject}
EOF
  exit 1
fi

exit 0
