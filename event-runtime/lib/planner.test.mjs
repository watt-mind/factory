import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashJson } from "./canonical.mjs";
import { DEAD_LETTER_AFTER } from "./config.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { createRun, lifecycleOf, runState } from "./lifecycle.mjs";
import { buildRunSpec, idempotencyKeyFor, planAdmittedEvents, planEvent } from "./planner.mjs";
import { loadRegistry } from "./registry.mjs";

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
    expect(a).toBe(`factory-status-report@1:factory.status-report/v1:workflow-01:${inputHash}`);
  });

  test("correlationId scope falls back to eventId; subject scope to empty string", () => {
    const inputHash = hashJson({ repos: ["bj29"] });
    const noCorrelation = envelope({ correlationId: null });
    expect(idempotencyKeyFor(mapping, def, noCorrelation, inputHash)).toBe(
      `factory-status-report@1:factory.status-report/v1:delivery-1:${inputHash}`,
    );
    const subjectScope = { idempotencyScope: ["subject"] };
    expect(idempotencyKeyFor(subjectScope, def, envelope({ subject: null }), inputHash)).toBe(
      "factory-status-report@1:factory.status-report/v1:",
    );
  });

  test("unknown scope field throws (fail closed)", () => {
    expect(() => idempotencyKeyFor({ idempotencyScope: ["deliveryColor"] }, def, envelope(), "sha256:x")).toThrow(
      /unknown idempotency scope/,
    );
  });
});

describe("planEvent", () => {
  test("run decision: PROPOSED run + open proposal with the §5.2 spec", () => {
    const db = openDb(":memory:");
    const ref = admit(db);
    const outcome = planEvent(db, registry, ref, { now: NOW, policyVersion: "git:test" });

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
      adapter: "claude",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.status-report/v1",
      capabilities: ["linear:read"],
      timeoutSeconds: 600,
      maxAttempts: 1,
      idempotencyKey: `factory-status-report@1:factory.status-report/v1:workflow-01:${hashJson(payload)}`,
    });

    const event = db.query(`SELECT status FROM events WHERE source = ? AND event_id = ?`).get(ref.source, ref.eventId);
    expect(event.status).toBe("planned");
    expect(lifecycleOf(db, outcome.runId).map((e) => e.to_state)).toEqual(["PROPOSED"]);
    expect(lifecycleOf(db, outcome.runId)[0].actor).toBe("planner");
  });

  test("planning the same event twice is idempotent: one run, one proposal", () => {
    const db = openDb(":memory:");
    const ref = admit(db);
    const first = planEvent(db, registry, ref, { now: NOW, policyVersion: "git:test" });
    const second = planEvent(db, registry, ref, { now: NOW + 60_000, policyVersion: "git:test" });
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
    const first = planEvent(db, registry, ref1, { now: NOW, policyVersion: "git:test" });
    const second = planEvent(db, registry, ref2, { now: NOW + 1000, policyVersion: "git:test" });

    expect(first.decision).toBe("run");
    expect(second.decision).toBe("noop");
    expect(second.reason).toBe("duplicate_run");
    expect(second.runId).toBe(first.runId);
    expect(second.proposal.run_id).toBe(first.runId);
    expect(second.proposal.status).toBe("resolved");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'`).get().n).toBe(1);
    const event = db.query(`SELECT status FROM events WHERE event_id = 'delivery-2'`).get();
    expect(event.status).toBe("noop");
  });

  test("repeat remediations with identical payload but distinct correlationId produce distinct runs (OPS-419)", () => {
    const db = openDb(":memory:");
    const ref1 = admit(db, {
      eventId: "keep-1",
      correlationId: "alert-1",
      type: "keephq.disk-remediate.requested",
      payload: { host: "lab", mount: "/", actions: [{ action: "docker-builder-prune" }] },
    });
    const ref2 = admit(db, {
      eventId: "keep-2",
      correlationId: "alert-2",
      type: "keephq.disk-remediate.requested",
      payload: { host: "lab", mount: "/", actions: [{ action: "docker-builder-prune" }] },
    });

    const first = planEvent(db, registry, ref1, { now: NOW, policyVersion: "git:test" });
    const second = planEvent(db, registry, ref2, { now: NOW + 1000, policyVersion: "git:test" });

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
      payload: { host: "lab", mount: "/", actions: [{ action: "docker-builder-prune" }] },
    });
    const ref2 = admit(db, {
      eventId: "keep-dup",
      correlationId: "alert-1",
      type: "keephq.disk-remediate.requested",
      payload: { host: "lab", mount: "/", actions: [{ action: "docker-builder-prune" }] },
    });

    const first = planEvent(db, registry, ref1, { now: NOW, policyVersion: "git:test" });
    const second = planEvent(db, registry, ref2, { now: NOW + 1000, policyVersion: "git:test" });

    expect(first.decision).toBe("run");
    expect(second.decision).toBe("noop");
    expect(second.reason).toBe("duplicate_run");
    expect(second.runId).toBe(first.runId);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
  });

  test("unregistered event type → human_needed", () => {
    const db = openDb(":memory:");
    const ref = admit(db, { type: "totally.unknown.type" });
    const outcome = planEvent(db, registry, ref, { now: NOW });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toBe("unregistered_event_type");
    expect(outcome.proposal.decision).toBe("human_needed");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    const event = db.query(`SELECT status FROM events WHERE event_id = ?`).get(ref.eventId);
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
    const event = db.query(`SELECT status FROM events WHERE event_id = ?`).get(ref.eventId);
    expect(event.status).toBe("noop");
  });

  test("payload failing the agent input schema → human_needed with the first error", () => {
    const db = openDb(":memory:");
    const ref = admit(db, { payload: { repos: [] } });
    const outcome = planEvent(db, registry, ref, { now: NOW });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason.startsWith("invalid_input: ")).toBe(true);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    const event = db.query(`SELECT status FROM events WHERE event_id = ?`).get(ref.eventId);
    expect(event.status).toBe("human_needed");
  });
});

