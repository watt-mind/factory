import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../lib/db.mjs";
import { workerPassthroughArgs } from "./supervise.mjs";
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
} from "./test-helpers.mjs";

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

  test("refuses to be the second supervisor on one run dir — two would orphan each other's workers", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-dup-"));
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
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-up-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-up-run-"));
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

  test("surplus idle workers drain back to workers.min, and the pool is not respawned past target", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-down-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-down-run-"));
    // Two short hangs: long enough to force a second worker, short enough that
    // both go idle while the supervisor is still watching.
    for (const runId of ["run_drain_a", "run_drain_b"]) {
      await seedRun(home, {
        runId,
        input: { repos: ["hang"] },
        timeoutSeconds: 3,
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
      expect(await waitFor(box, "spawn slot 2", 30_000)).toBe(true);
      expect(await waitFor(box, "drain slot", 30_000)).toBe(true);
      expect(box.out).toMatch(
        /drain slot \d+ \(worker \S+\): \d+ idle worker\(s\) and no queued runs, pool 2 above workers.min 1/,
      );
      // Asked, never signalled: the flag is the whole mechanism.
      expect(box.out).toContain(
        "it exits at its next idle poll boundary, never mid-run",
      );
      expect(await waitFor(box, "slot released", 30_000)).toBe(true);

      // Converged at min and stayed there — a drain that is immediately undone
      // by the next tick's spawn is a busy loop, not a scale-down.
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        expect(await poolSize(dir)).toBeLessThanOrEqual(2);
        await Bun.sleep(200);
      }
      expect(await poolSize(dir)).toBe(1);
      expect(box.out.split("spawn slot").length - 1).toBe(2); // slots 1 and 2, no third
    } finally {
      await killPool(box, dir);
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
