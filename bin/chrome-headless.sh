#!/usr/bin/env bash
# Headless Chromium launcher for the factory's browser tooling (WM-670).
#
# The UX critic drives the app through pi's chrome-devtools extension
# (@narumitw/pi-chrome-devtools). That extension auto-launches whatever it
# finds as `google-chrome` with a fixed argument list that has NO --headless
# flag. On a display-less Linux runner Chrome then dies at startup —
#
#   ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc Missing X server or $DISPLAY
#   ERROR:ui/aura/env.cc The platform failed to initialize.  Exiting.
#
# — and the critic reports "Auto-launched browser exited before DevTools became
# available" → NOT-ASSESSED on every web PR. The extension cannot be told to add
# flags, but it can be pointed at an executable (`browser.executablePath` in
# ~/.pi/agent/pi-chrome-devtools.json, or PI_CHROME_DEVTOOLS_BROWSER). This is
# that executable: it finds a Chromium-family binary and execs it headless with
# the flags a non-root user on a container-ish Linux host needs, passing every
# argument the caller supplied (remote-debugging port, user-data-dir, URL, ...)
# straight through. `exec` keeps Chrome as the caller's direct child, so the
# extension's exit watchdog and shutdown still see the real process.
#
#   bin/chrome-headless.sh --remote-debugging-port=0 --user-data-dir=/tmp/x about:blank
#
# CHROME_BIN overrides discovery. `orchestrator/doctor.mjs` runs this same
# script to prove the browser launches before the loop depends on it.
set -euo pipefail

resolve_chrome() {
  # CHROME_BIN, when set, is the only candidate — even if empty. Tests starve
  # discovery by exporting CHROME_BIN= so a macOS host with Chrome in
  # /Applications cannot be exec'd by a "no browser installed" case. Unset
  # keeps the previous PATH + app-bundle search. `${VAR+set}` is bash 3.2-safe
  # (/bin/bash on macOS); `[[ -v ]]` is not.
  if [ "${CHROME_BIN+set}" = "set" ]; then
    if [ -z "$CHROME_BIN" ]; then
      return 1
    fi
    printf '%s\n' "$CHROME_BIN"
    return 0
  fi
  local name
  for name in google-chrome google-chrome-stable chromium chromium-browser chrome; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return 0
    fi
  done
  local mac
  for mac in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if [[ -x "$mac" ]]; then
      printf '%s\n' "$mac"
      return 0
    fi
  done
  return 1
}

if ! chrome="$(resolve_chrome)"; then
  echo "chrome-headless.sh: no Chromium-family browser found (tried CHROME_BIN, google-chrome, google-chrome-stable, chromium, chromium-browser, chrome)" >&2
  exit 127
fi

exec "$chrome" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-crash-reporter \
  --disable-background-networking \
  --hide-crash-restore-bubble \
  "$@"
