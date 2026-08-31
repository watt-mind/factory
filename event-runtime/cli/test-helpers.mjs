import { afterAll, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { policyVersion } from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";
import { cleanupTmpDirs, tmpDir } from "../test-support/tmp.mjs";
export {
  cleanupTrackedProcesses,
  processOwnerWatchdogSource,
  registerTestProcessCleanup,
  spawnTracked,
  trackMarkedFakeRuntimeGroups,
  trackProcess,
  trackProcessGroupForPid,
  trackProcessGroupsMatching,
} from "../lib/test-helpers-process.mjs";
import { spawnTracked, trackProcess } from "../lib/test-helpers-process.mjs";
export {
  CI_LOAD_FACTOR,
  freePort,
  loadAdjustedTimeout,
  until,
} from "../lib/test-helpers-timing.mjs";
import {
  freePort,
  loadAdjustedTimeout,
  until,
} from "../lib/test-helpers-timing.mjs";

export const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** A loopback port nothing in these tests ever listens on. */
export const DEAD_PORT = "59987";

/** Register cleanup for this shared helper's cached temp-directory tracker. */
export function registerCliTmpCleanup() {
  afterAll(cleanupTmpDirs);
}

/**
 * A throwaway run dir, so nothing here reads this machine's real
 * ~/.factory/run — `status` reports the local worker pool from pidfiles
 * (WM-226), and a developer's own running stack must not change a test result.
 */
export const throwawayRunDir = () => tmpDir("evrt-cli-run-");

export function runCli(args, env = {}) {
  const home = tmpDir("evrt-cli-");
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FACTORY_EVENT_HOME: home,
      FACTORY_RUN_DIR: throwawayRunDir(),
      ...env,
    },
  });
  return { ...result, all: `${result.stdout}${result.stderr}` };
}

export async function awaitFile(file, label, { timeoutMs = 5000 } = {}) {
  timeoutMs = loadAdjustedTimeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await Bun.sleep(10);
  }
  throw new Error(`${label} did not appear within ${timeoutMs}ms`);
}

/** Wait for both durable writes made after an async notifier process exits. */
export async function awaitNotifierDelivery(
  db,
  target,
  { timeoutMs = 5000 } = {},
) {
  timeoutMs = loadAdjustedTimeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db
      .query(
        `SELECT i.delivery_json, n.exit_code
       FROM inbox_items i JOIN notify_log n ON n.inbox_item_id = i.id
       WHERE n.target = ?`,
      )
      .get(target);
    const delivery = JSON.parse(row?.delivery_json ?? "{}");
    if (delivery.telegram && row?.exit_code !== null) {
      return { ...delivery.telegram, exitCode: row.exit_code };
    }
    await Bun.sleep(10);
  }
  throw new Error(
    `notifier delivery for ${target} did not settle within ${timeoutMs}ms`,
  );
}

export function writeGatedNotifier(dir, { exitCode = 0 } = {}) {
  const outFile = path.join(dir, "pushes.txt");
  const startedFile = path.join(dir, "notifier-started");
  const releaseFile = path.join(dir, "notifier-release");
  const pidFile = path.join(dir, "notifier.pid");
  const stub = path.join(dir, "notify-stub.sh");
  // The child advertises that it is pending, then waits for the test's explicit
  // release condition. A visible message alone is deliberately insufficient.
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${pidFile}\nprintf '%s\\n' "$1" >> ${outFile}\n: > ${startedFile}\nwhile [ ! -f ${releaseFile} ]; do sleep 0.01; done\nexit ${exitCode}\n`,
  );
  spawnSync("chmod", ["+x", stub]);
  return { outFile, pidFile, startedFile, releaseFile, stub };
}

/**
 * Spawn `serve` on an OS-assigned port and wait until /health answers.
 * Callers own cleanup (`box.child.kill`).
 */
export async function spawnLiveServe({
  home,
  extraEnv = {},
  args = [],
  timeoutMs = 20_000,
} = {}) {
  if (!home) throw new Error("spawnLiveServe requires home");
  const port = freePort();
  const child = spawnTracked("bun", [CLI, "serve", "--port", port, ...args], {
    env: {
      ...process.env,
      FACTORY_EVENT_HOME: home,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const box = { out: "", child, port };
  child.stdout.on("data", (b) => {
    box.out += b;
  });
  child.stderr.on("data", (b) => {
    box.out += b;
  });
  try {
    await until(
      `serve control API on :${port}`,
      async () => {
        if (!box.out.includes("control API on")) return false;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          return res.ok;
        } catch {
          return false;
        }
      },
      { timeoutMs, everyMs: 20 },
    );
  } catch (error) {
    const tail = box.out.slice(-800) || "(empty)";
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n--- serve output tail ---\n${tail}`, {
      cause: error,
    });
  }
  return box;
}

