import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-serve-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
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
import {
  CLOSE_CONNECTIONS_AFTER_MS,
  CONNECTOR_STOP_TIMEOUT_MS,
  HARD_EXIT_MS,
  serveLockPath,
  stopBounded,
} from "./serve.mjs";
import { openDb } from "../lib/db.mjs";
import { freePort, until } from "../lib/test-helpers-timing.mjs";
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

function connectorFixture({
  connectorSource,
  name = "factory/test-connector",
}) {
  const root = tmpDir("evrt-serve-connector-root-");
  const extension = path.join(root, "connector");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    path.join(extension, "factory-extension.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      contributes: { connectors: { test: "./connector.mjs" } },
    }),
  );
  writeFileSync(path.join(extension, "connector.mjs"), connectorSource);
  mkdirSync(path.join(root, "config"), { recursive: true });
  // A literal, minimal policy: the fixture must never inherit the checkout's
  // config/policy.yaml, which is instance configuration on the operator box
  // and is absent in a fresh worktree.
  writeFileSync(
    path.join(root, "config", "policy.yaml"),
    [
      "packs: []",
      "models:",
      "  claude: { strong: default, standard: sonnet, light: haiku }",
      "  pi: { strong: pi-strong, standard: pi-standard, light: pi-light }",
      "  agy: { strong: agy, standard: agy, light: agy }",
      "  cursor: { strong: cursor, standard: cursor, light: cursor }",
      "extensions:",
      `  - path: ${JSON.stringify(extension)}`,
      "",
    ].join("\n"),
  );
  return root;
}

/** Serve child with captured output, in the shape `waitFor` expects. */
function spawnServeBox(args, env) {
  const child = spawnTracked("bun", [CLI, "serve", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => {
    out += b;
  });
  child.stderr.on("data", (b) => {
    out += b;
  });
  return {
    child,
    get out() {
      return out;
    },
  };
}

/**
 * Open a raw HTTP/1.1 keep-alive connection to the control API and leave it
 * idle, the way curl loops and the web UI do. `server.close` alone never
 * completes while such a socket exists.
 */
async function openKeepAlive(port) {
  const socket = connect({ host: API_HOST, port: Number(port) });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `GET /health HTTP/1.1\r\nHost: ${API_HOST}\r\nConnection: keep-alive\r\n\r\n`,
  );
  await new Promise((resolve) => socket.once("data", resolve));
  socket.on("error", () => {});
  return socket;
}

const HANGING_CONNECTOR = `export const id = "factory/test-connector:test";
export default async function start() {
  return {
    stop() { return new Promise(() => {}); },
    health() { return { ok: true }; },
  };
}
`;

