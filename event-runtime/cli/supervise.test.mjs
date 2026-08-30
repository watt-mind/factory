import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-supervise-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.mjs";
import { registerWorker } from "../lib/workers.mjs";
import {
  crashBackoffMs,
  readPool,
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
