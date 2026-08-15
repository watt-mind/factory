import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./lib/db.mjs";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));

/** A loopback port nothing in these tests ever listens on. */
const DEAD_PORT = "59987";

function runCli(args, env = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "evrt-cli-"));
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, FACTORY_EVENT_HOME: home, ...env },
  });
  return { ...result, all: `${result.stdout}${result.stderr}` };
}

describe("cli", () => {
  test("no command → usage text listing all verbs, non-zero exit", () => {
    const r = runCli([]);
    expect(r.status).not.toBe(0);
    for (const verb of [
      "serve", "status", "doctor", "ps", "runs", "proposals", "approve", "reject",
      "inject", "cancel", "retry", "inspect", "update-pins",
    ]) {
      expect(r.all).toContain(verb);
    }
    expect(r.all).toContain("usage:");
    expect(r.all).toContain("--watch");
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
    const { tick } = await import("./cli.mjs");
    const { loadRegistry } = await import("./lib/registry.mjs");
    const { chmodSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");

    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-tick-notify-"));
    const outFile = path.join(dir, "pushes.txt");
    const stub = path.join(dir, "notify-stub.sh");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${outFile}\n`);
    chmodSync(stub, 0o755);

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
    try {
      await tick({ db, registry: loadRegistry(), policyVersion: "git:test", log: (l) => logs.push(l) });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !existsSync(outFile)) {
        await Bun.sleep(50);
      }
      expect(readFileSync(outFile, "utf8").trim()).toBe(
        "BLOCKED linear.ticket.agent_ready evt-tick: no_worktree_scripts",
      );
      expect(logs.some((l) => l.includes("notify human_needed test/evt-tick"))).toBe(true);
      // A second tick pushes nothing new.
      await tick({ db, registry: loadRegistry(), policyVersion: "git:test", log: () => {} });
      await Bun.sleep(200);
      expect(readFileSync(outFile, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      if (saved.N === undefined) delete process.env.FACTORY_EVENT_NOTIFY;
      else process.env.FACTORY_EVENT_NOTIFY = saved.N;
      if (saved.C === undefined) delete process.env.FACTORY_EVENT_NOTIFY_CMD;
      else process.env.FACTORY_EVENT_NOTIFY_CMD = saved.C;
      db.close();
    }
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
        env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_EVENT_PORT: port },
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
        env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_EVENT_PORT: port },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    expect(docRes.status).not.toBe(0);
    expect(docRes.stdout).toContain("stalled worker w-stalled-test");
  });
});