describe("serve command", () => {
  test("registry ref swaps atomically and keeps last-good on invalid edits", async () => {
    const { createRegistryRef } = await import("./serve.mjs");
    let stamp = "registry:a";
    let candidate = { name: "a", anomalies: [] };
    let clock = Date.parse("2026-08-28T10:00:00Z");
    const logs = [];
    const ref = createRegistryRef({
      initial: candidate,
      load: () => {
        if (candidate instanceof Error) throw candidate;
        return candidate;
      },
      sourceStamp: () => stamp,
      now: () => clock,
      log: (line) => logs.push(line),
    });

    candidate = { name: "b", anomalies: [] };
    stamp = "registry:b";
    clock += 1000;
    expect(ref.poll()).toMatchObject({ changed: true, swapped: true });
    expect(ref.current.name).toBe("b");
    expect(ref.proxy.name).toBe("b");
    expect(ref.state()).toMatchObject({
      stamp: "registry:b",
      loadedAt: "2026-08-28T10:00:01.000Z",
      lastReloadError: null,
    });

    candidate = new Error("bad edges");
    stamp = "registry:bad-1";
    clock += 1000;
    expect(ref.poll()).toMatchObject({ changed: true, swapped: false });
    expect(ref.current.name).toBe("b");
    expect(ref.state().lastReloadError).toEqual({
      at: "2026-08-28T10:00:02.000Z",
      message: "bad edges",
    });
    stamp = "registry:bad-2";
    ref.poll();
    expect(logs.filter((line) => line.includes("bad edges"))).toHaveLength(1);

    candidate = { name: "c", anomalies: [] };
    stamp = "registry:c";
    clock += 1000;
    ref.poll();
    expect(ref.current.name).toBe("c");
    expect(ref.state().lastReloadError).toBeNull();
  });

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

  test("a stalled Linear ticket read cannot wedge /health past the tick budget (#1835 AC3)", async () => {
    const home = tmpDir("evrt-serve-linear-stall-");
    const reposRoot = tmpDir("evrt-serve-linear-stall-repos-");
    mkdirSync(path.join(reposRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(reposRoot, "config", "repos.yaml"),
      [
        "repos:",
        "  - name: gated",
        "    path: /tmp/nowhere",
        "    base: develop",
        "    team: WM",
        "    project: Factory",
        "    worktree_up: bin/up",
        "    worktree_down: bin/down",
        "    worktree_root: /tmp/worktrees",
        "    escalate_paths: []",
        "",
      ].join("\n"),
    );
    // Minimal literal policy: the registry needs full model tier mappings and
    // must not inherit the checkout's instance config/policy.yaml.
    writeFileSync(
      path.join(reposRoot, "config", "policy.yaml"),
      [
        "packs: []",
        "models:",
        "  claude: { strong: default, standard: sonnet, light: haiku }",
        "  pi: { strong: pi-strong, standard: pi-standard, light: pi-light }",
        "  agy: { strong: agy, standard: agy, light: agy }",
        "  cursor: { strong: cursor, standard: cursor, light: cursor }",
        "",
      ].join("\n"),
    );
    // A Linear CLI stand-in that never answers: without a read timeout the
    // planner's synchronous execFileSync would block the serve event loop for
    // the child's full lifetime and /health would miss the web proxy's 10s.
    const slowCli = path.join(home, "slow-linear.mjs");
    writeFileSync(
      slowCli,
      "await new Promise((resolve) => setTimeout(resolve, 60_000));\n",
    );
    const port = freePort();
    const box = spawnServeBox(["--port", port], {
      FACTORY_EVENT_HOME: home,
      FACTORY_REPOS_ROOT: reposRoot,
      FACTORY_LINEAR_CLI: slowCli,
      FACTORY_LINEAR_READ_TIMEOUT_MS: "1500",
    });
    try {
      expect(await waitFor(box, "control API on", 8000)).toBe(true);
      const { admitEvent } = await import("../lib/intake.mjs");
      const { loadRegistry } = await import("../lib/registry.mjs");
      const db = openDb(path.join(home, "runtime.db"));
      const result = admitEvent(
        db,
        loadRegistry(),
        {
          schemaVersion: "factory.event/v1",
          eventId: "linear-stall-1",
          type: "factory.dispatch.requested",
          source: "operator-webhook",
          subject: "factory",
          occurredAt: new Date().toISOString(),
          correlationId: "linear-stall-1",
          causationId: null,
          payload: { repo: "gated", ticket: "WM-1835" },
        },
        { now: Date.now() },
      );
      expect(result.admitted).toBe(true);
      // The next tick stalls in the fake CLI; the execFileSync timeout must
      // abort it and record a bounded read failure instead of sleeping 60s.
      // The exact reason is not the acceptance criterion and has already
      // shifted once with the read-refusal work (#1886): the tick may record
      // the raw ETIMEDOUT, or refuse the read outright once the bounded read
      // budget is spent. Either is a correct non-wedge outcome, so match the
      // family of bounded-read refusals rather than one spelling. What stays
      // strict is the /health assertion below.
      const planError = () => {
        const row = db
          .query(
            `SELECT last_plan_error FROM events WHERE event_id = 'linear-stall-1'`,
          )
          .get();
        return String(row?.last_plan_error ?? "");
      };
      const reason = await until(
        "the stalled Linear read to be recorded as bounded",
        () => {
          const out = planError();
          return /ETIMEDOUT|linear_read_|read_budget/.test(out) ? out : null;
        },
        { timeoutMs: 15_000 },
      );
      expect(reason).toMatch(/ETIMEDOUT|linear_read_|read_budget/);
      // Retries keep stalling one bounded read per tick; a /health probe that
      // lands mid-stall still answers inside the web proxy's 10s budget.
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(9_000),
      });
      expect(res.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(9_000);
    } finally {
      box.child.kill("SIGTERM");
      await exitOf(box.child);
    }
  }, 60_000);

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

  test("SIGTERM closes the server when a connector stop never resolves", async () => {
    const home = tmpDir("evrt-serve-hanging-stop-");
    const port = freePort();
    const root = connectorFixture({ connectorSource: HANGING_CONNECTOR });
    const box = spawnServeBox(["--port", port], {
      FACTORY_EVENT_HOME: home,
      FACTORY_EVENT_ENV: "live",
      FACTORY_REPOS_ROOT: root,
    });
    const { child } = box;
    try {
      expect(await waitFor(box, "control API on", 8000)).toBe(true);
      const started = Date.now();
      child.kill("SIGTERM");
      expect((await exitOf(child, HARD_EXIT_MS)).code).toBe(0);
      expect(Date.now() - started).toBeLessThan(HARD_EXIT_MS);
      expect(box.out).toContain(
        `connector stop: timed out after ${CONNECTOR_STOP_TIMEOUT_MS}ms`,
      );
      expect(box.out).not.toContain("shutdown exceeded");
    } finally {
      if (child.exitCode == null) child.kill("SIGKILL");
      await exitOf(child);
    }
  });

  test("SIGTERM with an idle keep-alive client exits inside the supervisor grace and releases the lock after the port (#1585)", async () => {
    // `await_daemon` SIGKILLs 3 s after SIGTERM. A keep-alive socket keeps
    // `server.close` from ever calling back, so before #1585 the hard exit
    // (3 s) tied the kill and the lock file was left to the kernel.
    const home = tmpDir("evrt-serve-keepalive-");
    const port = freePort();
    const root = connectorFixture({ connectorSource: HANGING_CONNECTOR });
    const box = spawnServeBox(["--port", port], {
      FACTORY_EVENT_HOME: home,
      FACTORY_EVENT_ENV: "live",
      FACTORY_REPOS_ROOT: root,
    });
    const { child } = box;
    const lockFile = serveLockPath(home);
    let socket = null;
    try {
      expect(await waitFor(box, "control API on", 8000)).toBe(true);
      expect(existsSync(lockFile)).toBe(true);
      socket = await openKeepAlive(port);
      const started = Date.now();
      child.kill("SIGTERM");
      const exit = await exitOf(child, HARD_EXIT_MS);
      const elapsed = Date.now() - started;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(elapsed).toBeLessThan(HARD_EXIT_MS);
      // The graceful path ran to completion: close called back, so the lock
      // went after the socket — not through the hard-exit backstop.
      expect(box.out).not.toContain("shutdown exceeded");
      expect(existsSync(lockFile)).toBe(false);
      const probe = createServer();
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(Number(port), API_HOST, resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
    } finally {
      socket?.destroy();
      if (child.exitCode == null) child.kill("SIGKILL");
      await exitOf(child);
    }
  });

  test("a shutdown step that never settles is bounded to its budget", async () => {
    // The planner thread stop and the connector stop share one budget and run
    // concurrently; a hung `worker.terminate()` must return inside it so the
    // whole sequence (stops + close) stays under HARD_EXIT_MS.
    expect(CONNECTOR_STOP_TIMEOUT_MS + CLOSE_CONNECTIONS_AFTER_MS).toBeLessThan(
      HARD_EXIT_MS,
    );
    expect(HARD_EXIT_MS).toBeLessThan(3_000);
    const started = Date.now();
    await Promise.all([
      stopBounded("planner stop", () => new Promise(() => {}), 200),
      stopBounded("connector stop", () => new Promise(() => {}), 200),
    ]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(400);
    // A throwing stop is logged, not propagated.
    await stopBounded(
      "planner stop",
      () => Promise.reject(new Error("x")),
      200,
    );
  });

  test("a busy port is named, not a silent exit 1 (WM-1037)", async () => {
    const home = tmpDir("evrt-busy-port-");
    const port = freePort();
    const stoppedFile = path.join(home, "connector-stopped");
    const root = connectorFixture({
      connectorSource: `import { writeFileSync } from "node:fs";
export const id = "factory/test-connector:test";
export default async function start() {
  return {
    stop() { writeFileSync(${JSON.stringify(stoppedFile)}, "stopped\\n"); },
    health() { return { ok: true }; },
  };
}
`,
    });
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
        env: {
          ...process.env,
          FACTORY_EVENT_HOME: home,
          FACTORY_EVENT_ENV: "live",
          FACTORY_REPOS_ROOT: root,
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
      expect(await waitFor(box, "already in use", 8000)).toBe(true);
      expect(out).toContain(`port ${port} is already in use`);
      expect(out).not.toContain("control API on");
      expect((await exitOf(child)).code).not.toBe(0);
      expect(readFileSync(stoppedFile, "utf8")).toBe("stopped\n");
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

  test("tick logs one stale-proposal summary when it expires a retired scheduler row (#1706)", async () => {
    const { tick } = await import("../cli.mjs");
    const { emitDueTicks } = await import("../lib/schedules.mjs");
    const { planAdmittedEvents } = await import("../lib/planner.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-30T13:00:00.000Z");
    const current = loadRegistry();
    const registry = {
      ...current,
      schedules: {
        reaper: {
          every: "60m",
          eventType: "clock.tick.reaper",
          catchUp: "none",
          singleton: true,
          approval: "auto",
          enabled: true,
        },
      },
    };
    emitDueTicks(db, registry, { now });
    planAdmittedEvents(db, registry, { now, policyVersion: "git:old" });
    const stale = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
    };
    stale.agents.delete("reaper@1");
    delete stale.eventTypes["clock.tick.reaper"];
    const logs = [];

    await tick({
      db,
      registry: stale,
      now,
      policyVersion: "git:test",
      skipPlan: true,
      log: (line) => logs.push(line),
    });

    expect(logs).toEqual(
      expect.arrayContaining([
        "proposal staleness: skipped 0 pending chain row(s) (0 memoised registry-stale); expired 1 unreplannable scheduler row(s)",
      ]),
    );
    db.close();
  });

  test("tick bounds orphaned non-run proposal sweeps and logs the remainder", async () => {
    const { tick } = await import("../cli.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-30T13:00:00.000Z");
    const at = new Date(now).toISOString();
    const insertEvent = db.query(
      `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, admitted_at, status)
       VALUES ('test', ?, 'test.event', ?, ?, '{}', 'hash', ?, ?)`,
    );
    insertEvent.run("moved-on-1", at, at, at, "admitted");
    insertEvent.run("moved-on-2", at, at, at, "admitted");
    insertEvent.run("moved-on-3", at, at, at, "admitted");
    insertEvent.run("still-parked", at, at, at, "human_needed");
    const insertProposal = db.query(
      `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
       VALUES (?, 'test', ?, 'human_needed', 'open', ?, 1800)`,
    );
    insertProposal.run("orphaned-1", "moved-on-1", at);
    insertProposal.run("orphaned-2", "moved-on-2", at);
    insertProposal.run("orphaned-3", "moved-on-3", at);
    insertProposal.run("parked", "still-parked", at);
    const logs = [];

    await tick({
      db,
      registry: loadRegistry(),
      now,
      policyVersion: "git:test",
      skipPlan: true,
      proposalSweepLimit: 2,
      log: (line) => logs.push(line),
    });

    expect(
      db.query("SELECT status FROM proposals WHERE id = 'orphaned-1'").get(),
    ).toEqual({ status: "expired" });
    expect(
      db.query("SELECT status FROM proposals WHERE id = 'orphaned-2'").get(),
    ).toEqual({ status: "expired" });
    expect(
      db.query("SELECT status FROM proposals WHERE id = 'orphaned-3'").get(),
    ).toEqual({ status: "open" });
    expect(
      db.query("SELECT status FROM proposals WHERE id = 'parked'").get(),
    ).toEqual({ status: "open" });
    expect(logs).toContain(
      "proposals: expired 2 orphaned human_needed/noop row(s) (1 remaining)",
    );

    logs.length = 0;
    await tick({
      db,
      registry: loadRegistry(),
      now: now + 1_000,
      policyVersion: "git:test",
      skipPlan: true,
      proposalSweepLimit: 2,
      log: (line) => logs.push(line),
    });
    expect(
      db.query("SELECT status FROM proposals WHERE id = 'orphaned-3'").get(),
    ).toEqual({ status: "expired" });
    expect(logs).toContain(
      "proposals: expired 1 orphaned human_needed/noop row(s) (0 remaining)",
    );
    db.close();
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

  test("tick warns when unparsable results hold artifact GC", async () => {
    const { tick } = await import("../cli.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const db = openDb(":memory:");
    const now = Date.parse("2026-08-18T14:02:11.000Z");
    const storeRoot = tmpDir("evrt-gc-held-store-");
    const orphan = path.join(storeRoot, "c".repeat(64));
    writeFileSync(orphan, "orphan bytes");
    const stale = new Date(now - 8 * 24 * 60 * 60 * 1000);
    utimesSync(orphan, stale, stale);
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES ('invalid-result', 1, '{not json', 'sha256:x', '{}', '{}', ?)`,
    ).run(new Date(now).toISOString());
    const logs = [];

    await tick({
      db,
      registry: loadRegistry(),
      now,
      policyVersion: "git:test",
      lastPrune: 0,
      storeRoot,
      log: (line) => logs.push(line),
    });

    expect(logs).toContain(
      "artifacts: GC held — 1 unparsable results row(s); 1 orphan(s) retained",
    );
    expect(existsSync(orphan)).toBe(true);
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
