#!/usr/bin/env bash
# Compute CI_LOAD_FACTOR on shared self-hosted runners from runnable tasks and
# active Runner.Worker processes, clamped to [1.00, 4.00], and export it via
# GITHUB_ENV.
set -euo pipefail

cpu_count="$(nproc)"
runner_jobs="$(pgrep -fc 'Runner\.Worker' || true)"
read -r _ _ _ runnable _ < /proc/loadavg
runnable="${runnable%%/*}"
runner_jobs="${runner_jobs:-1}"
pressure="$runner_jobs"
if [ "$runnable" -gt "$pressure" ]; then
  pressure="$runnable"
fi
load_factor="$(awk -v pressure="$pressure" -v cpu_count="$cpu_count" '
  BEGIN {
    load_factor = 1 + pressure / cpu_count
    if (load_factor > 4) load_factor = 4
    printf "%.2f", load_factor
  }
')"
echo "CI_LOAD_FACTOR=$load_factor" >> "$GITHUB_ENV"
echo "Spawn-test load factor: $load_factor ($pressure runnable/jobs across $cpu_count CPUs)."
