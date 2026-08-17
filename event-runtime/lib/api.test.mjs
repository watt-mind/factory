import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GH_SECRET,
  PV,
  SECRET,
  apiClient,
  deregisterWorker,
  envelope,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  makeServer,
  mkdirSync,
  mkdtempSync,
  observedModelFromTranscript,
  openDb,
  os,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  rejection,
  repoNamesFromInput,
  registry,
  runOnce,
  sign,
  startApi,
  utimesSync,
  writeFileSync,
} from "./api-test-helpers.mjs";
import { emitDueTicks } from "./schedules.mjs";

describe("schedule trigger metadata (WM-259)", () => {
  test("run and trigger return the unchanged next scheduled tick", async () => {
    const nowMs = Date.parse("2026-08-17T11:35:00.000Z");
    const scheduleRegistry = {
      ...registry,
      schedules: {
        reaper: {
          ...registry.schedules.reaper,
          every: "60m",
          enabled: true,
          payload: { repo: "factory" },
        },
      },
    };
    const s = await makeServer({ registry: scheduleRegistry, now: () => nowMs });
    try {
      emitDueTicks(s.db, scheduleRegistry, {
        now: Date.parse("2026-08-17T11:00:00.000Z"),
      });

      for (const action of ["run", "trigger"]) {
        const res = await fetch(s.url(`/schedules/reaper/${action}`), {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.schedule).toMatchObject({
          loop: "reaper",
          repo: "factory",
          lastSlot: "2026-08-17T11:00:00.000Z",
          nextDue: "2026-08-17T12:00:00.000Z",
          stopped: false,
        });
      }

      const operatorEvents = s.db
        .query(`SELECT envelope_json FROM events WHERE source = 'operator' ORDER BY event_id`)
        .all()
        .map((row) => JSON.parse(row.envelope_json));
      expect(operatorEvents).toHaveLength(2);
      expect(operatorEvents.every((event) => event.payload.repo === "factory")).toBe(true);

      const schedules = await (await fetch(s.url("/schedules"))).json();
      expect(schedules.schedules[0]).toMatchObject({
        lastSlot: "2026-08-17T11:00:00.000Z",
        nextDue: "2026-08-17T12:00:00.000Z",
        stopped: false,
      });
    } finally {
      s.close();
    }
  });
});

describe("environment identity (webui chip)", () => {
  test("health and status expose the env the server was started with", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-env-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "dev", home: dir, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const client = apiClient({ port: server.address().port });
    try {
      const health = await client.health();
      expect(health.env).toEqual({ name: "dev", home: dir, adapter: "fake" });
      expect((await client.status()).env.name).toBe("dev");
    } finally {
      server.close();
    }
  });
});

describe("serve PID lock (OPS-458)", () => {
  test("acquireServeLock acquires lock in empty runtime home and releaseServeLock removes it", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } =
      await import("../cli.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-"));
    const lock = acquireServeLock(home, 7381);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(7381);

    const lockFile = serveLockPath(home);
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(lockFile)).toBe(true);
    const data = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(7381);

    releaseServeLock(home);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("acquireServeLock fails when locked by a live process with clear PID and port", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } =
      await import("../cli.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-"));
    const lockFile = serveLockPath(home);
    const { writeFileSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");

    // Spawn a dummy process to be a live owner
    const sleeper = spawn("sleep", ["60"]);
    try {
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: sleeper.pid,
          port: 7381,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      expect(() => acquireServeLock(home, 7382)).toThrow(
        /already locked by PID \d+ \(port 7381\)/,
      );
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  test("acquireServeLock reclaims a stale lock from a dead process", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } =
      await import("../cli.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-"));
    const lockFile = serveLockPath(home);
    const { writeFileSync, readFileSync } = await import("node:fs");

    // Use a PID that does not exist
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999999,
        port: 7381,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const lock = acquireServeLock(home, 7385);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(7385);
    const data = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(7385);
    releaseServeLock(home);
  });

  test("concurrent duplicate serve on same home fails second instance and releasing first allows next", async () => {
    const { spawn } = await import("node:child_process");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-cli-"));
    const port1 = String(59500 + (process.pid % 200));
    const port2 = String(59700 + (process.pid % 200));
    const CLI = path.resolve(import.meta.dir, "../cli.mjs");

    const serve1 = spawn("bun", [CLI, "serve", "--port", port1], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out1 = "";
    serve1.stdout.on("data", (b) => {
      out1 += b;
    });
    serve1.stderr.on("data", (b) => {
      out1 += b;
    });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out1.includes("control API on")) {
      await Bun.sleep(100);
    }
    expect(out1).toContain("control API on");

    // Second serve targeting same home should fail immediately
    const serve2 = spawn("bun", [CLI, "serve", "--port", port2], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out2 = "";
    serve2.stdout.on("data", (b) => {
      out2 += b;
    });
    serve2.stderr.on("data", (b) => {
      out2 += b;
    });
    const exitCode2 = await new Promise((resolve) =>
      serve2.on("exit", resolve),
    );
    expect(exitCode2).not.toBe(0);
    expect(out2).toContain("already locked by PID");

    // Kill serve1
    serve1.kill("SIGTERM");
    await new Promise((resolve) => serve1.on("exit", resolve));

    // Now a third serve should succeed
    const serve3 = spawn("bun", [CLI, "serve", "--port", port2], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out3 = "";
    serve3.stdout.on("data", (b) => {
      out3 += b;
    });
    serve3.stderr.on("data", (b) => {
      out3 += b;
    });

    const deadline3 = Date.now() + 8000;
    while (Date.now() < deadline3 && !out3.includes("control API on")) {
      await Bun.sleep(100);
    }
    try {
      expect(out3).toContain("control API on");
    } finally {
      serve3.kill("SIGTERM");
      await new Promise((resolve) => serve3.on("exit", resolve));
    }
  });
});
