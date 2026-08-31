import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-planner-test-mjs";
import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import path from "node:path";
import { canonicalJson, hashBytes, hashJson } from "./canonical.mjs";
import {
  artifactsRoot,
  DEAD_LETTER_AFTER,
  DEFAULT_MAX_IN_FLIGHT,
} from "./config.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { createRun, lifecycleOf, runState, transition } from "./lifecycle.mjs";
import {
  buildEscalatedContinuationSpec,
  buildRunSpec,
  createLinearReadCache,
  modelAdapterMismatch,
  DEFAULT_MAX_IN_FLIGHT as PLANNER_DEFAULT_MAX_IN_FLIGHT,
  idempotencyKeyFor,
  LINEAR_READ_TIMEOUT_MS,
  pinMemos,
  planAdmittedEvents,
  planEvent,
  policyDispatchPaused,
  policyMaxConcurrentMerges,
  policyMergeBatchSize,
  wrapLinearReads,
  worktreeDispatchAutoEligibility,
  worktreeDispatchGate,
  worktreeMergeFixEligibility,
} from "./planner.mjs";
import {
  RegistryError,
  loadRegistry,
  validateMemosDeclaration,
} from "./registry.mjs";
import {
  MEMO_SCHEMA_VERSION,
  memoDigest,
  registerMemos,
  withProvenance,
} from "./memos.mjs";
import { computeDefHash } from "./receipts.mjs";
import { LinearRateLimitError } from "../../tools/ticket.mjs";
import {
  KIND_AGENT,
  KIND_EVENT_TYPE,
  deleteOverride,
  putOverride,
} from "./runtime-overrides.mjs";

const registry = loadRegistry();
const NOW = Date.parse("2026-08-12T10:30:02Z");

function envelope(overrides = {}) {
  return {
    schemaVersion: "factory.event/v1",
    eventId: "delivery-1",
    type: "factory.status-report.requested",
    source: "operator-webhook",
    subject: "factory",
    occurredAt: "2026-08-12T10:30:00Z",
    correlationId: "workflow-01",
    causationId: null,
    payload: { repos: ["bj29"] },
    ...overrides,
  };
}

function admit(db, overrides = {}, now = NOW) {
  const result = admitEvent(db, registry, envelope(overrides), { now });
  expect(result.admitted).toBe(true);
  return { source: result.event.source, eventId: result.event.event_id };
}

describe("idempotencyKeyFor", () => {
  const def = registry.agents.get("factory-status-report@1");
  const mapping = registry.eventTypes["factory.status-report.requested"];

  test("deterministic: same inputs, same key, always", () => {
    const inputHash = hashJson({ repos: ["bj29"] });
    const a = idempotencyKeyFor(mapping, def, envelope(), inputHash);
    const b = idempotencyKeyFor(mapping, def, envelope(), inputHash);
    expect(a).toBe(b);
    expect(a).toBe(
      `factory-status-report@1:factory.status-report/v1:workflow-01:${inputHash}`,
    );
  });

  test("correlationId scope falls back to eventId; subject scope to empty string", () => {
    const inputHash = hashJson({ repos: ["bj29"] });
    const noCorrelation = envelope({ correlationId: null });
    expect(idempotencyKeyFor(mapping, def, noCorrelation, inputHash)).toBe(
      `factory-status-report@1:factory.status-report/v1:delivery-1:${inputHash}`,
    );
    const subjectScope = { idempotencyScope: ["subject"] };
    expect(
      idempotencyKeyFor(
        subjectScope,
        def,
        envelope({ subject: null }),
        inputHash,
      ),
    ).toBe("factory-status-report@1:factory.status-report/v1:");
  });

  test("unknown scope field throws (fail closed)", () => {
    expect(() =>
      idempotencyKeyFor(
        { idempotencyScope: ["deliveryColor"] },
        def,
        envelope(),
        "sha256:x",
      ),
    ).toThrow(/unknown idempotency scope/);
  });
});

describe("DEFAULT_MAX_IN_FLIGHT (WM-755)", () => {
  test("planner re-exports the config binding so callers keep working", () => {
    expect(PLANNER_DEFAULT_MAX_IN_FLIGHT).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(DEFAULT_MAX_IN_FLIGHT).toBe(3);
  });
});

describe("merge concurrency policy", () => {
  test("reads a positive integer max_concurrent_merges and fails safe otherwise", () => {
    const root = tmpDir("evrt-merge-policy-");
    mkdirSync(path.join(root, "config"));
    const policy = path.join(root, "config", "policy.yaml");

    writeFileSync(policy, "concurrency:\n  max_concurrent_merges: 2\n");
    expect(policyMaxConcurrentMerges(root)).toBe(2);

    for (const invalid of ["0", "1.5", "many"]) {
      writeFileSync(
        policy,
        `concurrency:\n  max_concurrent_merges: ${invalid}\n`,
      );
      expect(policyMaxConcurrentMerges(root)).toBe(1);
    }
  });

  test("reads a positive integer merge.batch_size and fails safe to 4 otherwise", () => {
    const root = tmpDir("evrt-merge-batch-");
    mkdirSync(path.join(root, "config"));
    const policy = path.join(root, "config", "policy.yaml");

    writeFileSync(policy, "merge:\n  batch_size: 6\n");
    expect(policyMergeBatchSize(root)).toBe(6);
    expect(policyMergeBatchSize(tmpDir("evrt-merge-batch-missing-"))).toBe(4);

    for (const invalid of ["0", "1.5", "many"]) {
      writeFileSync(policy, `merge:\n  batch_size: ${invalid}\n`);
      expect(policyMergeBatchSize(root)).toBe(4);
    }
  });
});

