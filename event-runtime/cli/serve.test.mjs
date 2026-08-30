import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-serve-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { API_HOST } from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";
import { freePort } from "../lib/test-helpers-timing.mjs";
import {
  CLI,
  DEAD_PORT,
  assertHealthyLiveServe,
  cleanupTrackedProcesses,
  editStampRoot,
  exitOf,
  killPool,
  makeStampRoot,
  poolSize,
  runCli,
  runNotifierDeliveryCase,
  seedRun,
  spawnTracked,
  spawnSupervisor,
  spawnWorker,
  waitFor,
  registerCliTmpCleanup,
  registerTestProcessCleanup,
} from "./test-helpers.mjs";

registerCliTmpCleanup();
registerTestProcessCleanup(import.meta.url);

/**
 * Every live `serve --adapter-override fake` whose cwd is `cwd`, by pid. Linux
 * exposes cwd through procfs; lsof provides the equivalent elsewhere. This is
 * the same ownership signal `bin/worktree-down.sh` sweeps on (#1379).
 */
function fakeServesRootedAt(cwd) {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const serves = [];
  for (const line of ps.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    if (!/cli\.mjs\s+serve\s.*--adapter-override\s+fake(\s|$)/.test(match[2]))
      continue;
    serves.push(Number(match[1]));
  }
  return serves.filter((pid) => {
    if (process.platform === "linux") {
      const link = spawnSync("readlink", [`/proc/${pid}/cwd`], {
        encoding: "utf8",
      });
      return link.status === 0 && link.stdout.trim() === cwd;
    }
    const lsof = spawnSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { encoding: "utf8" },
    );
    let realCwd = cwd;
    try {
      if (existsSync(cwd)) realCwd = realpathSync(cwd);
    } catch {
      /* ignore */
    }
    const lines = lsof.stdout.split("\n");
    return lines.includes(`n${cwd}`) || lines.includes(`n${realCwd}`);
  });
}

