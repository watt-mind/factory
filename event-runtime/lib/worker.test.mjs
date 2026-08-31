import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-worker-test-mjs";
import "../test-helpers.mjs";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { loadAdjustedTimeout } from "./test-helpers-timing.mjs";

/**
 * Ceiling for the execute-side adapter spawn tests (WM-1025).
 *
 * These spawn a real CLI subprocess. 5s is comfortable on a quiet machine and
 * demonstrably not comfortable on a contended one: on 2026-08-22 four of these
 * timed out under concurrent runners and took WM-1008, WM-1015 and WM-534 out
 * of the queue with them — WM-1015 was a documentation-only diff that could
 * not merge because of it.
 *
 * `loadAdjustedTimeout` is the repo's existing answer (CI sets CI_LOAD_FACTOR,
 * capped at 4x). This file was simply not wired into it. Scaling a liveness
 * ceiling changes no assertion: every check below still waits on observable
 * state, so a real hang still fails, just not a slow host.
 */
const EXECUTE_SPAWN_TIMEOUT_MS = loadAdjustedTimeout(5_000);

/**
 * Ceiling for the isolated-process local-notify drain probe (GH-2011). It
 * spawns a Bun child that loads the worker module graph, which is comfortably
 * under a second on a quiet box and demonstrably slower on a contended one.
 * Scaling it weakens no assertion: the probe's own asserts decide the verdict.
 */
const LOCAL_NOTIFY_PROBE_TIMEOUT_MS = loadAdjustedTimeout(20_000);
import {
  composeHandoffVerification,
  ContractViolation,
  HANDOFF_DEPENDENCIES_MISSING,
  insideHandoffSandbox,
  verifyResult,
} from "./verify.mjs";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
const realReadFileSync = nodeFs.readFileSync;
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildClaudeArgv,
  execute as executeClaude,
} from "./adapters/claude.mjs";
import * as fake from "./adapters/fake.mjs";
import { buildPiArgv, execute as executePi } from "./adapters/pi.mjs";
import { createAdapterRegistry } from "./adapters/index.mjs";
import { SandboxUnsupportedError } from "./adapters/sandboxed.mjs";
import { pinRunArtifact } from "./artifacts.mjs";
import { memoryForge } from "../../lib/forge/index.mjs";
import { admitEvent } from "./intake.mjs";
import { planEvent } from "./planner.mjs";
import { canonicalJson, hashBytes, hashJson } from "./canonical.mjs";
import { artifactsRoot, resolveConfigPath } from "./config.mjs";
import { openDb, runUsage } from "./db.mjs";
import {
  createRun,
  lifecycleOf,
  runState,
  transition,
  IllegalTransition,
} from "./lifecycle.mjs";
import { computeDefHash } from "./receipts.mjs";
import { listMemos, registerMemos } from "./memos.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import { transcriptSessionId } from "./transcripts.mjs";
import {
  dispatchIdentityEnv,
  acquireClaimLock,
  adapterExecuteTimeoutMs,
  assertHandoffPullRequestBase,
  cancelRun,
  CLAIM_LOCK_BACKOFF_MAX_MS,
  claimNext,
  claimedRetryFor,
  CODE_RELOAD_EXIT,
  codeStamp,
  codeStampFiles,
  codeStampRoot,
  continuationExecutionInput,
  continuationHandoffFailure,
  escalationHandoffFailure,
  createReloadWatcher,
  DEFAULT_MAX_ENVIRONMENT_RETRIES,
  defaultFindWorkspacePullRequest,
  defaultLocksDir,
  defaultMarkHandoffPullRequestReady,
  defaultReconcileVerifiedHandoffTicket,
  defaultHoldPullRequest,
  defaultProjectTierEscalation,
  defaultReturnHandoffTicket,
  defaultUnclaimTicket,
  drainLocalNotifyOutbox,
  dispatchLockPath,
  DYNAMIC_DEADLINE_ADAPTERS,
  executeClaimed,
  classifyFailureCause,
  expireRunDeadline,
  extendRunDeadline,
  forceFailRun,
  HarnessMaterializeError,
  HANDOFF_FORGE_UNAVAILABLE,
  humanDecisionAuthorisationGate,
  LEASE_GRACE_SECONDS,
  policyMaxRunMinutes,
  policyWorkspaceOnlyFallback,
  materializeRunHarness,
  reapExpiredLeases,
  releaseStalledWorkerLease,
  releaseClaimLock,
  repositoryIsClean,
  repositoryStatus,
  provisionInstanceLocalConfigs,
  recoverMissingDispatchResult,
  runClaimPathGitProbe,
  resolveLinearApiKey,
  reconcileTierEscalations,
  scheduleTierEscalation,
  sweepOrphanedLocalNotifyOutbox,
  tierEscalationContinuationGuard,
  tierEscalationEligibility,
  retryRun,
  runLinearCli,
  runOnce,
  ticketHandoffContext,
} from "./worker.mjs";
import {
  liveWorkerLeases,
  writeWorkerLease,
} from "../../lib/worker-leases.mjs";
import {
  cleanupTrackedProcesses,
  processOwnerWatchdogSource,
  registerTestProcessCleanup,
  trackMarkedFakeRuntimeGroups,
  trackProcess,
  trackProcessGroupsMatching,
} from "./test-helpers-process.mjs";

import {
  EMPTY_POLICY_ROOT,
  adapters,
  dispatchConfigSnapshot,
  freshRoot,
  insertStalledWorker,
  linkEvent,
  makeSpec,
  opts,
  queueRun,
  registry,
  T0,
} from "./worker-test-helpers.mjs";

registerTestProcessCleanup(import.meta.url);

let seq = 0;

