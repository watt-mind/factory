import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./lib/db.mjs";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));

/** A loopback port nothing in these tests ever listens on. */
const DEAD_PORT = "59987";

/**
 * A throwaway run dir, so nothing here reads this machine's real
 * ~/.factory/run — `status` reports the local worker pool from pidfiles
 * (WM-226), and a developer's own running stack must not change a test result.
 */
const throwawayRunDir = () => mkdtempSync(path.join(os.tmpdir(), "evrt-cli-run-"));

function runCli(args, env = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "evrt-cli-"));
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_RUN_DIR: throwawayRunDir(), ...env },
  });
  return { ...result, all: `${result.stdout}${result.stderr}` };
}

async function awaitFile(file, label, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await Bun.sleep(10);
  }
  throw new Error(`${label} did not appear within ${timeoutMs}ms`);
}

/** Wait for both durable writes made after an async notifier process exits. */
async function awaitNotifierDelivery(db, target, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.query(
      `SELECT i.delivery_json, n.exit_code
       FROM inbox_items i JOIN notify_log n ON n.inbox_item_id = i.id
       WHERE n.target = ?`,
    ).get(target);
    const delivery = JSON.parse(row?.delivery_json ?? "{}");
    if (delivery.telegram && row?.exit_code !== null) {
      return { ...delivery.telegram, exitCode: row.exit_code };
    }
    await Bun.sleep(10);
  }
  throw new Error(`notifier delivery for ${target} did not settle within ${timeoutMs}ms`);
}

function writeGatedNotifier(dir, { exitCode = 0 } = {}) {
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

async function assertHealthyLiveServe() {
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
      env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_EVENT_PORT: port, FACTORY_RUN_DIR: throwawayRunDir() },
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  expect(docRes.status).toBe(0);
  expect(docRes.stdout).toContain("anomalies");
  expect(docRes.stdout).toContain("none");
}

async function runNotifierDeliveryCase({ failWhilePending = false } = {}) {
  const { tick } = await import("./cli.mjs");
  const { loadRegistry } = await import("./lib/registry.mjs");
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

  const saved = { N: process.env.FACTORY_EVENT_NOTIFY, C: process.env.FACTORY_EVENT_NOTIFY_CMD };
  process.env.FACTORY_EVENT_NOTIFY = "1";
  process.env.FACTORY_EVENT_NOTIFY_CMD = stub;
  const logs = [];
  let deliveryStarted = false;
  let deliverySettled = false;
  try {
    await tick({ db, registry: loadRegistry(), policyVersion: "git:test", log: (l) => logs.push(l) });
    deliveryStarted = true;
    await awaitFile(startedFile, "notifier start");
    if (failWhilePending) throw new Error("intentional assertion failure while notifier delivery is pending");
    writeFileSync(releaseFile, "release\n");
    const delivery = await awaitNotifierDelivery(db, "test/evt-tick");
    deliverySettled = true;
    expect(readFileSync(outFile, "utf8").trim()).toBe(
      "BLOCKED linear.ticket.agent_ready evt-tick: no_worktree_scripts",
    );
    expect(logs.some((l) => l.includes("notify human_needed test/evt-tick"))).toBe(true);
    await tick({ db, registry: loadRegistry(), policyVersion: "git:test", log: () => {} });
    expect(readFileSync(outFile, "utf8").trim().split("\n")).toHaveLength(1);
    return { delivery };
  } finally {
    // This is the critical cleanup contract: first unblock an in-flight child,
    // then await its inbox and notify-log writes, only then close SQLite.
    if (deliveryStarted && !existsSync(releaseFile)) writeFileSync(releaseFile, "release\n");
    if (deliveryStarted && !deliverySettled) await awaitNotifierDelivery(db, "test/evt-tick");
    if (saved.N === undefined) delete process.env.FACTORY_EVENT_NOTIFY;
    else process.env.FACTORY_EVENT_NOTIFY = saved.N;
    if (saved.C === undefined) delete process.env.FACTORY_EVENT_NOTIFY_CMD;
    else process.env.FACTORY_EVENT_NOTIFY_CMD = saved.C;
    db.close();
  }
}