describe("serve command", () => {
  test("serve --watch re-execs under bun --watch and binds", async () => {
    const home = tmpDir("evrt-watch-");
    const port = freePort();
    const child = spawnTracked(
      "bun",
      [CLI, "serve", "--watch", "--port", port],
      {
        env: { ...process.env, FACTORY_EVENT_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    const box = {
      child,
      get out() {
        return out;
      },
    };
    expect(await waitFor(box, "control API on", 8000)).toBe(true);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(out).toContain(
      "serve --watch: restarting on event-runtime/ changes",
    );
    expect(out).toContain("control API on");
  });

  test("serve binds the control API, starts the loop, and answers /health", async () => {
    const home = tmpDir("evrt-serve-");
    const port = freePort();
    const child = spawnTracked("bun", [CLI, "serve", "--port", port], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    const box = {
      child,
      get out() {
        return out;
      },
    };
    expect(await waitFor(box, "control API on", 8000)).toBe(true);
    let health;
    try {
      expect(out).toContain("control API on");
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.ok).toBe(true);
      health = await res.json();
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    expect(health.ok).toBe(true);
  });

  test("serve clearly warns when FACTORY_CONTROL_API_TOKEN is unset", async () => {
    const home = tmpDir("evrt-serve-no-token-");
    const port = freePort();
    const child = spawnTracked("bun", [CLI, "serve", "--port", port], {
      env: {
        ...process.env,
        FACTORY_EVENT_HOME: home,
        FACTORY_CONTROL_API_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    const box = {
      child,
      get out() {
        return out;
      },
    };
    try {
      expect(
        await waitFor(box, "FACTORY_CONTROL_API_TOKEN is unset", 8000),
      ).toBe(true);
      expect(out).toContain(
        "all non-intake control API routes will return 503",
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });

  test("a busy port is named, not a silent exit 1 (WM-1037)", async () => {
    const home = tmpDir("evrt-busy-port-");
    const port = freePort();
    // Hold the port the way a leftover runtime from an aborted concurrent job
    // does. Before WM-1037 serve died here with no output at all, so every
    // waiter downstream reported "never printed control API on" and the real
    // cause — someone else owns this port — never reached the log.
    const stranger = createServer((_req, res) => res.end("stranger"));
    // Bind the same interface the control API uses. A wildcard bind does not
    // conflict with a later 127.0.0.1 bind on macOS, so the collision would
    // not reproduce.
    await new Promise((resolve) =>
      stranger.listen(Number(port), API_HOST, resolve),
    );
    try {
      const child = spawnTracked("bun", [CLI, "serve", "--port", port], {
        env: { ...process.env, FACTORY_EVENT_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (b) => {
        out += b;
      });
      child.stderr.on("data", (b) => {
        out += b;
      });
      const box = {
        child,
        get out() {
          return out;
        },
      };
      expect(await waitFor(box, "already in use", 8000)).toBe(true);
      expect(out).toContain(`port ${port} is already in use`);
      expect(out).not.toContain("control API on");
      expect((await exitOf(child)).code).not.toBe(0);
    } finally {
      await new Promise((resolve) => stranger.close(resolve));
    }
  });

  test("serve --adapter-override pi is accepted at the serve call site (OPS-517)", async () => {
    const home = tmpDir("evrt-serve-pi-");
    const port = freePort();
    const child = spawnTracked(
      "bun",
      [CLI, "serve", "--adapter-override", "pi", "--port", port],
      {
        env: { ...process.env, FACTORY_EVENT_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    const box = {
      child,
      get out() {
        return out;
      },
    };
    expect(await waitFor(box, "control API on", 8000)).toBe(true);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(out).not.toContain('unknown --adapter-override "pi"');
    expect(out).toContain('adapter override: all new run specs use "pi"');
    expect(out).toContain("control API on");
  });

  test("an aborted test leaves no cwd-bound serve --adapter-override fake behind (#1379)", async () => {
    // Regression for the orphaned fake serves found on the operator box: a
    // fake serve started through the shared helper must run detached in its
    // own process group and die with the test that owned it, even when that
    // test never reaches its own kill (timeout, thrown assertion). The spawn
    // is rooted in a throwaway cwd so ownership is asserted the way
    // worktree-down asserts it: by cwd, not by pidfile.
    const home = tmpDir("evrt-serve-orphan-");
    const cwd = tmpDir("evrt-serve-orphan-cwd-");
    const port = freePort();
    const child = spawnTracked(
      "bun",
      [CLI, "serve", "--adapter-override", "fake", "--port", port],
      {
        cwd,
        env: { ...process.env, FACTORY_EVENT_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    const box = {
      child,
      get out() {
        return out;
      },
    };
    expect(await waitFor(box, "control API on", 8000)).toBe(true);
    expect(fakeServesRootedAt(cwd)).toEqual([child.pid]);

    // Abort the test the way a timed-out/failed test does: the per-test
    // cleanup hook runs, the test body never calls child.kill().
    await cleanupTrackedProcesses({ scope: "test" });
    await exitOf(child);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && fakeServesRootedAt(cwd).length > 0) {
      await Bun.sleep(25);
    }
    expect(fakeServesRootedAt(cwd)).toEqual([]);
  });

  test("tick runs notify as an isolated subsystem (WM-65): a throwing notifier step cannot break the tick", async () => {
    const { tick, TICK_SUBSYSTEMS } = await import("../cli.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    expect(TICK_SUBSYSTEMS).toContain("notify");

    const db = openDb(":memory:");
    const logs = [];
    let chainsRan = false;
    await tick({
      db,
      registry: loadRegistry(),
      policyVersion: "git:test",
      log: (l) => logs.push(l),
      subsystems: {
        notify: () => {
          throw new Error("notifier exploded");
        },
        chains: () => {
          chainsRan = true;
        },
      },
    });
    expect(logs.some((l) => l.includes("tick notify: notifier exploded"))).toBe(
      true,
    );
    expect(chainsRan).toBe(true);
  });

  test("tick sweeps retained memo rows alongside artifact GC and logs the count", async () => {
    const { tick } = await import("../cli.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    db.query(
      `INSERT INTO memos (sha256, subject_type, subject_id, kind, created_at, expires_at)
       VALUES (?, 'repo', 'factory', 'repo-note', ?, ?)`,
    ).run("a".repeat(64), now - 100, now - 31 * 24 * 60 * 60 * 1000);
    const logs = [];
    await tick({
      db,
      registry: loadRegistry(),
      now,
      policyVersion: "git:test",
      lastPrune: 0,
      log: (line) => logs.push(line),
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM memos`).get().n).toBe(0);
    expect(logs).toContain("memos: swept 1 expired/retired/superseded memo(s)");
    db.close();
  });

  test("tick still prunes artifacts when the memo sweep throws", async () => {
    const { tick } = await import("../cli.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    db.query(
      `INSERT INTO memos (sha256, subject_type, subject_id, kind, created_at, expires_at)
       VALUES (?, 'repo', 'factory', 'repo-note', ?, ?)`,
    ).run("a".repeat(64), now - 100, now - 31 * 24 * 60 * 60 * 1000);
    // With a doomed row present the sweep's transaction touches memo_uses;
    // removing the table makes that step throw without affecting artifact GC.
    db.exec(`DROP TABLE memo_uses`);
    const storeRoot = tmpDir("evrt-gc-store-");
    const orphan = path.join(storeRoot, "b".repeat(64));
    writeFileSync(orphan, "orphan bytes");
    const stale = new Date(now - 8 * 24 * 60 * 60 * 1000);
    utimesSync(orphan, stale, stale);
    const logs = [];
    const result = await tick({
      db,
      registry: loadRegistry(),
      now,
      policyVersion: "git:test",
      lastPrune: 0,
      storeRoot,
      log: (line) => logs.push(line),
    });
    expect(logs.some((line) => line.startsWith("tick GC: memos: "))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(logs).toContain("artifacts: pruned 1 orphan(s), freed 12B");
    expect(db.query(`SELECT COUNT(*) AS n FROM memos`).get().n).toBe(1);
    expect(result.lastPrune).toBe(now);
    db.close();
  });

  test("tick sweeps stale notify-log markers on the hourly GC cadence", async () => {
    const { tick, PRUNE_INTERVAL_MS } = await import("../cli.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const { ensureNotifyLog } = await import("../lib/notify.mjs");
    const db = openDb(":memory:");
    const now = Date.now();
    ensureNotifyLog(db);
    db.query(
      `INSERT INTO notify_log (kind, target, message, sent_at)
       VALUES ('human_needed', 'test/resolved-event', 'old marker', ?)`,
    ).run(new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString());

    await tick({
      db,
      registry: loadRegistry(),
      policyVersion: "git:test",
      now,
      lastPrune: now - PRUNE_INTERVAL_MS - 1,
      subsystems: { notify: () => {} },
    });

    expect(db.query("SELECT COUNT(*) AS n FROM notify_log").get().n).toBe(0);
  });

  test("tick with FACTORY_EVENT_NOTIFY=1 pushes a human_needed park through the stub notifier exactly once", async () => {
    const { delivery } = await runNotifierDeliveryCase();
    expect(delivery.error).toBeNull();
    expect(delivery.exitCode).toBe(0);
  });

  test("notifier delivery immediately followed by healthy live serve stays durable across repeated runs (WM-402)", async () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const { delivery } = await runNotifierDeliveryCase();
      expect(delivery.error).toBeNull();
      await assertHealthyLiveServe();
    }
  });

  test("notifier cleanup quiesces a failed pending delivery before closing SQLite (WM-402)", async () => {
    await expect(
      runNotifierDeliveryCase({ failWhilePending: true }),
    ).rejects.toThrow(
      "intentional assertion failure while notifier delivery is pending",
    );
    await assertHealthyLiveServe();
  });
});
