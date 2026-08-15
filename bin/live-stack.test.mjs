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
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LIVE_STACK = path.resolve(import.meta.dir, "live-stack.sh");

/** worktree-common.sh replaced by recorders: no daemon is ever started. */
const COMMON_STUB = `#!/usr/bin/env bash
repo_root() { printf '%s' "$FAKE_REPO"; }
info() { printf '==> %s\\n' "$*"; }
warn() { printf 'warn: %s\\n' "$*" >&2; }
die() { printf 'error: %s\\n' "$*" >&2; exit 1; }
pid_alive() { return 1; }
spawn_daemon() { # <pidfile> <logfile> <workdir> <cmd...>
  local pidfile="$1" logfile="$2" workdir="$3"
  shift 3
  printf 'SPAWN pid=%s workdir=%s cmd=%s\\n' "$(basename "$pidfile")" "$workdir" "$*" >>"$SPAWN_LOG"
  printf '1\\n' >"$pidfile"
}
term_daemon() { printf 'TERM %s\\n' "$2" >>"$SPAWN_LOG"; }
await_daemon() { printf 'AWAIT %s\\n' "$2" >>"$SPAWN_LOG"; }
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

function makeFixture({ withWebDeps = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "live-stack-"));
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "event-runtime", "web"), { recursive: true });
  mkdirSync(path.join(root, "stubs"), { recursive: true });
  copyFileSync(LIVE_STACK, path.join(root, "bin", "live-stack.sh"));
  writeFileSync(path.join(root, "bin", "worktree-common.sh"), COMMON_STUB, "utf8");
  writeFileSync(path.join(root, "event-runtime", "cli.mjs"), FAKE_CLI, "utf8");
  writeFileSync(path.join(root, "event-runtime", "web", "serve.mjs"), "", "utf8");
  if (withWebDeps) mkdirSync(path.join(root, "event-runtime", "web", "node_modules"), { recursive: true });

  // The health polls must not gate a test on a server nobody started.
  const curl = path.join(root, "stubs", "curl");
  writeFileSync(curl, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(curl, 0o755);

  return {
    root,
    spawnLog: path.join(root, "spawns.log"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runStack(fixture, args, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["bash", path.join(fixture.root, "bin", "live-stack.sh"), ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${path.join(fixture.root, "stubs")}:${process.env.PATH}`,
      FAKE_REPO: fixture.root,
      SPAWN_LOG: fixture.spawnLog,
      FACTORY_RUN_DIR: path.join(fixture.root, "run"),
      FACTORY_EVENT_HOME: path.join(fixture.root, "home"),
      ...extraEnv,
    },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    spawns: existsSync(fixture.spawnLog) ? readFileSync(fixture.spawnLog, "utf8").trim().split("\n") : [],
  };
}

const spawnFor = (spawns, pidfile) => spawns.find((line) => line.includes(`pid=${pidfile}`)) ?? "";

test("plain `up` spawns serve, worker, and the static web server — unchanged by --dev existing", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up"]);
    expect(r.status).toBe(0);

    const serve = spawnFor(r.spawns, "serve.pid");
    expect(serve).toContain("cli.mjs serve --port 7381");
    expect(serve).not.toContain("--watch");

    expect(spawnFor(r.spawns, "worker.pid")).toContain("cli.mjs work");
    expect(spawnFor(r.spawns, "worker.pid")).not.toContain("__supervise-worker");

    const web = spawnFor(r.spawns, "web.pid");
    expect(web).toContain("web/serve.mjs");
    expect(web).not.toContain("vite");

    expect(r.stdout).toContain("ready — live factory stack");
    expect(r.stdout).not.toContain("dev, live reload");
  } finally {
    f.cleanup();
  }
});

test("`up --fake` still passes the adapter override through", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--fake"]);
    expect(r.status).toBe(0);
    expect(spawnFor(r.spawns, "serve.pid")).toContain("--adapter-override fake");
  } finally {
    f.cleanup();
  }
});

test("`up --dev` wires all three: serve --watch, vite HMR web, supervised worker", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--dev"]);
    expect(r.status).toBe(0);

    expect(spawnFor(r.spawns, "serve.pid")).toContain("cli.mjs serve --port 7381 --watch");

    const worker = spawnFor(r.spawns, "worker.pid");
    expect(worker).toContain("bin/live-stack.sh __supervise-worker --reload-on-change");

    const web = spawnFor(r.spawns, "web.pid");
    expect(web).toContain("bunx vite --host 127.0.0.1 --port 7382 --strictPort");
    expect(web).toContain(`workdir=${path.join(f.root, "event-runtime", "web")}`);

    expect(r.stdout).toContain("ready — live factory stack (dev, live reload)");
    expect(r.stdout).toContain("worker: on exit 75 when idle");
  } finally {
    f.cleanup();
  }
});

test("`up --dev --fake` keeps both the adapter override and the watch flag", () => {
  const f = makeFixture();
  try {
    const r = runStack(f, ["up", "--dev", "--fake", "--port", "7391", "--web-port", "7392"]);
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

// --- __supervise-worker ------------------------------------------------------

function runSupervisor(f, { reloads = 0, final = 0, mode = "" } = {}) {
  const counter = path.join(f.root, "counter");
  writeFileSync(counter, "0", "utf8");
  const proc = Bun.spawnSync({
    cmd: ["bash", path.join(f.root, "bin", "live-stack.sh"), "__supervise-worker", "--reload-on-change"],
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
    cmd: ["bash", path.join(f.root, "bin", "live-stack.sh"), "__supervise-worker", "--reload-on-change"],
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
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk);
    })();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !out.includes("fake worker start #1")) await Bun.sleep(50);
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
