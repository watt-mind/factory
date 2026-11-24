#!/usr/bin/env bash
set -euo pipefail
# Invoke locked_bun_install without constructing a bash -c command string.
source "$(dirname "${BASH_SOURCE[0]}")/worktree-common.sh"
locked_bun_install "$1"
