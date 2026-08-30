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
import { insideHandoffSandbox } from "./verify.mjs";
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
import { getAgent, loadRegistry } from "./registry.mjs";
import { transcriptSessionId } from "./transcripts.mjs";
import {
  acquireClaimLock,
  adapterExecuteTimeoutMs,
  cancelRun,
  CLAIM_LOCK_BACKOFF_MAX_MS,
  claimNext,
  claimedRetryFor,
  CODE_RELOAD_EXIT,
  codeStamp,
  codeStampFiles,
  codeStampRoot,
  createReloadWatcher,
  DEFAULT_MAX_ENVIRONMENT_RETRIES,
  defaultLocksDir,
  defaultProjectTierEscalation,
  defaultReturnHandoffTicket,
  defaultUnclaimTicket,
  dispatchLockPath,
  DYNAMIC_DEADLINE_ADAPTERS,
  executeClaimed,
  classifyFailureCause,
  expireRunDeadline,
  extendRunDeadline,
  forceFailRun,
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
  resolveLinearApiKey,
  reconcileTierEscalations,
  scheduleTierEscalation,
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

registerTestProcessCleanup(import.meta.url);

const registry = loadRegistry();
const adapters = { fake };
const T0 = Date.parse("2026-08-12T10:00:00Z");

let seq = 0;
function makeSpec(overrides = {}) {
  const runId =
    overrides.runId ??
    `run_worker_${++seq}_${Math.random().toString(36).slice(2)}`;
  const input = overrides.input ?? { repos: ["ok"] };
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: true },
    adapter: "fake",
    promptVersion: "git:test",
    policyVersion: "git:test",
    outputContract: "factory.status-report/v1",
    capabilities: ["tracker:read"],
    timeoutSeconds: 5,
    maxAttempts: 1,
    idempotencyKey: `idem-${runId}`,
    ...overrides,
  };
}

function queueRun(db, spec, now = T0) {
  createRun(db, {
    runId: spec.runId,
    idempotencyKey: spec.idempotencyKey,
    spec,
    specJson: canonicalJson(spec),
    specHash: hashJson(spec),
    actor: "test",
    policyVersion: "test",
    now,
  });
  transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now });
  transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now });
  return spec;
}

/** Link the run to an admitted event via a proposal, like the planner would. */
function linkEvent(
  db,
  runId,
  {
    type = "factory.status-report.requested",
    correlationId = "corr-1",
    source = "test",
  } = {},
) {
  const at = new Date(T0).toISOString();
  db.query(
    `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    source,
    `evt-${runId}`,
    type,
    "factory",
    at,
    at,
    correlationId,
    null,
    "{}",
    "sha256:x",
    at,
  );
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, 'RUN_SPEC', ?, 1800)`,
  ).run(`prop-${runId}`, source, `evt-${runId}`, runId, at);
}

function freshRoot() {
  return tmpDir("evrt-worker-");
}

/**
 * A checkout root with no config/ at all, so every policy read from these
 * tests normalizes to its fail-closed default.
 *
 * `bin/worktree-up.sh` copies the operator's real config/policy.yaml into every
 * worktree, and the handoff verify gate runs the suite from the worktree root —
 * so an operator stanza (`sandbox.workspace_only_fallback`) silently decided
 * what `runOnce` did here, and the same commit passed in a clean checkout and
 * failed in a provisioned worktree (#1285).
 */
const EMPTY_POLICY_ROOT = tmpDir("evrt-worker-empty-policy-");

function opts(extra = {}) {
  return {
    owner: "w1",
    workspacesRoot: freshRoot(),
    now: T0,
    policyVersion: "test",
    policyRoot: EMPTY_POLICY_ROOT,
    ...extra,
  };
}