describe("cli", () => {
  test("no command → usage text listing all verbs, non-zero exit", () => {
    const r = runCli([]);
    expect(r.status).not.toBe(0);
    for (const verb of [
      "serve", "status", "doctor", "ps", "runs", "proposals", "approve", "reject",
      "inject", "cancel", "retry", "inspect", "update-pins", "supervise",
    ]) {
      expect(r.all).toContain(verb);
    }
    expect(r.all).toContain("usage:");
    expect(r.all).toContain("--watch");
    expect(r.all).toContain("--reload-on-change");
    expect(r.all).toContain("--workers min:max");
  });

  test("unknown command → usage text, non-zero exit", () => {
    const r = runCli(["frobnicate"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("usage:");
  });

  test("work rejects an unsafe idle poll interval", () => {
    const r = runCli(["work", "--poll-ms", "0"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("work: --poll-ms must be an integer between 25 and 5000");
  });

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

  test("serve --watch re-execs under bun --watch and binds", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-watch-"));
    const port = String(59000 + (process.pid % 800));
    const child = spawn("bun", [CLI, "serve", "--watch", "--port", port], {
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
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("control API on")) {
      await Bun.sleep(100);
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(out).toContain("serve --watch: restarting on event-runtime/ changes");
    expect(out).toContain("control API on");
  });

  test("serve binds the control API, starts the loop, and answers /health", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-serve-"));
    const port = String(59800 + (process.pid % 100));
    const child = spawn("bun", [CLI, "serve", "--port", port], {
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
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("control API on")) {
      await Bun.sleep(100);
    }
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

  test("work with unknown --adapter-override exits non-zero with error", () => {
    const r = runCli(["work", "--adapter-override", "nonexistent"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('work: unknown --adapter-override "nonexistent"');
  });

  test("executeClaimed respects adapterOverride option", async () => {
    const { openDb } = await import("./lib/db.mjs");
    const { createRun, transition } = await import("./lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("./lib/canonical.mjs");
    const { loadRegistry } = await import("./lib/registry.mjs");
    const { claimNext, executeClaimed } = await import("./lib/worker.mjs");

    const db = openDb(":memory:");
    const registry = loadRegistry();
    const input = { repos: ["ok"] };
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_override_test",
      agent: "factory-status-report@1",
      input,
      inputHash: hashJson(input),
      workspace: { type: "ephemeral", retainOnFailure: true },
      adapter: "real_adapter",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.status-report/v1",
      capabilities: ["linear:read"],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: "idem_override_test",
    };

    createRun(db, {
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      spec,
      specJson: canonicalJson(spec),
      specHash: hashJson(spec),
      actor: "test",
      policyVersion: "test",
      now: Date.now(),
    });
    transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now: Date.now() });
    transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now: Date.now() });

    let realCalled = false;
    let fakeCalled = false;
    const mockAdapters = {
      real_adapter: {
        execute: async () => {
          realCalled = true;
          return { exitCode: 0, timedOut: false };
        },
      },
      fake: {
        execute: async ({ workspaceDir }) => {
          fakeCalled = true;
          const { writeFileSync } = await import("node:fs");
          const { default: path } = await import("node:path");
          writeFileSync(
            path.join(workspaceDir, "result.json"),
            JSON.stringify({
              schemaVersion: "factory.agent-result/v1",
              terminalState: "completed",
              artifact: { repos: [{ name: "ok", triage: 1, agentReady: 2, inProgress: 0, blocked: 0 }], recommendedAction: "dispatch" },
              evidence: { queries: ["fake"] },
            }),
            "utf8",
          );
          return { exitCode: 0, timedOut: false };
        },
      },
    };

    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-override-"));
    const claim = claimNext(db, { owner: "w1", adapterOverride: "fake" });
    expect(claim).toBeTruthy();

    const summary = await executeClaimed(db, registry, mockAdapters, claim, {
      workspacesRoot: home,
      adapterOverride: "fake",
    });

    expect(realCalled).toBe(false);
    expect(fakeCalled).toBe(true);
    expect(summary.terminalState).toBe("COMPLETED");
  });

  test("work process with --adapter-override fake executes a command-adapter run via fake", async () => {
    const { openDb } = await import("./lib/db.mjs");
    const { createRun, transition } = await import("./lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("./lib/canonical.mjs");

    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-work-proc-"));
    const db = openDb(path.join(home, "runtime.db"));

    const input = { repos: ["ok"] };
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_work_proc_test",
      agent: "factory-status-report@1",
      input,
      inputHash: hashJson(input),
      workspace: { type: "ephemeral", retainOnFailure: true },
      adapter: "command", // real adapter that lacks command template for status-report
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.status-report/v1",
      capabilities: ["linear:read"],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: "idem_work_proc_test",
    };

    createRun(db, {
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      spec,
      specJson: canonicalJson(spec),
      specHash: hashJson(spec),
      actor: "test",
      policyVersion: "test",
      now: Date.now(),
    });
    transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now: Date.now() });
    transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now: Date.now() });
    db.close();

    const child = spawn("bun", [CLI, "work", "--adapter-override", "fake"], {
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

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("run_work_proc_test → COMPLETED")) {
      await Bun.sleep(100);
    }

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(out).toContain('adapter override: executing every run with "fake"');
    expect(out).toContain("claimed run_work_proc_test attempt 1 (factory-status-report@1)");
    expect(out).toContain("run_work_proc_test → COMPLETED (ok)");

    const verifyDb = openDb(path.join(home, "runtime.db"));
    const row = verifyDb.query(`SELECT state FROM runs WHERE run_id = ?`).get("run_work_proc_test");
    expect(row?.state).toBe("COMPLETED");
    verifyDb.close();
  });

  test("work --adapter-override pi is accepted at the work call site (OPS-517)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-work-pi-"));
    const child = spawn("bun", [CLI, "work", "--adapter-override", "pi"], {
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
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("adapter override")) {
      await Bun.sleep(100);
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(out).not.toContain('unknown --adapter-override "pi"');
    expect(out).toContain('adapter override: executing every run with "pi"');
  });

  test("serve --adapter-override pi is accepted at the serve call site (OPS-517)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-serve-pi-"));
    const port = String(59800 + (process.pid % 150));
    const child = spawn("bun", [CLI, "serve", "--adapter-override", "pi", "--port", port], {
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
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("control API on")) {
      await Bun.sleep(100);
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(out).not.toContain('unknown --adapter-override "pi"');
    expect(out).toContain('adapter override: all new run specs use "pi"');
    expect(out).toContain("control API on");
  });

  test("pi-smoke@1 routes end-to-end through the pi adapter via a fake shim (OPS-517)", async () => {
    const { createRun, transition } = await import("./lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("./lib/canonical.mjs");
    const { loadRegistry } = await import("./lib/registry.mjs");
    const { claimNext, executeClaimed } = await import("./lib/worker.mjs");

    const db = openDb(":memory:");
    const registry = loadRegistry();

    // Same shape the planner produces for a real factory.pi-smoke.requested
    // event (agent pi-smoke@1, adapter "pi", per event-types.json) — proves
    // the registered agent/event-type/schema route reaches the worker and
    // resolves to the "pi" key in the adapters map, not just that the map
    // has that key. spec.adapter carries "pi" with no --adapter-override,
    // so worker.mjs's `adapterOverride ?? spec.adapter` must pick "pi".
    const input = { message: "hello from OPS-517" };
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_pi_smoke_test",
      agent: "pi-smoke@1",
      input,
      inputHash: hashJson(input),
      workspace: { type: "ephemeral", retainOnFailure: true },
      adapter: "pi",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.pi-smoke/v1",
      capabilities: [],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: "idem_pi_smoke_test",
    };

    createRun(db, {
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      spec,
      specJson: canonicalJson(spec),
      specHash: hashJson(spec),
      actor: "test",
      policyVersion: "test",
      now: Date.now(),
    });
    transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now: Date.now() });
    transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now: Date.now() });

    // A shim standing in for the real pi CLI spawn (lib/adapters/pi.mjs,
    // already covered by pi.test.mjs) — it only has to prove the route: read
    // the input the workspace provider staged and write a result shaped to
    // pi-smoke's own output schema.
    let piCalled = false;
    const mockAdapters = {
      pi: {
        execute: async ({ spec: runSpec, workspaceDir }) => {
          piCalled = true;
          const { readFileSync, writeFileSync } = await import("node:fs");
          const { default: path } = await import("node:path");
          const staged = JSON.parse(readFileSync(path.join(workspaceDir, "input.json"), "utf8"));
          writeFileSync(
            path.join(workspaceDir, "result.json"),
            JSON.stringify({
              schemaVersion: "factory.agent-result/v1",
              terminalState: "completed",
              reasonCode: "ok",
              artifact: { echo: staged.message },
              evidence: { commands: [] },
            }),
            "utf8",
          );
          return { exitCode: 0, timedOut: false };
        },
      },
    };

    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-pi-smoke-"));
    const claim = claimNext(db, { owner: "w1" });
    expect(claim).toBeTruthy();

    const summary = await executeClaimed(db, registry, mockAdapters, claim, {
      workspacesRoot: home,
    });

    expect(piCalled).toBe(true);
    expect(summary.terminalState).toBe("COMPLETED");

    const row = db.query(`SELECT state FROM runs WHERE run_id = ?`).get("run_pi_smoke_test");
    expect(row?.state).toBe("COMPLETED");
  });

  test("tick runs notify as an isolated subsystem (WM-65): a throwing notifier step cannot break the tick", async () => {
    const { tick, TICK_SUBSYSTEMS } = await import("./cli.mjs");
    const { loadRegistry } = await import("./lib/registry.mjs");
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
    expect(logs.some((l) => l.includes("tick notify: notifier exploded"))).toBe(true);
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
    await expect(runNotifierDeliveryCase({ failWhilePending: true })).rejects.toThrow(
      "intentional assertion failure while notifier delivery is pending",
    );
    await assertHealthyLiveServe();
  });

  test("doctor against a dead port says serve is not running, non-zero exit", () => {
    const r = runCli(["doctor"], { FACTORY_EVENT_PORT: DEAD_PORT });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain(
      `control API not reachable on 127.0.0.1:${DEAD_PORT} — start it with: bun event-runtime/cli.mjs serve`,
    );
  });

  test("doctor reports anomalies (stale workers, unreferenced artifacts, orphaned workspaces, proposals piling up) and exits non-zero (OPS-428, WM-124)", async () => {
    const { getAnomalyLines } = await import("./cli.mjs");
    const statusPayload = {
      anomalies: {
        stalledWorkers: [{ workerId: "w-dead", host: "node-1", runId: "run-99", lastSeen: "2026-08-14T10:00:00Z" }],
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
    expect(lines.some((l) => l.includes("stalled worker w-dead on node-1"))).toBe(true);
    expect(lines.some((l) => l.includes("stopped schedule nightly: 3 intervals late"))).toBe(true);
    expect(lines.some((l) => l.includes("proposals piling up for schedule reconcile-bj29: 4 open proposals exist (threshold 3)"))).toBe(true);
    expect(lines.some((l) => l.includes("no live workers with queued runs") || l.includes("no workers"))).toBe(true);
    expect(lines.some((l) => l.includes("orphaned workspace: /tmp/orphaned-ws-1"))).toBe(true);
    expect(lines.some((l) => l.includes("unreferenced artifacts: 5"))).toBe(true);
    expect(lines.some((l) => l.includes("customAnomaly: something unexpected"))).toBe(true);
  });

  test("doctor against a healthy live serve outputs anomalies none and exits 0", async () => {
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
      await Bun.sleep(100);
    }
    let docRes;
    try {
      expect(out).toContain("control API on");
      docRes = spawnSync("bun", [CLI, "doctor"], {
        encoding: "utf8",
        env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_EVENT_PORT: port, FACTORY_RUN_DIR: throwawayRunDir() },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    expect(docRes.status).toBe(0);
    expect(docRes.stdout).toContain("anomalies");
    expect(docRes.stdout).toContain("none");
  });

  test("doctor against a live serve with an anomaly exits non-zero and reports anomaly", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-doc-anomaly-"));
    const port = String(59600 + (process.pid % 100));
    const db = openDb(path.join(home, "runtime.db"));
    const at = new Date(Date.now() - 200_000).toISOString();
    db.query(
      `INSERT INTO workers (worker_id, host, pid, labels_json, adapters, started_at, last_seen, state, current_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("w-stalled-test", "host-1", 1234, "{}", "fake", at, at, "busy", "run-stalled-test");
    db.close();

    const child = spawn("bun", [CLI, "serve", "--port", port], {
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
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("control API on")) {
      await Bun.sleep(100);
    }
    let docRes;
    try {
      expect(out).toContain("control API on");
      docRes = spawnSync("bun", [CLI, "doctor"], {
        encoding: "utf8",
        env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_EVENT_PORT: port, FACTORY_RUN_DIR: throwawayRunDir() },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    expect(docRes.status).not.toBe(0);
    expect(docRes.stdout).toContain("stalled worker w-stalled-test");
  });
});

// ---------------------------------------------------------------------------
// work --reload-on-change (WM-213)
// ---------------------------------------------------------------------------

/** A throwaway checkout for the code stamp to watch, so tests never dirty this repo. */
function makeStampRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-reload-src-"));
  mkdirSync(path.join(root, "event-runtime", "lib"), { recursive: true });
  writeFileSync(path.join(root, "event-runtime", "cli.mjs"), "// cli\n", "utf8");
  writeFileSync(path.join(root, "event-runtime", "lib", "worker.mjs"), "// v1\n", "utf8");
  return root;
}

function editStampRoot(root, body) {
  writeFileSync(path.join(root, "event-runtime", "lib", "worker.mjs"), body, "utf8");
}

/** Spawn a worker, collecting stdout+stderr into one buffer. */
function spawnWorker(args, env) {
  const child = spawn("bun", [CLI, "work", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const box = { out: "", child };
  child.stdout.on("data", (b) => { box.out += b; });
  child.stderr.on("data", (b) => { box.out += b; });
  return box;
}

async function waitFor(box, needle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !box.out.includes(needle)) await Bun.sleep(50);
  return box.out.includes(needle);
}

function exitOf(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

describe("work --reload-on-change (WM-213)", () => {
  test("plain work never arms the watcher", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-reload-off-"));
    const stampRoot = makeStampRoot();
    const box = spawnWorker(["--adapter-override", "fake", "--poll-ms", "50"], {
      FACTORY_EVENT_HOME: home, FACTORY_CODE_STAMP_ROOT: stampRoot,
    });
    try {
      expect(await waitFor(box, "adapter override")).toBe(true);
      editStampRoot(stampRoot, "// v2\n");
      await Bun.sleep(2500); // well past two reload-check intervals
      expect(box.out).not.toContain("reload-on-change");
      expect(box.out).not.toContain("reloading worker");
      expect(box.child.exitCode).toBe(null); // still running
    } finally {
      box.child.kill("SIGTERM");
      await exitOf(box.child);
      rmSync(stampRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("an idle worker exits 75 within a poll interval of an uncommitted edit", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-reload-idle-"));
    const stampRoot = makeStampRoot();
    const box = spawnWorker(["--adapter-override", "fake", "--poll-ms", "50", "--reload-on-change"], {
      FACTORY_EVENT_HOME: home, FACTORY_CODE_STAMP_ROOT: stampRoot,
    });
    try {
      expect(await waitFor(box, "reload-on-change: armed at code stamp")).toBe(true);
      // No commit — only a working-tree write. HEAD is unchanged (this tree has
      // no git at all), so a HEAD-only stamp would sit here forever.
      editStampRoot(stampRoot, "// v2\n");
      const { code } = await exitOf(box.child);
      expect(code).toBe(75);
      expect(box.out).toContain("reloading worker (exit 75)");
      // The log names both stamps so the developer can see what moved.
      expect(box.out).toMatch(/code changed \(nogit:[0-9a-f]+ → nogit:[0-9a-f]+\)/);
      expect(box.out).toContain("worker stopped (code_reload)");
    } finally {
      box.child.kill("SIGKILL");
      rmSync(stampRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("a run in flight defers the reload; the worker restarts only once it is idle", async () => {
    const { openDb } = await import("./lib/db.mjs");
    const { createRun, transition } = await import("./lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("./lib/canonical.mjs");

    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-reload-busy-"));
    const stampRoot = makeStampRoot();
    const db = openDb(path.join(home, "runtime.db"));

    // The fake adapter's "hang" mode occupies the worker for the whole spec
    // timeout — the in-flight window this reload must not interrupt.
    const input = { repos: ["hang"] };
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_reload_busy",
      agent: "factory-status-report@1",
      input,
      inputHash: hashJson(input),
      workspace: { type: "ephemeral", retainOnFailure: false },
      adapter: "fake",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.status-report/v1",
      capabilities: ["linear:read"],
      timeoutSeconds: 4,
      maxAttempts: 1,
      idempotencyKey: "idem_reload_busy",
    };
    createRun(db, {
      runId: spec.runId, idempotencyKey: spec.idempotencyKey,
      spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
      actor: "test", policyVersion: "test", now: Date.now(),
    });
    transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now: Date.now() });
    transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now: Date.now() });
    db.close();

    const box = spawnWorker(["--adapter-override", "fake", "--poll-ms", "50", "--reload-on-change"], {
      FACTORY_EVENT_HOME: home, FACTORY_CODE_STAMP_ROOT: stampRoot,
    });
    try {
      expect(await waitFor(box, "claimed run_reload_busy")).toBe(true);
      editStampRoot(stampRoot, "// v2\n");

      expect(await waitFor(box, "reload deferred until run_reload_busy finishes")).toBe(true);
      // Proven, not assumed: the deferral was logged while the run was still
      // going, and the worker was still alive at that point.
      expect(box.out).not.toContain("run_reload_busy → ");
      expect(box.child.exitCode).toBe(null);

      const { code } = await exitOf(box.child);
      expect(code).toBe(75);
      // Order is the guarantee: the run reached a terminal state BEFORE the reload.
      expect(box.out.indexOf("run_reload_busy → ")).toBeGreaterThan(-1);
      expect(box.out.indexOf("run_reload_busy → ")).toBeLessThan(box.out.indexOf("reloading worker"));
      // And exactly one deferral line, however many intervals it spanned.
      expect(box.out.split("reload deferred until").length - 1).toBe(1);
    } finally {
      box.child.kill("SIGKILL");
      rmSync(stampRoot, { recursive: true, force: true });
    }

    const verifyDb = openDb(path.join(home, "runtime.db"));
    const row = verifyDb.query(`SELECT state FROM runs WHERE run_id = ?`).get("run_reload_busy");
    expect(["TIMED_OUT", "FAILED", "COMPLETED"]).toContain(row?.state);
    verifyDb.close();
  }, 45_000);
});

// ---------------------------------------------------------------------------
// worker pool supervisor (WM-226)
// ---------------------------------------------------------------------------

/** A QUEUED run in `home`'s database, straight through the real lifecycle. */
async function seedRun(home, { runId, input = {}, timeoutSeconds = 5 }) {
  const { createRun, transition } = await import("./lib/lifecycle.mjs");
  const { canonicalJson, hashJson } = await import("./lib/canonical.mjs");
  const db = openDb(path.join(home, "runtime.db"));
  const spec = {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: false },
    adapter: "fake",
    promptVersion: "git:test",
    policyVersion: "git:test",
    outputContract: "factory.status-report/v1",
    capabilities: ["linear:read"],
    timeoutSeconds,
    maxAttempts: 1,
    idempotencyKey: `idem_${runId}`,
  };
  createRun(db, {
    runId, idempotencyKey: spec.idempotencyKey,
    spec, specJson: canonicalJson(spec), specHash: hashJson(spec),
    actor: "test", policyVersion: "test", now: Date.now(),
  });
  transition(db, { runId, to: "APPROVED", actor: "test", now: Date.now() });
  transition(db, { runId, to: "QUEUED", actor: "test", now: Date.now() });
  db.close();
}

function spawnSupervisor(args, env) {
  const child = spawn("bun", [CLI, "supervise", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const box = { out: "", child };
  child.stdout.on("data", (b) => { box.out += b; });
  child.stderr.on("data", (b) => { box.out += b; });
  return box;
}

/** Every worker the supervisor left behind, killed hard — tests do not drain. */
async function killPool(box, dir) {
  const { readPool } = await import("./cli.mjs");
  box.child.kill("SIGKILL");
  for (const slot of readPool(dir).slots) {
    if (slot.alive) { try { process.kill(slot.pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

async function poolSize(dir) {
  const { readPool } = await import("./cli.mjs");
  return readPool(dir).size;
}

describe("supervise (WM-226)", () => {
  test("rejects bounds and intervals it cannot honour, naming the flag", () => {
    expect(runCli(["supervise", "--workers", "3:1", "--once"]).all).toContain("min (3) cannot exceed max (1)");
    expect(runCli(["supervise", "--workers", "1:2:3", "--once"]).all).toContain("--workers expects min:max");
    expect(runCli(["supervise", "--workers", "1:2", "--interval-ms", "10", "--once"]).all)
      .toContain("--interval-ms must be an integer between 100 and 60000");
    for (const args of [["supervise", "--workers", "3:1", "--once"], ["supervise", "--workers", "x", "--once"]]) {
      expect(runCli(args).status).not.toBe(0);
    }
  });

  test("refuses to be the second supervisor on one run dir — two would orphan each other's workers", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-dup-"));
    try {
      // This process stands in for a live incumbent supervisor.
      writeFileSync(path.join(dir, "supervisor.pid"), `${process.pid}\n`, "utf8");
      const r = runCli(["supervise", "--workers", "1:2", "--once"], { FACTORY_RUN_DIR: dir });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain(`a supervisor is already running for ${dir} (pid ${process.pid})`);
      expect(existsSync(path.join(dir, "worker-1.pid"))).toBe(false); // nothing spawned

      // A stale pidfile is not an incumbent: the pool starts.
      writeFileSync(path.join(dir, "supervisor.pid"), "2147483646\n", "utf8");
      expect(runCli(["supervise", "--workers", "1:1", "--once"], { FACTORY_RUN_DIR: dir }).status).toBe(0);
      const pid = Number(readFileSync(path.join(dir, "worker-1.pid"), "utf8").trim());
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
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
      await seedRun(home, { runId, input: { repos: ["hang"] }, timeoutSeconds: 20 });
    }
    const box = spawnSupervisor(
      ["--workers", "1:2", "--interval-ms", "150", "--spawn-grace-ms", "150",
       "--adapter-override", "fake", "--poll-ms", "50", "--drain-timeout", "1"],
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
      expect(box.out).toMatch(/spawn slot 2 → worker \S+ pid \d+ .*queued=\d+ idle=0 busy=\d+ pool=1 pending=0 draining=0 min=1 max=2/);
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
      await seedRun(home, { runId, input: { repos: ["hang"] }, timeoutSeconds: 3 });
    }
    const box = spawnSupervisor(
      ["--workers", "1:2", "--interval-ms", "150", "--spawn-grace-ms", "150",
       "--adapter-override", "fake", "--poll-ms", "50", "--drain-timeout", "1"],
      { FACTORY_EVENT_HOME: home, FACTORY_RUN_DIR: dir },
    );
    try {
      expect(await waitFor(box, "spawn slot 2", 30_000)).toBe(true);
      expect(await waitFor(box, "drain slot", 30_000)).toBe(true);
      expect(box.out).toMatch(/drain slot \d+ \(worker \S+\): \d+ idle worker\(s\) and no queued runs, pool 2 above workers.min 1/);
      // Asked, never signalled: the flag is the whole mechanism.
      expect(box.out).toContain("it exits at its next idle poll boundary, never mid-run");
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

describe("work --drain-file (WM-226)", () => {
  test("a drain-signalled worker holding a lease finishes its run first, then exits 0", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-drain-busy-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-drain-busy-run-"));
    const drainFile = path.join(dir, "worker-1.drain");
    await seedRun(home, { runId: "run_drain_busy", input: { repos: ["hang"] }, timeoutSeconds: 4 });

    const box = spawnWorker(
      ["--adapter-override", "fake", "--poll-ms", "50", "--drain-file", drainFile],
      { FACTORY_EVENT_HOME: home },
    );
    try {
      expect(await waitFor(box, "claimed run_drain_busy")).toBe(true);
      writeFileSync(drainFile, "scale-down\n", "utf8");

      // Proven, not assumed: still alive and still running the claim a moment
      // after the flag appeared. A worker that leaves here is one that dropped
      // a leased run on the floor.
      await Bun.sleep(500);
      expect(box.child.exitCode).toBe(null);
      expect(box.out).not.toContain("run_drain_busy → ");

      const { code } = await exitOf(box.child);
      expect(code).toBe(0); // a clean drain, not the reload code
      // Order is the guarantee: the run reached a terminal state BEFORE the exit.
      expect(box.out.indexOf("run_drain_busy → ")).toBeGreaterThan(-1);
      expect(box.out.indexOf("run_drain_busy → ")).toBeLessThan(box.out.indexOf("drain requested"));
      expect(box.out).toContain("worker stopped (drain_requested)");
    } finally {
      box.child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  test("plain work ignores a drain file it was never given", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-drain-off-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-drain-off-run-"));
    writeFileSync(path.join(dir, "worker-1.drain"), "scale-down\n", "utf8");
    const box = spawnWorker(["--adapter-override", "fake", "--poll-ms", "50"], { FACTORY_EVENT_HOME: home });
    try {
      expect(await waitFor(box, "adapter override")).toBe(true);
      await Bun.sleep(1000);
      expect(box.out).not.toContain("drain-file");
      expect(box.child.exitCode).toBe(null);
    } finally {
      box.child.kill("SIGTERM");
      await exitOf(box.child);
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("pool visibility in status/doctor (WM-226)", () => {
  test("no pool ever started → no pool line and no anomaly (single-worker stacks look unchanged)", async () => {
    const { getPoolLines, readPool } = await import("./cli.mjs");
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-view-none-"));
    try {
      const view = getPoolLines(readPool(dir), { runs: { byState: { QUEUED: 4 } } });
      expect(view.line).toBeNull();
      expect(view.anomalies).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live supervisor reports its pool size; a dead one with a queue is an anomaly", async () => {
    const { getPoolLines, readPool } = await import("./cli.mjs");
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-pool-view-"));
    try {
      // This process stands in for a live supervisor and a live worker.
      writeFileSync(path.join(dir, "supervisor.pid"), `${process.pid}\n`);
      writeFileSync(path.join(dir, "worker-1.pid"), `${process.pid}\n`);
      writeFileSync(path.join(dir, "worker-1.id"), "worker_live\n");
      let view = getPoolLines(readPool(dir), { runs: { byState: { QUEUED: 2 } } });
      expect(view.line).toContain(`supervisor live (pid ${process.pid})`);
      expect(view.line).toContain("workers 1");
      expect(view.anomalies).toEqual([]);

      // A drained slot is visible while it winds down.
      writeFileSync(path.join(dir, "worker-1.drain"), "scale-down\n");
      expect(getPoolLines(readPool(dir), {}).line).toContain("(1 draining)");

      // A queue with waiting runs and a dead supervisor is the §13 anomaly:
      // nothing is left that can grow the pool behind the workers still up.
      writeFileSync(path.join(dir, "supervisor.pid"), "2147483646\n");
      view = getPoolLines(readPool(dir), { runs: { byState: { QUEUED: 2 } } });
      expect(view.line).toContain("supervisor DEAD");
      expect(view.anomalies).toEqual(["worker pool supervisor is dead (stale pid 2147483646) with 2 queued run(s)"]);

      // Dead but nothing waiting is a stopped stack, not an anomaly.
      expect(getPoolLines(readPool(dir), { runs: { byState: { QUEUED: 0 } } }).anomalies).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