describe("worker", () => {
  test("sweeps orphaned local notify outboxes while preserving active runs", () => {
    const home = tmpDir("evrt-local-notify-sweep-");
    const outboxDir = path.join(home, "outbox");
    const db = openDb(":memory:");
    const active = queueRun(db, makeSpec({ runId: "run_active_outbox" }));
    claimNext(db, opts());
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(path.join(outboxDir, `${active.runId}.jsonl`), "active\n");
    writeFileSync(path.join(outboxDir, "run_orphan_outbox.jsonl"), "orphan\n");

    // Past the grace window: the inactive run's file is eligible, the active
    // run's file is still protected by its state.
    expect(
      sweepOrphanedLocalNotifyOutbox({
        db,
        home,
        now: Date.now() + 2 * 60 * 60 * 1000,
      }),
    ).toEqual(["run_orphan_outbox"]);
    expect(existsSync(path.join(outboxDir, `${active.runId}.jsonl`))).toBe(
      true,
    );
    expect(existsSync(path.join(outboxDir, "run_orphan_outbox.jsonl"))).toBe(
      false,
    );
    rmSync(home, { recursive: true, force: true });
  });

  test("leaves an outbox file inside the mtime grace window alone", () => {
    // Without an age grace the sweep deletes the very file a live drain
    // retains as its recovery source: the agent writes the outbox before the
    // worker's run is visible in any active state to this sweep's snapshot.
    const home = tmpDir("evrt-local-notify-grace-");
    const outboxDir = path.join(home, "outbox");
    const db = openDb(":memory:");
    mkdirSync(outboxDir, { recursive: true });
    const fresh = path.join(outboxDir, "run_fresh_outbox.jsonl");
    writeFileSync(fresh, "fresh\n");

    expect(sweepOrphanedLocalNotifyOutbox({ db, home })).toEqual([]);
    expect(existsSync(fresh)).toBe(true);

    // Only once the file has aged past the window does it become eligible.
    expect(
      sweepOrphanedLocalNotifyOutbox({
        db,
        home,
        now: Date.now() + 61 * 60 * 1000,
      }),
    ).toEqual(["run_fresh_outbox"]);
    expect(existsSync(fresh)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("drains an agent local notification outbox with the worker bearer", async () => {
    const home = tmpDir("evrt-local-notify-outbox-");
    const runId = "run_1558";
    const outbox = path.join(home, "outbox", `${runId}.jsonl`);
    mkdirSync(path.dirname(outbox), { recursive: true });
    writeFileSync(
      outbox,
      `${JSON.stringify({
        schemaVersion: "factory.local-notify-outbox/v1",
        runId,
        kind: "BLOCKED",
        title: "BLOCKED watt-mind/factory#1558: token unavailable",
        refs: { issue: "watt-mind/factory#1558", repo: "factory" },
        source: `agent:${runId}`,
      })}\n`,
    );
    const calls = [];
    const result = await drainLocalNotifyOutbox({
      home,
      runId,
      port: "7499",
      token: "worker-only-token",
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return new Response("{}", { status: 201 });
      },
    });

    expect(result).toEqual({
      delivered: [
        expect.objectContaining({
          title: "BLOCKED watt-mind/factory#1558: token unavailable",
        }),
      ],
      undelivered: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.authorization).toBe(
      "Bearer worker-only-token",
    );
    expect(existsSync(outbox)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("reports one undelivered entry per line for an invalid port", async () => {
    // The caller only reads `undelivered`; an `error` field alone made a
    // misconfigured port invisible and the retained lines were then swept.
    const home = tmpDir("evrt-local-notify-invalid-port-");
    const runId = "run_invalid_port";
    const outbox = path.join(home, "outbox", `${runId}.jsonl`);
    mkdirSync(path.dirname(outbox), { recursive: true });
    const line = (title) =>
      JSON.stringify({
        schemaVersion: "factory.local-notify-outbox/v1",
        runId,
        kind: "BLOCKED",
        title,
        refs: {},
        source: `agent:${runId}`,
      });
    writeFileSync(
      outbox,
      `${line("BLOCKED watt-mind/factory#1964: invalid port")}\n${line(
        "BLOCKED watt-mind/factory#1964: second escalation",
      )}\nnot-json\n`,
    );
    const expectedError =
      "FACTORY_EVENT_PORT must be a positive integer between 1 and 65535";
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls += 1;
      throw new Error("invalid ports must not attempt notification delivery");
    };
    try {
      const result = await drainLocalNotifyOutbox({
        home,
        runId,
        port: "not-a-port",
        fetchFn,
      });
      expect(result.delivered).toEqual([]);
      expect(result.undelivered).toEqual([
        {
          title: "BLOCKED watt-mind/factory#1964: invalid port",
          error: expectedError,
        },
        {
          title: "BLOCKED watt-mind/factory#1964: second escalation",
          error: expectedError,
        },
        { title: "invalid local notification record", error: expectedError },
      ]);
      expect(fetchCalls).toBe(0);
      // The outbox stays put as the recovery source.
      expect(existsSync(outbox)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("forbids global fetch spies in lib tests", () => {
    // Worker code accepts injected fetchFn dependencies. Keeping spies local to
    // that seam prevents a global patch from leaking into interleaved tests.
    const libDir = import.meta.dir;
    const testFiles = [];
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
          testFiles.push(file);
        }
      }
    };
    visit(libDir);

    const globalFetchSpy = /spyOn\s*\(\s*globalThis\s*,\s*["']fetch["']/;
    const violations = testFiles.filter((file) =>
      globalFetchSpy.test(readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  // The drain-on-throw behaviour is a whole-`executeClaimed` scenario, and in
  // process it was load- and order-sensitive: four dispatch-worktree
  // repo-verify gates failed on it in one morning (GH-2011) while every
  // isolated re-run passed, because the surrounding suite mutates
  // module-level fixtures this scenario reads through `executeClaimed`. The
  // probe therefore runs as its own Bun process, which owns that state; every
  // assertion lives there and each one names the invariant it guards. The
  // inbox port is allocated ephemerally here (bind :0, read it back, close)
  // and passed in, so nothing depends on a fixed local port being free.
  test(
    "drains a worktree adapter's local notifications and reports an undelivered one after the adapter throws (isolated process)",
    async () => {
      const port = await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const assigned = probe.address().port;
          probe.close(() => resolve(assigned));
        });
      });
      const script = new URL(
        "../test-support/local-notify-drain-probe.mjs",
        import.meta.url,
      ).pathname;

      const proc = Bun.spawnSync({
        cmd: ["bun", script, String(port)],
        stdout: "pipe",
        stderr: "pipe",
        cwd: new URL("../..", import.meta.url).pathname,
      });
      const stdout = proc.stdout.toString();
      const stderr = proc.stderr.toString();
      if (proc.exitCode !== 0) {
        throw new Error(
          `local-notify drain probe failed (exit ${proc.exitCode}):\n${stderr}${stdout}`,
        );
      }
      expect(stdout).toContain("PROBE_OK");
    },
    LOCAL_NOTIFY_PROBE_TIMEOUT_MS,
  );

  test("keeps exactly one local notify drain in the adapter finally to prevent double delivery", () => {
    // Two drain sites could race the same outbox read/truncate cycle and
    // deliver a BLOCKED or escalation notification twice. Keep this structural
    // guard alongside the behavioral drain tests so a future refactor cannot
    // silently add another call site.
    const source = readFileSync(
      new URL("./worker.mjs", import.meta.url),
      "utf8",
    );
    const marker =
      "    } finally {\n      stopDeadlineMonitor();\n      stopCancellationMonitor();\n";
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(open);
    const finallyBody = source.slice(open, end);
    expect(finallyBody).toContain("await drainLocalNotifyOutbox({");
    expect(source.split("await drainLocalNotifyOutbox({")).toHaveLength(2);
  });

  test("retains an undelivered local notification for handoff recovery", async () => {
    const home = tmpDir("evrt-local-notify-retained-");
    const runId = "run_1558_retained";
    const outbox = path.join(home, "outbox", `${runId}.jsonl`);
    mkdirSync(path.dirname(outbox), { recursive: true });
    writeFileSync(
      outbox,
      `${JSON.stringify({
        schemaVersion: "factory.local-notify-outbox/v1",
        runId,
        kind: "ESCALATED",
        title: "ESCALATED watt-mind/factory#1558: worker delivery failed",
        refs: { issue: "watt-mind/factory#1558", repo: "factory" },
        source: `agent:${runId}`,
      })}\n`,
    );
    const result = await drainLocalNotifyOutbox({
      home,
      runId,
      fetchFn: async () => {
        throw new Error("runtime unavailable");
      },
    });

    expect(result.delivered).toEqual([]);
    expect(result.undelivered).toEqual([
      {
        title: "ESCALATED watt-mind/factory#1558: worker delivery failed",
        error: "runtime unavailable",
      },
    ]);
    expect(readFileSync(outbox, "utf8")).toContain("worker delivery failed");
    rmSync(home, { recursive: true, force: true });
  });

  test("canonical authorisation hash is verified before dispatch execution", () => {
    const description =
      "## Owned Paths\n- event-runtime/lib/worker.mjs\n- docs/event-runtime-inbox.md\n";
    const input = {
      repo: "factory",
      ticket: "watt-mind/factory#1337",
      humanDecision: {
        inboxItemId: "inbox_authorised",
        authorisation: {
          ticket: "watt-mind/factory#1337",
          repo: "factory",
          descriptionHash: hashBytes(description),
          paths: [
            "event-runtime/lib/worker.mjs",
            "docs/event-runtime-inbox.md",
          ],
        },
      },
    };

    const result = humanDecisionAuthorisationGate(input, {
      fetchTicket: () => ({ description }),
    });

    expect(result).toMatchObject({
      ok: true,
      input: {
        humanDecision: { authorisation: { verified: true } },
      },
    });
    expect(input.humanDecision.authorisation.verified).toBeUndefined();
  });

  test("trailing-newline authorisation hash is refused before dispatch execution", () => {
    const description = "## Owned Paths\n- event-runtime/lib/worker.mjs\n";
    const result = humanDecisionAuthorisationGate(
      {
        repo: "factory",
        ticket: "watt-mind/factory#1337",
        humanDecision: {
          authorisation: {
            ticket: "watt-mind/factory#1337",
            repo: "factory",
            descriptionHash: hashBytes(`${description}\n`),
            paths: ["event-runtime/lib/worker.mjs"],
          },
        },
      },
      { fetchTicket: () => ({ description }) },
    );

    expect(result).toMatchObject({
      ok: false,
      refusal: { reason: "authorisation_stale:description" },
    });
  });

  test("authorisation paths may narrow to a non-empty subset of Owned Paths", () => {
    const description =
      "## Owned Paths\n- event-runtime/lib/worker.mjs\n- docs/event-runtime-inbox.md\n";
    const result = humanDecisionAuthorisationGate(
      {
        repo: "factory",
        ticket: "watt-mind/factory#1337",
        humanDecision: {
          authorisation: {
            ticket: "watt-mind/factory#1337",
            repo: "factory",
            descriptionHash: hashBytes(description),
            paths: ["event-runtime/lib/worker.mjs"],
          },
        },
      },
      { fetchTicket: () => ({ description }) },
    );

    expect(result).toMatchObject({
      ok: true,
      input: {
        humanDecision: {
          authorisation: {
            verified: true,
            paths: ["event-runtime/lib/worker.mjs"],
          },
        },
      },
    });
  });

  test("authorisation paths outside the ticket's Owned Paths are refused", () => {
    const description = "## Owned Paths\n- event-runtime/lib/worker.mjs\n";
    const result = humanDecisionAuthorisationGate(
      {
        repo: "factory",
        ticket: "watt-mind/factory#1337",
        humanDecision: {
          authorisation: {
            ticket: "watt-mind/factory#1337",
            repo: "factory",
            descriptionHash: hashBytes(description),
            paths: [
              "event-runtime/lib/worker.mjs",
              "event-runtime/lib/planner.mjs",
            ],
          },
        },
      },
      { fetchTicket: () => ({ description }) },
    );

    expect(result).toMatchObject({
      ok: false,
      refusal: { reason: "authorisation_stale:paths" },
    });
    expect(result.refusal.detail).toContain("event-runtime/lib/planner.mjs");
    expect(result.evidence).toEqual({
      descriptionHash: hashBytes(description),
      ownedPaths: ["event-runtime/lib/worker.mjs"],
    });
  });

  test("an empty authorisation path set is refused", () => {
    const description = "## Owned Paths\n- event-runtime/lib/worker.mjs\n";
    for (const paths of [[], undefined]) {
      const result = humanDecisionAuthorisationGate(
        {
          repo: "factory",
          ticket: "watt-mind/factory#1337",
          humanDecision: {
            authorisation: {
              ticket: "watt-mind/factory#1337",
              repo: "factory",
              descriptionHash: hashBytes(description),
              ...(paths === undefined ? {} : { paths }),
            },
          },
        },
        { fetchTicket: () => ({ description }) },
      );

      expect(result).toMatchObject({
        ok: false,
        refusal: { reason: "authorisation_stale:paths" },
        evidence: { ownedPaths: ["event-runtime/lib/worker.mjs"] },
      });
    }
  });

  test("an authorisation minted for another ticket or repo is refused", () => {
    const description = "## Owned Paths\n- event-runtime/lib/worker.mjs\n";
    let fetches = 0;
    for (const binding of [
      { ticket: "watt-mind/factory#1338", repo: "factory" },
      { ticket: "watt-mind/factory#1337", repo: "other-repo" },
      {},
    ]) {
      const result = humanDecisionAuthorisationGate(
        {
          repo: "factory",
          ticket: "watt-mind/factory#1337",
          humanDecision: {
            authorisation: {
              ...binding,
              descriptionHash: hashBytes(description),
              paths: ["event-runtime/lib/worker.mjs"],
            },
          },
        },
        {
          fetchTicket: () => {
            fetches += 1;
            return { description };
          },
        },
      );

      expect(result).toMatchObject({
        ok: false,
        refusal: { reason: "authorisation_stale:ticket" },
      });
      expect(result.evidence).toEqual({
        descriptionHash: null,
        ownedPaths: [],
      });
    }
    expect(fetches).toBe(0);
  });

  test("a stale description refusal carries a fingerprint, not the ticket", () => {
    const description = "## Owned Paths\n- event-runtime/lib/worker.mjs\n";
    const result = humanDecisionAuthorisationGate(
      {
        repo: "factory",
        ticket: "watt-mind/factory#1337",
        humanDecision: {
          authorisation: {
            ticket: "watt-mind/factory#1337",
            repo: "factory",
            descriptionHash: hashBytes("something else"),
            paths: ["event-runtime/lib/worker.mjs"],
          },
        },
      },
      { fetchTicket: () => ({ description, title: "secret title" }) },
    );

    expect(result).toMatchObject({
      ok: false,
      refusal: { reason: "authorisation_stale:description" },
    });
    expect(result.evidence).toEqual({
      descriptionHash: hashBytes(description),
      ownedPaths: ["event-runtime/lib/worker.mjs"],
    });
  });

  test("dispatch without an authorisation does not add a ticket read", () => {
    const input = { repo: "factory", ticket: "watt-mind/factory#1337" };
    let fetches = 0;

    expect(
      humanDecisionAuthorisationGate(input, {
        fetchTicket: () => (fetches += 1),
      }),
    ).toEqual({ ok: true, input });
    expect(fetches).toBe(0);
  });

  const demoSkillFixture = () => {
    const factoryRoot = tmpDir("evrt-harness-source-");
    const catalog = path.join(factoryRoot, "catalog");
    const source = path.join(factoryRoot, "dist", "fake", "skills", "demo");
    mkdirSync(path.join(catalog, "skills", "demo"), { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(catalog, "skills", "demo", "SKILL.md"),
      "catalog\n",
    );
    writeFileSync(path.join(source, "SKILL.md"), "first\n");
    writeFileSync(path.join(source, "notes.md"), "second\n");
    return {
      spec: { harness: { skills: ["demo"] } },
      adapterKey: "fake",
      adapter: {
        HARNESS_LAYOUT: {
          skills: {
            source: (name) => ["dist", "fake", "skills", name],
            dest: (name) => [".fake", "skills", name],
            type: "dir",
          },
        },
      },
      registry: { harnessRoots: [{ skills: path.join(catalog, "skills") }] },
      factoryRoot,
    };
  };

  test("materialized harness entries record hashes for every copied file", () => {
    const workspaceDir = tmpDir("evrt-harness-workspace-");
    const written = materializeRunHarness({
      ...demoSkillFixture(),
      workspaceDir,
    });

    expect(written).toEqual([
      {
        kind: "skills",
        name: "demo",
        dest: ".fake/skills/demo",
        pins: {
          ".fake/skills/demo/SKILL.md": hashBytes("first\n"),
          ".fake/skills/demo/notes.md": hashBytes("second\n"),
        },
      },
    ]);
  });

  test("materialize refuses a missing workspace root as harness_unmaterializable", () => {
    const workspaceDir = path.join(
      tmpDir("evrt-harness-workspace-missing-"),
      "does-not-exist",
    );
    let caught;
    try {
      materializeRunHarness({ ...demoSkillFixture(), workspaceDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessMaterializeError);
    expect(caught.code).toBe("harness_unmaterializable");
    expect(caught.message).toContain("workspace root");
  });

  test("materialized harness entries remain workspace-relative through a symlinked parent", () => {
    const factoryRoot = tmpDir("evrt-harness-source-");
    const realWorkspaceParent = tmpDir("evrt-harness-workspace-real-");
    const workspaceAliasBase = tmpDir("evrt-harness-workspace-alias-");
    const workspaceAliasParent = path.join(workspaceAliasBase, "parent");
    symlinkSync(realWorkspaceParent, workspaceAliasParent, "dir");
    const workspaceDir = path.join(workspaceAliasParent, "workspace");
    mkdirSync(workspaceDir);
    const catalog = path.join(factoryRoot, "catalog");
    const source = path.join(factoryRoot, "dist", "fake", "skills", "demo");
    mkdirSync(path.join(catalog, "skills", "demo"), { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(catalog, "skills", "demo", "SKILL.md"),
      "catalog\n",
    );
    writeFileSync(path.join(source, "SKILL.md"), "first\n");
    writeFileSync(path.join(source, "notes.md"), "second\n");

    const written = materializeRunHarness({
      spec: { harness: { skills: ["demo"] } },
      adapterKey: "fake",
      adapter: {
        HARNESS_LAYOUT: {
          skills: {
            source: (name) => ["dist", "fake", "skills", name],
            dest: (name) => [".fake", "skills", name],
            type: "dir",
          },
        },
      },
      workspaceDir,
      registry: { harnessRoots: [{ skills: path.join(catalog, "skills") }] },
      factoryRoot,
    });

    expect(written).toEqual([
      {
        kind: "skills",
        name: "demo",
        dest: ".fake/skills/demo",
        pins: {
          ".fake/skills/demo/SKILL.md": hashBytes("first\n"),
          ".fake/skills/demo/notes.md": hashBytes("second\n"),
        },
      },
    ]);
  });

  test("completed receipts attest emitted harness files", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ harness: { commands: ["factory-ticket"] } }),
    );
    const materializingFake = {
      ...fake,
      HARNESS_LAYOUT: {
        commands: {
          source: (name) => ["plugins", "core", "commands", `${name}.md`],
          dest: (name) => [".fake", "commands", `${name}.md`],
          type: "file",
        },
      },
    };

    const summary = await runOnce(
      db,
      registry,
      { fake: materializingFake },
      opts(),
    );

    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.receipt.harnessPins).toEqual({
      ".fake/commands/factory-ticket.md": hashBytes(
        readFileSync("plugins/core/commands/factory-ticket.md"),
      ),
    });
  });

  test("provisions present instance configs into an ignored checkout and skips absent files", async () => {
    const factoryRoot = tmpDir("evrt-instance-config-source-");
    const checkout = tmpDir("evrt-instance-config-checkout-");
    try {
      mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
      mkdirSync(path.join(checkout, "config"), { recursive: true });
      writeFileSync(
        path.join(checkout, ".gitignore"),
        "config/repos.yaml\nconfig/policy.yaml\nconfig/schedule.yaml\n",
      );
      expect(spawnSync("git", ["init", "-q"], { cwd: checkout }).status).toBe(
        0,
      );
      writeFileSync(
        path.join(factoryRoot, "config", "repos.yaml"),
        "repos: []\n",
      );
      writeFileSync(
        path.join(factoryRoot, "config", "policy.yaml"),
        "limits: {}\n",
      );

      expect(
        await provisionInstanceLocalConfigs({
          factoryRoot,
          checkoutPath: checkout,
        }),
      ).toEqual(["config/repos.yaml", "config/policy.yaml"]);
      expect(
        readFileSync(path.join(checkout, "config", "repos.yaml"), "utf8"),
      ).toBe("repos: []\n");
      expect(existsSync(path.join(checkout, "config", "schedule.yaml"))).toBe(
        false,
      );
      for (const file of ["config/repos.yaml", "config/policy.yaml"]) {
        expect(
          spawnSync("git", ["check-ignore", "-q", file], { cwd: checkout })
            .status,
        ).toBe(0);
      }
    } finally {
      rmSync(factoryRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("does not materialize a stale operator schedule overlay, so a worktree stays verifiable after client schedules leave the kernel (#1051)", async () => {
    const factoryRoot = tmpDir("evrt-schedule-overlay-source-");
    const checkout = tmpDir("evrt-schedule-overlay-checkout-");
    try {
      mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
      mkdirSync(path.join(checkout, "config"), { recursive: true });
      writeFileSync(
        path.join(checkout, ".gitignore"),
        "config/repos.yaml\nconfig/policy.yaml\nconfig/schedule.yaml\n",
      );
      expect(spawnSync("git", ["init", "-q"], { cwd: checkout }).status).toBe(
        0,
      );
      writeFileSync(
        path.join(factoryRoot, "config", "repos.yaml"),
        "repos: []\n",
      );
      // A checkout tracks only the example overlay; the branch has trimmed the
      // client loop out of the kernel, so the tracked example carries no
      // `work-bj29`.
      writeFileSync(
        path.join(checkout, "config", "schedule.example.yaml"),
        "jobs: []\n",
      );
      // The live operator overlay still carries a stale, partial entry for the
      // now-kernel-less loop: `enabled: true` with no cadence. Copied into the
      // checkout it would load as a brand-new overlay loop with no `every` and
      // detonate the repo verify gate with `unparseable cadence "undefined"`.
      writeFileSync(
        path.join(factoryRoot, "config", "schedule.yaml"),
        "schedules:\n  work-bj29:\n    enabled: true\n",
      );

      expect(
        await provisionInstanceLocalConfigs({
          factoryRoot,
          checkoutPath: checkout,
        }),
      ).toEqual(["config/repos.yaml"]);

      // The stale overlay never lands in the checkout ...
      expect(existsSync(path.join(checkout, "config", "schedule.yaml"))).toBe(
        false,
      );
      // ... so schedule resolution falls back to the tracked example, which
      // parses cleanly and has no cadence-less loop to break verify.
      const resolved = resolveConfigPath("schedule", {
        root: checkout,
        warn: false,
      });
      expect(resolved).toBe(
        path.join(checkout, "config", "schedule.example.yaml"),
      );
      const parsed = Bun.YAML.parse(readFileSync(resolved, "utf8"));
      expect(parsed?.schedules?.["work-bj29"]).toBeUndefined();
    } finally {
      rmSync(factoryRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("silently skips instance config provisioning when no local files exist", async () => {
    const factoryRoot = tmpDir("evrt-instance-config-empty-source-");
    const checkout = tmpDir("evrt-instance-config-empty-checkout-");
    try {
      expect(
        await provisionInstanceLocalConfigs({
          factoryRoot,
          checkoutPath: checkout,
        }),
      ).toEqual([]);
    } finally {
      rmSync(factoryRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("provisions instance config into a client checkout but makes it un-stageable", async () => {
    // A client repo (bj29, cashsaas, …) does not gitignore config/repos.yaml,
    // so the old guard skipped the copy and left the review with no config —
    // failing it closed. Now the path is added to the checkout's local exclude
    // and the config IS copied, so merge-review can resolve the repo's control
    // plane and merge_ci gate, while an agent still cannot `git add` it.
    const factoryRoot = tmpDir("evrt-instance-config-protected-source-");
    const checkout = tmpDir("evrt-instance-config-protected-checkout-");
    try {
      mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
      writeFileSync(
        path.join(factoryRoot, "config", "repos.yaml"),
        "repos: []\n",
      );
      expect(spawnSync("git", ["init", "-q"], { cwd: checkout }).status).toBe(
        0,
      );

      expect(
        await provisionInstanceLocalConfigs({
          factoryRoot,
          checkoutPath: checkout,
        }),
      ).toEqual(["config/repos.yaml"]);
      // Copied in, so the run can read it.
      expect(existsSync(path.join(checkout, "config", "repos.yaml"))).toBe(
        true,
      );
      // But un-stageable: git now ignores it (via .git/info/exclude).
      expect(
        spawnSync(
          "git",
          ["-C", checkout, "check-ignore", "-q", "--", "config/repos.yaml"],
          { encoding: "utf8" },
        ).status,
      ).toBe(0);
    } finally {
      rmSync(factoryRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("kills timed-out claim-path probe groups and traces both probes", async () => {
    const factoryRoot = tmpDir("evrt-instance-config-timeout-source-");
    const checkout = tmpDir("evrt-instance-config-timeout-checkout-");
    const bin = tmpDir("evrt-instance-config-timeout-bin-");
    const previousPath = process.env.PATH;
    const previousTimeout = process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS;
    try {
      mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
      writeFileSync(
        path.join(factoryRoot, "config", "repos.yaml"),
        "repos: []\n",
      );
      expect(spawnSync("git", ["init", "-q"], { cwd: checkout }).status).toBe(
        0,
      );
      writeFileSync(
        path.join(bin, "git"),
        `#!/bin/sh
case "$3" in
  rev-parse)
    if [ "$4" = "--is-inside-work-tree" ]; then
      printf 'true\\n'
      exit 0
    fi
    ;;
esac
sh -c 'sleep 5 & wait'
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS = "25";

      const timeouts = [];
      const started = Date.now();
      expect(
        await provisionInstanceLocalConfigs({
          factoryRoot,
          checkoutPath: checkout,
          onProbeTimeout: (timeout) => timeouts.push(timeout),
        }),
      ).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(timeouts).toEqual([
        expect.objectContaining({ name: "check-ignore", ceilingMs: 25 }),
        expect.objectContaining({ name: "rev-parse", ceilingMs: 25 }),
      ]);
    } finally {
      process.env.PATH = previousPath;
      if (previousTimeout === undefined)
        delete process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS;
      else process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS = previousTimeout;
      rmSync(factoryRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("claim-path git probe settles as a failed probe when the binary does not exist", async () => {
    const missing = path.join(
      tmpDir("evrt-claim-probe-missing-bin-"),
      "definitely-not-git",
    );
    const timeouts = [];
    const started = Date.now();
    const probe = await runClaimPathGitProbe({
      checkoutPath: "/nonexistent/checkout",
      args: ["rev-parse", "--git-path", "info/exclude"],
      name: "rev-parse",
      command: missing,
      onTimeout: (timeout) => timeouts.push(timeout),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(probe.status).not.toBe(0);
    expect(probe.stdout).toBe("");
    expect(probe.error?.code).toBe("ENOENT");
    expect(timeouts).toEqual([]);
    rmSync(path.dirname(missing), { recursive: true, force: true });
  });

  test("provisioning always returns a promise, even without a checkout path", async () => {
    const result = provisionInstanceLocalConfigs({});
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual([]);
  });

  test("repository integrity gate rejects any checkout dirt before output acceptance", () => {
    const repo = tmpDir("evrt-clean-repo-");
    const git = (args) =>
      spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    expect(git(["init", "--quiet"]).status).toBe(0);
    writeFileSync(path.join(repo, "tracked.txt"), "clean\n");
    writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
    expect(git(["add", "tracked.txt", ".gitignore"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Test",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    expect(repositoryIsClean(repo)).toBe(true);
    writeFileSync(path.join(repo, "ignored.log"), "dirty\n");
    expect(repositoryIsClean(repo)).toBe(false);
    rmSync(path.join(repo, "ignored.log"));
    writeFileSync(path.join(repo, "agent-wrote.txt"), "dirty\n");
    expect(repositoryIsClean(repo)).toBe(false);
  });

  test("repository integrity baseline permits pre-existing ignored state but detects later writes", () => {
    const repo = tmpDir("evrt-baseline-repo-");
    const git = (args) =>
      spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    expect(git(["init", "--quiet"]).status).toBe(0);
    writeFileSync(path.join(repo, ".gitignore"), "generated/*.log\n");
    expect(git(["add", ".gitignore"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Test",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    mkdirSync(path.join(repo, "generated"));
    writeFileSync(path.join(repo, "generated", "setup.log"), "pre-existing\n");
    const baseline = repositoryStatus(repo);
    expect(baseline).toContain("!! generated/setup.log");
    expect(repositoryStatus(repo)).toBe(baseline);
    writeFileSync(path.join(repo, "generated", "agent-write.log"), "new\n");
    expect(repositoryStatus(repo)).not.toBe(baseline);
  });

  test("repository status returns null when git exceeds its timeout", () => {
    const dir = tmpDir("evrt-hanging-git-");
    const hangingGit = path.join(dir, "git");
    writeFileSync(hangingGit, "#!/bin/bash\nwhile :; do :; done\n", "utf8");
    execFileSync("chmod", ["+x", hangingGit]);

    const started = Date.now();
    expect(
      repositoryStatus(dir, { gitCommand: hangingGit, timeoutMs: 25 }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("Linear helper subprocesses honor the configured timeout", () => {
    const dir = tmpDir("evrt-hanging-linear-");
    const hangingCommand = path.join(dir, "bun");
    writeFileSync(hangingCommand, "#!/bin/bash\nwhile :; do :; done\n", "utf8");
    execFileSync("chmod", ["+x", hangingCommand]);
    const previous = process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS;
    process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS = "25";

    const started = Date.now();
    try {
      expect(() =>
        runLinearCli(["get", "WM-262"], { command: hangingCommand }),
      ).toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      if (previous === undefined)
        delete process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS;
      else process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS = previous;
    }
  });

  test("e2e (WM-135): tiered pi route plans a spec with the model pinned; the fake adapter executes it, ignoring the model", async () => {
    const db = openDb(":memory:");
    // The real status-report definition with a declared tier, on a registry
    // whose policy map says standard → the pi standard model.
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      modelTiers: { pi: { standard: "openai-codex/gpt-5.6-terra" } },
    };
    synthetic.agents.set("factory-status-report@1", {
      ...getAgent(registry, "factory-status-report@1"),
      model_tier: "standard",
    });

    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId: "wm135-e2e-1",
      type: "factory.status-report.requested",
      source: "operator-webhook",
      subject: "factory",
      occurredAt: new Date(T0).toISOString(),
      correlationId: "wm135-corr",
      causationId: null,
      payload: { repos: ["ok"] },
    };
    const admitted = admitEvent(db, synthetic, envelope, { now: T0 });
    expect(admitted.admitted).toBe(true);

    const outcome = planEvent(
      db,
      synthetic,
      { source: admitted.event.source, eventId: admitted.event.event_id },
      { now: T0, policyVersion: "git:test", adapterOverride: "fake" },
    );
    expect(outcome.decision).toBe("run");
    // The pinned resolution is what the operator would approve: the
    // registered pi route's model, even though execution is the fake.
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.model).toBe("openai-codex/gpt-5.6-terra");
    expect(spec.modelTier).toBe("standard");
    expect(spec.adapter).toBe("fake");

    transition(db, {
      runId: outcome.runId,
      to: "APPROVED",
      actor: "test",
      now: T0,
    });
    transition(db, {
      runId: outcome.runId,
      to: "QUEUED",
      actor: "test",
      now: T0,
    });
    const summary = await runOnce(db, synthetic, adapters, opts());
    expect(summary.runId).toBe(outcome.runId);
    expect(summary.terminalState).toBe("COMPLETED");
    // The run's stored spec — what inspect/receipts read — carries the pin.
    const stored = JSON.parse(
      db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(outcome.runId)
        .spec_json,
    );
    expect(stored.model).toBe("openai-codex/gpt-5.6-terra");
    expect(stored.modelTier).toBe("standard");
  });

  test("happy path: COMPLETED, results row, receipt, one completion outbox event, workspace destroyed", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    const o = opts({ artifactStore: freshRoot() });

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.reasonCode).toBe("ok");
    expect(runState(db, spec.runId)).toBe("COMPLETED");

    const result = db
      .query(`SELECT * FROM results WHERE run_id = ?`)
      .get(spec.runId);
    expect(result).toBeTruthy();
    const receipt = JSON.parse(result.receipt_json);
    expect(receipt.verificationStatus).toBe("passed");
    expect(receipt.journalHead).toMatch(/^sha256:/);
    expect(receipt.runSpecHash).toBe(hashJson(spec));
    expect(receipt.artifactHash).toBe(result.artifact_hash);
    expect(summary.receipt).toEqual(receipt);

    const parsedResult = JSON.parse(result.result_json);
    const resultDigest = result.artifact_hash.slice("sha256:".length);
    const storedResult = path.join(o.artifactStore, resultDigest);
    expect(readFileSync(storedResult, "utf8")).toBe(
      canonicalJson(parsedResult.artifact),
    );
    expect(
      createHash("sha256").update(readFileSync(storedResult)).digest("hex"),
    ).toBe(resultDigest);

    const outbox = db.query(`SELECT * FROM outbox`).all();
    expect(outbox).toHaveLength(1);
    const envelope = JSON.parse(outbox[0].event_json);
    expect(envelope.type).toBe("factory.status-report.completed");
    expect(envelope.eventId).toBe(`event-runtime:${spec.runId}:1`);
    expect(envelope.correlationId).toBe("corr-1");
    expect(envelope.payload).toEqual({
      runId: spec.runId,
      attempt: 1,
      artifactHash: result.artifact_hash,
      outputContract: spec.outputContract,
    });
    expect(runUsage(db, spec.runId).attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        adapter: "fake",
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    ]);

    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(spec.runId);
    expect(attempt.terminal_state).toBe("COMPLETED");
    expect(attempt.started_at).toBeTruthy();
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(
      false,
    );
  });

  test("COMPLETED accepts register emitted memos and pinned memo verdicts", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const memoRegistry = {
      ...registry,
      agents: new Map(registry.agents),
    };
    memoRegistry.agents.set("factory-status-report@1", {
      ...getAgent(registry, "factory-status-report@1"),
      emits: { memos: ["repo-note"] },
      outputSchema: {
        ...getAgent(registry, "factory-status-report@1").outputSchema,
        additionalProperties: true,
      },
    });
    const pinnedBytes = JSON.stringify({
      schemaVersion: "factory.memo/v1",
      subject: { type: "repo", id: "factory" },
      kind: "repo-note",
      claim: { kind: "fact", text: "Pinned memo for the worker test." },
      evidence: "worker test",
      body: "Pinned memo for the worker test.",
    });
    const pinnedSha = createHash("sha256").update(pinnedBytes).digest("hex");
    const artifactStore = freshRoot();
    writeFileSync(path.join(artifactStore, pinnedSha), pinnedBytes);
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "memo-emitting",
        input: {
          repos: ["factory"],
          repo: "factory",
          memoPin: { entries: [{ sha256: pinnedSha }] },
        },
      }),
      now,
    );
    const memoAdapter = {
      async execute({ workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            artifact: {
              repos: [
                {
                  name: "factory",
                  triage: 0,
                  agentReady: 0,
                  inProgress: 0,
                  blocked: 0,
                },
              ],
              recommendedAction: "wait",
              learnings: [
                {
                  claim: {
                    kind: "fact",
                    text: "Accepted memo reaches the ledger.",
                  },
                  evidence: "worker test",
                },
              ],
              usedMemos: [{ sha256: pinnedSha, verdict: "useful" }],
            },
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    };

    const summary = await runOnce(
      db,
      memoRegistry,
      { "memo-emitting": memoAdapter },
      opts({ now: () => Date.now(), artifactStore }),
    );

    expect(summary.terminalState).toBe("COMPLETED");
    const memos = db
      .query(`SELECT * FROM memos WHERE run_id = ?`)
      .all(spec.runId);
    expect(memos).toHaveLength(1);
    expect(listMemos(db, { type: "repo", id: "factory" })).toEqual([
      expect.objectContaining({ sha256: memos[0].sha256, kind: "repo-note" }),
    ]);
    expect(
      db
        .query(
          `SELECT sha256, run_id, verdict, run_state FROM memo_uses WHERE run_id = ?`,
        )
        .get(spec.runId),
    ).toEqual({
      sha256: pinnedSha,
      run_id: spec.runId,
      verdict: "useful",
      run_state: "COMPLETED",
    });

    const accepted = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(spec.runId).result_json,
    );
    registerMemos(db, spec.runId, accepted, {
      now: Date.now(),
      agent: spec.agent,
      runState: "COMPLETED",
    });
    expect(
      db.query(`SELECT * FROM memos WHERE run_id = ?`).all(spec.runId),
    ).toHaveLength(1);
    db.close();
  });

  test("COMPLETED records a NULL-verdict memo_uses row for a pinned memo the agent never mentions", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const pinnedBytes = JSON.stringify({
      schemaVersion: "factory.memo/v1",
      subject: { type: "repo", id: "factory" },
      kind: "repo-note",
      claim: { kind: "fact", text: "Pinned but unmentioned memo." },
      evidence: "worker test",
      body: "Pinned but unmentioned memo.",
    });
    const pinnedSha = createHash("sha256").update(pinnedBytes).digest("hex");
    const artifactStore = freshRoot();
    writeFileSync(path.join(artifactStore, pinnedSha), pinnedBytes);
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "memo-silent",
        input: {
          repos: ["factory"],
          repo: "factory",
          memoPin: { entries: [{ sha256: pinnedSha }] },
        },
      }),
      now,
    );
    const silentAdapter = {
      async execute({ workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            artifact: {
              repos: [
                {
                  name: "factory",
                  triage: 0,
                  agentReady: 0,
                  inProgress: 0,
                  blocked: 0,
                },
              ],
              recommendedAction: "wait",
            },
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    };

    const summary = await runOnce(
      db,
      registry,
      { "memo-silent": silentAdapter },
      opts({ now: () => Date.now(), artifactStore }),
    );

    expect(summary.terminalState).toBe("COMPLETED");
    const accepted = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(spec.runId).result_json,
    );
    expect(accepted.usedMemos ?? []).toEqual([]);
    expect(
      db
        .query(
          `SELECT sha256, run_id, verdict, run_state FROM memo_uses WHERE run_id = ?`,
        )
        .all(spec.runId),
    ).toEqual([
      {
        sha256: pinnedSha,
        run_id: spec.runId,
        verdict: null,
        run_state: "COMPLETED",
      },
    ]);
    db.close();
  });

  test("memo registration failure rolls back the accepted result transaction", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const memoRegistry = {
      ...registry,
      agents: new Map(registry.agents),
    };
    memoRegistry.agents.set("factory-status-report@1", {
      ...getAgent(registry, "factory-status-report@1"),
      emits: { memos: ["repo-note"] },
      outputSchema: {
        ...getAgent(registry, "factory-status-report@1").outputSchema,
        additionalProperties: true,
      },
    });
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "memo-insert-fails",
        input: { repos: ["factory"], repo: "factory" },
      }),
      now,
    );
    db.exec(`
      CREATE TRIGGER reject_memo_insert
      BEFORE INSERT ON memos
      BEGIN
        SELECT RAISE(ABORT, 'memo insert failed');
      END;
    `);
    const failingMemoAdapter = {
      async execute({ workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            artifact: {
              repos: [
                {
                  name: "factory",
                  triage: 0,
                  agentReady: 0,
                  inProgress: 0,
                  blocked: 0,
                },
              ],
              recommendedAction: "wait",
              learnings: [
                {
                  claim: {
                    kind: "fact",
                    text: "A failing insert must roll back.",
                  },
                  evidence: "worker test",
                },
              ],
            },
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    };

    const summary = await runOnce(
      db,
      memoRegistry,
      { "memo-insert-fails": failingMemoAdapter },
      opts({ now: () => Date.now() }),
    );

    expect(summary.terminalState).toBe("FAILED");
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`)
        .get(spec.runId).n,
    ).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM memos`).get().n).toBe(0);
    db.close();
  });

  test("persists usage returned by an adapter, including model and cache tokens", async () => {
    const db = openDb(":memory:");
    const usageAdapter = {
      async execute(args) {
        const outcome = await fake.execute(args);
        args.onUsage?.({
          model: "claude-sonnet-4-6",
          inputTokens: 101,
          outputTokens: 29,
          cacheCreationInputTokens: 300,
          cacheReadInputTokens: 700,
          costUSD: 0.123,
        });
        return outcome;
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "usage-stub" }));

    const summary = await runOnce(
      db,
      registry,
      { "usage-stub": usageAdapter },
      opts(),
    );
    expect(summary.terminalState).toBe("COMPLETED");
    expect(runUsage(db, spec.runId)).toEqual({
      totals: {
        attempts: 1,
        inputTokens: 101,
        outputTokens: 29,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 700,
        totalTokens: 1130,
        costUSD: 0.123,
      },
      attempts: [
        expect.objectContaining({
          attempt: 1,
          adapter: "usage-stub",
          model: "claude-sonnet-4-6",
          totalTokens: 1130,
        }),
      ],
    });
  });

  test("failed adapter outcomes retain tokens consumed before failure", async () => {
    const db = openDb(":memory:");
    const consumedThenFailed = {
      async execute() {
        return {
          exitCode: 1,
          timedOut: false,
          usage: {
            model: "claude-sonnet-4-6",
            inputTokens: 11,
            outputTokens: 4,
          },
        };
      },
    };
    const spec = queueRun(
      db,
      makeSpec({ adapter: "consumed-failure", maxAttempts: 1 }),
    );

    const summary = await runOnce(
      db,
      registry,
      { "consumed-failure": consumedThenFailed },
      opts(),
    );
    expect(summary.terminalState).toBe("FAILED");
    expect(runUsage(db, spec.runId).attempts[0]).toEqual(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        inputTokens: 11,
        outputTokens: 4,
        totalTokens: 15,
      }),
    );
  });

  test("policy denial is terminal and is never retried as an opaque agent exit", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "policy", maxAttempts: 5 }));
    const policyAdapter = {
      execute: async () => ({
        // Adapters report policyDenials only when they are the verdict — the
        // claude adapter suppresses them on a clean exit (WM-127), so a
        // non-empty list here means the run failed at a refused tool call.
        exitCode: 1,
        timedOut: false,
        policyDenials: [
          {
            tool: "Bash",
            rule: "Claude requested permissions to use Bash, but you haven't granted it yet.",
          },
        ],
      }),
    };

    const summary = await runOnce(
      db,
      registry,
      { policy: policyAdapter },
      opts(),
    );
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "policy_denied:Bash",
    });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      db
        .query(`SELECT reason_code FROM attempts WHERE run_id = ?`)
        .get(spec.runId).reason_code,
    ).toBe("policy_denied:Bash");
    expect(
      db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId),
    ).toBeNull();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
    expect(claimNext(db, opts())).toBeNull();
  });

  test("refuse: REFUSED, results row stored, no outbox row, workspace destroyed", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["refuse"] } }));
    db.query(
      `INSERT INTO proposals
         (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
          idempotency_key, status, created_at, ttl_seconds)
       VALUES ('prop-stale-open', 'chain', 'evt-stale-open', ?, 'run', ?,
               'sha256:test', ?, 'open', ?, 1800)`,
    ).run(
      spec.runId,
      JSON.stringify(spec),
      spec.idempotencyKey,
      new Date(T0).toISOString(),
    );
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("REFUSED");
    expect(summary.reasonCode).toBe("needs_human");
    expect(runState(db, spec.runId)).toBe("REFUSED");
    expect(
      db
        .query(
          `SELECT status, reason FROM proposals WHERE id = 'prop-stale-open'`,
        )
        .get(),
    ).toEqual({ status: "rejected", reason: "run_refused" });

    const result = db
      .query(`SELECT * FROM results WHERE run_id = ?`)
      .get(spec.runId);
    expect(result).toBeTruthy();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(
      false,
    );

    const resultRow = db
      .query(`SELECT * FROM results WHERE run_id = ?`)
      .get(spec.runId);
    const parsedResult = JSON.parse(resultRow.result_json);
    expect(parsedResult.artifacts).toHaveLength(1);
    expect(parsedResult.artifacts[0].kind).toBe("transcript");
    expect(parsedResult.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsedResult.artifacts[0].uri).toMatch(/^file:\/\//);
    const inbox = db
      .query(`SELECT * FROM inbox_items WHERE refs_json LIKE ?`)
      .get(`%${spec.runId}%`);
    expect(inbox).toBeTruthy();
    expect(inbox.kind).toBe("ESCALATED");
    expect(inbox.source).toBe(`agent:${spec.runId}`);
    expect(inbox.dedupe_key).toBe(`ESCALATED:${spec.runId}`);
    expect(inbox.title).toBe(
      `Escalated: run ${spec.runId} — stopped because an operator decision is required before it can proceed`,
    );
    expect(inbox.body).toContain(
      `What happened: An item needs attention for run ${spec.runId} (escalated).`,
    );
    expect(inbox.body).toContain("Reason code: needs_human.");
    expect(inbox.body).toContain("Option effects:");
    expect(JSON.parse(inbox.decision_json).schemaVersion).toBe(
      "factory.decision-request/v1",
    );
    const storePath = path.join(
      o.artifactStore ?? artifactsRoot(),
      parsedResult.artifacts[0].sha256,
    );
    expect(existsSync(storePath)).toBe(true);
    expect(pinRunArtifact(db, spec.runId)).toEqual({
      runId: spec.runId,
      transcript: parsedResult.artifacts[0].sha256,
      state: "REFUSED",
      agent: spec.agent,
    });
  });

  test("sandbox console is stored as a runtime artifact when present", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["refuse"] } }));
    const consoleAdapter = {
      async execute(args) {
        const outcome = await fake.execute(args);
        writeFileSync(
          path.join(args.workspaceDir, ".sandbox-console.log"),
          "guest console evidence\n",
          "utf8",
        );
        return outcome;
      },
    };

    await runOnce(db, registry, { fake: consoleAdapter }, opts());
    const parsed = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(spec.runId).result_json,
    );
    expect(parsed.artifacts.map((entry) => entry.kind)).toEqual([
      "transcript",
      "sandbox-console",
    ]);
    expect(parsed.artifacts[1].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refusal omits a runtime artifact unlinked between preflight and read", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["refuse"] } }));
    // Simulate the guest deleting .transcript.json after confinement passed
    // but before the host read it: the read itself reports ENOENT.
    const readSpy = spyOn(nodeFs, "readFileSync").mockImplementation(
      (file, ...rest) => {
        if (String(file).endsWith(".transcript.json")) {
          rmSync(file, { force: true });
        }
        return realReadFileSync(file, ...rest);
      },
    );
    try {
      const summary = await runOnce(db, registry, adapters, opts());
      expect(summary).toMatchObject({
        terminalState: "REFUSED",
        reasonCode: "needs_human",
      });
      const parsed = JSON.parse(
        db
          .query(`SELECT result_json FROM results WHERE run_id = ?`)
          .get(spec.runId).result_json,
      );
      expect(parsed.artifacts).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });

  for (const artifact of [
    { kind: "transcript", path: ".transcript.json" },
    { kind: "sandbox-console", path: ".sandbox-console.log" },
  ]) {
    for (const linkType of ["absolute", "relative"]) {
      test(`refusal omits ${artifact.kind} replaced by a ${linkType} final symlink before reading or storing it`, async () => {
        const db = openDb(":memory:");
        const spec = queueRun(db, makeSpec({ input: { repos: ["refuse"] } }));
        const artifactStore = freshRoot();
        const outsideDir = freshRoot();
        const secretBytes = `host bytes for ${artifact.kind} ${linkType}\n`;
        const outsideFile = path.join(outsideDir, "host-secret.txt");
        writeFileSync(outsideFile, secretBytes, "utf8");
        // A non-privileged worker cannot open this target. The refusal must
        // still complete because confinement rejects the link before read.
        chmodSync(outsideFile, 0);
        const secretHash = createHash("sha256")
          .update(secretBytes)
          .digest("hex");
        const symlinkedArtifactAdapter = {
          async execute(args) {
            const outcome = await fake.execute(args);
            const runtimePath = path.join(args.workspaceDir, artifact.path);
            rmSync(runtimePath, { force: true });
            const target =
              linkType === "absolute"
                ? outsideFile
                : path.relative(args.workspaceDir, outsideFile);
            symlinkSync(target, runtimePath);
            return outcome;
          },
        };

        const summary = await runOnce(
          db,
          registry,
          { fake: symlinkedArtifactAdapter },
          opts({ artifactStore }),
        );

        expect(summary).toMatchObject({
          terminalState: "REFUSED",
          reasonCode: "needs_human",
        });
        const parsed = JSON.parse(
          db
            .query(`SELECT result_json FROM results WHERE run_id = ?`)
            .get(spec.runId).result_json,
        );
        expect(parsed.artifacts.map((entry) => entry.kind)).not.toContain(
          artifact.kind,
        );
        if (artifact.kind === "sandbox-console") {
          expect(parsed.artifacts.map((entry) => entry.kind)).toEqual([
            "transcript",
          ]);
          expect(existsSync(new URL(parsed.artifacts[0].uri))).toBe(true);
        }
        expect(existsSync(path.join(artifactStore, secretHash))).toBe(false);
      });
    }
  }

  test("needs_human preserves a valid authored ask, while an invalid ask falls back with its errors", async () => {
    const authored = {
      schemaVersion: "factory.decision-request/v1",
      question: "Which answer should unblock WM-390?",
      options: [
        { id: "answer", label: "Answer the agent", effect: "answer" },
        { id: "dismiss", label: "Not now", effect: "dismiss" },
      ],
      // An `answer` option needs an applicable required text field (WM-716)
      // for this to remain the *valid* ask.
      fields: [
        {
          id: "reply",
          kind: "text",
          label: "Your answer",
          required: true,
          whenOption: ["answer"],
        },
      ],
    };
    const invalid = { ...authored, recommended: "missing" };
    const refusingAdapter = (decision) => ({
      async execute({ workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "refused",
            reasonCode: "needs_human",
            decision,
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    });

    for (const [suffix, decision, valid] of [
      ["valid", authored, true],
      ["invalid", invalid, false],
    ]) {
      const db = openDb(":memory:");
      const spec = queueRun(
        db,
        makeSpec({
          adapter: `refuse-${suffix}`,
          input: {
            repos: [suffix],
            ticket: "WM-390",
            repo: "factory",
            pr: 42,
          },
          approvalPolicy: {
            dispatchEvidence: {
              ticket: { title: "Choose a supported answer" },
            },
          },
        }),
      );
      const summary = await runOnce(
        db,
        registry,
        { [`refuse-${suffix}`]: refusingAdapter(decision) },
        opts(),
      );
      expect(summary).toMatchObject({
        terminalState: "REFUSED",
        reasonCode: "needs_human",
      });
      const item = db.query("SELECT * FROM inbox_items").get();
      expect(JSON.parse(item.refs_json)).toEqual({
        runId: spec.runId,
        issue: "WM-390",
        repo: "factory",
        pr: "42",
      });
      expect(item.dedupe_key).toBe("ESCALATED:WM-390");
      if (valid) {
        expect(item.title).toBe(
          'Escalated: WM-390 "Choose a supported answer" — stopped because an operator decision is required before it can proceed',
        );
        expect(item.body).toContain(
          'What happened: An item needs attention for WM-390 "Choose a supported answer" (escalated).',
        );
        expect(item.body).toContain("Reason code: needs_human.");
        expect(item.body).toContain(
          "Question: Which answer should unblock WM-390?",
        );
        expect(item.body).toContain(
          "Answer the agent — records the operator's reply for the agent.",
        );
        expect(item.body).toContain(
          "Not now — keeps the item resolved without changing the referenced work.",
        );
        expect(JSON.parse(item.decision_json)).toEqual(authored);
      } else {
        expect(JSON.parse(item.decision_json)).not.toEqual(invalid);
        expect(item.body).toContain("recommended");
      }
    }
  });

  test("a failing refusal inbox write never rolls back the terminal REFUSED state", async () => {
    const db = openDb(":memory:");
    // Force createInboxItem to throw inside the REFUSED transaction; the
    // projection is best-effort and the terminal state and result row must land.
    db.exec(`CREATE TRIGGER inbox_write_fails BEFORE INSERT ON inbox_items
             BEGIN SELECT RAISE(ABORT, 'inbox write refused by test'); END`);
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "refuse-inbox-fails",
        input: { repos: ["inbox-fails"], ticket: "WM-390", repo: "factory" },
      }),
    );
    const adapter = {
      async execute({ workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "refused",
            reasonCode: "needs_human",
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    };
    const summary = await runOnce(
      db,
      registry,
      { "refuse-inbox-fails": adapter },
      opts(),
    );
    expect(summary).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "needs_human",
    });
    expect(
      db.query("SELECT state FROM runs WHERE run_id = ?").get(spec.runId).state,
    ).toBe("REFUSED");
    expect(
      db.query("SELECT * FROM results WHERE run_id = ?").get(spec.runId),
    ).toBeTruthy();
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(0);
  });

  test("refusal reasons other than needs_human do not create inbox items", async () => {
    const db = openDb(":memory:");
    queueRun(
      db,
      makeSpec({
        adapter: "refuse-missing-input",
        input: { repos: ["missing"] },
      }),
    );
    const adapter = {
      async execute({ workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "refused",
            reasonCode: "missing_input",
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    };
    const summary = await runOnce(
      db,
      registry,
      { "refuse-missing-input": adapter },
      opts(),
    );
    expect(summary.reasonCode).toBe("missing_input");
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(0);
  });

  test("invalid-artifact: FAILED/contract_violation, no outbox row, workspace retained", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ input: { repos: ["invalid-artifact"] } }),
    );
    const o = opts();

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
    expect(runState(db, spec.runId)).toBe("FAILED");

    expect(
      db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId),
    ).toBeNull();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(
      true,
    );
  });

  test("escape: artifact outside the workspace is a contract violation", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["escape"] } }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
  });

  test("verifyResult ENOENT on a vanished worktree is FAILED/handoff_worktree_missing, not a LEASED leftover (#1663)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        verifyResult: ({ workspaceDir }) => {
          throw Object.assign(new Error("ENOENT"), {
            code: "ENOENT",
            syscall: "realpath",
            path: path.join(workspaceDir, "worktree"),
          });
        },
      }),
    );
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "handoff_worktree_missing",
    });
    expect(summary.error).toEqual({ code: "ENOENT", message: "ENOENT" });
    expect(runState(db, spec.runId)).not.toBe("LEASED");
    const attemptRow = db
      .query(
        `SELECT terminal_state, reason_code, finished_at FROM attempts WHERE run_id = ? AND attempt = 1`,
      )
      .get(spec.runId);
    expect(attemptRow.terminal_state).toBe("FAILED");
    expect(attemptRow.reason_code).toBe("handoff_worktree_missing");
    expect(attemptRow.finished_at).toBeTruthy();
    const stored = JSON.parse(
      db
        .query(
          `SELECT result_json, verification_json FROM results WHERE run_id = ?`,
        )
        .get(spec.runId).result_json,
    );
    expect(stored.error).toEqual({ code: "ENOENT", message: "ENOENT" });
    expect(stored.verification).toMatchObject({
      status: "failed",
      stage: "verification",
    });
  });

  test("verifyResult ENOENT outside the run workspace (missing verifier binary) is verification_internal_error, not the environment budget (#1663)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const missingBinary = path.join(
      path.sep,
      "nonexistent-gh-1663",
      "bin",
      "verifier",
    );
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        verifyResult: () => {
          throw Object.assign(new Error(`ENOENT: ${missingBinary}`), {
            code: "ENOENT",
            syscall: "realpath",
            path: missingBinary,
          });
        },
      }),
    );
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "verification_internal_error",
    });
    expect(summary.error.code).toBe("ENOENT");
    expect(runState(db, spec.runId)).toBe("FAILED");
    const attemptRow = db
      .query(
        `SELECT reason_code FROM attempts WHERE run_id = ? AND attempt = 1`,
      )
      .get(spec.runId);
    expect(attemptRow.reason_code).toBe("verification_internal_error");
  });

  test("verifyResult ENOENT without a path is verification_internal_error (#1663)", async () => {
    const db = openDb(":memory:");
    queueRun(db, makeSpec());
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        verifyResult: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    );
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "verification_internal_error",
    });
  });

  test("verifyResult TypeError is FAILED/verification_internal_error with the message recorded (#1663)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        verifyResult: () => {
          throw new TypeError("cannot read property of undefined");
        },
      }),
    );
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "verification_internal_error",
    });
    expect(summary.error.message).toBe("cannot read property of undefined");
    expect(runState(db, spec.runId)).toBe("FAILED");
    const stored = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(spec.runId).result_json,
    );
    expect(stored.reasonCode).toBe("verification_internal_error");
    expect(stored.error).toEqual({
      code: "TypeError",
      message: "cannot read property of undefined",
    });
    expect(stored.verification.stage).toBe("verification");
  });

  test("verifyResult ContractViolation still follows the existing handoff-failure path (#1663)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        verifyResult: () => {
          throw new ContractViolation(["missing_result"]);
        },
      }),
    );
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId),
    ).toBeNull();
  });

  test("a trace recorder that cannot be prepared degrades to a no-op instead of throwing out of executeClaimed (#1330)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    db.exec(`DROP TABLE attempt_trace`);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await runOnce(
        db,
        registry,
        adapters,
        opts({ artifactStore: freshRoot() }),
      );
      expect(summary.terminalState).toBe("COMPLETED");
      expect(runState(db, spec.runId)).toBe("COMPLETED");
      expect(
        err.mock.calls.some((c) =>
          String(c[0]).includes("trace recorder unavailable"),
        ),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test("no-result reports the expected absolute path and bounded agent output", async () => {
    const db = openDb(":memory:");
    const diagnosticAdapter = {
      async execute({ workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, ".transcript.json"),
          `${"discarded-prefix\n".repeat(300)}agent-final-diagnostic\n`,
        );
        return { exitCode: 0, timedOut: false };
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "diagnostic-no-result" }));
    const o = opts();

    const summary = await runOnce(
      db,
      registry,
      { "diagnostic-no-result": diagnosticAdapter },
      o,
    );
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
    expect(summary.detail).toContain(
      path.resolve(o.workspacesRoot, `${spec.runId}-a1`, "result.json"),
    );
    expect(summary.detail).toContain("agent-final-diagnostic");
    const outputTail = summary.detail.split(
      "agent stdout/stderr (last 2 KB): ",
    )[1];
    expect(outputTail.length).toBeLessThanOrEqual(2 * 1024);
  });

  test("dispatch missing-result recovery is exact and requires an open PR Handoff", () => {
    const workspaceDir = tmpDir("dispatch-result-recovery-");
    const checkoutPath = tmpDir("dispatch-result-checkout-");
    const def = getAgent(registry, "dispatch@1");
    const spec = makeSpec({
      agent: "dispatch@1",
      input: { repo: "factory", ticket: "watt-mind/factory#1539" },
      outputContract: "factory.dispatch-result/v1",
    });
    const worktreeRecord = {
      path: checkoutPath,
      github: "watt-mind/factory",
      verify: "bun test event-runtime/lib/worker.test.mjs",
      handoff: {
        verificationCommand: "bun test event-runtime/lib/worker.test.mjs",
      },
    };
    const missing = new ContractViolation(["missing_result"]);
    const openPr = {
      number: 1533,
      url: "https://github.com/watt-mind/factory/pull/1533",
      state: "OPEN",
    };
    const headSha = "a".repeat(40);

    const recovered = recoverMissingDispatchResult({
      error: missing,
      spec,
      def,
      workspaceDir,
      worktreeRecord,
      findPullRequest: () => openPr,
      fetchPullRequest: () => ({
        body: "Fixes watt-mind/factory#1539\n\n## Handoff\ncomplete",
        headRefOid: headSha,
      }),
    });
    expect(recovered.candidate).toMatchObject({
      reasonCode: "worker_recovered_missing_result",
      artifact: { outcome: "PR_OPEN", prNumber: 1533 },
      evidence: { headSha },
    });
    // The synthesized artifact must satisfy the registered dispatch-result
    // schema (additionalProperties: false) — no cloned, widened definition.
    expect(recovered.candidate.artifact).not.toHaveProperty("headSha");
    expect(recovered).not.toHaveProperty("definition");
    const verified = verifyResult({
      spec,
      def,
      registry,
      workspaceDir,
      attempt: 1,
      worktreeRecord: {},
    });
    expect(verified.kind).toBe("completed");
    expect(verified.result.artifact.headSha).toBeUndefined();
    expect(verified.result.evidence.headSha).toBe(headSha);

    rmSync(path.join(workspaceDir, "result.json"), { force: true });
    const pushedNoPr = recoverMissingDispatchResult({
      error: missing,
      spec,
      def,
      workspaceDir,
      worktreeRecord: { ...worktreeRecord, base: "develop" },
      findPullRequest: () => ({ pushedBranch: "feat/gh-1539" }),
    });
    expect(pushedNoPr).toMatchObject({ retainWorkspace: true });
    expect(pushedNoPr.candidate).toMatchObject({
      reasonCode: "pushed_branch_no_pr",
      artifact: {
        outcome: "BLOCKED",
        prUrl: null,
        prNumber: null,
        verification: { command: null, passed: false },
      },
      evidence: {
        branch: "feat/gh-1539",
        resumeCommand: expect.stringContaining("gh pr create --base develop"),
      },
    });
    expect(pushedNoPr.candidate.artifact.summary).toContain(
      "gh pr create --base develop",
    );

    expect(() =>
      recoverMissingDispatchResult({
        error: missing,
        spec,
        def,
        workspaceDir,
        worktreeRecord,
        findPullRequest: () => {
          const rateLimit = new Error("rate limited");
          rateLimit.code = "forge_rate_limited";
          throw rateLimit;
        },
      }),
    ).toThrow(
      expect.objectContaining({ reasonCode: HANDOFF_FORGE_UNAVAILABLE }),
    );

    for (const { error, findPullRequest, body, recoveredHeadSha = headSha } of [
      { error: missing, findPullRequest: () => null, body: "## Handoff" },
      { error: missing, findPullRequest: () => openPr, body: "Fixes #1539" },
      {
        error: missing,
        findPullRequest: () => openPr,
        body: "## Handoff",
        recoveredHeadSha: null,
      },
      {
        error: new ContractViolation(["missing_result", "missing_artifact"]),
        findPullRequest: () => openPr,
        body: "## Handoff",
      },
      {
        error: new ContractViolation(["missing_artifact"]),
        findPullRequest: () => openPr,
        body: "## Handoff",
      },
    ]) {
      rmSync(path.join(workspaceDir, "result.json"), { force: true });
      expect(
        recoverMissingDispatchResult({
          error,
          spec,
          def,
          workspaceDir,
          worktreeRecord,
          findPullRequest,
          fetchPullRequest: () => ({ body, headRefOid: recoveredHeadSha }),
        }),
      ).toBeNull();
      expect(existsSync(path.join(workspaceDir, "result.json"))).toBe(false);
    }
  });

  test("hang: TIMED_OUT with a tiny timeout", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ input: { repos: ["hang"] }, timeoutSeconds: 0.05 }),
    );

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("TIMED_OUT");
    expect(summary.reasonCode).toBe("timeout");
    expect(runState(db, spec.runId)).toBe("TIMED_OUT");
  });

  test("a running adapter honors a DB deadline extension past its original timeout (WM-566)", async () => {
    const db = openDb(":memory:");
    const completesAfterOriginalDeadline = {
      async execute({ workspaceDir, abortSignal }) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            writeFileSync(
              path.join(workspaceDir, "result.json"),
              JSON.stringify({
                schemaVersion: "factory.agent-result/v1",
                terminalState: "completed",
                artifact: {
                  repos: [
                    {
                      name: "extended",
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
            );
            resolve({ exitCode: 0, timedOut: false });
          }, 120);
          abortSignal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve({ exitCode: null, timedOut: false });
            },
            { once: true },
          );
        });
      },
    };
    const spec = queueRun(
      db,
      makeSpec({ adapter: "fake", timeoutSeconds: 0.05 }),
    );
    const running = runOnce(
      db,
      registry,
      { fake: completesAfterOriginalDeadline },
      opts(),
    );

    for (let i = 0; i < 50 && runState(db, spec.runId) !== "RUNNING"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(runState(db, spec.runId)).toBe("RUNNING");
    const extension = extendRunDeadline(db, spec.runId, {
      seconds: 1,
      actor: "operator",
      policyVersion: "test",
      now: T0 + 20,
    });
    expect(extension.deadlineAt).toBe(new Date(T0 + 1_050).toISOString());

    const summary = await running;
    expect(summary).toMatchObject({
      terminalState: "COMPLETED",
      reasonCode: "ok",
    });
    const receipt = JSON.parse(
      db
        .query(`SELECT receipt_json FROM results WHERE run_id = ?`)
        .get(spec.runId).receipt_json,
    );
    expect(JSON.parse(receipt.deadlineExtensions)).toEqual([
      expect.objectContaining({
        actor: "operator",
        seconds: 1,
        deadlineAt: extension.deadlineAt,
        type: "deadline_extended",
      }),
    ]);
    expect(
      db
        .query(`SELECT lease_expires_at FROM attempts WHERE run_id = ?`)
        .get(spec.runId).lease_expires_at,
    ).toBe(new Date(T0 + 121_050).toISOString());
  });

  test("a dynamic-deadline adapter's timeoutMs is bounded by policy, not 24.8 days (WM-692)", async () => {
    const db = openDb(":memory:");
    const seen = [];
    const recording = {
      async execute(options) {
        seen.push(options);
        return fake.execute(options);
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "fake", timeoutSeconds: 5 }));
    expect(DYNAMIC_DEADLINE_ADAPTERS.has(spec.adapter)).toBe(true);
    // The ceiling comes from the policy root runOnce is given. Reading the
    // live one instead only agreed because both happened to reach the
    // checkout's own config/policy.yaml, which a provisioned worktree carries
    // and a clean checkout does not (#1285).
    const policyRoot = freshRoot();
    mkdirSync(path.join(policyRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(policyRoot, "config", "policy.yaml"),
      "limits:\n  max_run_minutes: 7\n",
    );
    const liveMaxMinutes = policyMaxRunMinutes(policyRoot);
    expect(liveMaxMinutes).toBe(7);

    const summary = await runOnce(
      db,
      registry,
      { fake: recording },
      opts({ policyRoot }),
    );
    expect(summary.terminalState).toBe("COMPLETED");
    expect(seen).toHaveLength(1);
    // The ceiling every policy-bounded extension can reach, and nothing beyond it.
    const ceilingMs = liveMaxMinutes * 60_000 + LEASE_GRACE_SECONDS * 1000;
    expect(seen[0].timeoutMs).toBeGreaterThanOrEqual(
      spec.timeoutSeconds * 1000,
    );
    expect(seen[0].timeoutMs).toBeLessThanOrEqual(ceilingMs);
    expect(seen[0].timeoutMs).toBe(ceilingMs);
  });

  test("the adapter backstop follows the policy root it is given (WM-692)", async () => {
    const db = openDb(":memory:");
    const policyRoot = freshRoot();
    mkdirSync(path.join(policyRoot, "config"));
    writeFileSync(
      path.join(policyRoot, "config", "policy.yaml"),
      "limits:\n  max_run_minutes: 3\n",
    );
    const seen = [];
    const recording = {
      async execute(options) {
        seen.push(options.timeoutMs);
        return fake.execute(options);
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "fake", timeoutSeconds: 5 }));
    await runOnce(db, registry, { fake: recording }, opts({ policyRoot }));
    expect(seen).toEqual([3 * 60_000 + LEASE_GRACE_SECONDS * 1000]);

    // A budget above the policy ceiling still gets its whole budget plus grace,
    // and an adapter outside the dynamic set keeps its exact budget.
    expect(
      adapterExecuteTimeoutMs({
        adapterKey: "fake",
        spec: { ...spec, timeoutSeconds: 600 },
        maxRunMinutes: 3,
      }),
    ).toBe(600_000 + LEASE_GRACE_SECONDS * 1000);
    expect(
      adapterExecuteTimeoutMs({
        adapterKey: "actions",
        spec: { ...spec, timeoutSeconds: 600 },
        maxRunMinutes: 3,
      }),
    ).toBe(600_000);
    // No policy at all: fall back to the run budget plus grace, never to a sentinel.
    expect(
      adapterExecuteTimeoutMs({
        adapterKey: "fake",
        spec,
        maxRunMinutes: null,
      }),
    ).toBe(spec.timeoutSeconds * 1000 + LEASE_GRACE_SECONDS * 1000);
  });

  test("expiry wins atomically and refuses extension throughout adapter kill grace (WM-566)", async () => {
    const db = openDb(":memory:");
    let releaseKillGrace;
    const killGrace = new Promise((resolve) => {
      releaseKillGrace = resolve;
    });
    let termStarted;
    const term = new Promise((resolve) => {
      termStarted = resolve;
    });
    const ignoresTermBriefly = {
      async execute({ abortSignal }) {
        abortSignal.addEventListener("abort", () => termStarted(), {
          once: true,
        });
        await killGrace;
        return { exitCode: null, timedOut: false };
      },
    };
    const spec = queueRun(
      db,
      makeSpec({ adapter: "fake", timeoutSeconds: 0.03 }),
    );
    const running = runOnce(db, registry, { fake: ignoresTermBriefly }, opts());

    await term;
    expect(runState(db, spec.runId)).toBe("RUNNING");
    const refused = extendRunDeadline(db, spec.runId, {
      seconds: 1,
      actor: "operator",
      policyVersion: "test",
      now: T0 + 40,
    });
    expect(refused).toMatchObject({
      refused: true,
      code: "deadline_already_expired",
      status: 409,
    });
    const expiryRows = lifecycleOf(db, spec.runId).filter((row) => {
      try {
        return JSON.parse(row.reason)?.type === "deadline_expired";
      } catch {
        return false;
      }
    });
    expect(expiryRows).toHaveLength(1);

    releaseKillGrace();
    const summary = await running;
    expect(summary).toMatchObject({
      terminalState: "TIMED_OUT",
      reasonCode: "timeout",
    });
  });

  test("extension refuses after the edge even before the worker records expiry", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ timeoutSeconds: 1 }));
    const claim = claimNext(db, opts());
    transition(db, {
      runId: spec.runId,
      to: "RUNNING",
      expectFrom: "LEASED",
      actor: "w1",
      attempt: claim.attempt,
      now: T0,
    });
    db.query(
      `UPDATE attempts SET started_at = ? WHERE run_id = ? AND attempt = ?`,
    ).run(new Date(T0).toISOString(), spec.runId, claim.attempt);

    expect(
      extendRunDeadline(db, spec.runId, {
        seconds: 1,
        actor: "operator",
        policyVersion: "test",
        now: T0 + 1_001,
      }),
    ).toMatchObject({
      refused: true,
      code: "deadline_already_expired",
      status: 409,
      deadlineAt: new Date(T0 + 1_000).toISOString(),
    });
    expect(
      lifecycleOf(db, spec.runId).some((row) => {
        try {
          return JSON.parse(row.reason)?.type === "deadline_extended";
        } catch {
          return false;
        }
      }),
    ).toBe(false);
  });

  test("expire transaction observes an extension that committed before the old edge", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ timeoutSeconds: 1 }));
    const claim = claimNext(db, opts());
    transition(db, {
      runId: spec.runId,
      to: "RUNNING",
      expectFrom: "LEASED",
      actor: "w1",
      attempt: claim.attempt,
      now: T0,
    });
    db.query(
      `UPDATE attempts SET started_at = ? WHERE run_id = ? AND attempt = ?`,
    ).run(new Date(T0).toISOString(), spec.runId, claim.attempt);
    const extension = extendRunDeadline(db, spec.runId, {
      seconds: 1,
      actor: "operator",
      policyVersion: "test",
      now: T0 + 999,
    });
    expect(extension.refused).toBeUndefined();
    expect(
      expireRunDeadline(db, spec.runId, claim.attempt, claim.fencingToken, {
        actor: "w1",
        policyVersion: "test",
        now: T0 + 1_001,
      }),
    ).toMatchObject({ expired: false, deadlineMs: T0 + 2_000 });
  });

  test("timeout accepts a valid result.json written before the adapter hangs (WM-538)", async () => {
    const db = openDb(":memory:");
    const writesThenHangs = {
      async execute({ workspaceDir, timeoutMs }) {
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            artifact: {
              repos: [
                {
                  name: "late",
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
        );
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        return { exitCode: null, timedOut: true };
      },
    };
    const spec = queueRun(
      db,
      makeSpec({ adapter: "writes-then-hangs", timeoutSeconds: 0.01 }),
    );

    const summary = await runOnce(
      db,
      registry,
      { "writes-then-hangs": writesThenHangs },
      opts(),
    );

    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.reasonCode).toBe("ok");
    expect(runState(db, spec.runId)).toBe("COMPLETED");
    expect(lifecycleOf(db, spec.runId)).toContainEqual(
      expect.objectContaining({
        to_state: "VERIFYING",
        reason: "late_completion_after_timeout",
      }),
    );
    expect(
      db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId),
    ).toBeTruthy();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(1);
  });

  test("timeout ignores an invalid result.json and remains TIMED_OUT", async () => {
    const db = openDb(":memory:");
    const invalidThenTimesOut = {
      async execute({ workspaceDir }) {
        writeFileSync(path.join(workspaceDir, "result.json"), "{}\n");
        return { exitCode: null, timedOut: true };
      },
    };
    const spec = queueRun(db, makeSpec({ adapter: "invalid-then-timeout" }));

    const summary = await runOnce(
      db,
      registry,
      { "invalid-then-timeout": invalidThenTimesOut },
      opts(),
    );

    expect(summary.terminalState).toBe("TIMED_OUT");
    expect(summary.reasonCode).toBe("timeout");
    expect(runState(db, spec.runId)).toBe("TIMED_OUT");
    expect(
      db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId),
    ).toBeNull();
  });

  test("crash with maxAttempts 2: FAILED then auto re-QUEUED; second claim has higher fencing token", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ input: { repos: ["crash"] }, maxAttempts: 2 }),
    );
    const o = opts();

    const first = await runOnce(db, registry, adapters, o);
    expect(first.terminalState).toBe("FAILED");
    expect(first.reasonCode).toBe("agent_exit_1");
    expect(runState(db, spec.runId)).toBe("QUEUED");

    const second = claimNext(db, o);
    expect(second).toBeTruthy();
    expect(second.attempt).toBe(2);
    expect(second.fencingToken).toBeGreaterThan(1);
  });

  test("crash with maxAttempts 1: stays FAILED, no auto retry", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ input: { repos: ["crash"] }, maxAttempts: 1 }),
    );

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(claimNext(db, opts())).toBeNull();
  });

  test("attempt 2 resumes the prior harness session and stale attempt 1 remains fenced", async () => {
    const db = openDb(":memory:");
    const resumeRegistry = {
      ...registry,
      agents: new Map(registry.agents),
    };
    resumeRegistry.agents.set("factory-status-report@1", {
      ...getAgent(registry, "factory-status-report@1"),
      // This test owns resume/fencing, not workspace-only admission.
      capabilities: { filesystem: "read-only", services: ["tracker:read"] },
    });
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "claude",
        maxAttempts: 2,
        defHash: computeDefHash(
          resumeRegistry.agents.get("factory-status-report@1"),
        ),
      }),
    );
    const o = opts();
    const stale = claimNext(db, o);
    const priorWorkspace = path.join(o.workspacesRoot, `${spec.runId}-a1`);
    mkdirSync(priorWorkspace, { recursive: true });
    const priorTranscript = path.join(priorWorkspace, ".transcript.json");
    writeFileSync(
      priorTranscript,
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: priorWorkspace,
        session_id: "11111111-2222-4333-8444-555555555555",
      })}\n`,
    );

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(
      reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" }),
    ).toBe(1);
    const fresh = claimNext(db, { ...o, now: afterExpiry });
    expect(fresh.attempt).toBe(2);

    let observedResume = null;
    const resumeAdapter = {
      async execute(args) {
        observedResume = args.resume;
        return fake.execute(args);
      },
    };
    const done = await executeClaimed(
      db,
      resumeRegistry,
      { claude: resumeAdapter },
      fresh,
      { ...o, now: afterExpiry },
    );
    expect(done.terminalState).toBe("COMPLETED");
    expect(observedResume).toEqual({
      attempt: 1,
      sessionId: "11111111-2222-4333-8444-555555555555",
      transcriptPath: priorTranscript,
    });

    const zombie = await executeClaimed(
      db,
      resumeRegistry,
      { claude: resumeAdapter },
      stale,
      { ...o, now: afterExpiry },
    );
    expect(zombie.fenced === true || zombie.cancelled === true).toBe(true);
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`)
        .get(spec.runId).n,
    ).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(1);
  });

  test("attempt 2 cold-starts cleanly when the prior transcript has no resumable session", async () => {
    const db = openDb(":memory:");
    const resumeRegistry = {
      ...registry,
      agents: new Map(registry.agents),
    };
    resumeRegistry.agents.set("factory-status-report@1", {
      ...getAgent(registry, "factory-status-report@1"),
      // This test owns resume extraction, not workspace-only admission.
      capabilities: { filesystem: "read-only", services: ["tracker:read"] },
    });
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "claude",
        maxAttempts: 2,
        defHash: computeDefHash(
          resumeRegistry.agents.get("factory-status-report@1"),
        ),
      }),
    );
    const o = opts();
    claimNext(db, o);
    const priorWorkspace = path.join(o.workspacesRoot, `${spec.runId}-a1`);
    mkdirSync(priorWorkspace, { recursive: true });
    writeFileSync(
      path.join(priorWorkspace, ".transcript.json"),
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: priorWorkspace,
          session_id: "not-a-uuid",
        }),
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/another/run",
          session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      ].join("\n") + "\n",
    );

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(
      reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" }),
    ).toBe(1);
    const fresh = claimNext(db, { ...o, now: afterExpiry });

    let observedResume = "not-called";
    const coldAdapter = {
      async execute(args) {
        observedResume = args.resume;
        return fake.execute(args);
      },
    };
    const done = await executeClaimed(
      db,
      resumeRegistry,
      { claude: coldAdapter },
      fresh,
      { ...o, now: afterExpiry },
    );
    expect(done.terminalState).toBe("COMPLETED");
    expect(observedResume).toBeNull();
  });

  test("adapter argv carries an extracted resume session identifier", () => {
    const root = freshRoot();
    const claudeTranscript = path.join(root, "claude.ndjson");
    const piTranscript = path.join(root, "pi.ndjson");
    const claudeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    writeFileSync(
      claudeTranscript,
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: root,
        session_id: claudeId,
      })}\n`,
    );
    writeFileSync(
      piTranscript,
      `${JSON.stringify({
        type: "session",
        version: 3,
        cwd: root,
        id: "pi-session",
      })}\n`,
    );

    const claudeSession = transcriptSessionId(claudeTranscript, "claude");
    const piSession = transcriptSessionId(piTranscript, "pi");
    expect(claudeSession).toBe(claudeId);
    expect(piSession).toBe("pi-session");

    const claude = buildClaudeArgv({
      prompt: "continue",
      def: { mutating: false },
      resumeSessionId: claudeSession,
    });
    expect(claude.slice(0, 4)).toEqual([
      "-p",
      "continue",
      "--resume",
      claudeId,
    ]);
    expect(claude).toContain("--fork-session");

    const pi = buildPiArgv({
      def: { mutating: false },
      model: null,
      resumeSessionId: piSession,
    });
    expect(pi).toContain("--fork");
    expect(pi[pi.indexOf("--fork") + 1]).toBe("pi-session");
  });

  test("real adapter execute paths forward resume context to their spawned CLIs", async () => {
    const root = freshRoot();
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const command of ["claude", "pi"]) {
      const executable = path.join(bin, command);
      writeFileSync(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FACTORY_TEST_ARGV"\n',
      );
      chmodSync(executable, 0o755);
    }
    const promptPath = path.join(root, "prompt.md");
    const promptText = "Continue the run.\n";
    writeFileSync(promptPath, promptText);
    // Adapters execute only registry-verified promptText (#1218); promptPath
    // stays on the def for provenance.
    const def = {
      promptPath,
      promptText,
      mutating: true,
      capabilities: { tools: [] },
    };
    const spec = { model: null, input: {} };

    const claudeWorkspace = path.join(root, "claude-workspace");
    const claudeArgv = path.join(root, "claude-argv.txt");
    mkdirSync(claudeWorkspace);
    const claudeOutcome = await executeClaude({
      spec,
      def,
      workspaceDir: claudeWorkspace,
      timeoutMs: EXECUTE_SPAWN_TIMEOUT_MS,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_ARGV: claudeArgv,
      },
      resume: { sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    });
    expect(claudeOutcome.exitCode).toBe(0);
    expect(readFileSync(claudeArgv, "utf8").split("\n")).toContain("--resume");
    expect(readFileSync(claudeArgv, "utf8")).toContain(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(readFileSync(claudeArgv, "utf8").split("\n")).toContain(
      "--fork-session",
    );

    const piWorkspace = path.join(root, "pi-workspace");
    const piArgv = path.join(root, "pi-argv.txt");
    mkdirSync(piWorkspace);
    const piOutcome = await executePi({
      spec,
      def,
      workspaceDir: piWorkspace,
      timeoutMs: EXECUTE_SPAWN_TIMEOUT_MS,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FACTORY_TEST_ARGV: piArgv,
      },
      resume: { sessionId: "pi-session" },
    });
    expect(piOutcome.exitCode).toBe(0);
    expect(readFileSync(piArgv, "utf8").split("\n")).toContain("--fork");
    expect(readFileSync(piArgv, "utf8")).toContain("pi-session");
  });

  test("fencing: a stale claim can never publish over a newer attempt", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2 }));
    const o = opts();

    // Claim but never execute — the worker "died".
    const stale = claimNext(db, o);
    expect(runState(db, spec.runId)).toBe("LEASED");

    // Lease expires → reaper re-queues.
    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(
      reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" }),
    ).toBe(1);
    expect(runState(db, spec.runId)).toBe("QUEUED");

    // Fresh claim executes to completion.
    const o2 = { ...o, now: afterExpiry };
    const fresh = claimNext(db, o2);
    expect(fresh.attempt).toBe(2);
    expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken);
    const done = await executeClaimed(db, registry, adapters, fresh, o2);
    expect(done.terminalState).toBe("COMPLETED");

    // The zombie wakes up and tries to run its stale claim.
    const zombie = await executeClaimed(db, registry, adapters, stale, o2);
    expect(zombie.fenced === true || zombie.cancelled === true).toBe(true);

    expect(runState(db, spec.runId)).toBe("COMPLETED");
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`)
        .get(spec.runId).n,
    ).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM outbox`).get().n).toBe(1);
    const terminals = lifecycleOf(db, spec.runId).filter(
      (e) => e.to_state === "COMPLETED",
    );
    expect(terminals).toHaveLength(1);
  });

  test("restart survival: results, receipt, and journal readable from a reopened file db", async () => {
    const dir = tmpDir("evrt-db-");
    const file = path.join(dir, "runtime.db");
    const db = openDb(file);
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    await runOnce(db, registry, adapters, opts());
    expect(runState(db, spec.runId)).toBe("COMPLETED");
    db.close();

    const reopened = openDb(file);
    const result = reopened
      .query(`SELECT * FROM results WHERE run_id = ?`)
      .get(spec.runId);
    expect(result).toBeTruthy();
    expect(JSON.parse(result.receipt_json).verificationStatus).toBe("passed");
    expect(lifecycleOf(reopened, spec.runId).length).toBeGreaterThanOrEqual(4);
    reopened.close();
  });

  test("executeClaimed on a cancelled run stops quietly and publishes nothing", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const o = opts();
    const claim = claimNext(db, o);

    // Operator cancels while the claim was sitting in LEASED.
    cancelRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });

    const summary = await executeClaimed(db, registry, adapters, claim, o);
    expect(summary.cancelled).toBe(true);
    expect(
      db.query(`SELECT * FROM results WHERE run_id = ?`).get(spec.runId),
    ).toBeNull();
    expect(db.query(`SELECT * FROM outbox`).all()).toHaveLength(0);
  });

  test("the suite's policy root is pinned, so a provisioned worktree's instance policy cannot decide a test (#1285)", () => {
    // Seed a worktree-like checkout the way bin/worktree-up.sh does: a real,
    // non-default config/policy.yaml beside the code under test.
    const worktreeLike = tmpDir("evrt-worktree-like-");
    mkdirSync(path.join(worktreeLike, "config"), { recursive: true });
    writeFileSync(
      path.join(worktreeLike, "config", "policy.yaml"),
      "sandbox:\n  workspace_only_fallback:\n    mode: host\n    agents:\n      - factory-status-report\n",
    );
    // The fixture is genuinely non-default...
    expect(policyWorkspaceOnlyFallback(worktreeLike)).toEqual({
      mode: "host",
      agents: ["factory-status-report"],
    });
    // ...and every runOnce in this file still reads the fail-closed default,
    // whatever config/policy.yaml the checkout it runs from happens to hold.
    expect(opts().policyRoot).toBe(EMPTY_POLICY_ROOT);
    expect(
      existsSync(path.join(EMPTY_POLICY_ROOT, "config", "policy.yaml")),
    ).toBe(false);
    expect(policyWorkspaceOnlyFallback(EMPTY_POLICY_ROOT)).toBeNull();
  });

  test("unknown adapter fails terminal", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "nonexistent" }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("unknown_adapter");
  });

  test("workspace-only model execution is refused before workspace creation or adapter spawn (#962)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "claude",
        defHash: computeDefHash(getAgent(registry, "factory-status-report@1")),
      }),
    );
    const workspacesRoot = freshRoot();
    let executed = false;
    const guardedAdapters = createAdapterRegistry({
      builtins: {
        claude: {
          SANDBOX_SUPPORT: "unsupported",
          async execute() {
            executed = true;
            throw new Error("model adapter must not spawn");
          },
        },
      },
    }).toMap();

    const summary = await runOnce(
      db,
      registry,
      guardedAdapters,
      opts({
        workspacesRoot,
        sandboxAvailability: {
          available: false,
          qemu: null,
          node: null,
          nodeVersion: null,
          sdk: false,
          reason: "qemu-system-x86_64 is not on PATH",
        },
      }),
    );

    expect(summary).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "filesystem_confinement_unavailable",
    });
    expect(executed).toBe(false);
    expect(readdirSync(workspacesRoot)).toEqual([]);
    expect(runState(db, spec.runId)).toBe("REFUSED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toContain(
      "sandbox_unavailable:qemu",
    );
    expect(
      JSON.parse(
        db
          .query(`SELECT result_json FROM results WHERE run_id = ?`)
          .get(spec.runId).result_json,
      ).verification,
    ).toEqual({ status: "passed", checks: ["filesystem_confinement"] });
  });

  test("explicit host fallback runs workspace-only models and attests the unconfined receipt (#1250)", async () => {
    const db = openDb(":memory:");
    const def = getAgent(registry, "factory-status-report@1");
    const spec = queueRun(
      db,
      makeSpec({ adapter: "claude", defHash: computeDefHash(def) }),
    );
    const policyRoot = freshRoot();
    mkdirSync(path.join(policyRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(policyRoot, "config", "policy.yaml"),
      "sandbox:\n  workspace_only_fallback:\n    mode: host\n    agents:\n      - factory-status-report\n",
    );
    expect(policyWorkspaceOnlyFallback(policyRoot)).toEqual({
      mode: "host",
      agents: ["factory-status-report"],
    });

    const guardedAdapters = createAdapterRegistry({
      builtins: {
        claude: { ...fake, SANDBOX_SUPPORT: "unsupported" },
      },
    }).toMap();
    const summary = await runOnce(
      db,
      registry,
      guardedAdapters,
      opts({
        policyRoot,
        sandboxAvailability: {
          available: false,
          qemu: null,
          node: null,
          nodeVersion: null,
          sdk: false,
          reason: "qemu-system-x86_64 is not on PATH",
        },
      }),
    );

    const expected = {
      status: "unconfined",
      declared: "workspace-only",
      fallback: "host",
      source: "policy:sandbox.workspace_only_fallback",
      agent: "factory-status-report",
      hostCapability: "qemu",
    };
    expect(summary).toMatchObject({
      terminalState: "COMPLETED",
      receipt: { filesystemConfinement: expected },
    });
    expect(
      JSON.parse(
        db
          .query(`SELECT receipt_json FROM results WHERE run_id = ?`)
          .get(spec.runId).receipt_json,
      ).filesystemConfinement,
    ).toEqual(expected);
  });

  test("an agent the fallback allow-list omits is still refused for the missing host capability (#1250)", async () => {
    const db = openDb(":memory:");
    const def = getAgent(registry, "factory-status-report@1");
    const spec = queueRun(
      db,
      makeSpec({ adapter: "claude", defHash: computeDefHash(def) }),
    );
    const policyRoot = freshRoot();
    mkdirSync(path.join(policyRoot, "config"), { recursive: true });
    // The stanza exists, but it names a different agent.
    writeFileSync(
      path.join(policyRoot, "config", "policy.yaml"),
      "sandbox:\n  workspace_only_fallback:\n    mode: host\n    agents:\n      - work-scan\n",
    );

    const guardedAdapters = createAdapterRegistry({
      builtins: { claude: { ...fake, SANDBOX_SUPPORT: "unsupported" } },
    }).toMap();
    const summary = await runOnce(
      db,
      registry,
      guardedAdapters,
      opts({
        policyRoot,
        sandboxAvailability: {
          available: false,
          qemu: null,
          node: null,
          nodeVersion: null,
          sdk: false,
          reason: "qemu-system-x86_64 is not on PATH",
        },
      }),
    );

    expect(summary).toMatchObject({ terminalState: "REFUSED" });
    expect(runState(db, spec.runId)).toBe("REFUSED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toContain(
      "sandbox_unavailable:qemu",
    );
    expect(
      JSON.parse(
        db
          .query(`SELECT receipt_json FROM results WHERE run_id = ?`)
          .get(spec.runId).receipt_json,
      ).filesystemConfinement,
    ).toBeUndefined();
  });

  test("an unconfined admission is attested on non-receipt terminal paths too (#1250)", async () => {
    const db = openDb(":memory:");
    const def = getAgent(registry, "factory-status-report@1");
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "claude",
        defHash: computeDefHash(def),
        maxAttempts: 1,
      }),
    );
    const policyRoot = freshRoot();
    mkdirSync(path.join(policyRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(policyRoot, "config", "policy.yaml"),
      "sandbox:\n  workspace_only_fallback:\n    mode: host\n    agents:\n      - factory-status-report\n",
    );

    // FAILED writes no results receipt, so the attestation has to survive on
    // the attempt trace or it would exist only for runs that completed.
    const guardedAdapters = createAdapterRegistry({
      builtins: {
        claude: {
          ...fake,
          SANDBOX_SUPPORT: "unsupported",
          execute: async () => {
            throw new Error("adapter blew up");
          },
        },
      },
    }).toMap();
    const summary = await runOnce(
      db,
      registry,
      guardedAdapters,
      opts({
        policyRoot,
        sandboxAvailability: {
          available: false,
          qemu: null,
          node: null,
          nodeVersion: null,
          sdk: false,
          reason: "qemu-system-x86_64 is not on PATH",
        },
      }),
    );

    expect(summary.terminalState).toBe("FAILED");
    const attested = db
      .query(`SELECT payload_json FROM attempt_trace WHERE run_id = ?`)
      .all(spec.runId)
      .map((row) => JSON.parse(row.payload_json))
      .filter((payload) => payload?.filesystemConfinement);
    expect(attested).toHaveLength(1);
    expect(attested[0].filesystemConfinement).toMatchObject({
      status: "unconfined",
      agent: "factory-status-report",
      hostCapability: "qemu",
    });
  });

  test("legacy non-mutating model specs without a definition pin fail closed before using the live definition (#962)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "hermes" }));
    const workspacesRoot = freshRoot();
    let executed = false;
    const guardedAdapters = createAdapterRegistry({
      builtins: {
        hermes: {
          SANDBOX_SUPPORT: "unsupported",
          async execute() {
            executed = true;
          },
        },
      },
    }).toMap();

    const summary = await runOnce(
      db,
      registry,
      guardedAdapters,
      opts({ workspacesRoot }),
    );

    expect(summary).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "agent_definition_mismatch",
    });
    expect(executed).toBe(false);
    expect(readdirSync(workspacesRoot)).toEqual([]);
    expect(
      JSON.parse(
        db
          .query(`SELECT result_json FROM results WHERE run_id = ?`)
          .get(spec.runId).result_json,
      ).verification.checks,
    ).toEqual(["def_hash_missing"]);
  });

  test("cancelRun on a QUEUED run → CANCELLED; on a terminal run → IllegalTransition", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const result = cancelRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });
    expect(result.to).toBe("CANCELLED");
    expect(runState(db, spec.runId)).toBe("CANCELLED");

    expect(() =>
      cancelRun(db, spec.runId, {
        actor: "operator",
        policyVersion: "test",
        now: T0,
      }),
    ).toThrow(IllegalTransition);
  });

  test("cancelRun on a PROPOSED run closes its unique open proposal", () => {
    const db = openDb(":memory:");
    const spec = makeSpec();
    createRun(db, {
      runId: spec.runId,
      idempotencyKey: spec.idempotencyKey,
      spec,
      specJson: canonicalJson(spec),
      specHash: hashJson(spec),
      actor: "test",
      policyVersion: "test",
      now: T0,
    });
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', 'open', ?, 1800)`,
    ).run("prop-1", "test", "evt-1", spec.runId, new Date(T0).toISOString());

    const result = cancelRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });
    expect(result.to).toBe("CANCELLED");
    expect(result.proposalClose).toEqual({ closed: true, id: "prop-1" });
    expect(
      db
        .query(`SELECT status, reason FROM proposals WHERE id = 'prop-1'`)
        .get(),
    ).toEqual({
      status: "rejected",
      reason: "run_cancelled",
    });
  });

  test("cancelRun with no open proposal still cancels", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const result = cancelRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });
    expect(result.to).toBe("CANCELLED");
    expect(result.proposalClose).toEqual({ closed: false });
  });

  test("cancelRun with two open proposals for the run closes neither", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const at = new Date(T0).toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds)
       VALUES ('p1', 'test', 'e1', ?, 'run', 'open', ?, 1800), ('p2', 'test', 'e2', ?, 'run', 'open', ?, 1800)`,
    ).run(spec.runId, at, spec.runId, at);

    const result = cancelRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });
    expect(result.to).toBe("CANCELLED");
    expect(result.proposalClose).toEqual({
      closed: false,
      ambiguous: true,
      count: 2,
    });
    expect(
      db.query(`SELECT status FROM proposals WHERE id = 'p1'`).get().status,
    ).toBe("open");
    expect(
      db.query(`SELECT status FROM proposals WHERE id = 'p2'`).get().status,
    ).toBe("open");
  });

  test("retryRun: exhausted agent attempts throw without force, re-queue with force", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ input: { repos: ["crash"] }, maxAttempts: 1 }),
    );
    await runOnce(db, registry, adapters, opts());
    expect(runState(db, spec.runId)).toBe("FAILED");

    expect(() =>
      retryRun(db, spec.runId, {
        actor: "operator",
        policyVersion: "test",
        now: T0,
      }),
    ).toThrow("attempts_exhausted");

    const retried = retryRun(db, spec.runId, {
      actor: "operator",
      force: true,
      policyVersion: "test",
      now: T0,
    });
    expect(retried.to).toBe("QUEUED");
    expect(runState(db, spec.runId)).toBe("QUEUED");
  });

  test("retryRun does not treat environment attempts as exhausted agent attempts", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = {
      execute: async () => {
        throw new Error("network dropped");
      },
    };
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "throwing",
        maxAttempts: 1,
        maxEnvironmentRetries: 0,
      }),
    );
    await runOnce(db, registry, { throwing: throwingAdapter }, opts());
    expect(runState(db, spec.runId)).toBe("FAILED");

    const retried = retryRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });
    expect(retried.to).toBe("QUEUED");
  });

  test("failure cause taxonomy classifies retryable and fatal worker failures", () => {
    expect(classifyFailureCause("adapter_error")).toBe("environment");
    expect(classifyFailureCause("lease_expired")).toBe("environment");
    expect(classifyFailureCause("linear_unconfigured")).toBe("environment");
    expect(classifyFailureCause("registry_stale")).toBe("environment");
    expect(classifyFailureCause(HANDOFF_DEPENDENCIES_MISSING)).toBe(
      "environment",
    );
    expect(classifyFailureCause("handoff_worktree_missing")).toBe(
      "environment",
    );
    expect(classifyFailureCause(HANDOFF_FORGE_UNAVAILABLE)).toBe("environment");
    expect(classifyFailureCause("agent_exit_1")).toBe("agent_error");
    expect(classifyFailureCause("contract_violation")).toBe("agent_error");
    for (const reason of [
      "cli_not_found",
      "sandbox_unsupported",
      "worktree_sandbox_unsupported",
      "input_artifact_missing",
      "unknown_adapter",
      "agent_definition_mismatch",
      "policy_denied:Bash",
      "workspace_integrity_violation",
      "verification_internal_error",
    ]) {
      expect(classifyFailureCause(reason)).toBe("fatal");
    }
    expect(DEFAULT_MAX_ENVIRONMENT_RETRIES).toBe(3);
  });

  test("tier escalation eligibility is closed to exhausted agent-caused light and standard dispatch failures", () => {
    const light = makeSpec({
      agent: "dispatch@1",
      input: { repo: "factory", ticket: "WM-845" },
      workspace: {
        type: "worktree",
        checkoutDir: "repo",
        retainOnFailure: true,
      },
      modelTier: "light",
      maxAttempts: 1,
    });
    for (const reasonCode of [
      "handoff_verification_failed",
      "handoff_owned_paths_violation",
      "contract_violation",
      "agent_exit_1",
    ]) {
      expect(tierEscalationEligibility(light, reasonCode)).toEqual({
        eligible: true,
        rootRunId: light.runId,
      });
    }
    for (const reasonCode of [
      "timeout",
      "lease_expired",
      "adapter_error",
      HANDOFF_DEPENDENCIES_MISSING,
      "needs_human",
      "policy_denied:Bash",
      "cancelled",
      // The acceptance criteria name `verification_failed`; nothing emits it.
      // The real code is `handoff_verification_failed` (verify.mjs), so the
      // invented spelling must not silently widen the predicate.
      "verification_failed",
    ]) {
      expect(tierEscalationEligibility(light, reasonCode).eligible).toBe(false);
    }
    expect(
      tierEscalationEligibility(
        { ...light, modelTier: "strong" },
        "agent_exit_1",
      ).eligible,
    ).toBe(false);
    expect(
      tierEscalationEligibility(
        { ...light, rootRunId: "run_root", escalatedFromRunId: "run_prior" },
        "agent_exit_1",
      ).eligible,
    ).toBe(false);
  });

  test("tier escalation skips work already handed to review but keeps active claims eligible", () => {
    const spec = makeSpec({
      agent: "dispatch@1",
      input: { repo: "factory", ticket: "watt-mind/factory#2006" },
      workspace: { type: "worktree", checkoutDir: "repo" },
      modelTier: "light",
    });
    const inReview = tierEscalationContinuationGuard(spec, "agent_exit_1", {
      fetchTicket: () => ({ state: { name: "In Review" } }),
    });
    expect(inReview).toMatchObject({
      eligible: true,
      skip: true,
      reason: "ticket_in_review",
    });
    const db = openDb(":memory:");
    queueRun(db, spec);
    linkEvent(db, spec.runId);
    expect(
      scheduleTierEscalation(db, registry, spec, {
        workspacePath: "/retained/factory-2006",
        sourceWorkspacePath: "/workspace/run-2006",
        continuationRunId: "run_tier_in_review",
        reasonCode: "agent_exit_1",
        continuationGuard: inReview,
      }),
    ).toBeNull();
    expect(
      db.query(`SELECT * FROM runs WHERE run_id = 'run_tier_in_review'`).get(),
    ).toBeNull();
    db.close();
    for (const state of ["Todo", "In Progress"]) {
      expect(
        tierEscalationContinuationGuard(spec, "agent_exit_1", {
          fetchTicket: () => ({ state: { name: state } }),
        }),
      ).toMatchObject({ eligible: true, skip: false });
    }
    expect(
      tierEscalationContinuationGuard(spec, "agent_exit_1", {
        fetchTicket: () => ({ state: { name: "In Progress" } }),
        workspacePath: "/retained/factory-2006",
        findPullRequest: () => ({ isDraft: false }),
      }),
    ).toMatchObject({
      eligible: true,
      skip: true,
      reason: "retained_pr_open",
    });
  });

  test("failed dispatch skips an In Review continuation but schedules one for an active ticket", async () => {
    const executeFailure = async (reviewed) => {
      const db = openDb(":memory:");
      let ticketState = "Todo";
      const ticket = "watt-mind/factory#2006";
      const comments = [];
      const spec = queueRun(
        db,
        makeSpec({
          runId: `run_tier_failed_${reviewed ? "reviewed" : "active"}`,
          agent: "dispatch@1",
          input: { repo: "factory", ticket },
          workspace: {
            type: "worktree",
            checkoutDir: "repo",
            retainOnFailure: true,
          },
          outputContract: "factory.dispatch-result/v1",
          modelTier: "light",
          maxAttempts: 1,
        }),
      );
      linkEvent(db, spec.runId, { type: "factory.dispatch.requested" });
      const o = opts({
        dispatch: {
          // Pin the registry's factory checkout to this tree: the example
          // registry's ~/Develop/factory is absent under repo-verify (#2031).
          configSnapshot: dispatchConfigSnapshot(),
          locksDir: tmpDir("tier-skip-locks-"),
          leasesDir: tmpDir("tier-skip-leases-"),
          fetchTicket: () => ({
            identifier: ticket,
            state: { name: ticketState },
            assignee: ticketState === "Todo" ? null : { name: "hdkiller" },
            labels: {
              nodes: [
                {
                  name:
                    ticketState === "Todo"
                      ? "ai:agent-ready"
                      : "ai:in-progress",
                },
              ],
            },
            description:
              "## Owned Paths\n- event-runtime/lib/worker.mjs\n\n## Verification Command\n`bun test event-runtime/lib/worker.test.mjs`\n",
          }),
          fetchInFlight: () => [],
          countLeases: () => 0,
          budgetRefusal: () => null,
          claimTicket: () => ((ticketState = "In Progress"), { ok: true }),
          commentTicket: (entry) => comments.push(entry),
          projectTierEscalation: () => true,
          findWorkspacePullRequest: () => null,
        },
        materializeWorktree: () => ({
          path: tmpDir("tier-skip-checkout-"),
        }),
      });
      const claim = claimNext(db, o);
      const result = await executeClaimed(
        db,
        registry,
        {
          fake: {
            async execute() {
              if (reviewed) ticketState = "In Review";
              return { exitCode: 1, timedOut: false };
            },
          },
        },
        claim,
        o,
      );
      const continuations = db
        .query(`SELECT * FROM tier_escalations ORDER BY created_at`)
        .all();
      db.close();
      return { result, comments, continuations };
    };

    const reviewed = await executeFailure(true);
    expect(reviewed.result).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "agent_exit_1",
      tierEscalationSkip: "ticket_in_review",
    });
    expect(reviewed.continuations).toEqual([]);
    expect(reviewed.comments).toContainEqual(
      expect.objectContaining({
        body: expect.stringContaining(
          "Tier escalation skipped: ticket is already In Review",
        ),
      }),
    );

    const active = await executeFailure(false);
    expect(active.result).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "agent_exit_1",
      escalatedRunId: expect.any(String),
    });
    expect(active.result.tierEscalationSkip).toBeUndefined();
    expect(active.continuations).toHaveLength(1);
  });

  test("a retained open PR skips the continuation and still releases the ticket claim", async () => {
    const db = openDb(":memory:");
    const ticket = "watt-mind/factory#2006";
    let ticketState = "Todo";
    const comments = [];
    const unclaims = [];
    const spec = queueRun(
      db,
      makeSpec({
        runId: "run_tier_retained_pr",
        agent: "dispatch@1",
        input: { repo: "factory", ticket },
        workspace: {
          type: "worktree",
          checkoutDir: "repo",
          retainOnFailure: true,
        },
        outputContract: "factory.dispatch-result/v1",
        modelTier: "light",
        maxAttempts: 1,
      }),
    );
    linkEvent(db, spec.runId, { type: "factory.dispatch.requested" });
    const o = opts({
      dispatch: {
        configSnapshot: dispatchConfigSnapshot(),
        locksDir: tmpDir("tier-retained-locks-"),
        leasesDir: tmpDir("tier-retained-leases-"),
        fetchTicket: () => ({
          identifier: ticket,
          state: { name: ticketState },
          assignee: ticketState === "Todo" ? null : { name: "hdkiller" },
          labels: {
            nodes: [
              {
                name:
                  ticketState === "Todo" ? "ai:agent-ready" : "ai:in-progress",
              },
            ],
          },
          description:
            "## Owned Paths\n- event-runtime/lib/worker.mjs\n\n## Verification Command\n`bun test event-runtime/lib/worker.test.mjs`\n",
        }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        budgetRefusal: () => null,
        claimTicket: () => ((ticketState = "In Progress"), { ok: true }),
        commentTicket: (entry) => comments.push(entry),
        unclaimTicket: (entry) => (unclaims.push(entry), true),
        projectTierEscalation: () => true,
        // The agent opened a PR and left it out of draft; the ticket never
        // reached In Review, so only the forge carries the ownership signal.
        findWorkspacePullRequest: () => ({ number: 4242, isDraft: false }),
      },
      materializeWorktree: () => ({ path: tmpDir("tier-retained-checkout-") }),
    });
    const claim = claimNext(db, o);
    const result = await executeClaimed(
      db,
      registry,
      {
        fake: {
          async execute() {
            return { exitCode: 1, timedOut: false };
          },
        },
      },
      claim,
      o,
    );

    expect(result).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "agent_exit_1",
      tierEscalationSkip: "retained_pr_open",
    });
    expect(db.query(`SELECT * FROM tier_escalations`).all()).toEqual([]);
    // No continuation inherits the claim, so the run must hand the ticket back
    // itself rather than strand it In Progress with nothing scheduled.
    expect(unclaims).toEqual([
      { repo: "factory", ticket, why: "agent_exit_1", log: null },
    ]);
    expect(comments).toContainEqual(
      expect.objectContaining({
        body: expect.stringContaining(
          "the retained worktree already has an open non-draft PR",
        ),
      }),
    );
    db.close();
  });

  test("the PR the failed handoff just opened is drafted before the guard reads it, so escalation still happens", async () => {
    const db = openDb(":memory:");
    const ticket = "watt-mind/factory#2006";
    let ticketState = "Todo";
    // The agent's own PR: open and NOT draft at the moment the handoff
    // verification fails. WM-718's hold converts it; the guard must observe
    // the converted state, not the pre-hold one.
    let prIsDraft = false;
    const held = [];
    const spec = queueRun(
      db,
      makeSpec({
        runId: "run_tier_handoff_pr",
        agent: "dispatch@1",
        input: { repo: "factory", ticket },
        workspace: {
          type: "worktree",
          checkoutDir: "repo",
          retainOnFailure: true,
        },
        outputContract: "factory.dispatch-result/v1",
        modelTier: "light",
        maxAttempts: 1,
      }),
    );
    linkEvent(db, spec.runId, { type: "factory.dispatch.requested" });
    const o = opts({
      verifyResult: () => {
        throw new ContractViolation(["repo_verify_failed"], {
          reasonCode: "handoff_verification_failed",
          handoff: {
            prNumber: 4242,
            prUrl: "https://github.com/watt-mind/factory/pull/4242",
            github: "watt-mind/factory",
            verification: [],
          },
        });
      },
      dispatch: {
        configSnapshot: dispatchConfigSnapshot(),
        locksDir: tmpDir("tier-handoff-locks-"),
        leasesDir: tmpDir("tier-handoff-leases-"),
        fetchTicket: () => ({
          identifier: ticket,
          state: { name: ticketState },
          assignee: ticketState === "Todo" ? null : { name: "hdkiller" },
          labels: {
            nodes: [
              {
                name:
                  ticketState === "Todo" ? "ai:agent-ready" : "ai:in-progress",
              },
            ],
          },
          description:
            "## Owned Paths\n- event-runtime/lib/worker.mjs\n\n## Verification Command\n`bun test event-runtime/lib/worker.test.mjs`\n",
        }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        budgetRefusal: () => null,
        claimTicket: () => ((ticketState = "In Progress"), { ok: true }),
        commentTicket: () => {},
        holdPullRequest: (entry) => (
          held.push(entry),
          (prIsDraft = true),
          true
        ),
        returnHandoffTicket: () => ({ agentReadyRestored: true }),
        unclaimTicket: () => true,
        projectTierEscalation: () => true,
        findWorkspacePullRequest: () => ({ number: 4242, isDraft: prIsDraft }),
      },
      materializeWorktree: () => ({ path: tmpDir("tier-handoff-checkout-") }),
    });
    const claim = claimNext(db, o);
    const result = await executeClaimed(
      db,
      registry,
      {
        fake: {
          async execute() {
            return { exitCode: 0, timedOut: false };
          },
        },
      },
      claim,
      o,
    );

    expect(result).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "handoff_verification_failed",
      escalatedRunId: expect.any(String),
    });
    expect(result.tierEscalationSkip).toBeUndefined();
    expect(held).toHaveLength(1);
    expect(db.query(`SELECT * FROM tier_escalations`).all()).toHaveLength(1);
    db.close();
  });

  test("continuation handoff failures are matched per violation, anchored at its start", () => {
    const quoted =
      "repo_verify_failed: (fail) x\nweb_build_failed: quoted inside output";
    expect(continuationHandoffFailure([quoted])).toBeNull();
    expect(
      continuationHandoffFailure([
        quoted,
        "ticket_verify_failed: bunx: command not found; sandbox_limits: tmpfs=1024MiB",
      ]),
    ).toBe(
      "ticket_verify_failed: bunx: command not found; sandbox_limits: tmpfs=1024MiB",
    );
    expect(
      continuationHandoffFailure(
        "owned_paths_violation: a; web_build_failed: error TS7053",
      ),
    ).toBe("web_build_failed: error TS7053");
    expect(continuationHandoffFailure(undefined)).toBeNull();
    expect(continuationHandoffFailure([42, null])).toBeNull();
    const missingResultReason =
      "contract_violation: missing_result: expected /tmp/run/result.json; agent stdout/stderr (last 2 KB): text; ticket_verify_failed: quoted output";
    expect(continuationHandoffFailure(missingResultReason)).toBe(
      missingResultReason,
    );
    expect(
      continuationExecutionInput(
        { repo: "factory", ticket: "watt-mind/factory#1539" },
        continuationHandoffFailure(missingResultReason),
      ).handoffFailure,
    ).toBe(missingResultReason);
  });

  test("a handoff_verification_failed run hands its web_build_failed line to the continuation", () => {
    const violations = [
      "owned_paths_violation: docs/x.md",
      "web_build_failed: src/views/Ticket.tsx: error TS7053",
    ];
    const error = new ContractViolation(violations, {
      reasonCode: "handoff_verification_failed",
    });
    const failureReason = `handoff_verification_failed: ${violations.join(", ")}`;
    // The composed reason is prefixed, so the anchored matcher cannot see the
    // diagnostic in it; the worker must hand over the raw violations instead.
    expect(continuationHandoffFailure(failureReason)).toBeNull();
    expect(escalationHandoffFailure(error, failureReason)).toBe(
      "web_build_failed: src/views/Ticket.tsx: error TS7053",
    );
    const missingResultReason =
      "contract_violation: missing_result: expected /tmp/run/result.json; agent stdout/stderr (last 2 KB): text";
    expect(
      escalationHandoffFailure(
        new ContractViolation(["missing_result"]),
        missingResultReason,
      ),
    ).toBe(missingResultReason);
    expect(
      escalationHandoffFailure(
        new ContractViolation(["missing_artifact"]),
        "contract_violation: missing_artifact",
      ),
    ).toBeNull();
  });

  test("tier continuation input carries the worker-observed handoff failure verbatim", () => {
    const handoffFailure = `web_build_failed: ${"TS7053\n".repeat(200)}`.slice(
      0,
      2 * 1024,
    );
    expect(
      continuationExecutionInput(
        { repo: "factory", ticket: "WM-1529" },
        handoffFailure,
      ),
    ).toEqual({
      repo: "factory",
      ticket: "WM-1529",
      handoffFailure,
    });
  });

  test("tier escalation schedules exactly once and retries projection before the continuation is runnable", () => {
    const databaseFile = path.join(
      tmpDir("tier-escalation-restart-"),
      "runtime.db",
    );
    let db = openDb(databaseFile);
    const spec = queueRun(
      db,
      makeSpec({
        runId: "run_tier_root",
        agent: "dispatch@1",
        input: { repo: "factory", ticket: "WM-845", modelTier: "light" },
        workspace: {
          type: "worktree",
          checkoutDir: "repo",
          retainOnFailure: true,
        },
        modelTier: "light",
        model: null,
        maxAttempts: 1,
      }),
    );
    linkEvent(db, spec.runId, {
      type: "factory.dispatch.requested",
      correlationId: "root-correlation",
    });
    const checkout = tmpDir("tier-escalation-checkout-");
    const wrapper = tmpDir("tier-escalation-wrapper-");
    const first = scheduleTierEscalation(db, registry, spec, {
      workspacePath: checkout,
      sourceWorkspacePath: wrapper,
      continuationRunId: "run_tier_strong",
      now: T0,
      reasonCode: "contract_violation",
      handoffFailure: "web_build_failed: src/views/Ticket.tsx: error TS7053",
    });
    db.close();
    db = openDb(databaseFile);
    const again = scheduleTierEscalation(db, registry, spec, {
      workspacePath: checkout,
      sourceWorkspacePath: wrapper,
      continuationRunId: "run_tier_duplicate",
      now: T0,
      reasonCode: "contract_violation",
    });
    expect(first.continuation_run_id).toBe("run_tier_strong");
    expect(again.continuation_run_id).toBe("run_tier_strong");
    expect(db.query(`SELECT COUNT(*) AS n FROM tier_escalations`).get().n).toBe(
      1,
    );
    expect(runState(db, "run_tier_strong")).toBe("APPROVED");
    expect(
      db.query(`SELECT * FROM runs WHERE run_id = 'run_tier_duplicate'`).get(),
    ).toBeNull();
    const continuation = JSON.parse(
      db
        .query(`SELECT spec_json FROM runs WHERE run_id = 'run_tier_strong'`)
        .get().spec_json,
    );
    expect(continuation).toMatchObject({
      rootRunId: spec.runId,
      escalatedFromRunId: spec.runId,
      modelTier: "strong",
      approvalPolicy: {
        escalation: {
          handoffFailure:
            "web_build_failed: src/views/Ticket.tsx: error TS7053",
        },
      },
    });
    const event = db
      .query(`SELECT * FROM events WHERE source = 'handoff'`)
      .get();
    expect(event.correlation_id).toBe("root-correlation");
    expect(event.causation_id).toBe(spec.runId);

    const projectionErrors = [];
    expect(
      claimNext(db, {
        owner: "restart-worker",
        adapters: [],
        projectTierEscalation: () => {
          throw new Error("tracker unavailable");
        },
        now: T0,
        policyVersion: "test",
        onTierEscalationProjectionError: (entry) =>
          projectionErrors.push(entry),
      }),
    ).toBeNull();
    expect(projectionErrors[0]).toMatchObject({
      reasonCode: "tier_escalation_writeback_failed",
      continuationRunId: "run_tier_strong",
      error: "tracker unavailable",
    });
    expect(runState(db, "run_tier_strong")).toBe("APPROVED");

    const writes = [];
    expect(
      claimNext(db, {
        owner: "restart-worker",
        adapters: [],
        projectTierEscalation: (entry) => (writes.push(entry), true),
        now: T0,
        policyVersion: "test",
      }),
    ).toBeNull();
    expect(writes[0]).toMatchObject({
      failedRunId: spec.runId,
      continuationRunId: "run_tier_strong",
      workspacePath: checkout,
    });
    expect(runState(db, "run_tier_strong")).toBe("QUEUED");

    const noPendingProjection = reconcileTierEscalations(db, {
      projectTierEscalation: () => {
        throw new Error("tracker unavailable");
      },
      now: T0,
      policyVersion: "test",
    });
    expect(noPendingProjection).toEqual({ ok: true, projected: 0 });
    expect(
      lifecycleOf(db, "run_tier_strong").map((entry) => entry.reason),
    ).toEqual(
      expect.arrayContaining([
        `auto_approved:tier-escalation:${spec.runId}`,
        `tracker_projection_applied:${spec.runId}`,
      ]),
    );
    db.close();
  });

  test("tier escalation refuses a continuation when its failed run PR is closed", async () => {
    const db = openDb(":memory:");
    const failedRunId = "run_tier_closed_failed";
    const continuationRunId = "run_tier_closed_continuation";
    queueRun(
      db,
      makeSpec({
        runId: continuationRunId,
        agent: "dispatch@1",
        input: {
          repo: "factory",
          ticket: "watt-mind/factory#1499",
          modelTier: "strong",
        },
        workspace: { type: "worktree", checkoutDir: "repo" },
        outputContract: "factory.dispatch-result/v1",
        modelTier: "strong",
      }),
    );
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:test', '{}', '{}', ?)`,
    ).run(
      failedRunId,
      JSON.stringify({ artifact: { prNumber: 1499 } }),
      new Date(T0).toISOString(),
    );
    db.query(
      `INSERT INTO tier_escalations
         (root_run_id, failed_run_id, continuation_run_id, repo, ticket,
          workspace_path, source_workspace_path, projection_state, created_at)
       VALUES (?, ?, ?, 'factory', 'watt-mind/factory#1499', '/tmp/checkout', '/tmp/wrapper', 'applied', ?)`,
    ).run(
      failedRunId,
      failedRunId,
      continuationRunId,
      new Date(T0).toISOString(),
    );

    const locksDir = tmpDir("tier-closed-locks-");
    const leasesDir = tmpDir("tier-closed-leases-");
    let claims = 0;
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        dispatch: {
          locksDir,
          leasesDir,
          fetchTicket: () => ({
            identifier: "watt-mind/factory#1499",
            state: { name: "In Progress" },
            assignee: { id: "factory-owner", name: "Factory" },
            labels: {
              nodes: [{ name: "ai:in-progress" }, { name: "tier:strong" }],
            },
            description: "## Owned Paths\n- event-runtime/lib/worker.mjs\n",
          }),
          fetchViewer: () => ({ id: "factory-owner", name: "Factory" }),
          fetchPullRequest: ({ github, pr }) => {
            expect(github).toBe("watt-mind/factory");
            expect(pr).toBe(1499);
            return { state: "MERGED" };
          },
          fetchInFlight: () => [],
          countLeases: () => 0,
          budgetRefusal: () => null,
          claimTicket: () => ((claims += 1), { ok: true }),
        },
      }),
    );

    expect(summary).toMatchObject({
      runId: continuationRunId,
      terminalState: "REFUSED",
      reasonCode: "ticket_escalation_pr_closed",
    });
    expect(claims).toBe(0);
    expect(existsSync(dispatchLockPath("factory", locksDir))).toBe(false);
    expect(
      db
        .query(
          `SELECT projection_state, projection_error FROM tier_escalations WHERE continuation_run_id = ?`,
        )
        .get(continuationRunId),
    ).toEqual({
      projection_state: "refused",
      projection_error: "ticket_escalation_pr_closed",
    });
    db.close();
  });

  test("tier escalation marks its projection refused when the checkout branch already has a ready PR", async () => {
    const db = openDb(":memory:");
    const failedRunId = "run_tier_open_pr_failed";
    const continuationRunId = "run_tier_open_pr_continuation";
    queueRun(
      db,
      makeSpec({
        runId: continuationRunId,
        agent: "dispatch@1",
        input: {
          repo: "factory",
          ticket: "watt-mind/factory#1539",
          modelTier: "strong",
        },
        workspace: { type: "worktree", checkoutDir: "repo" },
        outputContract: "factory.dispatch-result/v1",
        modelTier: "strong",
      }),
    );
    db.query(
      `INSERT INTO tier_escalations
         (root_run_id, failed_run_id, continuation_run_id, repo, ticket,
          workspace_path, source_workspace_path, projection_state, created_at)
       VALUES (?, ?, ?, 'factory', 'watt-mind/factory#1539', '/tmp/checkout', '/tmp/wrapper', 'applied', ?)`,
    ).run(
      failedRunId,
      failedRunId,
      continuationRunId,
      new Date(T0).toISOString(),
    );

    const locksDir = tmpDir("tier-open-pr-locks-");
    const leasesDir = tmpDir("tier-open-pr-leases-");
    let claims = 0;
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        dispatch: {
          locksDir,
          leasesDir,
          fetchTicket: () => ({
            identifier: "watt-mind/factory#1539",
            state: { name: "In Progress" },
            assignee: { id: "factory-owner", name: "Factory" },
            labels: {
              nodes: [{ name: "ai:in-progress" }, { name: "tier:strong" }],
            },
            description: "## Owned Paths\n- event-runtime/lib/worker.mjs\n",
          }),
          fetchViewer: () => ({ id: "factory-owner", name: "Factory" }),
          findWorkspacePullRequest: () => ({
            number: 1533,
            state: "OPEN",
            isDraft: false,
          }),
          fetchInFlight: () => [],
          countLeases: () => 0,
          budgetRefusal: () => null,
          claimTicket: () => ((claims += 1), { ok: true }),
        },
      }),
    );

    expect(summary).toMatchObject({
      runId: continuationRunId,
      terminalState: "REFUSED",
      reasonCode: "ticket_pr_already_open",
    });
    expect(claims).toBe(0);
    expect(
      db
        .query(
          `SELECT projection_state, projection_error FROM tier_escalations WHERE continuation_run_id = ?`,
        )
        .get(continuationRunId),
    ).toEqual({
      projection_state: "refused",
      projection_error: "ticket_pr_already_open",
    });
    db.close();
  });

  test("tier escalation routes a handoff-verification PR to merge review", async () => {
    const db = openDb(":memory:");
    const failedRunId = "run_tier_verify_failed";
    const continuationRunId = "run_tier_verify_continuation";
    queueRun(
      db,
      makeSpec({
        runId: continuationRunId,
        agent: "dispatch@1",
        input: {
          repo: "factory",
          ticket: "watt-mind/factory#1539",
          modelTier: "strong",
        },
        workspace: { type: "worktree", checkoutDir: "repo" },
        outputContract: "factory.dispatch-result/v1",
        modelTier: "strong",
      }),
    );
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, finished_at, terminal_state, reason_code)
       VALUES (?, 1, 1, ?, 'FAILED', 'handoff_verification_failed')`,
    ).run(failedRunId, new Date(T0).toISOString());
    db.query(
      `INSERT INTO tier_escalations
         (root_run_id, failed_run_id, continuation_run_id, repo, ticket,
          workspace_path, source_workspace_path, projection_state, created_at)
       VALUES (?, ?, ?, 'factory', 'watt-mind/factory#1539', '/tmp/checkout', '/tmp/wrapper', 'applied', ?)`,
    ).run(
      failedRunId,
      failedRunId,
      continuationRunId,
      new Date(T0).toISOString(),
    );

    const routed = [];
    // The PR-side effect is asserted through the DEFAULT hold helper against
    // an in-memory forge (the dispatch stub would otherwise no-op it): the
    // merge stage skips drafts, so drafting is what stops a refused handoff
    // from landing without a fix round.
    const forge = memoryForge({
      repos: {
        "watt-mind/factory": {
          prs: [{ number: 1533, state: "OPEN", isDraft: false }],
        },
      },
    });
    const summary = await runOnce(
      db,
      registry,
      adapters,
      opts({
        dispatch: {
          holdPullRequest: (args) => defaultHoldPullRequest({ ...args, forge }),
          locksDir: tmpDir("tier-verify-pr-locks-"),
          leasesDir: tmpDir("tier-verify-pr-leases-"),
          fetchTicket: () => ({
            identifier: "watt-mind/factory#1539",
            state: { name: "In Progress" },
            assignee: { id: "factory-owner", name: "Factory" },
            labels: {
              nodes: [{ name: "ai:in-progress" }, { name: "tier:strong" }],
            },
            description: "## Owned Paths\n- event-runtime/lib/worker.mjs\n",
          }),
          fetchViewer: () => ({ id: "factory-owner", name: "Factory" }),
          findWorkspacePullRequest: () => ({
            number: 1533,
            state: "OPEN",
            isDraft: false,
          }),
          fetchInFlight: () => [],
          countLeases: () => 0,
          budgetRefusal: () => null,
          reconcileVerifiedHandoffTicket: (args) => (routed.push(args), true),
        },
      }),
    );

    expect(summary).toMatchObject({
      runId: continuationRunId,
      terminalState: "REFUSED",
      reasonCode: "ticket_pr_handoff_verification_failed",
    });
    expect(routed).toEqual([
      expect.objectContaining({
        repo: "factory",
        ticket: "watt-mind/factory#1539",
        reason: "handoff_verification_failed",
        prNumber: 1533,
      }),
    ]);
    expect(forge.calls).toEqual([
      expect.objectContaining({
        op: "prSetDraft",
        repo: "watt-mind/factory",
        number: 1533,
        draft: true,
      }),
      expect.objectContaining({
        op: "prComment",
        repo: "watt-mind/factory",
        number: 1533,
        body: expect.stringContaining("handoff_verification_failed"),
      }),
    ]);
    expect(forge.calls[1].body).toContain("Converted to draft");
    expect(forge.seed.repos["watt-mind/factory"].prs[0].isDraft).toBe(true);
    expect(
      db
        .query(
          `SELECT projection_state, projection_error FROM tier_escalations WHERE continuation_run_id = ?`,
        )
        .get(continuationRunId),
    ).toEqual({
      projection_state: "refused",
      projection_error: "ticket_pr_handoff_verification_failed",
    });
    db.close();
  });

  test("tier escalation requeues a continuation when its failed run PR read fails transiently", async () => {
    const seedEscalation = (db, failedRunId, continuationRunId) => {
      queueRun(
        db,
        makeSpec({
          runId: continuationRunId,
          agent: "dispatch@1",
          input: {
            repo: "factory",
            ticket: "watt-mind/factory#1499",
            modelTier: "strong",
          },
          workspace: { type: "worktree", checkoutDir: "repo" },
          outputContract: "factory.dispatch-result/v1",
          modelTier: "strong",
        }),
      );
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, 1, ?, 'sha256:test', '{}', '{}', ?)`,
      ).run(
        failedRunId,
        JSON.stringify({ artifact: { prNumber: 1499 } }),
        new Date(T0).toISOString(),
      );
      db.query(
        `INSERT INTO tier_escalations
           (root_run_id, failed_run_id, continuation_run_id, repo, ticket,
            workspace_path, source_workspace_path, projection_state, created_at)
         VALUES (?, ?, ?, 'factory', 'watt-mind/factory#1499', '/tmp/checkout', '/tmp/wrapper', 'applied', ?)`,
      ).run(
        failedRunId,
        failedRunId,
        continuationRunId,
        new Date(T0).toISOString(),
      );
    };
    const escalationRow = (db, continuationRunId) =>
      db
        .query(
          `SELECT projection_state, projection_error FROM tier_escalations WHERE continuation_run_id = ?`,
        )
        .get(continuationRunId);
    const dispatchOpts = (locksDir, leasesDir, claims) => ({
      locksDir,
      leasesDir,
      fetchTicket: () => ({
        identifier: "watt-mind/factory#1499",
        state: { name: "In Progress" },
        assignee: { id: "factory-owner", name: "Factory" },
        labels: {
          nodes: [{ name: "ai:in-progress" }, { name: "tier:strong" }],
        },
        description: "## Owned Paths\n- event-runtime/lib/worker.mjs\n",
      }),
      fetchViewer: () => ({ id: "factory-owner", name: "Factory" }),
      fetchPullRequest: () => {
        throw new Error("github_read_failed: rate limited");
      },
      fetchInFlight: () => [],
      countLeases: () => 0,
      budgetRefusal: () => null,
      claimTicket: () => ((claims.count += 1), { ok: true }),
    });

    {
      const db = openDb(":memory:");
      const continuationRunId = "run_tier_unreadable_continuation";
      seedEscalation(db, "run_tier_unreadable_failed", continuationRunId);
      const locksDir = tmpDir("tier-unreadable-locks-");
      const leasesDir = tmpDir("tier-unreadable-leases-");
      const claims = { count: 0 };
      const summary = await runOnce(
        db,
        registry,
        adapters,
        opts({ dispatch: dispatchOpts(locksDir, leasesDir, claims) }),
      );
      expect(summary).toMatchObject({
        runId: continuationRunId,
        terminalState: "QUEUED",
        reasonCode: "ticket_escalation_pr_read_failed",
      });
      expect(summary.requeueAfterMs).toBeGreaterThan(0);
      expect(claims.count).toBe(0);
      expect(existsSync(dispatchLockPath("factory", locksDir))).toBe(false);
      expect(runState(db, continuationRunId)).toBe("QUEUED");
      expect(escalationRow(db, continuationRunId)).toEqual({
        projection_state: "applied",
        projection_error: null,
      });
      db.close();
    }

    {
      const db = openDb(":memory:");
      const continuationRunId = "run_tier_exhausted_continuation";
      seedEscalation(db, "run_tier_exhausted_failed", continuationRunId);
      const locksDir = tmpDir("tier-exhausted-locks-");
      const leasesDir = tmpDir("tier-exhausted-leases-");
      const claims = { count: 0 };
      const summary = await runOnce(
        db,
        registry,
        adapters,
        opts({
          dispatch: {
            ...dispatchOpts(locksDir, leasesDir, claims),
            maxTransientGateRequeues: 0,
          },
        }),
      );
      expect(summary).toMatchObject({
        runId: continuationRunId,
        terminalState: "REFUSED",
        reasonCode: "ticket_escalation_pr_read_failed",
      });
      expect(claims.count).toBe(0);
      expect(existsSync(dispatchLockPath("factory", locksDir))).toBe(false);
      expect(escalationRow(db, continuationRunId)).toEqual({
        projection_state: "refused",
        projection_error: "ticket_escalation_pr_read_failed",
      });
      db.close();
    }
  });

  test("tier escalation projection replaces every tier label and comments both run ids idempotently", () => {
    const calls = [];
    const runCli = (args) => {
      calls.push(args);
      if (args[0] === "comments") return "[]";
      return "{}";
    };
    expect(
      defaultProjectTierEscalation({
        repo: "factory",
        ticket: "WM-845",
        failedRunId: "run_light",
        continuationRunId: "run_strong",
        workspacePath: "/retained/WM-845",
        fetchTicket: () => ({
          labels: [
            { name: "tier:light" },
            { name: "tier:standard" },
            { name: "tier:strong" },
            { name: "type:feature" },
          ],
        }),
        findPullRequest: ({ workspacePath }) => {
          expect(workspacePath).toBe("/retained/WM-845");
          return {
            number: 1281,
            url: "https://github.com/watt-mind/factory/pull/1281",
            headRefName: "feat/gh-1239",
          };
        },
        runCli,
      }),
    ).toBe(true);
    expect(calls[0]).toEqual([
      "labels",
      "WM-845",
      "--add",
      "tier:strong",
      "--remove",
      "tier:light",
      "--remove",
      "tier:standard",
    ]);
    expect(calls.at(-1)[0]).toBe("comment");
    expect(calls.at(-1)[2]).toContain("run_light");
    expect(calls.at(-1)[2]).toContain("run_strong");
    expect(calls.at(-1)[2]).toContain(
      "https://github.com/watt-mind/factory/pull/1281",
    );
  });

  test("cancelRun releases an unstarted tier continuation claim and retained worktree ownership", () => {
    const db = openDb(":memory:");
    const failed = queueRun(
      db,
      makeSpec({
        runId: "run_cancel_tier_failed",
        agent: "dispatch@1",
        input: { repo: "factory", ticket: "watt-mind/factory#2006" },
        workspace: {
          type: "worktree",
          checkoutDir: "repo",
          retainOnFailure: true,
        },
        modelTier: "light",
        maxAttempts: 1,
      }),
    );
    linkEvent(db, failed.runId);
    const escalation = scheduleTierEscalation(db, registry, failed, {
      workspacePath: "/retained/factory-2006",
      sourceWorkspacePath: "/workspace/run-2006",
      continuationRunId: "run_cancel_tier_continuation",
      reasonCode: "agent_exit_1",
    });
    const unclaims = [];
    const cleanups = [];

    const result = cancelRun(db, escalation.continuation_run_id, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
      unclaimTierEscalation: (entry) => (unclaims.push(entry), true),
      cleanupTierEscalationWorkspace: (entry) => (cleanups.push(entry), true),
    });

    expect(runState(db, escalation.continuation_run_id)).toBe("CANCELLED");
    expect(result.escalationCancellation).toEqual({
      projectionRefused: true,
      claimReleased: true,
      workspaceCleaned: true,
    });
    expect(unclaims).toEqual([
      {
        repo: "factory",
        ticket: "watt-mind/factory#2006",
        why: "operator_cancel",
        log: null,
      },
    ]);
    expect(cleanups).toEqual([
      {
        sourceWorkspacePath: "/workspace/run-2006",
        workspacePath: "/retained/factory-2006",
        repo: "factory",
        ticket: "watt-mind/factory#2006",
      },
    ]);
    expect(
      db
        .query(
          `SELECT projection_state, projection_error FROM tier_escalations WHERE continuation_run_id = ?`,
        )
        .get(escalation.continuation_run_id),
    ).toEqual({
      projection_state: "refused",
      projection_error: "operator_cancel",
    });
    db.close();
  });

  test("adapter_error with maxAttempts 1 requeues and succeeds without consuming the agent budget", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const flakyAdapter = {
      async execute(args) {
        calls += 1;
        if (calls === 1) throw new Error("simulated transport explosion");
        return fake.execute(args);
      },
    };
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "flaky",
        maxAttempts: 1,
        maxEnvironmentRetries: 1,
        workspace: { type: "ephemeral", retainOnFailure: false },
      }),
    );
    const o = opts();

    const first = await runOnce(db, registry, { flaky: flakyAdapter }, o);
    expect(first).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "adapter_error",
    });
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:environment");

    const second = await runOnce(db, registry, { flaky: flakyAdapter }, o);
    expect(second.terminalState).toBe("COMPLETED");
    expect(runState(db, spec.runId)).toBe("COMPLETED");
    expect(
      db
        .query(
          `SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`,
        )
        .all(spec.runId),
    ).toEqual([{ reason_code: "adapter_error" }, { reason_code: "ok" }]);
  });

  test("adapter failure logs and traces a failTerminal failure", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ adapter: "throwing" }));
    const originalQuery = db.query.bind(db);
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "query") {
          return (sql) => {
            if (String(sql).includes("UPDATE attempts SET terminal_state")) {
              throw new Error("finish attempt write failed");
            }
            return originalQuery(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const loud = [];
    const originalConsoleError = console.error;
    console.error = (...args) => loud.push(args.join(" "));
    let summary;
    try {
      summary = await runOnce(
        failingDb,
        registry,
        {
          throwing: {
            async execute() {
              throw new Error("adapter exploded");
            },
          },
        },
        opts(),
      );
    } finally {
      console.error = originalConsoleError;
    }

    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "adapter_error",
      terminalError: "finish attempt write failed",
    });
    expect(loud.join("\n")).toContain(
      `terminal failTerminal failed for run ${spec.runId} attempt 1: finish attempt write failed`,
    );
    expect(
      db
        .query(
          `SELECT kind, payload_json FROM attempt_trace WHERE run_id = ? ORDER BY seq`,
        )
        .all(spec.runId)
        .map((row) => ({ kind: row.kind, ...JSON.parse(row.payload_json) })),
    ).toContainEqual({
      kind: "lifecycle",
      terminalError: true,
      operation: "failTerminal",
      runId: spec.runId,
      attempt: 1,
      message: "finish attempt write failed",
    });
  });

  test("SandboxUnsupportedError is fatal and never requeues", async () => {
    const db = openDb(":memory:");
    const unsupportedAdapter = {
      async execute() {
        throw new SandboxUnsupportedError("unsupported", "test adapter");
      },
    };
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "unsupported",
        maxAttempts: 5,
        maxEnvironmentRetries: 5,
      }),
    );

    const summary = await runOnce(
      db,
      registry,
      { unsupported: unsupportedAdapter },
      opts(),
    );
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "sandbox_unsupported",
    });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(claimNext(db, opts())).toBeNull();
    expect(
      lifecycleOf(db, spec.runId).some((event) =>
        event.reason?.startsWith("retry:"),
      ),
    ).toBe(false);
  });

  test("repeated environment failures stop at the dedicated retry ceiling", async () => {
    const db = openDb(":memory:");
    const throwingAdapter = {
      execute: async () => {
        throw new Error("simulated transport explosion");
      },
    };
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "throwing",
        maxAttempts: 1,
        maxEnvironmentRetries: 2,
        workspace: { type: "ephemeral", retainOnFailure: false },
      }),
    );
    const o = opts();

    expect(
      (await runOnce(db, registry, { throwing: throwingAdapter }, o))
        .reasonCode,
    ).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(
      (await runOnce(db, registry, { throwing: throwingAdapter }, o))
        .reasonCode,
    ).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(
      (await runOnce(db, registry, { throwing: throwingAdapter }, o))
        .reasonCode,
    ).toBe("adapter_error");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`)
        .get(spec.runId).n,
    ).toBe(3);
    expect(
      lifecycleOf(db, spec.runId).filter(
        (event) => event.reason === "retry:environment",
      ),
    ).toHaveLength(2);
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toContain(
      "environment_retry_budget_exhausted",
    );
  });

  test("a missing pinned memo artifact retires its memo before terminal failure", async () => {
    const db = openDb(":memory:");
    const missingSha = "a".repeat(64);
    let executed = false;
    const observingAdapter = {
      async execute() {
        executed = true;
        return { exitCode: 0, timedOut: false };
      },
    };
    const spec = queueRun(
      db,
      makeSpec({
        input: {
          repos: ["ok"],
          memoPin: { entries: [{ sha256: missingSha }] },
        },
        workspace: {
          type: "artifacts",
          inputs: [{ from: missingSha, as: "input.json" }],
        },
        maxEnvironmentRetries: 5,
      }),
    );
    db.query(
      `INSERT INTO memos (sha256, subject_type, subject_id, kind, created_at)
       VALUES (?, 'repo', 'factory', 'repo-note', ?)`,
    ).run(missingSha, T0);

    const summary = await runOnce(
      db,
      registry,
      { fake: observingAdapter },
      opts({ artifactStore: freshRoot() }),
    );

    expect(executed).toBe(false);
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "input_artifact_missing",
    });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      db
        .query(`SELECT reason_code FROM attempts WHERE run_id = ?`)
        .get(spec.runId).reason_code,
    ).toBe("input_artifact_missing");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toContain(
      "failure:fatal:input_artifact_missing",
    );
    expect(
      db
        .query(`SELECT retired_at, retired_reason FROM memos WHERE sha256 = ?`)
        .get(missingSha),
    ).toEqual({ retired_at: T0, retired_reason: "artifact_missing" });
  });

  test("a missing non-memo declared input stays fatal without retiring a memo", async () => {
    const db = openDb(":memory:");
    const missingSha = "b".repeat(64);
    const spec = queueRun(
      db,
      makeSpec({
        workspace: {
          type: "artifacts",
          inputs: [{ from: missingSha, as: "input.json" }],
        },
      }),
    );
    db.query(
      `INSERT INTO memos (sha256, subject_type, subject_id, kind, created_at)
       VALUES (?, 'repo', 'factory', 'repo-note', ?)`,
    ).run(missingSha, T0);

    const summary = await runOnce(
      db,
      registry,
      { fake },
      opts({ artifactStore: freshRoot() }),
    );

    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "input_artifact_missing",
    });
    expect(
      db
        .query(`SELECT retired_at, retired_reason FROM memos WHERE sha256 = ?`)
        .get(missingSha),
    ).toEqual({ retired_at: null, retired_reason: null });
  });

  test("environment failures do not consume agent_exit retry attempts", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const mixedAdapter = {
      async execute() {
        calls += 1;
        if (calls === 1) throw new Error("network dropped");
        return { exitCode: 1, timedOut: false };
      },
    };
    const spec = queueRun(
      db,
      makeSpec({ adapter: "mixed", maxAttempts: 2, maxEnvironmentRetries: 1 }),
    );
    const o = opts();

    await runOnce(db, registry, { mixed: mixedAdapter }, o);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    await runOnce(db, registry, { mixed: mixedAdapter }, o);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:agent_error");
    await runOnce(db, registry, { mixed: mixedAdapter }, o);
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      db
        .query(
          `SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`,
        )
        .all(spec.runId),
    ).toEqual([
      { reason_code: "adapter_error" },
      { reason_code: "agent_exit_1" },
      { reason_code: "agent_exit_1" },
    ]);
  });

  test("contract violations consume maxAttempts independently of environment failures", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ input: { repos: ["invalid-artifact"] }, maxAttempts: 2 }),
    );
    const o = opts();

    await runOnce(db, registry, adapters, o);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:agent_error");
    await runOnce(db, registry, adapters, o);
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      db
        .query(
          `SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`,
        )
        .all(spec.runId),
    ).toEqual([
      { reason_code: "contract_violation" },
      { reason_code: "contract_violation" },
    ]);
  });

  test("fatal errors never requeue regardless of either retry budget", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({
        adapter: "nonexistent",
        maxAttempts: 5,
        maxEnvironmentRetries: 5,
      }),
    );

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "unknown_adapter",
    });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(claimNext(db, opts())).toBeNull();
    expect(
      lifecycleOf(db, spec.runId).some((event) =>
        event.reason?.startsWith("retry:"),
      ),
    ).toBe(false);
  });

  test("post-VERIFYING exception finalizes the attempt and re-queues instead of stranding it (WM-261)", async () => {
    const db = openDb(":memory:");
    const blockedStoreParent = path.join(freshRoot(), "not-a-directory");
    writeFileSync(blockedStoreParent, "blocks artifact store creation\n");
    const spec = queueRun(
      db,
      makeSpec({
        maxAttempts: 2,
        workspace: { type: "ephemeral", retainOnFailure: false },
      }),
    );
    const o = opts({
      artifactStore: path.join(blockedStoreParent, "artifacts"),
    });

    const summary = await runOnce(db, registry, adapters, o);

    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "adapter_error",
    });
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(
      lifecycleOf(db, spec.runId)
        .slice(-3)
        .map((event) => event.to_state),
    ).toEqual(["VERIFYING", "FAILED", "QUEUED"]);
    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(spec.runId);
    expect(attempt.terminal_state).toBe("FAILED");
    expect(attempt.reason_code).toBe("adapter_error");
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(
      false,
    );
  });

  test("lease_expired uses the environment retry ceiling instead of maxAttempts", () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ maxAttempts: 1, maxEnvironmentRetries: 1 }),
    );
    const o = opts();
    claimNext(db, o);
    expect(runState(db, spec.runId)).toBe("LEASED");

    const firstExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(
      reapExpiredLeases(db, { now: firstExpiry, policyVersion: "test" }),
    ).toBe(1);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe("retry:environment");

    const secondClaim = claimNext(db, { ...o, now: firstExpiry });
    const secondExpiry = firstExpiry + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(secondClaim.attempt).toBe(2);
    expect(
      reapExpiredLeases(db, { now: secondExpiry, policyVersion: "test" }),
    ).toBe(1);
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      db
        .query(
          `SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`,
        )
        .all(spec.runId),
    ).toEqual([
      { reason_code: "lease_expired" },
      { reason_code: "lease_expired" },
    ]);
    expect(claimNext(db, opts())).toBeNull();
  });

  test("releasing a stalled worker finalizes and marks a retry as a lease expiry", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2 }));
    const claim = claimNext(db, opts());
    const staleAt = T0 - 90_001;
    db.query(
      `INSERT INTO workers (worker_id, host, pid, labels_json, adapters, started_at, last_seen, state, current_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "w1",
      "test-host",
      1,
      "{}",
      "fake",
      new Date(T0).toISOString(),
      new Date(staleAt).toISOString(),
      "busy",
      spec.runId,
    );

    expect(
      releaseStalledWorkerLease(
        db,
        { workerId: "w1", runId: spec.runId },
        { now: T0, policyVersion: "test" },
      ),
    ).toEqual({ released: true, runId: spec.runId });
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(
      db
        .query(
          `SELECT terminal_state, reason_code, finished_at FROM attempts WHERE run_id = ? AND attempt = ?`,
        )
        .get(spec.runId, claim.attempt),
    ).toEqual({
      terminal_state: "FAILED",
      reason_code: "lease_expired",
      finished_at: new Date(T0).toISOString(),
    });
    expect(claimedRetryFor(db, spec.runId, claim.attempt + 1)).toEqual({
      runId: spec.runId,
      priorAttempt: claim.attempt,
      reasonCode: "lease_expired",
    });
  });

  test("releasing a stalled worker honors the environment retry ceiling", () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ maxAttempts: 5, maxEnvironmentRetries: 0 }),
    );
    db.query(`UPDATE runs SET attempts = 1 WHERE run_id = ?`).run(spec.runId);
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, finished_at, terminal_state, reason_code)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      spec.runId,
      1,
      1,
      new Date(T0 - 1).toISOString(),
      "FAILED",
      "lease_expired",
    );
    db.query(`INSERT INTO counters (name, value) VALUES (?, ?)`).run(
      "fencing",
      1,
    );
    const claim = claimNext(db, opts());
    const staleAt = T0 - 90_001;
    db.query(
      `INSERT INTO workers (worker_id, host, pid, labels_json, adapters, started_at, last_seen, state, current_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "w1",
      "test-host",
      1,
      "{}",
      "fake",
      new Date(T0).toISOString(),
      new Date(staleAt).toISOString(),
      "busy",
      spec.runId,
    );

    expect(
      releaseStalledWorkerLease(
        db,
        { workerId: "w1", runId: spec.runId },
        { now: T0, policyVersion: "test" },
      ),
    ).toEqual({ released: true, runId: spec.runId });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(claim.attempt).toBe(2);
    expect(
      db
        .query(
          `SELECT terminal_state, reason_code FROM attempts WHERE run_id = ? AND attempt = ?`,
        )
        .get(spec.runId, claim.attempt),
    ).toEqual({ terminal_state: "FAILED", reason_code: "lease_expired" });
  });

  test("stalled-worker release matches reaper at the environment retry ceiling", () => {
    const releasedDb = openDb(":memory:");
    const reapedDb = openDb(":memory:");
    const releasedSpec = queueRun(
      releasedDb,
      makeSpec({
        runId: "run_stalled_release_ceiling",
        maxAttempts: 5,
        maxEnvironmentRetries: 0,
      }),
    );
    const reapedSpec = queueRun(
      reapedDb,
      makeSpec({
        runId: "run_stalled_reap_ceiling",
        maxAttempts: 5,
        maxEnvironmentRetries: 0,
      }),
    );

    for (const [db, spec] of [
      [releasedDb, releasedSpec],
      [reapedDb, reapedSpec],
    ]) {
      db.query(`UPDATE runs SET attempts = 1 WHERE run_id = ?`).run(spec.runId);
      db.query(
        `INSERT INTO attempts (run_id, attempt, fencing_token, finished_at, terminal_state, reason_code)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        spec.runId,
        1,
        1,
        new Date(T0 - 1).toISOString(),
        "FAILED",
        "lease_expired",
      );
      db.query(`INSERT INTO counters (name, value) VALUES (?, ?)`).run(
        "fencing",
        1,
      );
    }

    const releasedClaim = claimNext(releasedDb, opts({ owner: "w-release" }));
    const reapedClaim = claimNext(reapedDb, opts({ owner: "reaper" }));
    expect(releasedClaim.attempt).toBe(2);
    expect(reapedClaim.attempt).toBe(2);
    const afterExpiry = T0 + (releasedSpec.timeoutSeconds + 120) * 1000 + 1;
    insertStalledWorker(
      releasedDb,
      "w-release",
      releasedSpec.runId,
      afterExpiry,
    );

    expect(
      releaseStalledWorkerLease(
        releasedDb,
        { workerId: "w-release", runId: releasedSpec.runId },
        { now: afterExpiry, policyVersion: "test" },
      ),
    ).toEqual({ released: true, runId: releasedSpec.runId });
    expect(
      reapExpiredLeases(reapedDb, { now: afterExpiry, policyVersion: "test" }),
    ).toBe(1);

    expect(runState(releasedDb, releasedSpec.runId)).toBe("FAILED");
    expect(runState(reapedDb, reapedSpec.runId)).toBe("FAILED");
    expect(
      lifecycleOf(releasedDb, releasedSpec.runId)
        .slice(-2)
        .map(({ to_state, reason }) => ({ to_state, reason })),
    ).toEqual(
      lifecycleOf(reapedDb, reapedSpec.runId)
        .slice(-2)
        .map(({ to_state, reason }) => ({ to_state, reason })),
    );
    expect(lifecycleOf(releasedDb, releasedSpec.runId).at(-1).reason).toBe(
      "failure:environment:lease_expired; environment_retry_budget_exhausted",
    );
  });

  test("stalled-worker release matches reaper below the environment retry ceiling", () => {
    const releasedDb = openDb(":memory:");
    const reapedDb = openDb(":memory:");
    const releasedSpec = queueRun(
      releasedDb,
      makeSpec({
        runId: "run_stalled_release_retry",
        maxEnvironmentRetries: 1,
      }),
    );
    const reapedSpec = queueRun(
      reapedDb,
      makeSpec({ runId: "run_stalled_reap_retry", maxEnvironmentRetries: 1 }),
    );
    const releasedClaim = claimNext(releasedDb, opts({ owner: "w-release" }));
    const reapedClaim = claimNext(reapedDb, opts({ owner: "reaper" }));
    expect(releasedClaim.attempt).toBe(1);
    expect(reapedClaim.attempt).toBe(1);
    const afterExpiry = T0 + (releasedSpec.timeoutSeconds + 120) * 1000 + 1;
    insertStalledWorker(
      releasedDb,
      "w-release",
      releasedSpec.runId,
      afterExpiry,
    );

    expect(
      releaseStalledWorkerLease(
        releasedDb,
        { workerId: "w-release", runId: releasedSpec.runId },
        { now: afterExpiry, policyVersion: "test" },
      ),
    ).toEqual({ released: true, runId: releasedSpec.runId });
    expect(
      reapExpiredLeases(reapedDb, { now: afterExpiry, policyVersion: "test" }),
    ).toBe(1);

    expect(runState(releasedDb, releasedSpec.runId)).toBe("QUEUED");
    expect(runState(reapedDb, reapedSpec.runId)).toBe("QUEUED");
    expect(lifecycleOf(releasedDb, releasedSpec.runId).at(-1).reason).toBe(
      "retry:environment",
    );
    expect(lifecycleOf(reapedDb, reapedSpec.runId).at(-1).reason).toBe(
      "retry:environment",
    );
  });

  test("cancelRun on a RUNNING attempt aborts adapter immediately and records attempt (OPS-417)", async () => {
    const db = openDb(":memory:");
    let aborted = false;
    const longRunningAdapter = {
      execute: ({ abortSignal }) => {
        return new Promise((resolve) => {
          const timer = setTimeout(
            () => resolve({ exitCode: 0, timedOut: false }),
            5000,
          );
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            resolve({
              exitCode: null,
              timedOut: false,
              usage: {
                model: "claude-sonnet-4-6",
                inputTokens: 9,
                outputTokens: 2,
              },
            });
          });
        });
      },
    };
    const customAdapters = { long: longRunningAdapter };
    const spec = queueRun(
      db,
      makeSpec({ adapter: "long", timeoutSeconds: 30 }),
    );
    const o = opts();

    const claim = claimNext(db, o);
    const execPromise = executeClaimed(db, registry, customAdapters, claim, o);

    // Cancel while RUNNING
    expect(runState(db, spec.runId)).toBe("RUNNING");
    cancelRun(db, spec.runId, {
      actor: "operator",
      policyVersion: "test",
      now: T0,
    });

    const summary = await execPromise;
    expect(summary.cancelled).toBe(true);
    expect(aborted).toBe(true);
    expect(runState(db, spec.runId)).toBe("CANCELLED");

    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(spec.runId);
    expect(attempt.terminal_state).toBe("CANCELLED");
    expect(attempt.reason_code).toBe("cancelled");
    expect(attempt.finished_at).toBeTruthy();
    expect(existsSync(path.join(o.workspacesRoot, `${spec.runId}-a1`))).toBe(
      false,
    );
    expect(runUsage(db, spec.runId).attempts[0]).toEqual(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        inputTokens: 9,
        outputTokens: 2,
        totalTokens: 11,
      }),
    );
  });

  test("cancelled attempt reports and traces a finishAttempt failure", async () => {
    const db = openDb(":memory:");
    let signalAdapterStarted;
    const adapterStarted = new Promise((resolve) => {
      signalAdapterStarted = resolve;
    });
    const longRunningAdapter = {
      execute: ({ abortSignal }) =>
        new Promise((resolve) => {
          abortSignal?.addEventListener("abort", () =>
            resolve({ exitCode: null, timedOut: false }),
          );
          signalAdapterStarted();
        }),
    };
    const spec = queueRun(
      db,
      makeSpec({ adapter: "long", timeoutSeconds: 30 }),
    );
    const originalQuery = db.query.bind(db);
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "query") {
          return (sql) => {
            if (String(sql).includes("UPDATE attempts SET terminal_state")) {
              throw new Error("cancel finish write failed");
            }
            return originalQuery(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const loud = [];
    const originalConsoleError = console.error;
    console.error = (...args) => loud.push(args.join(" "));
    let summary;
    try {
      const claim = claimNext(db, opts());
      const execution = executeClaimed(
        failingDb,
        registry,
        { long: longRunningAdapter },
        claim,
        opts(),
      );
      await adapterStarted;
      cancelRun(db, spec.runId, {
        actor: "operator",
        policyVersion: "test",
        now: T0,
      });
      summary = await execution;
    } finally {
      console.error = originalConsoleError;
    }

    expect(summary).toEqual({
      cancelled: true,
      finishError: "cancel finish write failed",
    });
    expect(loud.join("\n")).toContain(
      `terminal finishAttempt failed for run ${spec.runId} attempt 1: cancel finish write failed`,
    );
    expect(
      db
        .query(
          `SELECT kind, payload_json FROM attempt_trace WHERE run_id = ? ORDER BY seq`,
        )
        .all(spec.runId)
        .map((row) => ({ kind: row.kind, ...JSON.parse(row.payload_json) })),
    ).toContainEqual({
      kind: "lifecycle",
      terminalError: true,
      operation: "finishAttempt",
      runId: spec.runId,
      attempt: 1,
      message: "cancel finish write failed",
    });
  });

  test("forceFailRun preserves the LEASED → RUNNING → FAILED journal path", () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    claimNext(db, opts());

    const result = forceFailRun(db, spec.runId, {
      actor: "operator",
      reason: "operator_force_fail",
      policyVersion: "test",
      now: T0,
    });

    expect(result.to).toBe("FAILED");
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      lifecycleOf(db, spec.runId)
        .slice(-2)
        .map((entry) => entry.to_state),
    ).toEqual(["RUNNING", "FAILED"]);
  });

  test("runOnce returns null when nothing is QUEUED", async () => {
    const db = openDb(":memory:");
    expect(await runOnce(db, registry, adapters, opts())).toBeNull();
  });

  test("accurate attempt timestamps: started_at < finished_at with clock function (OPS-430)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    linkEvent(db, spec.runId);
    let t = T0;
    const clock = () => (t += 1000);
    const o = opts({ now: clock });

    const summary = await runOnce(db, registry, adapters, o);
    expect(summary.terminalState).toBe("COMPLETED");

    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(spec.runId);
    expect(attempt.started_at).toBeTruthy();
    expect(attempt.finished_at).toBeTruthy();
    expect(Date.parse(attempt.started_at)).toBeLessThan(
      Date.parse(attempt.finished_at),
    );

    const journal = lifecycleOf(db, spec.runId);
    const leased = journal.find((e) => e.to_state === "LEASED");
    const running = journal.find((e) => e.to_state === "RUNNING");
    const verifying = journal.find((e) => e.to_state === "VERIFYING");
    const completed = journal.find((e) => e.to_state === "COMPLETED");

    expect(Date.parse(leased.at)).toBeLessThan(Date.parse(running.at));
    expect(Date.parse(running.at)).toBeLessThan(Date.parse(verifying.at));
    expect(Date.parse(verifying.at)).toBeLessThan(Date.parse(completed.at));
    expect(attempt.started_at).toBe(running.at);
    expect(attempt.finished_at).toBe(completed.at);
  });

  test("claimNext refuses a stale worker before leasing and requires reload (WM-613)", () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({
        promptVersion: "git:current",
        policyVersion: "git:current",
      }),
    );

    const refusal = claimNext(db, {
      ...opts(),
      policyVersion: "git:stale",
      registryVersion: "git:stale",
      currentRegistryVersion: "git:current",
    });

    expect(refusal).toMatchObject({
      runId: spec.runId,
      refused: true,
      retryable: true,
      reloadRequired: true,
      reasonCode: "registry_stale",
      workerRegistryVersion: "git:stale",
      checkoutRegistryVersion: "git:current",
    });
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(
      db.query(`SELECT attempts FROM runs WHERE run_id = ?`).get(spec.runId)
        .attempts,
    ).toBe(0);
    expect(
      db.query(`SELECT * FROM attempts WHERE run_id = ?`).all(spec.runId),
    ).toHaveLength(0);
  });

  test("claimNext does not restart-loop a fresh worker on an older queued spec (WM-613)", () => {
    const db = openDb(":memory:");
    const staleSpec = queueRun(
      db,
      makeSpec({
        promptVersion: "git:old",
        policyVersion: "git:old",
      }),
    );

    const refusal = claimNext(db, {
      ...opts(),
      policyVersion: "git:current",
      registryVersion: "git:current",
      currentRegistryVersion: "git:current",
    });

    expect(refusal).toMatchObject({
      runId: staleSpec.runId,
      refused: true,
      retryable: true,
      reloadRequired: false,
      reasonCode: "registry_stale",
    });
    expect(runState(db, staleSpec.runId)).toBe("QUEUED");
  });

  test("claimNext skips an incompatible old spec and claims compatible queued work (WM-613)", () => {
    const db = openDb(":memory:");
    const staleSpec = queueRun(
      db,
      makeSpec({
        promptVersion: "git:old",
        policyVersion: "git:old",
      }),
      T0,
    );
    const compatibleSpec = queueRun(
      db,
      makeSpec({
        promptVersion: "git:current",
        policyVersion: "git:current",
      }),
      T0 + 1000,
    );

    const claim = claimNext(db, {
      ...opts(),
      policyVersion: "git:current",
      registryVersion: "git:current",
      currentRegistryVersion: "git:current",
    });

    expect(claim.runId).toBe(compatibleSpec.runId);
    expect(runState(db, staleSpec.runId)).toBe("QUEUED");
    expect(runState(db, compatibleSpec.runId)).toBe("LEASED");
  });

  test("claimNext unconstrained candidate query: 60 unsatisfiable placement runs do not starve matching run (OPS-454)", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 60; i += 1) {
      queueRun(db, makeSpec({ placement: { node: "nowhere" } }), T0 + i * 1000);
    }
    const claimableSpec = queueRun(
      db,
      makeSpec({ placement: null }),
      T0 + 60 * 1000,
    );

    const claim = claimNext(db, opts({ labels: {} }));
    expect(claim).not.toBeNull();
    expect(claim.runId).toBe(claimableSpec.runId);
  });

  test("claimNext unconstrained candidate query: 60 unsatisfiable adapter runs do not starve matching run (OPS-454)", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 60; i += 1) {
      queueRun(db, makeSpec({ adapter: "missing_adapter" }), T0 + i * 1000);
    }
    const claimableSpec = queueRun(
      db,
      makeSpec({ adapter: "fake" }),
      T0 + 60 * 1000,
    );

    const claim = claimNext(db, opts({ adapters: ["fake"] }));
    expect(claim).not.toBeNull();
    expect(claim.runId).toBe(claimableSpec.runId);
  });

  test("claimNext preserves oldest-eligible-first ordering among satisfiable runs (OPS-454)", () => {
    const db = openDb(":memory:");
    const unclaimable1 = queueRun(
      db,
      makeSpec({ placement: { node: "gpu" } }),
      T0,
    );
    const claimable1 = queueRun(db, makeSpec({ placement: null }), T0 + 1000);
    const unclaimable2 = queueRun(
      db,
      makeSpec({ placement: { node: "gpu" } }),
      T0 + 2000,
    );
    const claimable2 = queueRun(db, makeSpec({ placement: null }), T0 + 3000);

    const firstClaim = claimNext(db, opts({ labels: {} }));
    expect(firstClaim).not.toBeNull();
    expect(firstClaim.runId).toBe(claimable1.runId);

    const secondClaim = claimNext(db, opts({ labels: {} }));
    expect(secondClaim).not.toBeNull();
    expect(secondClaim.runId).toBe(claimable2.runId);
  });

  test("fencing on failure: reaped-while-running worker's late failure cannot overwrite newer attempt (OPS-413)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ maxAttempts: 2, input: { repos: ["ok"] } }),
    );
    const o1 = opts({ owner: "w1", now: T0 });

    // Worker 1 claims attempt 1 and begins running
    const claim1 = claimNext(db, o1);
    expect(claim1.attempt).toBe(1);
    expect(runState(db, spec.runId)).toBe("LEASED");

    // Worker 1 enters RUNNING
    transition(db, {
      runId: spec.runId,
      to: "RUNNING",
      expectFrom: "LEASED",
      actor: "w1",
      reason: "started",
      attempt: 1,
      now: T0,
    });

    // Lease expires while worker 1 is running slowly
    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    expect(
      reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" }),
    ).toBe(1);
    expect(runState(db, spec.runId)).toBe("QUEUED");

    // Worker 2 claims attempt 2 and starts running
    const o2 = opts({ owner: "w2", now: afterExpiry });
    const claim2 = claimNext(db, o2);
    expect(claim2.attempt).toBe(2);
    expect(claim2.fencingToken).toBeGreaterThan(claim1.fencingToken);

    // Worker 1 finishes (with failure) and attempts terminal failure write
    // Custom fake adapter that exits with non-zero code
    const failingAdapters = {
      fake: {
        execute: async () => ({ exitCode: 1, timedOut: false }),
      },
    };
    const w1Result = await executeClaimed(
      db,
      registry,
      failingAdapters,
      claim1,
      { ...o1, now: afterExpiry },
    );
    expect(w1Result.fenced).toBe(true);

    // Assert that Worker 1 did not mutate run state to FAILED
    expect(runState(db, spec.runId)).toBe("LEASED");

    // Assert journal recorded fenced_attempt
    const fencedEvents = lifecycleOf(db, spec.runId).filter(
      (e) => e.reason === "fenced_attempt",
    );
    expect(fencedEvents).toHaveLength(1);
    expect(fencedEvents[0].attempt).toBe(1);

    // Worker 2 now succeeds
    const w2Result = await executeClaimed(db, registry, adapters, claim2, o2);
    expect(w2Result.terminalState).toBe("COMPLETED");
    expect(runState(db, spec.runId)).toBe("COMPLETED");

    // Only attempt 2 has results and published outbox event
    const results = db
      .query(`SELECT * FROM results WHERE run_id = ?`)
      .all(spec.runId);
    expect(results).toHaveLength(1);
    expect(results[0].attempt).toBe(2);
  });

  test("receipt attests agent definition content hash (OPS-409)", async () => {
    const db = openDb(":memory:");
    const def = getAgent(registry, "factory-status-report@1");
    const expectedDefHash = computeDefHash(def);
    expect(expectedDefHash).toMatch(/^sha256:/);

    const spec = queueRun(db, makeSpec({ defHash: expectedDefHash }));
    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.receipt.defHash).toBe(expectedDefHash);

    const result = db
      .query(`SELECT * FROM results WHERE run_id = ?`)
      .get(spec.runId);
    const receipt = JSON.parse(result.receipt_json);
    expect(receipt.defHash).toBe(expectedDefHash);
  });

  test("mutated agent definition between approval and execution causes typed refusal (OPS-409)", async () => {
    const db = openDb(":memory:");
    // Spec carries an approved defHash that differs from current definition
    const staleDefHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const spec = queueRun(db, makeSpec({ defHash: staleDefHash }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("REFUSED");
    expect(summary.reasonCode).toBe("agent_definition_mismatch");
    expect(runState(db, spec.runId)).toBe("REFUSED");

    const result = db
      .query(`SELECT * FROM results WHERE run_id = ?`)
      .get(spec.runId);
    expect(result).toBeTruthy();
    const resultJson = JSON.parse(result.result_json);
    expect(resultJson.terminalState).toBe("refused");
    expect(resultJson.reasonCode).toBe("agent_definition_mismatch");

    const receipt = JSON.parse(result.receipt_json);
    expect(receipt.verificationStatus).toBe("passed");
    expect(receipt.defHash).toBeTruthy();

    const attempt = db
      .query(`SELECT * FROM attempts WHERE run_id = ?`)
      .get(spec.runId);
    expect(attempt.terminal_state).toBe("REFUSED");
    expect(attempt.reason_code).toBe("agent_definition_mismatch");
    expect(
      lifecycleOf(db, spec.runId)
        .slice(-2)
        .map((event) => event.reason),
    ).toEqual([
      "failure:fatal:agent_definition_mismatch",
      "failure:fatal:agent_definition_mismatch",
    ]);
  });

  test("fencing on contract violation: stale worker cannot overwrite newer attempt (OPS-413)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeSpec({ maxAttempts: 2, input: { repos: ["ok"] } }),
    );
    const o1 = opts({ owner: "w1", now: T0 });

    const claim1 = claimNext(db, o1);
    transition(db, {
      runId: spec.runId,
      to: "RUNNING",
      expectFrom: "LEASED",
      actor: "w1",
      reason: "started",
      attempt: 1,
      now: T0,
    });

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" });

    const o2 = opts({ owner: "w2", now: afterExpiry });
    const claim2 = claimNext(db, o2);

    // w1 produces invalid artifact (contract violation)
    const invalidAdapters = {
      fake: {
        execute: async ({ workspaceDir }) => {
          const { writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          writeFileSync(
            join(workspaceDir, "result.json"),
            JSON.stringify({
              schemaVersion: "factory.agent-result/v1",
              terminalState: "completed",
              artifact: { invalid: true },
            }),
          );
          return { exitCode: 0, timedOut: false };
        },
      },
    };

    const w1Result = await executeClaimed(
      db,
      registry,
      invalidAdapters,
      claim1,
      { ...o1, now: afterExpiry },
    );
    expect(w1Result.fenced).toBe(true);
    expect(runState(db, spec.runId)).toBe("LEASED");

    const w2Result = await executeClaimed(db, registry, adapters, claim2, o2);
    expect(w2Result.terminalState).toBe("COMPLETED");
    expect(runState(db, spec.runId)).toBe("COMPLETED");
  });

  test("fencing on abort: stale reaped worker abort cannot overwrite newer attempt (OPS-413)", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ maxAttempts: 2 }));
    const o1 = opts({ owner: "w1", now: T0 });

    const claim1 = claimNext(db, o1);
    transition(db, {
      runId: spec.runId,
      to: "RUNNING",
      expectFrom: "LEASED",
      actor: "w1",
      reason: "started",
      attempt: 1,
      now: T0,
    });

    const afterExpiry = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
    reapExpiredLeases(db, { now: afterExpiry, policyVersion: "test" });

    const o2 = opts({ owner: "w2", now: afterExpiry });
    const claim2 = claimNext(db, o2);

    const abortingAdapters = {
      fake: {
        execute: async ({ abortSignal }) => {
          // Trigger abort
          const { cancelRun } = await import("./worker.mjs");
          // Abort the controller directly
          return new Promise((resolve) => {
            setTimeout(() => {
              abortSignal?.dispatchEvent?.(new Event("abort"));
              resolve({ exitCode: null, timedOut: false });
            }, 10);
          });
        },
      },
    };

    // Stale execution when abort is tripped
    const abortController = new AbortController();
    abortController.abort("cancelled");
    // Stale attempt with higher token existing
    const w1Result = await executeClaimed(db, registry, adapters, claim1, {
      ...o1,
      now: afterExpiry,
    });
    expect(w1Result.fenced).toBe(true);
  });

  test("dispatchIdentityEnv omits unset identity keys and gates on the dispatch@ prefix (#1497)", () => {
    const env = {
      PATH: "/bin",
      FACTORY_CONTROL_API_TOKEN: "worker-only-token",
      FACTORY_EVENT_HOME: "/tmp/factory-events",
      FACTORY_EVENT_PORT: "7381",
    };
    const full = dispatchIdentityEnv({
      spec: { agent: "dispatch@2" },
      env,
      runId: "run-1",
      ticketId: 1497,
      repoName: "factory",
    });
    expect(full).toEqual({
      PATH: "/bin",
      FACTORY_EVENT_HOME: "/tmp/factory-events",
      FACTORY_EVENT_PORT: "7381",
      FACTORY_DISPATCH: "1",
      FACTORY_RUN_ID: "run-1",
      FACTORY_TICKET: "1497",
      FACTORY_REPO: "factory",
    });
    expect(full.FACTORY_CONTROL_API_TOKEN).toBeUndefined();

    const partial = dispatchIdentityEnv({
      spec: { agent: "dispatch@1" },
      env,
      runId: "run-2",
      ticketId: null,
      repoName: undefined,
    });
    expect(partial).toEqual({
      PATH: "/bin",
      FACTORY_EVENT_HOME: "/tmp/factory-events",
      FACTORY_EVENT_PORT: "7381",
      FACTORY_DISPATCH: "1",
      FACTORY_RUN_ID: "run-2",
    });
    expect(partial.FACTORY_CONTROL_API_TOKEN).toBeUndefined();
    expect("FACTORY_TICKET" in partial).toBe(false);
    expect("FACTORY_REPO" in partial).toBe(false);

    for (const agent of [
      "factory-status-report@1",
      "dispatcher@1",
      undefined,
    ]) {
      const untouched = dispatchIdentityEnv({
        spec: { agent },
        env,
        runId: "run-3",
        ticketId: "T-1",
        repoName: "r",
      });
      expect(untouched).toBe(env);
    }
  });

  test("handoff PR form records draft and body markers, refusing malformed markers", () => {
    const base = {
      github: "watt-mind/factory",
      prNumber: 77,
      ticket: "watt-mind/factory#1504",
      runId: "run-1504",
    };
    const valid = { ...base };
    const headSha = "a".repeat(40);
    assertHandoffPullRequestBase({
      handoff: valid,
      base: "develop",
      fetchPullRequest: () => ({
        baseRefName: "develop",
        isDraft: false,
        headRefOid: headSha,
        body: "Fixes watt-mind/factory#1504\n\nImplemented\n\nrun:run-1504",
      }),
    });
    expect(valid.pr).toEqual({
      number: 77,
      draft: false,
      headSha,
      hasFixesLine: true,
      hasRunTrailer: true,
      hasUnexpandedRunTrailer: false,
    });
    expect(
      composeHandoffVerification({
        ...valid,
        verification: null,
        repoVerify: null,
        webBuild: null,
      }),
    ).toContain("head SHA: aaaaaaaaaaaa");

    const warningOnly = { ...base };
    assertHandoffPullRequestBase({
      handoff: warningOnly,
      base: "develop",
      fetchPullRequest: () => ({
        baseRefName: "develop",
        isDraft: true,
        body: "Fixes watt-mind/factory#1504",
      }),
    });
    expect(warningOnly.pr).toMatchObject({
      draft: true,
      headSha: null,
      hasFixesLine: true,
      hasRunTrailer: false,
      hasUnexpandedRunTrailer: false,
    });
    expect(
      composeHandoffVerification({
        ...warningOnly,
        verification: null,
        repoVerify: null,
        webBuild: null,
      }),
    ).toContain("head SHA: unknown");

    const missingFixes = { ...base };
    expect(() =>
      assertHandoffPullRequestBase({
        handoff: missingFixes,
        base: "develop",
        fetchPullRequest: () => ({
          baseRefName: "develop",
          isDraft: false,
          body: "run:run-1504",
        }),
      }),
    ).toThrow(
      "handoff_pr_form_invalid: PR #77 has no Fixes line for watt-mind/factory#1504",
    );
    expect(missingFixes.pr).toMatchObject({
      hasFixesLine: false,
      hasRunTrailer: true,
      hasUnexpandedRunTrailer: false,
    });
  });

  test("verified draft handoffs are marked ready and record draft: no", () => {
    const handoff = {
      github: "watt-mind/factory",
      prNumber: 77,
      pr: { number: 77, draft: true },
      prDraft: true,
    };
    const calls = [];
    const forge = {
      prSetDraft: (...args) => calls.push(args),
    };

    expect(defaultMarkHandoffPullRequestReady({ handoff, forge })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "watt-mind/factory",
      77,
      false,
      expect.objectContaining({ timeout: expect.any(Number) }),
    ]);
    expect(handoff.pr.draft).toBe(false);
    expect(handoff.prDraft).toBe(false);
    expect(
      composeHandoffVerification({
        ...handoff,
        verification: null,
        repoVerify: null,
        webBuild: null,
      }),
    ).toContain("- PR: #77 (draft: no)");

    expect(defaultMarkHandoffPullRequestReady({ handoff, forge })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a failed ready-for-review transition is best effort: the run keeps its verified handoff, recorded draft: yes", () => {
    const handoff = {
      github: "watt-mind/factory",
      prNumber: 77,
      pr: { number: 77, draft: true },
      prDraft: true,
    };
    const forge = {
      prSetDraft: () => {
        throw new Error("GitHub rejected the transition");
      },
    };

    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Promotion happens after the run is already verified; a transient forge
      // error must never throw here, or a green run is failed and its PR is
      // re-drafted by the failure path it lands in.
      expect(defaultMarkHandoffPullRequestReady({ handoff, forge })).toBe(
        false,
      );
      expect(
        err.mock.calls.some((c) =>
          String(c[0]).includes(
            "could not mark PR #77 ready for review: GitHub rejected the transition",
          ),
        ),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
    expect(handoff.pr.draft).toBe(true);
    expect(handoff.prDraft).toBe(true);
    // The comment stays truthful about the state the PR is actually left in.
    expect(
      composeHandoffVerification({
        ...handoff,
        verification: null,
        repoVerify: null,
        webBuild: null,
      }),
    ).toContain("- PR: #77 (draft: yes)");
  });

  test("a handoff with no usable PR coordinates is left alone rather than promoted", () => {
    const forge = {
      prSetDraft: () => {
        throw new Error("prSetDraft must not be called");
      },
    };
    for (const handoff of [
      { github: "watt-mind/factory", prNumber: null, pr: { draft: true } },
      { github: null, prNumber: 77, pr: { number: 77, draft: true } },
      { github: "watt-mind/factory", prNumber: 77, pr: { draft: false } },
      { github: "watt-mind/factory", prNumber: 77 },
    ]) {
      expect(defaultMarkHandoffPullRequestReady({ handoff, forge })).toBe(
        false,
      );
    }
  });

  test("executeClaimed promotes a verified handoff PR, and never a refused one (#2005)", async () => {
    const TICKET = "watt-mind/factory#2005";
    // The gate reads the live PR; this is the form it must accept, and it is
    // what makes the handoff record say `draft: true` before promotion.
    const livePullRequest = {
      baseRefName: "develop",
      isDraft: true,
      body: `Fixes ${TICKET}`,
    };
    const handoffFixture = () => ({
      github: "watt-mind/factory",
      ticket: TICKET,
      prNumber: 77,
      verification: null,
      repoVerify: null,
      webBuild: null,
    });
    const runResult = (spec, overrides = {}) => {
      const artifact = { repos: [], recommendedAction: "wait" };
      return {
        schemaVersion: "factory.run-result/v1",
        runId: spec.runId,
        attempt: 1,
        terminalState: "completed",
        reasonCode: "ok",
        outputContract: spec.outputContract,
        artifact,
        artifactHash: hashJson(artifact),
        evidenceSetHash: null,
        verification: { status: "passed", checks: [] },
        artifacts: [],
        ...overrides,
      };
    };
    const dispatchSeams = (calls) => ({
      configSnapshot: dispatchConfigSnapshot(),
      locksDir: tmpDir("evrt-pr-ready-locks-"),
      leasesDir: tmpDir("evrt-pr-ready-leases-"),
      fetchTicket: () => ({
        identifier: TICKET,
        state: { name: "Todo" },
        assignee: null,
        labels: { nodes: [{ name: "ai:agent-ready" }] },
        description: "## Owned Paths\n- event-runtime/lib/worker.mjs\n",
      }),
      fetchInFlight: () => [],
      countLeases: () => 0,
      budgetRefusal: () => null,
      claimTicket: () => ({ ok: true }),
      unclaimTicket: () => true,
      commentTicket: (args) => (calls.comments.push(args), true),
      fetchHandoffPullRequest: () => livePullRequest,
      markHandoffPullRequestReady: ({ handoff }) => {
        calls.promoted.push(handoff);
        handoff.pr.draft = false;
        handoff.prDraft = false;
        return true;
      },
    });
    const workerOpts = (calls, verified) =>
      opts({
        artifactStore: freshRoot(),
        dispatch: dispatchSeams(calls),
        materializeWorktree: () => ({
          github: "watt-mind/factory",
          base: "develop",
        }),
        verifyResult: verified,
      });

    const acceptedDb = openDb(":memory:");
    const acceptedSpec = makeSpec({
      input: { repo: "factory", ticket: TICKET },
      workspace: { type: "worktree" },
    });
    queueRun(acceptedDb, acceptedSpec);
    const acceptedCalls = { comments: [], promoted: [] };
    const acceptedHandoff = handoffFixture();
    const accepted = await executeClaimed(
      acceptedDb,
      registry,
      adapters,
      claimNext(acceptedDb, opts()),
      workerOpts(acceptedCalls, () => ({
        kind: "completed",
        result: runResult(acceptedSpec),
        receipt: {},
        handoff: acceptedHandoff,
      })),
    );

    expect(accepted).toMatchObject({ terminalState: "COMPLETED" });
    expect(acceptedCalls.promoted).toEqual([acceptedHandoff]);
    // Promotion runs before the handoff comment is composed, so the comment
    // reports the state the PR is actually left in.
    expect(acceptedCalls.comments).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("- PR: #77 (draft: no)"),
      }),
    ]);
    acceptedDb.close();

    // A refused run must leave its PR in draft: the merge stage skips drafts,
    // which is exactly what keeps an unaccepted handoff from landing.
    const refusedDb = openDb(":memory:");
    const refusedSpec = makeSpec({
      input: { repo: "factory", ticket: TICKET },
      workspace: { type: "worktree" },
    });
    queueRun(refusedDb, refusedSpec);
    const refusedCalls = { comments: [], promoted: [] };
    const refusedHandoff = handoffFixture();
    const refused = await executeClaimed(
      refusedDb,
      registry,
      adapters,
      claimNext(refusedDb, opts()),
      workerOpts(refusedCalls, () => ({
        kind: "refused",
        reasonCode: "ticket_not_ready",
        result: runResult(refusedSpec, {
          terminalState: "refused",
          reasonCode: "ticket_not_ready",
        }),
        handoff: refusedHandoff,
      })),
    );

    expect(refused).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "ticket_not_ready",
    });
    expect(refusedCalls.promoted).toEqual([]);
    expect(refusedHandoff.pr.draft).toBe(true);
    refusedDb.close();
  });

  test("handoff PR form rejects literal run trailers when a run ID is set", () => {
    const base = {
      github: "watt-mind/factory",
      prNumber: 77,
      ticket: "watt-mind/factory#1504",
      runId: "run-1504",
    };
    for (const trailer of ["run:$FACTORY_RUN_ID", "run:${FACTORY_RUN_ID}"]) {
      const handoff = { ...base };
      expect(() =>
        assertHandoffPullRequestBase({
          handoff,
          base: "develop",
          fetchPullRequest: () => ({
            baseRefName: "develop",
            isDraft: false,
            body: `Fixes watt-mind/factory#1504\n\n${trailer}`,
          }),
        }),
      ).toThrow("run_trailer_unexpanded");
      expect(handoff.pr).toMatchObject({
        hasFixesLine: true,
        hasRunTrailer: false,
        hasUnexpandedRunTrailer: true,
      });
    }
  });

  test("handoff PR Fixes line tolerates the short #n form, case, and trailing punctuation", () => {
    const base = {
      github: "watt-mind/factory",
      prNumber: 77,
      ticket: "watt-mind/factory#1504",
      runId: "run-1504",
    };
    for (const body of [
      "Fixes #1504\n\nrun:run-1504",
      "fixes watt-mind/factory#1504.\n\nrun:run-1504",
      "  Fixes watt-mind/factory#1504  \r\nrun:run-1504",
    ]) {
      const handoff = { ...base };
      assertHandoffPullRequestBase({
        handoff,
        base: "develop",
        fetchPullRequest: () => ({
          baseRefName: "develop",
          isDraft: false,
          body,
        }),
      });
      expect(handoff.pr).toMatchObject({
        hasFixesLine: true,
        hasRunTrailer: true,
        hasUnexpandedRunTrailer: false,
      });
    }

    // The short form only counts when the PR lives in the ticket's repo, and
    // a different issue number or a mid-line mention never matches.
    for (const [github, body] of [
      ["watt-mind/other", "Fixes #1504"],
      ["watt-mind/factory", "Fixes #15040"],
      ["watt-mind/factory", "This Fixes #1504 for real"],
    ]) {
      const handoff = { ...base, github };
      expect(() =>
        assertHandoffPullRequestBase({
          handoff,
          base: "develop",
          fetchPullRequest: () => ({
            baseRefName: "develop",
            isDraft: false,
            body,
          }),
        }),
      ).toThrow("handoff_pr_form_invalid");
      expect(handoff.pr.hasFixesLine).toBe(false);
    }

    const linear = { ...base, ticket: "WM-1234" };
    assertHandoffPullRequestBase({
      handoff: linear,
      base: "develop",
      fetchPullRequest: () => ({
        baseRefName: "develop",
        isDraft: false,
        body: "Fixes WM-1234",
      }),
    });
    expect(linear.pr.hasFixesLine).toBe(true);
  });

  const assertHandoffFormThrows = (body, message) => {
    const handoff = {
      github: "watt-mind/factory",
      prNumber: 77,
      ticket: "watt-mind/factory#1504",
      runId: "run-1504",
    };
    expect(() =>
      assertHandoffPullRequestBase({
        handoff,
        base: "develop",
        fetchPullRequest: () => ({
          baseRefName: "develop",
          isDraft: false,
          body,
        }),
      }),
    ).toThrow(message);
  };

  test("handoff PR form identifies malformed Fixes-like lines", () => {
    for (const [body, offendingLine] of [
      ["Fixes: #1504\n\nrun:run-1504", "Fixes: #1504"],
      [
        "Fixes watt-mind/factory#1504 (follow-up)\n\nrun:run-1504",
        "Fixes watt-mind/factory#1504 (follow-up)",
      ],
    ]) {
      assertHandoffFormThrows(
        body,
        `handoff_pr_form_invalid: PR #77 has malformed Fixes line ${JSON.stringify(offendingLine)}`,
      );
    }
  });

  test("handoff PR form reports a well-formed Fixes line that is not first", () => {
    // The line itself is exactly right — quoting it as "malformed" against an
    // identical expectation would leave the author nothing to act on.
    assertHandoffFormThrows(
      "Implementation details\n\nFixes watt-mind/factory#1504\n\nrun:run-1504",
      'handoff_pr_form_invalid: PR #77 has "Fixes watt-mind/factory#1504" but it must be the first line of the PR body',
    );
  });

  test("handoff PR form accepts a Fixes line after leading blank lines", () => {
    const handoff = {
      github: "watt-mind/factory",
      prNumber: 77,
      ticket: "watt-mind/factory#1504",
      runId: "run-1504",
    };
    assertHandoffPullRequestBase({
      handoff,
      base: "develop",
      fetchPullRequest: () => ({
        baseRefName: "develop",
        isDraft: false,
        body: "\n  \nFixes watt-mind/factory#1504\n\nrun:run-1504",
      }),
    });
    expect(handoff.pr.hasFixesLine).toBe(true);
  });

  test("handoff PR form refuses a null body and reports unknown for a missing ticket or run id", () => {
    const base = {
      github: "watt-mind/factory",
      prNumber: 77,
      ticket: "watt-mind/factory#1504",
      runId: "run-1504",
    };
    const nullBody = { ...base };
    expect(() =>
      assertHandoffPullRequestBase({
        handoff: nullBody,
        base: "develop",
        fetchPullRequest: () => ({
          baseRefName: "develop",
          isDraft: false,
          body: null,
        }),
      }),
    ).toThrow("handoff_pr_form_invalid");
    expect(nullBody.pr).toMatchObject({
      hasFixesLine: false,
      hasRunTrailer: false,
      hasUnexpandedRunTrailer: false,
    });

    const noRunId = { ...base, runId: undefined };
    assertHandoffPullRequestBase({
      handoff: noRunId,
      base: "develop",
      fetchPullRequest: () => ({
        baseRefName: "develop",
        isDraft: false,
        body: "Fixes watt-mind/factory#1504\nrun:$FACTORY_RUN_ID",
      }),
    });
    expect(noRunId.pr).toMatchObject({
      hasFixesLine: true,
      hasRunTrailer: null,
      hasUnexpandedRunTrailer: null,
    });

    const noTicket = { ...base, ticket: null, runId: undefined };
    assertHandoffPullRequestBase({
      handoff: noTicket,
      base: "develop",
      fetchPullRequest: () => ({
        baseRefName: "develop",
        isDraft: false,
        body: "Fixes null\nrun:undefined",
      }),
    });
    expect(noTicket.pr).toMatchObject({
      hasFixesLine: null,
      hasRunTrailer: null,
      hasUnexpandedRunTrailer: null,
    });
    expect(composeHandoffVerification(noTicket)).toContain(
      "Fixes: unknown · run trailer: unknown",
    );
  });

  test("worker preserves push credentials for mutating runs and strips them for non-mutating runs (WM-128)", async () => {
    const db = openDb(":memory:");
    let capturedMutatingEnv = null;
    let capturedReadOnlyEnv = null;

    const spyAdapter = {
      execute: async ({ spec, def, env, workspaceDir }) => {
        const { safeChildEnvironment } = await import("./adapters/claude.mjs");
        const effectiveEnv = safeChildEnvironment(env, def);
        if (def.mutating) {
          capturedMutatingEnv = effectiveEnv;
        } else {
          capturedReadOnlyEnv = effectiveEnv;
        }
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const isMutating = Boolean(def.mutating);
        const artifact = isMutating
          ? {
              outcome: "PR_OPEN",
              repo: "bj29",
              ticket: "WM-128",
              prUrl: "https://github.com/watt-mind/factory/pull/1",
              verification: {
                command: "bun test",
                passed: true,
                output: "ok",
              },
              summary: "Implemented",
            }
          : {
              repos: [
                {
                  name: "ok",
                  triage: 0,
                  agentReady: 0,
                  inProgress: 0,
                  blocked: 0,
                },
              ],
              recommendedAction: "wait",
            };
        writeFileSync(
          join(workspaceDir, "result.json"),
          JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            artifact,
          }),
        );
        return { exitCode: 0, timedOut: false };
      },
    };

    const customAdapters = { spy: spyAdapter };

    // 1. Mutating run (dispatch@1 has mutating: true)
    const mutatingSpec = queueRun(
      db,
      makeSpec({
        agent: "dispatch@1",
        input: { repo: "bj29", ticket: "WM-128" },
        outputContract: "factory.dispatch-result/v1",
        adapter: "spy",
      }),
    );
    const mutatingResult = await runOnce(
      db,
      registry,
      customAdapters,
      opts({
        env: {
          SSH_AUTH_SOCK: "/tmp/worker-dispatch.sock",
          GITHUB_TOKEN: "ghp_worker_dispatch_token",
          ANTHROPIC_API_KEY: "sk-worker-must-strip",
        },
      }),
    );
    expect(mutatingResult.terminalState).toBe("COMPLETED");
    expect(capturedMutatingEnv).not.toBeNull();
    expect(capturedMutatingEnv.SSH_AUTH_SOCK).toBe("/tmp/worker-dispatch.sock");
    expect(capturedMutatingEnv.GITHUB_TOKEN).toBe("ghp_worker_dispatch_token");
    expect(capturedMutatingEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedMutatingEnv.FACTORY_RUN_ID).toBe(mutatingSpec.runId);
    expect(capturedMutatingEnv.FACTORY_TICKET).toBe("WM-128");
    expect(capturedMutatingEnv.FACTORY_REPO).toBe("bj29");

    // 2. Non-mutating run (factory-status-report@1 has mutating: false)
    const readOnlySpec = queueRun(
      db,
      makeSpec({
        agent: "factory-status-report@1",
        input: { repos: ["ok"] },
        outputContract: "factory.status-report/v1",
        adapter: "spy",
      }),
    );
    const readOnlyResult = await runOnce(
      db,
      registry,
      customAdapters,
      opts({
        env: {
          SSH_AUTH_SOCK: "/tmp/worker-readonly.sock",
          GITHUB_TOKEN: "ghp_worker_readonly_token",
          ANTHROPIC_API_KEY: "sk-worker-must-strip",
        },
      }),
    );
    expect(readOnlyResult.terminalState).toBe("COMPLETED");
    expect(capturedReadOnlyEnv).not.toBeNull();
    expect(capturedReadOnlyEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(capturedReadOnlyEnv.GITHUB_TOKEN).toBeUndefined();
    expect(capturedReadOnlyEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  describe("defaultReconcileVerifiedHandoffTicket (#1498)", () => {
    const STATE_ARGS = [
      "state",
      "WM-1498",
      "In Review",
      "--add",
      "ai:needs-review",
      "--remove",
      "ai:in-progress",
      "--remove",
      "ai:agent-ready",
    ];

    test("moves a Todo handoff to In Review and fixes its dispatch labels", () => {
      const calls = [];
      const result = defaultReconcileVerifiedHandoffTicket({
        repo: "factory",
        ticket: "WM-1498",
        fetchTicket: () => ({ state: { name: "Todo" } }),
        runCli: (args, options) => (calls.push({ args, options }), ""),
      });

      expect(result).toBe(true);
      expect(calls).toEqual([
        { args: STATE_ARGS, options: { repo: "factory" } },
      ]);
    });

    test("does not mutate a ticket the agent already put In Review", () => {
      const calls = [];
      const result = defaultReconcileVerifiedHandoffTicket({
        repo: "factory",
        ticket: "WM-1498",
        fetchTicket: () => ({ state: { name: "In Review" } }),
        runCli: (args) => (calls.push(args), ""),
      });

      expect(result).toBe(false);
      expect(calls).toHaveLength(0);
    });

    test("moves an In Progress handoff to In Review", () => {
      const calls = [];
      const result = defaultReconcileVerifiedHandoffTicket({
        repo: "factory",
        ticket: "WM-1498",
        fetchTicket: () => ({ state: { name: "In Progress" } }),
        runCli: (args, options) => (calls.push({ args, options }), ""),
      });

      expect(result).toBe(true);
      expect(calls).toEqual([
        { args: STATE_ARGS, options: { repo: "factory" } },
      ]);
    });

    for (const state of ["Blocked", "Done", "Canceled"]) {
      test(`leaves a ticket a human moved to ${state} mid-run untouched`, () => {
        const calls = [];
        const result = defaultReconcileVerifiedHandoffTicket({
          repo: "factory",
          ticket: "WM-1498",
          fetchTicket: () => ({ state: { name: state } }),
          runCli: (args) => (calls.push(args), ""),
        });

        expect(result).toBe(false);
        expect(calls).toHaveLength(0);
      });
    }

    test("a false mayMutateClaimedTicket guard makes no reconciliation calls", () => {
      const calls = [];
      const result = defaultReconcileVerifiedHandoffTicket({
        repo: "factory",
        ticket: "WM-1498",
        mayMutate: () => false,
        fetchTicket: () => {
          calls.push("fetch");
          return { state: { name: "Todo" } };
        },
        runCli: (args) => (calls.push(args), ""),
      });

      expect(result).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("registry reload worker outcomes", () => {
  test("a queued run whose agent was removed refuses with a typed outcome", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());
    const agents = new Map(registry.agents);
    agents.delete(spec.agent);
    const summary = await runOnce(
      db,
      { ...registry, agents },
      adapters,
      opts(),
    );

    expect(summary).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "agent_unregistered_after_reload",
    });
    expect(runState(db, spec.runId)).toBe("REFUSED");
    expect(
      lifecycleOf(db, spec.runId)
        .slice(-2)
        .map((event) => event.reason),
    ).toEqual([
      "failure:fatal:agent_unregistered_after_reload",
      "failure:fatal:agent_unregistered_after_reload",
    ]);
  });
});

describe("defaultFindWorkspacePullRequest", () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv,
    });

  function seedWorkspace(branch) {
    const workspacePath = tmpDir("evrt-find-pr-workspace-");
    git(workspacePath, "init", "-q", "-b", "main");
    writeFileSync(path.join(workspacePath, "seed.txt"), "seed\n");
    git(workspacePath, "add", "seed.txt");
    git(workspacePath, "commit", "-q", "-m", "seed");
    git(workspacePath, "checkout", "-q", "-b", branch);
    return workspacePath;
  }

  test("reports a branch that exists at origin as pushed", () => {
    const branch = "feat/gh-1870-pushed";
    const workspacePath = seedWorkspace(branch);
    const origin = tmpDir("evrt-find-pr-origin-");
    git(origin, "init", "-q", "--bare");
    git(workspacePath, "remote", "add", "origin", origin);
    git(workspacePath, "push", "-q", "origin", branch);

    const found = defaultFindWorkspacePullRequest({
      workspacePath,
      forge: { prList: () => [] },
    });
    expect(found).toEqual({ pushedBranch: branch });
  });

  test("treats a failing ls-remote as no pushed branch (WM-1870 review)", () => {
    const workspacePath = seedWorkspace("feat/gh-1870-unreachable");
    // Unreachable origin: ls-remote exits non-zero. The finder must swallow
    // the failure (bounded, SIGKILL on timeout) instead of throwing out of
    // missing-result recovery.
    git(
      workspacePath,
      "remote",
      "add",
      "origin",
      path.join(workspacePath, "no-such-origin"),
    );
    expect(
      defaultFindWorkspacePullRequest({
        workspacePath,
        forge: { prList: () => [] },
      }),
    ).toBeNull();
  });
});
