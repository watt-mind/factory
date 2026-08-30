import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const COMMON = path.resolve(import.meta.dir, "worktree-common.sh");
const DAEMONS = path.resolve(import.meta.dir, "worktree-daemons.sh");

function sh(body, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", `source "${COMMON}"\n${body}`],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runScript(args = [], extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: [DAEMONS, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function waitForFile(file, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await Bun.sleep(10);
  }
  return false;
}

test("spawn_daemon creates detached process that survives subshell exit", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "spawn-daemon-test-"));
  const pidfile = path.join(testDir, "test.pid");
  const logfile = path.join(testDir, "test.log");

  try {
    // Run spawn_daemon in a subshell that exits immediately
    const subshell = sh(`
      (
        spawn_daemon "${pidfile}" "${logfile}" "${testDir}" sleep 5
      )
      echo "subshell exited"
    `);
    expect(subshell.status).toBe(0);
    expect(subshell.stdout).toContain("subshell exited");
    expect(existsSync(pidfile)).toBe(true);

    const pid = readFileSync(pidfile, "utf8").trim();
    expect(Number(pid)).toBeGreaterThan(0);

    // Verify daemon is still alive
    const aliveCheck = sh(`pid_alive "${pidfile}"`);
    expect(aliveCheck.status).toBe(0);

    // Check process group using ps
    const ps = Bun.spawnSync({
      cmd: ["ps", "-o", "pid,pgid", "-p", pid],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(ps.exitCode).toBe(0);
    const psOut = ps.stdout.toString();
    expect(psOut).toContain(pid);

    // Stop daemon
    const stop = sh(`
      term_daemon "${pidfile}" "test daemon"
      await_daemon "${pidfile}" "test daemon"
    `);
    expect(stop.status).toBe(0);
    expect(existsSync(pidfile)).toBe(false);

    // Verify daemon is dead
    const deadCheck = sh(`pid_alive "${pidfile}"`);
    expect(deadCheck.status).not.toBe(0);
  } finally {
    if (existsSync(pidfile)) {
      try {
        const pid = readFileSync(pidfile, "utf8").trim();
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* intentionally ignored */
      }
    }
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("term_daemon and await_daemon handle non-existent pidfile gracefully", () => {
  const r = sh(`
    term_daemon "/nonexistent/test.pid" "dummy"
    await_daemon "/nonexistent/test.pid" "dummy"
  `);
  expect(r.status).toBe(0);
});

test("pid_alive returns true for running process and false for dead process", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "pid-alive-test-"));
  const pidfile = path.join(testDir, "live.pid");

  try {
    // Write current test runner PID
    writeFileSync(pidfile, String(process.pid));
    // Should be alive
    const alive = sh(`pid_alive "${pidfile}"`);
    expect(alive.status).toBe(0);

    // Write a dead PID
    writeFileSync(pidfile, "999999");
    const dead = sh(`pid_alive "${pidfile}"`);
    expect(dead.status).not.toBe(0);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("await_daemon falls back to SIGKILL when process ignores SIGTERM", () => {
  const testDir = mkdtempSync(
    path.join(tmpdir(), "await-daemon-sigkill-test-"),
  );
  const pidfile = path.join(testDir, "stubborn.pid");
  const logfile = path.join(testDir, "stubborn.log");

  let pid = null;
  try {
    // Spawn a process that ignores SIGTERM
    const spawnRes = sh(`
      spawn_daemon "${pidfile}" "${logfile}" "${testDir}" bash -c 'trap "" TERM; while true; do sleep 0.1; done'
    `);
    expect(spawnRes.status).toBe(0);
    expect(existsSync(pidfile)).toBe(true);

    pid = readFileSync(pidfile, "utf8").trim();
    expect(Number(pid)).toBeGreaterThan(0);

    // Verify stubborn process is running
    expect(sh(`pid_alive "${pidfile}"`).status).toBe(0);

    // Attempt graceful teardown; should fall back to SIGKILL
    const stopRes = sh(`
      term_daemon "${pidfile}" "stubborn daemon"
      await_daemon "${pidfile}" "stubborn daemon"
    `);
    expect(stopRes.status).toBe(0);
    expect(stopRes.stderr).toContain("ignored SIGTERM — killing");
    expect(existsSync(pidfile)).toBe(false);

    // Verify process is terminated
    const checkDead = Bun.spawnSync({
      cmd: ["kill", "-0", pid],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(checkDead.exitCode).not.toBe(0);
  } finally {
    if (pid) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* intentionally ignored */
      }
    }
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("check_daemon_health reports dead workers and anomalies", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "daemon-health-test-"));
  const runDir = path.join(testDir, ".factory", "run");
  mkdirSync(runDir, { recursive: true });

  try {
    // 1. All dead
    const deadRes = sh(`check_daemon_health "${testDir}"`);
    expect(deadRes.status).not.toBe(0);
    expect(deadRes.stdout).toContain("serve:   DEAD");
    expect(deadRes.stdout).toContain("worker:  DEAD");
    expect(deadRes.stdout).toContain("web:     DEAD");
    expect(deadRes.stdout).toContain("anomalies (");

    // 2. Serve alive, but dead worker
    writeFileSync(path.join(runDir, "serve.pid"), String(process.pid));
    writeFileSync(path.join(runDir, "worker.pid"), "999999");
    const workerDeadRes = sh(`check_daemon_health "${testDir}"`);
    expect(workerDeadRes.status).not.toBe(0);
    expect(workerDeadRes.stdout).toContain("worker:  DEAD");
    expect(workerDeadRes.stdout).toContain("worker daemon died");

    // 3. Check daemon_anomalies helper
    const anomalies = sh(`daemon_anomalies "${testDir}"`);
    expect(anomalies.status).toBe(0);
    expect(anomalies.stdout).toContain("worker daemon died (pid 999999)");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("rotate_log_file and rotate_daemon_logs rotate oversized logs", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "log-rotate-test-"));
  const runDir = path.join(testDir, ".factory", "run");
  mkdirSync(runDir, { recursive: true });

  try {
    const serveLog = path.join(runDir, "serve.log");
    const workerLog = path.join(runDir, "worker.log");

    // Write 500 bytes to serve.log and 100 bytes to worker.log
    writeFileSync(serveLog, "x".repeat(500));
    writeFileSync(workerLog, "y".repeat(100));

    // Threshold = 300 bytes -> serve.log should rotate, worker.log should stay
    const rotRes = sh(`rotate_daemon_logs "${testDir}" 300`);
    expect(rotRes.status).toBe(0);

    expect(existsSync(`${serveLog}.1`)).toBe(true);
    expect(readFileSync(`${serveLog}.1`, "utf8").length).toBe(500);
    expect(readFileSync(serveLog, "utf8").length).toBe(0);

    expect(existsSync(`${workerLog}.1`)).toBe(false);
    expect(readFileSync(workerLog, "utf8").length).toBe(100);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("rotate_daemon_logs rejects a non-positive FACTORY_LOG_KEEP", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "log-keep-guard-test-"));
  const runDir = path.join(testDir, ".factory", "run");
  const serveLog = path.join(runDir, "serve.log");
  mkdirSync(runDir, { recursive: true });

  try {
    writeFileSync(serveLog, "x".repeat(500));
    writeFileSync(`${serveLog}.1`, "archived\n");

    for (const keep of ["0", "abc", "-1", "3x"]) {
      const rotRes = sh(`rotate_daemon_logs "${testDir}" 300`, {
        FACTORY_LOG_KEEP: keep,
      });
      expect(rotRes.status).not.toBe(0);
      expect(rotRes.stderr).toContain(
        "FACTORY_LOG_KEEP must be a positive integer",
      );
      // Nothing rotated or pruned when the knob is rejected.
      expect(readFileSync(serveLog, "utf8").length).toBe(500);
      expect(readFileSync(`${serveLog}.1`, "utf8")).toBe("archived\n");
    }

    const okRes = sh(`rotate_log_file "${serveLog}" 300`, {
      FACTORY_LOG_KEEP: "2",
    });
    expect(okRes.status).toBe(0);
    expect(readFileSync(serveLog, "utf8").length).toBe(0);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("rotate_daemon_logs copy-truncates a live daemon log", async () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "live-log-rotate-test-"));
  const runDir = path.join(testDir, ".factory", "run");
  const serveLog = path.join(runDir, "serve.log");
  const ready = path.join(testDir, "writer-ready");
  const continueFile = path.join(testDir, "writer-continue");
  mkdirSync(runDir, { recursive: true });

  let writer;
  try {
    // The writer opens serve.log once, matching a daemon whose stdout was
    // redirected when it started. It only emits the second line after rotation.
    writer = Bun.spawn({
      cmd: [
        "bash",
        "-c",
        'exec > "$1"; printf "before\\n"; : > "$2"; while [[ ! -f "$3" ]]; do sleep 0.01; done; printf "after\\n"',
        "bash",
        serveLog,
        ready,
        continueFile,
      ],
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await waitForFile(ready)).toBe(true);
    writeFileSync(path.join(runDir, "serve.pid"), `${writer.pid}\n`);

    const rotRes = sh(`rotate_daemon_logs "${testDir}" 1`);
    expect(rotRes.status).toBe(0);
    expect(readFileSync(`${serveLog}.1`, "utf8")).toContain("before\n");

    writeFileSync(continueFile, "continue\n");
    expect(await writer.exited).toBe(0);
    expect(readFileSync(serveLog, "utf8")).toContain("after\n");
    expect(readFileSync(`${serveLog}.1`, "utf8")).not.toContain("after\n");
  } finally {
    writer?.kill("SIGKILL");
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("restart_daemon preserves the fake adapter reported by a live serve", () => {
  const testDir = mkdtempSync(
    path.join(tmpdir(), "restart-worker-adapter-test-"),
  );
  const runDir = path.join(testDir, ".factory", "run");
  const spawnedArgs = path.join(testDir, "spawned.args");
  mkdirSync(runDir, { recursive: true });

  try {
    const result = sh(`
      write_ports "${testDir}" 7654 7655
      health_json() { printf '%s' '{"env":{"home":"${testDir}/.factory/event-runtime","adapter":"fake"}}'; }
      spawn_daemon() {
        local pidfile="$1"
        shift 3
        printf '%s\\n' "$@" > "${spawnedArgs}"
        printf '12345\\n' > "$pidfile"
      }
      restart_daemon "${testDir}" worker
      cat "${spawnedArgs}"
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "bun\nevent-runtime/cli.mjs\nwork\n--adapter-override\nfake\n",
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("restart_daemon defaults a dead serve restart to the fake adapter", () => {
  const testDir = mkdtempSync(
    path.join(tmpdir(), "restart-serve-adapter-test-"),
  );
  const runDir = path.join(testDir, ".factory", "run");
  const spawnedArgs = path.join(testDir, "spawned.args");
  mkdirSync(runDir, { recursive: true });

  try {
    const result = sh(`
      write_ports "${testDir}" 7656 7657
      health_json() { true; }
      spawn_daemon() {
        local pidfile="$1"
        shift 3
        printf '%s\\n' "$@" > "${spawnedArgs}"
        printf '12345\\n' > "$pidfile"
      }
      restart_daemon "${testDir}" serve
      cat "${spawnedArgs}"
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "bun\nevent-runtime/cli.mjs\nserve\n--adapter-override\nfake\n",
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("restart_daemon preserves an explicitly configured live adapter mode", () => {
  const testDir = mkdtempSync(
    path.join(tmpdir(), "restart-live-adapter-test-"),
  );
  const runDir = path.join(testDir, ".factory", "run");
  const spawnedArgs = path.join(testDir, "spawned.args");
  mkdirSync(runDir, { recursive: true });

  try {
    const result = sh(`
      write_ports "${testDir}" 7658 7659
      write_adapter_override "${testDir}" ""
      health_json() { true; }
      spawn_daemon() {
        local pidfile="$1"
        shift 3
        printf '%s\\n' "$@" > "${spawnedArgs}"
        printf '12345\\n' > "$pidfile"
      }
      restart_daemon "${testDir}" serve
      cat "${spawnedArgs}"
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bun\nevent-runtime/cli.mjs\nserve\n");
    expect(result.stdout).not.toContain("--adapter-override");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("supervise_tick restarts dead daemon and logs restart line", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "supervise-restart-test-"));
  const runDir = path.join(testDir, ".factory", "run");
  mkdirSync(runDir, { recursive: true });

  try {
    const workerPid = path.join(runDir, "worker.pid");
    const workerLog = path.join(runDir, "worker.log");
    writeFileSync(workerPid, "999999");
    writeFileSync(workerLog, "initial log line\n");

    const stateFile = path.join(runDir, "supervisor-state.json");
    const supRes = sh(`supervise_tick "${testDir}" "${stateFile}" 5 60`);
    expect(supRes.status).toBe(0);
    expect(supRes.stderr).toContain("detected dead daemon 'worker'");
    expect(supRes.stderr).toContain("restarting daemon 'worker'");

    const newPid = readFileSync(workerPid, "utf8").trim();
    expect(newPid).not.toBe("999999");
    expect(Number(newPid)).toBeGreaterThan(0);

    const logContent = readFileSync(workerLog, "utf8");
    expect(logContent).toContain("[supervisor] restarting dead worker");

    // Clean up spawned worker
    try {
      process.kill(Number(newPid), "SIGKILL");
    } catch {
      /* intentionally ignored */
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("supervise_tick enforces circuit breaker when max restarts exceeded", () => {
  const testDir = mkdtempSync(
    path.join(tmpdir(), "supervise-circuit-breaker-test-"),
  );
  const runDir = path.join(testDir, ".factory", "run");
  mkdirSync(runDir, { recursive: true });

  try {
    const workerPid = path.join(runDir, "worker.pid");
    const stateFile = path.join(runDir, "supervisor-state.json");
    const now = Math.floor(Date.now() / 1000);

    // Pre-populate state with 3 recent restarts
    writeFileSync(
      stateFile,
      JSON.stringify({
        worker: [now - 10, now - 5, now - 1],
      }),
    );
    writeFileSync(workerPid, "999999");

    // max_restarts = 3 -> should hit circuit breaker
    const supRes = sh(`supervise_tick "${testDir}" "${stateFile}" 3 60`);
    expect(supRes.status).toBe(0);
    expect(supRes.stderr).toContain("exceeded max restarts");
    expect(supRes.stderr).toContain("circuit breaker engaged");

    // PID should still be the dead pid, not restarted
    expect(readFileSync(workerPid, "utf8").trim()).toBe("999999");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("worktree-daemons CLI subcommands (status, check, anomalies, rotate-logs)", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "daemons-cli-test-"));
  const runDir = path.join(testDir, ".factory", "run");
  mkdirSync(runDir, { recursive: true });

  try {
    // 1. check on empty -> fails
    const checkEmpty = runScript(["check", testDir]);
    expect(checkEmpty.status).not.toBe(0);

    // 2. anomalies on dead worker
    writeFileSync(path.join(runDir, "serve.pid"), String(process.pid));
    writeFileSync(path.join(runDir, "worker.pid"), "999999");
    const anomaliesRes = runScript(["anomalies", testDir]);
    expect(anomaliesRes.status).toBe(0);
    expect(anomaliesRes.stdout).toContain("worker daemon died");

    // 3. status
    const statusRes = runScript(["status", testDir]);
    expect(statusRes.status).not.toBe(0); // non-zero due to dead worker
    expect(statusRes.stdout).toContain("worker:  DEAD");

    // 4. rotate-logs
    const serveLog = path.join(runDir, "serve.log");
    writeFileSync(serveLog, "a".repeat(100));
    const rotRes = runScript(["rotate-logs", testDir]);
    expect(rotRes.status).toBe(0);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