describe("planEvent", () => {
  test("pins workspace-only intent into the RunSpec for the execute-time admission backstop (#962)", () => {
    const db = openDb(":memory:");
    const ref = admit(db, {
      eventId: "workspace-only-pin",
      correlationId: "workspace-only-pin",
    });
    const outcome = planEvent(db, registry, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(outcome.decision).toBe("run");
    expect(JSON.parse(outcome.proposal.spec_json).filesystem).toBe(
      "workspace-only",
    );
  });

  test("run decision: PROPOSED run + open proposal with the §5.2 spec", () => {
    const db = openDb(":memory:");
    const ref = admit(db);
    const outcome = planEvent(db, registry, ref, {
      now: NOW,
      policyVersion: "git:test",
    });

    expect(outcome.decision).toBe("run");
    expect(runState(db, outcome.runId)).toBe("PROPOSED");
    expect(outcome.proposal.status).toBe("open");
    expect(outcome.proposal.decision).toBe("run");
    expect(outcome.proposal.ttl_seconds).toBe(1800);

    const payload = { repos: ["bj29"] };
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec).toEqual({
      schemaVersion: "factory.run-spec/v1",
      runId: outcome.runId,
      agent: "factory-status-report@1",
      input: payload,
      inputHash: hashJson(payload),
      workspace: { type: "ephemeral", retainOnFailure: true },
      adapter: "pi",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.status-report/v1",
      // Attested definition pin (WM-1056): the content sha256 of the
      // registered agent def, the same value worker claim-time
      // verifyDefHash consumes.
      defHash: computeDefHash(registry.agents.get("factory-status-report@1")),
      capabilities: ["tracker:read"],
      filesystem: "workspace-only",
      // Model-tier routing (WM-135): the committed definition declares
      // standard, policy maps it to models.pi.standard (WM-215 made pi the
      // default harness), and the planner pins the resolution.
      modelTier: "standard",
      model: "openai-codex/gpt-5.6-terra",
      timeoutSeconds: 600,
      maxAttempts: 1,
      idempotencyKey: `factory-status-report@1:factory.status-report/v1:workflow-01:${hashJson(payload)}`,
    });

    const event = db
      .query(`SELECT status FROM events WHERE source = ? AND event_id = ?`)
      .get(ref.source, ref.eventId);
    expect(event.status).toBe("planned");
    expect(lifecycleOf(db, outcome.runId).map((e) => e.to_state)).toEqual([
      "PROPOSED",
    ]);
    expect(lifecycleOf(db, outcome.runId)[0].actor).toBe("planner");
  });

  test("planning the same event twice is idempotent: one run, one proposal", () => {
    const db = openDb(":memory:");
    const ref = admit(db);
    const first = planEvent(db, registry, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    const second = planEvent(db, registry, ref, {
      now: NOW + 60_000,
      policyVersion: "git:test",
    });
    expect(second.decision).toBe("run");
    expect(second.runId).toBe(first.runId);
    expect(second.proposal.id).toBe(first.proposal.id);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(1);
  });

  test("duplicate delivery converges on one run: same correlationId + payload → noop (§15 exit criterion)", () => {
    const db = openDb(":memory:");
    const ref1 = admit(db, { eventId: "delivery-1" });
    const ref2 = admit(db, { eventId: "delivery-2" });
    const first = planEvent(db, registry, ref1, {
      now: NOW,
      policyVersion: "git:test",
    });
    const second = planEvent(db, registry, ref2, {
      now: NOW + 1000,
      policyVersion: "git:test",
    });

    expect(first.decision).toBe("run");
    expect(second.decision).toBe("noop");
    expect(second.reason).toBe("duplicate_run");
    expect(second.runId).toBe(first.runId);
    expect(second.proposal.run_id).toBe(first.runId);
    expect(second.proposal.status).toBe("resolved");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'`)
        .get().n,
    ).toBe(1);
    const event = db
      .query(`SELECT status FROM events WHERE event_id = 'delivery-2'`)
      .get();
    expect(event.status).toBe("noop");
  });

  test("GitHub CI bursts retain one trailing scan only behind an executing merge scan", () => {
    const db = openDb(":memory:");
    const webhook = (eventId, repo = "factory") => ({
      eventId,
      type: "factory.merge.requested",
      source: "github",
      subject: repo,
      correlationId: eventId,
      payload: { repo },
    });
    const firstRef = admit(db, webhook("check-1"));
    const first = planEvent(db, registry, firstRef, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(first.decision).toBe("run");

    const whileProposed = planEvent(
      db,
      registry,
      admit(db, webhook("check-proposed")),
      { now: NOW + 1000, policyVersion: "git:test" },
    );
    expect(whileProposed).toMatchObject({
      decision: "noop",
      runId: first.runId,
      reason: "webhook_merge_scan_pending",
    });
    expect(whileProposed.proposal.status).toBe("resolved");
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(2);

    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }

    const queued = planEvent(db, registry, admit(db, webhook("check-2")), {
      now: NOW + 1000,
      policyVersion: "git:test",
    });
    expect(queued).toMatchObject({
      decision: "noop",
      runId: first.runId,
      reason: "webhook_merge_scan_already_live",
    });
    expect(queued.proposal.status).toBe("resolved");
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(2);

    for (const eventId of ["check-3", "check-4", "check-5"]) {
      const next = planEvent(db, registry, admit(db, webhook(eventId)), {
        now: NOW + 1000,
        policyVersion: "git:test",
      });
      expect(next).toEqual({
        decision: "noop",
        runId: first.runId,
        reason: "webhook_merge_scan_already_live",
      });
    }
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(2);

    for (const to of ["VERIFYING", "COMPLETED"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }

    expect(
      planAdmittedEvents(db, registry, {
        now: NOW + 2000,
        policyVersion: "git:test",
      }),
    ).toEqual({ planned: 1, failed: 0, deadLettered: 0 });
    const trailing = db
      .query(`SELECT status FROM events WHERE event_id = 'check-2'`)
      .get();
    expect(trailing.status).toBe("planned");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(3);

    const trailingRun = db
      .query(
        `SELECT run_id FROM proposals WHERE event_id = 'check-2' AND decision = 'run'`,
      )
      .get();
    for (const to of [
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]) {
      transition(db, { runId: trailingRun.run_id, to, actor: "test" });
    }

    const clockRef = admit(db, {
      eventId: "clock:merge-factory:2026-08-12T10:30:00.000Z",
      type: "factory.merge.requested",
      source: "schedule",
      subject: "factory",
      correlationId: "clock:merge-factory:2026-08-12T10:30:00.000Z",
      payload: {
        repo: "factory",
        loop: "merge-factory",
        slot: "2026-08-12T10:30:00.000Z",
        cadenceSeconds: 14400,
        skippedSlots: 0,
      },
    });
    const clock = planEvent(db, registry, clockRef, {
      now: NOW + 2000,
      policyVersion: "git:test",
    });
    expect(clock.decision).toBe("run");

    for (const to of [
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]) {
      transition(db, { runId: clock.runId, to, actor: "test" });
    }

    const other = planEvent(
      db,
      registry,
      admit(db, webhook("other-check", "bj29")),
      { now: NOW + 3000, policyVersion: "git:test" },
    );
    expect(other.decision).toBe("run");
    expect(other.runId).not.toBe(first.runId);
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(5);
  });

  test("never-executed merge scans retain one webhook delivery only when refused or cancelled", () => {
    const webhook = (eventId) => ({
      eventId,
      type: "factory.merge.requested",
      source: "github",
      subject: "factory",
      correlationId: eventId,
      payload: { repo: "factory" },
    });
    const queueScan = (db, eventId) => {
      const first = planEvent(db, registry, admit(db, webhook(eventId)), {
        now: NOW,
        policyVersion: "git:test",
      });
      for (const to of ["APPROVED", "QUEUED"]) {
        transition(db, { runId: first.runId, to, actor: "test" });
      }
      return first;
    };
    const coalesceTwoDeliveries = (db, suffix, runId) => {
      for (const eventId of [`${suffix}-1`, `${suffix}-2`]) {
        expect(
          planEvent(db, registry, admit(db, webhook(eventId)), {
            now: NOW + 1000,
            policyVersion: "git:test",
          }),
        ).toMatchObject({
          decision: "noop",
          runId,
          reason: "webhook_merge_scan_pending",
        });
      }
      expect(
        db
          .query(
            `SELECT COUNT(*) AS n FROM proposals
             WHERE run_id = ? AND reason = 'webhook_merge_scan_pending'`,
          )
          .get(runId).n,
      ).toBe(1);
    };

    // A queued scan cancelled before any worker leased it never read GitHub:
    // the retained pending delivery is re-admitted and plans a fresh scan.
    {
      const db = openDb(":memory:");
      const first = queueScan(db, "cancelled-first");
      coalesceTwoDeliveries(db, "cancelled", first.runId);
      transition(db, { runId: first.runId, to: "CANCELLED", actor: "test" });

      expect(
        planAdmittedEvents(db, registry, {
          now: NOW + 2000,
          policyVersion: "git:test",
        }),
      ).toEqual({ planned: 1, failed: 0, deadLettered: 0 });
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);
      expect(
        db
          .query(`SELECT status FROM events WHERE event_id = ?`)
          .get("cancelled-1").status,
      ).toBe("planned");
      expect(
        db
          .query(`SELECT status FROM events WHERE event_id = ?`)
          .get("cancelled-2").status,
      ).toBe("noop");
    }

    // REFUSED is only reachable from VERIFYING, i.e. the scan executed and
    // read current GitHub state; a pending marker must not re-arm a trailing
    // scan for it. Same for the executed COMPLETED path.
    for (const terminal of ["REFUSED", "COMPLETED"]) {
      const db = openDb(":memory:");
      const suffix = terminal.toLowerCase();
      const first = queueScan(db, `${suffix}-first`);
      coalesceTwoDeliveries(db, suffix, first.runId);
      for (const to of ["LEASED", "RUNNING", "VERIFYING", terminal]) {
        transition(db, { runId: first.runId, to, actor: "test" });
      }

      expect(
        planAdmittedEvents(db, registry, {
          now: NOW + 2000,
          policyVersion: "git:test",
        }),
      ).toEqual({ planned: 0, failed: 0, deadLettered: 0 });
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
      for (const eventId of [`${suffix}-1`, `${suffix}-2`]) {
        expect(
          db.query(`SELECT status FROM events WHERE event_id = ?`).get(eventId)
            .status,
        ).toBe("noop");
      }
    }
  });

  test("repeat remediations with identical payload but distinct correlationId produce distinct runs (OPS-419)", () => {
    const db = openDb(":memory:");
    const ref1 = admit(db, {
      eventId: "keep-1",
      correlationId: "alert-1",
      type: "keephq.disk-remediate.requested",
      payload: {
        host: "lab",
        mount: "/",
        actions: [{ action: "docker-builder-prune" }],
      },
    });
    const ref2 = admit(db, {
      eventId: "keep-2",
      correlationId: "alert-2",
      type: "keephq.disk-remediate.requested",
      payload: {
        host: "lab",
        mount: "/",
        actions: [{ action: "docker-builder-prune" }],
      },
    });

    const first = planEvent(db, registry, ref1, {
      now: NOW,
      policyVersion: "git:test",
    });
    const second = planEvent(db, registry, ref2, {
      now: NOW + 1000,
      policyVersion: "git:test",
    });

    expect(first.decision).toBe("run");
    expect(second.decision).toBe("run");
    expect(second.runId).not.toBe(first.runId);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);
  });

  test("duplicate delivery of remediation with same correlationId converges to one run (OPS-419)", () => {
    const db = openDb(":memory:");
    const ref1 = admit(db, {
      eventId: "keep-1",
      correlationId: "alert-1",
      type: "keephq.disk-remediate.requested",
      payload: {
        host: "lab",
        mount: "/",
        actions: [{ action: "docker-builder-prune" }],
      },
    });
    const ref2 = admit(db, {
      eventId: "keep-dup",
      correlationId: "alert-1",
      type: "keephq.disk-remediate.requested",
      payload: {
        host: "lab",
        mount: "/",
        actions: [{ action: "docker-builder-prune" }],
      },
    });

    const first = planEvent(db, registry, ref1, {
      now: NOW,
      policyVersion: "git:test",
    });
    const second = planEvent(db, registry, ref2, {
      now: NOW + 1000,
      policyVersion: "git:test",
    });

    expect(first.decision).toBe("run");
    expect(second.decision).toBe("noop");
    expect(second.reason).toBe("duplicate_run");
    expect(second.runId).toBe(first.runId);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
  });

  test("chain repeat triggers coalesce while active and self-feed again after terminal completion (WM-319)", () => {
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
    };
    synthetic.eventTypes["test.chain.requested"] = {
      agent: "test-chain@1",
      adapter: "fake",
      idempotencyScope: ["inputHash"],
    };
    synthetic.agents.set("test-chain@1", {
      id: "test-chain",
      version: 1,
      ref: "test-chain@1",
      output_contract: "factory.test/v1",
      workspace: { type: "ephemeral" },
      capabilities: { services: [] },
      limits: { timeout_seconds: 60, attempts: 1 },
      mutating: false,
      inputSchema: { type: "object" },
    });

    const chainEvent = (eventId, causationId) => ({
      eventId,
      type: "test.chain.requested",
      source: "chain",
      subject: "factory",
      correlationId: "lineage-001",
      causationId,
      payload: { repo: "factory" },
    });
    const db = openDb(":memory:");

    const firstRef = admit(
      db,
      chainEvent("chain-dispatch-1", "run_dispatch_1"),
    );
    const first = planEvent(db, synthetic, firstRef, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(first.decision).toBe("run");

    const concurrentRef = admit(
      db,
      chainEvent("chain-dispatch-2", "run_dispatch_2"),
    );
    const concurrent = planEvent(db, synthetic, concurrentRef, {
      now: NOW + 1000,
      policyVersion: "git:test",
    });
    expect(concurrent).toMatchObject({
      decision: "noop",
      reason: "duplicate_run",
      runId: first.runId,
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);

    for (const to of [
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }

    const nextCycleRef = admit(
      db,
      chainEvent("chain-dispatch-3", "run_dispatch_3"),
    );
    const nextCycle = planEvent(db, synthetic, nextCycleRef, {
      now: NOW + 2000,
      policyVersion: "git:test",
    });
    expect(nextCycle.decision).toBe("run");
    expect(nextCycle.runId).not.toBe(first.runId);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);

    const coalescedAgainRef = admit(
      db,
      chainEvent("chain-dispatch-4", "run_dispatch_4"),
    );
    const coalescedAgain = planEvent(db, synthetic, coalescedAgainRef, {
      now: NOW + 3000,
      policyVersion: "git:test",
    });
    expect(coalescedAgain).toMatchObject({
      decision: "noop",
      reason: "duplicate_run",
      runId: nextCycle.runId,
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);

    for (const to of [
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]) {
      transition(db, { runId: nextCycle.runId, to, actor: "test" });
    }

    // Even if a concrete generation key collides after resolution (for
    // example, two planners racing around a terminal generation), the raw
    // SQLite error is converted to a typed noop naming the winning run.
    const collisionEventId = "chain-collision";
    const collisionKey = `${first.proposal.idempotency_key}:trigger:${hashJson({ source: "chain", eventId: collisionEventId })}`;
    createRun(db, {
      runId: "run_collision_winner",
      idempotencyKey: collisionKey,
      spec: {},
      specJson: "{}",
      specHash: "sha256:0",
      actor: "planner",
      correlationId: "lineage-001",
      causationId: "run_dispatch_old",
      policyVersion: "git:test",
      now: NOW + 4000,
    });
    transition(db, {
      runId: "run_collision_winner",
      to: "CANCELLED",
      actor: "test",
      now: NOW + 4000,
    });

    const collisionRef = admit(
      db,
      chainEvent(collisionEventId, "run_dispatch_5"),
    );
    const collision = planEvent(db, synthetic, collisionRef, {
      now: NOW + 5000,
      policyVersion: "git:test",
    });
    expect(collision).toMatchObject({
      decision: "noop",
      reason: "idempotency_collision:run_collision_winner",
      runId: "run_collision_winner",
    });
    expect(
      db
        .query(`SELECT status FROM events WHERE event_id = ?`)
        .get(collisionEventId).status,
    ).toBe("noop");
  });

  test("concurrent work scans for one repo reserve selection before either can duplicate it (WM-491)", () => {
    const synthetic = { ...registry, agents: new Map(registry.agents) };
    synthetic.agents.set("work-scan@1", {
      ...registry.agents.get("work-scan@1"),
      // Keep this planner regression hermetic: repo pinning is unrelated to
      // the reservation, whose scope comes from input.repo.
      workspace: { type: "ephemeral" },
    });
    const db = openDb(":memory:");
    const firstRef = admit(db, {
      eventId: "work-hot-1",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-hot-1",
      payload: { repo: "factory" },
    });
    const secondRef = admit(db, {
      eventId: "work-hot-2",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-hot-2",
      payload: { repo: "factory" },
    });

    const first = planEvent(db, synthetic, firstRef, {
      now: NOW,
      policyVersion: "git:test",
    });
    const second = planEvent(db, synthetic, secondRef, {
      now: NOW + 1000,
      policyVersion: "git:test",
    });

    expect(first.decision).toBe("run");
    expect(runState(db, first.runId)).toBe("PROPOSED");
    expect(second).toMatchObject({
      decision: "noop",
      reason: "work_scan_already_in_flight",
      runId: first.runId,
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);

    // The reservation is repo-scoped, not a global scanner singleton — even
    // after the first scan leaves PROPOSED and schedule singleton applies.
    transition(db, { runId: first.runId, to: "APPROVED", actor: "test" });
    const otherRepoRef = admit(db, {
      eventId: "work-other-repo",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-other-repo",
      payload: { repo: "bj29", loop: "work-bj29" },
    });
    expect(
      planEvent(db, synthetic, otherRepoRef, {
        now: NOW + 2000,
        policyVersion: "git:test",
      }).decision,
    ).toBe("run");

    // A failed read emitted no dispatch chain and must release the queue; unlike
    // a failed dispatch, a failed scan owns no retained worktree to protect.
    for (const to of ["QUEUED", "LEASED", "RUNNING", "FAILED"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }
    const afterFailureRef = admit(db, {
      eventId: "work-after-failure",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-after-failure",
      payload: { repo: "factory" },
    });
    const afterFailure = planEvent(db, synthetic, afterFailureRef, {
      now: NOW + 3000,
      policyVersion: "git:test",
    });
    expect(afterFailure.decision).toBe("run");

    for (const to of [
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]) {
      transition(db, { runId: afterFailure.runId, to, actor: "test" });
    }
    const nextCycleRef = admit(db, {
      eventId: "work-hot-next",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-hot-next",
      payload: { repo: "factory" },
    });
    expect(
      planEvent(db, synthetic, nextCycleRef, {
        now: NOW + 4000,
        policyVersion: "git:test",
      }).decision,
    ).toBe("run");
  });

  test("live reservations survive an agent version upgrade (WM-491)", () => {
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
    };
    synthetic.agents.set("work-scan@1", {
      ...registry.agents.get("work-scan@1"),
      workspace: { type: "ephemeral" },
    });
    const db = openDb(":memory:");
    const firstRef = admit(db, {
      eventId: "work-v1",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-v1",
      payload: { repo: "factory" },
    });
    const first = planEvent(db, synthetic, firstRef, {
      now: NOW,
      policyVersion: "git:test",
    });

    synthetic.eventTypes["factory.work.requested"] = {
      ...synthetic.eventTypes["factory.work.requested"],
      agent: "work-scan@2",
    };
    synthetic.agents.set("work-scan@2", {
      ...synthetic.agents.get("work-scan@1"),
      version: 2,
      ref: "work-scan@2",
    });
    const nextRef = admit(db, {
      eventId: "work-v2",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-v2",
      payload: { repo: "factory" },
    });
    expect(
      planEvent(db, synthetic, nextRef, {
        now: NOW + 1000,
        policyVersion: "git:test",
      }),
    ).toMatchObject({
      decision: "noop",
      reason: "work_scan_already_in_flight",
      runId: first.runId,
    });
  });

  test("same_ticket_worktree: a duplicate dispatch with a live run is refused at plan time (WM-491)", () => {
    const synthetic = { ...registry, agents: new Map(registry.agents) };
    synthetic.agents.set("dispatch@1", {
      ...registry.agents.get("dispatch@1"),
      // The duplicate ledger check is local planner admission; make external
      // Linear/worktree eligibility irrelevant to this focused test.
      workspace: { type: "ephemeral" },
    });
    const db = openDb(":memory:");
    const dispatch = (eventId) => ({
      eventId,
      type: "factory.dispatch.requested",
      source: "operator",
      correlationId: eventId,
      causationId: null,
      payload: { repo: "factory", ticket: "WM-480" },
    });
    const firstRef = admit(db, dispatch("dispatch-hot-1"));
    const secondRef = admit(db, dispatch("dispatch-hot-2"));

    const first = planEvent(db, synthetic, firstRef, {
      now: NOW,
      policyVersion: "git:test",
    });
    const second = planEvent(db, synthetic, secondRef, {
      now: NOW + 1000,
      policyVersion: "git:test",
    });

    expect(first.decision).toBe("run");
    expect(second).toMatchObject({
      decision: "noop",
      reason: `ticket_dispatch_already_live:${first.runId}:same_ticket_worktree_held`,
      runId: first.runId,
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);

    // A malformed dispatch remains an input error; a missing ticket must not
    // wildcard-match the live dispatch above.
    const malformedEnvelope = dispatch("dispatch-malformed");
    delete malformedEnvelope.payload.ticket;
    const malformedRef = admit(db, malformedEnvelope);
    const malformed = planEvent(db, synthetic, malformedRef, {
      now: NOW + 2000,
      policyVersion: "git:test",
    });
    expect(malformed.decision).toBe("human_needed");
    expect(malformed.reason).toMatch(/^invalid_input: /);

    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "FAILED"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }
    const failedRetryRef = admit(db, dispatch("dispatch-while-retryable"));
    expect(
      planEvent(db, synthetic, failedRetryRef, {
        now: NOW + 3000,
        policyVersion: "git:test",
      }),
    ).toMatchObject({
      decision: "noop",
      reason: `ticket_dispatch_already_live:${first.runId}:same_ticket_worktree_held`,
    });

    for (const to of [
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }
    const nextRef = admit(db, dispatch("dispatch-next-cycle"));
    expect(
      planEvent(db, synthetic, nextRef, {
        now: NOW + 4000,
        policyVersion: "git:test",
      }).decision,
    ).toBe("run");
  });

  test("an attempts-exhausted FAILED dispatch stops wedging a fresh dispatch for the same ticket (WM-1066)", () => {
    const synthetic = { ...registry, agents: new Map(registry.agents) };
    synthetic.agents.set("dispatch@1", {
      ...registry.agents.get("dispatch@1"),
      // Keep the focus on the ledger block; the worktree eligibility gate and
      // its Linear/lease reads are irrelevant to what liveRunForInput decides.
      workspace: { type: "ephemeral" },
    });
    const db = openDb(":memory:");
    const dispatch = (eventId) => ({
      eventId,
      type: "factory.dispatch.requested",
      source: "operator",
      correlationId: eventId,
      causationId: null,
      payload: { repo: "factory", ticket: "WM-1066" },
    });

    const firstRef = admit(db, dispatch("dispatch-dead-1"));
    const first = planEvent(db, synthetic, firstRef, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(first.decision).toBe("run");

    // Drive the run to FAILED — the dead dispatch that used to hold this
    // ticket's worktree forever.
    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "FAILED"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }

    // While the attempt budget is not yet spent the worktree is still owned and
    // the run is genuinely retryable, so a fresh dispatch MUST keep NOOPing.
    const retryableRef = admit(db, dispatch("dispatch-while-retryable"));
    expect(
      planEvent(db, synthetic, retryableRef, {
        now: NOW + 1000,
        policyVersion: "git:test",
      }),
    ).toMatchObject({
      decision: "noop",
      reason: `ticket_dispatch_already_live:${first.runId}:same_ticket_worktree_held`,
    });

    // Exhaust the attempt budget (maxAttempts is 1). The dead run will never
    // retry and the reaper reclaims its worktree, so it must stop blocking a
    // fresh work-scan re-dispatch instead of wedging the ticket.
    db.query(`UPDATE runs SET attempts = ? WHERE run_id = ?`).run(
      1,
      first.runId,
    );

    const freshRef = admit(db, dispatch("dispatch-fresh-work-scan"));
    const fresh = planEvent(db, synthetic, freshRef, {
      now: NOW + 2000,
      policyVersion: "git:test",
    });
    expect(fresh.decision).toBe("run");
    expect(fresh.reason ?? "").not.toContain("same_ticket_worktree_held");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);
  });

  test("unregistered event type → human_needed", () => {
    const db = openDb(":memory:");
    const ref = admit(db, { type: "totally.unknown.type" });
    const outcome = planEvent(db, registry, ref, { now: NOW });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toBe("unregistered_event_type");
    expect(outcome.proposal.decision).toBe("human_needed");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    const event = db
      .query(`SELECT status FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(event.status).toBe("human_needed");
  });

  test("observe-only event type → typed NOOP 'observed', never an inbox ask (WM-75)", () => {
    const db = openDb(":memory:");
    const ref = admit(db, {
      type: "factory.ticket.dispatched",
      payload: { repo: "bj29", ticket: "CLNT-1", harness: "claude" },
    });
    const outcome = planEvent(db, registry, ref, { now: NOW });
    expect(outcome.decision).toBe("noop");
    expect(outcome.reason).toBe("observed");
    expect(outcome.proposal.status).toBe("resolved");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    const event = db
      .query(`SELECT status FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(event.status).toBe("noop");
  });

  test("payload failing the agent input schema → human_needed with the first error", () => {
    const db = openDb(":memory:");
    const ref = admit(db, { payload: { repos: [] } });
    const outcome = planEvent(db, registry, ref, { now: NOW });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason.startsWith("invalid_input: ")).toBe(true);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    const event = db
      .query(`SELECT status FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(event.status).toBe("human_needed");
  });
});

describe("planEvent worktree gate (WM-108)", () => {
  // A synthetic worktree-workspace agent: the real dispatch@1 lands with its
  // own tests; this proves the gate itself, independent of any one agent.
  function syntheticRegistry({ agentRef = "test-worktree@1" } = {}) {
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
    };
    synthetic.eventTypes["test.worktree.requested"] = {
      agent: agentRef,
      adapter: "claude",
      idempotencyScope: ["inputHash"],
    };
    synthetic.agents.set(agentRef, {
      id: "test-worktree",
      version: 1,
      ref: agentRef,
      output_contract: "factory.test/v1",
      workspace: { type: "worktree" },
      capabilities: { services: [] },
      limits: { timeout_seconds: 60, attempts: 1 },
      mutating: true,
      inputSchema: {
        type: "object",
        required: ["repo", "ticket"],
        properties: { repo: { type: "string" }, ticket: { type: "string" } },
      },
    });
    return synthetic;
  }

  function withReposRoot(yaml, fn, policy = null) {
    const root = tmpDir("evrt-plan-wt-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "config", "repos.yaml"), yaml);
    if (policy) writeFileSync(path.join(root, "config", "policy.yaml"), policy);
    const previous = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = root;
    try {
      return fn(root);
    } finally {
      if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previous;
    }
  }

  const dispatchEnvelope = (payload) => ({
    type: "test.worktree.requested",
    eventId: `wt-${JSON.stringify(payload)}`,
    correlationId: null,
    payload,
  });

  const tierRepo =
    `repos:\n  - name: tiered\n    path: /tmp/nowhere\n    base: develop\n` +
    `    team: WM\n    project: Factory\n    max_in_flight: 1\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
    `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`;

  const tierTicket = (tierLabels = []) => ({
    identifier: "WM-694",
    state: { name: "Todo" },
    assignee: null,
    labels: {
      nodes: [
        { name: "ai:agent-ready" },
        ...tierLabels.map((name) => ({ name })),
      ],
    },
    description: "## Owned Paths\n- event-runtime/lib/planner.mjs\n",
  });

  const tierDispatch = (tierLabels = []) => ({
    countLeases: () => 0,
    budgetRefusal: () => null,
    fetchTicket: () => tierTicket(tierLabels),
    fetchInFlight: () => [],
  });

  test("ticket-scoped human-needed refusals deduplicate unchanged bodies and supersede changed ones", () => {
    const closureRepo =
      `repos:\n  - name: closure\n    path: /tmp/nowhere\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
      `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n` +
      `    owned_paths_policy:\n      direct:\n        - source: generated/input.mjs\n          requires:\n            - generated/pin.json\n`;
    withReposRoot(closureRepo, () => {
      const db = openDb(":memory:");
      const ticket = {
        ...tierTicket(),
        description: "## Owned Paths\n- generated/input.mjs\n",
      };
      const dispatch = {
        ...tierDispatch(),
        fetchTicket: () => ticket,
      };
      const plan = (eventId) => {
        const ref = admit(db, {
          type: "test.worktree.requested",
          eventId,
          correlationId: eventId,
          payload: { repo: "closure", ticket: "WM-694" },
        });
        return planEvent(db, syntheticRegistry(), ref, {
          now: NOW,
          dispatch,
        });
      };

      const first = plan("closure-first");
      expect(first).toMatchObject({
        decision: "human_needed",
        reason: "owned_paths_not_closed",
      });
      expect(first.proposal.reason).toContain("[dispatch_ticket_body_hash:");

      const unchanged = plan("closure-unchanged");
      expect(unchanged).toEqual({
        decision: "noop",
        reason: `human_needed_already_open:${first.proposal.id}`,
      });
      expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(1);

      ticket.description =
        "## Owned Paths\n- generated/input.mjs\n\nChanged ticket body.\n";
      const changed = plan("closure-changed");
      expect(changed).toMatchObject({
        decision: "human_needed",
        reason: "owned_paths_not_closed",
      });
      expect(changed.proposal.id).not.toBe(first.proposal.id);
      expect(
        db
          .query(`SELECT status, reason FROM proposals WHERE id = ?`)
          .get(first.proposal.id),
      ).toEqual({
        status: "superseded",
        reason: "superseded_by_ticket_body_change",
      });
    });
  });

  test("the human-needed guard covers other ticket refusals and reopens after resolution", () => {
    const unconfiguredRepo =
      `repos:\n  - name: unconfigured\n    path: /tmp/nowhere\n    base: develop\n` +
      `    worktree_up: bin/up\n    worktree_down: bin/down\n` +
      `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`;
    withReposRoot(unconfiguredRepo, () => {
      const db = openDb(":memory:");
      const dispatch = tierDispatch();
      const plan = (eventId, now = NOW) => {
        const ref = admit(db, {
          type: "test.worktree.requested",
          eventId,
          correlationId: eventId,
          payload: { repo: "unconfigured", ticket: "WM-694" },
        });
        return planEvent(db, syntheticRegistry(), ref, {
          now,
          dispatch,
        });
      };

      const first = plan("unconfigured-first");
      expect(first).toMatchObject({
        decision: "human_needed",
        reason:
          "repo_unconfigured: team/project missing for the in-flight query",
      });
      expect(plan("unconfigured-unchanged")).toEqual({
        decision: "noop",
        reason: `human_needed_already_open:${first.proposal.id}`,
      });

      let active = first.proposal;
      for (const status of ["approved", "rejected"]) {
        db.query(`UPDATE proposals SET status = ? WHERE id = ?`).run(
          status,
          active.id,
        );
        const fresh = plan(`unconfigured-${status}`);
        expect(fresh.decision).toBe("human_needed");
        active = fresh.proposal;
      }

      // Nothing writes status='expired': expiry is derived from
      // created_at + ttl_seconds. An open row that aged out must not
      // suppress the unchanged ticket's next question.
      const ttlMs = Number(active.ttl_seconds) * 1000;
      expect(plan("unconfigured-within-ttl", NOW + ttlMs)).toEqual({
        decision: "noop",
        reason: `human_needed_already_open:${active.id}`,
      });
      const afterExpiry = plan("unconfigured-expired", NOW + ttlMs + 1000);
      expect(afterExpiry.decision).toBe("human_needed");
      expect(afterExpiry.proposal.id).not.toBe(active.id);
      expect(
        db
          .query(`SELECT status, reason FROM proposals WHERE id = ?`)
          .get(active.id),
      ).toEqual({ status: "superseded", reason: "superseded_by_replan" });
    });
  });

  test("dispatch model tier precedence is payload > ticket label > definition and records its source (WM-694)", () => {
    withReposRoot(tierRepo, () => {
      const cases = [
        {
          eventId: "tier-definition",
          payload: { repo: "tiered", ticket: "WM-694" },
          labels: [],
          source: "definition",
          tier: "strong",
          model: "cursor-grok-4.6-high",
        },
        {
          eventId: "tier-label",
          payload: { repo: "tiered", ticket: "WM-694" },
          labels: ["tier:light"],
          source: "label",
          tier: "light",
          model: "cursor-grok-4.6-low-fast",
        },
        {
          eventId: "tier-payload",
          payload: {
            repo: "tiered",
            ticket: "WM-694",
            modelTier: "standard",
          },
          labels: ["tier:light"],
          source: "payload",
          tier: "standard",
          model: "cursor-grok-4.6-high",
        },
      ];

      for (const item of cases) {
        const eligibility = worktreeDispatchAutoEligibility(
          item.payload,
          tierDispatch(item.labels),
        );
        expect(eligibility.ok).toBe(true);
        expect(eligibility.evidence.checks.model_tier_source).toBe(item.source);

        const db = openDb(":memory:");
        const ref = admit(db, {
          type: "factory.dispatch.requested",
          eventId: item.eventId,
          correlationId: item.eventId,
          payload: item.payload,
        });
        const outcome = planEvent(db, registry, ref, {
          now: NOW,
          policyVersion: "git:test",
          dispatch: tierDispatch(item.labels),
        });
        const spec = JSON.parse(outcome.proposal.spec_json);
        expect(spec.modelTier).toBe(item.tier);
        expect(spec.model).toBe(item.model);
      }
    });
  });

  test("escalated continuation resolves the strong model for the failed spec's own adapter (gh-1704 AC3)", () => {
    const base = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_light_failed_pi",
      agent: "dispatch@1",
      input: { repo: "tiered", ticket: "WM-694", modelTier: "light" },
      inputHash: hashJson({
        repo: "tiered",
        ticket: "WM-694",
        modelTier: "light",
      }),
      workspace: { type: "worktree", checkoutDir: "repo" },
      adapter: "pi",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.dispatch-result/v1",
      capabilities: ["tracker:write", "repo:write", "github:write"],
      modelTier: "light",
      model: "openai-codex/gpt-5.6-luna",
      timeoutSeconds: 5400,
      maxAttempts: 1,
      idempotencyKey: "dispatch-light-pi",
    };
    for (const [adapter, strong] of [
      ["pi", "openai-codex/gpt-5.6-sol"],
      ["cursor", "cursor-grok-4.6-high"],
    ]) {
      const continuation = buildEscalatedContinuationSpec(
        registry,
        { ...base, adapter },
        { runId: `run_strong_${adapter}` },
      );
      expect(continuation).toMatchObject({
        adapter,
        modelTier: "strong",
        model: strong,
      });
      expect(
        modelAdapterMismatch(continuation, registry.modelTiers, adapter, {
          explicitPin: false,
        }),
      ).toBeNull();
    }
  });

  test("escalated continuation pins a fresh strong-tier spec and authenticated claim proof", () => {
    const base = {
      schemaVersion: "factory.run-spec/v1",
      runId: "run_light_failed",
      agent: "dispatch@1",
      input: { repo: "tiered", ticket: "WM-694", modelTier: "light" },
      inputHash: hashJson({
        repo: "tiered",
        ticket: "WM-694",
        modelTier: "light",
      }),
      workspace: {
        type: "worktree",
        checkoutDir: "repo",
        retainOnFailure: true,
      },
      adapter: "cursor",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.dispatch-result/v1",
      capabilities: ["tracker:write", "repo:write", "github:write"],
      modelTier: "light",
      model: "cursor-grok-4.6-low-fast",
      timeoutSeconds: 5400,
      maxAttempts: 1,
      idempotencyKey: "dispatch-light",
    };
    const continuation = buildEscalatedContinuationSpec(registry, base, {
      runId: "run_strong_continuation",
      operatorAuthorized: true,
    });
    expect(continuation).toMatchObject({
      runId: "run_strong_continuation",
      rootRunId: "run_light_failed",
      escalatedFromRunId: "run_light_failed",
      modelTier: "strong",
      model: "cursor-grok-4.6-high",
      timeoutSeconds: 5400,
      maxAttempts: 1,
      approvalPolicy: {
        source: "handoff",
        mode: "auto",
        escalation: { operatorAuthorized: true },
      },
    });

    withReposRoot(tierRepo, () => {
      const assigned = tierTicket(["tier:light"]);
      assigned.state = { name: "In Progress" };
      assigned.assignee = { id: "10578603", name: "hdkiller" };
      assigned.labels.nodes.push({ name: "ai:in-progress" });
      const viewerRepos = [];
      const dispatch = {
        ...tierDispatch(["tier:light"]),
        fetchTicket: () => assigned,
        fetchViewer: (repo) => {
          viewerRepos.push(repo);
          return { id: "10578603", name: "hdkiller" };
        },
      };
      expect(
        worktreeDispatchAutoEligibility(continuation.input, dispatch).refusal
          .reason,
      ).toBe("ticket_assigned");
      const authenticated = worktreeDispatchAutoEligibility(
        continuation.input,
        {
          ...dispatch,
          escalatedContinuation: {
            failedRunId: base.runId,
            continuationRunId: continuation.runId,
            rootRunId: base.runId,
            repo: "tiered",
            ticket: "WM-694",
            projectionState: "applied",
          },
        },
      );
      expect(authenticated.ok).toBe(true);
      expect(authenticated.evidence.checks).toMatchObject({
        ticket_escalation_projection_applied: true,
        ticket_escalation_repo_matches: true,
        ticket_escalation_ticket_matches: true,
        ticket_escalation_model_tier_strong: true,
        ticket_claim_viewer_identity: true,
        ticket_claim_escalation: true,
      });
      expect(viewerRepos).toEqual(["tiered"]);

      const workspaceEscalation = {
        failedRunId: base.runId,
        continuationRunId: continuation.runId,
        rootRunId: base.runId,
        repo: "tiered",
        ticket: "WM-694",
        workspacePath: "/tmp/tiered-checkout",
        projectionState: "applied",
      };
      expect(
        worktreeDispatchGate(continuation.input, {
          ...dispatch,
          escalatedContinuation: workspaceEscalation,
          findWorkspacePullRequest: () => ({
            number: 1533,
            state: "OPEN",
            isDraft: false,
          }),
        }),
      ).toEqual({ decision: "noop", reason: "ticket_pr_already_open" });
      for (const pullRequest of [
        { number: 1533, state: "OPEN", isDraft: true },
        null,
      ]) {
        expect(
          worktreeDispatchAutoEligibility(continuation.input, {
            ...dispatch,
            escalatedContinuation: workspaceEscalation,
            findWorkspacePullRequest: () => pullRequest,
          }).ok,
        ).toBe(true);
      }

      const closedEscalation = {
        failedRunId: base.runId,
        continuationRunId: continuation.runId,
        rootRunId: base.runId,
        repo: "tiered",
        ticket: "WM-694",
        projectionState: "applied",
        failedRunArtifact: { prNumber: 1499 },
      };
      for (const state of ["MERGED", "CLOSED"]) {
        expect(
          worktreeDispatchGate(continuation.input, {
            ...dispatch,
            escalatedContinuation: closedEscalation,
            fetchPullRequest: ({ pr }) => ({ state, number: pr }),
          }),
        ).toEqual({ decision: "noop", reason: "ticket_escalation_pr_closed" });
      }
      // A transient forge failure is reported under its own reason so the
      // worker can requeue it instead of refusing the continuation for good.
      const unreadable = worktreeDispatchAutoEligibility(continuation.input, {
        ...dispatch,
        escalatedContinuation: closedEscalation,
        fetchPullRequest: () => {
          throw new Error("github_read_failed: x");
        },
      });
      expect(unreadable.ok).toBe(false);
      expect(unreadable.refusal).toMatchObject({
        reason: "ticket_escalation_pr_read_failed",
        decision: "noop",
        detail: "github_read_failed: x",
      });
      expect(unreadable.evidence.checks.ticket_escalation_pr_read).toBe(
        undefined,
      );
      expect(
        worktreeDispatchAutoEligibility(continuation.input, {
          ...dispatch,
          escalatedContinuation: closedEscalation,
          fetchPullRequest: () => ({ state: "OPEN" }),
        }).ok,
      ).toBe(true);
      let readPullRequest = false;
      expect(
        worktreeDispatchAutoEligibility(continuation.input, {
          ...dispatch,
          escalatedContinuation: {
            ...closedEscalation,
            failedRunArtifact: {},
          },
          fetchPullRequest: () => {
            readPullRequest = true;
            return { state: "CLOSED" };
          },
        }).ok,
      ).toBe(true);
      expect(readPullRequest).toBe(false);

      assigned.assignee = { id: "someone-else", name: "Other" };
      const foreign = worktreeDispatchAutoEligibility(continuation.input, {
        ...dispatch,
        escalatedContinuation: {
          failedRunId: base.runId,
          continuationRunId: continuation.runId,
          rootRunId: base.runId,
          repo: "tiered",
          ticket: "WM-694",
          projectionState: "applied",
        },
      });
      expect(foreign.refusal).toMatchObject({
        reason: "ticket_claimed_by_other",
        detail: "tier_escalation_check_failed:viewer_identity",
      });
      expect(foreign.evidence.checks.ticket_claim_viewer_identity).toBe(false);
      assigned.assignee = { id: "10578603", name: "hdkiller" };

      const pendingProjection = worktreeDispatchAutoEligibility(
        continuation.input,
        {
          ...dispatch,
          escalatedContinuation: {
            failedRunId: base.runId,
            continuationRunId: continuation.runId,
            rootRunId: base.runId,
            repo: "tiered",
            ticket: "WM-694",
            projectionState: "pending",
          },
        },
      );
      expect(pendingProjection.refusal).toMatchObject({
        reason: "ticket_assigned",
        detail:
          "tier_escalation_check_failed:ticket_escalation_projection_applied",
      });

      const wrongTier = worktreeDispatchAutoEligibility(
        { ...continuation.input, modelTier: "standard" },
        {
          ...dispatch,
          escalatedContinuation: {
            failedRunId: base.runId,
            continuationRunId: continuation.runId,
            rootRunId: base.runId,
            repo: "tiered",
            ticket: "WM-694",
            projectionState: "applied",
          },
        },
      );
      expect(wrongTier.refusal).toMatchObject({
        reason: "ticket_assigned",
        detail:
          "tier_escalation_check_failed:ticket_escalation_model_tier_strong",
      });

      const fullCapacity = {
        ...dispatch,
        countLeases: () => 1,
        hasTicketLease: () => false,
        escalatedContinuation: {
          failedRunId: base.runId,
          continuationRunId: continuation.runId,
          rootRunId: base.runId,
          repo: "tiered",
          ticket: "WM-694",
          projectionState: "applied",
        },
      };
      expect(
        worktreeDispatchAutoEligibility(continuation.input, fullCapacity)
          .refusal.reason,
      ).toBe("capacity_full");
      const transferredCapacity = worktreeDispatchAutoEligibility(
        continuation.input,
        { ...fullCapacity, hasTicketLease: () => true },
      );
      expect(transferredCapacity.ok).toBe(true);
      expect(transferredCapacity.evidence.repo).toMatchObject({
        capCurrent: 1,
        capEffective: 0,
        capTransferred: true,
      });
    });
  });

  test("only operator-sourced dispatches bypass escalated and security gates (GH-999)", () => {
    withReposRoot(tierRepo, () => {
      const escalatedDispatch = tierDispatch(["ai:escalated"]);
      const securityDispatch = tierDispatch(["type:security"]);

      const direct = worktreeDispatchAutoEligibility(
        { repo: "tiered", ticket: "WM-694" },
        escalatedDispatch,
      );
      expect(direct.refusal.reason).toBe("ticket_escalated");
      expect(direct.evidence.checks.operator_authorized).toBe(false);

      const authorized = worktreeDispatchAutoEligibility(
        { repo: "tiered", ticket: "WM-694" },
        { ...securityDispatch, operatorAuthorized: true },
      );
      expect(authorized.ok).toBe(true);
      expect(authorized.evidence.checks.operator_authorized).toBe(true);

      const operatorDb = openDb(":memory:");
      const operatorRef = admit(operatorDb, {
        type: "factory.dispatch.requested",
        source: "operator",
        eventId: "operator-security-dispatch",
        correlationId: "operator-security-dispatch",
        payload: { repo: "tiered", ticket: "WM-694" },
      });
      expect(
        planEvent(operatorDb, registry, operatorRef, {
          now: NOW,
          policyVersion: "git:test",
          dispatch: securityDispatch,
        }).decision,
      ).toBe("run");

      for (const source of ["chain", "handoff"]) {
        const unattendedDb = openDb(":memory:");
        const unattendedRef = admit(unattendedDb, {
          type: "factory.dispatch.requested",
          source,
          eventId: `${source}-security-dispatch`,
          correlationId: `${source}-security-dispatch`,
          causationId: source === "chain" ? "run-parent" : null,
          payload: { repo: "tiered", ticket: "WM-694" },
        });
        expect(
          planEvent(unattendedDb, registry, unattendedRef, {
            now: NOW,
            policyVersion: "git:test",
            dispatch: securityDispatch,
          }),
        ).toMatchObject({ decision: "noop", reason: "ticket_security" });
      }
    });
  });

  test("dispatch.paused noops unattended dispatches but keeps operator dispatch available", () => {
    const pausedPolicy = "dispatch:\n  paused: true\n";
    withReposRoot(
      tierRepo,
      () => {
        expect(policyDispatchPaused()).toBe(true);
        const db = openDb(":memory:");
        let ticketReads = 0;
        const dispatch = {
          ...tierDispatch(),
          fetchTicket: () => {
            ticketReads += 1;
            return tierTicket();
          },
        };

        for (const source of ["schedule", "chain"]) {
          const ref = admit(db, {
            type: "factory.dispatch.requested",
            source,
            eventId: `${source}-paused-dispatch`,
            correlationId: `${source}-paused-dispatch`,
            causationId: source === "chain" ? "run-parent" : null,
            payload: { repo: "tiered", ticket: "WM-694" },
          });
          expect(
            planEvent(db, registry, ref, {
              now: NOW,
              policyVersion: "git:test",
              dispatch,
            }),
          ).toMatchObject({ decision: "noop", reason: "dispatch_paused" });
        }
        expect(ticketReads).toBe(0);

        const operator = admit(db, {
          type: "factory.dispatch.requested",
          source: "operator",
          eventId: "operator-paused-dispatch",
          correlationId: "operator-paused-dispatch",
          payload: { repo: "tiered", ticket: "WM-694" },
        });
        expect(
          planEvent(db, registry, operator, {
            now: NOW,
            policyVersion: "git:test",
            dispatch,
          }).decision,
        ).toBe("run");
        expect(ticketReads).toBe(1);
      },
      pausedPolicy,
    );
  });

  test("eligible handoff dispatch pins auto-approval evidence without operator authorization", () => {
    withReposRoot(
      tierRepo,
      () => {
        const db = openDb(":memory:");
        const ref = admit(db, {
          type: "factory.dispatch.requested",
          source: "handoff",
          eventId: "handoff-safe-dispatch",
          correlationId: "handoff-safe-dispatch",
          causationId: null,
          payload: { repo: "tiered", ticket: "WM-694" },
        });
        const outcome = planEvent(db, registry, ref, {
          now: NOW,
          policyVersion: "git:test",
          dispatch: tierDispatch(),
        });
        expect(outcome.decision).toBe("run");
        const spec = JSON.parse(outcome.proposal.spec_json);
        expect(spec.approvalPolicy).toMatchObject({
          source: "handoff",
          mode: "auto",
          eventType: "factory.dispatch.requested",
          dispatchEvidence: {
            checks: { operator_authorized: false },
          },
        });
      },
      "chain_auto_approval:\n  allowed_event_types:\n    - factory.dispatch.requested\n",
    );
  });

  test("dispatch.security_tickets: auto admits a chain security dispatch, held for human merge (WM-1060)", () => {
    const autoPolicy = "dispatch:\n  security_tickets: auto\n";
    const securityDispatch = tierDispatch(["type:security"]);

    // Default policy (key absent) still refuses a non-operator security dispatch.
    withReposRoot(tierRepo, () => {
      const direct = worktreeDispatchAutoEligibility(
        { repo: "tiered", ticket: "WM-694" },
        securityDispatch,
      );
      expect(direct.ok).toBe(false);
      expect(direct.refusal.reason).toBe("ticket_security");
      expect(direct.evidence.checks.security_dispatch_mode).toBe("excluded");
    });

    // With auto, the same non-operator (chain) dispatch is admitted.
    withReposRoot(
      tierRepo,
      () => {
        const admitted = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "WM-694" },
          securityDispatch,
        );
        expect(admitted.ok).toBe(true);
        expect(admitted.evidence.checks.security_dispatch_mode).toBe("auto");
        expect(admitted.evidence.checks.operator_authorized).toBe(false);

        const db = openDb(":memory:");
        const ref = admit(db, {
          type: "factory.dispatch.requested",
          source: "chain",
          eventId: "chain-security-auto",
          correlationId: "chain-security-auto",
          causationId: "run-parent",
          payload: { repo: "tiered", ticket: "WM-694" },
        });
        expect(
          planEvent(db, registry, ref, {
            now: NOW,
            policyVersion: "git:test",
            dispatch: securityDispatch,
          }).decision,
        ).toBe("run");
      },
      autoPolicy,
    );
  });

  test("duplicate or unknown ticket tier labels refuse with typed evidence (WM-694)", () => {
    withReposRoot(tierRepo, () => {
      for (const labels of [["tier:light", "tier:standard"], ["tier:turbo"]]) {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "WM-694", modelTier: "strong" },
          tierDispatch(labels),
        );
        expect(result.refusal.reason).toBe("ticket_tier_invalid");
        expect(result.evidence.checks).toMatchObject({
          ticket_tier_valid: false,
          model_tier_source: null,
        });
        expect(result.evidence.ticket.modelTierLabels).toEqual(labels);
      }
    });
  });

  test("open Linear blockers refuse dispatch with blocker ids in evidence (WM-709)", () => {
    withReposRoot(tierRepo, () => {
      const openRelations = {
        nodes: [
          {
            type: "blocks",
            issue: { identifier: "WM-703", state: { type: "started" } },
          },
          {
            type: "related",
            issue: { identifier: "WM-701", state: { type: "started" } },
          },
          {
            type: "blocks",
            issue: { identifier: "WM-702", state: { type: "unstarted" } },
          },
        ],
      };
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "dispatch-open-blockers",
        correlationId: "dispatch-open-blockers",
        payload: { repo: "tiered", ticket: "WM-704" },
      });
      const outcome = planEvent(db, registry, ref, {
        now: NOW,
        dispatch: {
          ...tierDispatch(),
          fetchTicket: () => ({
            ...tierTicket(),
            identifier: "WM-704",
            inverseRelations: openRelations,
          }),
        },
      });

      expect(outcome).toMatchObject({
        decision: "noop",
        reason: "ticket_blocked_by_open:WM-703,WM-702",
        evidence: {
          checks: { ticket_unblocked: false },
          ticket: { openBlockers: ["WM-703", "WM-702"] },
        },
      });
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    });
  });

  test("finished blockers and non-blocking relations remain dispatchable (WM-709)", () => {
    withReposRoot(tierRepo, () => {
      const relations = [
        {
          type: "blocks",
          issue: { identifier: "WM-700", state: { type: "completed" } },
        },
        {
          type: "blocks",
          issue: { identifier: "WM-701", state: { type: "canceled" } },
        },
        {
          type: "duplicate",
          issue: { identifier: "WM-702", state: { type: "started" } },
        },
      ];
      for (const inverseRelations of [undefined, { nodes: relations }]) {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "WM-704" },
          {
            ...tierDispatch(),
            fetchTicket: () => ({ ...tierTicket(), inverseRelations }),
          },
        );
        expect(result.ok).toBe(true);
        expect(result.evidence.checks.ticket_unblocked).toBe(true);
        expect(result.evidence.ticket.openBlockers).toEqual([]);
      }
    });
  });

  test("a label tier with no routed-adapter mapping fails closed (WM-694)", () => {
    withReposRoot(tierRepo, () => {
      const missingLight = {
        ...registry,
        modelTiers: {
          ...registry.modelTiers,
          cursor: {
            strong: registry.modelTiers.cursor.strong,
            standard: registry.modelTiers.cursor.standard,
          },
        },
      };
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "tier-label-unmapped",
        correlationId: "tier-label-unmapped",
        payload: { repo: "tiered", ticket: "WM-694" },
      });
      expect(() =>
        planEvent(db, missingLight, ref, {
          now: NOW,
          dispatch: tierDispatch(["tier:light"]),
        }),
      ).toThrow(/model_tier "light" has no mapping for adapter "cursor"/);
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    });
  });

  describe("trusted-author + body-hash-pin gates, github plane only (GH-879)", () => {
    const githubTicket = ({
      authorAssociation = "OWNER",
      lastEditorAssociation = "OWNER",
      readyPinHash,
      description = "## Owned Paths\n- event-runtime/lib/planner.mjs\n",
    } = {}) => {
      const ticket = {
        identifier: "acme/widget#1",
        state: { name: "Todo" },
        assignee: null,
        labels: [{ name: "ai:agent-ready" }],
        description,
        controlPlaneKind: "github",
        authorAssociation,
        lastEditorAssociation,
        readyPinHash:
          readyPinHash === undefined ? hashJson(description) : readyPinHash,
      };
      return ticket;
    };

    const githubDispatch = (ticket) => ({
      countLeases: () => 0,
      budgetRefusal: () => null,
      fetchTicket: () => ticket,
      fetchInFlight: () => [],
    });

    test("an untrusted author refuses dispatch", () => {
      withReposRoot(tierRepo, () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "acme/widget#1" },
          githubDispatch(githubTicket({ authorAssociation: "CONTRIBUTOR" })),
        );
        expect(result.ok).toBe(false);
        expect(result.refusal.reason).toBe("ticket_untrusted_author");
        expect(result.evidence.checks.ticket_trusted_author).toBe(false);
      });
    });

    test("a trusted author whose last edit came from an untrusted editor still refuses", () => {
      withReposRoot(tierRepo, () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "acme/widget#1" },
          githubDispatch(
            githubTicket({
              authorAssociation: "OWNER",
              lastEditorAssociation: "NONE",
            }),
          ),
        );
        expect(result.ok).toBe(false);
        expect(result.refusal.reason).toBe("ticket_untrusted_author");
      });
    });

    test("an unfetchable (null) association fails closed, not open", () => {
      withReposRoot(tierRepo, () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "acme/widget#1" },
          githubDispatch(
            githubTicket({
              authorAssociation: "OWNER",
              lastEditorAssociation: null,
            }),
          ),
        );
        expect(result.ok).toBe(false);
        expect(result.refusal.reason).toBe("ticket_untrusted_author");
      });
    });

    test("trusted author + trusted last editor is admitted", () => {
      withReposRoot(tierRepo, () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "acme/widget#1" },
          githubDispatch(githubTicket()),
        );
        expect(result.ok).toBe(true);
        expect(result.evidence.checks.ticket_trusted_author).toBe(true);
      });
    });

    test("a body edit after the ready-pin was stamped refuses dispatch", () => {
      withReposRoot(tierRepo, () => {
        const ticket = githubTicket({
          readyPinHash: hashJson("a completely different body"),
        });
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "acme/widget#1" },
          githubDispatch(ticket),
        );
        expect(result.ok).toBe(false);
        expect(result.refusal.reason).toBe("ticket_body_changed_since_ready");
        expect(result.evidence.checks.ticket_body_pin_matches).toBe(false);
      });
    });

    test("a re-label that refreshes the pin to match the live body admits again", () => {
      withReposRoot(tierRepo, () => {
        const description = "## Owned Paths\n- event-runtime/lib/planner.mjs\n";
        const ticket = githubTicket({
          description,
          readyPinHash: hashJson(description),
        });
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "acme/widget#1" },
          githubDispatch(ticket),
        );
        expect(result.ok).toBe(true);
        expect(result.evidence.checks.ticket_body_pin_matches).toBe(true);
      });
    });

    test("an absent ready pin fails closed under its own reason code", () => {
      withReposRoot(tierRepo, () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "acme/widget#1" },
          githubDispatch(githubTicket({ readyPinHash: null })),
        );
        expect(result.ok).toBe(false);
        // Distinct from a mismatch (GH-967): an unpinned ticket is re-stamped
        // by a relabel sweep, a changed body needs a human.
        expect(result.refusal.reason).toBe("ticket_ready_pin_missing");
        expect(result.evidence.checks.ticket_body_pin_matches).toBe(false);
      });
    });

    test("a Linear ticket (no controlPlaneKind) is unaffected by either gate", () => {
      withReposRoot(tierRepo, () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "WM-694" },
          tierDispatch(),
        );
        expect(result.ok).toBe(true);
        expect(result.evidence.checks.ticket_trusted_author).toBeUndefined();
        expect(result.evidence.checks.ticket_body_pin_matches).toBeUndefined();
        expect(result.evidence.ticket.controlPlaneKind).toBeUndefined();
      });
    });
  });

  test("a dispatch-exempt worktree agent bypasses dispatch-only planning checks", () => {
    withReposRoot(
      `repos:\n  - name: repairable\n    path: /tmp/nowhere\n    base: develop\n`,
      () => {
        const synthetic = syntheticRegistry();
        synthetic.agents.set("test-worktree@1", {
          ...synthetic.agents.get("test-worktree@1"),
          dispatchGateExempt: true,
        });
        const db = openDb(":memory:");
        const ref = admit(
          db,
          dispatchEnvelope({ repo: "repairable", ticket: "WM-500" }),
        );
        const outcome = planEvent(db, synthetic, ref, {
          now: NOW,
          dispatch: {
            fetchTicket: () => {
              throw new Error("dispatch gate must not run");
            },
          },
        });
        expect(outcome.decision).toBe("run");
      },
    );
  });

  test("merge-fix@1 bypasses the tier-2 dispatch gate while dispatch@1 does not", () => {
    const mergeFixDb = openDb(":memory:");
    const mergeFix = admit(mergeFixDb, {
      type: "factory.merge-fix.requested",
      eventId: "merge-fix-dispatch-gate-characterization",
      payload: {
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 469,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        headRef: "feat/WM-469",
        ticket: "WM-469",
        finding: "characterization fixture",
        findingHash: "c".repeat(64),
        round: 1,
        mechanical: true,
        withinOwnedPaths: true,
        ownedPaths: ["event-runtime/lib/planner.mjs"],
      },
    });
    expect(
      planEvent(mergeFixDb, registry, mergeFix, {
        now: NOW,
        dispatch: {
          fetchTicket: () => {
            throw new Error("merge-fix must bypass the dispatch gate");
          },
        },
      }).decision,
    ).toBe("run");

    const dispatchDb = openDb(":memory:");
    const dispatch = admit(dispatchDb, {
      type: "factory.dispatch.requested",
      eventId: "dispatch-gate-characterization",
      payload: { repo: "factory", ticket: "watt-mind/factory#469" },
    });
    const outcome = planEvent(dispatchDb, registry, dispatch, {
      now: NOW,
      dispatch: { fetchTicket: () => null },
    });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toBe("ticket_not_found");
  });

  test("merge-fix eligibility expects assigned review tickets and returns merge-fix typed refusals", () => {
    const payload = {
      repo: "factory",
      github: "watt-mind/factory",
      pr: 42,
      ticket: "WM-500",
      headSha: "a".repeat(40),
      ownedPaths: ["event-runtime/lib/worker.mjs"],
    };
    const ticket = {
      identifier: payload.ticket,
      state: { name: "In Review" },
      assignee: { id: "reviewer" },
      labels: { nodes: [{ name: "ai:needs-review" }] },
      description: "## Owned Paths\n- event-runtime/lib/**\n",
    };
    const eligible = worktreeMergeFixEligibility(payload, {
      fetchTicket: () => ticket,
      fetchPullRequest: () => ({ state: "OPEN", headRefOid: payload.headSha }),
      fetchNonTerminalRuns: () => [],
      now: NOW,
    });
    expect(eligible.ok).toBe(true);

    expect(
      worktreeMergeFixEligibility(payload, {
        fetchTicket: () => ({
          ...ticket,
          labels: { nodes: [{ name: "ai:escalated" }] },
        }),
        fetchPullRequest: () => ({
          state: "OPEN",
          headRefOid: payload.headSha,
        }),
        now: NOW,
      }).refusal.reason,
    ).toBe("merge_fix_ticket_escalated");
    expect(
      worktreeMergeFixEligibility(payload, {
        fetchTicket: () => ticket,
        fetchPullRequest: () => ({ state: "OPEN", headRefOid: "b".repeat(40) }),
        now: NOW,
      }).refusal.reason,
    ).toBe("merge_fix_pr_moved");
    expect(
      worktreeMergeFixEligibility(payload, {
        fetchTicket: () => ticket,
        fetchPullRequest: () => ({
          state: "OPEN",
          headRefOid: payload.headSha,
        }),
        fetchNonTerminalRuns: () => [{ runId: "run_other", state: "RUNNING" }],
        now: NOW,
      }).refusal.reason,
    ).toBe("merge_fix_run_active");
    expect(
      worktreeMergeFixEligibility(
        { ...payload, ownedPaths: ["outside/scope.mjs"] },
        {
          fetchTicket: () => ticket,
          fetchPullRequest: () => ({
            state: "OPEN",
            headRefOid: payload.headSha,
          }),
          now: NOW,
        },
      ).refusal.reason,
    ).toBe("merge_fix_owned_paths_moved");
  });

  test("a repo with no worktree scripts declared → typed human_needed at plan time, no run", () => {
    withReposRoot(
      `repos:\n  - name: noscripts\n    path: /tmp/nowhere\n    base: develop\n`,
      () => {
        const synthetic = syntheticRegistry();
        const db = openDb(":memory:");
        const ref = admit(
          db,
          dispatchEnvelope({ repo: "noscripts", ticket: "WM-1" }),
        );
        const outcome = planEvent(db, synthetic, ref, { now: NOW });
        expect(outcome.decision).toBe("human_needed");
        expect(outcome.reason).toBe("no_worktree_scripts");
        expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
      },
    );
  });

  test("factory dispatch refuses a missing toolchain before ticket reads and memoizes the typed proposal", () => {
    const toolchainRepo = tierRepo + `    toolchain:\n      uv: ">=0.5"\n`;
    withReposRoot(toolchainRepo, () => {
      const db = openDb(":memory:");
      const calls = [];
      const toolchain = {
        cache: new Map(),
        which: (executable) => {
          calls.push(executable);
          return null;
        },
      };
      const plan = (eventId) => {
        const ref = admit(db, {
          type: "factory.dispatch.requested",
          eventId,
          correlationId: eventId,
          payload: { repo: "tiered", ticket: "WM-694" },
        });
        return planEvent(db, registry, ref, { now: NOW, toolchain });
      };

      const first = plan("toolchain-missing-first");
      const second = plan("toolchain-missing-second");
      expect(first).toMatchObject({
        decision: "human_needed",
        reason: "toolchain_unsatisfied:uv",
      });
      expect(second).toMatchObject({
        decision: "human_needed",
        reason: "toolchain_unsatisfied:uv",
      });
      expect(calls).toEqual(["uv"]);
      expect(first.proposal.reason).toContain("repo_toolchain_missing");
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    });
  });

  test("factory dispatch probes a satisfied declared toolchain and plans normally", () => {
    const toolchainRepo = tierRepo + `    toolchain:\n      bun: ">=1.3 <2"\n`;
    withReposRoot(toolchainRepo, () => {
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "toolchain-satisfied",
        correlationId: "toolchain-satisfied",
        payload: { repo: "tiered", ticket: "WM-694" },
      });
      const outcome = planEvent(db, registry, ref, {
        now: NOW,
        dispatch: tierDispatch(),
        toolchain: {
          cache: new Map(),
          which: () => "/opt/bin/bun",
          spawn: () => ({ exitCode: 0, stdout: "1.3.14\n", stderr: "" }),
        },
      });
      expect(outcome.decision).toBe("run");
    });
  });

  test("factory dispatch skips probing when the repo declares no toolchain", () => {
    withReposRoot(tierRepo, () => {
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "toolchain-undeclared",
        correlationId: "toolchain-undeclared",
        payload: { repo: "tiered", ticket: "WM-694" },
      });
      const outcome = planEvent(db, registry, ref, {
        now: NOW,
        dispatch: tierDispatch(),
        toolchain: {
          cache: new Map(),
          which: () => {
            throw new Error("undeclared toolchain must not probe");
          },
        },
      });
      expect(outcome.decision).toBe("run");
    });
  });

  test("factory dispatch for a repo missing from config/repos.yaml → human_needed repo_unknown", () => {
    withReposRoot(tierRepo, () => {
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "toolchain-repo-unknown",
        correlationId: "toolchain-repo-unknown",
        payload: { repo: "ghost", ticket: "WM-694" },
      });
      const outcome = planEvent(db, registry, ref, {
        now: NOW,
        dispatch: tierDispatch(),
        toolchain: {
          cache: new Map(),
          which: () => {
            throw new Error("unknown repo must not probe");
          },
        },
      });
      expect(outcome.decision).toBe("human_needed");
      expect(outcome.reason).toMatch(/^repo_unknown: /);
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    });
  });

  test("a repo missing from config/repos.yaml → human_needed repo_unknown", () => {
    withReposRoot(
      `repos:\n  - name: real\n    path: /tmp/nowhere\n    base: develop\n`,
      () => {
        const synthetic = syntheticRegistry();
        const db = openDb(":memory:");
        const ref = admit(
          db,
          dispatchEnvelope({ repo: "ghost", ticket: "WM-1" }),
        );
        const outcome = planEvent(db, synthetic, ref, { now: NOW });
        expect(outcome.decision).toBe("human_needed");
        expect(outcome.reason).toMatch(/^repo_unknown: /);
        expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
      },
    );
  });

  test("whole-repo Owned Paths refuses distinctly before wildcard escalation", () => {
    withReposRoot(
      `repos:\n  - name: gated\n    path: /tmp/nowhere\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
        `    worktree_root: /tmp/worktrees\n    escalate_paths:\n      - '**'\n`,
      () => {
        for (const description of [
          "",
          "## Owned Paths\n- **\n",
          "## Owned Paths\n- **/*\n",
          "## Owned Paths\n- **/**\n",
        ]) {
          let fetchedInFlight = false;
          const result = worktreeDispatchAutoEligibility(
            { repo: "gated", ticket: "WM-2" },
            {
              countLeases: () => 0,
              budgetRefusal: () => null,
              fetchTicket: () => ({
                identifier: "WM-2",
                state: { name: "Todo" },
                assignee: null,
                labels: { nodes: [{ name: "ai:agent-ready" }] },
                description,
              }),
              fetchInFlight: () => {
                fetchedInFlight = true;
                return [];
              },
            },
          );
          expect(result.refusal).toMatchObject({
            decision: "noop",
            reason: "owned_paths_unknown",
          });
          expect(result.evidence.ticket.ownedPathsParsed).toBe(false);
          expect(result.evidence.escalatePathIntersections).toEqual([]);
          expect(fetchedInFlight).toBe(false);
        }
      },
    );
  });

  test("advisory mode records but does not block an in-flight **/* claim", () => {
    withReposRoot(
      tierRepo,
      () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "tiered", ticket: "WM-952" },
          {
            ...tierDispatch(),
            fetchTicket: () => ({
              ...tierTicket(),
              identifier: "WM-952",
              description: "## Owned Paths\n- src/a.ts\n",
            }),
            fetchInFlight: () => [
              {
                identifier: "WM-953",
                description: "## Owned Paths\n- **/*\n",
              },
            ],
          },
        );
        // A whole-repo (`**`) claim from an in-flight ticket no longer hard-
        // refuses in advisory mode — it is recorded for visibility and the
        // candidate stays dispatchable (a scope-unknown in-flight ticket must
        // not freeze the queue).
        expect(result.refusal?.reason).not.toBe("owned_paths_conflict_hard");
        expect(result.evidence.ownedPathsHardConflicts).toEqual([
          { ticket: "WM-953", path: "src/a.ts", inFlightPath: "**/*" },
        ]);
      },
      "dispatch:\n  owned_paths_collision: advisory\n",
    );
  });

  test("refreshes pin-manifest closure requirements after manifests are added and removed", () => {
    const repoPath = tmpDir("evrt-plan-closure-cache-");
    const manifestDir = path.join(repoPath, "manifests");
    const manifestPath = path.join(manifestDir, "generated.json");
    mkdirSync(manifestDir, { recursive: true });
    const yaml =
      `repos:\n  - name: closure-cache\n    path: ${repoPath}\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
      `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n` +
      `    owned_paths_policy:\n      pin_manifests:\n        - manifests/*.json\n`;
    const ticket = {
      identifier: "WM-948",
      state: { name: "Todo" },
      assignee: null,
      labels: { nodes: [{ name: "ai:agent-ready" }] },
      description: "## Owned Paths\n- generated/contracts.mjs\n",
    };
    const dispatch = {
      countLeases: () => 0,
      budgetRefusal: () => null,
      fetchTicket: () => ticket,
      fetchInFlight: () => [],
    };

    withReposRoot(yaml, () => {
      // Cache an empty set first, exactly as a long-lived daemon does before
      // a new generated-contract pin is committed.
      expect(
        worktreeDispatchAutoEligibility(
          { repo: "closure-cache", ticket: "WM-948" },
          dispatch,
        ).ok,
      ).toBe(true);

      writeFileSync(
        manifestPath,
        JSON.stringify({ pins: { "generated/contracts.mjs": "sha256:pin" } }),
      );
      expect(
        worktreeDispatchAutoEligibility(
          { repo: "closure-cache", ticket: "WM-948" },
          dispatch,
        ).refusal?.reason,
      ).toBe("owned_paths_not_closed");

      // A changed existing manifest cannot retain its prior requirement.
      writeFileSync(
        manifestPath,
        JSON.stringify({
          pins: { "generated/other-contract.mjs": "sha256:new" },
        }),
      );
      expect(
        worktreeDispatchAutoEligibility(
          { repo: "closure-cache", ticket: "WM-948" },
          dispatch,
        ).ok,
      ).toBe(true);

      // Removing the same manifest must evict its cached requirement too.
      rmSync(manifestPath);
      expect(
        worktreeDispatchAutoEligibility(
          { repo: "closure-cache", ticket: "WM-948" },
          dispatch,
        ).ok,
      ).toBe(true);
    });
  });

  test("flat labels array from the control-plane adapter still admits (WM-978)", () => {
    withReposRoot(
      `repos:\n  - name: gated\n    path: /tmp/nowhere\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
        `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`,
      () => {
        // WM-894's adapter emits labels as a flat [{id,name}] array instead of
        // the GraphQL {nodes:[...]} shape; admission must accept both.
        const result = worktreeDispatchAutoEligibility(
          { repo: "gated", ticket: "WM-978" },
          {
            countLeases: () => 0,
            budgetRefusal: () => null,
            fetchTicket: () => ({
              identifier: "WM-978",
              state: { name: "Todo" },
              assignee: null,
              labels: [{ id: "x", name: "ai:agent-ready" }],
              description: "## Owned Paths\n- event-runtime/lib/planner.mjs\n",
            }),
            fetchInFlight: () => [],
          },
        );
        expect(result.refusal?.reason).not.toBe("ticket_not_agent_ready");
        expect(result.evidence.ticket.labels).toContain("ai:agent-ready");
      },
    );
  });

  test("lease-loss retry accepts only the factory viewer's surviving In Progress claim (WM-621)", () => {
    withReposRoot(
      `repos:\n  - name: gated\n    path: /tmp/nowhere\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
        `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`,
      () => {
        const claimedTicket = (assignee) => ({
          identifier: "WM-621",
          state: { name: "In Progress" },
          assignee,
          labels: {
            nodes: [{ name: "ai:in-progress" }, { name: "agent:claude-code" }],
          },
          description: "## Owned Paths\n- event-runtime/lib/worker.mjs\n",
        });
        const baseDispatch = {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchViewer: () => ({ id: "factory-user", name: "Factory" }),
          fetchInFlight: () => [],
          claimedRetry: {
            runId: "run_same",
            priorAttempt: 1,
            reasonCode: "lease_expired",
          },
        };

        const resumed = worktreeDispatchAutoEligibility(
          { repo: "gated", ticket: "WM-621" },
          {
            ...baseDispatch,
            fetchTicket: () => claimedTicket({ id: "factory-user" }),
          },
        );
        expect(resumed.ok).toBe(true);
        expect(resumed.evidence.checks).toMatchObject({
          ticket_claim_retry: true,
          ticket_in_progress_retry: true,
          ticket_in_progress_label_retry: true,
        });

        const foreign = worktreeDispatchAutoEligibility(
          { repo: "gated", ticket: "WM-621" },
          {
            ...baseDispatch,
            fetchTicket: () => claimedTicket({ id: "someone-else" }),
          },
        );
        expect(foreign.refusal).toMatchObject({
          decision: "noop",
          reason: "ticket_assigned",
        });

        const ownAssignedTodo = worktreeDispatchAutoEligibility(
          { repo: "gated", ticket: "WM-621" },
          {
            ...baseDispatch,
            fetchTicket: () => ({
              ...claimedTicket({ id: "factory-user" }),
              state: { name: "Todo" },
              labels: { nodes: [{ name: "ai:agent-ready" }] },
            }),
          },
        );
        expect(ownAssignedTodo.refusal).toMatchObject({
          decision: "noop",
          reason: "ticket_assigned",
        });
      },
    );
  });

  test("a genuine sensitive-path refusal names the intersecting configured globs", () => {
    withReposRoot(
      `repos:\n  - name: gated\n    path: /tmp/nowhere\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
        `    worktree_root: /tmp/worktrees\n    escalate_paths:\n      - src/auth/**\n      - infra/**\n`,
      () => {
        const dispatch = {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchTicket: () => ({
            identifier: "WM-3",
            state: { name: "Todo" },
            assignee: null,
            labels: { nodes: [{ name: "ai:agent-ready" }] },
            description: "## Owned Paths\n- src/auth/session.ts\n",
          }),
          fetchInFlight: () => [],
        };
        const result = worktreeDispatchAutoEligibility(
          { repo: "gated", ticket: "WM-3" },
          dispatch,
        );
        expect(result.refusal).toEqual({
          decision: "noop",
          reason: "escalate_paths_intersect",
          detail: "intersecting escalate_paths globs: src/auth/**",
        });
        expect(result.evidence.escalatePathIntersections).toEqual([
          "src/auth/**",
        ]);

        const db = openDb(":memory:");
        const ref = admit(
          db,
          dispatchEnvelope({ repo: "gated", ticket: "WM-3" }),
        );
        const outcome = planEvent(db, syntheticRegistry(), ref, {
          now: NOW,
          dispatch,
        });
        expect(outcome).toMatchObject({
          decision: "noop",
          reason: "escalate_paths_intersect",
        });
        expect(outcome.proposal.reason).toBe(
          "intersecting escalate_paths globs: src/auth/**",
        );
      },
    );
  });

  test("a direct dispatch enforces an in-repo-only escalate_paths overlay", () => {
    const checkout = tmpDir("evrt-escalate-overlay-");
    writeFileSync(
      path.join(checkout, ".factory.yaml"),
      "schemaVersion: factory.repo/v1\nescalate_paths:\n  - src/auth/**\n",
    );
    withReposRoot(
      `repos:\n  - name: overlaid\n    path: ${checkout}\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
        `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`,
      () => {
        const result = worktreeDispatchAutoEligibility(
          { repo: "overlaid", ticket: "WM-1797" },
          {
            countLeases: () => 0,
            budgetRefusal: () => null,
            fetchTicket: () => ({
              identifier: "WM-1797",
              state: { name: "Todo" },
              assignee: null,
              labels: { nodes: [{ name: "ai:agent-ready" }] },
              description: "## Owned Paths\n- src/auth/session.ts\n",
            }),
            fetchInFlight: () => [],
          },
        );
        expect(result.refusal).toMatchObject({
          decision: "noop",
          reason: "escalate_paths_intersect",
        });
        expect(result.evidence.escalatePathIntersections).toEqual([
          "src/auth/**",
        ]);
      },
    );
  });

  test("dispatch also defers when merge-fix already owns the ticket worktree", () => {
    withReposRoot(
      `repos:\n  - name: fixture\n    path: /tmp/fixture\n    base: develop\n    team: WM\n    project: Factory\n    worktree_up: /tmp/worktree-up\n    worktree_down: /tmp/worktree-down\n    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`,
      () => {
        const synthetic = syntheticRegistry({ agentRef: "dispatch@1" });
        const db = openDb(":memory:");
        db.query(
          `INSERT INTO runs (run_id,idempotency_key,spec_json,spec_hash,state,attempts,created_at,updated_at)
           VALUES ('run_mergefix','mergefix-key',?,'hash','QUEUED',0,?,?)`,
        ).run(
          JSON.stringify({
            agent: "merge-fix@1",
            input: { repo: "fixture", ticket: "WM-526" },
          }),
          new Date(NOW).toISOString(),
          new Date(NOW).toISOString(),
        );
        const ref = admit(
          db,
          dispatchEnvelope({ repo: "fixture", ticket: "WM-526" }),
        );
        const outcome = planEvent(db, synthetic, ref, {
          now: NOW,
          dispatch: {
            budgetRefusal: () => null,
            countLeases: () => 0,
            fetchTicket: () => ({
              state: { name: "Todo" },
              assignee: null,
              labels: { nodes: [{ name: "ai:agent-ready" }] },
              description: "## Owned Paths\n* `src/**`",
            }),
            fetchInFlight: () => [],
          },
        });

        expect(outcome).toMatchObject({
          decision: "noop",
          reason: "ticket_merge_fix_in_flight",
          runId: "run_mergefix",
        });
        expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
      },
    );
  });
});

describe("planEvent repo scoping (WM-64)", () => {
  // A synthetic agent per test keeps the check independent of any one real
  // definition (same approach as the worktree gate tests above).
  function scopedRegistry({ repos, workspace = { type: "ephemeral" } } = {}) {
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
    };
    synthetic.eventTypes["test.scoped.requested"] = {
      agent: "test-scoped@1",
      adapter: "claude",
      idempotencyScope: ["inputHash"],
    };
    synthetic.agents.set("test-scoped@1", {
      id: "test-scoped",
      version: 1,
      ref: "test-scoped@1",
      output_contract: "factory.test/v1",
      workspace,
      capabilities: { services: [] },
      limits: { timeout_seconds: 60, attempts: 1 },
      ...(repos ? { repos } : {}),
      inputSchema: {
        type: "object",
        required: ["repo", "ticket"],
        properties: { repo: { type: "string" }, ticket: { type: "string" } },
      },
    });
    return synthetic;
  }

  const scopedEnvelope = (payload) => ({
    type: "test.scoped.requested",
    eventId: `scoped-${JSON.stringify(payload)}`,
    correlationId: null,
    payload,
  });

  test("payload.repo inside the declared set plans a run, and the spec carries the scope", () => {
    const synthetic = scopedRegistry({ repos: ["bj29", "cw-app"] });
    const db = openDb(":memory:");
    const ref = admit(db, scopedEnvelope({ repo: "bj29", ticket: "WM-1" }));
    const outcome = planEvent(db, synthetic, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(outcome.decision).toBe("run");
    // The proposal the operator approves names the scope (WM-64).
    expect(JSON.parse(outcome.proposal.spec_json).repos).toEqual([
      "bj29",
      "cw-app",
    ]);
  });

  test("payload.repo outside the declared set parks human_needed with the named reason, no run", () => {
    const synthetic = scopedRegistry({ repos: ["bj29", "cw-app"] });
    const db = openDb(":memory:");
    const ref = admit(
      db,
      scopedEnvelope({ repo: "coach-wattz", ticket: "WM-1" }),
    );
    const outcome = planEvent(db, synthetic, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toBe(
      "repo_not_allowed: test-scoped@1 may not run over coach-wattz (allowed: bj29, cw-app)",
    );
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    const event = db
      .query(`SELECT status FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(event.status).toBe("human_needed");
  });

  test("a definition without repos is unrestricted — behaves exactly as today (regression)", () => {
    const synthetic = scopedRegistry();
    const db = openDb(":memory:");
    const ref = admit(
      db,
      scopedEnvelope({ repo: "anything-at-all", ticket: "WM-1" }),
    );
    const outcome = planEvent(db, synthetic, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(outcome.decision).toBe("run");
    expect(JSON.parse(outcome.proposal.spec_json).repos).toBeUndefined();
  });

  test("scope refusal precedes the repo pin: repository workspace parks repo_not_allowed, never touches the mirror", () => {
    // No FACTORY_REPOS_ROOT setup at all — if the planner reached pinRepo it
    // would fail as repo_pin_failed; the scope check must win first, so no
    // mirror fetch happens for a refused run.
    const synthetic = scopedRegistry({
      repos: ["bj29"],
      workspace: { type: "repository" },
    });
    const db = openDb(":memory:");
    const ref = admit(
      db,
      scopedEnvelope({ repo: "coach-wattz", ticket: "WM-1" }),
    );
    const outcome = planEvent(db, synthetic, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toMatch(/^repo_not_allowed: /);
    const stored = db
      .query(`SELECT envelope_json FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(JSON.parse(stored.envelope_json).payload.repoPin).toBeUndefined();
  });

  test("scope refusal precedes the worktree dispatch gate: no Linear or lease reads for an out-of-scope repo", () => {
    const synthetic = scopedRegistry({
      repos: ["bj29"],
      workspace: { type: "worktree" },
    });
    const db = openDb(":memory:");
    const ref = admit(
      db,
      scopedEnvelope({ repo: "coach-wattz", ticket: "WM-1" }),
    );
    const dispatch = {
      fetchTicket: () => {
        throw new Error("gate consulted Linear for an out-of-scope repo");
      },
      fetchInFlight: () => {
        throw new Error("gate consulted Linear for an out-of-scope repo");
      },
    };
    const outcome = planEvent(db, synthetic, ref, {
      now: NOW,
      policyVersion: "git:test",
      dispatch,
    });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toMatch(/^repo_not_allowed: /);
  });
});

describe("planEvent model pinning (WM-135)", () => {
  // Synthetic agents again: the resolution semantics belong to the planner,
  // not to any one shipped definition.
  function tieredRegistry({
    modelTier,
    model,
    adapter = "claude",
    modelTiers,
  } = {}) {
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
      modelTiers: modelTiers ?? {
        claude: { strong: "default", standard: "sonnet", light: "haiku" },
      },
    };
    synthetic.eventTypes["test.tiered.requested"] = {
      agent: "test-tiered@1",
      adapter,
      idempotencyScope: ["inputHash"],
    };
    synthetic.agents.set("test-tiered@1", {
      id: "test-tiered",
      version: 1,
      ref: "test-tiered@1",
      output_contract: "factory.test/v1",
      workspace: { type: "ephemeral" },
      capabilities: { services: [] },
      limits: { timeout_seconds: 60, attempts: 1 },
      mutating: false,
      ...(modelTier !== undefined ? { model_tier: modelTier } : {}),
      ...(model !== undefined ? { model } : {}),
      inputSchema: { type: "object" },
    });
    return synthetic;
  }

  const tieredEnvelope = (payload = { subject: "x" }) => ({
    type: "test.tiered.requested",
    eventId: `tier-${JSON.stringify(payload)}`,
    correlationId: null,
    payload,
  });

  test("declared tier resolves through the policy map and is pinned into the spec the operator approves", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(
      db,
      tieredRegistry({ modelTier: "standard" }),
      ref,
      { now: NOW, policyVersion: "git:test" },
    );
    expect(outcome.decision).toBe("run");
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.model).toBe("sonnet");
    expect(spec.modelTier).toBe("standard");
  });

  test('tier resolving to the default sentinel pins "default" explicitly — visible, not implicit', () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(
      db,
      tieredRegistry({ modelTier: "strong" }),
      ref,
      { now: NOW, policyVersion: "git:test" },
    );
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.model).toBe("default");
    expect(spec.modelTier).toBe("strong");
  });

  test("per-definition model override wins over the tier map", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(
      db,
      tieredRegistry({ modelTier: "standard", model: "claude-opus-4-1" }),
      ref,
      { now: NOW, policyVersion: "git:test" },
    );
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.model).toBe("claude-opus-4-1");
    expect(spec.modelTier).toBe("standard");
  });

  test("an agent overlay model pin outside the tier map is an explicit pin — planned verbatim, not parked (gh-1704)", () => {
    const db = openDb(":memory:");
    putOverride(db, {
      kind: KIND_AGENT,
      key: "test-tiered@1",
      patch: { model: "claude-opus-4-1" },
    });
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(
      db,
      tieredRegistry({ modelTier: "standard" }),
      ref,
      { now: NOW, policyVersion: "git:test" },
    );
    expect(outcome.decision).toBe("run");
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec).toMatchObject({
      adapter: "claude",
      modelTier: "standard",
      model: "claude-opus-4-1",
    });
  });

  test("a tier-resolved model follows an adapter overlay flip and is consistent with that adapter's map (gh-1704)", () => {
    const db = openDb(":memory:");
    const modelTiers = {
      claude: { strong: "default", standard: "sonnet", light: "haiku" },
      pi: {
        strong: "openai-codex/gpt-5.6-sol",
        standard: "openai-codex/gpt-5.6-terra",
        light: "openai-codex/gpt-5.6-luna",
      },
    };
    putOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: "test.tiered.requested",
      patch: { adapter: "pi" },
    });
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(
      db,
      tieredRegistry({ modelTier: "standard", modelTiers }),
      ref,
      { now: NOW, policyVersion: "git:test" },
    );
    expect(outcome.decision).toBe("run");
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec).toMatchObject({
      adapter: "pi",
      modelTier: "standard",
      model: "openai-codex/gpt-5.6-terra",
    });
    expect(modelAdapterMismatch(spec, modelTiers, spec.adapter)).toBeNull();
    expect(
      modelAdapterMismatch(spec, modelTiers, spec.adapter, {
        explicitPin: false,
      }),
    ).toBeNull();
  });

  describe("modelAdapterMismatch (gh-1704)", () => {
    const modelTiers = {
      claude: { strong: "default", standard: "sonnet", light: "haiku" },
      pi: { standard: "openai-codex/gpt-5.6-terra" },
    };

    test("a tier-resolved model outside its adapter's map is a mismatch", () => {
      expect(
        modelAdapterMismatch(
          { model: "openai-codex/gpt-5.6-terra" },
          modelTiers,
          "claude",
          { explicitPin: false },
        ),
      ).toStartWith("model_adapter_mismatch:");
    });

    test("an explicit pin is accepted as-is whatever the map says", () => {
      expect(
        modelAdapterMismatch(
          { model: "openai-codex/gpt-5.6-terra" },
          modelTiers,
          "claude",
          { explicitPin: true },
        ),
      ).toBeNull();
    });

    test("unknown provenance: another adapter's tier value is a mismatch, any other value is a pin", () => {
      expect(
        modelAdapterMismatch(
          { model: "openai-codex/gpt-5.6-terra" },
          modelTiers,
          "claude",
        ),
      ).toStartWith("model_adapter_mismatch:");
      expect(
        modelAdapterMismatch(
          { model: "claude-opus-4-1" },
          modelTiers,
          "claude",
        ),
      ).toBeNull();
      expect(
        modelAdapterMismatch({ model: "sonnet" }, modelTiers, "claude"),
      ).toBeNull();
    });

    test("an adapter that takes no model never mismatches one", () => {
      expect(
        modelAdapterMismatch(
          { model: "openai-codex/gpt-5.6-terra" },
          modelTiers,
          "fake",
          { explicitPin: false },
        ),
      ).toBeNull();
    });

    test("a spec without a model is never a mismatch", () => {
      expect(modelAdapterMismatch({}, modelTiers, "claude")).toBeNull();
      expect(
        modelAdapterMismatch({ model: null }, modelTiers, "pi"),
      ).toBeNull();
    });
  });

  test("a definition declaring nothing produces a spec without model fields — today's behavior (regression)", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(db, tieredRegistry(), ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect("model" in spec).toBe(false);
    expect("modelTier" in spec).toBe(false);
  });

  test("a tier routed via a non-model adapter is recorded as not applicable (model null), never an error", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(
      db,
      tieredRegistry({ modelTier: "light", adapter: "fake", modelTiers: {} }),
      ref,
      { now: NOW, policyVersion: "git:test" },
    );
    expect(outcome.decision).toBe("run");
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.model).toBeNull();
    expect(spec.modelTier).toBe("light");
  });

  test("adapterOverride does not change resolution: the registered claude route still pins the model", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(db, tieredRegistry({ modelTier: "light" }), ref, {
      now: NOW,
      policyVersion: "git:test",
      adapterOverride: "fake",
    });
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.adapter).toBe("fake");
    expect(spec.model).toBe("haiku");
  });

  test("declared tier with no policy mapping fails the plan closed — never a silent adapter default", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    // Bypassing loadRegistry's own load-time check (synthetic registry): the
    // planner is the second line of the same fail-closed rule.
    expect(() =>
      planEvent(
        db,
        tieredRegistry({ modelTier: "light", modelTiers: {} }),
        ref,
        { now: NOW, policyVersion: "git:test" },
      ),
    ).toThrow(/no mapping for adapter "claude"/);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
  });
});

describe("buildRunSpec", () => {
  test("a dispatch with no per-ticket tier source stays byte-identical to the definition-only spec (WM-694)", () => {
    const mapping = registry.eventTypes["factory.dispatch.requested"];
    const dispatch = envelope({
      eventId: "dispatch-baseline",
      type: "factory.dispatch.requested",
      source: "operator",
      subject: "WM-694",
      correlationId: "dispatch-baseline",
      payload: { repo: "factory", ticket: "WM-694" },
    });
    const spec = buildRunSpec(registry, dispatch, mapping, {
      runId: "run_baseline",
      policyVersion: "git:test",
      now: 0,
    });
    // Regenerated (#2013): dispatch documents draft PR readiness; prompt pin only.
    expect(canonicalJson(spec)).toBe(
      '{"adapter":"cursor","agent":"dispatch@1","capabilities":["tracker:write","repo:write","github:write"],"defHash":"sha256:4a12ffc0fa80ad8b97a9757361ee319589c3567de36f8d9aa33ef917ff26a4d2","idempotencyKey":"dispatch@1:factory.dispatch-result/v1:sha256:4381f987d301384843e8cf651c969e06c3d9dba79b947f3c07b5c3852926cf59:dispatch-baseline","input":{"repo":"factory","ticket":"WM-694"},"inputHash":"sha256:4381f987d301384843e8cf651c969e06c3d9dba79b947f3c07b5c3852926cf59","maxAttempts":1,"model":"cursor-grok-4.6-high","modelTier":"strong","outputContract":"factory.dispatch-result/v1","policyVersion":"git:test","promptVersion":"git:test","runId":"run_baseline","schemaVersion":"factory.run-spec/v1","timeoutSeconds":5400,"workspace":{"checkoutDir":"repo","retainOnFailure":true,"type":"worktree"}}',
    );
  });

  test("persists the registered definition's defHash pin (WM-1056)", () => {
    const mapping = registry.eventTypes["factory.status-report.requested"];
    const def = registry.agents.get("factory-status-report@1");
    const spec = buildRunSpec(registry, envelope(), mapping, {
      runId: "run_defhash",
      policyVersion: "git:test",
      now: NOW,
    });
    // Present and computed with the canonical helper the worker's
    // claim-time verifyDefHash consumes.
    expect(spec.defHash).toBe(computeDefHash(def));
    expect(spec.defHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Deterministic for identical definitions.
    const again = buildRunSpec(registry, envelope(), mapping, {
      runId: "run_defhash_2",
      policyVersion: "git:test",
      now: NOW,
    });
    expect(again.defHash).toBe(spec.defHash);
    // Changes when attested definition content changes.
    const synthetic = { ...registry, agents: new Map(registry.agents) };
    synthetic.agents.set("factory-status-report@1", {
      ...def,
      output_contract: "factory.status-report/v2",
    });
    const mutated = buildRunSpec(
      synthetic,
      envelope(),
      synthetic.eventTypes["factory.status-report.requested"],
      { runId: "run_defhash_3", policyVersion: "git:test", now: NOW },
    );
    expect(mutated.defHash).not.toBe(spec.defHash);
    // Per-ticket model/model-tier overrides must NOT redefine the attested
    // definition (AC4): defHash stays pinned to the registered def.
    const overridden = buildRunSpec(registry, envelope(), mapping, {
      runId: "run_defhash_4",
      policyVersion: "git:test",
      now: NOW,
      modelTierOverride: "strong",
      modelOverride: "openai-codex/gpt-5.6-terra",
    });
    expect(overridden.defHash).toBe(spec.defHash);
  });

  test("is pure and honors adapterOverride", () => {
    const mapping = registry.eventTypes["factory.status-report.requested"];
    const opts = { runId: "run_x", policyVersion: "git:abc", now: NOW };
    const a = buildRunSpec(registry, envelope(), mapping, opts);
    const b = buildRunSpec(registry, envelope(), mapping, opts);
    expect(hashJson(a)).toBe(hashJson(b));
    const overridden = buildRunSpec(registry, envelope(), mapping, {
      ...opts,
      adapterOverride: "pi",
    });
    expect(overridden.adapter).toBe("pi");
    expect(overridden.idempotencyKey).toBe(a.idempotencyKey);
  });

  test("pins only the declared harness source files in the approved spec", () => {
    const def = registry.agents.get("factory-status-report@1");
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
    };
    synthetic.agents.set("factory-status-report@1", {
      ...def,
      harness: { commands: ["factory-ticket"] },
    });
    const mapping = synthetic.eventTypes["factory.status-report.requested"];
    const spec = buildRunSpec(synthetic, envelope(), mapping, {
      runId: "run_harness_pins",
      policyVersion: "git:test",
      now: NOW,
    });

    expect(spec.harness).toEqual({ commands: ["factory-ticket"] });
    expect(spec.harnessPins).toEqual({
      core: {
        origin: "builtin",
        name: "factory/core",
        version: "0.1.0",
        files: {
          "commands/factory-ticket.md": hashBytes(
            readFileSync("shared/commands/factory-ticket.md"),
          ),
        },
      },
    });
  });
});

describe("planEvent runtime overlay (WM-887)", () => {
  test("an event-type adapter overlay pins that adapter and resolves the model via its policy map", () => {
    const db = openDb(":memory:");
    const ref = admit(db);
    putOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: "factory.status-report.requested",
      patch: { adapter: "cursor" },
    });
    const outcome = planEvent(db, registry, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(outcome.decision).toBe("run");
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.adapter).toBe("cursor");
    expect(spec.modelTier).toBe("standard");
    expect(spec.model).toBe("cursor-grok-4.6-high");
  });

  test("deleting the overlay returns the next plan to the git adapter; the first spec is unchanged", () => {
    const db = openDb(":memory:");
    const firstRef = admit(db, {
      eventId: "overlay-first",
      correlationId: "c1",
    });
    putOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: "factory.status-report.requested",
      patch: { adapter: "cursor" },
    });
    const first = planEvent(db, registry, firstRef, {
      now: NOW,
      policyVersion: "git:test",
    });
    const firstSpec = JSON.parse(first.proposal.spec_json);
    expect(firstSpec.adapter).toBe("cursor");
    deleteOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: "factory.status-report.requested",
    });
    const secondRef = admit(db, {
      eventId: "overlay-second",
      correlationId: "c2",
    });
    const second = planEvent(db, registry, secondRef, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(JSON.parse(second.proposal.spec_json).adapter).toBe("pi");
    expect(
      JSON.parse(
        db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(first.runId)
          .spec_json,
      ).adapter,
    ).toBe("cursor");
  });

  test("an agent model_tier overlay pins the resolved model; payload.modelTier still wins on dispatch", () => {
    const db = openDb(":memory:");
    putOverride(db, {
      kind: KIND_AGENT,
      key: "factory-status-report@1",
      patch: { modelTier: "light" },
    });
    const ref = admit(db, { eventId: "tier-overlay", correlationId: "tier-c" });
    const outcome = planEvent(db, registry, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.modelTier).toBe("light");
    expect(spec.model).toBe("openai-codex/gpt-5.6-luna");
  });

  test("a stale overlay adapter parks human_needed instead of planning", () => {
    const db = openDb(":memory:");
    db.query(
      `INSERT INTO runtime_overrides (kind, key, patch_json, updated_at, updated_by)
       VALUES ('eventType', 'factory.status-report.requested', '{"adapter":"nope"}', 't', 'x')`,
    ).run();
    const ref = admit(db, {
      eventId: "stale-overlay",
      correlationId: "stale-c",
    });
    const outcome = planEvent(db, registry, ref, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toBe("overlay_unknown_adapter:nope");
  });
});

describe("planAdmittedEvents", () => {
  test("snapshots policy.yaml and repos.yaml once for a multi-candidate dispatch tick (GH-1362)", () => {
    const root = tmpDir("evrt-plan-config-snapshot-");
    const configDir = path.join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const reposFile = path.join(configDir, "repos.yaml");
    const policyFile = path.join(configDir, "policy.yaml");
    writeFileSync(
      reposFile,
      `repos:\n  - name: snapshotted\n    path: /tmp/nowhere\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
        `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`,
    );
    writeFileSync(
      policyFile,
      "concurrency:\n  max_in_flight_per_repo: 5\ndispatch:\n  security_tickets: auto\n  owned_paths_collision: advisory\n" +
        "chain_auto_approval:\n  allowed_event_types: []\n",
    );
    const previous = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = root;
    const reads = new Map();
    const realReadFileSync = nodeFs.readFileSync;
    const readSpy = spyOn(nodeFs, "readFileSync").mockImplementation(
      (file, ...args) => {
        const filename = String(file);
        if (filename === reposFile || filename === policyFile) {
          reads.set(filename, (reads.get(filename) ?? 0) + 1);
        }
        return realReadFileSync(file, ...args);
      },
    );
    try {
      const snapshotRegistry = {
        ...registry,
        agents: new Map(registry.agents),
        eventTypes: { ...registry.eventTypes },
      };
      snapshotRegistry.eventTypes["test.config-snapshot.requested"] = {
        agent: "test-config-snapshot@1",
        adapter: "claude",
        idempotencyScope: ["inputHash"],
      };
      snapshotRegistry.agents.set("test-config-snapshot@1", {
        id: "test-config-snapshot",
        version: 1,
        ref: "test-config-snapshot@1",
        output_contract: "factory.test/v1",
        workspace: { type: "worktree" },
        capabilities: { services: [] },
        limits: { timeout_seconds: 60, attempts: 1 },
        mutating: true,
        inputSchema: {
          type: "object",
          required: ["repo", "ticket"],
          properties: {
            repo: { type: "string" },
            ticket: { type: "string" },
          },
        },
      });
      const db = openDb(":memory:");
      for (let i = 1; i <= 5; i++) {
        expect(
          admitEvent(
            db,
            snapshotRegistry,
            envelope({
              type: "test.config-snapshot.requested",
              eventId: `snapshot-candidate-${i}`,
              correlationId: `snapshot-candidate-${i}`,
              payload: { repo: "snapshotted", ticket: `WM-${13620 + i}` },
            }),
            { now: NOW },
          ).admitted,
        ).toBe(true);
      }

      expect(
        planAdmittedEvents(db, snapshotRegistry, {
          now: NOW,
          dispatch: {
            countLeases: () => 0,
            budgetRefusal: () => null,
            fetchTicket: (ticket) => ({
              identifier: ticket,
              state: { name: "Todo" },
              assignee: null,
              labels: { nodes: [{ name: "ai:agent-ready" }] },
              description: "## Owned Paths\n- event-runtime/lib/planner.mjs\n",
            }),
            fetchInFlight: () => [],
          },
        }),
      ).toEqual({ planned: 5, failed: 0, deadLettered: 0 });
      // Five candidates used to cost six parses of each file (#1362). The
      // eligibility path now reads each once; the post-plan auto-approval
      // pass may read policy.yaml one more time, never once per candidate.
      expect(reads.get(reposFile)).toBe(1);
      expect(reads.get(policyFile) ?? 0).toBeLessThanOrEqual(2);
    } finally {
      readSpy.mockRestore();
      if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previous;
    }
  });

  test("records and logs a typed reason for a nooped dispatch", () => {
    const root = tmpDir("evrt-plan-noop-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: gated\n    path: /tmp/nowhere\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
        `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`,
    );
    const previous = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = root;
    try {
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "dispatch-security",
        correlationId: "dispatch-security",
        payload: { repo: "gated", ticket: "WM-969" },
      });
      const lines = [];

      expect(
        planAdmittedEvents(db, registry, {
          now: NOW,
          dispatch: {
            countLeases: () => 0,
            budgetRefusal: () => null,
            fetchTicket: () => ({
              identifier: "WM-969",
              state: { name: "Todo" },
              assignee: null,
              labels: {
                nodes: [{ name: "ai:agent-ready" }, { name: "type:security" }],
              },
              description: "## Owned Paths\n- event-runtime/lib/planner.mjs\n",
            }),
            fetchInFlight: () => [],
          },
          log: (line) => lines.push(line),
        }),
      ).toEqual({ planned: 1, failed: 0, deadLettered: 0 });

      expect(
        db
          .query(
            `SELECT status, last_plan_error FROM events WHERE source = ? AND event_id = ?`,
          )
          .get(ref.source, ref.eventId),
      ).toEqual({ status: "noop", last_plan_error: "ticket_security" });
      expect(lines).toEqual([
        `planned noop (ticket_security) — ${ref.source}:${ref.eventId}`,
      ]);
    } finally {
      if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previous;
    }
  });

  test("dead-letters an event after DEAD_LETTER_AFTER consecutive plan failures (§13)", () => {
    const db = openDb(":memory:");
    const ref = admit(db);
    const broken = {}; // getEventType throws on this — a poison planning input

    for (let i = 1; i < DEAD_LETTER_AFTER; i++) {
      expect(planAdmittedEvents(db, broken)).toEqual({
        planned: 0,
        failed: 1,
        deadLettered: 0,
      });
      const event = db
        .query(`SELECT * FROM events WHERE event_id = ?`)
        .get(ref.eventId);
      expect(event.status).toBe("admitted");
      expect(event.plan_failures).toBe(i);
    }

    expect(planAdmittedEvents(db, broken)).toEqual({
      planned: 0,
      failed: 1,
      deadLettered: 1,
    });
    const event = db
      .query(`SELECT * FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(event.status).toBe("dead_lettered");
    expect(event.plan_failures).toBe(DEAD_LETTER_AFTER);
    expect(event.last_plan_error).toBeTruthy();

    // Dead-lettered events leave the sweep; nothing is wedged.
    expect(planAdmittedEvents(db, broken)).toEqual({
      planned: 0,
      failed: 0,
      deadLettered: 0,
    });
  });

  test("plans every admitted event and reports counts", () => {
    const db = openDb(":memory:");
    admit(db, { eventId: "delivery-1" });
    admit(db, { eventId: "delivery-2", correlationId: "workflow-02" });
    const counts = planAdmittedEvents(db, registry, {
      now: NOW,
      policyVersion: "git:test",
    });
    expect(counts).toEqual({ planned: 2, failed: 0, deadLettered: 0 });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);
  });

  test("holds write transaction from second connection and does not increment plan_failures or dead-letter (OPS-451)", () => {
    const dir = tmpDir("evrt-planner-");
    const file = path.join(dir, "test.db");
    const db1 = openDb(file);
    const db2 = openDb(file);
    db2.exec("PRAGMA busy_timeout = 10;");

    const ref = admit(db1);

    // db1 holds write transaction
    db1.exec("BEGIN IMMEDIATE;");
    try {
      for (let i = 0; i < DEAD_LETTER_AFTER + 1; i++) {
        const res = planAdmittedEvents(db2, registry);
        expect(res.deadLettered).toBe(0);
        expect(res.failed).toBe(0);
      }
    } finally {
      db1.exec("ROLLBACK;");
    }

    const event = db1
      .query(`SELECT * FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(event.status).toBe("admitted");
    expect(event.plan_failures).toBe(0);
  });

  test("three consecutive lock collisions leave the event admitted, not dead_lettered (OPS-451)", () => {
    const dir = tmpDir("evrt-planner-");
    const file = path.join(dir, "test.db");
    const db1 = openDb(file);
    const db2 = openDb(file);
    db2.exec("PRAGMA busy_timeout = 10;");

    const ref = admit(db1);

    db1.exec("BEGIN IMMEDIATE;");
    try {
      for (let i = 0; i < 3; i++) {
        const res = planAdmittedEvents(db2, registry);
        expect(res.deadLettered).toBe(0);
      }
    } finally {
      db1.exec("ROLLBACK;");
    }

    const event = db1
      .query(`SELECT * FROM events WHERE event_id = ?`)
      .get(ref.eventId);
    expect(event.status).toBe("admitted");
    expect(event.plan_failures).toBe(0);
  });

  test("TTL re-plan preserves repoPin for repository workspace agent across expiry (OPS-418)", () => {
    const root = tmpDir("evrt-plan-factory-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    const repoDir = tmpDir("evrt-repo-");
    execFileSync("git", ["init", "--quiet", "--initial-branch=develop"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(path.join(repoDir, "README.md"), "bj29\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repoDir });

    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: bj29\n    path: ${repoDir}\n    github: watt-mind/bj29\n    base: develop\n`,
    );
    const oldReposRoot = process.env.FACTORY_REPOS_ROOT;
    const oldHome = process.env.FACTORY_EVENT_HOME;
    process.env.FACTORY_REPOS_ROOT = root;
    process.env.FACTORY_EVENT_HOME = tmpDir("evrt-plan-home-");

    try {
      const db = openDb(":memory:");
      const ref = admit(db, {
        eventId: "triage-1",
        type: "factory.triage.requested",
        payload: { repo: "bj29", ref: "develop" },
      });
      const outcome = planEvent(db, registry, ref, {
        now: NOW,
        policyVersion: "git:test",
      });
      expect(outcome.decision).toBe("run");
      const originalSpec = JSON.parse(outcome.proposal.spec_json);
      expect(originalSpec.input.repoPin).toBeTruthy();
      expect(originalSpec.input.repoPin.sha).toMatch(/^[0-9a-f]{40}$/);

      // Stored event envelope now carries repoPin
      const storedEvent = db
        .query(
          `SELECT envelope_json FROM events WHERE source = ? AND event_id = ?`,
        )
        .get(ref.source, ref.eventId);
      const storedEnvelope = JSON.parse(storedEvent.envelope_json);
      expect(storedEnvelope.payload.repoPin).toBeTruthy();

      const mapping = registry.eventTypes["factory.triage.requested"];
      const replannedSpec = buildRunSpec(registry, storedEnvelope, mapping, {
        runId: outcome.runId,
        policyVersion: "git:test",
        now: NOW + 3600 * 1000,
      });
      expect(replannedSpec.input.repoPin).toEqual(originalSpec.input.repoPin);
      expect(hashJson(replannedSpec)).toBe(outcome.proposal.spec_hash);
      expect(replannedSpec.idempotencyKey).toBe(originalSpec.idempotencyKey);
    } finally {
      if (oldReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = oldReposRoot;
      if (oldHome === undefined) delete process.env.FACTORY_EVENT_HOME;
      else process.env.FACTORY_EVENT_HOME = oldHome;
    }
  });

  test("TTL re-plan preserves runPin for artifacts workspace agent across expiry (OPS-418)", () => {
    const db = openDb(":memory:");
    const priorRunId = "run_prior_123";
    createRun(db, {
      runId: priorRunId,
      idempotencyKey: "prior-key",
      spec: {},
      specJson: JSON.stringify({ agent: "factory-status-report@1" }),
      specHash: "sha256:0",
      actor: "test",
      policyVersion: "git:test",
    });
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:a', '{}', '{}', ?)`,
    ).run(
      priorRunId,
      JSON.stringify({
        artifacts: [
          {
            kind: "transcript",
            uri: "file:///tmp/t.json",
            sha256:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        ],
      }),
      new Date(NOW).toISOString(),
    );

    const artifactStore = tmpDir("evrt-pm-store-");
    const transcriptSha =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    writeFileSync(path.join(artifactStore, transcriptSha), "{}");

    const ref = admit(db, {
      eventId: "postmortem-1",
      type: "factory.run-postmortem.requested",
      payload: { runId: priorRunId },
    });
    const outcome = planEvent(db, registry, ref, {
      now: NOW,
      policyVersion: "git:test",
      artifactStore,
    });
    expect(outcome.decision).toBe("run");
    const originalSpec = JSON.parse(outcome.proposal.spec_json);
    expect(originalSpec.input.runPin).toBeTruthy();
    expect(originalSpec.input.runPin.transcript).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    const storedEvent = db
      .query(
        `SELECT envelope_json FROM events WHERE source = ? AND event_id = ?`,
      )
      .get(ref.source, ref.eventId);
    const storedEnvelope = JSON.parse(storedEvent.envelope_json);
    expect(storedEnvelope.payload.runPin).toBeTruthy();

    const mapping = registry.eventTypes["factory.run-postmortem.requested"];
    const replannedSpec = buildRunSpec(registry, storedEnvelope, mapping, {
      runId: outcome.runId,
      policyVersion: "git:test",
      now: NOW + 3600 * 1000,
    });
    expect(replannedSpec.input.runPin).toEqual(originalSpec.input.runPin);
    expect(hashJson(replannedSpec)).toBe(outcome.proposal.spec_hash);
    expect(replannedSpec.idempotencyKey).toBe(originalSpec.idempotencyKey);
  });
});

const TICKET_REPO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ticket: { type: "string" },
    repo: { type: "string" },
    runPin: {
      type: "object",
      properties: { transcript: { type: "string" } },
    },
  },
};

function memoDoc(overrides = {}) {
  const { provenance, ...rest } = overrides;
  return withProvenance(
    {
      schemaVersion: MEMO_SCHEMA_VERSION,
      subject: { type: "ticket", id: "WM-810" },
      kind: "postmortem",
      body: "Run the scoped command, not the full suite.",
      ...rest,
    },
    provenance ?? {
      runId: "run_producer",
      agent: "run-postmortem@2",
      createdAt: "2026-08-18T14:02:11.000Z",
    },
  );
}

function acceptMemo(document) {
  const sha256 = memoDigest(document);
  const store = artifactsRoot();
  mkdirSync(store, { recursive: true });
  writeFileSync(path.join(store, sha256), canonicalJson(document));
  return {
    sha256,
    result: { memos: [{ sha256, document }] },
  };
}

function withMemoConfig(fn) {
  const root = tmpDir("evrt-plan-memos-");
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    "repos:\n  - name: factory\n    path: /tmp/factory\n    base: develop\n",
  );
  writeFileSync(path.join(root, "config", "policy.yaml"), "models: {}\n");

  // Memo normalization reads the repository index through the process-wide
  // FACTORY_REPOS_ROOT seam. Keep this synchronous scope as narrow as the
  // code under test; no other test file can observe it while JavaScript is
  // executing here, and restore the prior value rather than deleting it.
  const previous = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function memoReaderRegistry() {
  const synthetic = {
    ...registry,
    agents: new Map(registry.agents),
    eventTypes: { ...registry.eventTypes },
  };
  synthetic.eventTypes["test.memo.requested"] = {
    agent: "memo-reader@1",
    adapter: "fake",
    idempotencyScope: ["inputHash"],
  };
  synthetic.agents.set("memo-reader@1", {
    id: "memo-reader",
    version: 1,
    ref: "memo-reader@1",
    output_contract: "factory.test/v1",
    workspace: { type: "artifacts", inputs: [] },
    capabilities: { services: [] },
    limits: { timeout_seconds: 60, attempts: 1 },
    mutating: false,
    inputSchema: {
      type: "object",
      required: ["ticket", "repo"],
      additionalProperties: false,
      properties: {
        ticket: { type: "string" },
        repo: { type: "string" },
        memoPin: { type: "object" },
      },
    },
    memos: [
      {
        subject: { type: "ticket", id: "$.input.ticket" },
        kinds: ["postmortem", "decision"],
        max: 10,
      },
      {
        subject: { type: "repo", id: "$.input.repo" },
        kinds: ["repo-note"],
      },
    ],
  });
  return synthetic;
}

function admitMemo(db, memoRegistry, overrides = {}, now = NOW) {
  const result = admitEvent(
    db,
    memoRegistry,
    {
      schemaVersion: "factory.event/v1",
      eventId: "memo-1",
      type: "test.memo.requested",
      source: "operator-webhook",
      subject: "factory",
      occurredAt: "2026-08-12T10:30:00Z",
      correlationId: "memo-line",
      causationId: null,
      ...overrides,
      payload: {
        ticket: "WM-810",
        repo: "factory",
        ...(overrides.payload ?? {}),
      },
    },
    { now },
  );
  expect(result.admitted).toBe(true);
  return { source: result.event.source, eventId: result.event.event_id };
}

describe("validateMemosDeclaration (WM-810)", () => {
  const ok = [
    {
      subject: { type: "ticket", id: "$.input.ticket" },
      kinds: ["postmortem"],
      max: 10,
    },
  ];

  test("accepts a well-formed declaration against the input schema", () => {
    expect(() =>
      validateMemosDeclaration(ok, {
        source: "agents/x.json",
        inputSchema: TICKET_REPO_SCHEMA,
      }),
    ).not.toThrow();
  });

  test("unknown kinds, subject types, and fields fail at load", () => {
    expect(() =>
      validateMemosDeclaration(
        [{ subject: { type: "board", id: "$.input.ticket" } }],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).toThrow(RegistryError);
    expect(() =>
      validateMemosDeclaration(
        [
          {
            subject: { type: "ticket", id: "$.input.ticket" },
            kinds: ["gossip"],
          },
        ],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).toThrow(/unknown kind/);
    expect(() =>
      validateMemosDeclaration(
        [
          {
            subject: { type: "ticket", id: "$.input.ticket" },
            extra: true,
          },
        ],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).toThrow(/unknown field/);
  });

  test("paths that do not resolve against the input schema fail at load", () => {
    expect(() =>
      validateMemosDeclaration(
        [{ subject: { type: "ticket", id: "$.input.missing" } }],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).toThrow(/does not resolve against the input schema/);
    expect(() =>
      validateMemosDeclaration(
        [{ subject: { type: "ticket", id: "ticket" } }],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).toThrow(/\$\.input\.<path>/);
    expect(() =>
      validateMemosDeclaration(
        [
          {
            subject: { type: "ticket", id: "$.input.runPin.transcript" },
          },
        ],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).not.toThrow();
  });

  test("empty kinds and non-positive max fail at load", () => {
    expect(() =>
      validateMemosDeclaration(
        [{ subject: { type: "ticket", id: "$.input.ticket" }, kinds: [] }],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).toThrow(/kinds must be a non-empty array/);
    expect(() =>
      validateMemosDeclaration(
        [{ subject: { type: "ticket", id: "$.input.ticket" }, max: 0 }],
        { source: "agents/x.json", inputSchema: TICKET_REPO_SCHEMA },
      ),
    ).toThrow(/positive integer/);
  });
});

describe("planEvent memoPin (WM-810)", () => {
  test("empty fold is empty entries, never human_needed", () => {
    withMemoConfig(() => {
      const db = openDb(":memory:");
      const memoRegistry = memoReaderRegistry();
      const ref = admitMemo(db, memoRegistry);
      const outcome = planEvent(db, memoRegistry, ref, {
        now: NOW,
        policyVersion: "git:test",
      });
      expect(outcome.decision).toBe("run");
      const spec = JSON.parse(outcome.proposal.spec_json);
      expect(spec.input.memoPin).toEqual({
        foldedAt: new Date(NOW).toISOString(),
        entries: [],
      });
    });
  });

  test("folds live memos into memoPin with hashes and provenance headers", () => {
    withMemoConfig(() => {
      const db = openDb(":memory:");
      const document = memoDoc();
      const { sha256, result } = acceptMemo(document);
      registerMemos(db, "run_producer", result, {
        now: Date.parse(document.provenance.createdAt),
      });
      const memoRegistry = memoReaderRegistry();
      const ref = admitMemo(db, memoRegistry);
      const outcome = planEvent(db, memoRegistry, ref, {
        now: NOW,
        policyVersion: "git:test",
      });
      expect(outcome.decision).toBe("run");
      const spec = JSON.parse(outcome.proposal.spec_json);
      expect(spec.input.memoPin.entries).toEqual([
        {
          sha256,
          subject: { type: "ticket", id: "WM-810" },
          kind: "postmortem",
          runId: "run_producer",
          createdAt: document.provenance.createdAt,
        },
      ]);
    });
  });

  test("kinds filter and max cap the fold; a new memo re-admits work", () => {
    withMemoConfig(() => {
      const db = openDb(":memory:");
      const note = memoDoc({
        subject: { type: "repo", id: "factory" },
        kind: "repo-note",
        claim: { kind: "howto", text: "Use the scoped lib suite." },
        evidence: "Root suite 6m40s; scoped 41s clean.",
        body: "Use the scoped lib suite.",
      });
      registerMemos(db, "run_note", acceptMemo(note).result, {
        now: Date.parse(note.provenance.createdAt),
      });
      const def = memoReaderRegistry().agents.get("memo-reader@1");
      const payload = { ticket: "WM-810", repo: "factory" };
      const first = pinMemos(db, def, payload, { now: NOW });
      expect(first.memoPin.entries.map((e) => e.kind)).toEqual(["repo-note"]);

      const later = memoDoc({
        body: "attempt 2 — do not rerun the full suite",
        provenance: {
          runId: "run_producer_2",
          agent: "run-postmortem@2",
          createdAt: "2026-08-18T15:00:00.000Z",
        },
      });
      registerMemos(db, "run_producer_2", acceptMemo(later).result, {
        now: Date.parse(later.provenance.createdAt),
      });
      const second = pinMemos(db, def, first, { now: NOW + 1000 });
      expect(second.memoPin.entries.map((e) => e.kind).sort()).toEqual([
        "postmortem",
        "repo-note",
      ]);
      expect(second.memoPin.foldedAt).not.toBe(first.memoPin.foldedAt);
      expect(hashJson(second)).not.toBe(hashJson(first));
    });
  });

  test("TTL re-plan preserves foldedAt when the live fold is unchanged", () => {
    withMemoConfig(() => {
      const db = openDb(":memory:");
      const document = memoDoc();
      registerMemos(db, "run_producer", acceptMemo(document).result, {
        now: Date.parse(document.provenance.createdAt),
      });
      const def = memoReaderRegistry().agents.get("memo-reader@1");
      const first = pinMemos(
        db,
        def,
        { ticket: "WM-810", repo: "factory" },
        { now: NOW },
      );
      const again = pinMemos(db, def, first, { now: NOW + 3600 * 1000 });
      expect(again.memoPin).toEqual(first.memoPin);
    });
  });

  test("missing memo artifacts retire once and leave the surviving fold stable", () => {
    withMemoConfig(() => {
      const db = openDb(":memory:");
      const missing = memoDoc({
        subject: { type: "repo", id: "factory" },
        kind: "decision",
        precedentOnly: true,
        body: "The missing decision.",
        refs: { inboxItemId: "inbox_missing" },
        provenance: {
          runId: null,
          agent: "runtime:inbox",
          createdAt: "2026-08-18T14:02:11.000Z",
        },
      });
      const surviving = memoDoc({
        subject: { type: "repo", id: "factory" },
        kind: "decision",
        precedentOnly: true,
        body: "The surviving decision.",
        refs: { inboxItemId: "inbox_surviving" },
        provenance: {
          runId: null,
          agent: "runtime:inbox",
          createdAt: "2026-08-18T14:02:12.000Z",
        },
      });
      const missingAccepted = acceptMemo(missing);
      const survivingAccepted = acceptMemo(surviving);
      registerMemos(db, null, missingAccepted.result, { now: NOW });
      registerMemos(db, null, survivingAccepted.result, { now: NOW });
      unlinkSync(path.join(artifactsRoot(), missingAccepted.sha256));

      const retired = [];
      const def = {
        memos: [
          {
            subject: { type: "repo", id: "$.input.repo" },
            kinds: ["decision"],
            max: 10,
          },
        ],
      };
      const first = pinMemos(
        db,
        def,
        { repo: "factory" },
        { now: NOW, onArtifactMissing: (memo) => retired.push(memo) },
      );
      expect(first.memoPin.entries.map((entry) => entry.sha256)).toEqual([
        survivingAccepted.sha256,
      ]);
      expect(retired).toEqual([
        expect.objectContaining({
          sha256: missingAccepted.sha256,
          inboxItemId: "inbox_missing",
          retiredReason: "artifact_missing",
          subject: { type: "repo", id: "factory" },
        }),
      ]);
      expect(
        db
          .query(
            `SELECT retired_at, retired_reason FROM memos WHERE sha256 = ?`,
          )
          .get(missingAccepted.sha256),
      ).toEqual({ retired_at: NOW, retired_reason: "artifact_missing" });

      const second = pinMemos(db, def, first, {
        now: NOW + 1000,
        onArtifactMissing: (memo) => retired.push(memo),
      });
      expect(second.memoPin).toEqual(first.memoPin);
      expect(retired).toHaveLength(1);
      db.close();
    });
  });

  test("artifact-missing logging waits for the planner transaction to commit", () => {
    withMemoConfig(() => {
      const db = openDb(":memory:");
      const document = memoDoc({
        subject: { type: "repo", id: "factory" },
        kind: "decision",
        precedentOnly: true,
        body: "Retire only after commit.",
        refs: { inboxItemId: "inbox_commit" },
        provenance: {
          runId: null,
          agent: "runtime:inbox",
          createdAt: "2026-08-18T14:02:13.000Z",
        },
      });
      const accepted = acceptMemo(document);
      registerMemos(db, null, accepted.result, { now: NOW });
      unlinkSync(path.join(artifactsRoot(), accepted.sha256));

      const memoRegistry = memoReaderRegistry();
      const def = memoRegistry.agents.get("memo-reader@1");
      memoRegistry.agents.set("memo-reader@1", {
        ...def,
        memos: [
          {
            subject: { type: "repo", id: "$.input.repo" },
            kinds: ["decision"],
            max: 10,
          },
        ],
      });
      memoRegistry.eventTypes["test.memo.requested"] = {
        ...memoRegistry.eventTypes["test.memo.requested"],
        idempotencyScope: ["invalid-after-memo-fold"],
      };
      const ref = admitMemo(db, memoRegistry, {
        eventId: "memo-rollback-log",
        correlationId: "memo-rollback-log",
      });
      const logs = [];
      expect(() =>
        planEvent(db, memoRegistry, ref, {
          now: NOW,
          policyVersion: "git:test",
          log: (line) => logs.push(line),
        }),
      ).toThrow(/unknown idempotency scope/);
      expect(logs).toEqual([]);
      expect(
        db
          .query(`SELECT retired_at FROM memos WHERE sha256 = ?`)
          .get(accepted.sha256).retired_at,
      ).toBeNull();

      memoRegistry.eventTypes["test.memo.requested"] = {
        ...memoRegistry.eventTypes["test.memo.requested"],
        idempotencyScope: ["inputHash"],
      };
      expect(
        planEvent(db, memoRegistry, ref, {
          now: NOW + 1,
          policyVersion: "git:test",
          log: (line) => logs.push(line),
        }).decision,
      ).toBe("run");
      expect(logs).toEqual([
        `memo retired artifact_missing sha256=${accepted.sha256} subject=repo:factory inbox_item_id=inbox_commit`,
      ]);
      expect(
        db
          .query(`SELECT retired_reason FROM memos WHERE sha256 = ?`)
          .get(accepted.sha256).retired_reason,
      ).toBe("artifact_missing");
      db.close();
    });
  });

  test("a new memo on a later event is a new run by inputHash", () => {
    withMemoConfig(() => {
      const db = openDb(":memory:");
      const memoRegistry = memoReaderRegistry();
      const firstRef = admitMemo(db, memoRegistry, { eventId: "memo-a" });
      const first = planEvent(db, memoRegistry, firstRef, {
        now: NOW,
        policyVersion: "git:test",
      });
      expect(first.decision).toBe("run");
      const firstHash = JSON.parse(first.proposal.spec_json).inputHash;

      const document = memoDoc();
      registerMemos(db, "run_producer", acceptMemo(document).result, {
        now: Date.parse(document.provenance.createdAt),
      });
      const secondRef = admitMemo(db, memoRegistry, { eventId: "memo-b" });
      const second = planEvent(db, memoRegistry, secondRef, {
        now: NOW + 1000,
        policyVersion: "git:test",
      });
      expect(second.decision).toBe("run");
      expect(second.runId).not.toBe(first.runId);
      const secondSpec = JSON.parse(second.proposal.spec_json);
      expect(secondSpec.inputHash).not.toBe(firstHash);
      expect(secondSpec.input.memoPin.entries).toHaveLength(1);
    });
  });
});

describe("Linear rate limit (WM-878)", () => {
  function withReposRoot(yaml, fn) {
    const root = tmpDir("evrt-plan-rl-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "config", "repos.yaml"), yaml);
    const previous = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = root;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previous;
    }
  }

  const gatedYaml =
    `repos:\n  - name: gated\n    path: /tmp/nowhere\n    base: develop\n` +
    `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
    `    worktree_root: /tmp/worktrees\n    escalate_paths: []\n`;

  const readyTicket = (id) => ({
    identifier: id,
    state: { name: "Todo" },
    assignee: null,
    labels: { nodes: [{ name: "ai:agent-ready" }] },
    description: "## Owned Paths\n- event-runtime/lib/planner.mjs\n",
  });

  function withLinearCli(source, fn) {
    const root = tmpDir("evrt-plan-linear-cli-");
    const cli = path.join(root, "linear.mjs");
    writeFileSync(cli, source);
    const previous = process.env.FACTORY_LINEAR_CLI;
    process.env.FACTORY_LINEAR_CLI = cli;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.FACTORY_LINEAR_CLI;
      else process.env.FACTORY_LINEAR_CLI = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }

  function deadlineBudget() {
    let reads = 0;
    return {
      deadline: 10_000,
      now: () => (reads++ < 2 ? 0 : 10_000),
    };
  }

  test("binds the read budget without replacing an omitted viewer config snapshot", () => {
    withLinearCli(
      'console.log(JSON.stringify({ viewer: { id: "viewer-1" } }));',
      () => {
        const cache = createLinearReadCache();
        cache.linearReadBudget = { deadline: 10_000, now: () => 0 };
        const reads = wrapLinearReads({}, cache, NOW, {
          repos: new Map([
            ["gated", { name: "gated", controlPlane: "linear" }],
          ]),
        });

        expect(reads.fetchViewer("gated")).toEqual({ id: "viewer-1" });
      },
    );
  });

  test("a deadline-boundary CLI 429 retains its resetAt", () => {
    withLinearCli(
      [
        'console.error(JSON.stringify({ resetAt: "2026-08-19T13:00:00.000Z" }));',
        "process.exit(3);",
      ].join("\n"),
      () => {
        const cache = createLinearReadCache();
        cache.linearReadBudget = deadlineBudget();
        const reads = wrapLinearReads({}, cache, NOW, {
          repos: new Map([
            ["gated", { name: "gated", controlPlane: "linear" }],
          ]),
        });

        let error;
        try {
          reads.fetchTicket("WM-429", "gated");
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(LinearRateLimitError);
        expect(error.resetAt).toBe("2026-08-19T13:00:00.000Z");
        expect(cache.rateLimitedUntil).toBe(
          Date.parse("2026-08-19T13:00:00.000Z"),
        );
      },
    );
  });

  test("a deadline-boundary missing ticket still returns null", () => {
    withLinearCli('console.error("no such issue"); process.exit(1);', () => {
      const cache = createLinearReadCache();
      cache.linearReadBudget = deadlineBudget();
      const reads = wrapLinearReads({}, cache, NOW, {
        repos: new Map([["gated", { name: "gated", controlPlane: "linear" }]]),
      });

      expect(reads.fetchTicket("WM-missing", "gated")).toBeNull();
    });
  });

  test("an exhausted budget defers every default read on a github plane (#1890)", () => {
    // wrapLinearReads skips its own pre-check for a github control plane, so
    // the budget throw surfaces from *inside* each default fetcher's try. It
    // must stay deferrable rather than being rewrapped as linear_read_failed.
    withLinearCli("throw new Error('the CLI must never be spawned');", () => {
      const configSnapshot = {
        repos: new Map([["gh", { name: "gh", controlPlane: "github" }]]),
      };
      for (const read of [
        (reads) => reads.fetchTicket("watt-mind/factory#534", "gh"),
        (reads) => reads.fetchViewer("gh"),
        (reads) =>
          reads.fetchInFlight({
            name: "gh",
            team: "WM",
            project: "Factory",
            controlPlane: "github",
          }),
      ]) {
        const cache = createLinearReadCache();
        cache.linearReadBudget = { deadline: 0, now: () => 5000 };
        let error;
        try {
          read(wrapLinearReads({}, cache, NOW, configSnapshot));
        } catch (caught) {
          error = caught;
        }
        expect(error?.name).toBe("LinearReadBudgetExceededError");
        expect(error?.message).toBe("linear_read_budget_exhausted");
      }
    });
  });

  test("a child killed by the read timeout at the deadline defers", () => {
    // The genuine linearReadTimedOut path: the budget still had room when the
    // child was spawned, the child was SIGTERMed by that timeout, and the
    // deadline has passed by the time the failure is classified.
    withLinearCli("Bun.sleepSync(2000);", () => {
      const cache = createLinearReadCache();
      let clockReads = 0;
      cache.linearReadBudget = {
        deadline: 100,
        now: () => (clockReads++ < 2 ? 0 : 100),
      };
      const reads = wrapLinearReads({}, cache, NOW, {
        repos: new Map([["gated", { name: "gated", controlPlane: "linear" }]]),
      });

      let error;
      try {
        reads.fetchTicket("WM-slow", "gated");
      } catch (caught) {
        error = caught;
      }
      expect(error?.name).toBe("LinearReadBudgetExceededError");
      expect(error?.message).toBe("linear_read_budget_exhausted");
    });
  });

  test("a simulated Linear 400 rate-limit refuses linear_rate_limited, leaves the event admitted, and does not dead-letter", () => {
    withReposRoot(gatedYaml, () => {
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "rate-limit-1",
        correlationId: "rate-limit-1",
        payload: { repo: "gated", ticket: "WM-878" },
      });
      const resetAt = "2026-08-19T13:00:00.000Z";
      const counts = planAdmittedEvents(db, registry, {
        now: NOW,
        policyVersion: "git:test",
        dispatch: {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchTicket: () => {
            throw new LinearRateLimitError(resetAt);
          },
          fetchInFlight: () => {
            throw new Error("in-flight must not run after a rate-limit");
          },
        },
      });
      expect(counts).toEqual({ planned: 0, failed: 0, deadLettered: 0 });
      const event = db
        .query(`SELECT * FROM events WHERE event_id = ?`)
        .get(ref.eventId);
      expect(event.status).toBe("admitted");
      expect(event.plan_failures).toBe(0);
      expect(event.last_plan_error).toMatch(/^linear_rate_limited:/);
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
      expect(db.query(`SELECT COUNT(*) AS n FROM proposals`).get().n).toBe(0);

      const direct = planEvent(db, registry, ref, {
        now: NOW,
        dispatch: {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchTicket: () => {
            throw new LinearRateLimitError(resetAt);
          },
        },
      });
      expect(direct).toMatchObject({
        decision: "refused",
        reason: "linear_rate_limited",
        resetAt,
      });
    });
  });

  test("an active cached Linear budget skips planner reads and logs its reset clock once", () => {
    withReposRoot(gatedYaml, () => {
      const db = openDb(":memory:");
      const ref = admit(db, {
        type: "factory.dispatch.requested",
        eventId: "cached-rate-limit-1",
        correlationId: "cached-rate-limit-1",
        payload: { repo: "gated", ticket: "WM-1835" },
      });
      const resetAt = "2026-08-19T13:00:00.000Z";
      const logs = [];
      let ticketReads = 0;

      const counts = planAdmittedEvents(db, registry, {
        now: NOW,
        policyVersion: "git:test",
        linearBudget: { rateLimited: true, resetAt },
        log: (line) => logs.push(line),
        dispatch: {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchTicket: () => {
            ticketReads += 1;
            return readyTicket("WM-1835");
          },
        },
      });

      expect(counts).toEqual({ planned: 0, failed: 0, deadLettered: 0 });
      expect(ticketReads).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/rate-limited/);
      expect(logs[0]).toContain(resetAt);
      const escapedResetAt = resetAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const event = db
        .query(`SELECT status, last_plan_error FROM events WHERE event_id = ?`)
        .get(ref.eventId);
      expect(event).toMatchObject({
        status: "admitted",
        last_plan_error: expect.stringMatching(
          new RegExp(`^linear_rate_limited:.*${escapedResetAt}`),
        ),
      });
    });
  });

  test("a stalled event cannot exhaust the next event's Linear read budget", () => {
    const checkout = tmpDir("evrt-plan-budget-repo-");
    execFileSync("git", ["init", "-q", "-b", "develop", checkout]);
    writeFileSync(path.join(checkout, "README.md"), "fixture\n");
    execFileSync("git", ["-C", checkout, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "fixture",
    ]);
    withReposRoot(gatedYaml.replace("/tmp/nowhere", checkout), () => {
      const db = openDb(":memory:");
      for (const ticket of ["WM-18661", "WM-18662"]) {
        admit(db, {
          type: "factory.dispatch.requested",
          eventId: `pass-budget-${ticket}`,
          correlationId: `pass-budget-${ticket}`,
          payload: { repo: "gated", ticket },
        });
      }
      let elapsed = 0;
      const ticketReads = [];

      expect(
        planAdmittedEvents(db, registry, {
          now: NOW,
          policyVersion: "git:test",
          linearReadClock: () => elapsed,
          linearReadTimeoutMs: 50,
          dispatch: {
            countLeases: () => 0,
            budgetRefusal: () => null,
            fetchTicket: (ticket) => {
              ticketReads.push(ticket);
              // Model the first stalled read consuming the pass budget.
              elapsed = 50;
              return readyTicket(ticket);
            },
            fetchInFlight: () => [],
          },
        }),
      ).toEqual({ planned: 1, failed: 0, deadLettered: 0 });

      expect(ticketReads).toEqual(["WM-18661", "WM-18662"]);
      expect(
        db
          .query(
            `SELECT status, plan_failures, last_plan_error FROM events WHERE event_id = ?`,
          )
          .get("pass-budget-WM-18661"),
      ).toMatchObject({
        status: "admitted",
        plan_failures: 0,
        last_plan_error: "linear_read_budget_exhausted",
      });
      expect(
        db
          .query(
            `SELECT status, last_plan_error FROM events WHERE event_id = ?`,
          )
          .get("pass-budget-WM-18662"),
      ).toEqual({ status: "planned", last_plan_error: null });
    });
  });

  // The default is what production runs on: no deployment sets
  // FACTORY_LINEAR_READ_TIMEOUT_MS, so a silent change to this number changes
  // how long a stalled Linear read can hold a planner pass.
  test.skipIf(process.env.FACTORY_LINEAR_READ_TIMEOUT_MS != null)(
    "the Linear read budget defaults to 25s when FACTORY_LINEAR_READ_TIMEOUT_MS is unset",
    () => {
      expect(LINEAR_READ_TIMEOUT_MS).toBe(25_000);
    },
  );

  test("one planning pass over 10 candidates makes at most 3 in-flight queries", () => {
    withReposRoot(gatedYaml, () => {
      const db = openDb(":memory:");
      for (let i = 1; i <= 10; i++) {
        admit(db, {
          type: "factory.dispatch.requested",
          eventId: `rl-cand-${i}`,
          correlationId: `rl-cand-${i}`,
          payload: { repo: "gated", ticket: `WM-${800 + i}` },
        });
      }
      const cache = createLinearReadCache();
      const counts = planAdmittedEvents(db, registry, {
        now: NOW,
        policyVersion: "git:test",
        linearReadCache: cache,
        dispatch: {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchTicket: (id) => readyTicket(id),
          fetchInFlight: () => [],
        },
      });
      expect(counts.failed).toBe(0);
      expect(counts.deadLettered).toBe(0);
      expect(cache.inFlightCalls).toBeLessThanOrEqual(3);
      expect(cache.inFlightCalls).toBeGreaterThan(0);
    });
  });

  test("viewer reads are cached per repo instead of crossing control planes", () => {
    const calls = [];
    const reads = wrapLinearReads(
      {
        fetchViewer: (repo) => {
          calls.push(repo);
          return { id: `${repo}-viewer` };
        },
      },
      createLinearReadCache(),
    );
    expect(reads.fetchViewer("linear-repo").id).toBe("linear-repo-viewer");
    expect(reads.fetchViewer("github-repo").id).toBe("github-repo-viewer");
    expect(reads.fetchViewer("linear-repo").id).toBe("linear-repo-viewer");
    expect(calls).toEqual(["linear-repo", "github-repo"]);
  });
});

describe("GitHub dispatch candidate parsing (GH-974)", () => {
  function withGithubRepo(fn) {
    const root = tmpDir("evrt-plan-github-");
    const checkout = path.join(root, "checkout");
    mkdirSync(checkout, { recursive: true });
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "config",
      "user.email",
      "test@example.com",
    ]);
    execFileSync("git", ["-C", checkout, "config", "user.name", "Test"]);
    writeFileSync(path.join(checkout, "README.md"), "fixture\n");
    execFileSync("git", ["-C", checkout, "add", "README.md"]);
    execFileSync("git", ["-C", checkout, "commit", "-qm", "fixture"]);

    const configRoot = path.join(root, "config-root");
    mkdirSync(path.join(configRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(configRoot, "config", "repos.yaml"),
      [
        "repos:",
        "  - name: github-candidates",
        `    path: ${checkout}`,
        "    github: watt-mind/factory",
        "    control_plane: github",
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
    const previous = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = configRoot;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("drops legacy Linear IDs from a GitHub candidate list before ticket reads", () => {
    withGithubRepo(() => {
      const db = openDb(":memory:");
      const valid = "watt-mind/factory#534";
      const legacy = "WM-621";
      for (const [eventId, ticket] of [
        ["github-candidate-valid", valid],
        ["github-candidate-legacy", legacy],
      ]) {
        admit(db, {
          type: "factory.dispatch.requested",
          eventId,
          correlationId: eventId,
          payload: { repo: "github-candidates", ticket },
        });
      }

      const reads = [];
      const logs = [];
      const counts = planAdmittedEvents(db, registry, {
        now: NOW,
        policyVersion: "git:test",
        log: (line) => logs.push(line),
        dispatch: {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchTicket: (ticket) => {
            reads.push(ticket);
            const description =
              "## Owned Paths\n- event-runtime/lib/planner.mjs\n";
            return {
              identifier: ticket,
              state: { name: "Todo" },
              assignee: null,
              labels: [{ name: "ai:agent-ready" }],
              description,
              controlPlaneKind: "github",
              authorAssociation: "MEMBER",
              lastEditorAssociation: "MEMBER",
              readyPinHash: hashJson(description),
            };
          },
          fetchInFlight: () => [],
        },
      });

      expect(counts).toEqual({ planned: 2, failed: 0, deadLettered: 0 });
      expect(reads).toEqual([valid]);
      expect(
        db
          .query(`SELECT status FROM events WHERE event_id = ?`)
          .get("github-candidate-valid").status,
      ).toBe("planned");
      const dropped = db
        .query(`SELECT status, last_plan_error FROM events WHERE event_id = ?`)
        .get("github-candidate-legacy");
      expect(dropped.status).toBe("noop");
      expect(dropped.last_plan_error).toMatch(
        /^ticket_identifier_unresolvable: not a GitHub issue identifier: WM-621/,
      );
      expect(logs).toContain(
        "planned noop (ticket_identifier_unresolvable: not a GitHub issue identifier: WM-621 (want owner/repo#N)) — operator-webhook:github-candidate-legacy",
      );
    });
  });

  test("an exhausted read budget defers a github candidate rather than failing the plan (#1890)", () => {
    withGithubRepo(() => {
      const db = openDb(":memory:");
      admit(db, {
        type: "factory.dispatch.requested",
        eventId: "github-budget-exhausted",
        correlationId: "github-budget-exhausted",
        payload: {
          repo: "github-candidates",
          ticket: "watt-mind/factory#534",
        },
      });

      // Default fetchers, budget already spent: the throw comes from inside
      // the fetcher's own try, which used to exit as a hard linear_read_failed.
      expect(
        planAdmittedEvents(db, registry, {
          now: NOW,
          policyVersion: "git:test",
          linearReadBudget: { deadline: 0, now: () => 5000 },
          dispatch: { countLeases: () => 0, budgetRefusal: () => null },
        }),
      ).toEqual({ planned: 0, failed: 0, deadLettered: 0 });

      expect(
        db
          .query(
            `SELECT status, plan_failures, last_plan_error FROM events WHERE event_id = ?`,
          )
          .get("github-budget-exhausted"),
      ).toMatchObject({
        status: "admitted",
        plan_failures: 0,
        last_plan_error: "linear_read_budget_exhausted",
      });
    });
  });
});
