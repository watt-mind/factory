/**
 * bin/live-stack.sh — `factory up --dev` wiring and the dev worker supervisor
 * (WM-213).
 *
 * The point of these tests is the *shape of the commands* the script spawns and
 * the supervisor's restart rule, so they run against a throwaway repo whose
 * worktree-common.sh records spawns instead of starting daemons. Booting three
 * real processes would test bun and vite, not this script.
 */
import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LIVE_STACK = path.resolve(import.meta.dir, "live-stack.sh");

/**
 * worktree-common.sh replaced by recorders: no daemon is ever started.
 *
 * `pid_alive` is false by default (so `up` always spawns) and consults real
 * pidfiles only under FAKE_ALIVE=1, which is what the pool-drain path in `down`
 * needs to exercise. A terminated daemon stops being alive, modelling a process
 * that honours SIGTERM — unless FAKE_IGNORES_TERM=1, the case whose whole point
 * is that `down` gives up on a schedule instead of hanging.
 */
const COMMON_STUB = `#!/usr/bin/env bash
repo_root() { printf '%s' "$FAKE_REPO"; }
info() {
  printf '==> %s\\n' "$*"
  # A command failing *inside* a helper body under set -e (not a non-zero
  # return to the caller): the shell aborts here, and the ERR trap must still
  # run cleanup. The line after the failure is never reached.
  if [[ -n "\${FAKE_INFO_FAIL_ON:-}" && "$*" == "\${FAKE_INFO_FAIL_ON}"* ]]; then
    false
    printf 'unreachable under set -e\\n' >&2
  fi
}
warn() { printf 'warn: %s\\n' "$*" >&2; }
die() { printf 'error: %s\\n' "$*" >&2; exit 1; }
pid_alive() {
  if [[ "\${FAKE_WEB_SUPERVISOR:-0}" == "1" ]]; then
    [[ "$(basename "$1")" == "serve.pid" ]]
    return
  fi
  if [[ "\${FAKE_SERVE_DIES:-0}" == "1" && "$(basename "$1")" == "serve.pid" && -f "$1" ]]; then
    return 1
  fi
  if [[ "$(basename "$1")" == "serve.pid" && -f "$1" ]]; then
    return 0
  fi
  if [[ "$(basename "$1")" == "worker.pid" || "$(basename "$1")" == "supervisor.pid" ]]; then
    [[ -f "$1" ]] || return 1
    [[ -f "$1.terminated" || -f "$1.exited" ]] && return 1
    return 0
  fi
  if [[ "$(basename "$1")" == "gh-app-auth.pid" && -f "$1.fake" ]]; then
    [[ -f "$1.terminated" || -f "$1.exited" ]] && return 1
    return 0
  fi
  [[ "\${FAKE_ALIVE:-0}" == "1" ]] || return 1
  [[ -f "$1" ]] || return 1
  [[ -f "$1.terminated" ]] && return 1
  return 0
}
spawn_daemon() { # <pidfile> <logfile> <workdir> <cmd...>
  local pidfile="$1" logfile="$2" workdir="$3"
  shift 3
  printf 'SPAWN pid=%s workdir=%s cmd=%s\\n' "$(basename "$pidfile")" "$workdir" "$*" >>"$SPAWN_LOG"
  if [[ "$(basename "$pidfile")" == "\${FAKE_SPAWN_FAIL_PIDFILE:-}" ]]; then return 1; fi
  printf '1\\n' >"$pidfile"
  if [[ "$(basename "$pidfile")" == "gh-app-auth.pid" ]]; then
    touch "$pidfile.fake"
    printf '1\\n' >"\${FACTORY_GH_APP_TOKEN_FILE}.lock"
  fi
  if [[ -n "\${FAKE_DAEMON_DIES_FOR:-}" && "$*" == *"\${FAKE_DAEMON_DIES_FOR}"* ]]; then
    printf 'fake daemon exited 1\\n' >"$logfile"
    touch "$pidfile.exited"
  fi
  if [[ "\${FAKE_SUPERVISOR_MISSING:-0}" != "1" && "$*" == *"cli.mjs supervise"* ]]; then
    printf '2\\n' >"$(dirname "$pidfile")/supervisor.pid"
    if [[ "\${FAKE_POOL_CHILDREN:-0}" == "1" ]]; then
      printf '3\\n' >"$(dirname "$pidfile")/worker-1.pid"
      printf 'worker_test\\n' >"$(dirname "$pidfile")/worker-1.id"
    fi
  fi
}
term_daemon() {
  printf 'TERM %s\\n' "$2" >>"$SPAWN_LOG"
  [[ "\${FAKE_IGNORES_TERM:-0}" == "1" ]] || touch "$1.terminated"
}
await_daemon() { printf 'AWAIT %s\\n' "$2" >>"$SPAWN_LOG"; }
rotate_run_logs() {
  if [[ -n "\${FAKE_ROTATION_LOG:-}" ]]; then
    printf 'ROTATE bytes=%s keep=%s\\n' "$2" "$3" >>"$FAKE_ROTATION_LOG"
  fi
}
run_log_total_bytes() { printf '%s' "\${FAKE_LOG_BYTES:-0}"; }
`;

/**
 * A fake event-runtime CLI for the supervisor tests. Counts its invocations and
 * exits 75 for the first FAKE_WORKER_RELOADS of them, then FAKE_WORKER_FINAL.
 * `wait-term` instead stays up until signalled, then exits 75 — the case that
 * proves a reload code arriving *after* a SIGTERM does not restart anything.
 */
const FAKE_CLI = `import { readFileSync, writeFileSync } from "node:fs";
const counter = process.env.FAKE_WORKER_COUNTER;
const n = Number(readFileSync(counter, "utf8").trim() || "0") + 1;
writeFileSync(counter, String(n));
console.log(\`fake worker start #\${n} args=\${process.argv.slice(2).join(" ")}\`);
if (process.env.FAKE_WORKER_MODE === "wait-term") {
  process.on("SIGTERM", () => { console.log("fake worker got SIGTERM"); process.exit(75); });
  setInterval(() => {}, 1000);
} else {
  process.exit(n <= Number(process.env.FAKE_WORKER_RELOADS ?? 0)
    ? 75
    : Number(process.env.FAKE_WORKER_FINAL ?? 0));
}
`;

