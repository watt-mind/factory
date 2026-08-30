import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-work-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { policyVersion } from "../lib/config.mjs";
import { openDb } from "../lib/db.mjs";
import { listWorkers } from "../lib/workers.mjs";
import {
  CLI,
  DEAD_PORT,
  assertHealthyLiveServe,
  awaitFile,
  editStampRoot,
  exitOf,
  killPool,
  loadAdjustedTimeout,
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

const WORKER_POLICY_VERSION = policyVersion();
const LIVE_STACK = path.resolve(import.meta.dir, "../../bin/live-stack.sh");

/** Poll the registry until the worker row exists (registration is racy vs stdout). */
async function registeredWorker(home, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const db = openDb(path.join(home, "runtime.db"));
    const [worker] = listWorkers(db);
    db.close();
    if (worker) return worker;
    if (Date.now() >= deadline) throw new Error("worker never registered");
    await Bun.sleep(25);
  }
}

async function seedSkippedRun(
  home,
  { runId, placement, promptVersion = WORKER_POLICY_VERSION, queuedReason },
) {
  const { createRun, transition } = await import("../lib/lifecycle.mjs");
  const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");
  const db = openDb(path.join(home, "runtime.db"));
  const input = { repos: ["ok"] };
  const spec = {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: false },
    adapter: "fake",
    promptVersion,
    policyVersion: promptVersion,
    ...(placement ? { placement } : {}),
    outputContract: "factory.status-report/v1",
    capabilities: ["linear:read"],
    timeoutSeconds: 5,
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
  transition(db, {
    runId,
    to: "QUEUED",
    actor: "test",
    ...(queuedReason ? { reason: queuedReason } : {}),
    now: Date.now(),
  });
  db.close();
}