export async function assertHealthyLiveServe() {
  const home = tmpDir("evrt-doc-healthy-");
  const controlApiToken = "healthy-live-serve-control-token";
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
}

export async function runNotifierDeliveryCase({
  failWhilePending = false,
} = {}) {
  const { tick } = await import("../cli.mjs");
  const { loadRegistry } = await import("../lib/registry.mjs");
  const dir = tmpDir("evrt-tick-notify-");
  const { outFile, pidFile, startedFile, releaseFile, stub } =
    writeGatedNotifier(dir);
  const db = openDb(path.join(dir, "runtime.db"));
  const at = new Date().toISOString();
  db.query(
    `INSERT INTO events (source, event_id, type, occurred_at, received_at, envelope_json, payload_hash, status, admitted_at)
     VALUES ('test', 'evt-tick', 'linear.ticket.agent_ready', ?, ?, '{}', 'sha256:x', 'human_needed', ?)`,
  ).run(at, at, at);
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, decision, status, reason, created_at, ttl_seconds)
     VALUES ('prop-tick', 'test', 'evt-tick', 'human_needed', 'open', 'no_worktree_scripts', ?, 1800)`,
  ).run(at);

  const saved = {
    N: process.env.FACTORY_EVENT_NOTIFY,
    C: process.env.FACTORY_EVENT_NOTIFY_CMD,
    W: process.env.FACTORY_WEB_URL,
  };
  process.env.FACTORY_EVENT_NOTIFY = "1";
  process.env.FACTORY_EVENT_NOTIFY_CMD = stub;
  // The push appends a deep link to the item's random id when a web URL is
  // configured. This box exports one; the fixture asserts an exact message.
  delete process.env.FACTORY_WEB_URL;
  const logs = [];
  let deliveryStarted = false;
  let deliverySettled = false;
  try {
    await tick({
      db,
      registry: loadRegistry(),
      policyVersion: "git:test",
      log: (l) => logs.push(l),
    });
    deliveryStarted = true;
    await awaitFile(startedFile, "notifier start");
    trackProcess(Number(readFileSync(pidFile, "utf8").trim()), {
      group: false,
    });
    if (failWhilePending)
      throw new Error(
        "intentional assertion failure while notifier delivery is pending",
      );
    writeFileSync(releaseFile, "release\n");
    const delivery = await awaitNotifierDelivery(db, "test/evt-tick");
    deliverySettled = true;
    // The push is the synthesized item: its human title and body, then the
    // decision question and its options once (WM-390, the body's restatement
    // of the ask is stripped so the operator does not read it twice).
    const expectedMessage = [
      "BLOCKED linear.ticket.agent_ready evt-tick: no_worktree_scripts",
      "What happened: A blocked item needs attention for linear.ticket.agent_ready evt-tick.",
      "",
      "Why it matters: The runtime reported “no worktree scripts” and needs an operator to decide what happens next.",
      "",
      "Reason code: no_worktree_scripts.",
      "Should this parked event be requeued?",
      "1. Requeue the event",
      "2. Not now",
    ].join("\n");
    expect(readFileSync(outFile, "utf8").trim()).toBe(expectedMessage);
    expect(logs.some((l) => l.includes("notify BLOCKED test/evt-tick"))).toBe(
      true,
    );
    await tick({
      db,
      registry: loadRegistry(),
      policyVersion: "git:test",
      log: () => {},
    });
    // Exactly one delivery: the file still holds the single message.
    expect(readFileSync(outFile, "utf8").trim()).toBe(expectedMessage);
    return { delivery };
  } finally {
    // This is the critical cleanup contract: first unblock an in-flight child,
    // then await its inbox and notify-log writes, only then close SQLite.
    if (deliveryStarted && !existsSync(releaseFile))
      writeFileSync(releaseFile, "release\n");
    if (deliveryStarted && !deliverySettled)
      await awaitNotifierDelivery(db, "test/evt-tick");
    if (saved.N === undefined) delete process.env.FACTORY_EVENT_NOTIFY;
    else process.env.FACTORY_EVENT_NOTIFY = saved.N;
    if (saved.C === undefined) delete process.env.FACTORY_EVENT_NOTIFY_CMD;
    else process.env.FACTORY_EVENT_NOTIFY_CMD = saved.C;
    if (saved.W === undefined) delete process.env.FACTORY_WEB_URL;
    else process.env.FACTORY_WEB_URL = saved.W;
    db.close();
  }
}

/** A throwaway checkout for the code stamp to watch, so tests never dirty this repo. */
export function makeStampRoot() {
  const root = tmpDir("evrt-reload-src-");
  mkdirSync(path.join(root, "event-runtime", "lib"), { recursive: true });
  mkdirSync(path.join(root, "event-runtime", "cli"), { recursive: true });
  writeFileSync(
    path.join(root, "event-runtime", "cli.mjs"),
    "// cli\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "event-runtime", "cli", "work.mjs"),
    "// v1\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "event-runtime", "lib", "worker.mjs"),
    "// v1\n",
    "utf8",
  );
  return root;
}

export function editStampRoot(root, body) {
  writeFileSync(
    path.join(root, "event-runtime", "lib", "worker.mjs"),
    body,
    "utf8",
  );
}

/** Spawn a worker, collecting stdout+stderr into one buffer. */
export function spawnWorker(args, env) {
  const child = spawnTracked("bun", [CLI, "work", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const box = { out: "", child };
  child.stdout.on("data", (b) => {
    box.out += b;
  });
  child.stderr.on("data", (b) => {
    box.out += b;
  });
  return box;
}

export async function waitFor(box, needle, timeoutMs = 15_000) {
  try {
    await until(
      `output to contain ${JSON.stringify(needle)}`,
      () => box.out.includes(needle),
      { timeoutMs, everyMs: 10 },
    );
  } catch (error) {
    const tail = String(box.out ?? "").slice(-800) || "(empty)";
    throw new Error(`${error.message}\n--- output tail ---\n${tail}`, {
      cause: error,
    });
  }
  return true;
}

export async function exitOf(child, timeoutMs = 30_000) {
  // Resolve immediately if the child already exited (a drain-signalled
  // worker can finish before the test awaits it — WM-689). Use loose
  // null checks: Bun's ChildProcess reports `signalCode` as undefined (not
  // null) while the process is still running, and a strict `!== null` test
  // made this fire on live children, which broke demo/seed.test.mjs.
  if (child.exitCode != null || child.signalCode != null) {
    return {
      code: child.exitCode,
      signal: child.signalCode ?? null,
    };
  }
  await until(
    `pid ${child.pid} to exit`,
    () => child.exitCode != null || child.signalCode != null,
    { timeoutMs, everyMs: 20 },
  );
  return {
    code: child.exitCode,
    signal: child.signalCode ?? null,
  };
}

/** A QUEUED run in `home`'s database, straight through the real lifecycle. */
export async function seedRun(home, { runId, input = {}, timeoutSeconds = 5 }) {
  const { createRun, transition } = await import("../lib/lifecycle.mjs");
  const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");
  const db = openDb(path.join(home, "runtime.db"));
  const spec = {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: false },
    adapter: "fake",
    promptVersion: policyVersion(),
    policyVersion: policyVersion(),
    outputContract: "factory.status-report/v1",
    capabilities: ["linear:read"],
    timeoutSeconds,
    maxAttempts: 1,
    idempotencyKey: `idem_${runId}`,
  };
  createRun(db, {
    runId,
    idempotencyKey: spec.idempotencyKey,
    spec,
    specJson: canonicalJson(spec),
    specHash: hashJson(spec),
    actor: "test",
    policyVersion: "test",
    now: Date.now(),
  });
  transition(db, { runId, to: "APPROVED", actor: "test", now: Date.now() });
  transition(db, { runId, to: "QUEUED", actor: "test", now: Date.now() });
  db.close();
}

export function spawnSupervisor(args, env) {
  const child = spawnTracked("bun", [CLI, "supervise", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const box = { out: "", child };
  child.stdout.on("data", (b) => {
    box.out += b;
  });
  child.stderr.on("data", (b) => {
    box.out += b;
  });
  return box;
}

/** Every worker the supervisor left behind, killed hard — tests do not drain. */
export async function killPool(box, dir) {
  const { readPool } = await import("../cli.mjs");
  box.child.kill("SIGKILL");
  for (const slot of readPool(dir).slots) {
    if (slot.alive) {
      try {
        process.kill(slot.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

export async function poolSize(dir) {
  const { readPool } = await import("../cli.mjs");
  return readPool(dir).size;
}
