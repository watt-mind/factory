import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-supervise-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.mjs";
import { registerWorker } from "../lib/workers.mjs";
import supervise, {
  crashBackoffMs,
  readPool,
  spawnDetached,
  startTickLoop,
  workerPassthroughArgs,
} from "./supervise.mjs";
import {
  CLI,
  DEAD_PORT,
  assertHealthyLiveServe,
  editStampRoot,
  exitOf,
  killPool,
  makeStampRoot,
  poolSize,
  runCli,
  runNotifierDeliveryCase,
  seedRun,
  spawnSupervisor,
  spawnWorker,
  until,
  waitFor,
  registerCliTmpCleanup,
} from "./test-helpers.mjs";

registerCliTmpCleanup();

describe("supervise (WM-226)", () => {
  test("passes reload and worker-shaping flags through to every pool slot (WM-613)", () => {
    expect(
      workerPassthroughArgs([
        "--workers",
        "1:2",
        "--adapter-override",
        "fake",
        "--poll-ms",
        "50",
        "--reload-on-change",
        "--label",
        "node=lab",
      ]),
    ).toEqual([
      "--adapter-override",
      "fake",
      "--poll-ms",
      "50",
      "--reload-on-change",
      "--label",
      "node=lab",
    ]);
  });

  test("rejects bounds and intervals it cannot honour, naming the flag", () => {
    expect(runCli(["supervise", "--workers", "3:1", "--once"]).all).toContain(
      "min (3) cannot exceed max (1)",
    );
    expect(runCli(["supervise", "--workers", "1:2:3", "--once"]).all).toContain(
      "--workers expects min:max",
    );
    expect(
      runCli(["supervise", "--workers", "1:2", "--interval-ms", "10", "--once"])
        .all,
    ).toContain("--interval-ms must be an integer between 100 and 60000");
    for (const args of [
      ["supervise", "--workers", "3:1", "--once"],
      ["supervise", "--workers", "x", "--once"],
    ]) {
      expect(runCli(args).status).not.toBe(0);
    }
  });

  test("--once propagates tick failures while daemon ticks log non-Error throws and retry", async () => {
    const error = "transient failure";
    expect(() =>
      startTickLoop(
        () => {
          throw error;
        },
        { once: true, intervalMs: 10, log: () => {} },
      ),
    ).toThrow(error);

    // A permanently broken tick must stay loud: every failing tick logs, with
    // no `lastHold`-style dedupe, and the interval keeps firing regardless.
    const lines = [];
    let calls = 0;
    const timer = startTickLoop(
      () => {
        calls += 1;
        throw error;
      },
      { once: false, intervalMs: 10, log: (line) => lines.push(line) },
    );
    try {
      await until(
        "the guarded tick to fail at least three times",
        () => calls >= 3,
        {
          timeoutMs: 5_000,
        },
      );
    } finally {
      clearInterval(timer);
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBe(calls);
    expect(new Set(lines)).toEqual(new Set(["tick error: transient failure"]));
  });

  test("a spawn() that throws closes the log fd and the next tick still runs", async () => {
    const dir = tmpDir("evrt-pool-spawn-throw-");
    const logFile = path.join(dir, "worker-1.log");
    const openFds = () => readdirSync("/proc/self/fd").length;
    const spawnThrows = () => {
      throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    };

    // The parent's copy of the log fd is closed even when spawn() throws:
    // fifty failed spawns leave the descriptor table where it started.
    const before = openFds();
    for (let i = 0; i < 50; i += 1) {
      expect(() =>
        spawnDetached(logFile, ["work"], { cwd: dir, spawn: spawnThrows }),
      ).toThrow("spawn EAGAIN");
    }
    expect(openFds()).toBe(before);

    // Inside the guarded loop the failure is logged and the loop keeps ticking.
    const lines = [];
    let calls = 0;
    const timer = startTickLoop(
      () => {
        calls += 1;
        spawnDetached(logFile, ["work"], { cwd: dir, spawn: spawnThrows });
      },
      { once: false, intervalMs: 10, log: (line) => lines.push(line) },
    );
    try {
      await until("the tick to fail at least three times", () => calls >= 3, {
        timeoutMs: 5_000,
      });
    } finally {
      clearInterval(timer);
    }
    expect(openFds()).toBe(before);
    expect(new Set(lines)).toEqual(new Set(["tick error: spawn EAGAIN"]));
  });

  test("an unwritable primary crash-loop file uses its fallback and keeps the supervisor live", async () => {
    const home = tmpDir("evrt-pool-tick-error-");
    const dir = tmpDir("evrt-pool-tick-error-run-");
    const box = spawnSupervisor(
      [
        "--workers",
        "1:1",
        "--interval-ms",
        "100",
        "--adapter-override",
        "fake",
        "--poll-ms",
        "50",
      ],
      { FACTORY_EVENT_HOME: home, FACTORY_RUN_DIR: dir },
    );
    try {
      expect(await waitFor(box, "spawn slot 1")).toBe(true);
      const worker = readPool(dir).slots[0];
      const crashLoop = path.join(dir, "worker-1.crash-loop.json");
      rmSync(crashLoop, { force: true });
      mkdirSync(crashLoop);
      process.kill(worker.pid, "SIGKILL");
      expect(
        await waitFor(
          box,
          "crash-loop state for slot 1 could not be saved",
          10_000,
        ),
      ).toBe(true);
      await until(
        "a replacement worker after the crash-loop write fails",
        () => readPool(dir).slots.find((s) => s.n === 1 && s.alive) ?? null,
        { timeoutMs: 10_000 },
      );
      expect(box.child.exitCode ?? null).toBeNull();
      expect(existsSync(path.join(dir, "supervisor.pid"))).toBe(true);
    } finally {
      await killPool(box, dir);
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("preserves a failed fast exit before release so the next decision backs off", async () => {
    const home = tmpDir("evrt-pool-crash-fallback-home-");
    const dir = tmpDir("evrt-pool-crash-fallback-run-");
    const before = Date.now();
    const oldHome = process.env.FACTORY_EVENT_HOME;
    const oldRunDir = process.env.FACTORY_RUN_DIR;
    process.env.FACTORY_EVENT_HOME = home;
    process.env.FACTORY_RUN_DIR = dir;
    writeFileSync(path.join(dir, "worker-1.pid"), "2147483646\n");
    writeFileSync(
      path.join(dir, "worker-1.crash-loop.json"),
      JSON.stringify({
        fastExits: 2,
        spawnedAt: before,
        workerId: "fast-exit-worker",
        nextAttemptAt: null,
        loggedRetryAt: null,
      }),
    );

    try {
      await supervise(["--workers", "1:1", "--once"], {
        writeCrashLoop: () => {
          throw "injected crash-loop write failure";
        },
      });
      const state = JSON.parse(
        readFileSync(
          path.join(dir, "worker-1.crash-loop.fallback.json"),
          "utf8",
        ),
      );
      expect(state.fastExits).toBe(3);
      expect(state.nextAttemptAt).toBeGreaterThan(before);
      expect(existsSync(path.join(dir, "worker-1.pid"))).toBe(false);
      expect(readPool(dir).slots[0]).toMatchObject({
        crashLoops: 3,
        nextAttemptAt: state.nextAttemptAt,
      });
    } finally {
      if (oldHome === undefined) delete process.env.FACTORY_EVENT_HOME;
      else process.env.FACTORY_EVENT_HOME = oldHome;
      if (oldRunDir === undefined) delete process.env.FACTORY_RUN_DIR;
      else process.env.FACTORY_RUN_DIR = oldRunDir;
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the supervise process exits non-zero when its single tick throws", () => {
    const dir = tmpDir("evrt-pool-once-tick-throw-");
    try {
      writeFileSync(path.join(dir, "worker-1.pid"), "2147483646\n");
      mkdirSync(path.join(dir, "worker-1.crash-loop.json"));
      const result = runCli(["supervise", "--workers", "1:1", "--once"], {
        FACTORY_RUN_DIR: dir,
      });
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsafe drain timeouts before writing its pidfile", () => {
    for (const value of ["not-a-number", "0", "-1"]) {
      const dir = tmpDir("evrt-pool-invalid-drain-");
      const r = runCli(
        ["supervise", "--workers", "1:1", "--drain-timeout", value, "--once"],
        { FACTORY_RUN_DIR: dir },
      );
      expect(r.status).not.toBe(0);
      expect(r.all).toContain(
        "supervise: --drain-timeout must be an integer between 1 and 3600 seconds",
      );
      expect(existsSync(path.join(dir, "supervisor.pid"))).toBe(false);
    }
  });

  test("refuses to be the second supervisor on one run dir — two would orphan each other's workers", () => {
    const dir = tmpDir("evrt-pool-dup-");
    try {
      // This process stands in for a live incumbent supervisor.
      writeFileSync(
        path.join(dir, "supervisor.pid"),
        `${process.pid}\n`,
        "utf8",
      );
      const r = runCli(["supervise", "--workers", "1:2", "--once"], {
        FACTORY_RUN_DIR: dir,
      });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain(
        `a supervisor is already running for ${dir} (pid ${process.pid})`,
      );
      expect(existsSync(path.join(dir, "worker-1.pid"))).toBe(false); // nothing spawned

      // A stale pidfile is not an incumbent: the pool starts.
      writeFileSync(path.join(dir, "supervisor.pid"), "2147483646\n", "utf8");
      expect(
        runCli(["supervise", "--workers", "1:1", "--once"], {
          FACTORY_RUN_DIR: dir,
        }).status,
      ).toBe(0);
      const pid = Number(
        readFileSync(path.join(dir, "worker-1.pid"), "utf8").trim(),
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a queued run with no idle worker spawns one within a tick, and the pool stops at workers.max", async () => {
    const home = tmpDir("evrt-pool-up-");
    const dir = tmpDir("evrt-pool-up-run-");
    // "hang" occupies a worker for the whole spec timeout, so the queue stays
    // hot long enough for the ceiling to be the thing that stops the pool.
    for (const runId of ["run_pool_a", "run_pool_b", "run_pool_c"]) {
      await seedRun(home, {
        runId,
        input: { repos: ["hang"] },
        timeoutSeconds: 20,
      });
    }
    const box = spawnSupervisor(
      [
        "--workers",
        "1:2",
        "--interval-ms",
        "150",
        "--spawn-grace-ms",
        "150",
        "--adapter-override",
        "fake",
        "--poll-ms",
        "50",
        "--drain-timeout",
        "1",
      ],
      { FACTORY_EVENT_HOME: home, FACTORY_RUN_DIR: dir },
    );
    try {
      expect(await waitFor(box, "spawn slot 1")).toBe(true);
      expect(await waitFor(box, "spawn slot 2")).toBe(true);
      // Three queued runs, two workers: the next decision is a hold at the cap.
      expect(await waitFor(box, "pool is at workers.max 2")).toBe(true);
      expect(box.out).not.toContain("spawn slot 3");
      expect(await poolSize(dir)).toBe(2);
      // The counts that justified each spawn are in the line, not just the verdict.
      expect(box.out).toMatch(
        /spawn slot 2 → worker \S+ pid \d+ .*queued=\d+ idle=0 busy=\d+ pool=1 pending=0 draining=0 min=1 max=2/,
      );
    } finally {
      await killPool(box, dir);
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("fast-exit slots back off exponentially instead of respawning every tick", async () => {
    const home = tmpDir("evrt-pool-crash-loop-");
    const dir = tmpDir("evrt-pool-crash-loop-run-");
    const box = spawnSupervisor(
      [
        "--workers",
        "1:1",
        "--interval-ms",
        "100",
        "--spawn-grace-ms",
        "500",
        "--adapter-override",
        "does-not-exist",
      ],
      { FACTORY_EVENT_HOME: home, FACTORY_RUN_DIR: dir },
    );
    try {
      expect(
        await waitFor(
          box,
          "crash-loop slot 1: 3 fast exits, next attempt in 2s",
          15_000,
        ),
      ).toBe(true);
      expect(
        await waitFor(
          box,
          "crash-loop slot 1: 4 fast exits, next attempt in 4s",
          15_000,
        ),
      ).toBe(true);
      expect(readPool(dir).slots[0].crashLoops).toBeGreaterThanOrEqual(4);
      expect(crashBackoffMs(3)).toBe(2_000);
      expect(crashBackoffMs(4)).toBe(4_000);
      expect(crashBackoffMs(8)).toBe(60_000);
    } finally {
      await killPool(box, dir);
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  test("--once reports a persisted crash-loop hold without respawning", () => {
    const home = tmpDir("evrt-pool-crash-once-");
    const dir = tmpDir("evrt-pool-crash-once-run-");
    try {
      writeFileSync(
        path.join(dir, "worker-1.crash-loop.json"),
        JSON.stringify({
          fastExits: 3,
          spawnedAt: null,
          workerId: "failed-worker",
          nextAttemptAt: Date.now() + 16_000,
          loggedRetryAt: null,
        }),
      );
      const result = runCli(["supervise", "--workers", "1:1", "--once"], {
        FACTORY_EVENT_HOME: home,
        FACTORY_RUN_DIR: dir,
      });
      expect(result.status).toBe(0);
      expect(result.all).toMatch(
        /crash-loop slot 1: 3 fast exits, next attempt in \d+s/,
      );
      expect(readPool(dir).slots[0].crashLoops).toBe(3);
      expect(existsSync(path.join(dir, "worker-1.pid"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a registered worker that survives grace resets its crash-loop counter", async () => {
    const home = tmpDir("evrt-pool-crash-reset-");
    const dir = tmpDir("evrt-pool-crash-reset-run-");
    writeFileSync(
      path.join(dir, "worker-1.crash-loop.json"),
      JSON.stringify({
        fastExits: 2,
        spawnedAt: Date.now() - 1_000,
        workerId: "old-worker",
        nextAttemptAt: null,
        loggedRetryAt: null,
      }),
    );
    const box = spawnSupervisor(
      [
        "--workers",
        "1:1",
        "--interval-ms",
        "100",
        "--spawn-grace-ms",
        "500",
        "--adapter-override",
        "fake",
        "--poll-ms",
        "50",
      ],
      { FACTORY_EVENT_HOME: home, FACTORY_RUN_DIR: dir },
    );
    try {
      expect(
        await waitFor(
          box,
          "slot 1 registered past spawn grace — crash-loop counter reset",
          10_000,
        ),
      ).toBe(true);
      expect(readPool(dir).slots[0].crashLoops).toBe(0);
    } finally {
      await killPool(box, dir);
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("surplus idle workers drain back to workers.min, and the pool is not respawned past target", async () => {
    const home = tmpDir("evrt-pool-down-");
    const dir = tmpDir("evrt-pool-down-run-");
    const children = [];
    let box = null;
    try {
      // Adopt two known-idle processes instead of waiting on timed fake runs.
      // That keeps this a supervisor decision test even on a loaded worker,
      // where run timeouts can otherwise leave transient busy registry rows.
      const db = openDb(path.join(home, "runtime.db"));
      for (const n of [1, 2]) {
        const workerId = `worker_drain_${n}`;
        registerWorker(db, { workerId });
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 60_000)"],
          { stdio: "ignore" },
        );
        children.push(child);
        writeFileSync(path.join(dir, `worker-${n}.pid`), `${child.pid}\n`);
        writeFileSync(path.join(dir, `worker-${n}.id`), `${workerId}\n`);
      }
      db.close();

      // A stale backoff for an unavailable slot must not turn a scale-down
      // decision into a retry hold; draining live capacity remains safe.
      writeFileSync(
        path.join(dir, "worker-3.crash-loop.json"),
        JSON.stringify({
          fastExits: 3,
          spawnedAt: null,
          workerId: "previous-worker",
          nextAttemptAt: Date.now() + 60_000,
          loggedRetryAt: null,
        }),
      );

      box = spawnSupervisor(["--workers", "1:2", "--interval-ms", "100"], {
        FACTORY_EVENT_HOME: home,
        FACTORY_RUN_DIR: dir,
      });
      expect(await waitFor(box, "drain slot", 10_000)).toBe(true);
      expect(box.out).toMatch(
        /drain slot \d+ \(worker \S+\): \d+ idle worker\(s\) and no queued runs, pool 2 above workers.min 1/,
      );
      // Asked, never signalled: the flag is the whole mechanism.
      expect(box.out).toContain(
        "it exits at its next idle poll boundary, never mid-run",
      );
      const drainedSlot = Number(/drain slot (\d+)/.exec(box.out)?.[1]);
      expect(drainedSlot).toBeGreaterThanOrEqual(1);
      children[drainedSlot - 1].kill("SIGKILL");
      await exitOf(children[drainedSlot - 1]);
      expect(await waitFor(box, "slot released", 10_000)).toBe(true);
      expect(await waitFor(box, "steady: 0 queued", 10_000)).toBe(true);

      // Converged at min and did not immediately undo the drain.
      expect(await poolSize(dir)).toBe(1);
      expect(box.out).not.toContain("spawn slot");
    } finally {
      if (box) await killPool(box, dir);
      for (const child of children) {
        if (child.exitCode == null && child.signalCode == null)
          child.kill("SIGKILL");
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