describe("buildRunSpec", () => {
  test("is pure and honors adapterOverride", () => {
    const mapping = registry.eventTypes["factory.status-report.requested"];
    const opts = { runId: "run_x", policyVersion: "git:abc", now: NOW };
    const a = buildRunSpec(registry, envelope(), mapping, opts);
    const b = buildRunSpec(registry, envelope(), mapping, opts);
    expect(hashJson(a)).toBe(hashJson(b));
    const overridden = buildRunSpec(registry, envelope(), mapping, { ...opts, adapterOverride: "pi" });
    expect(overridden.adapter).toBe("pi");
    expect(overridden.idempotencyKey).toBe(a.idempotencyKey);
  });
});

describe("planAdmittedEvents", () => {
  test("dead-letters an event after DEAD_LETTER_AFTER consecutive plan failures (§13)", () => {
    const db = openDb(":memory:");
    const ref = admit(db);
    const broken = {}; // getEventType throws on this — a poison planning input

    for (let i = 1; i < DEAD_LETTER_AFTER; i++) {
      expect(planAdmittedEvents(db, broken)).toEqual({ planned: 0, failed: 1, deadLettered: 0 });
      const event = db.query(`SELECT * FROM events WHERE event_id = ?`).get(ref.eventId);
      expect(event.status).toBe("admitted");
      expect(event.plan_failures).toBe(i);
    }

    expect(planAdmittedEvents(db, broken)).toEqual({ planned: 0, failed: 1, deadLettered: 1 });
    const event = db.query(`SELECT * FROM events WHERE event_id = ?`).get(ref.eventId);
    expect(event.status).toBe("dead_lettered");
    expect(event.plan_failures).toBe(DEAD_LETTER_AFTER);
    expect(event.last_plan_error).toBeTruthy();

    // Dead-lettered events leave the sweep; nothing is wedged.
    expect(planAdmittedEvents(db, broken)).toEqual({ planned: 0, failed: 0, deadLettered: 0 });
  });

  test("plans every admitted event and reports counts", () => {
    const db = openDb(":memory:");
    admit(db, { eventId: "delivery-1" });
    admit(db, { eventId: "delivery-2", correlationId: "workflow-02" });
    const counts = planAdmittedEvents(db, registry, { now: NOW, policyVersion: "git:test" });
    expect(counts).toEqual({ planned: 2, failed: 0, deadLettered: 0 });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);
  });

  test("holds write transaction from second connection and does not increment plan_failures or dead-letter (OPS-451)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-planner-"));
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

    const event = db1.query(`SELECT * FROM events WHERE event_id = ?`).get(ref.eventId);
    expect(event.status).toBe("admitted");
    expect(event.plan_failures).toBe(0);
  });

  test("three consecutive lock collisions leave the event admitted, not dead_lettered (OPS-451)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-planner-"));
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

    const event = db1.query(`SELECT * FROM events WHERE event_id = ?`).get(ref.eventId);
    expect(event.status).toBe("admitted");
    expect(event.plan_failures).toBe(0);
  });

  test("TTL re-plan preserves repoPin for repository workspace agent across expiry (OPS-418)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "evrt-plan-factory-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    const repoDir = mkdtempSync(path.join(os.tmpdir(), "evrt-repo-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=develop"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
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
    process.env.FACTORY_EVENT_HOME = mkdtempSync(path.join(os.tmpdir(), "evrt-plan-home-"));

    try {
      const db = openDb(":memory:");
      const ref = admit(db, {
        eventId: "triage-1",
        type: "factory.triage.requested",
        payload: { repo: "bj29", ref: "develop" },
      });
      const outcome = planEvent(db, registry, ref, { now: NOW, policyVersion: "git:test" });
      expect(outcome.decision).toBe("run");
      const originalSpec = JSON.parse(outcome.proposal.spec_json);
      expect(originalSpec.input.repoPin).toBeTruthy();
      expect(originalSpec.input.repoPin.sha).toMatch(/^[0-9a-f]{40}$/);

      // Stored event envelope now carries repoPin
      const storedEvent = db.query(`SELECT envelope_json FROM events WHERE source = ? AND event_id = ?`).get(ref.source, ref.eventId);
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
      process.env.FACTORY_REPOS_ROOT = oldReposRoot;
      process.env.FACTORY_EVENT_HOME = oldHome;
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
        artifacts: [{ kind: "transcript", uri: "file:///tmp/t.json", sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }],
      }),
      new Date(NOW).toISOString(),
    );

    const artifactStore = mkdtempSync(path.join(os.tmpdir(), "evrt-pm-store-"));
    const transcriptSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    writeFileSync(path.join(artifactStore, transcriptSha), "{}");

    const ref = admit(db, {
      eventId: "postmortem-1",
      type: "factory.run-postmortem.requested",
      payload: { runId: priorRunId },
    });
    const outcome = planEvent(db, registry, ref, { now: NOW, policyVersion: "git:test", artifactStore });
    expect(outcome.decision).toBe("run");
    const originalSpec = JSON.parse(outcome.proposal.spec_json);
    expect(originalSpec.input.runPin).toBeTruthy();
    expect(originalSpec.input.runPin.transcript).toBe("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

    const storedEvent = db.query(`SELECT envelope_json FROM events WHERE source = ? AND event_id = ?`).get(ref.source, ref.eventId);
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