/** Capture the shell supervisor's restart events, not just its worker's logs. */
function spawnReloadSupervisor(args, env) {
  const child = spawnTracked(
    "bash",
    [LIVE_STACK, "__supervise-worker", ...args],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const box = { out: "", child };
  child.stdout.on("data", (b) => {
    box.out += b;
  });
  child.stderr.on("data", (b) => {
    box.out += b;
  });
  return box;
}

describe("work command", () => {
  test("work rejects an unsafe idle poll interval", () => {
    const r = runCli(["work", "--poll-ms", "0"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain(
      "work: --poll-ms must be an integer between 25 and 5000",
    );
  });

  test("work rejects unsafe drain timeouts before registering", () => {
    for (const value of ["not-a-number", "0", "-1"]) {
      const r = runCli(["work", "--drain-timeout", value]);
      expect(r.status).not.toBe(0);
      expect(r.all).toContain(
        "work: --drain-timeout must be an integer between 1 and 3600 seconds",
      );
    }
  });

  test("work with unknown --adapter-override exits non-zero with error", () => {
    const r = runCli(["work", "--adapter-override", "nonexistent"]);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('work: unknown --adapter-override "nonexistent"');
  });

  test(
    "reports an unsatisfied queued placement once per skip-report interval",
    async () => {
      const home = tmpDir("evrt-work-placement-skip-");
      await seedSkippedRun(home, {
        runId: "run_placement_skip",
        placement: { node: "gpu" },
      });
      const box = spawnWorker(
        [
          "--adapter-override",
          "fake",
          "--label",
          "node=cpu",
          "--poll-ms",
          "25",
          "--skip-report-ms",
          "1000",
        ],
        { FACTORY_EVENT_HOME: home },
      );
      try {
        await waitFor(box, '"runId":"run_placement_skip"');
        await Bun.sleep(100); // at least three more 25ms polls
        expect(box.out.match(/"runId":"run_placement_skip"/g)).toHaveLength(1);
        expect(box.out).toContain('"definition":"factory-status-report@1"');
        expect(box.out).toContain("placement_unsatisfied:node=gpu");
      } finally {
        box.child.kill("SIGTERM");
        await exitOf(box.child);
        rmSync(home, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "folds stale registry refusals into the rate-limited skip report",
    async () => {
      const home = tmpDir("evrt-work-registry-skip-");
      await seedSkippedRun(home, {
        runId: "run_registry_skip",
        promptVersion: "git:older-registry",
      });
      const box = spawnWorker(
        [
          "--adapter-override",
          "fake",
          "--poll-ms",
          "25",
          "--skip-report-ms",
          "1000",
        ],
        { FACTORY_EVENT_HOME: home },
      );
      try {
        await waitFor(box, '"runId":"run_registry_skip"');
        await Bun.sleep(100); // at least three more 25ms polls
        expect(box.out.match(/"runId":"run_registry_skip"/g)).toHaveLength(1);
        expect(box.out).toMatch(
          /registry_stale:spec=git:older-registry\/git:older-registry:worker=git:[^:"]+:checkout=git:[^"}]+/,
        );
        expect(box.out).not.toContain("refused run_registry_skip");
        const worker = await registeredWorker(home);
        expect(worker.skipped).toEqual([
          {
            runId: "run_registry_skip",
            definition: "factory-status-report@1",
            reason: expect.stringMatching(/^registry_stale:/),
          },
        ]);
      } finally {
        box.child.kill("SIGTERM");
        await exitOf(box.child);
        rmSync(home, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "publishes cached skipped diagnostics to the registry and caps them",
    async () => {
      const home = tmpDir("evrt-work-registry-diagnostics-");
      for (let index = 0; index < 51; index += 1) {
        await seedSkippedRun(home, {
          runId: `run_registry_${String(index).padStart(3, "0")}`,
          promptVersion: "git:older-registry",
        });
      }
      const box = spawnWorker(
        [
          "--adapter-override",
          "fake",
          "--poll-ms",
          "25",
          "--skip-report-ms",
          "1000",
        ],
        { FACTORY_EVENT_HOME: home },
      );
      try {
        await waitFor(box, '"runId":"run_registry_000"');
        const worker = await registeredWorker(home);
        expect(worker.skipped).toHaveLength(50);
        expect(worker.skipped[0].runId).toBe("run_registry_000");
        expect(worker.skipped.at(-1)).toEqual({
          runId: "...",
          reason: "and 2 more",
        });
      } finally {
        box.child.kill("SIGTERM");
        await exitOf(box.child);
        rmSync(home, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "reports a queued claim backoff with its retry time",
    async () => {
      const home = tmpDir("evrt-work-backoff-skip-");
      await seedSkippedRun(home, {
        runId: "run_backoff_skip",
        queuedReason: "claim_lock_contention:1:backoff_10000ms",
      });
      const box = spawnWorker(
        [
          "--adapter-override",
          "fake",
          "--poll-ms",
          "25",
          "--skip-report-ms",
          "1000",
        ],
        { FACTORY_EVENT_HOME: home },
      );
      try {
        await waitFor(box, '"runId":"run_backoff_skip"');
        expect(box.out).toMatch(/"reason":"backoff_until:\d{4}-\d{2}-\d{2}T/);
      } finally {
        box.child.kill("SIGTERM");
        await exitOf(box.child);
        rmSync(home, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );

  test("executeClaimed respects adapterOverride option", async () => {
    const { openDb } = await import("../lib/db.mjs");
    const { createRun, transition } = await import("../lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const { claimNext, executeClaimed } = await import("../lib/worker.mjs");

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
    transition(db, {
      runId: spec.runId,
      to: "APPROVED",
      actor: "test",
      now: Date.now(),
    });
    transition(db, {
      runId: spec.runId,
      to: "QUEUED",
      actor: "test",
      now: Date.now(),
    });

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
              artifact: {
                repos: [
                  {
                    name: "ok",
                    triage: 1,
                    agentReady: 2,
                    inProgress: 0,
                    blocked: 0,
                  },
                ],
                recommendedAction: "dispatch",
              },
              evidence: { queries: ["fake"] },
            }),
            "utf8",
          );
          return { exitCode: 0, timedOut: false };
        },
      },
    };

    const home = tmpDir("evrt-override-");
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
    const { openDb } = await import("../lib/db.mjs");
    const { createRun, transition } = await import("../lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");

    const home = tmpDir("evrt-work-proc-");
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
      promptVersion: WORKER_POLICY_VERSION,
      policyVersion: WORKER_POLICY_VERSION,
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
    transition(db, {
      runId: spec.runId,
      to: "APPROVED",
      actor: "test",
      now: Date.now(),
    });
    transition(db, {
      runId: spec.runId,
      to: "QUEUED",
      actor: "test",
      now: Date.now(),
    });
    db.close();

    const child = spawnTracked(
      "bun",
      [CLI, "work", "--adapter-override", "fake"],
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
    expect(await waitFor(box, "run_work_proc_test → COMPLETED", 8000)).toBe(
      true,
    );

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(out).toContain('adapter override: executing every run with "fake"');
    expect(out).toContain(
      "claimed run_work_proc_test attempt 1 (factory-status-report@1)",
    );
    expect(out).toContain("run_work_proc_test → COMPLETED (ok)");

    const verifyDb = openDb(path.join(home, "runtime.db"));
    const row = verifyDb
      .query(`SELECT state FROM runs WHERE run_id = ?`)
      .get("run_work_proc_test");
    expect(row?.state).toBe("COMPLETED");
    verifyDb.close();
  });

  test("work --adapter-override pi is accepted at the work call site (OPS-517)", async () => {
    const home = tmpDir("evrt-work-pi-");
    const child = spawnTracked(
      "bun",
      [CLI, "work", "--adapter-override", "pi"],
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
    expect(await waitFor(box, "adapter override", 8000)).toBe(true);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(out).not.toContain('unknown --adapter-override "pi"');
    expect(out).toContain('adapter override: executing every run with "pi"');
  });

  test("pi-smoke@1 routes end-to-end through the pi adapter via a fake shim (OPS-517)", async () => {
    const { createRun, transition } = await import("../lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const { claimNext, executeClaimed } = await import("../lib/worker.mjs");

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
    transition(db, {
      runId: spec.runId,
      to: "APPROVED",
      actor: "test",
      now: Date.now(),
    });
    transition(db, {
      runId: spec.runId,
      to: "QUEUED",
      actor: "test",
      now: Date.now(),
    });

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
          const staged = JSON.parse(
            readFileSync(path.join(workspaceDir, "input.json"), "utf8"),
          );
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

    const home = tmpDir("evrt-pi-smoke-");
    const claim = claimNext(db, { owner: "w1" });
    expect(claim).toBeTruthy();

    const summary = await executeClaimed(db, registry, mockAdapters, claim, {
      workspacesRoot: home,
    });

    expect(piCalled).toBe(true);
    expect(summary.terminalState).toBe("COMPLETED");

    const row = db
      .query(`SELECT state FROM runs WHERE run_id = ?`)
      .get("run_pi_smoke_test");
    expect(row?.state).toBe("COMPLETED");
  });

  test("agy-smoke@1 routes end-to-end through the agy adapter via a fake shim (WM-424)", async () => {
    const { createRun, transition } = await import("../lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const { claimNext, executeClaimed } = await import("../lib/worker.mjs");

    const db = openDb(":memory:");
    const registry = loadRegistry();

    const input = { message: "hello from WM-424" };
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_agy_smoke_test",
      agent: "agy-smoke@1",
      input,
      inputHash: hashJson(input),
      workspace: { type: "ephemeral", retainOnFailure: true },
      adapter: "agy",
      model: "gemini-3.7-flash",
      effort: "high",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.agy-smoke/v1",
      capabilities: [],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: "idem_agy_smoke_test",
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
    transition(db, {
      runId: spec.runId,
      to: "APPROVED",
      actor: "test",
      now: Date.now(),
    });
    transition(db, {
      runId: spec.runId,
      to: "QUEUED",
      actor: "test",
      now: Date.now(),
    });

    let agyCalled = false;
    const mockAdapters = {
      agy: {
        execute: async ({ spec: runSpec, workspaceDir }) => {
          agyCalled = true;
          const { readFileSync, writeFileSync } = await import("node:fs");
          const { default: path } = await import("node:path");
          const staged = JSON.parse(
            readFileSync(path.join(workspaceDir, "input.json"), "utf8"),
          );
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

    const home = tmpDir("evrt-agy-smoke-");
    const claim = claimNext(db, { owner: "w1" });
    expect(claim).toBeTruthy();

    const summary = await executeClaimed(db, registry, mockAdapters, claim, {
      workspacesRoot: home,
    });

    expect(agyCalled).toBe(true);
    expect(summary.terminalState).toBe("COMPLETED");

    const row = db
      .query(`SELECT state FROM runs WHERE run_id = ?`)
      .get("run_agy_smoke_test");
    expect(row?.state).toBe("COMPLETED");
  });

  test("work --adapter-override cursor is accepted at the work call site (WM-440)", async () => {
    const home = tmpDir("evrt-work-cursor-");
    const child = spawnTracked(
      "bun",
      [CLI, "work", "--adapter-override", "cursor"],
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
    expect(await waitFor(box, "adapter override", 8000)).toBe(true);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(out).not.toContain('unknown --adapter-override "cursor"');
    expect(out).toContain(
      'adapter override: executing every run with "cursor"',
    );
  });

  test("cursor-smoke@1 routes end-to-end through the cursor adapter via a fake shim (WM-440)", async () => {
    const { createRun, transition } = await import("../lib/lifecycle.mjs");
    const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");
    const { loadRegistry } = await import("../lib/registry.mjs");
    const { claimNext, executeClaimed } = await import("../lib/worker.mjs");

    const db = openDb(":memory:");
    const registry = loadRegistry();

    const input = { message: "hello from WM-440" };
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_cursor_smoke_test",
      agent: "cursor-smoke@1",
      input,
      inputHash: hashJson(input),
      workspace: { type: "ephemeral", retainOnFailure: true },
      adapter: "cursor",
      model: "composer-2.5-fast",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.cursor-smoke/v1",
      capabilities: [],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: "idem_cursor_smoke_test",
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
    transition(db, {
      runId: spec.runId,
      to: "APPROVED",
      actor: "test",
      now: Date.now(),
    });
    transition(db, {
      runId: spec.runId,
      to: "QUEUED",
      actor: "test",
      now: Date.now(),
    });

    let cursorCalled = false;
    const mockAdapters = {
      cursor: {
        execute: async ({ workspaceDir }) => {
          cursorCalled = true;
          const { readFileSync, writeFileSync } = await import("node:fs");
          const { default: path } = await import("node:path");
          const staged = JSON.parse(
            readFileSync(path.join(workspaceDir, "input.json"), "utf8"),
          );
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

    const home = tmpDir("evrt-cursor-smoke-");
    const claim = claimNext(db, { owner: "w1" });
    expect(claim).toBeTruthy();

    const summary = await executeClaimed(db, registry, mockAdapters, claim, {
      workspacesRoot: home,
    });

    expect(cursorCalled).toBe(true);
    expect(summary.terminalState).toBe("COMPLETED");

    const row = db
      .query(`SELECT state FROM runs WHERE run_id = ?`)
      .get("run_cursor_smoke_test");
    expect(row?.state).toBe("COMPLETED");
  });
});

describe("work --reload-on-change (WM-213)", () => {
  test(
    "plain work never arms the watcher",
    async () => {
      const home = tmpDir("evrt-reload-off-");
      const stampRoot = makeStampRoot();
      const box = spawnWorker(
        ["--adapter-override", "fake", "--poll-ms", "50"],
        {
          FACTORY_EVENT_HOME: home,
          FACTORY_CODE_STAMP_ROOT: stampRoot,
        },
      );
      try {
        expect(await waitFor(box, "adapter override")).toBe(true);
        editStampRoot(stampRoot, "// v2\n");
        await seedRun(home, {
          runId: "run_reload_off",
          input: { repos: ["ok"] },
        });
        expect(await waitFor(box, "run_reload_off → COMPLETED")).toBe(true);
        expect(box.out).not.toContain("reload-on-change");
        expect(box.out).not.toContain("reloading worker");
        expect(box.child.exitCode).toBe(null); // still running
      } finally {
        box.child.kill("SIGTERM");
        await exitOf(box.child);
        rmSync(stampRoot, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "an idle worker exits 75 within a poll interval of an uncommitted edit",
    async () => {
      const home = tmpDir("evrt-reload-idle-");
      const stampRoot = makeStampRoot();
      const box = spawnWorker(
        ["--adapter-override", "fake", "--poll-ms", "50", "--reload-on-change"],
        {
          FACTORY_EVENT_HOME: home,
          FACTORY_CODE_STAMP_ROOT: stampRoot,
        },
      );
      try {
        expect(
          await waitFor(box, "reload-on-change: armed at code stamp"),
        ).toBe(true);
        // No commit — only a working-tree write. HEAD is unchanged (this tree has
        // no git at all), so a HEAD-only stamp would sit here forever.
        editStampRoot(stampRoot, "// v2\n");
        const { code, signal } = await exitOf(box.child);
        expect({ code, signal, tail: box.out.slice(-600) }).toMatchObject({
          code: 75,
          signal: null,
        });
        expect(box.out).toContain("reloading worker (exit 75)");
        // The log names both stamps so the developer can see what moved.
        expect(box.out).toMatch(
          /code changed \(files:[0-9a-f]+ → files:[0-9a-f]+\)/,
        );
        expect(box.out).toContain("worker stopped (code_reload)");
      } finally {
        box.child.kill("SIGKILL");
        rmSync(stampRoot, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "an idle worker reloads when a per-command module changes",
    async () => {
      const home = tmpDir("evrt-reload-command-");
      const stampRoot = makeStampRoot();
      const box = spawnWorker(
        ["--adapter-override", "fake", "--poll-ms", "50", "--reload-on-change"],
        {
          FACTORY_EVENT_HOME: home,
          FACTORY_CODE_STAMP_ROOT: stampRoot,
        },
      );
      try {
        expect(
          await waitFor(box, "reload-on-change: armed at code stamp"),
        ).toBe(true);
        writeFileSync(
          path.join(stampRoot, "event-runtime", "cli", "work.mjs"),
          "// v2\n",
          "utf8",
        );
        const { code, signal } = await exitOf(box.child);
        expect({ code, signal, tail: box.out.slice(-600) }).toMatchObject({
          code: 75,
          signal: null,
        });
        expect(box.out).toContain("reloading worker (exit 75)");
      } finally {
        box.child.kill("SIGKILL");
        rmSync(stampRoot, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );

  test(
    "a run in flight defers reload; its supervisor restarts only once it is idle",
    async () => {
      const { openDb } = await import("../lib/db.mjs");
      const { createRun, transition } = await import("../lib/lifecycle.mjs");
      const { canonicalJson, hashJson } = await import("../lib/canonical.mjs");
      const { HOLD_PREFIX, holdMarkerFile } =
        await import("../lib/adapters/fake.mjs");

      const home = tmpDir("evrt-reload-busy-");
      const stampRoot = makeStampRoot();
      const db = openDb(path.join(home, "runtime.db"));

      // The fake adapter's hold mode keeps the run in flight until this file
      // exists — the in-flight window is opened and closed by the test, not by
      // the wall clock (gh-1423). The spec timeout is only a safety net.
      const releaseFile = path.join(home, "release-run_reload_busy");
      const input = { repos: [`${HOLD_PREFIX}${releaseFile}`] };
      const spec = {
        schemaVersion: "factory.run-spec/v1",
        runId: "run_reload_busy",
        agent: "factory-status-report@1",
        input,
        inputHash: hashJson(input),
        workspace: { type: "ephemeral", retainOnFailure: false },
        adapter: "fake",
        promptVersion: WORKER_POLICY_VERSION,
        policyVersion: WORKER_POLICY_VERSION,
        outputContract: "factory.status-report/v1",
        capabilities: ["linear:read"],
        timeoutSeconds: 120,
        maxAttempts: 1,
        idempotencyKey: "idem_reload_busy",
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
      transition(db, {
        runId: spec.runId,
        to: "APPROVED",
        actor: "test",
        now: Date.now(),
      });
      transition(db, {
        runId: spec.runId,
        to: "QUEUED",
        actor: "test",
        now: Date.now(),
      });
      db.close();
      // Keep the queue non-empty when the first run finishes. The worker must
      // reload at that boundary rather than claiming this run with old code.
      await seedRun(home, {
        runId: "run_reload_waiting",
        input: { repos: ["ok"] },
      });

      const DEADLINE_MS = 30_000;
      const box = spawnReloadSupervisor(
        ["--adapter-override", "fake", "--poll-ms", "50", "--reload-on-change"],
        {
          FACTORY_EVENT_HOME: home,
          FACTORY_CODE_STAMP_ROOT: stampRoot,
        },
      );
      try {
        expect(await waitFor(box, "claimed run_reload_busy", DEADLINE_MS)).toBe(
          true,
        );
        // Proven in flight: the adapter has entered the hold, not merely been
        // claimed — so the edit below lands strictly inside the run.
        await awaitFile(holdMarkerFile(releaseFile), "hold marker", {
          timeoutMs: DEADLINE_MS,
        });
        editStampRoot(stampRoot, "// v2\n");

        expect(
          await waitFor(
            box,
            "reload deferred until run_reload_busy finishes",
            DEADLINE_MS,
          ),
        ).toBe(true);
        // The deferral was logged while the run was still held open, and the
        // worker was still alive at that point — asserted, not slept for.
        expect(box.out).not.toContain("run_reload_busy → ");
        expect(box.out).not.toContain("reloading worker");
        expect(box.out).not.toContain("[supervisor] worker reloaded");
        expect(box.child.exitCode).toBe(null);

        writeFileSync(releaseFile, "go\n", "utf8");
        // Observe the handoff from the component that actually restarts the
        // worker. The replacement then claims the queued run, proving it was
        // re-execed only after the held lease was released.
        expect(
          await waitFor(
            box,
            "[supervisor] worker reloaded (exit 75) — restarting on new code",
            DEADLINE_MS,
          ),
        ).toBe(true);
        expect(
          await waitFor(box, "claimed run_reload_waiting", DEADLINE_MS),
        ).toBe(true);
        expect(
          await waitFor(box, "run_reload_waiting → COMPLETED", DEADLINE_MS),
        ).toBe(true);
        // Order is the guarantee: the held run reached a terminal state before
        // the supervisor accepted the reload handoff.
        expect(box.out).toContain("run_reload_busy → COMPLETED");
        expect(box.out.indexOf("run_reload_busy → ")).toBeLessThan(
          box.out.indexOf("[supervisor] worker reloaded"),
        );
        // Exactly one deferral line however many intervals it spanned, and
        // exactly one reload recorded by the supervisor that owns restarts.
        expect(box.out.split("reload deferred until").length - 1).toBe(1);
        expect(box.out.split("[supervisor] worker reloaded").length - 1).toBe(
          1,
        );
      } finally {
        box.child.kill("SIGTERM");
        await exitOf(box.child, DEADLINE_MS);
        rmSync(stampRoot, { recursive: true, force: true });
      }

      const verifyDb = openDb(path.join(home, "runtime.db"));
      const row = verifyDb
        .query(`SELECT state FROM runs WHERE run_id = ?`)
        .get("run_reload_busy");
      expect(row?.state).toBe("COMPLETED");
      verifyDb.close();
    },
    loadAdjustedTimeout(90_000),
  );
});

describe("work --drain-file (WM-226)", () => {
  test(
    "a drain-signalled worker holding a lease finishes its run first, then exits 0",
    async () => {
      const home = tmpDir("evrt-drain-busy-");
      const dir = tmpDir("evrt-drain-busy-run-");
      const drainFile = path.join(dir, "worker-1.drain");
      await seedRun(home, {
        runId: "run_drain_busy",
        input: { repos: ["hang"] },
        timeoutSeconds: 4,
      });

      const box = spawnWorker(
        [
          "--adapter-override",
          "fake",
          "--poll-ms",
          "50",
          "--drain-file",
          drainFile,
        ],
        { FACTORY_EVENT_HOME: home },
      );
      try {
        expect(await waitFor(box, "claimed run_drain_busy")).toBe(true);
        writeFileSync(drainFile, "scale-down\n", "utf8");

        const { code } = await exitOf(box.child);
        expect(code).toBe(0); // a clean drain, not the reload code
        // Order is the guarantee: the run reached a terminal state BEFORE the exit.
        expect(box.out.indexOf("run_drain_busy → ")).toBeGreaterThan(-1);
        expect(box.out.indexOf("drain requested")).toBeGreaterThan(-1);
        expect(box.out.indexOf("run_drain_busy → ")).toBeLessThan(
          box.out.indexOf("drain requested"),
        );
        expect(box.out).toContain("worker stopped (drain_requested)");
      } finally {
        box.child.kill("SIGKILL");
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(45_000),
  );

  test(
    "plain work ignores a drain file it was never given",
    async () => {
      const home = tmpDir("evrt-drain-off-");
      const dir = tmpDir("evrt-drain-off-run-");
      writeFileSync(path.join(dir, "worker-1.drain"), "scale-down\n", "utf8");
      const box = spawnWorker(
        ["--adapter-override", "fake", "--poll-ms", "50"],
        {
          FACTORY_EVENT_HOME: home,
        },
      );
      try {
        expect(await waitFor(box, "adapter override")).toBe(true);
        await seedRun(home, {
          runId: "run_drain_off",
          input: { repos: ["ok"] },
        });
        expect(await waitFor(box, "run_drain_off → COMPLETED")).toBe(true);
        expect(box.out).not.toContain("drain-file");
        expect(box.child.exitCode).toBe(null);
      } finally {
        box.child.kill("SIGTERM");
        await exitOf(box.child);
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    loadAdjustedTimeout(30_000),
  );
});