function insertStalledWorker(db, workerId, runId, now) {
  const staleAt = now - 90_001;
  db.query(
    `INSERT INTO workers (worker_id, host, pid, labels_json, adapters, started_at, last_seen, state, current_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workerId,
    "test-host",
    1,
    "{}",
    "fake",
    new Date(now).toISOString(),
    new Date(staleAt).toISOString(),
    "busy",
    runId,
  );
}

describe("worker", () => {
  test("materialized harness entries record hashes for every copied file", () => {
    const factoryRoot = tmpDir("evrt-harness-source-");
    const workspaceDir = tmpDir("evrt-harness-workspace-");
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

  test("provisions present instance configs into an ignored checkout and skips absent files", () => {
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
        provisionInstanceLocalConfigs({ factoryRoot, checkoutPath: checkout }),
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

  test("does not materialize a stale operator schedule overlay, so a worktree stays verifiable after client schedules leave the kernel (#1051)", () => {
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
        provisionInstanceLocalConfigs({ factoryRoot, checkoutPath: checkout }),
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

  test("silently skips instance config provisioning when no local files exist", () => {
    const factoryRoot = tmpDir("evrt-instance-config-empty-source-");
    const checkout = tmpDir("evrt-instance-config-empty-checkout-");
    try {
      expect(
        provisionInstanceLocalConfigs({ factoryRoot, checkoutPath: checkout }),
      ).toEqual([]);
    } finally {
      rmSync(factoryRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("provisions instance config into a client checkout but makes it un-stageable", () => {
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
        provisionInstanceLocalConfigs({ factoryRoot, checkoutPath: checkout }),
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

  test("does not hang or copy instance config when a git ignore probe times out", () => {
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
    exit 1
    ;;
esac
exec sleep 1
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS = "25";

      const started = Date.now();
      expect(
        provisionInstanceLocalConfigs({ factoryRoot, checkoutPath: checkout }),
      ).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1_000);
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
        expect(item.title).toBe(authored.question);
        expect(JSON.parse(item.decision_json)).toEqual(authored);
        expect(item.body).toBeNull();
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

  test("no-result: FAILED/contract_violation", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["no-result"] } }));

    const summary = await runOnce(db, registry, adapters, opts());
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("contract_violation");
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

  test("a missing declared input artifact is fatal and never reaches the adapter", async () => {
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
        workspace: {
          type: "artifacts",
          inputs: [{ from: missingSha, as: "input.json" }],
        },
        maxEnvironmentRetries: 5,
      }),
    );

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
});

describe("execute-side dispatch hardening (WM-115)", () => {
  let factoryRoot;
  let repoDir;
  let wtRoot;
  let callsLog;
  let previousReposRoot;

  beforeAll(() => {
    factoryRoot = tmpDir("evrt-worker-hard-factory-");
    repoDir = tmpDir("evrt-worker-hard-repo-");
    wtRoot = tmpDir("evrt-worker-hard-trees-");
    callsLog = path.join(repoDir, "calls.log");

    mkdirSync(path.join(repoDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up.sh"),
      `#!/bin/bash\nset -e\necho "up $1" >> "${callsLog}"\nmkdir -p "${wtRoot}/$1"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down.sh"),
      `#!/bin/bash\nset -e\necho "down $1" >> "${callsLog}"\nrm -rf "${wtRoot}/$1"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-red-baseline.sh"),
      `#!/bin/bash\nset -e\necho "up-red $1" >> "${callsLog}"\nmkdir -p "${wtRoot}/$1"\nprintf '%s\\n' '{"status":"red","check":"web_build","command":"bun run build:fast","exitCode":1,"output":"entry chunk exceeds budget"}' > "$FACTORY_WORKTREE_REPORT"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-broken.sh"),
      `#!/bin/bash\necho "dependency install failed" >&2\nexit 12\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-link-collision.sh"),
      `#!/bin/bash\nset -e\nmkdir -p "${wtRoot}/$1"\nmkdir -p "$(dirname "$FACTORY_WORKTREE_REPORT")/repo"\n`,
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up-startup-crash.sh"),
      `#!/bin/bash\n` +
        `mkdir -p "${wtRoot}/$1/.factory/run"\n` +
        `echo "RegistryError: event type test: model_tier strong has no mapping" > "${wtRoot}/$1/.factory/run/serve.log"\n` +
        `echo "warn: event runtime log (${wtRoot}/$1/.factory/run/serve.log):" >&2\n` +
        `cat "${wtRoot}/$1/.factory/run/serve.log" >&2\n` +
        `echo "error: event runtime died during startup on 7400 — see ${wtRoot}/$1/.factory/run/serve.log" >&2\n` +
        `exit 1\n`,
    );

    mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
    writeFileSync(path.join(factoryRoot, "config", "policy.yaml"), "{}\n");
    writeFileSync(
      path.join(factoryRoot, "config", "repos.yaml"),
      `repos:\n` +
        `  - name: wt-worker\n    path: ${repoDir}\n    github: watt-mind/wt-worker\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo repo_verified\n    escalate_paths: []\n` +
        `  - name: wt-failing-verify\n    path: ${repoDir}\n    github: watt-mind/wt-failing-verify\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: exit 42\n    escalate_paths: []\n` +
        `  - name: wt-baseline-red\n    path: ${repoDir}\n    github: watt-mind/wt-baseline-red\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up-red-baseline.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: printf 'entry chunk exceeds budget\\n' >&2; exit 9\n    escalate_paths: []\n` +
        `  - name: wm-baseline-real\n    path: ${repoDir}\n    github: watt-mind/wm-baseline-real\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo repo_verified\n    escalate_paths: []\n` +
        `  - name: wt-broken-up\n    path: ${repoDir}\n    github: watt-mind/wt-broken-up\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up-broken.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo never\n    escalate_paths: []\n` +
        `  - name: wt-startup-crash\n    path: ${repoDir}\n    github: watt-mind/wt-startup-crash\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up-startup-crash.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo never\n    escalate_paths: []\n` +
        `  - name: wt-link-collision\n    path: ${repoDir}\n    github: watt-mind/wt-link-collision\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up-link-collision.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo never\n    escalate_paths: []\n`,
    );
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = factoryRoot;
  });

  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });

  function makeDispatchSpec(overrides = {}) {
    const runId =
      overrides.runId ??
      `run_dispatch_${++seq}_${Math.random().toString(36).slice(2)}`;
    const input = overrides.input ?? { repo: "wt-worker", ticket: "WM-701" };
    return {
      schemaVersion: "factory.run-spec/v1",
      runId,
      agent: "dispatch@1",
      input,
      inputHash: hashJson(input),
      workspace: {
        type: "worktree",
        checkoutDir: "repo",
        retainOnFailure: true,
      },
      adapter: "fake",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.dispatch-result/v1",
      capabilities: ["tracker:write", "repo:write", "github:write"],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: `idem-${runId}`,
      ...overrides,
    };
  }

  function makeMergeFixSpec(overrides = {}) {
    const runId =
      overrides.runId ??
      `run_merge_fix_${++seq}_${Math.random().toString(36).slice(2)}`;
    const input = overrides.input ?? {
      repo: "wt-worker",
      github: "watt-mind/wt-worker",
      base: "develop",
      pr: 42,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      headRef: "feat/WM-720",
      ticket: "WM-720",
      finding: "mechanical correction",
      findingHash: "c".repeat(64),
      round: 1,
      mechanical: true,
      withinOwnedPaths: true,
      ownedPaths: ["src/feature/fix.mjs"],
    };
    return {
      schemaVersion: "factory.run-spec/v1",
      runId,
      agent: "merge-fix@1",
      input,
      inputHash: hashJson(input),
      workspace: {
        type: "worktree",
        checkoutDir: "repo",
        retainOnFailure: true,
      },
      adapter: "merge-fake",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.merge-fix-result/v1",
      capabilities: ["tracker:write", "repo:write", "github:write"],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: `idem-${runId}`,
      ...overrides,
    };
  }

  const mergeFixFakeAdapter = {
    async execute({ spec, workspaceDir }) {
      writeFileSync(
        path.join(workspaceDir, ".transcript.json"),
        `{"fake":"merge-fix transcript"}\n`,
        "utf8",
      );
      writeFileSync(
        path.join(workspaceDir, "result.json"),
        `${JSON.stringify(
          {
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: {
              outcome: "UPDATED",
              repo: spec.input.repo,
              ticket: spec.input.ticket,
              pr: spec.input.pr,
              headSha: spec.input.headSha,
              round: spec.input.round,
              summary: "applied mechanical correction",
            },
            evidence: { commands: ["echo repo_verified"] },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { exitCode: 0, timedOut: false };
    },
  };

  const readyDispatchTicket = (identifier, overrides = {}) => ({
    identifier,
    state: { name: "Todo" },
    assignee: null,
    labels: { nodes: [{ name: "ai:agent-ready" }] },
    description: "## Owned Paths\n- src/feature/**\n",
    ...overrides,
  });

  const planTimeDispatchEvidence = (
    description = "## Owned Paths\n- src/feature/**\n",
  ) => ({
    source: "chain",
    mode: "auto",
    eventType: "factory.dispatch.requested",
    dispatchEvidence: {
      ticket: {
        descriptionHash: hashJson(description),
        ownedPathsParsed: true,
      },
    },
  });

  const dispatchFakeAdapter = {
    async execute({ spec, workspaceDir }) {
      writeFileSync(
        path.join(workspaceDir, ".transcript.json"),
        `{"fake":"dispatch transcript"}\n`,
        "utf8",
      );
      const repoPath = path.join(workspaceDir, "repo");
      if (existsSync(repoPath)) {
        writeFileSync(
          path.join(repoPath, "mutated.txt"),
          "some dirty edit\n",
          "utf8",
        );
      }
      writeFileSync(
        path.join(workspaceDir, "result.json"),
        `${JSON.stringify(
          {
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: {
              outcome: "PR_OPEN",
              repo: spec.input.repo,
              ticket: spec.input.ticket,
              prUrl: `https://github.com/watt-mind/${spec.input.repo}/pull/10`,
              verification: {
                command: "echo repo_verified",
                passed: true,
                output: "repo_verified",
              },
              summary: `implemented ${spec.input.ticket}`,
            },
            evidence: { commands: ["echo repo_verified"] },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { exitCode: 0, timedOut: false };
    },
  };

  test("tier escalation transfers a failed dispatch checkout and claim to one strong continuation", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(
      db,
      makeDispatchSpec({
        runId: "run_dispatch_light_failure",
        input: {
          repo: "wt-worker",
          ticket: "WM-845",
          modelTier: "light",
        },
        modelTier: "light",
        model: null,
        maxAttempts: 1,
      }),
    );
    linkEvent(db, spec.runId, {
      type: "factory.dispatch.requested",
      correlationId: "dispatch-tier-root",
    });
    const unclaims = [];
    const projections = [];
    const summary = await runOnce(
      db,
      registry,
      {
        fake: {
          async execute({ workspaceDir }) {
            writeFileSync(
              path.join(workspaceDir, "repo", "useful-change.txt"),
              "keep this exact checkout\n",
            );
            return { exitCode: 1, timedOut: false };
          },
        },
      },
      opts({
        dispatch: {
          locksDir: tmpDir("tier-escalation-locks-"),
          leasesDir: tmpDir("tier-escalation-leases-"),
          fetchTicket: () =>
            readyDispatchTicket("WM-845", {
              labels: {
                nodes: [{ name: "ai:agent-ready" }, { name: "tier:light" }],
              },
            }),
          fetchViewer: () => ({ id: "factory" }),
          fetchInFlight: () => [],
          countLeases: () => 0,
          budgetRefusal: () => null,
          claimTicket: () => ({ ok: true }),
          unclaimTicket: (entry) => (unclaims.push(entry), true),
          projectTierEscalation: (entry) => (projections.push(entry), true),
        },
      }),
    );

    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "agent_exit_1",
      escalationProjection: { ok: true },
    });
    expect(summary.escalatedRunId).toMatch(/^run_/);
    expect(unclaims).toHaveLength(0);
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      failedRunId: spec.runId,
      continuationRunId: summary.escalatedRunId,
    });
    expect(runState(db, summary.escalatedRunId)).toBe("QUEUED");
    const strongSpec = JSON.parse(
      db
        .query(`SELECT spec_json FROM runs WHERE run_id = ?`)
        .get(summary.escalatedRunId).spec_json,
    );
    expect(strongSpec).toMatchObject({
      rootRunId: spec.runId,
      escalatedFromRunId: spec.runId,
      modelTier: "strong",
    });
    expect(
      readFileSync(path.join(wtRoot, "WM-845", "useful-change.txt"), "utf8"),
    ).toBe("keep this exact checkout\n");
    expect(
      readFileSync(callsLog, "utf8")
        .trim()
        .split("\n")
        .filter((call) => call === "up WM-845"),
    ).toHaveLength(1);
  });

  test("tier escalation refuses a foreign claim with diagnostic evidence and terminal projection", async () => {
    const db = openDb(":memory:");
    const failed = queueRun(
      db,
      makeDispatchSpec({
        runId: "run_foreign_claim_light",
        input: {
          repo: "wt-worker",
          ticket: "WM-1290",
          modelTier: "light",
        },
        modelTier: "light",
        model: null,
        maxAttempts: 1,
      }),
    );
    linkEvent(db, failed.runId, {
      type: "factory.dispatch.requested",
      correlationId: "foreign-claim-tier-root",
    });
    let ticket = readyDispatchTicket("WM-1290", {
      labels: {
        nodes: [{ name: "ai:agent-ready" }, { name: "tier:light" }],
      },
    });
    const dispatchOpts = {
      locksDir: tmpDir("tier-foreign-locks-"),
      leasesDir: tmpDir("tier-foreign-leases-"),
      fetchTicket: () => ticket,
      fetchViewer: () => ({ id: "factory-owner", name: "Factory" }),
      fetchInFlight: () => [],
      countLeases: () => 0,
      budgetRefusal: () => null,
      claimTicket: () => ({ ok: true }),
      unclaimTicket: () => true,
      projectTierEscalation: () => true,
    };
    const failure = await runOnce(
      db,
      registry,
      {
        fake: {
          async execute() {
            return { exitCode: 1, timedOut: false };
          },
        },
      },
      opts({ dispatch: dispatchOpts }),
    );
    expect(failure).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "agent_exit_1",
    });
    expect(runState(db, failure.escalatedRunId)).toBe("QUEUED");

    ticket = readyDispatchTicket("WM-1290", {
      state: { name: "In Progress" },
      assignee: { id: "another-owner", name: "Other" },
      labels: {
        nodes: [{ name: "ai:in-progress" }, { name: "tier:strong" }],
      },
    });
    const refused = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({ dispatch: dispatchOpts }),
    );
    expect(refused).toMatchObject({
      runId: failure.escalatedRunId,
      terminalState: "REFUSED",
      reasonCode: "ticket_claimed_by_other",
    });
    expect(
      db
        .query(
          `SELECT projection_state AS projectionState, projection_error AS projectionError
             FROM tier_escalations WHERE continuation_run_id = ?`,
        )
        .get(failure.escalatedRunId),
    ).toEqual({
      projectionState: "refused",
      projectionError: "ticket_claimed_by_other",
    });
    const receipt = JSON.parse(
      db
        .query(
          `SELECT receipt_json FROM results WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
        )
        .get(failure.escalatedRunId).receipt_json,
    );
    expect(receipt.dispatchGateEvidence.checks).toMatchObject({
      ticket_escalation_model_tier_strong: true,
      ticket_escalation_projection_applied: true,
      ticket_claim_viewer_identity: false,
    });
    db.close();
  });

  test("tier escalation continuation is deferred, not refused, while its projection is pending (#1290)", async () => {
    const db = openDb(":memory:");
    const failed = queueRun(
      db,
      makeDispatchSpec({
        runId: "run_pending_projection_light",
        input: {
          repo: "wt-worker",
          ticket: "WM-1290",
          modelTier: "light",
        },
        modelTier: "light",
        model: null,
        maxAttempts: 1,
      }),
    );
    linkEvent(db, failed.runId, {
      type: "factory.dispatch.requested",
      correlationId: "pending-projection-tier-root",
    });
    let now = T0;
    let projectionWorks = false;
    const dispatchOpts = {
      locksDir: tmpDir("tier-pending-locks-"),
      leasesDir: tmpDir("tier-pending-leases-"),
      random: () => 0,
      fetchTicket: () =>
        readyDispatchTicket("WM-1290", {
          labels: {
            nodes: [{ name: "ai:agent-ready" }, { name: "tier:light" }],
          },
        }),
      fetchViewer: () => ({ id: "factory-owner", name: "Factory" }),
      fetchInFlight: () => [],
      countLeases: () => 0,
      budgetRefusal: () => null,
      claimTicket: () => ({ ok: true }),
      unclaimTicket: () => true,
      projectTierEscalation: () => projectionWorks,
      onTierEscalationProjectionError: () => {},
    };
    const o = opts({
      now: () => now,
      onTierEscalationProjectionError: () => {},
      dispatch: dispatchOpts,
    });
    const failure = await runOnce(
      db,
      registry,
      {
        fake: {
          async execute() {
            return { exitCode: 1, timedOut: false };
          },
        },
      },
      o,
    );
    expect(failure).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "agent_exit_1",
    });
    const continuationRunId = failure.escalatedRunId;
    const projectionState = () =>
      db
        .query(
          `SELECT projection_state AS projectionState
             FROM tier_escalations WHERE continuation_run_id = ?`,
        )
        .get(continuationRunId).projectionState;
    expect(projectionState()).toBe("pending");
    expect(runState(db, continuationRunId)).toBe("APPROVED");

    // A continuation admitted to the queue before its projection landed must
    // not reach the eligibility gate: the planner would refuse it terminally.
    transition(db, {
      runId: continuationRunId,
      to: "QUEUED",
      expectFrom: "APPROVED",
      actor: "test",
      reason: "queued_before_projection",
      now,
    });
    const deferred = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(deferred).toMatchObject({
      runId: continuationRunId,
      terminalState: "QUEUED",
      reasonCode: "tier_escalation_projection_pending",
    });
    expect(deferred.requeueAfterMs).toBeGreaterThan(0);
    expect(runState(db, continuationRunId)).toBe("QUEUED");
    expect(projectionState()).toBe("pending");
    expect(claimNext(db, o)).toBeNull();

    // Once the projection is applied the same continuation proceeds as before.
    projectionWorks = true;
    now += deferred.requeueAfterMs;
    const completed = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(completed).toMatchObject({
      runId: continuationRunId,
      terminalState: "COMPLETED",
      reasonCode: "ok",
    });
    expect(projectionState()).toBe("applied");
    db.close();
  });

  test("only a durable escalation handoff authorises the operator bypass at execute time (GH-845)", async () => {
    // Regression: an inherited spec field must never be an authorisation.
    // approvalPolicy — dispatchEvidence included — is copied onto chain runs
    // by stableChainApprovalPolicyForHash, so a chain descended from one
    // operator dispatch would otherwise carry a permanent security bypass.
    const laundered = openDb(":memory:");
    const chainSpec = queueRun(
      laundered,
      makeDispatchSpec({
        runId: "run_chain_launders_operator",
        input: { repo: "wt-worker", ticket: "WM-847" },
        approvalPolicy: {
          source: "chain",
          mode: "auto",
          eventType: "factory.dispatch.requested",
          escalation: {
            rootRunId: "run_some_other_root",
            failedRunId: "run_some_other_root",
            operatorAuthorized: true,
          },
          dispatchEvidence: { checks: { operator_authorized: true } },
        },
      }),
    );
    linkEvent(laundered, chainSpec.runId, {
      type: "factory.dispatch.requested",
      source: "chain",
    });
    const launderedSummary = await runOnce(
      laundered,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: tmpDir("evrt-gh845-chain-locks-"),
          leasesDir: tmpDir("evrt-gh845-chain-leases-"),
          fetchTicket: () =>
            readyDispatchTicket("WM-847", {
              labels: {
                nodes: [{ name: "ai:agent-ready" }, { name: "type:security" }],
              },
            }),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );
    expect(launderedSummary).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "ticket_security",
    });
    laundered.close();

    // The same bypass IS granted to a continuation the durable
    // tier_escalations row authenticates, when the failed run it continues
    // was operator-sourced.
    const db = openDb(":memory:");
    const failed = queueRun(
      db,
      makeDispatchSpec({
        runId: "run_operator_security_light",
        input: { repo: "wt-worker", ticket: "WM-848", modelTier: "light" },
        modelTier: "light",
        model: null,
        maxAttempts: 1,
      }),
    );
    linkEvent(db, failed.runId, {
      type: "factory.dispatch.requested",
      source: "operator",
    });
    let ticket = readyDispatchTicket("WM-848", {
      labels: {
        nodes: [{ name: "ai:agent-ready" }, { name: "type:security" }],
      },
    });
    const dispatchOpts = {
      locksDir: tmpDir("evrt-gh845-escalation-locks-"),
      leasesDir: tmpDir("evrt-gh845-escalation-leases-"),
      fetchTicket: () => ticket,
      fetchViewer: () => ({ id: "factory" }),
      fetchInFlight: () => [],
      countLeases: () => 0,
      budgetRefusal: () => null,
      claimTicket: () => ({ ok: true }),
      unclaimTicket: () => true,
      projectTierEscalation: () => true,
    };
    const failure = await runOnce(
      db,
      registry,
      {
        fake: {
          async execute() {
            return { exitCode: 1, timedOut: false };
          },
        },
      },
      opts({ dispatch: dispatchOpts }),
    );
    expect(failure).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "agent_exit_1",
    });
    expect(runState(db, failure.escalatedRunId)).toBe("QUEUED");

    // The continuation resumes the factory's own claim: assigned, In
    // Progress, and still carrying the security label that only an operator
    // dispatch may pass.
    ticket = readyDispatchTicket("WM-848", {
      state: { name: "In Progress" },
      assignee: { id: "factory" },
      labels: {
        nodes: [{ name: "ai:in-progress" }, { name: "type:security" }],
      },
    });
    const continued = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({ dispatch: dispatchOpts }),
    );
    expect(continued.runId).toBe(failure.escalatedRunId);
    expect(continued.reasonCode).not.toBe("ticket_security");
    expect(continued.terminalState).toBe("COMPLETED");
    db.close();
  });

  test("resolves Linear credentials from env first, then the shared env file", () => {
    const dir = tmpDir("evrt-linear-key-");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "OTHER=value\nLINEAR_API_KEY='file-key'\n", "utf8");

    const fromEnv = { LINEAR_API_KEY: "process-key" };
    expect(resolveLinearApiKey({ env: fromEnv, envFile })).toBe("process-key");

    const fromFile = {};
    expect(resolveLinearApiKey({ env: fromFile, envFile })).toBe("file-key");
    expect(fromFile.LINEAR_API_KEY).toBe("file-key");
  });

  test("missing process credentials never activate the dispatch stub implicitly (WM-533)", async () => {
    const previousHome = process.env.FACTORY_EVENT_HOME;
    const previousKey = process.env.LINEAR_API_KEY;
    const previousStub = process.env.FACTORY_DISPATCH_STUB;
    process.env.FACTORY_EVENT_HOME = tmpDir("evrt-linear-unconfigured-");
    delete process.env.LINEAR_API_KEY;
    delete process.env.FACTORY_DISPATCH_STUB;

    try {
      const db = openDb(":memory:");
      const spec = queueRun(
        db,
        makeDispatchSpec({ adapter: "pi", maxEnvironmentRetries: 1 }),
      );
      const runOpts = opts({ resolveLinearKey: () => null });
      const first = await runOnce(
        db,
        registry,
        { pi: dispatchFakeAdapter },
        runOpts,
      );

      expect(first).toMatchObject({
        terminalState: "FAILED",
        reasonCode: "linear_unconfigured",
      });
      expect(runState(db, spec.runId)).toBe("QUEUED");

      const exhausted = await runOnce(
        db,
        registry,
        { pi: dispatchFakeAdapter },
        runOpts,
      );
      expect(exhausted).toMatchObject({
        terminalState: "FAILED",
        reasonCode: "linear_unconfigured",
      });
      expect(runState(db, spec.runId)).toBe("FAILED");
      expect(
        db
          .query(
            `SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt`,
          )
          .all(spec.runId),
      ).toEqual([
        { reason_code: "linear_unconfigured" },
        { reason_code: "linear_unconfigured" },
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.FACTORY_EVENT_HOME;
      else process.env.FACTORY_EVENT_HOME = previousHome;
      if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousKey;
      if (previousStub === undefined) delete process.env.FACTORY_DISPATCH_STUB;
      else process.env.FACTORY_DISPATCH_STUB = previousStub;
    }
  });

  test("FACTORY_DISPATCH_STUB enables the demo stub with a bounded owned-paths fixture", async () => {
    const previousStub = process.env.FACTORY_DISPATCH_STUB;
    process.env.FACTORY_DISPATCH_STUB = "1";
    try {
      const db = openDb(":memory:");
      queueRun(db, makeDispatchSpec({ adapter: "pi" }));
      const summary = await runOnce(
        db,
        registry,
        { pi: dispatchFakeAdapter },
        opts({
          resolveLinearKey: () => null,
        }),
      );
      expect(summary).toMatchObject({
        terminalState: "COMPLETED",
        reasonCode: "ok",
      });
    } finally {
      if (previousStub === undefined) delete process.env.FACTORY_DISPATCH_STUB;
      else process.env.FACTORY_DISPATCH_STUB = previousStub;
    }
  });

  test("the fake adapter override explicitly enables the demo dispatch stub", async () => {
    const db = openDb(":memory:");
    queueRun(db, makeDispatchSpec({ adapter: "pi" }));
    const summary = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        adapterOverride: "fake",
        resolveLinearKey: () => null,
      }),
    );
    expect(summary).toMatchObject({
      terminalState: "COMPLETED",
      reasonCode: "ok",
    });
  });

  // WM-115 / #1252: a partial `dispatch` override used to disable the demo
  // stub wholesale, so the seams the caller left out — notably the WM-718
  // handoff comment — fell through to the real tracker CLI. A fake-adapter run
  // then spawned `bun tools/linear.mjs comment` per run: real Linear writes
  // from the test suite, and a wall-clock dependency that timed the burst test
  // out on CI. Shim `bun` on PATH and assert nothing reaches the tracker CLI.
  test("a partial dispatch override still never reaches the tracker CLI under the fake adapter", async () => {
    const shimDir = tmpDir("evrt-bun-shim-");
    const spawnLog = path.join(shimDir, "spawned.log");
    writeFileSync(
      path.join(shimDir, "bun"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(spawnLog)}\nexit 0\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${previousPath}`;
    try {
      const db = openDb(":memory:");
      const spec = queueRun(
        db,
        makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-742" } }),
      );
      const summary = await runOnce(
        db,
        registry,
        { fake: dispatchFakeAdapter },
        opts({
          dispatch: {
            locksDir: tmpDir("evrt-lock-partial-"),
            fetchTicket: (ticket) => readyDispatchTicket(ticket),
            fetchInFlight: () => [],
            countLeases: () => 0,
            claimTicket: () => ({ ok: true }),
          },
        }),
      );
      expect(summary).toMatchObject({
        terminalState: "COMPLETED",
        reasonCode: "ok",
      });
      expect(runState(db, spec.runId)).toBe("COMPLETED");
      const spawned = existsSync(spawnLog)
        ? readFileSync(spawnLog, "utf8")
        : "";
      expect(spawned).not.toContain("linear.mjs");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("acquireClaimLock acquires lock file and prevents concurrent acquire, release unlocks", () => {
    const lockDir = tmpDir("evrt-lock-");
    const lockFile = dispatchLockPath("wt-worker", lockDir);
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 1000 })).toBe(
      true,
    );
    // Second acquire by live PID fails
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 2000 })).toBe(
      false,
    );
    releaseClaimLock(lockFile);
    expect(existsSync(lockFile)).toBe(false);
    expect(acquireClaimLock(lockFile, { pid: process.pid, now: 3000 })).toBe(
      true,
    );
    releaseClaimLock(lockFile);
  });

  test("acquireClaimLock preserves old locks from live owners and reclaims dead owners", () => {
    const lockDir = tmpDir("evrt-lock-stale-");
    const lockFile = dispatchLockPath("wt-worker", lockDir);
    // Age alone cannot make a live owner's lock safe to steal.
    writeFileSync(lockFile, `${process.pid} 1000\n`, "utf8");
    expect(
      acquireClaimLock(lockFile, {
        pid: process.pid,
        now: 201_000,
        isAlive: () => true,
      }),
    ).toBe(false);
    releaseClaimLock(lockFile);

    // A dead owner's lock is stale and is reclaimed immediately.
    writeFileSync(lockFile, `999999 1000\n`, "utf8");
    expect(
      acquireClaimLock(lockFile, {
        pid: process.pid,
        now: 2000,
        isAlive: () => false,
      }),
    ).toBe(true);
    releaseClaimLock(lockFile);
  });

  test("same-identity dispatch claims share the supervisor lock when event home is isolated", async () => {
    const previousEventHome = process.env.FACTORY_EVENT_HOME;
    const previousLocksDir = process.env.FACTORY_LOCKS_DIR;
    const repoName = "wt-worker";
    const supervisorLock = dispatchLockPath(
      repoName,
      path.join(homedir(), ".factory", "locks"),
    );
    process.env.FACTORY_EVENT_HOME = tmpDir("evrt-isolated-event-home-");
    delete process.env.FACTORY_LOCKS_DIR;
    let claimCalls = 0;

    try {
      expect(acquireClaimLock(supervisorLock)).toBe(true);
      const db = openDb(":memory:");
      queueRun(
        db,
        makeDispatchSpec({
          input: { repo: repoName, ticket: "WM-877" },
        }),
      );

      const summary = await runOnce(
        db,
        registry,
        { fake: dispatchFakeAdapter },
        opts({
          dispatch: {
            random: () => 0,
            fetchTicket: () => readyDispatchTicket("WM-877"),
            fetchInFlight: () => [],
            countLeases: () => 0,
            claimTicket: () => {
              claimCalls += 1;
              return { ok: true, assignee: "shared-bot" };
            },
          },
        }),
      );

      expect(summary.reasonCode).toBe("claim_lock_contention");
      expect(claimCalls).toBe(0);
    } finally {
      releaseClaimLock(supervisorLock);
      if (previousEventHome === undefined)
        delete process.env.FACTORY_EVENT_HOME;
      else process.env.FACTORY_EVENT_HOME = previousEventHome;
      if (previousLocksDir === undefined) delete process.env.FACTORY_LOCKS_DIR;
      else process.env.FACTORY_LOCKS_DIR = previousLocksDir;
    }
  });

  test("contended claim lock requeues with jittered backoff without consuming an attempt, then runs", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-lock-busy-");
    const lockFile = dispatchLockPath("wt-worker", lockDir);
    acquireClaimLock(lockFile, { pid: process.pid, now: T0 });

    const spec = queueRun(db, makeDispatchSpec());
    let now = T0;
    const o = opts({
      now: () => now,
      dispatch: {
        locksDir: lockDir,
        random: () => 0,
        fetchTicket: () => readyDispatchTicket("WM-701"),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    });

    const deferred = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(deferred).toMatchObject({
      terminalState: "QUEUED",
      reasonCode: "claim_lock_contention",
    });
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(
      db.query(`SELECT attempts FROM runs WHERE run_id = ?`).get(spec.runId)
        .attempts,
    ).toBe(0);
    expect(
      db.query(`SELECT * FROM attempts WHERE run_id = ?`).all(spec.runId),
    ).toHaveLength(0);
    expect(
      db.query(`SELECT * FROM results WHERE run_id = ?`).all(spec.runId),
    ).toHaveLength(0);
    expect(claimNext(db, o)).toBeNull();

    releaseClaimLock(lockFile);
    now += deferred.requeueAfterMs;
    const completed = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(completed).toMatchObject({
      terminalState: "COMPLETED",
      reasonCode: "ok",
      attempt: 1,
    });
    expect(runState(db, spec.runId)).toBe("COMPLETED");
    expect(
      db.query(`SELECT attempts FROM runs WHERE run_id = ?`).get(spec.runId)
        .attempts,
    ).toBe(1);
  });

  test("claim lock starvation refuses with a distinct reason after the requeue ceiling", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-lock-starved-");
    const lockFile = dispatchLockPath("wt-worker", lockDir);
    acquireClaimLock(lockFile, { pid: process.pid, now: T0 });

    const spec = queueRun(db, makeDispatchSpec());
    let now = T0;
    const o = opts({
      now: () => now,
      dispatch: {
        locksDir: lockDir,
        random: () => 0,
        maxClaimLockContentionRequeues: 1,
        fetchTicket: () => readyDispatchTicket("WM-701"),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    });

    const deferred = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    now += deferred.requeueAfterMs;
    const refused = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(refused).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "claim_lock_starvation",
    });
    expect(runState(db, spec.runId)).toBe("REFUSED");
    releaseClaimLock(lockFile);
  });

  test("concurrent disjoint dispatches drain through the claim lock with mutually exclusive claims", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-lock-burst-");
    const specs = ["WM-710", "WM-711", "WM-712"].map((ticket, index) =>
      queueRun(
        db,
        makeDispatchSpec({
          runId: `run_lock_burst_${index + 1}`,
          input: { repo: "wt-worker", ticket },
        }),
      ),
    );
    let now = T0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    const firstRelease = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let activeClaims = 0;
    let maxActiveClaims = 0;
    const claimedTickets = [];
    const o = opts({
      now: () => now,
      dispatch: {
        locksDir: lockDir,
        random: () => 1,
        fetchTicket: (ticket) => readyDispatchTicket(ticket),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: async ({ ticket }) => {
          activeClaims += 1;
          maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
          claimedTickets.push(ticket);
          if (ticket === "WM-710") {
            markFirstStarted();
            await firstRelease;
          }
          activeClaims -= 1;
          return { ok: true };
        },
      },
    });

    const first = runOnce(db, registry, { fake: dispatchFakeAdapter }, o);
    await firstStarted;
    const second = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    const third = await runOnce(db, registry, { fake: dispatchFakeAdapter }, o);
    expect([second.reasonCode, third.reasonCode]).toEqual([
      "claim_lock_contention",
      "claim_lock_contention",
    ]);
    releaseFirst();
    expect((await first).terminalState).toBe("COMPLETED");

    now += Math.max(second.requeueAfterMs, third.requeueAfterMs);
    const drained = [
      await runOnce(db, registry, { fake: dispatchFakeAdapter }, o),
      await runOnce(db, registry, { fake: dispatchFakeAdapter }, o),
    ];
    expect(drained.map((summary) => summary.terminalState)).toEqual([
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(specs.map((spec) => runState(db, spec.runId))).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(
      specs.map(
        (spec) =>
          db.query(`SELECT attempts FROM runs WHERE run_id = ?`).get(spec.runId)
            .attempts,
      ),
    ).toEqual([1, 1, 1]);
    expect(claimedTickets.sort()).toEqual(["WM-710", "WM-711", "WM-712"]);
    expect(maxActiveClaims).toBe(1);
  });

  // WM-1124: a full-width same-repo dispatch burst must not starve itself. One
  // worker holds the claim lock across a long claim window while the rest of the
  // burst contends against it for many more cycles than the old fixed requeue
  // ceiling (24) allowed. Every contender must durably defer-and-retry — none
  // may terminally REFUSE with claim_lock_starvation just because a live holder
  // still owns the lock — and the atomic claim must be preserved throughout
  // (at most one active tracker claim, each ticket claimed exactly once).
  test("a same-repo dispatch burst never claim_lock_starves against a live holder", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-lock-burst20-");
    const BURST = 20;
    const tickets = Array.from({ length: BURST }, (_, i) => `WM-${720 + i}`);
    const specs = tickets.map((ticket, index) =>
      queueRun(
        db,
        makeDispatchSpec({
          runId: `run_burst_${String(index + 1).padStart(2, "0")}`,
          input: { repo: "wt-worker", ticket },
        }),
      ),
    );

    let now = T0;
    let releaseHolder;
    let markHolderStarted;
    const holderStarted = new Promise((resolve) => {
      markHolderStarted = resolve;
    });
    const holderRelease = new Promise((resolve) => {
      releaseHolder = resolve;
    });
    let activeClaims = 0;
    let maxActiveClaims = 0;
    const claimedTickets = [];
    const holderTicket = tickets[0];

    const o = opts({
      now: () => now,
      dispatch: {
        locksDir: lockDir,
        // Deterministic worst case: full backoff (random -> the cap) every time.
        random: () => 1,
        fetchTicket: (ticket) => readyDispatchTicket(ticket),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: async ({ ticket }) => {
          activeClaims += 1;
          maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
          claimedTickets.push(ticket);
          if (ticket === holderTicket) {
            // Pin the lock open so the rest of the burst repeatedly contends.
            markHolderStarted();
            await holderRelease;
          }
          activeClaims -= 1;
          return { ok: true };
        },
      },
    });

    // One worker wins the lock and holds it across a long claim window.
    const holder = runOnce(db, registry, { fake: dispatchFakeAdapter }, o);
    await holderStarted;

    // While the live holder keeps the lock, sweep the other 19 through far more
    // contention cycles than the old fixed ceiling (24) permitted. Every sweep
    // must defer (QUEUED / claim_lock_contention); none may terminally REFUSE.
    const CONTENTION_ROUNDS = 30;
    const contenders = specs.slice(1);
    for (let round = 0; round < CONTENTION_ROUNDS; round++) {
      // Advance past every deferred not-before so the whole cohort is eligible.
      now += CLAIM_LOCK_BACKOFF_MAX_MS;
      for (let i = 0; i < contenders.length; i++) {
        const summary = await runOnce(
          db,
          registry,
          { fake: dispatchFakeAdapter },
          o,
        );
        expect(summary).toMatchObject({
          terminalState: "QUEUED",
          reasonCode: "claim_lock_contention",
        });
      }
      // The holder is RUNNING and the rest are deferred to a future not-before,
      // so nothing else is claimable within this round.
      expect(claimNext(db, o)).toBeNull();
    }

    // Contention must not have spent an execution attempt or left an attempt row.
    for (const spec of contenders) {
      expect(
        db.query(`SELECT attempts FROM runs WHERE run_id = ?`).get(spec.runId)
          .attempts,
      ).toBe(0);
      expect(
        db.query(`SELECT * FROM attempts WHERE run_id = ?`).all(spec.runId),
      ).toHaveLength(0);
    }

    // Release the holder and drain the whole burst.
    releaseHolder();
    expect((await holder).terminalState).toBe("COMPLETED");

    let completed = 1; // the holder
    let guard = 0;
    while (completed < BURST && guard++ < BURST * 3) {
      now += CLAIM_LOCK_BACKOFF_MAX_MS;
      let summary;
      while (
        (summary = await runOnce(
          db,
          registry,
          { fake: dispatchFakeAdapter },
          o,
        ))
      ) {
        expect(summary.terminalState).toBe("COMPLETED");
        completed += 1;
      }
    }

    // Every burst member ran to completion — none terminally REFUSED.
    expect(completed).toBe(BURST);
    expect(specs.map((spec) => runState(db, spec.runId))).toEqual(
      Array.from({ length: BURST }, () => "COMPLETED"),
    );
    expect(
      db
        .query(
          `SELECT COUNT(*) AS n FROM attempts WHERE reason_code = 'claim_lock_starvation'`,
        )
        .get().n,
    ).toBe(0);
    // Claim atomicity: exactly one claim in flight at a time, each ticket once.
    expect(maxActiveClaims).toBe(1);
    expect(claimedTickets.slice().sort()).toEqual(tickets.slice().sort());
    expect(new Set(claimedTickets).size).toBe(BURST);
    expect(
      specs.map(
        (spec) =>
          db.query(`SELECT attempts FROM runs WHERE run_id = ?`).get(spec.runId)
            .attempts,
      ),
    ).toEqual(Array.from({ length: BURST }, () => 1));
  });

  test("merge-fix gate accepts an assigned In Review ticket without invoking the dispatch claim", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-merge-fix-gate-");
    const spec = queueRun(db, makeMergeFixSpec());
    let claimCalled = false;

    const summary = await runOnce(
      db,
      registry,
      { "merge-fake": mergeFixFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () => ({
            identifier: spec.input.ticket,
            state: { name: "In Review" },
            assignee: { id: "reviewer" },
            labels: { nodes: [{ name: "ai:needs-review" }] },
            description: "## Owned Paths\n- src/feature/**\n",
          }),
          fetchPullRequest: () => ({
            state: "OPEN",
            headRefOid: spec.input.headSha,
          }),
          claimTicket: () => {
            claimCalled = true;
            return { ok: false, reasonCode: "ticket_assigned" };
          },
        },
      }),
    );

    expect(summary).toMatchObject({
      terminalState: "COMPLETED",
      reasonCode: "ok",
    });
    expect(claimCalled).toBe(false);
    expect(runState(db, spec.runId)).toBe("COMPLETED");
  });

  test("merge-fix claim refusals use role-specific reason codes", async () => {
    for (const [suffix, ticketOverrides, pr, reasonCode] of [
      [
        "escalated",
        { labels: { nodes: [{ name: "ai:escalated" }] } },
        { state: "OPEN", headRefOid: "a".repeat(40) },
        "merge_fix_ticket_escalated",
      ],
      [
        "moved",
        {},
        { state: "OPEN", headRefOid: "d".repeat(40) },
        "merge_fix_pr_moved",
      ],
    ]) {
      const db = openDb(":memory:");
      const spec = queueRun(
        db,
        makeMergeFixSpec({ runId: `run_merge_fix_${suffix}` }),
      );
      const summary = await runOnce(
        db,
        registry,
        { "merge-fake": mergeFixFakeAdapter },
        opts({
          dispatch: {
            locksDir: tmpDir(`evrt-merge-fix-${suffix}-`),
            fetchTicket: () => ({
              identifier: spec.input.ticket,
              state: { name: "In Review" },
              assignee: { id: "reviewer" },
              labels: { nodes: [{ name: "ai:needs-review" }] },
              description: "## Owned Paths\n- src/feature/**\n",
              ...ticketOverrides,
            }),
            fetchPullRequest: () => pr,
          },
        }),
      );
      expect(summary).toMatchObject({ terminalState: "REFUSED", reasonCode });
      expect(["ticket_assigned", "ticket_not_todo"]).not.toContain(
        summary.reasonCode,
      );
    }
  });

  test("claim-time dispatch gate honors only operator-sourced security runs (GH-1004)", async () => {
    for (const [source, expectedTerminalState, expectedReasonCode] of [
      ["operator", "COMPLETED", "ok"],
      ["chain", "REFUSED", "ticket_security"],
    ]) {
      const db = openDb(":memory:");
      const ticket = source === "operator" ? "WM-701" : "WM-702";
      const spec = queueRun(
        db,
        makeDispatchSpec({
          runId: `run_security_${source}`,
          input: { repo: "wt-worker", ticket },
        }),
      );
      linkEvent(db, spec.runId, {
        type: "factory.dispatch.requested",
        source,
      });

      const summary = await runOnce(
        db,
        registry,
        { fake: dispatchFakeAdapter },
        opts({
          dispatch: {
            locksDir: tmpDir(`evrt-security-${source}-locks-`),
            fetchTicket: () =>
              readyDispatchTicket(ticket, {
                labels: {
                  nodes: [
                    { name: "ai:agent-ready" },
                    { name: "type:security" },
                  ],
                },
              }),
            fetchInFlight: () => [],
            countLeases: () => 0,
            claimTicket: () => ({ ok: true }),
          },
        }),
      );

      expect(summary).toMatchObject({
        terminalState: expectedTerminalState,
        reasonCode: expectedReasonCode,
      });
    }
  });

  test("execute-time re-checks refuse on ticket_not_todo, ticket_assigned, capacity_full, owned_paths_overlap, ticket_claim_lost", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-rechecks-");

    // 1. ticket_not_todo
    const spec1 = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-702" } }),
    );
    const sum1 = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () =>
            readyDispatchTicket("WM-702", { state: { name: "In Review" } }),
          fetchInFlight: () => [],
          countLeases: () => 0,
        },
      }),
    );
    expect(sum1.terminalState).toBe("REFUSED");
    expect(sum1.reasonCode).toBe("ticket_not_todo");

    // 2. ticket_assigned
    const spec2 = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-703" } }),
    );
    const sum2 = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () =>
            readyDispatchTicket("WM-703", { assignee: { id: "other" } }),
          fetchInFlight: () => [],
          countLeases: () => 0,
        },
      }),
    );
    expect(sum2.terminalState).toBe("REFUSED");
    expect(sum2.reasonCode).toBe("ticket_assigned");

    // 3. capacity_full
    const spec3 = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-704" } }),
    );
    const sum3 = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () => readyDispatchTicket("WM-704"),
          fetchInFlight: () => [],
          countLeases: () => 2, // cap is 2
        },
      }),
    );
    expect(sum3.terminalState).toBe("REFUSED");
    expect(sum3.reasonCode).toBe("capacity_full");

    // 4. owned_paths_overlap
    const spec4 = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-705" } }),
    );
    const sum4 = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () =>
            readyDispatchTicket("WM-705", {
              description: "## Owned Paths\n- src/api/**\n",
            }),
          fetchInFlight: () => [
            {
              identifier: "WM-800",
              description: "## Owned Paths\n- src/api/routes.ts\n",
            },
          ],
          countLeases: () => 0,
        },
      }),
    );
    expect(sum4.terminalState).toBe("REFUSED");
    expect(sum4.reasonCode).toBe("owned_paths_overlap");

    // 5. ticket_claim_lost
    const spec5 = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-706" } }),
    );
    const sum5 = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () => readyDispatchTicket("WM-706"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: false, reasonCode: "ticket_claim_lost" }),
        },
      }),
    );
    expect(sum5.terminalState).toBe("REFUSED");
    expect(sum5.reasonCode).toBe("ticket_claim_lost");
  });

  // WM-677: under `dispatch.owned_paths_collision: advisory` a textual overlap
  // is evidence, not a refusal — the run is claimed and executes. Only the
  // narrow hard-conflict set (identical concrete file, or `**`) still refuses.
  // The worker consumes the same gate as the planner, so this is the
  // execute-time half of the contract; the fixture policy.yaml is `{}` for
  // every other test here, which is why they still see strict.
  test("advisory owned-paths mode dispatches across overlap and refuses only hard conflicts (WM-677)", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-advisory-");
    const policyPath = path.join(factoryRoot, "config", "policy.yaml");
    const priorPolicy = readFileSync(policyPath, "utf8");
    writeFileSync(policyPath, "dispatch:\n  owned_paths_collision: advisory\n");
    try {
      // Containment overlap (src/api/** vs src/api/routes.ts): strict refuses this
      // exact pair in the test above; advisory lets it run.
      const specA = queueRun(
        db,
        makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-707" } }),
      );
      const sumA = await runOnce(
        db,
        registry,
        { fake: dispatchFakeAdapter },
        opts({
          dispatch: {
            locksDir: lockDir,
            fetchTicket: () =>
              readyDispatchTicket("WM-707", {
                description: "## Owned Paths\n- src/api/**\n",
              }),
            fetchInFlight: () => [
              {
                identifier: "WM-800",
                description: "## Owned Paths\n- src/api/routes.ts\n",
              },
            ],
            countLeases: () => 0,
          },
        }),
      );
      expect(sumA.terminalState).not.toBe("REFUSED");
      expect(sumA.reasonCode).not.toBe("owned_paths_overlap");

      // Identical concrete file on both sides: same file is not same lines —
      // advisory lets it run too (evidence carries the pair).
      queueRun(
        db,
        makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-708" } }),
      );
      const sumB = await runOnce(
        db,
        registry,
        { fake: dispatchFakeAdapter },
        opts({
          dispatch: {
            locksDir: lockDir,
            fetchTicket: () =>
              readyDispatchTicket("WM-708", {
                description: "## Owned Paths\n- src/api/routes.ts\n",
              }),
            fetchInFlight: () => [
              {
                identifier: "WM-801",
                description: "## Owned Paths\n- src/api/routes.ts\n",
              },
            ],
            countLeases: () => 0,
          },
        }),
      );
      expect(sumB.terminalState).not.toBe("REFUSED");
      expect(sumB.reasonCode).not.toBe("owned_paths_conflict_hard");

      // A `**` claim on the in-flight side is now advisory: a scope-unknown
      // in-flight ticket (missing Owned Paths → whole-repo claim) must not
      // freeze the queue, so the candidate dispatches rather than hard-refusing.
      queueRun(
        db,
        makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-709" } }),
      );
      const sumC = await runOnce(
        db,
        registry,
        { fake: dispatchFakeAdapter },
        opts({
          dispatch: {
            locksDir: lockDir,
            fetchTicket: () =>
              readyDispatchTicket("WM-709", {
                description: "## Owned Paths\n- docs/readme.md\n",
              }),
            fetchInFlight: () => [
              { identifier: "WM-802", description: "## Owned Paths\n- **\n" },
            ],
            countLeases: () => 0,
          },
        }),
      );
      expect(sumC.terminalState).not.toBe("REFUSED");
      expect(sumC.reasonCode).not.toBe("owned_paths_conflict_hard");
    } finally {
      writeFileSync(policyPath, priorPolicy);
    }
  });

  test("lease-loss attempt 2 resumes its own claim while stale attempt 1 cannot unclaim it (WM-621)", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-claim-retry-locks-");
    const leaseDir = tmpDir("evrt-claim-retry-leases-");
    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-worker", ticket: "WM-621" },
      }),
    );
    let now = T0;
    let ticket = readyDispatchTicket("WM-621");
    let claimCalls = 0;
    let unclaimCalls = 0;
    let adapterCalls = 0;
    let releaseFirst;
    let releaseSecond;
    let markFirstStarted;
    let markSecondStarted;
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise((resolve) => {
      markSecondStarted = resolve;
    });
    const firstRelease = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const secondRelease = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    const retryAdapter = {
      async execute(args) {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          markFirstStarted();
          await firstRelease;
          return { exitCode: 1, timedOut: false };
        }
        markSecondStarted();
        await secondRelease;
        return dispatchFakeAdapter.execute(args);
      },
    };
    const o = opts({
      now: () => now,
      workspacesRoot: freshRoot(),
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => ticket,
        fetchViewer: () => ({ id: "factory-user", name: "Factory" }),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => {
          claimCalls += 1;
          ticket = readyDispatchTicket("WM-621", {
            state: { name: "In Progress" },
            assignee: { id: "factory-user", name: "Factory" },
            labels: {
              nodes: [
                { name: "ai:in-progress" },
                { name: "agent:claude-code" },
              ],
            },
          });
          return { ok: true };
        },
        unclaimTicket: () => {
          unclaimCalls += 1;
          ticket = readyDispatchTicket("WM-621");
          return true;
        },
      },
    });

    const firstClaim = claimNext(db, o);
    const firstExecution = executeClaimed(
      db,
      registry,
      { fake: retryAdapter },
      firstClaim,
      o,
    );
    let retryExecution;
    try {
      await firstStarted;
      expect(claimCalls).toBe(1);
      expect(ticket.state.name).toBe("In Progress");

      now = T0 + (spec.timeoutSeconds + 120) * 1000 + 1;
      expect(reapExpiredLeases(db, { now, policyVersion: "test" })).toBe(1);
      expect(runState(db, spec.runId)).toBe("QUEUED");

      retryExecution = runOnce(db, registry, { fake: retryAdapter }, o);
      await secondStarted;
      expect(claimCalls).toBe(1);
      expect(
        readFileSync(callsLog, "utf8")
          .trim()
          .split("\n")
          .filter((call) => call === "up WM-621"),
      ).toHaveLength(2);
      expect(lifecycleOf(db, spec.runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to_state: "RUNNING", attempt: 2 }),
        ]),
      );

      releaseFirst();
      expect(await firstExecution).toEqual({ fenced: true });
      expect(unclaimCalls).toBe(0);
      expect(ticket.state.name).toBe("In Progress");
      expect(
        liveWorkerLeases("wt-worker", { dir: leaseDir, now }),
      ).toHaveLength(1);

      releaseSecond();
      const retried = await retryExecution;
      expect(retried).toMatchObject({ attempt: 2, terminalState: "COMPLETED" });
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled(
        [firstExecution, retryExecution].filter(Boolean),
      );
    }
  });

  test("claim-time Linear read failure contradicting plan evidence requeues with backoff", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-transient-linear-");
    const description = "## Owned Paths\n- src/feature/**\n";
    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-worker", ticket: "WM-707" },
        approvalPolicy: planTimeDispatchEvidence(description),
      }),
    );
    let now = T0;
    let reads = 0;
    const o = opts({
      now: () => now,
      dispatch: {
        locksDir: lockDir,
        random: () => 0,
        fetchTicket: () => {
          reads += 1;
          if (reads === 1) throw new Error("linear_read_failed: HTTP 503");
          return readyDispatchTicket("WM-707", { description });
        },
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
      },
    });

    const deferred = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(deferred).toMatchObject({
      terminalState: "QUEUED",
      reasonCode: "linear_read_failed",
    });
    expect(deferred.requeueAfterMs).toBeGreaterThan(0);
    expect(runState(db, spec.runId)).toBe("QUEUED");
    expect(
      db.query(`SELECT attempts FROM runs WHERE run_id = ?`).get(spec.runId)
        .attempts,
    ).toBe(0);
    expect(claimNext(db, o)).toBeNull();

    now += deferred.requeueAfterMs;
    const completed = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(completed).toMatchObject({
      terminalState: "COMPLETED",
      reasonCode: "ok",
      attempt: 1,
    });
  });

  test("empty claim-time description retries only when its hash contradicts plan evidence, then explains recovery", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-transient-owned-paths-");
    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-worker", ticket: "WM-708" },
        approvalPolicy: planTimeDispatchEvidence(),
      }),
    );
    let now = T0;
    const o = opts({
      now: () => now,
      dispatch: {
        locksDir: lockDir,
        random: () => 0,
        maxTransientGateRequeues: 1,
        fetchTicket: () => readyDispatchTicket("WM-708", { description: "" }),
        fetchInFlight: () => [],
        countLeases: () => 0,
      },
    });

    const deferred = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(deferred).toMatchObject({
      terminalState: "QUEUED",
      reasonCode: "owned_paths_unknown",
    });
    expect(runState(db, spec.runId)).toBe("QUEUED");

    now += deferred.requeueAfterMs;
    const exhausted = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      o,
    );
    expect(exhausted).toMatchObject({
      terminalState: "REFUSED",
      reasonCode: "owned_paths_unknown",
    });
    expect(runState(db, spec.runId)).toBe("REFUSED");
    expect(() =>
      retryRun(db, spec.runId, {
        actor: "operator",
        force: true,
        policyVersion: "test",
        now,
      }),
    ).toThrow(
      `factory dispatch event factory.dispatch.requested --payload '{"repo":"wt-worker","ticket":"WM-708"}' --watch`,
    );
  });

  test("worker lease is acquired during execution and released on completion", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-lease-locks-");
    const leaseDir = tmpDir("evrt-lease-dir-");

    let sawActiveLease = false;
    const leaseCheckAdapter = {
      async execute({ spec, workspaceDir }) {
        const active = liveWorkerLeases("wt-worker", {
          dir: leaseDir,
          now: T0,
        });
        sawActiveLease = active.some((l) => l.ticket === spec.input.ticket);
        return dispatchFakeAdapter.execute({ spec, workspaceDir });
      },
    };

    const spec = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-710" } }),
    );
    const summary = await runOnce(
      db,
      registry,
      { fake: leaseCheckAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          leasesDir: leaseDir,
          fetchTicket: () => readyDispatchTicket("WM-710"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );

    expect(sawActiveLease).toBe(true);
    expect(summary.terminalState).toBe("COMPLETED");
    // After execution, the lease must be released
    expect(
      liveWorkerLeases("wt-worker", { dir: leaseDir, now: T0 }),
    ).toHaveLength(0);
  });

  test("mutating worktree is exempt from read-only clean check and runs repo verify command", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-verify-locks-");
    const leaseDir = tmpDir("evrt-verify-leases-");

    const spec = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-720" } }),
    );
    const summary = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          leasesDir: leaseDir,
          fetchTicket: () => readyDispatchTicket("WM-720"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );

    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.reasonCode).toBe("ok");
    const resRow = db
      .query(`SELECT result_json FROM results WHERE run_id = ?`)
      .get(spec.runId);
    const result = JSON.parse(resRow.result_json);
    expect(result.verification.checks).toContain("repo_verify_passed");
  });

  test("forceFailRun aborts a RUNNING adapter and releases its ticket claim promptly", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-force-fail-locks-");
    const leaseDir = tmpDir("evrt-force-fail-leases-");
    const unclaimCalls = [];
    let adapterFinishedNaturally = false;
    let adapterAborted = false;
    let signalAdapterStarted;
    const adapterStarted = new Promise((resolve) => {
      signalAdapterStarted = resolve;
    });
    const sleepingAdapter = {
      execute: ({ abortSignal }) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            adapterFinishedNaturally = true;
            resolve({ exitCode: 0, timedOut: false });
          }, 1_000);
          abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            adapterAborted = true;
            resolve({ exitCode: null, timedOut: false });
          });
          signalAdapterStarted();
        }),
    };
    const spec = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-954" } }),
    );
    const o = opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => readyDispatchTicket("WM-954"),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
        unclaimTicket: (payload) => (unclaimCalls.push(payload), true),
      },
    });
    const claim = claimNext(db, o);
    const execution = executeClaimed(
      db,
      registry,
      { fake: sleepingAdapter },
      claim,
      o,
    );

    await adapterStarted;
    forceFailRun(db, spec.runId, {
      actor: "operator",
      reason: "operator_force_fail",
      policyVersion: "test",
      now: T0,
    });
    const summary = await execution;

    expect(adapterAborted).toBe(true);
    expect(adapterFinishedNaturally).toBe(false);
    expect(summary).toEqual({ cancelled: true });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(lifecycleOf(db, spec.runId).at(-1).reason).toBe(
      "operator_force_fail",
    );
    expect(
      db
        .query(
          `SELECT terminal_state, reason_code FROM attempts WHERE run_id = ?`,
        )
        .get(spec.runId),
    ).toEqual({
      terminal_state: "FAILED",
      reason_code: "operator_force_fail",
    });
    expect(unclaimCalls).toEqual([
      expect.objectContaining({
        repo: "wt-worker",
        ticket: "WM-954",
        why: "force_failed",
      }),
    ]);
  });

  test("force-fail reports and traces an unclaim failure", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-force-fail-unclaim-locks-");
    const leaseDir = tmpDir("evrt-force-fail-unclaim-leases-");
    let signalAdapterStarted;
    const adapterStarted = new Promise((resolve) => {
      signalAdapterStarted = resolve;
    });
    const sleepingAdapter = {
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
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-955" } }),
    );
    const o = opts({
      dispatch: {
        locksDir: lockDir,
        leasesDir: leaseDir,
        fetchTicket: () => readyDispatchTicket("WM-955"),
        fetchInFlight: () => [],
        countLeases: () => 0,
        claimTicket: () => ({ ok: true }),
        unclaimTicket: () => {
          throw new Error("tracker unclaim failed");
        },
      },
    });
    const loud = [];
    const originalConsoleError = console.error;
    console.error = (...args) => loud.push(args.join(" "));
    let summary;
    try {
      const claim = claimNext(db, o);
      const execution = executeClaimed(
        db,
        registry,
        { fake: sleepingAdapter },
        claim,
        o,
      );
      await adapterStarted;
      forceFailRun(db, spec.runId, {
        actor: "operator",
        reason: "operator_force_fail",
        policyVersion: "test",
        now: T0,
      });
      summary = await execution;
    } finally {
      console.error = originalConsoleError;
    }

    expect(summary).toEqual({
      cancelled: true,
      unclaimError: "tracker unclaim failed",
    });
    expect(loud.join("\n")).toContain(
      `terminal unclaimTicket failed for run ${spec.runId} attempt 1: tracker unclaim failed`,
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
      operation: "unclaimTicket",
      runId: spec.runId,
      attempt: 1,
      message: "tracker unclaim failed",
    });
  });

  // WM-718: at handoff (PR_OPEN) a red repo verify is the handoff gate
  // refusing — named `handoff_verification_failed` so the ticket returns to
  // Todo + ai:agent-ready and the PR is held; still FAILED, still no result row.
  test("failing repo verify command at handoff fails handoff_verification_failed", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-fverify-locks-");
    const leaseDir = tmpDir("evrt-fverify-leases-");

    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-failing-verify", ticket: "WM-730" },
      }),
    );
    const summary = await runOnce(
      db,
      registry,
      { fake: dispatchFakeAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          leasesDir: leaseDir,
          fetchTicket: () => readyDispatchTicket("WM-730"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("handoff_verification_failed");
    expect(summary.detail).toContain("repo_verify_failed");
    expect(summary.handoff.repoVerify.exitCode).toBe(42);
  });

  test("a deliberately red baseline still reaches the agent with failure context, then terminates baseline_red", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-baseline-locks-");
    const leaseDir = tmpDir("evrt-baseline-leases-");
    let executionInput = null;
    const unclaimCalls = [];
    const blockCalls = [];
    const observingAdapter = {
      async execute({ spec, workspaceDir }) {
        executionInput = JSON.parse(
          readFileSync(path.join(workspaceDir, "input.json"), "utf8"),
        );
        return dispatchFakeAdapter.execute({ spec, workspaceDir });
      },
    };

    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-baseline-red", ticket: "WM-731" },
      }),
    );
    const summary = await runOnce(
      db,
      registry,
      { fake: observingAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          leasesDir: leaseDir,
          fetchTicket: () => readyDispatchTicket("WM-731"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
          unclaimTicket: (payload) => {
            unclaimCalls.push(payload);
            return false;
          },
          blockBaselineTicket: (payload) => {
            blockCalls.push(payload);
            return true;
          },
        },
      }),
    );

    expect(executionInput).toMatchObject({
      repo: "wt-baseline-red",
      ticket: "WM-731",
      baseline: {
        status: "red",
        check: "web_build",
        output: "entry chunk exceeds budget",
      },
    });
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("baseline_red");
    expect(blockCalls).toHaveLength(1);
    expect(unclaimCalls).toHaveLength(0);
    expect(
      db
        .query(`SELECT reason_code FROM attempts WHERE run_id = ?`)
        .get(spec.runId).reason_code,
    ).toBe("baseline_red");
  });

  test(
    "worktree-up handles an actual baseline-red repo verification and deduplicates baseline blocker comments",
    // This test provisions real git worktrees and child processes twice. The
    // 45s ceiling has headroom over the ~9s observed under the 8-run burst
    // (load ~76 on 32 CPUs), and scales with the shared-runner load factor.
    { timeout: loadAdjustedTimeout(45_000) },
    async () => {
      // This test provisions a real worktree with bin/worktree-up.sh, which
      // takes its lifecycle lock inside the repository's shared git directory.
      // When the suite is itself the command a handoff sandbox is verifying,
      // that directory is mounted read-only on purpose (GH-967): ticket code
      // must not be able to write the host repository's refs or objects. The
      // gate's own worktree provisioning happens outside the sandbox, so this
      // is the test setup hitting the boundary, not the behaviour under test.
      if (insideHandoffSandbox()) return;
      const repoRoot = process.cwd();
      const repoName = "wm-baseline-real";
      const ticket = `WM-${732000000 + Math.floor(Math.random() * 1_000_000)}`;
      const apiPort = "7408";
      const apiPortNumber = Number(apiPort);
      const tmpRoot = tmpDir("wm334-real-");
      const stubDir = path.join(tmpRoot, "stub");
      const linearStateDir = path.join(tmpRoot, "linear-state");
      const worktreeRoot = path.join(tmpRoot, "worktrees");
      const reposFile = path.join(tmpRoot, "config", "repos.yaml");

      const write = (p, c) => {
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, c, "utf8");
      };

      const baselineFailureSignature = ({ why, log = null, baseline }) =>
        createHash("sha256")
          .update(
            JSON.stringify({
              why,
              log,
              baseline:
                baseline && typeof baseline === "object"
                  ? {
                      check: baseline.check,
                      exitCode: baseline.exitCode,
                      output: baseline.output,
                    }
                  : null,
            }),
          )
          .digest("hex");

      const baselineFailureMarker = (payload) =>
        `wm:baseline:red:${baselineFailureSignature(payload)}`;
      const keepAliveProcesses = [];

      const expectedHome = path.join(
        worktreeRoot,
        ticket,
        ".factory",
        "event-runtime",
      );
      const seedRuntimeState = () => {};

      const currentBranch = (
        spawnSync(
          "git",
          ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"],
          { encoding: "utf8" },
        ).stdout || ""
      ).trim();
      // GitHub Actions checks out a PR merge ref detached from its source branch.
      // Give worktree-up a verified origin ref to that checked-out commit, rather
      // than accidentally constructing the invalid origin/HEAD ref.
      const detachedBaseBranch =
        currentBranch === "HEAD" ? `wm334-test-${ticket}-${process.pid}` : null;
      if (detachedBaseBranch) {
        const head = (
          spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).stdout || ""
        ).trim();
        execFileSync("git", [
          "-C",
          repoRoot,
          "update-ref",
          `refs/remotes/origin/${detachedBaseBranch}`,
          head,
        ]);
      }
      const hasRemoteBranch = (branch) =>
        branch &&
        branch !== "HEAD" &&
        spawnSync("git", [
          "-C",
          repoRoot,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${branch}`,
        ]).status === 0;
      const baseBranch = [
        currentBranch,
        detachedBaseBranch,
        process.env.GITHUB_BASE_REF,
        "develop",
      ].find(hasRemoteBranch);
      expect(baseBranch).toBeDefined();
      expect(baseBranch).not.toBe("HEAD");
      expect(hasRemoteBranch(baseBranch)).toBe(true);
      const realBun =
        (
          spawnSync("bash", ["-c", "command -v bun"], {
            encoding: "utf8",
            env: { ...process.env },
          }).stdout || ""
        ).trim() || "bun";

      mkdirSync(stubDir, { recursive: true });
      mkdirSync(linearStateDir, { recursive: true });

      const worktreeUp = path.join(stubDir, "worktree-up-no-seed.sh");
      write(
        worktreeUp,
        `#!/usr/bin/env bash\nexec ${JSON.stringify(path.join(repoRoot, "bin", "worktree-up.sh"))} "$@" --no-seed\n`,
      );

      const testPortBase = 18400 + Math.floor(Math.random() * 1000) * 2;
      const testProcessMarker = `wm334-${process.pid}-${ticket}`;

      const bunStubLines = [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        'const path = require("path");',
        'const { spawn } = require("child_process");',
        ...processOwnerWatchdogSource().split("\n"),
        `const stateDir = process.env.WM334_LINEAR_STATE_DIR || ${JSON.stringify(linearStateDir)}`,
        `const realBun = process.env.WM334_REAL_BUN || ${JSON.stringify(realBun)}`,
        "const args = process.argv.slice(2);",
        "const logPath = process.env.WM334_BUN_LOG || null;",
        "if (logPath) {\n  try {\n    fs.appendFileSync(logPath, `CALL ${args.join(' ')}\\n`);\n  } catch {}\n}",
        "",
        "function commentsPath(ticket) {",
        '  return path.join(stateDir, ticket + ".comments.json");',
        "}",
        "function readComments(ticket) {",
        "  try {",
        '    return JSON.parse(fs.readFileSync(commentsPath(ticket), "utf8"));',
        "  } catch {",
        "    return [];",
        "  }",
        "}",
        "function writeComments(ticket, rows) {",
        '  fs.writeFileSync(commentsPath(ticket), JSON.stringify(rows), "utf8");',
        "}",
        "",
        'if (args[0]?.endsWith("tools/ticket.mjs")) {',
        "  const verb = args[1];",
        '  if (verb === "comments") {',
        "    const ticket = args[2];",
        "    console.log(JSON.stringify(readComments(ticket)));",
        "    process.exit(0);",
        "  }",
        '  if (verb === "comment") {',
        "    const ticket = args[2];",
        '    const body = args.slice(3).join(" ");',
        "    const rows = readComments(ticket);",
        "    rows.push({ body });",
        "    writeComments(ticket, rows);",
        "    process.exit(0);",
        "  }",
        '  if (verb === "state") {',
        '    console.log("ok");',
        "    process.exit(0);",
        "  }",
        '  if (verb === "claim") {',
        '    console.log("ok");',
        "    process.exit(0);",
        "  }",
        '  if (verb === "get") {',
        '    console.log(JSON.stringify({ identifier: args[2], state: { name: "In Progress" }, assignee: { name: "agent" }, labels: { nodes: [{ name: "ai:in-progress" }] } }));',
        "    process.exit(0);",
        "  }",
        '  console.log("[]");',
        "  process.exit(0);",
        "}",
        'if (args.includes("install")) {',
        "  process.exit(0);",
        "}",
        'if (args[0] === "run" && args[1] === "build:fast") {',
        '  console.log("entry chunk exceeds budget");',
        "  process.exit(1);",
        "}",
        "const child = spawn(realBun, args, {",
        '  stdio: "inherit",',
        `  argv0: ${JSON.stringify(`factory-test-${testProcessMarker}`)},`,
        `  env: { ...process.env, FACTORY_TEST_TRACKED_PROCESS: ${JSON.stringify(testProcessMarker)} },`,
        "});",
        'process.on("SIGTERM", () => child.kill("SIGTERM"));',
        'process.on("SIGINT", () => child.kill("SIGINT"));',
        'process.on("SIGHUP", () => child.kill("SIGHUP"));',
        'child.on("exit", (code, signal) => {',
        "  if (signal) {",
        "    try { process.kill(process.pid, signal); } catch {}",
        "  }",
        "  process.exit(code ?? 0);",
        "});",
      ];
      write(path.join(stubDir, "bun"), bunStubLines.join("\n") + "\n");

      for (const filePath of [path.join(stubDir, "bun"), worktreeUp]) {
        execFileSync("chmod", ["+x", filePath]);
      }

      write(
        reposFile,
        `repos:\n` +
          `  - name: ${repoName}\n` +
          `    path: ${repoRoot}\n` +
          `    github: watt-mind/${repoName}\n` +
          `    base: ${baseBranch}\n` +
          `    team: WM\n` +
          `    project: Factory\n` +
          `    max_in_flight: 1\n` +
          `    worktree_up: ${worktreeUp}\n` +
          `    worktree_down: bin/worktree-down.sh\n` +
          `    worktree_root: ${worktreeRoot}\n` +
          `    verify: printf 'entry chunk exceeds budget\\n' \\n  >&2; exit 1\n` +
          `    escalate_paths: []\n`,
      );
      const basePolicy = readFileSync(
        resolveConfigPath("policy", { root: repoRoot, warn: false }),
        "utf8",
      );
      const testPolicy = basePolicy.includes("  fake:")
        ? basePolicy
        : basePolicy.replace(
            /^models:\n/m,
            "models:\n  fake:\n    strong: default\n    standard: default\n    light: default\n",
          );
      write(path.join(tmpRoot, "config", "policy.yaml"), testPolicy);

      const originalEnv = {
        FACTORY_REPOS_ROOT: process.env.FACTORY_REPOS_ROOT,
        FACTORY_SKIP_FETCH: process.env.FACTORY_SKIP_FETCH,
        FACTORY_BASE_BRANCH: process.env.FACTORY_BASE_BRANCH,
        FACTORY_WT_ROOT: process.env.FACTORY_WT_ROOT,
        FACTORY_PORT_BASE: process.env.FACTORY_PORT_BASE,
        FACTORY_PORT_SPAN: process.env.FACTORY_PORT_SPAN,
        PATH: process.env.PATH,
        WM334_LINEAR_STATE_DIR: process.env.WM334_LINEAR_STATE_DIR,
        WM334_REAL_BUN: process.env.WM334_REAL_BUN,
        WM334_BUN_LOG: process.env.WM334_BUN_LOG,
        FACTORY_TEST_TRACKED_PROCESS: process.env.FACTORY_TEST_TRACKED_PROCESS,
      };
      try {
        process.env.FACTORY_REPOS_ROOT = tmpRoot;
        process.env.FACTORY_SKIP_FETCH = "1";
        process.env.FACTORY_BASE_BRANCH = baseBranch;
        process.env.FACTORY_WT_ROOT = worktreeRoot;
        process.env.FACTORY_PORT_BASE = String(testPortBase);
        process.env.FACTORY_PORT_SPAN = "50";
        process.env.PATH = `${path.join(stubDir)}:${process.env.PATH}`;
        process.env.WM334_LINEAR_STATE_DIR = linearStateDir;
        process.env.WM334_REAL_BUN = realBun;
        process.env.WM334_BUN_LOG = path.join(tmpRoot, "bun-calls.log");
        process.env.FACTORY_TEST_TRACKED_PROCESS = testProcessMarker;

        const db = openDb(":memory:");
        const lockDir = tmpDir("wm334-real-locks-");
        const leaseDir = tmpDir("wm334-real-leases-");
        const executionInputs = [];
        const blockCalls = [];
        const observedAdapter = {
          async execute({ spec, workspaceDir }) {
            executionInputs.push(
              JSON.parse(
                readFileSync(path.join(workspaceDir, "input.json"), "utf8"),
              ),
            );
            const result = {
              schemaVersion: "factory.agent-result/v1",
              terminalState: "completed",
              reasonCode: "ok",
              artifact: {
                outcome: "PR_OPEN",
                repo: spec.input.repo,
                ticket: spec.input.ticket,
                prUrl: `https://github.com/watt-mind/${spec.input.repo}/pull/10`,
                verification: {
                  command:
                    "printf 'entry chunk exceeds budget\\n' > /dev/null; exit 1",
                  passed: true,
                  output: "agent verification passed",
                },
                summary: `implemented ${spec.input.ticket}`,
              },
              evidence: {
                commands: ["cd event-runtime/web && bun run build:fast"],
              },
            };
            writeFileSync(
              path.join(workspaceDir, "result.json"),
              `${JSON.stringify(result, null, 2)}\n`,
              "utf8",
            );
            return { exitCode: 0, timedOut: false };
          },
        };

        const blockTicket = ({ ticket, why, baseline, log = null }) => {
          blockCalls.push({ ticket, why, baseline, log });
          const marker = baselineFailureMarker({ why, baseline, log });
          const commentsPath = path.join(
            linearStateDir,
            `${ticket}.comments.json`,
          );
          const existing = existsSync(commentsPath)
            ? JSON.parse(readFileSync(commentsPath, "utf8"))
            : [];
          if (
            !existing.some((row) => String(row.body ?? "").includes(marker))
          ) {
            existing.push({
              body: `Dispatch run blocked due pre-existing baseline red.\n\n**Why:** ${why}\n\n<!-- ${marker} -->`,
            });
            writeFileSync(commentsPath, JSON.stringify(existing), "utf8");
          }
          return true;
        };

        const run = async () => {
          seedRuntimeState();
          const spec = queueRun(
            db,
            makeDispatchSpec({
              input: { repo: repoName, ticket },
              workspace: {
                type: "worktree",
                checkoutDir: "repo",
                retainOnFailure: false,
              },
            }),
          );
          try {
            return await runOnce(
              db,
              registry,
              { fake: observedAdapter },
              opts({
                workspacesRoot: tmpDir(`${repoName}-run-`),
                dispatch: {
                  locksDir: lockDir,
                  leasesDir: leaseDir,
                  fetchTicket: () => readyDispatchTicket(ticket),
                  fetchInFlight: () => [],
                  countLeases: () => 0,
                  claimTicket: () => ({ ok: true }),
                  blockBaselineTicket: blockTicket,
                },
              }),
            );
          } finally {
            trackProcessGroupsMatching(tmpRoot);
            trackMarkedFakeRuntimeGroups(testProcessMarker);
            const runDir = path.join(worktreeRoot, ticket, ".factory", "run");
            if (existsSync(runDir)) {
              for (const name of readdirSync(runDir).filter((entry) =>
                entry.endsWith(".pid"),
              )) {
                const pid = Number(
                  readFileSync(path.join(runDir, name), "utf8").trim(),
                );
                if (Number.isInteger(pid) && pid > 0) trackProcess(pid);
              }
            }
          }
        };

        const first = await run();
        const second = await run();
        if (first.reasonCode !== "baseline_red") {
          console.log("first summary", first);
        }

        expect(first.terminalState).toBe("FAILED");
        expect(first.reasonCode).toBe("baseline_red");
        expect(second.terminalState).toBe("FAILED");
        expect(second.reasonCode).toBe("baseline_red");
        expect(executionInputs).toHaveLength(2);
        expect(blockCalls).toHaveLength(2);
        expect(executionInputs[0]).toMatchObject({
          repo: repoName,
          ticket,
          baseline: { status: "red", check: "web_build", exitCode: 1 },
        });
        expect(String(executionInputs[0].baseline.output ?? "")).toContain(
          "entry chunk exceeds budget",
        );

        const comments = JSON.parse(
          readFileSync(
            path.join(linearStateDir, `${ticket}.comments.json`),
            "utf8",
          ),
        );
        expect(comments).toHaveLength(1);

        const marker = baselineFailureMarker({
          why: blockCalls[0].why,
          baseline: blockCalls[0].baseline,
          log: blockCalls[0].log,
        });
        expect(comments[0].body).toContain(`<!-- ${marker} -->`);
      } finally {
        trackProcessGroupsMatching(tmpRoot);
        trackMarkedFakeRuntimeGroups(testProcessMarker);
        await cleanupTrackedProcesses();
        if (detachedBaseBranch) {
          spawnSync("git", [
            "-C",
            repoRoot,
            "update-ref",
            "-d",
            `refs/remotes/origin/${detachedBaseBranch}`,
          ]);
        }
        for (const child of keepAliveProcesses) {
          try {
            child.kill();
          } catch {
            /* intentionally ignored */
          }
        }
        for (const [key, value] of Object.entries(originalEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        if (!process.env.WM334_KEEP_TMP_ROOT) {
          rmSync(tmpRoot, { recursive: true, force: true });
        }
      }
    },
  );

  test("worktree provisioning failure is not misclassified as adapter_error and never reaches execution", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-provision-locks-");
    let executed = false;
    const observingAdapter = {
      async execute() {
        executed = true;
        return { exitCode: 0, timedOut: false };
      },
    };

    const spec = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-broken-up", ticket: "WM-732" } }),
    );
    const summary = await runOnce(
      db,
      registry,
      { fake: observingAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () => readyDispatchTicket("WM-732"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );

    expect(executed).toBe(false);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("workspace_provisioning_error");
    expect(summary.error).toContain("dependency install failed");
    expect(
      db
        .query(`SELECT reason_code FROM attempts WHERE run_id = ?`)
        .get(spec.runId).reason_code,
    ).toBe("workspace_provisioning_error");
  });

  test("sandboxed execution against a worktree workspace is refused typed before the adapter runs", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-sandbox-wt-locks-");
    let executed = false;
    const observingAdapter = {
      async execute() {
        executed = true;
        return { exitCode: 0, timedOut: false };
      },
    };
    const sandboxRegistry = {
      ...registry,
      agents: new Map(registry.agents),
    };
    sandboxRegistry.agents.set("dispatch@1", {
      ...getAgent(registry, "dispatch@1"),
      sandbox: { provider: "gondolin", allowedHosts: [] },
    });
    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-worker", ticket: "WM-733" },
        maxEnvironmentRetries: 5,
      }),
    );

    const summary = await runOnce(
      db,
      sandboxRegistry,
      { fake: observingAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () => readyDispatchTicket("WM-733"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );

    expect(executed).toBe(false);
    expect(summary).toMatchObject({
      terminalState: "FAILED",
      reasonCode: "worktree_sandbox_unsupported",
    });
    expect(runState(db, spec.runId)).toBe("FAILED");
    expect(
      lifecycleOf(db, spec.runId).some((event) =>
        event.reason?.startsWith("retry:"),
      ),
    ).toBe(false);
  });

  test("filesystem failures after worktree_up remain typed workspace provisioning errors", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-link-collision-locks-");
    let executed = false;
    const observingAdapter = {
      async execute() {
        executed = true;
        return { exitCode: 0, timedOut: false };
      },
    };

    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-link-collision", ticket: "WM-734" },
      }),
    );
    const summary = await runOnce(
      db,
      registry,
      { fake: observingAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () => readyDispatchTicket("WM-734"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );

    expect(executed).toBe(false);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("workspace_provisioning_error");
    expect(summary.error).toContain(
      "worktree provisioning failed for wt-link-collision/WM-734",
    );
    expect(summary.error).toContain("EEXIST");
    expect(
      db
        .query(`SELECT reason_code FROM attempts WHERE run_id = ?`)
        .get(spec.runId).reason_code,
    ).toBe("workspace_provisioning_error");
  });

  test("worktree_up daemon startup failure surfaces serve.log in provisioning error message", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-crash-locks-");
    const observingAdapter = {
      async execute() {
        return { exitCode: 0, timedOut: false };
      },
    };

    const spec = queueRun(
      db,
      makeDispatchSpec({
        input: { repo: "wt-startup-crash", ticket: "WM-733" },
      }),
    );
    const summary = await runOnce(
      db,
      registry,
      { fake: observingAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          fetchTicket: () => readyDispatchTicket("WM-733"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
        },
      }),
    );

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("workspace_provisioning_error");
    expect(summary.error).toContain(
      "RegistryError: event type test: model_tier strong has no mapping",
    );
    expect(summary.error).toContain(
      "event runtime died during startup on 7400",
    );
  });

  test("rollback Linear ticket state to Todo on crash, timeout, and contract violation", async () => {
    const db = openDb(":memory:");
    const lockDir = tmpDir("evrt-rollback-locks-");
    const leaseDir = tmpDir("evrt-rollback-leases-");

    const rollbacks = [];
    const mockUnclaim = ({ repo, ticket, why }) => {
      rollbacks.push({ repo, ticket, why });
      return true;
    };

    // 1. Crash (exit code 1)
    const crashingAdapter = {
      async execute() {
        return { exitCode: 1, timedOut: false };
      },
    };
    const spec1 = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-740" } }),
    );
    const sum1 = await runOnce(
      db,
      registry,
      { fake: crashingAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          leasesDir: leaseDir,
          fetchTicket: () => readyDispatchTicket("WM-740"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
          unclaimTicket: mockUnclaim,
        },
      }),
    );
    expect(sum1.terminalState).toBe("FAILED");
    expect(rollbacks).toContainEqual(
      expect.objectContaining({ ticket: "WM-740", why: "agent_exit_1" }),
    );

    // 2. Timeout
    const timingOutAdapter = {
      async execute() {
        return { exitCode: 0, timedOut: true };
      },
    };
    const spec2 = queueRun(
      db,
      makeDispatchSpec({ input: { repo: "wt-worker", ticket: "WM-741" } }),
    );
    const sum2 = await runOnce(
      db,
      registry,
      { fake: timingOutAdapter },
      opts({
        dispatch: {
          locksDir: lockDir,
          leasesDir: leaseDir,
          fetchTicket: () => readyDispatchTicket("WM-741"),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
          unclaimTicket: mockUnclaim,
        },
      }),
    );
    expect(sum2.terminalState).toBe("TIMED_OUT");
    expect(rollbacks).toContainEqual(
      expect.objectContaining({ ticket: "WM-741", why: "timeout" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Dev live-reload: code stamp + drain-aware reload watcher (WM-213)
// ---------------------------------------------------------------------------

function stampRepo() {
  const root = tmpDir("evrt-stamp-");
  mkdirSync(path.join(root, "event-runtime", "lib", "adapters"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "event-runtime", "cli.mjs"),
    "// cli\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "event-runtime", "lib", "worker.mjs"),
    "// worker\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "event-runtime", "lib", "adapters", "fake.mjs"),
    "// fake\n",
    "utf8",
  );
  writeFileSync(path.join(root, "README.md"), "# outside the stamp\n", "utf8");
  return root;
}

describe("code stamp (WM-213)", () => {
  test("covers event-runtime/lib/** and cli.mjs, and nothing else", () => {
    const root = stampRepo();
    try {
      expect(codeStampFiles(root)).toEqual([
        "event-runtime/cli.mjs",
        "event-runtime/lib/adapters/fake.mjs",
        "event-runtime/lib/worker.mjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is stable across calls and changes on an uncommitted edit", () => {
    const root = stampRepo();
    try {
      const before = codeStamp(root);
      expect(codeStamp(root)).toBe(before);

      // No commit, no git at all — the stamp must still notice a working-tree edit.
      writeFileSync(
        path.join(root, "event-runtime", "lib", "worker.mjs"),
        "// worker v2\n",
        "utf8",
      );
      const after = codeStamp(root);
      expect(after).not.toBe(before);

      // A new file under lib/ counts too, and a file outside the paths does not.
      writeFileSync(
        path.join(root, "event-runtime", "lib", "new.mjs"),
        "// new\n",
        "utf8",
      );
      expect(codeStamp(root)).not.toBe(after);
      const withNew = codeStamp(root);
      writeFileSync(path.join(root, "README.md"), "# edited\n", "utf8");
      expect(codeStamp(root)).toBe(withNew);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree with no git still stamps (nogit), rather than throwing", () => {
    const root = stampRepo();
    try {
      expect(codeStamp(root).startsWith("nogit:")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY_CODE_STAMP_ROOT overrides the watched checkout", () => {
    const root = stampRepo();
    const previous = process.env.FACTORY_CODE_STAMP_ROOT;
    try {
      process.env.FACTORY_CODE_STAMP_ROOT = root;
      expect(codeStampRoot()).toBe(root);
      expect(codeStamp()).toBe(codeStamp(root));
    } finally {
      if (previous === undefined) delete process.env.FACTORY_CODE_STAMP_ROOT;
      else process.env.FACTORY_CODE_STAMP_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reload watcher (WM-213)", () => {
  /** Watcher over a stamp and clock the test drives by hand. */
  function harness(intervalMs = 1000) {
    let stamp = "a";
    let clock = 0;
    const watcher = createReloadWatcher({
      intervalMs,
      stamp: () => stamp,
      now: () => clock,
    });
    return {
      watcher,
      change: (to) => {
        stamp = to;
      },
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  test("unchanged code never reloads", () => {
    const h = harness();
    h.advance(5000);
    expect(h.watcher.check(null).action).toBe("none");
    expect(h.watcher.check("run_1").action).toBe("none");
  });

  test("re-stamps at most once per interval", () => {
    let calls = 0;
    const watcher = createReloadWatcher({
      intervalMs: 1000,
      stamp: () => {
        calls += 1;
        return "a";
      },
      now: () => 0,
    });
    expect(calls).toBe(1); // the startup stamp
    for (let i = 0; i < 20; i += 1) watcher.check(null);
    expect(calls).toBe(1); // the clock never moved, so nothing re-hashed
  });

  test("idle worker reloads, reporting old → new", () => {
    const h = harness();
    h.change("b");
    h.advance(1000);
    const r = h.watcher.check(null);
    expect(r.action).toBe("reload");
    expect(r.from).toBe("a");
    expect(r.to).toBe("b");
  });

  test("forced between-runs check detects a change before the normal interval (WM-613)", () => {
    const h = harness();
    h.change("b");
    h.advance(1);

    expect(h.watcher.check(null).action).toBe("none");
    expect(h.watcher.check(null, { force: true })).toMatchObject({
      action: "reload",
      from: "a",
      to: "b",
    });
  });

  test("in-flight run defers the reload, then reloads at the next idle check", () => {
    const h = harness();
    h.change("b");
    h.advance(1000);

    // Busy: deferred, and flagged `first` exactly once so the log says it once.
    const first = h.watcher.check("run_busy");
    expect(first).toMatchObject({
      action: "deferred",
      from: "a",
      to: "b",
      runId: "run_busy",
      first: true,
    });
    h.advance(1000);
    expect(h.watcher.check("run_busy")).toMatchObject({
      action: "deferred",
      first: false,
    });

    // The run finishes. The very next check reloads — no extra interval of wait,
    // because the pending change was latched rather than re-detected.
    expect(h.watcher.check(null)).toMatchObject({
      action: "reload",
      from: "a",
      to: "b",
    });
  });

  test("a change that reverts before the next check is never seen", () => {
    const h = harness();
    h.change("b");
    h.change("a");
    h.advance(1000);
    expect(h.watcher.check(null).action).toBe("none");
  });

  test("once latched, the pending stamp is not re-read", () => {
    let stamp = "a";
    let reads = 0;
    let clock = 0;
    const watcher = createReloadWatcher({
      intervalMs: 1000,
      stamp: () => {
        reads += 1;
        return stamp;
      },
      now: () => clock,
    });
    stamp = "b";
    clock += 1000;
    expect(watcher.check("run_busy").action).toBe("deferred");
    const afterLatch = reads;
    stamp = "c"; // a second edit while busy must not un-latch the reload
    clock += 5000;
    expect(watcher.check("run_busy").action).toBe("deferred");
    expect(watcher.check(null)).toMatchObject({ action: "reload", to: "b" });
    expect(reads).toBe(afterLatch);
  });

  test("CODE_RELOAD_EXIT is a code no ordinary worker exit uses", () => {
    expect(CODE_RELOAD_EXIT).toBe(75);
  });
});

describe("post-claim ticket command capture (GH-967)", () => {
  const description =
    "## Owned Paths\n- event-runtime/lib/worker.mjs\n\n" +
    "## Verification Command\n\n```bash\nbun test focused.test.mjs\n```\n";

  test("a Linear description hash is pinned from admission through post-claim capture", () => {
    const captured = ticketHandoffContext(
      "WM-967",
      () => ({ description }),
      "factory",
      { descriptionHash: hashJson(description) },
    );
    expect(captured).toMatchObject({
      ok: true,
      handoff: {
        verificationCommand: "bun test focused.test.mjs",
        descriptionHash: hashJson(description),
      },
    });

    const changed = ticketHandoffContext(
      "WM-967",
      () => ({ description: description.replace("focused", "attacker") }),
      "factory",
      { descriptionHash: hashJson(description) },
    );
    expect(changed.ok).toBe(false);
    expect(changed.reasonCode).toBe("ticket_body_changed_post_claim");
    expect(changed.handoff).toBeUndefined();
  });

  test("GitHub trust and ready pin are revalidated on the same read that captures the command", () => {
    let reads = 0;
    const fetchTicket = () => {
      reads += 1;
      return {
        description,
        controlPlaneKind: "github",
        authorAssociation: "OWNER",
        lastEditorAssociation: "MEMBER",
        readyPinHash: hashJson(description),
      };
    };
    expect(
      ticketHandoffContext("watt-mind/factory#967", fetchTicket, "factory", {
        descriptionHash: hashJson(description),
      }).ok,
    ).toBe(true);
    expect(reads).toBe(1);

    for (const override of [
      { lastEditorAssociation: "NONE" },
      { readyPinHash: null },
      { readyPinHash: hashJson("older body") },
    ]) {
      const rejected = ticketHandoffContext(
        "watt-mind/factory#967",
        () => ({
          description,
          controlPlaneKind: "github",
          authorAssociation: "OWNER",
          lastEditorAssociation: "MEMBER",
          readyPinHash: hashJson(description),
          ...override,
        }),
        "factory",
        { descriptionHash: hashJson(description) },
      );
      expect(rejected.ok).toBe(false);
      expect(rejected.handoff).toBeUndefined();
    }
  });

  test("an unavailable post-claim read fails closed without a command", () => {
    const result = ticketHandoffContext(
      "WM-967",
      () => {
        throw new Error("tracker unavailable");
      },
      "factory",
      { descriptionHash: hashJson(description) },
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: "ticket_post_claim_read_failed",
    });
    expect(result.handoff).toBeUndefined();
  });
});

describe("handoff verification gate (WM-718)", () => {
  let factoryRoot;
  let repoDir;
  let wtRoot;
  let previousReposRoot;

  const OWNED = "## Owned Paths\n- src/feature/**\n- event-runtime/web/**\n\n";
  const withCommand = (cmd) =>
    `${OWNED}## Verification Command\n\n\`\`\`\n${cmd}\n\`\`\`\n`;

  beforeAll(() => {
    factoryRoot = tmpDir("evrt-handoff-factory-");
    repoDir = tmpDir("evrt-handoff-repo-");
    wtRoot = tmpDir("evrt-handoff-trees-");
    mkdirSync(path.join(repoDir, "bin"), { recursive: true });
    // A real git worktree with an `origin/develop` ref, so the gate can diff
    // merge-base..HEAD exactly as it does for a repo-owned worktree_up.
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up.sh"),
      [
        "#!/bin/bash",
        "set -e",
        `WT="${wtRoot}/$1"`,
        'mkdir -p "$WT" && cd "$WT"',
        "git init -q -b develop",
        "git config user.email factory@test && git config user.name factory",
        "mkdir -p src/feature event-runtime/web/src",
        "echo base > src/feature/base.txt",
        `printf '%s\\n' '{"name":"web","private":true,"scripts":{"build":"echo web_built:$PWD"}}' > event-runtime/web/package.json`,
        "echo 'export const x = 1;' > event-runtime/web/src/index.ts",
        "git add -A && git commit -qm base",
        "git update-ref refs/remotes/origin/develop HEAD",
        'git checkout -qb "feat/$1"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down.sh"),
      `#!/bin/bash\nrm -rf "${wtRoot}/$1"\n`,
    );
    mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
    writeFileSync(path.join(factoryRoot, "config", "policy.yaml"), "{}\n");
    writeFileSync(
      path.join(factoryRoot, "config", "repos.yaml"),
      `repos:\n` +
        `  - name: wt-handoff\n    path: ${repoDir}\n    github: watt-mind/wt-handoff\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo repo_verified\n    escalate_paths: []\n` +
        `  - name: wt-handoff-noverify\n    path: ${repoDir}\n    github: watt-mind/wt-handoff-noverify\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    escalate_paths: []\n`,
    );
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = factoryRoot;
  });

  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });

  const setPolicy = (yaml) =>
    writeFileSync(path.join(factoryRoot, "config", "policy.yaml"), yaml);

  function handoffSpec({ repo = "wt-handoff", ticket }) {
    const runId = `run_handoff_${++seq}_${Math.random().toString(36).slice(2)}`;
    const input = { repo, ticket };
    return {
      schemaVersion: "factory.run-spec/v1",
      runId,
      agent: "dispatch@1",
      input,
      inputHash: hashJson(input),
      workspace: {
        type: "worktree",
        checkoutDir: "repo",
        retainOnFailure: true,
      },
      adapter: "fake",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.dispatch-result/v1",
      capabilities: ["tracker:write", "repo:write", "github:write"],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: `idem-${runId}`,
    };
  }

  /** A fake dispatch agent: writes files, commits, claims whatever it likes. */
  function agent({ files = {}, claim = {}, prNumber = 77 }) {
    return {
      async execute({ spec, workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, ".transcript.json"),
          `{"fake":"handoff transcript"}\n`,
        );
        const repo = path.join(workspaceDir, "repo");
        for (const [rel, content] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
          writeFileSync(path.join(repo, rel), content);
        }
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync(
          "git",
          ["commit", "-qm", `implement ${spec.input.ticket}`],
          {
            cwd: repo,
          },
        );
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          `${JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: {
              outcome: "PR_OPEN",
              repo: spec.input.repo,
              ticket: spec.input.ticket,
              prUrl: `https://github.com/watt-mind/${spec.input.repo}/pull/${prNumber}`,
              prNumber,
              verification: {
                command: "bash run-tests.sh",
                passed: true,
                output: "all green",
                ...claim,
              },
              summary: `implemented ${spec.input.ticket}`,
              uxCritique: {
                status: "skipped",
                verdict: null,
                evidence: [],
                rounds: 0,
                prReady: true,
              },
            },
            evidence: { commands: ["bash run-tests.sh"] },
          })}\n`,
        );
        return { exitCode: 0, timedOut: false };
      },
    };
  }

  async function dispatch({ spec, adapter, description, hooks = {} }) {
    const db = openDb(":memory:");
    queueRun(db, spec);
    const calls = { unclaim: [], returned: [], held: [], comments: [] };
    const summary = await runOnce(
      db,
      registry,
      { fake: adapter },
      opts({
        dispatch: {
          locksDir: tmpDir("evrt-handoff-locks-"),
          leasesDir: tmpDir("evrt-handoff-leases-"),
          fetchTicket: () => ({
            identifier: spec.input.ticket,
            state: { name: "Todo" },
            assignee: null,
            labels: { nodes: [{ name: "ai:agent-ready" }] },
            description,
          }),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
          unclaimTicket: (p) => (calls.unclaim.push(p), false),
          returnHandoffTicket: (p) => (calls.returned.push(p), true),
          holdPullRequest: (p) => (calls.held.push(p), true),
          commentTicket: (p) => (calls.comments.push(p), true),
          fetchHandoffPullRequest: () => ({ baseRefName: "develop" }),
          ...hooks,
        },
      }),
    );
    return { db, summary, calls };
  }

  test("a fake agent that leaves a failing test is refused handoff_verification_failed: no result row, ticket back to Todo + agent-ready, PR held, tail in the receipt", async () => {
    const spec = handoffSpec({ ticket: "WM-7181" });
    const { db, summary, calls } = await dispatch({
      spec,
      description: withCommand("bash run-tests.sh"),
      adapter: agent({
        files: {
          "src/feature/impl.txt": "done\n",
          "run-tests.sh":
            'echo "suite start"\necho "(fail) totals > rejects an invalid total"\necho "1 fail" >&2\nexit 1\n',
        },
      }),
    });

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("handoff_verification_failed");
    expect(summary.detail).toContain("ticket_verify_failed");
    expect(summary.handoff.verification.command).toBe("bash run-tests.sh");
    expect(summary.handoff.verification.exitCode).toBe(1);
    expect(summary.handoff.verification.tail).toContain(
      "(fail) totals > rejects an invalid total",
    );
    // The repo verify passed; the ticket's own command is what caught it.
    expect(summary.handoff.repoVerify.passed).toBe(true);

    // No PR_OPEN result was published — nothing downstream chains a review.
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`)
        .get(spec.runId).n,
    ).toBe(0);
    expect(
      db
        .query(`SELECT reason_code FROM attempts WHERE run_id = ?`)
        .get(spec.runId).reason_code,
    ).toBe("handoff_verification_failed");
    const journal = lifecycleOf(db, spec.runId)
      .map((row) => row.reason)
      .join("\n");
    expect(journal).toContain("(fail) totals > rejects an invalid total");
    expect(classifyFailureCause("handoff_verification_failed")).toBe(
      "agent_error",
    );

    // Ticket returned (Todo + agent-ready), never Blocked, never the plain unclaim.
    expect(calls.returned).toHaveLength(1);
    expect(calls.returned[0].ticket).toBe("WM-7181");
    expect(calls.returned[0].body).toContain(
      "## Handoff verification (worker-observed)",
    );
    expect(calls.returned[0].body).toContain(
      "(fail) totals > rejects an invalid total",
    );
    expect(calls.returned[0].body).toContain("Todo + ai:agent-ready");
    expect(calls.unclaim).toHaveLength(0);
    // The agent's PR is converted to draft with the observed failure quoted.
    expect(calls.held).toHaveLength(1);
    expect(calls.held[0]).toMatchObject({
      prNumber: 77,
      github: "watt-mind/wt-handoff",
    });
    expect(calls.held[0].body).toContain("exit 1 (FAIL)");
    expect(calls.comments).toHaveLength(0);
  });

  test("no Verification Command and no repo verify: refused handoff_verification_unspecified (fail-closed)", async () => {
    const spec = handoffSpec({
      repo: "wt-handoff-noverify",
      ticket: "WM-7182",
    });
    const { summary, calls } = await dispatch({
      spec,
      description: OWNED,
      adapter: agent({ files: { "src/feature/impl.txt": "done\n" } }),
    });
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("handoff_verification_unspecified");
    expect(calls.returned).toHaveLength(1);
    expect(calls.held).toHaveLength(1);
    expect(calls.returned[0].body).toContain("Verification: NONE");
  });

  test("without a Verification Command the repo verify stands in and the run completes with a worker-observed line", async () => {
    const spec = handoffSpec({ ticket: "WM-7183" });
    const { db, summary, calls } = await dispatch({
      spec,
      description: OWNED,
      adapter: agent({ files: { "src/feature/impl.txt": "done\n" } }),
    });
    expect(summary.terminalState).toBe("COMPLETED");
    const result = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(spec.runId).result_json,
    );
    expect(result.verification.checks).toContain("repo_verify_passed");
    expect(result.verification.checks).not.toContain("ticket_verify_passed");
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0].body).toContain(
      "- Verification: `echo repo_verified` — exit 0 (pass)",
    );
    expect(calls.comments[0].body).toContain("repo `verify:` command stood in");
  });

  test("a PR targeting the wrong base fails handoff verification and is returned", async () => {
    const spec = handoffSpec({ ticket: "WM-9381" });
    const { summary, calls } = await dispatch({
      spec,
      description: OWNED,
      adapter: agent({ files: { "src/feature/impl.txt": "done\n" } }),
      hooks: {
        fetchHandoffPullRequest: () => ({ baseRefName: "main" }),
      },
    });

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("handoff_verification_failed");
    expect(summary.detail).toContain(
      "PR #77 targets main, expected configured base develop",
    );
    expect(calls.held).toHaveLength(1);
    expect(calls.returned).toHaveLength(1);
  });

  test("a change under event-runtime/web/src/** runs the web build and a red build refuses the handoff", async () => {
    const description = withCommand("bash run-tests.sh");
    const files = {
      "run-tests.sh": "echo ok\n",
      "event-runtime/web/src/index.ts": "export const x: number = 2;\n",
    };
    // Green build: gate runs it (marker written) and records the check.
    const green = handoffSpec({ ticket: "WM-7184" });
    const g = await dispatch({
      spec: green,
      description,
      adapter: agent({ files }),
    });
    expect(g.summary.terminalState).toBe("COMPLETED");
    // The chroot maps the worktree at /workspace; when this suite itself runs
    // inside a handoff sandbox the command is passed through and keeps the
    // real path. Either way the build ran in the web directory, not the root.
    expect(g.summary.handoff.webBuild.tail).toContain(
      `web_built:${insideHandoffSandbox() ? "" : "/workspace"}`,
    );
    expect(g.summary.handoff.webBuild.tail).toContain("/event-runtime/web");
    const result = JSON.parse(
      g.db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(green.runId).result_json,
    );
    expect(result.verification.checks).toEqual(
      expect.arrayContaining(["ticket_verify_passed", "web_build_passed"]),
    );
    expect(g.calls.comments[0].body).toContain(
      "- Web build (event-runtime/web/src/** changed): `cd event-runtime/web && bun run build` — exit 0 (pass)",
    );

    // Red build (tsc-style error) even though the ticket's command is green.
    const red = handoffSpec({ ticket: "WM-7185" });
    const r = await dispatch({
      spec: red,
      description,
      adapter: agent({
        files: {
          ...files,
          "event-runtime/web/package.json":
            '{"name":"web","private":true,"scripts":{"build":"echo \'src/index.ts(1,14): error TS6133: unused local\' >&2; exit 2"}}\n',
        },
      }),
    });
    expect(r.summary.terminalState).toBe("FAILED");
    expect(r.summary.reasonCode).toBe("handoff_verification_failed");
    expect(r.summary.detail).toContain("web_build_failed");
    expect(r.summary.detail).toContain("error TS6133");
    expect(r.summary.handoff.webBuild.exitCode).toBe(2);
    expect(r.calls.held).toHaveLength(1);
    expect(r.calls.returned).toHaveLength(1);

    // No web/src change: the build is not run at all.
    const skip = handoffSpec({ ticket: "WM-7186" });
    const s = await dispatch({
      spec: skip,
      description,
      adapter: agent({
        files: { "run-tests.sh": "echo ok\n", "src/feature/x.txt": "x\n" },
      }),
    });
    expect(s.summary.terminalState).toBe("COMPLETED");
    expect(s.summary.handoff.webBuild).toBeNull();
    expect(s.calls.comments[0].body).toContain("- Web build: skipped");
  });

  test("the Handoff Verification line is worker-authored: the agent's 'pass' claim cannot override an observed red, and rides below labelled agent-reported", async () => {
    const description = withCommand("bash run-tests.sh");
    const failing = handoffSpec({ ticket: "WM-7187" });
    const f = await dispatch({
      spec: failing,
      description,
      adapter: agent({
        files: { "run-tests.sh": 'echo "regression in totals"; exit 3\n' },
        claim: {
          command: "bash run-tests.sh",
          passed: true,
          output: "pass, 2045 tests green",
        },
      }),
    });
    expect(f.summary.terminalState).toBe("FAILED");
    const body = f.calls.returned[0].body;
    const verificationLine = body
      .split("\n")
      .find((l) => l.startsWith("- Verification:"));
    expect(verificationLine).toBe(
      "- Verification: `bash run-tests.sh` — exit 3 (FAIL)",
    );
    expect(body).toContain("regression in totals");
    expect(body).toContain(
      "- agent-reported: `bash run-tests.sh` — pass, pass, 2045 tests green",
    );
    expect(body).not.toContain("- Verification: `bash run-tests.sh` — pass");

    // Green run: the line still comes from the worker's observation, and a
    // claim naming a different command is quoted only as agent-reported.
    const passing = handoffSpec({ ticket: "WM-7188" });
    const p = await dispatch({
      spec: passing,
      description,
      adapter: agent({
        files: { "run-tests.sh": 'echo "42 tests, 0 failures"\n' },
        claim: {
          command: "bun test --only-my-file",
          passed: true,
          output: "green",
        },
      }),
    });
    expect(p.summary.terminalState).toBe("COMPLETED");
    const okBody = p.calls.comments[0].body;
    expect(
      okBody.split("\n").find((l) => l.startsWith("- Verification:")),
    ).toBe("- Verification: `bash run-tests.sh` — exit 0 (pass)");
    expect(okBody).toContain("42 tests, 0 failures");
    expect(okBody).toContain(
      "- agent-reported: `bun test --only-my-file` — pass, green",
    );
  });

  test("Owned Paths deviations are computed from the diff: listed under advisory (default), refused under strict", async () => {
    const description = withCommand("bash run-tests.sh");
    const files = {
      "run-tests.sh": "echo ok\n",
      "src/feature/impl.txt": "done\n",
      "docs/stray.md": "out of scope reflow\n",
      "orchestrator/tick.mjs": "// out of scope\n",
    };
    setPolicy("{}\n"); // key absent → advisory
    const adv = handoffSpec({ ticket: "WM-7189" });
    const a = await dispatch({
      spec: adv,
      description,
      adapter: agent({ files }),
    });
    expect(a.summary.terminalState).toBe("COMPLETED");
    expect(a.summary.handoff.ownedPathsDeviations).toEqual([
      "docs/stray.md",
      "orchestrator/tick.mjs",
      "run-tests.sh",
    ]);
    const result = JSON.parse(
      a.db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(adv.runId).result_json,
    );
    expect(result.verification.checks).toContain(
      "owned_paths_deviations_advisory",
    );
    const body = a.calls.comments[0].body;
    expect(body).toContain("- Files: 4 changed vs origin/develop");
    expect(body).toContain("- Owned Paths deviations (advisory): 3 file(s)");
    expect(body).toContain("  - `docs/stray.md`");
    expect(body).toContain("  - `orchestrator/tick.mjs`");
    expect(body).toContain("  - `run-tests.sh`");
    expect(body).not.toContain("  - `src/feature/impl.txt`");

    setPolicy("dispatch:\n  owned_paths_conformance: strict\n");
    try {
      const strict = handoffSpec({ ticket: "WM-7190" });
      const s = await dispatch({
        spec: strict,
        description,
        adapter: agent({ files }),
      });
      expect(s.summary.terminalState).toBe("FAILED");
      expect(s.summary.reasonCode).toBe("handoff_owned_paths_violation");
      expect(s.summary.detail).toContain("docs/stray.md");
      expect(s.calls.returned).toHaveLength(1);
      expect(s.calls.held).toHaveLength(1);
      expect(s.calls.returned[0].body).toContain(
        "Owned Paths deviations (strict): 3 file(s)",
      );
    } finally {
      setPolicy("{}\n");
    }

    // Conformant diff: no deviations, the check is recorded.
    const clean = handoffSpec({ ticket: "WM-7191" });
    const c = await dispatch({
      spec: clean,
      description: `## Owned Paths\n- src/feature/**\n- run-tests.sh\n\n## Verification Command\n\n\`\`\`\nbash run-tests.sh\n\`\`\`\n`,
      adapter: agent({
        files: { "run-tests.sh": "echo ok\n", "src/feature/y.txt": "y\n" },
      }),
    });
    expect(c.summary.terminalState).toBe("COMPLETED");
    expect(c.calls.comments[0].body).toContain(
      "- Owned Paths deviations: none",
    );
  });
});

// The describe block above only exercises the handoff gate through mocked
// hooks (claimTicket/returnHandoffTicket/etc all stubbed by `dispatch()`).
// `defaultReturnHandoffTicket` is the one production path none of that
// touches, and it has a real bug shape: the combined
// state+unassign+removes+add-label Linear call can fail on the label half
// alone (WM-718 F2). These tests drive the real function with a `runCli`
// stub that fails on cue, never mocking the function itself.
describe("defaultReturnHandoffTicket (WM-718 F2)", () => {
  const COMBINED_ARGS = [
    "state",
    "WM-9001",
    "Todo",
    "--unassign",
    "--add",
    "ai:agent-ready",
    "--remove",
    "ai:in-progress",
    "--remove",
    "ai:needs-review",
  ];
  const BASE_ARGS = [
    "state",
    "WM-9001",
    "Todo",
    "--unassign",
    "--remove",
    "ai:in-progress",
    "--remove",
    "ai:needs-review",
  ];

  test("retries as two separate calls and restores ai:agent-ready when the combined call fails", () => {
    const calls = [];
    const runCli = (args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("linear: rate limited");
      return "";
    };
    const result = defaultReturnHandoffTicket({
      ticket: "WM-9001",
      body: "handoff refused",
      fetchTicket: () => ({ state: { name: "In Review" } }),
      runCli,
    });
    expect(result).toEqual({
      ok: true,
      agentReadyRestored: true,
      warning: null,
    });
    // The first (failed) combined attempt, then the state move split from
    // the label add, then the comment — never a silent drop of the label.
    expect(calls).toEqual([
      COMBINED_ARGS,
      BASE_ARGS,
      ["labels", "WM-9001", "--add", "ai:agent-ready"],
      ["comment", "WM-9001", "handoff refused"],
    ]);
  });

  test("surfaces the failure loudly when the label restore also fails", () => {
    const calls = [];
    const runCli = (args) => {
      calls.push([...args]);
      if (args[0] === "state" && args.includes("--add")) {
        throw new Error("combined call failed");
      }
      if (args[0] === "labels") {
        throw new Error("labels endpoint down");
      }
      return "";
    };
    const loud = [];
    const originalConsoleError = console.error;
    console.error = (...args) => loud.push(args.join(" "));
    let result;
    try {
      result = defaultReturnHandoffTicket({
        ticket: "WM-9001",
        body: "handoff refused",
        fetchTicket: () => ({ state: { name: "In Progress" } }),
        runCli,
      });
    } finally {
      console.error = originalConsoleError;
    }
    // Never silent: the run's own return value says so...
    expect(result.ok).toBe(true);
    expect(result.agentReadyRestored).toBe(false);
    expect(result.warning).toContain("labels endpoint down");
    // ...the worker's own log says so...
    expect(
      loud.some((line) => line.includes("ai:agent-ready NOT restored")),
    ).toBe(true);
    // ...and the ticket itself still moved to Todo (unassigned, un-labeled)
    // rather than being stranded In Progress/In Review.
    expect(calls).toContainEqual(BASE_ARGS);
    const commentCall = calls.find((c) => c[0] === "comment");
    expect(commentCall).toBeDefined();
    expect(commentCall[2]).toContain("ai:agent-ready NOT restored");
  });

  test("is a no-op when the ticket already left In Progress/In Review", () => {
    const calls = [];
    const result = defaultReturnHandoffTicket({
      ticket: "WM-9001",
      body: "handoff refused",
      fetchTicket: () => ({ state: { name: "Done" } }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// `defaultUnclaimTicket` is the worker's NOT_CLAIMED release: when a dispatch
// run never reached handoff (the claim was lost, or the run failed while the
// ticket still sat In Progress), the slot has to go back on the board. The
// bug this guards (WM-1024) was that dropping `ai:in-progress` and stopping
// left the ticket `Todo`/unassigned but WITHOUT `ai:agent-ready` — the board
// read Todo, yet the dispatch predicate (Todo + ai:agent-ready + unassigned)
// never matched again, so nothing redispatched it. These drive the real
// function through injected `fetchTicket`/`runCli` seams, never mocking it.
describe("defaultUnclaimTicket (NOT_CLAIMED release)", () => {
  test("restores Todo + ai:agent-ready, strips ai:in-progress and the stale agent label", () => {
    const calls = [];
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: {
          nodes: [{ name: "ai:in-progress" }, { name: "agent:claude-code" }],
        },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(true);
    // The state move re-adds ai:agent-ready (so the ticket is dispatchable
    // again), unassigns, and strips the lifecycle + stale agent labels.
    expect(calls[0]).toEqual([
      "state",
      "WM-9001",
      "Todo",
      "--unassign",
      "--add",
      "ai:agent-ready",
      "--remove",
      "ai:in-progress",
      "--remove",
      "ai:blocked",
      "--remove",
      "agent:claude-code",
    ]);
    // ...and a comment records the release and its cause.
    const comment = calls.find((c) => c[0] === "comment");
    expect(comment).toBeDefined();
    expect(comment[2]).toContain("released back to Todo + ai:agent-ready");
    expect(comment[2]).toContain("ticket_claim_lost");
  });

  test("folds an absolute log path down to ~ in the release comment", () => {
    const calls = [];
    defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "agent_exit_1",
      log: `${homedir()}/.factory/runs/run-9001.log`,
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: { nodes: [{ name: "ai:in-progress" }] },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    const comment = calls.find((c) => c[0] === "comment");
    expect(comment[2]).toContain("~/.factory/runs/run-9001.log");
    expect(comment[2]).not.toContain(homedir());
  });

  test("is a no-op when the ticket is no longer In Progress", () => {
    const calls = [];
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "Todo" },
        labels: { nodes: [{ name: "ai:agent-ready" }] },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("is a no-op when In Progress but the ai:in-progress label is already gone", () => {
    const calls = [];
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: { nodes: [{ name: "agent:claude-code" }] },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("swallows a mutation failure and reports false rather than throwing", () => {
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: { nodes: [{ name: "ai:in-progress" }] },
      }),
      runCli: () => {
        throw new Error("linear: rate limited");
      },
    });
    expect(result).toBe(false);
  });
});

// ------------------------------------------ liveness-ceiling invariant ---
// WM-1025. Same shape as the GQL_IMPORT_ALLOWED grep invariant in
// tools/linear.test.mjs: the bug was not that 5s is the wrong number, it was
// that these call sites bypassed the load-adjustment mechanism the repo
// already had. A number typed inline cannot scale, and the next one typed
// inline will not either — so guard the pattern, not the value.
describe("subprocess liveness ceilings scale with host load (WM-1025)", () => {
  const SOURCES = [
    "event-runtime/lib/worker.test.mjs",
    "event-runtime/work.test.mjs",
    "event-runtime/cli/process-cleanup.test.mjs",
  ];

  test("no raw sub-30s timeoutMs literal bypasses loadAdjustedTimeout", () => {
    const root = path.resolve(import.meta.dir, "..", "..");
    const offenders = [];
    for (const rel of SOURCES) {
      const file = path.join(root, rel);
      if (!existsSync(file)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // `timeoutMs: 25` style intentional-hang probes are far below the
          // range that host contention affects; only flag plausible liveness
          // ceilings (1s..30s) written as bare literals.
          const m = line.match(/timeoutMs:\s*([0-9][0-9_]*)\s*,/);
          if (!m) return;
          const ms = Number(m[1].replace(/_/g, ""));
          if (ms < 1_000 || ms > 30_000) return;
          if (line.includes("loadAdjustedTimeout")) return;
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("the execute-side ceiling actually scales", () => {
    // Guards the wiring itself: a constant that ignores CI_LOAD_FACTOR would
    // satisfy the grep above while still pinning the timeout at 5s.
    expect(EXECUTE_SPAWN_TIMEOUT_MS).toBe(loadAdjustedTimeout(5_000));
    expect(EXECUTE_SPAWN_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  test("process-cleanup polling waits scale their caller-provided ceilings", () => {
    const root = path.resolve(import.meta.dir, "..", "..");
    const source = readFileSync(
      path.join(root, "event-runtime/cli/process-cleanup.test.mjs"),
      "utf8",
    );
    for (const name of ["waitForFile", "waitForExit"]) {
      expect(source).toMatch(
        new RegExp(
          `async function ${name}\\([^)]*timeoutMs[^)]*\\)\\s*\\{\\s*timeoutMs = loadAdjustedTimeout\\(timeoutMs\\);`,
        ),
      );
    }
  });
});
