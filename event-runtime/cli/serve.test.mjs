import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-serve-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { API_HOST } from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";
import { freePort } from "../lib/test-helpers-timing.mjs";
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
  spawnTracked,
  spawnSupervisor,
  spawnWorker,
  waitFor,
  registerCliTmpCleanup,
  registerTestProcessCleanup,
} from "./test-helpers.mjs";

registerCliTmpCleanup();
registerTestProcessCleanup(import.meta.url);

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