function makeFixture({
  withWebDeps = true,
  policy = null,
  bundle = "fresh",
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "live-stack-"));
  const webDir = path.join(root, "event-runtime", "web");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(webDir, "src"), { recursive: true });
  mkdirSync(path.join(root, "stubs"), { recursive: true });
  if (policy !== null) {
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "config", "policy.yaml"), policy, "utf8");
  }
  copyFileSync(LIVE_STACK, path.join(root, "bin", "live-stack.sh"));
  writeFileSync(
    path.join(root, "bin", "worktree-common.sh"),
    COMMON_STUB,
    "utf8",
  );
  writeFileSync(path.join(root, "event-runtime", "cli.mjs"), FAKE_CLI, "utf8");
  writeFileSync(path.join(webDir, "serve.mjs"), "", "utf8");
  for (const relative of [
    "src/App.tsx",
    "index.html",
    "vite.config.ts",
    "package.json",
  ]) {
    writeFileSync(path.join(webDir, relative), `${relative}\n`, "utf8");
  }
  if (bundle !== "missing") {
    mkdirSync(path.join(webDir, "dist"), { recursive: true });
    writeFileSync(path.join(webDir, "dist", "index.html"), "built\n", "utf8");
    const sourceTime = new Date("2026-01-01T00:00:00Z");
    const distTime = new Date("2027-01-01T00:00:00Z");
    for (const relative of [
      "src/App.tsx",
      "index.html",
      "vite.config.ts",
      "package.json",
    ]) {
      utimesSync(path.join(webDir, relative), sourceTime, sourceTime);
    }
    utimesSync(path.join(webDir, "dist", "index.html"), distTime, distTime);
    if (bundle === "stale") {
      const staleTime = new Date("2028-01-01T00:00:00Z");
      utimesSync(path.join(webDir, "src", "App.tsx"), staleTime, staleTime);
    }
  }
  if (withWebDeps)
    mkdirSync(path.join(webDir, "node_modules"), { recursive: true });

  // The health polls must not gate a test on a server nobody started.
  const curl = path.join(root, "stubs", "curl");
  writeFileSync(
    curl,
    `#!/bin/sh
if [ -n "\${FAKE_CURL_COUNT_FILE:-}" ]; then
  calls=0
  [ -f "$FAKE_CURL_COUNT_FILE" ] && calls=$(cat "$FAKE_CURL_COUNT_FILE")
  calls=$((calls + 1))
  printf '%s' "$calls" >"$FAKE_CURL_COUNT_FILE"
  if [ "$calls" -le "\${FAKE_CURL_SUCCEED_AFTER:-0}" ]; then exit 1; fi
fi
if [ "\${FAKE_CURL_SIGNAL_PARENT:-0}" = "1" ] && [ ! -e "\${FAKE_CURL_SIGNAL_MARKER:-}" ]; then
  case "$*" in
    *":7381/health"*) : >"$FAKE_CURL_SIGNAL_MARKER"; kill -INT "$PPID" ;;
  esac
fi
if [ -n "\${FAKE_CURL_FAIL_URL:-}" ]; then
  case "$*" in *"$FAKE_CURL_FAIL_URL"*) exit 1 ;; esac
fi
if [ -n "\${FAKE_CURL_STALL:-}" ]; then
  case "$*" in *"/health"*) /bin/sleep "$FAKE_CURL_STALL"; exit 1 ;; esac
fi
exit "\${FAKE_CURL_STATUS:-0}"
`,
    "utf8",
  );
  chmodSync(curl, 0o755);

  const sleep = path.join(root, "stubs", "sleep");
  writeFileSync(
    sleep,
    `#!/bin/sh
if [ "\${FAKE_FAST_SLEEP:-0}" = "1" ]; then exit 0; fi
exec /bin/sleep "$@"
`,
    "utf8",
  );
  chmodSync(sleep, 0o755);

  // Non-dev web builds are recorded and materialize the one artifact the
  // script checks. Other bun commands are only arguments to spawn_daemon.
  const bun = path.join(root, "stubs", "bun");
  writeFileSync(
    bun,
    `#!/bin/sh
if [ "$1 $2" = "run build" ]; then
  printf 'BUILD cwd=%s cmd=%s\\n' "$PWD" "$*" >>"$BUILD_LOG"
  mkdir -p "$FAKE_REPO/event-runtime/web/dist"
  : >"$FAKE_REPO/event-runtime/web/dist/index.html"
  exit 0
fi
printf 'unexpected bun invocation: %s\\n' "$*" >&2
exit 99
`,
    "utf8",
  );
  chmodSync(bun, 0o755);

  return {
    root,
    runDir: path.join(root, "run"),
    spawnLog: path.join(root, "spawns.log"),
    buildLog: path.join(root, "builds.log"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runStack(fixture, args, extraEnv = {}) {
  const noCurlBin = path.join(fixture.root, "no-curl-bin");
  if (extraEnv.FAKE_PATH_WITHOUT_CURL === "1") {
    mkdirSync(noCurlBin, { recursive: true });
    for (const command of [
      "bash",
      "basename",
      "cat",
      "date",
      "dirname",
      "find",
      "grep",
      "mkdir",
      "ps",
      "rm",
      "sort",
      "tr",
    ]) {
      const source = Bun.spawnSync({
        cmd: ["sh", "-c", `command -v ${command}`],
      })
        .stdout.toString()
        .trim();
      copyFileSync(source, path.join(noCurlBin, command));
      chmodSync(path.join(noCurlBin, command), 0o755);
    }
  }
  const result = Bun.spawnSync({
    cmd: ["bash", path.join(fixture.root, "bin", "live-stack.sh"), ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH:
        extraEnv.FAKE_PATH_WITHOUT_CURL === "1"
          ? noCurlBin
          : `${path.join(fixture.root, "stubs")}:${process.env.PATH}`,
      FAKE_REPO: fixture.root,
      SPAWN_LOG: fixture.spawnLog,
      BUILD_LOG: fixture.buildLog,
      FACTORY_RUN_DIR: path.join(fixture.root, "run"),
      FACTORY_EVENT_HOME: path.join(fixture.root, "home"),
      FACTORY_GH_APP_TOKEN_FILE: path.join(fixture.root, "gh-app-token.json"),
      // Startup survival is covered by focused cases below. Keep unrelated
      // command-wiring tests immediate instead of paying the production 5s.
      FACTORY_WORKER_READY_TIMEOUT: "0",
      ...extraEnv,
    },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    spawns: existsSync(fixture.spawnLog)
      ? readFileSync(fixture.spawnLog, "utf8").trim().split("\n")
      : [],
    builds: existsSync(fixture.buildLog)
      ? readFileSync(fixture.buildLog, "utf8").trim().split("\n")
      : [],
  };
}

const spawnFor = (spawns, pidfile) =>
  spawns.find((line) => line.includes(`pid=${pidfile}`)) ?? "";

async function startLockOwningGhAppProcess(
  fixture,
  daemonArgument = "--daemon",
) {
  const script = path.join(
    fixture.root,
    "lib",
    "control-plane",
    "gh-app-auth.mjs",
  );
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, "setInterval(() => {}, 60_000);\n", "utf8");
  const child = Bun.spawn({
    cmd: [process.execPath, script, daemonArgument],
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const command = Bun.spawnSync({
      cmd: ["ps", "-p", String(child.pid), "-o", "command="],
      stdout: "pipe",
      stderr: "ignore",
    }).stdout.toString();
    if (command.trim().endsWith(`${script} ${daemonArgument}`)) {
      writeFileSync(
        path.join(fixture.root, "gh-app-token.json.lock"),
        `${child.pid}\n`,
      );
      return child;
    }
    await Bun.sleep(5);
  }
  child.kill();
  await child.exited;
  throw new Error(`fake gh-app-auth process ${child.pid} did not start`);
}

async function stopProcess(child) {
  try {
    child.kill();
  } catch {
    // Already exited.
  }
  await child.exited;
}

test("`up` adopts a lock-owning GitHub App daemon when its pidfile is missing", async () => {
  const f = makeFixture();
  const daemon = await startLockOwningGhAppProcess(f);
  try {
    const r = runStack(f, ["up"], {
      FACTORY_GH_APP_ID: "test-app",
      FACTORY_GH_APP_PRIVATE_KEY_PATH: "/tmp/test-key",
      FACTORY_HOME: f.root,
      FACTORY_ROOT: f.root,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `GitHub App token daemon already running (adopted pid ${daemon.pid})`,
    );
    expect(readFileSync(path.join(f.runDir, "gh-app-auth.pid"), "utf8")).toBe(
      `${daemon.pid}\n`,
    );
    expect(spawnFor(r.spawns, "gh-app-auth.pid")).toBe("");

    const down = runStack(f, ["down"], { FAKE_ALIVE: "1" });
    expect(down.status).toBe(0);
    expect(down.spawns).toContain("TERM GitHub App token daemon");
    expect(down.spawns).toContain("AWAIT GitHub App token daemon");
  } finally {
    await stopProcess(daemon);
    f.cleanup();
  }
});

test("`up` adopts a lock-owning --daemon-held GitHub App process", async () => {
  const f = makeFixture();
  const daemon = await startLockOwningGhAppProcess(f, "--daemon-held");
  try {
    const r = runStack(f, ["up"], {
      FACTORY_GH_APP_ID: "test-app",
      FACTORY_GH_APP_PRIVATE_KEY_PATH: "/tmp/test-key",
      FACTORY_HOME: f.root,
      FACTORY_ROOT: f.root,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `GitHub App token daemon already running (adopted pid ${daemon.pid})`,
    );
    expect(readFileSync(path.join(f.runDir, "gh-app-auth.pid"), "utf8")).toBe(
      `${daemon.pid}\n`,
    );
    expect(spawnFor(r.spawns, "gh-app-auth.pid")).toBe("");
  } finally {
    await stopProcess(daemon);
    f.cleanup();
  }
});

test("gh_app_daemon_command_matches accepts --daemon and --daemon-held", () => {
  const repo = path.resolve(import.meta.dir, "..");
  const script = `${repo}/lib/control-plane/gh-app-auth.mjs`;
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      "-uc",
      `REPO="$2"
# Isolate the matcher + the release-root helper it calls.
eval "$(sed -n '/^gh_app_release_root()/,/^}/p; /^gh_app_daemon_command_matches()/,/^}/p' "$1")"
gh_app_daemon_command_matches "bun $3 --daemon"
gh_app_daemon_command_matches "bun $3 --daemon-held"
! gh_app_daemon_command_matches "bun $3 --daemon-other"
! gh_app_daemon_command_matches "bun $3 --daemonize"
`,
      "bash",
      LIVE_STACK,
      repo,
      script,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("untracking the only pidfile remains safe under nounset", () => {
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      "-uc",
      `source <(sed -n '48,109p' "$1")
UP_STARTED_PIDFILES=("$2")
UP_STARTED_LABELS=("GitHub App token daemon")
untrack_up_pidfile "$2"
[[ \${#UP_STARTED_PIDFILES[@]} -eq 0 ]]
[[ \${#UP_STARTED_LABELS[@]} -eq 0 ]]`,
      "bash",
      LIVE_STACK,
      "/tmp/only.pid",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
});

test("`up` keeps the existing live GitHub App daemon pidfile behavior", () => {
  const f = makeFixture();
  try {
    mkdirSync(f.runDir, { recursive: true });
    writeFileSync(path.join(f.runDir, "gh-app-auth.pid"), "31337\n");
    const r = runStack(f, ["up"], {
      FACTORY_GH_APP_ID: "test-app",
      FACTORY_GH_APP_PRIVATE_KEY_PATH: "/tmp/test-key",
      FAKE_ALIVE: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "GitHub App token daemon already running (pid 31337)",
    );
    expect(readFileSync(path.join(f.runDir, "gh-app-auth.pid"), "utf8")).toBe(
      "31337\n",
    );
    expect(spawnFor(r.spawns, "gh-app-auth.pid")).toBe("");
  } finally {
    f.cleanup();
  }
});

test("plain `up` spawns serve, worker, and the static web server — unchanged by --dev existing", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up"]);
    expect(r.status).toBe(0);

    const serve = spawnFor(r.spawns, "serve.pid");
    expect(serve).toContain("cli.mjs serve --port 7381");
    expect(serve).not.toContain("--watch");

    expect(spawnFor(r.spawns, "worker.pid")).toContain("cli.mjs work");
    expect(spawnFor(r.spawns, "worker.pid")).not.toContain(
      "__supervise-worker",
    );
    expect(existsSync(path.join(f.runDir, "worker.pid"))).toBe(true);

    const web = spawnFor(r.spawns, "web.pid");
    expect(web).toContain("web/serve.mjs");
    expect(web).not.toContain("vite");

    expect(r.stdout).toContain("ready — live factory stack");
    expect(r.stdout).not.toContain("dev, live reload");
  } finally {
    f.cleanup();
  }
});

test.each([
  ["work", ["up"], "cli.mjs work"],
  ["supervise", ["up", "--workers", "1:1"], "cli.mjs supervise"],
])(
  "a worker daemon that exits during %s startup fails `up` and cleans up its pidfiles",
  (_command, args, failingCommand) => {
    const f = makeFixture();
    try {
      const r = runStack(f, args, { FAKE_DAEMON_DIES_FOR: failingCommand });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("worker exited during startup");
      expect(r.stderr).toContain("worker.log");
      expect(r.stderr).toContain("fake daemon exited 1");
      expect(r.spawns).toContain("TERM worker");
      expect(r.spawns).toContain("TERM event runtime");
      for (const file of ["worker.pid", "serve.pid"])
        expect(existsSync(path.join(f.runDir, file))).toBe(false);
    } finally {
      f.cleanup();
    }
  },
);

test("`up --dry-run` prints the resolved daemon plan without spawning", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, [
      "up",
      "--dry-run",
      "--port",
      "7411",
      "--web-port",
      "7412",
    ]);
    expect(r.status).toBe(0);
    expect(r.spawns).toEqual([]);
    expect(r.builds).toEqual([]);
    expect(r.stdout).toContain("dry run — no daemons will be started");
    expect(r.stdout).toContain(`RUN_DIR=${f.runDir}`);
    expect(r.stdout).toContain("API_PORT=7411");
    expect(r.stdout).toContain("WEB_PORT=7412");
    expect(r.stdout).toContain("event runtime: env");
    expect(r.stdout).toContain("cli.mjs serve --port 7411");
    expect(r.stdout).toContain("worker: env");
    expect(r.stdout).toContain("web server: env");
    expect(r.stdout).toContain("web supervisor: env");
    // A dry run leaves no trace on disk: no run dir, no event home.
    expect(existsSync(f.runDir)).toBe(false);
    expect(existsSync(path.join(f.root, "home"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("failed runtime health cleans up only daemons spawned by this `up`", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up"], {
      FACTORY_GH_APP_ID: "test-app",
      FACTORY_GH_APP_PRIVATE_KEY_PATH: "/tmp/test-key",
      FAKE_CURL_STATUS: "1",
      FAKE_FAST_SLEEP: "1",
      FACTORY_API_READY_TIMEOUT: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("event runtime failed to start");
    expect(r.spawns).toContainEqual(
      expect.stringContaining("pid=gh-app-auth.pid"),
    );
    expect(r.spawns).toContainEqual(expect.stringContaining("pid=serve.pid"));
    expect(r.spawns).toContain("TERM GitHub App token daemon");
    expect(r.spawns).toContain("TERM event runtime");
    expect(existsSync(path.join(f.runDir, "gh-app-auth.pid"))).toBe(false);
    expect(existsSync(path.join(f.runDir, "serve.pid"))).toBe(false);
  } finally {
    f.cleanup();
  }
}, 20_000);

test("malformed timing knobs fail before `up` snapshots or starts daemons", () => {
  for (const [env, message] of [
    [
      { FACTORY_API_READY_TIMEOUT: "abc" },
      "FACTORY_API_READY_TIMEOUT must be a non-negative integer",
    ],
    [
      { FACTORY_API_READY_TIMEOUT: "-1" },
      "FACTORY_API_READY_TIMEOUT must be a non-negative integer",
    ],
    [
      { FACTORY_WORKER_READY_TIMEOUT: "soon" },
      "FACTORY_WORKER_READY_TIMEOUT must be a non-negative integer",
    ],
    [
      { FACTORY_WEB_SUPERVISOR_INTERVAL: "0" },
      "FACTORY_WEB_SUPERVISOR_INTERVAL must be a positive number",
    ],
    [
      { FACTORY_WEB_SUPERVISOR_INTERVAL: "soon" },
      "FACTORY_WEB_SUPERVISOR_INTERVAL must be a positive number",
    ],
  ]) {
    const f = makeFixture();
    try {
      const r = runStack(f, ["up"], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      expect(r.spawns).toEqual([]);
      expect(existsSync(f.runDir)).toBe(false);
    } finally {
      f.cleanup();
    }
  }
});

test("a pool without a supervisor pidfile fails worker readiness and cleans up", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--workers", "1:1"], {
      FAKE_SUPERVISOR_MISSING: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      "worker pool supervisor did not start within 0s",
    );
    expect(r.stderr).toContain("worker.log");
    expect(r.spawns).toContain("TERM worker");
    expect(r.spawns).toContain("TERM event runtime");
    for (const file of ["worker.pid", "serve.pid"])
      expect(existsSync(path.join(f.runDir, file))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("`up --help` prints usage even when a timing knob is malformed", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--help"], {
      FACTORY_API_READY_TIMEOUT: "abc",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("usage: factory up");
    expect(r.stderr).not.toContain("FACTORY_API_READY_TIMEOUT");
    expect(r.spawns).toEqual([]);
    expect(existsSync(f.runDir)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("FACTORY_API_READY_TIMEOUT=0 is an immediate deadline, not a rejection", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up"], {
      FAKE_CURL_STATUS: "1",
      FAKE_FAST_SLEEP: "1",
      FACTORY_API_READY_TIMEOUT: "0",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("must be a");
    expect(r.stderr).toContain("failed to start");
    expect(r.stderr).toContain("within 0s");
    expect(r.spawns).toContain("TERM event runtime");
  } finally {
    f.cleanup();
  }
}, 20_000);

test("web supervisor interval accepts a positive decimal", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--dry-run"], {
      FACTORY_WEB_SUPERVISOR_INTERVAL: "0.5",
    });
    expect(r.status).toBe(0);
    expect(r.spawns).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("runtime health allows a slow bind beyond the former 30-attempt budget", () => {
  const f = makeFixture();
  const calls = path.join(f.root, "curl-calls");
  try {
    const r = runStack(f, ["up"], {
      FAKE_CURL_COUNT_FILE: calls,
      FAKE_CURL_SUCCEED_AFTER: "31",
      FAKE_FAST_SLEEP: "1",
    });
    expect(r.status).toBe(0);
    expect(Number(readFileSync(calls, "utf8"))).toBeGreaterThan(31);
    expect(r.stdout).toContain("ready — live factory stack");
  } finally {
    f.cleanup();
  }
}, 20_000);

test("runtime health is a wall-clock deadline even when /health stalls per attempt", () => {
  const f = makeFixture();
  try {
    // Every probe hangs for a second (a bound socket whose /health never
    // answers). An attempt-counted loop would wait 600 x 1 s here; the deadline
    // must cut it off at FACTORY_API_READY_TIMEOUT regardless.
    const started = Date.now();
    const r = runStack(f, ["up"], {
      FAKE_CURL_STALL: "1",
      FACTORY_API_READY_TIMEOUT: "2",
    });
    const elapsed = (Date.now() - started) / 1000;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("event runtime failed to start");
    expect(r.stderr).toContain("within 2s");
    // $SECONDS ticks on wall-clock second boundaries, so a 2 s deadline may
    // expire shortly after 1 s; the upper bound is what the nit is about.
    expect(elapsed).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(8);
    expect(r.spawns).toContain("TERM event runtime");
    expect(existsSync(path.join(f.runDir, "serve.pid"))).toBe(false);
  } finally {
    f.cleanup();
  }
}, 20_000);

test("a dead serve pid aborts readiness promptly with its own diagnostic", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up"], {
      FAKE_SERVE_DIES: "1",
      FAKE_CURL_STATUS: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("event runtime exited before becoming healthy");
    expect(r.spawns).toContain("TERM event runtime");
    expect(existsSync(path.join(f.runDir, "serve.pid"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("SIGINT during `up` cleans up pidfiles owned by this invocation", () => {
  const f = makeFixture();
  const marker = path.join(f.root, "signal-sent");
  try {
    const r = runStack(f, ["up"], {
      FAKE_CURL_SIGNAL_PARENT: "1",
      FAKE_CURL_SIGNAL_MARKER: marker,
    });
    expect(r.status).toBe(130);
    expect(existsSync(marker)).toBe(true);
    expect(r.spawns).toContain("TERM event runtime");
    expect(existsSync(path.join(f.runDir, "serve.pid"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("a set -e abort inside a helper still runs the ERR-trap cleanup", () => {
  const f = makeFixture();
  try {
    // The failure happens inside a function body. Without `set -E` the ERR trap
    // is not inherited there, and the shell would exit leaving serve.pid behind.
    const r = runStack(f, ["up"], { FAKE_INFO_FAIL_ON: "starting worker" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("unreachable");
    expect(r.spawns).toContainEqual(expect.stringContaining("pid=serve.pid"));
    expect(r.spawns).not.toContainEqual(
      expect.stringContaining("pid=worker.pid"),
    );
    expect(r.spawns).toContain("TERM event runtime");
    expect(existsSync(path.join(f.runDir, "serve.pid"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("missing curl names the required tool before starting daemons", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up"], { FAKE_PATH_WITHOUT_CURL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("curl not found");
    expect(r.spawns).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("failed `up` leaves an already-running daemon alone", () => {
  const f = makeFixture();
  try {
    mkdirSync(f.runDir, { recursive: true });
    writeFileSync(path.join(f.runDir, "serve.pid"), "4242\n", "utf8");
    const r = runStack(f, ["up"], {
      FAKE_ALIVE: "1",
      FAKE_CURL_STATUS: "1",
      FAKE_FAST_SLEEP: "1",
      FACTORY_API_READY_TIMEOUT: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("event runtime already running");
    expect(r.spawns).not.toContain("TERM event runtime");
    expect(existsSync(path.join(f.runDir, "serve.pid"))).toBe(true);
  } finally {
    f.cleanup();
  }
}, 20_000);

test("slow web health warns and keeps the healthy runtime and pool running", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--workers", "1:1"], {
      FAKE_POOL_CHILDREN: "1",
      FAKE_CURL_FAIL_URL: ":7382",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("web server not responding on 7382 yet");
    expect(r.stdout).toContain("ready — live factory stack");
    expect(r.spawns.some((line) => line.startsWith("TERM "))).toBe(false);
    for (const file of [
      "serve.pid",
      "worker.pid",
      "supervisor.pid",
      "worker-1.pid",
      "web.pid",
    ]) {
      expect(existsSync(path.join(f.runDir, file))).toBe(true);
    }
  } finally {
    f.cleanup();
  }
}, 20_000);

test("a daemon that fails to spawn removes supervised pool children from this `up`", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--workers", "1:1"], {
      FAKE_POOL_CHILDREN: "1",
      FAKE_SPAWN_FAIL_PIDFILE: "web.pid",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("failed to start web server");
    expect(r.spawns).toContain("TERM worker pool worker-1");
    expect(r.spawns).toContain("TERM event runtime");
    for (const file of [
      "worker.pid",
      "supervisor.pid",
      "worker-1.pid",
      "worker-1.id",
    ]) {
      expect(existsSync(path.join(f.runDir, file))).toBe(false);
    }
  } finally {
    f.cleanup();
  }
}, 20_000);

test("a non-`up` die never touches pre-existing pidfiles or daemons", () => {
  const f = makeFixture();
  try {
    mkdirSync(f.runDir, { recursive: true });
    const preexisting = {
      "serve.pid": "4242\n",
      "worker.pid": "4243\n",
      "supervisor.pid": "4244\n",
      "worker-1.pid": "4245\n",
      "worker-1.id": "worker_live\n",
      "web.pid": "4246\n",
    };
    for (const [file, body] of Object.entries(preexisting)) {
      writeFileSync(path.join(f.runDir, file), body, "utf8");
    }
    for (const args of [
      ["tail", "nosuchlog"],
      ["bogus-action"],
      ["up", "--no-such-option"],
    ]) {
      const r = runStack(f, args, { FAKE_ALIVE: "1" });
      expect(r.status).not.toBe(0);
      expect(r.spawns).toEqual([]);
      for (const [file, body] of Object.entries(preexisting)) {
        expect(readFileSync(path.join(f.runDir, file), "utf8")).toBe(body);
      }
    }
  } finally {
    f.cleanup();
  }
}, 20_000);

test("plain `up` rebuilds a stale web bundle and reports the elapsed time", () => {
  const f = makeFixture({ bundle: "stale" });
  try {
    const r = runStack(f, ["up"]);
    expect(r.status).toBe(0);
    expect(r.builds).toHaveLength(1);
    expect(r.builds[0]).toContain("cmd=run build");
    expect(r.builds[0]).toContain(
      `cwd=${path.join(f.root, "event-runtime", "web")}`,
    );
    expect(r.stdout).toMatch(/web bundle stale — rebuilt in \d+s/);
  } finally {
    f.cleanup();
  }
});

test("plain `up` skips the build when dist is newer than the web sources", () => {
  const f = makeFixture({ bundle: "fresh" });
  try {
    const r = runStack(f, ["up"]);
    expect(r.status).toBe(0);
    expect(r.builds).toEqual([]);
    expect(r.stdout).not.toContain("web bundle stale");
  } finally {
    f.cleanup();
  }
});

test("each top-level web build input participates in the stale check", () => {
  for (const relative of ["index.html", "vite.config.ts", "package.json"]) {
    const f = makeFixture({ bundle: "fresh" });
    try {
      const staleTime = new Date("2028-01-01T00:00:00Z");
      utimesSync(
        path.join(f.root, "event-runtime", "web", relative),
        staleTime,
        staleTime,
      );
      const r = runStack(f, ["up"]);
      expect(r.status).toBe(0);
      expect(r.builds).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  }
});

test("plain `up` builds when the web bundle is missing", () => {
  const f = makeFixture({ bundle: "missing" });
  try {
    const r = runStack(f, ["up"]);
    expect(r.status).toBe(0);
    expect(r.builds).toHaveLength(1);
    expect(
      existsSync(
        path.join(f.root, "event-runtime", "web", "dist", "index.html"),
      ),
    ).toBe(true);
    expect(r.stdout).toMatch(/web bundle missing — rebuilt in \d+s/);
  } finally {
    f.cleanup();
  }
});

test("`up --no-build` skips a stale bundle check and warns explicitly", () => {
  const f = makeFixture({ bundle: "stale" });
  try {
    const r = runStack(f, ["up", "--no-build"]);
    expect(r.status).toBe(0);
    expect(r.builds).toEqual([]);
    expect(r.stderr).toContain("--no-build: served web bundle may be stale");
  } finally {
    f.cleanup();
  }
});

test("`up --fake` still passes the adapter override through", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--fake"]);
    expect(r.status).toBe(0);
    expect(spawnFor(r.spawns, "serve.pid")).toContain(
      "--adapter-override fake",
    );
  } finally {
    f.cleanup();
  }
});

test("`up --dev` wires all three without checking or building a stale dist", () => {
  const f = makeFixture({ bundle: "stale" });
  try {
    const r = runStack(f, ["up", "--dev"]);
    expect(r.status).toBe(0);

    expect(spawnFor(r.spawns, "serve.pid")).toContain(
      "cli.mjs serve --port 7381 --watch",
    );

    const worker = spawnFor(r.spawns, "worker.pid");
    expect(worker).toContain(
      "bin/live-stack.sh __supervise-worker --reload-on-change",
    );

    const web = spawnFor(r.spawns, "web.pid");
    expect(web).toContain(
      "bunx vite --host 127.0.0.1 --port 7382 --strictPort",
    );
    expect(web).toContain(
      `workdir=${path.join(f.root, "event-runtime", "web")}`,
    );

    expect(r.stdout).toContain("ready — live factory stack (dev, live reload)");
    expect(r.stdout).toContain("worker: on exit 75 when idle");
    expect(r.stdout).not.toContain("web bundle stale");
    expect(r.builds).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("`up --dev --fake` keeps both the adapter override and the watch flag", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, [
      "up",
      "--dev",
      "--fake",
      "--port",
      "7391",
      "--web-port",
      "7392",
    ]);
    expect(r.status).toBe(0);
    const serve = spawnFor(r.spawns, "serve.pid");
    expect(serve).toContain("--port 7391");
    expect(serve).toContain("--adapter-override fake");
    expect(serve).toContain("--watch");
    expect(spawnFor(r.spawns, "web.pid")).toContain("--port 7392");
  } finally {
    f.cleanup();
  }
});

test("`up --dev` without the web deps names the install command instead of failing inside vite", () => {
  const f = makeFixture({ withWebDeps: false });
  try {
    const r = runStack(f, ["up", "--dev"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--dev needs the web deps for vite");
    expect(r.stderr).toContain("bun install");
    expect(r.spawns).toEqual([]); // nothing started before the check
  } finally {
    f.cleanup();
  }
});

test("`down` stops all three daemons in either mode", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["down"]);
    expect(r.status).toBe(0);
    for (const label of ["web server", "worker", "event runtime"]) {
      expect(r.spawns).toContain(`TERM ${label}`);
      expect(r.spawns).toContain(`AWAIT ${label}`);
    }
  } finally {
    f.cleanup();
  }
});

// --- worker pool (WM-226) ----------------------------------------------------

test("a config with no workers: block keeps the plain single worker (regression)", () => {
  const f = makeFixture({
    policy: "concurrency:\n  max_in_flight_per_repo: 3\n",
  });
  try {
    const r = runStack(f, ["up"]);
    expect(r.status).toBe(0);
    const worker = spawnFor(r.spawns, "worker.pid");
    expect(worker).toContain("cli.mjs work");
    expect(worker).not.toContain("supervise");
    expect(r.stdout).not.toContain("supervised pool");
  } finally {
    f.cleanup();
  }
});

test("a workers: block in policy.yaml is the switch — `up` starts the supervisor instead", () => {
  const f = makeFixture({ policy: "workers:\n  min: 1\n  max: 3\n" });
  try {
    const r = runStack(f, ["up"]);
    expect(r.status).toBe(0);
    const worker = spawnFor(r.spawns, "worker.pid");
    expect(worker).toContain("cli.mjs supervise");
    expect(worker).not.toContain("--workers"); // bounds come from policy, not the flag
    expect(r.stdout).toContain("starting worker pool supervisor");
    expect(r.stdout).toContain("supervised pool");
    // The supervisor still takes the worker.pid slot, so down/tail are unchanged.
    expect(spawnFor(r.spawns, "worker.pid")).toContain("pid=worker.pid");
  } finally {
    f.cleanup();
  }
});

test("`up --workers 2:4` selects the pool even with no policy file, and passes the bounds through", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--workers", "2:4"]);
    expect(r.status).toBe(0);
    expect(spawnFor(r.spawns, "worker.pid")).toContain(
      "cli.mjs supervise --workers 2:4",
    );
    expect(r.stdout).toContain("starting worker pool supervisor (workers 2:4)");
    expect(r.stdout).toContain("supervised pool (2:4)");
  } finally {
    f.cleanup();
  }
});

test("`--workers` and `--dev` both claim the worker slot — the conflict is named, nothing starts", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--dev", "--workers", "1:3"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      "--workers and --dev both replace the worker daemon",
    );
    expect(r.spawns).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("`up --dev` ignores a workers: block and keeps WM-213's reload supervisor", () => {
  const f = makeFixture({ policy: "workers:\n  min: 1\n  max: 3\n" });
  try {
    const r = runStack(f, ["up", "--dev"]);
    expect(r.status).toBe(0);
    const worker = spawnFor(r.spawns, "worker.pid");
    expect(worker).toContain(
      "bin/live-stack.sh __supervise-worker --reload-on-change",
    );
    expect(worker).not.toContain("cli.mjs supervise");
  } finally {
    f.cleanup();
  }
});

test("`down` drains the pool before the ordinary teardown, and clears the slot files", () => {
  const f = makeFixture({ policy: "workers:\n  min: 1\n  max: 3\n" });
  try {
    mkdirSync(f.runDir, { recursive: true });
    for (const [name, body] of [
      ["supervisor.pid", "4242\n"],
      ["worker.pid", "4242\n"],
      ["worker-1.pid", "4243\n"],
      ["worker-1.drain", "scale-down\n"],
      ["worker-1.id", "worker_x\n"],
    ])
      writeFileSync(path.join(f.runDir, name), body, "utf8");

    const r = runStack(f, ["down"], {
      FAKE_ALIVE: "1",
      FACTORY_POOL_DRAIN_TIMEOUT: "5",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "draining worker pool (up to 5s — runs in flight finish first)",
    );
    // The supervisor is stopped FIRST and waited for, not lumped into the
    // three-second await that is right for a web server and wrong here.
    expect(r.spawns[0]).toBe("TERM worker pool supervisor");
    expect(r.stderr).not.toContain("still draining");
    for (const name of [
      "worker-1.pid",
      "worker-1.drain",
      "worker-1.id",
      "supervisor.pid",
    ]) {
      expect(existsSync(path.join(f.runDir, name))).toBe(false);
    }
  } finally {
    f.cleanup();
  }
});

test("`down` gives the pool a bounded wait, then says so instead of hanging", () => {
  const f = makeFixture({ policy: "workers:\n  min: 1\n  max: 3\n" });
  try {
    mkdirSync(f.runDir, { recursive: true });
    writeFileSync(path.join(f.runDir, "supervisor.pid"), "4242\n", "utf8");
    writeFileSync(path.join(f.runDir, "worker.pid"), "4242\n", "utf8");

    const r = runStack(f, ["down"], {
      FAKE_ALIVE: "1",
      FAKE_IGNORES_TERM: "1",
      FACTORY_POOL_DRAIN_TIMEOUT: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("worker pool still draining after 1s");
    expect(r.stderr).toContain("the reaper requeues any lease left behind");
  } finally {
    f.cleanup();
  }
}, 20_000);

test("malformed pool drain timeout leaves the running stack untouched", () => {
  const f = makeFixture();
  try {
    mkdirSync(f.runDir, { recursive: true });
    for (const [name, body] of [
      ["supervisor.pid", "4242\n"],
      ["worker.pid", "4242\n"],
      ["serve.pid", "4243\n"],
    ])
      writeFileSync(path.join(f.runDir, name), body, "utf8");

    const r = runStack(f, ["down"], {
      FAKE_ALIVE: "1",
      FACTORY_POOL_DRAIN_TIMEOUT: "10s",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "FACTORY_POOL_DRAIN_TIMEOUT must be a non-negative integer",
    );
    expect(r.spawns).toEqual([]);
    for (const name of ["supervisor.pid", "worker.pid", "serve.pid"])
      expect(existsSync(path.join(f.runDir, name))).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("FACTORY_POOL_DRAIN_TIMEOUT=0 skips the drain wait without rejecting the knob", () => {
  const f = makeFixture({ policy: "workers:\n  min: 1\n  max: 3\n" });
  try {
    mkdirSync(f.runDir, { recursive: true });
    writeFileSync(path.join(f.runDir, "supervisor.pid"), "4242\n", "utf8");
    writeFileSync(path.join(f.runDir, "worker.pid"), "4242\n", "utf8");

    const r = runStack(f, ["down"], {
      FAKE_ALIVE: "1",
      FAKE_IGNORES_TERM: "1",
      FACTORY_POOL_DRAIN_TIMEOUT: "0",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("must be a");
    expect(r.stdout).toContain("draining worker pool (up to 0s");
    expect(r.stderr).toContain("worker pool still draining after 0s");
  } finally {
    f.cleanup();
  }
});

test("`down` without a supervisor pidfile is the pre-pool teardown, unchanged", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["down"], { FAKE_ALIVE: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("draining worker pool");
    expect(r.spawns[0]).toBe("TERM web server");
  } finally {
    f.cleanup();
  }
});

test("`up --bogus` is still rejected", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--bogus"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--bogus'");
  } finally {
    f.cleanup();
  }
});

test("`logs rotate` reports its total after requesting the configured retention", () => {
  const f = makeFixture();
  const rotationLog = path.join(f.root, "rotations.log");
  try {
    const r = runStack(f, ["logs", "rotate"], {
      FACTORY_LOG_ROTATE_BYTES: "1048576",
      FACTORY_LOG_KEEP: "2",
      FAKE_ROTATION_LOG: rotationLog,
      FAKE_LOG_BYTES: "321",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("total log bytes: 321");
    expect(readFileSync(rotationLog, "utf8")).toBe(
      "ROTATE bytes=1048576 keep=2\n",
    );
  } finally {
    f.cleanup();
  }
});

test("`logs rotate` treats FACTORY_LOG_ROTATE_BYTES=0 as disabled", () => {
  const f = makeFixture();
  const rotationLog = path.join(f.root, "rotations.log");
  try {
    const r = runStack(f, ["logs", "rotate"], {
      FACTORY_LOG_ROTATE_BYTES: "0",
      FAKE_ROTATION_LOG: rotationLog,
      FAKE_LOG_BYTES: "7",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("log rotation disabled");
    expect(r.stdout).toContain("total log bytes: 7");
    expect(existsSync(rotationLog)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("log knobs below 1 MiB or malformed are rejected before anything rotates", () => {
  const f = makeFixture();
  const rotationLog = path.join(f.root, "rotations.log");
  try {
    for (const [env, message] of [
      [{ FACTORY_LOG_ROTATE_BYTES: "42" }, "at least 1048576 bytes"],
      [{ FACTORY_LOG_ROTATE_BYTES: "lots" }, "non-negative integer"],
      [
        { FACTORY_LOG_KEEP: "0" },
        "FACTORY_LOG_KEEP must be a positive integer",
      ],
      [
        { FACTORY_LOG_ROTATE_INTERVAL: "soon" },
        "FACTORY_LOG_ROTATE_INTERVAL must be a non-negative integer",
      ],
    ]) {
      const r = runStack(f, ["logs", "rotate"], {
        ...env,
        FAKE_ROTATION_LOG: rotationLog,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      expect(existsSync(rotationLog)).toBe(false);
    }
  } finally {
    f.cleanup();
  }
});

test("web supervisor rotates logs on its tick while the stack stays up", async () => {
  const f = makeFixture();
  const rotationLog = path.join(f.root, "rotations.log");
  const counter = path.join(f.root, "sleep-count");
  const sleep = path.join(f.root, "stubs", "sleep");
  writeFileSync(
    sleep,
    `#!/bin/sh
n=$(cat "$FAKE_SLEEP_COUNT" 2>/dev/null || printf 0)
n=$((n + 1))
printf '%s\n' "$n" > "$FAKE_SLEEP_COUNT"
if [ "$n" -ge 3 ]; then kill -TERM "$PPID"; fi
`,
    "utf8",
  );
  chmodSync(sleep, 0o755);
  mkdirSync(f.runDir, { recursive: true });
  writeFileSync(path.join(f.runDir, "serve.pid"), "1\n", "utf8");
  const proc = Bun.spawn({
    cmd: ["bash", path.join(f.root, "bin", "live-stack.sh"), "__supervise-web"],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${path.join(f.root, "stubs")}:${process.env.PATH}`,
      FAKE_REPO: f.root,
      FACTORY_RUN_DIR: f.runDir,
      FACTORY_EVENT_HOME: path.join(f.root, "home"),
      FAKE_WEB_SUPERVISOR: "1",
      FAKE_SLEEP_COUNT: counter,
      FAKE_ROTATION_LOG: rotationLog,
      FACTORY_LOG_ROTATE_BYTES: "2097152",
      FACTORY_LOG_KEEP: "4",
      // Every tick is a rotation check; the real default is 300 s.
      FACTORY_LOG_ROTATE_INTERVAL: "0",
    },
  });
  try {
    const status = await proc.exited;
    expect(status).toBe(0);
    const rotations = readFileSync(rotationLog, "utf8").trim().split("\n");
    expect(rotations.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rotations)).toEqual(
      new Set(["ROTATE bytes=2097152 keep=4"]),
    );
  } finally {
    f.cleanup();
  }
}, 20_000);

test("web supervisor exponentially backs off rapid restarts", async () => {
  const f = makeFixture();
  const sleeps = path.join(f.root, "sleeps.log");
  const counter = path.join(f.root, "sleep-count");
  const sleep = path.join(f.root, "stubs", "sleep");
  writeFileSync(
    sleep,
    `#!/bin/sh
n=$(cat "$FAKE_SLEEP_COUNT" 2>/dev/null || printf 0)
n=$((n + 1))
printf '%s\\n' "$n" > "$FAKE_SLEEP_COUNT"
printf '%s\\n' "$1" >> "$FAKE_SLEEP_LOG"
if [ "$n" -ge 4 ]; then kill -TERM "$PPID"; fi
`,
    "utf8",
  );
  chmodSync(sleep, 0o755);
  mkdirSync(f.runDir, { recursive: true });
  writeFileSync(path.join(f.runDir, "serve.pid"), "1\n", "utf8");
  const proc = Bun.spawn({
    cmd: ["bash", path.join(f.root, "bin", "live-stack.sh"), "__supervise-web"],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${path.join(f.root, "stubs")}:${process.env.PATH}`,
      FAKE_REPO: f.root,
      FACTORY_RUN_DIR: f.runDir,
      FACTORY_EVENT_HOME: path.join(f.root, "home"),
      FAKE_WEB_SUPERVISOR: "1",
      FAKE_SLEEP_LOG: sleeps,
      FAKE_SLEEP_COUNT: counter,
    },
  });
  try {
    const status = await proc.exited;
    expect(status).toBe(0);
    const delays = readFileSync(sleeps, "utf8").trim().split("\n");
    expect(delays).toEqual(["1", "1", "1", "2"]);
  } finally {
    f.cleanup();
  }
}, 20_000);

// --- __supervise-worker ------------------------------------------------------

function runSupervisor(f, { reloads = 0, final = 0, mode = "" } = {}) {
  const counter = path.join(f.root, "counter");
  writeFileSync(counter, "0", "utf8");
  const proc = Bun.spawnSync({
    cmd: [
      "bash",
      path.join(f.root, "bin", "live-stack.sh"),
      "__supervise-worker",
      "--reload-on-change",
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FAKE_REPO: f.root,
      SPAWN_LOG: f.spawnLog,
      FACTORY_RUN_DIR: path.join(f.root, "run"),
      FACTORY_EVENT_HOME: path.join(f.root, "home"),
      FAKE_WORKER_COUNTER: counter,
      FAKE_WORKER_RELOADS: String(reloads),
      FAKE_WORKER_FINAL: String(final),
      FAKE_WORKER_MODE: mode,
    },
  });
  return {
    status: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    runs: Number(readFileSync(counter, "utf8").trim()),
  };
}

test("supervisor restarts the worker on exit 75, as many times as it asks", () => {
  const f = makeFixture();
  try {
    const r = runSupervisor(f, { reloads: 3, final: 0 });
    expect(r.runs).toBe(4); // three reloads, then the run that exits cleanly
    expect(r.status).toBe(0);
    expect(r.out.split("worker reloaded (exit 75)").length - 1).toBe(3);
    expect(r.out).toContain("worker exited 0 — supervisor stopping");
    // The reload flag is what makes the worker exit 75 in the first place.
    expect(r.out).toContain("args=work --reload-on-change");
  } finally {
    f.cleanup();
  }
});

test("supervisor does NOT restart on a clean drain (exit 0)", () => {
  const f = makeFixture();
  try {
    const r = runSupervisor(f, { reloads: 0, final: 0 });
    expect(r.runs).toBe(1);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("worker reloaded");
  } finally {
    f.cleanup();
  }
});

test("supervisor surfaces a real crash instead of looping on it", () => {
  const f = makeFixture();
  try {
    const r = runSupervisor(f, { reloads: 0, final: 1 });
    expect(r.runs).toBe(1);
    expect(r.status).toBe(1);
    expect(r.out).toContain("worker exited 1 — supervisor stopping");
  } finally {
    f.cleanup();
  }
});

test("SIGTERM to the supervisor drains the worker and stops — even if it exits 75", async () => {
  const f = makeFixture();
  const counter = path.join(f.root, "counter");
  writeFileSync(counter, "0", "utf8");
  const proc = Bun.spawn({
    cmd: [
      "bash",
      path.join(f.root, "bin", "live-stack.sh"),
      "__supervise-worker",
      "--reload-on-change",
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FAKE_REPO: f.root,
      FACTORY_RUN_DIR: path.join(f.root, "run"),
      FACTORY_EVENT_HOME: path.join(f.root, "home"),
      FAKE_WORKER_COUNTER: counter,
      FAKE_WORKER_MODE: "wait-term",
    },
  });
  try {
    let out = "";
    const reader = (async () => {
      for await (const chunk of proc.stdout)
        out += new TextDecoder().decode(chunk);
    })();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !out.includes("fake worker start #1"))
      await Bun.sleep(50);
    expect(out).toContain("fake worker start #1");

    proc.kill("SIGTERM");
    const status = await proc.exited;
    await reader;

    // The child saw the signal (the supervisor forwarded it), and its 75 was
    // treated as "we are going down", not "restart me".
    expect(out).toContain("fake worker got SIGTERM");
    expect(out).not.toContain("worker reloaded");
    expect(out).toContain("worker drained after signal — supervisor stopping");
    expect(status).toBe(0);
    expect(Number(readFileSync(counter, "utf8").trim())).toBe(1);
  } finally {
    f.cleanup();
  }
}, 30_000);
