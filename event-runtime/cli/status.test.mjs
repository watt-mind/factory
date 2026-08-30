import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-status-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.mjs";
import {
  CLI,
  DEAD_PORT,
  loadAdjustedTimeout,
  runCli,
  spawnLiveServe,
  throwawayRunDir,
  registerCliTmpCleanup,
} from "./test-helpers.mjs";

registerCliTmpCleanup();

describe("status and doctor commands", () => {
  test("status against a dead port says serve is not running, non-zero exit", () => {
    const r = runCli(["status"], { FACTORY_EVENT_PORT: DEAD_PORT });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain(
      `control API not reachable on 127.0.0.1:${DEAD_PORT} — start it with: bun event-runtime/cli.mjs serve`,
    );
  });

  test("ps against a dead port says serve is not running, non-zero exit", () => {
    const r = runCli(["ps"], { FACTORY_EVENT_PORT: DEAD_PORT });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain(
      `control API not reachable on 127.0.0.1:${DEAD_PORT} — start it with: bun event-runtime/cli.mjs serve`,
    );
  });

  test("doctor against a dead port says serve is not running, non-zero exit", () => {
    const r = runCli(["doctor"], { FACTORY_EVENT_PORT: DEAD_PORT });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain(
      `control API not reachable on 127.0.0.1:${DEAD_PORT} — start it with: bun event-runtime/cli.mjs serve`,
    );
  });

  test("doctor reports anomalies (stale workers, unreferenced artifacts, orphaned workspaces, proposals piling up) and exits non-zero (OPS-428, WM-124)", async () => {
    const { getAnomalyLines } = await import("../cli.mjs");
    const statusPayload = {
      anomalies: {
        stalledWorkers: [
          {
            workerId: "w-dead",
            host: "node-1",
            runId: "run-99",
            lastSeen: "2026-08-14T10:00:00Z",
          },
        ],
        stoppedSchedules: [{ loop: "nightly", error: null, intervalsLate: 3 }],
        proposalsPilingUp: [{ loop: "reconcile-bj29", count: 4, threshold: 3 }],
        noWorkers: true,
        orphanedWorkspaces: ["/tmp/orphaned-ws-1"],
        unreferencedArtifacts: 5,
        customAnomaly: "something unexpected",
      },
      artifacts: {
        orphans: 5,
        orphanBytes: 1024,
      },
    };

    const lines = getAnomalyLines(statusPayload);
    expect(
      lines.some((l) => l.includes("stalled worker w-dead on node-1")),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes("stopped schedule nightly: 3 intervals late"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(
          "proposals piling up for schedule reconcile-bj29: 4 open proposals exist (threshold 3)",
        ),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.includes("no live workers with queued runs") ||
          l.includes("no workers"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes("orphaned workspace: /tmp/orphaned-ws-1")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("unreferenced artifacts: 5"))).toBe(
      true,
    );
    expect(
      lines.some((l) => l.includes("customAnomaly: something unexpected")),
    ).toBe(true);
  });

  test(
    "doctor against a healthy live serve outputs anomalies none and exits 0",
    async () => {
      const home = tmpDir("evrt-doc-healthy-");
      const controlApiToken = "doctor-healthy-control-token";
      const box = await spawnLiveServe({
        home,
        extraEnv: {
          FACTORY_EVENT_SECRET: "test-secret",
          FACTORY_GITHUB_WEBHOOK_SECRET: "test-gh-secret",
          FACTORY_CONTROL_API_TOKEN: controlApiToken,
        },
      });
      let docRes;
      try {
        expect(box.out).toContain("control API on");
        docRes = spawnSync("bun", [CLI, "doctor"], {
          encoding: "utf8",
          env: {
            ...process.env,
            FACTORY_EVENT_HOME: home,
            FACTORY_EVENT_PORT: box.port,
            FACTORY_RUN_DIR: throwawayRunDir(),
            FACTORY_CONTROL_API_TOKEN: controlApiToken,
          },
        });
      } finally {
        box.child.kill("SIGTERM");
        await new Promise((resolve) => box.child.once("exit", resolve));
      }
      expect(docRes.status).toBe(0);
      expect(docRes.stdout).toContain("anomalies");
      expect(docRes.stdout).toContain("none");
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "doctor against a live serve with an anomaly exits non-zero and reports anomaly",
    async () => {
      const home = tmpDir("evrt-doc-anomaly-");
      const db = openDb(path.join(home, "runtime.db"));
      const at = new Date(Date.now() - 200_000).toISOString();
      db.query(
        `INSERT INTO workers (worker_id, host, pid, labels_json, adapters, started_at, last_seen, state, current_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "w-stalled-test",
        "host-1",
        1234,
        "{}",
        "fake",
        at,
        at,
        "busy",
        "run-stalled-test",
      );
      db.close();

      const controlApiToken = "doctor-anomaly-control-token";
      const box = await spawnLiveServe({
        home,
        extraEnv: { FACTORY_CONTROL_API_TOKEN: controlApiToken },
      });
      let docRes;
      try {
        expect(box.out).toContain("control API on");
        docRes = spawnSync("bun", [CLI, "doctor"], {
          encoding: "utf8",
          env: {
            ...process.env,
            FACTORY_EVENT_HOME: home,
            FACTORY_EVENT_PORT: box.port,
            FACTORY_RUN_DIR: throwawayRunDir(),
            FACTORY_CONTROL_API_TOKEN: controlApiToken,
          },
        });
      } finally {
        box.child.kill("SIGTERM");
        await new Promise((resolve) => box.child.once("exit", resolve));
      }
      expect(docRes.status).not.toBe(0);
      expect(docRes.stdout).toContain("stalled worker w-stalled-test");
    },
    loadAdjustedTimeout(30_000),
  );
});

describe("pool visibility in status/doctor (WM-226)", () => {
  test("no pool ever started → no pool line and no anomaly (single-worker stacks look unchanged)", async () => {
    const { getPoolLines, readPool } = await import("../cli.mjs");
    const dir = tmpDir("evrt-pool-view-none-");
    try {
      const view = getPoolLines(readPool(dir), {
        runs: { byState: { QUEUED: 4 } },
      });
      expect(view.line).toBeNull();
      expect(view.anomalies).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a leftover fastExits: 0 crash-loop file after a clean stop prints no pool line", async () => {
    const { getPoolLines, readPool } = await import("../cli.mjs");
    const dir = tmpDir("evrt-pool-leftover-");
    try {
      // A clean pool stop removes the pidfiles but keeps the durable backoff
      // counter; on its own that must not fabricate a "supervisor absent" line.
      writeFileSync(
        path.join(dir, "worker-1.crash-loop.json"),
        JSON.stringify({ fastExits: 0, nextAttemptAt: null }),
      );
      const view = getPoolLines(readPool(dir), {
        runs: { byState: { QUEUED: 3 } },
      });
      expect(view.line).toBeNull();
      expect(view.anomalies).toEqual([]);

      // A real backoff counter is still worth showing.
      writeFileSync(
        path.join(dir, "worker-1.crash-loop.json"),
        JSON.stringify({ fastExits: 2, nextAttemptAt: null }),
      );
      expect(getPoolLines(readPool(dir), {}).line).toContain(
        "crashLoops slot 1: 2",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live supervisor reports its pool size; a dead one with a queue is an anomaly", async () => {
    const { getPoolLines, readPool } = await import("../cli.mjs");
    const dir = tmpDir("evrt-pool-view-");
    try {
      // This process stands in for a live supervisor and a live worker.
      writeFileSync(path.join(dir, "supervisor.pid"), `${process.pid}\n`);
      writeFileSync(path.join(dir, "worker-1.pid"), `${process.pid}\n`);
      writeFileSync(path.join(dir, "worker-1.id"), "worker_live\n");
      let view = getPoolLines(readPool(dir), {
        runs: { byState: { QUEUED: 2 } },
      });
      expect(view.line).toContain(`supervisor live (pid ${process.pid})`);
      expect(view.line).toContain("workers 1");
      expect(view.anomalies).toEqual([]);

      // A drained slot is visible while it winds down.
      writeFileSync(path.join(dir, "worker-1.drain"), "scale-down\n");
      expect(getPoolLines(readPool(dir), {}).line).toContain("(1 draining)");

      writeFileSync(
        path.join(dir, "worker-1.crash-loop.json"),
        JSON.stringify({ fastExits: 3, nextAttemptAt: Date.now() + 2_000 }),
      );
      expect(getPoolLines(readPool(dir), {}).line).toContain(
        "crashLoops slot 1: 3",
      );

      // A queue with waiting runs and a dead supervisor is the §13 anomaly:
      // nothing is left that can grow the pool behind the workers still up.
      writeFileSync(path.join(dir, "supervisor.pid"), "2147483646\n");
      view = getPoolLines(readPool(dir), { runs: { byState: { QUEUED: 2 } } });
      expect(view.line).toContain("supervisor DEAD");
      expect(view.anomalies).toEqual([
        "worker pool supervisor is dead (stale pid 2147483646) with 2 queued run(s)",
      ]);

      // Dead but nothing waiting is a stopped stack, not an anomaly.
      expect(
        getPoolLines(readPool(dir), { runs: { byState: { QUEUED: 0 } } })
          .anomalies,
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
