import { expect } from "bun:test";
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
import { fileURLToPath } from "node:url";
import { policyVersion } from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";

export const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** A loopback port nothing in these tests ever listens on. */
export const DEAD_PORT = "59987";

/**
 * A throwaway run dir, so nothing here reads this machine's real
 * ~/.factory/run — `status` reports the local worker pool from pidfiles
 * (WM-226), and a developer's own running stack must not change a test result.
 */
export const throwawayRunDir = () =>
  mkdtempSync(path.join(os.tmpdir(), "evrt-cli-run-"));

export function runCli(args, env = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "evrt-cli-"));
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
  const stub = path.join(dir, "notify-stub.sh");
  // The child advertises that it is pending, then waits for the test's explicit
  // release condition. A visible message alone is deliberately insufficient.
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${outFile}\n: > ${startedFile}\nwhile [ ! -f ${releaseFile} ]; do sleep 0.01; done\nexit ${exitCode}\n`,
  );
  spawnSync("chmod", ["+x", stub]);
  return { outFile, startedFile, releaseFile, stub };
}

export async function assertHealthyLiveServe() {
  const home = mkdtempSync(path.join(os.tmpdir(), "evrt-doc-healthy-"));
  const port = String(59700 + (process.pid % 100));
  const child = spawn("bun", [CLI, "serve", "--port", port], {
    env: {
      ...process.env,
      FACTORY_EVENT_HOME: home,
      FACTORY_EVENT_SECRET: "test-secret",
      FACTORY_GITHUB_WEBHOOK_SECRET: "test-gh-secret",
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
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !out.includes("control API on")) {
    await Bun.sleep(10);
  }
  let docRes;
  try {
    expect(out).toContain("control API on");
    docRes = spawnSync("bun", [CLI, "doctor"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FACTORY_EVENT_HOME: home,
        FACTORY_EVENT_PORT: port,
        FACTORY_RUN_DIR: throwawayRunDir(),
      },
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-tick-notify-"));
  const { outFile, startedFile, releaseFile, stub } = writeGatedNotifier(dir);
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
  };
  process.env.FACTORY_EVENT_NOTIFY = "1";
  process.env.FACTORY_EVENT_NOTIFY_CMD = stub;
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
    if (failWhilePending)
      throw new Error(
        "intentional assertion failure while notifier delivery is pending",
      );
    writeFileSync(releaseFile, "release\n");
    const delivery = await awaitNotifierDelivery(db, "test/evt-tick");
    deliverySettled = true;
    expect(readFileSync(outFile, "utf8").trim()).toBe(
      "BLOCKED linear.ticket.agent_ready evt-tick: no_worktree_scripts",
    );
    expect(
      logs.some((l) => l.includes("notify human_needed test/evt-tick")),
    ).toBe(true);
    await tick({
      db,
      registry: loadRegistry(),
      policyVersion: "git:test",
      log: () => {},
    });
    expect(readFileSync(outFile, "utf8").trim().split("\n")).toHaveLength(1);
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
    db.close();
  }
}

/** A throwaway checkout for the code stamp to watch, so tests never dirty this repo. */
export function makeStampRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-reload-src-"));
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
  const child = spawn("bun", [CLI, "work", ...args], {
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !box.out.includes(needle))
    await Bun.sleep(50);
  return box.out.includes(needle);
}

export function exitOf(child) {
  return new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
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
  const child = spawn("bun", [CLI, "supervise", ...args], {
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
