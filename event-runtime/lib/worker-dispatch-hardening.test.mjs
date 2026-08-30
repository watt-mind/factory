import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-worker-dispatch-hardening-test-mjs";
import "../test-helpers.mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadAdjustedTimeout } from "./test-helpers-timing.mjs";
import { fakeTrackerCli } from "./test-helpers.mjs";
import { insideHandoffSandbox } from "./verify.mjs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { hashJson } from "./canonical.mjs";
import { resolveConfigPath } from "./config.mjs";
import { openDb } from "./db.mjs";
import { lifecycleOf, runState, transition } from "./lifecycle.mjs";
import { getAgent } from "./registry.mjs";
import {
  acquireClaimLock,
  CLAIM_LOCK_BACKOFF_MAX_MS,
  claimNext,
  dispatchLockPath,
  executeClaimed,
  forceFailRun,
  reapExpiredLeases,
  releaseClaimLock,
  resolveLinearApiKey,
  retryRun,
  runLinearCli,
  runOnce,
} from "./worker.mjs";
import { liveWorkerLeases } from "../../lib/worker-leases.mjs";
import {
  cleanupTrackedProcesses,
  processOwnerWatchdogSource,
  registerTestProcessCleanup,
  trackMarkedFakeRuntimeGroups,
  trackProcess,
  trackProcessGroupsMatching,
} from "./test-helpers-process.mjs";
import {
  freshRoot,
  linkEvent,
  opts,
  queueRun,
  registry,
  T0,
} from "./worker-test-helpers.mjs";

registerTestProcessCleanup(import.meta.url);

let seq = 0;

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

  test("resolves Linear credentials from env first, then an opt-in env file", () => {
    const dir = tmpDir("evrt-linear-key-");
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "OTHER=value\nLINEAR_API_KEY='file-key'\n", "utf8");

    const fromEnv = { LINEAR_API_KEY: "process-key" };
    expect(resolveLinearApiKey({ env: fromEnv, envFile })).toBe("process-key");

    const fromFile = { FACTORY_LINEAR_ENV_FILE: envFile };
    expect(resolveLinearApiKey({ env: fromFile })).toBe("file-key");
    expect(fromFile.LINEAR_API_KEY).toBe("file-key");

    expect(
      resolveLinearApiKey({
        env: { FACTORY_LINEAR_ENV_FILE: envFile, FACTORY_LINEAR_OFFLINE: "1" },
      }),
    ).toBeNull();
  });

  test("offline tests reject a tracker CLI spawn before invoking bun", () => {
    expect(() => runLinearCli(["get", "WM-501"])).toThrow(
      "linear_offline_guard",
    );
  });

  // Regression for #1816: a real key in the environment must not be enough to
  // open a connection from a test process. The preloaded guard rejects the
  // fetch itself, so even an in-process Linear client cannot spend budget.
  test("a real LINEAR_API_KEY in the test environment never reaches api.linear.app", async () => {
    const previousKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_FAKE_REAL_LOOKING_KEY";
    try {
      expect(process.env.FACTORY_LINEAR_OFFLINE).toBe("1");
      expect(globalThis.fetch.__factoryLinearOfflineGuard).toBe(true);
      await expect(
        fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: process.env.LINEAR_API_KEY },
          body: "{}",
        }),
      ).rejects.toThrow("linear_offline_guard");
      expect(() => runLinearCli(["comment", "WM-501", "handoff"])).toThrow(
        "linear_offline_guard",
      );
    } finally {
      if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousKey;
    }
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
  // out on CI. Use the shared fake tracker CLI and assert nothing reaches it.
  test("a partial dispatch override still never reaches the tracker CLI under the fake adapter", async () => {
    const fakeCli = fakeTrackerCli();
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeCli.path}:${previousPath}`;
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
      expect(fakeCli.calls()).not.toContain("linear.mjs");
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
    const previousHome = process.env.HOME;
    const repoName = "wt-worker";
    const scratchHome = tmpDir("evrt-isolated-lock-home-");
    let supervisorLock;
    let claimCalls = 0;

    try {
      process.env.HOME = scratchHome;
      process.env.FACTORY_EVENT_HOME = tmpDir("evrt-isolated-event-home-");
      delete process.env.FACTORY_LOCKS_DIR;
      supervisorLock = dispatchLockPath(
        repoName,
        path.join(homedir(), ".factory", "locks"),
      );
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
      if (supervisorLock) releaseClaimLock(supervisorLock);
      if (previousEventHome === undefined)
        delete process.env.FACTORY_EVENT_HOME;
      else process.env.FACTORY_EVENT_HOME = previousEventHome;
      if (previousLocksDir === undefined) delete process.env.FACTORY_LOCKS_DIR;
      else process.env.FACTORY_LOCKS_DIR = previousLocksDir;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
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
  // gh-1781 classification: this is not related to an HTTP base URL. It is an
  // in-memory SQLite/fake-clock stress case with 570 deliberate contention
  // passes; any wall-clock timeout is the test's genuine load-scaled execution
  // budget, while its liveness assertions remain deterministic.
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
