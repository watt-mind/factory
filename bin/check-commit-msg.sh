#!/usr/bin/env bash
# WM-609: lefthook commit-msg hook.
#
# Enforces `type(scope): summary (ISSUE-ID)` conventional-commit format
# locally, matching AGENTS.md / linear.md §6. Dependency-free bash regex —
# no node_modules, <50ms — per the tier-4 hook rule in
# docs/guides/code-security.md §4 (heavier checks belong in CI, not here).
set -euo pipefail

msg_file="${1:?usage: check-commit-msg.sh <path-to-COMMIT_EDITMSG>}"

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
  example:  fix(scope): correct off-by-one in scheduler (WM-123)
  got:      ${subject}

  allowed types: feat fix chore docs test refactor perf ci build style revert sec maint ui ui-ux spike epic
EOF
  exit 1
fi

ticket_re='\((WM|OPS|CLNT|CW|LAB)-[0-9]+\)'
if ! [[ "$subject" =~ $ticket_re ]]; then
  if [[ "${FACTORY_NO_TICKET:-}" == "1" ]]; then
    echo "commit-msg: warning: no ticket ref like (WM-123) in subject — allowed because FACTORY_NO_TICKET=1" >&2
    exit 0
  fi
  cat >&2 <<EOF
commit-msg: subject is missing a ticket reference.

  fix: append " (WM-123)" to the subject, or export FACTORY_NO_TICKET=1 for a deliberate no-ticket commit
  got: ${subject}
EOF
  exit 1
fi

exit 0
