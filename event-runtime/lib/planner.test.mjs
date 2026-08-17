import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashJson } from "./canonical.mjs";
import { DEAD_LETTER_AFTER } from "./config.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { createRun, lifecycleOf, runState, transition } from "./lifecycle.mjs";
import {
  buildRunSpec,
  idempotencyKeyFor,
  planAdmittedEvents,
  planEvent,
  policyMaxConcurrentMerges,
  worktreeDispatchAutoEligibility,
  worktreeMergeFixEligibility,
} from "./planner.mjs";
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

describe("merge concurrency policy", () => {
  test("reads a positive integer max_concurrent_merges and fails safe otherwise", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "evrt-merge-policy-"));
    mkdirSync(path.join(root, "config"));
    const policy = path.join(root, "config", "policy.yaml");

    writeFileSync(policy, "concurrency:\n  max_concurrent_merges: 2\n");
    expect(policyMaxConcurrentMerges(root)).toBe(2);

    for (const invalid of ["0", "1.5", "many"]) {
      writeFileSync(policy, `concurrency:\n  max_concurrent_merges: ${invalid}\n`);
      expect(policyMaxConcurrentMerges(root)).toBe(1);
    }
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
      adapter: "pi",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.status-report/v1",
      capabilities: ["linear:read"],
      // Model-tier routing (WM-135): the committed definition declares
      // standard, policy maps it to models.pi.standard (WM-215 made pi the
      // default harness), and the planner pins the resolution.
      modelTier: "standard",
      model: "openai-codex/gpt-5.6-terra",
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

  test("chain repeat triggers coalesce while active and self-feed again after terminal completion (WM-319)", () => {
    const synthetic = { ...registry, agents: new Map(registry.agents), eventTypes: { ...registry.eventTypes } };
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

    const firstRef = admit(db, chainEvent("chain-dispatch-1", "run_dispatch_1"));
    const first = planEvent(db, synthetic, firstRef, { now: NOW, policyVersion: "git:test" });
    expect(first.decision).toBe("run");

    const concurrentRef = admit(db, chainEvent("chain-dispatch-2", "run_dispatch_2"));
    const concurrent = planEvent(db, synthetic, concurrentRef, { now: NOW + 1000, policyVersion: "git:test" });
    expect(concurrent).toMatchObject({ decision: "noop", reason: "duplicate_run", runId: first.runId });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);

    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }

    const nextCycleRef = admit(db, chainEvent("chain-dispatch-3", "run_dispatch_3"));
    const nextCycle = planEvent(db, synthetic, nextCycleRef, { now: NOW + 2000, policyVersion: "git:test" });
    expect(nextCycle.decision).toBe("run");
    expect(nextCycle.runId).not.toBe(first.runId);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);

    const coalescedAgainRef = admit(db, chainEvent("chain-dispatch-4", "run_dispatch_4"));
    const coalescedAgain = planEvent(db, synthetic, coalescedAgainRef, { now: NOW + 3000, policyVersion: "git:test" });
    expect(coalescedAgain).toMatchObject({ decision: "noop", reason: "duplicate_run", runId: nextCycle.runId });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(2);

    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED"]) {
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
    transition(db, { runId: "run_collision_winner", to: "CANCELLED", actor: "test", now: NOW + 4000 });

    const collisionRef = admit(db, chainEvent(collisionEventId, "run_dispatch_5"));
    const collision = planEvent(db, synthetic, collisionRef, { now: NOW + 5000, policyVersion: "git:test" });
    expect(collision).toMatchObject({
      decision: "noop",
      reason: "idempotency_collision:run_collision_winner",
      runId: "run_collision_winner",
    });
    expect(db.query(`SELECT status FROM events WHERE event_id = ?`).get(collisionEventId).status).toBe("noop");
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

    const first = planEvent(db, synthetic, firstRef, { now: NOW, policyVersion: "git:test" });
    const second = planEvent(db, synthetic, secondRef, { now: NOW + 1000, policyVersion: "git:test" });

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
    expect(planEvent(db, synthetic, otherRepoRef, { now: NOW + 2000, policyVersion: "git:test" }).decision).toBe("run");

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
    const afterFailure = planEvent(db, synthetic, afterFailureRef, { now: NOW + 3000, policyVersion: "git:test" });
    expect(afterFailure.decision).toBe("run");

    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED"]) {
      transition(db, { runId: afterFailure.runId, to, actor: "test" });
    }
    const nextCycleRef = admit(db, {
      eventId: "work-hot-next",
      type: "factory.work.requested",
      source: "operator",
      correlationId: "work-hot-next",
      payload: { repo: "factory" },
    });
    expect(planEvent(db, synthetic, nextCycleRef, { now: NOW + 4000, policyVersion: "git:test" }).decision).toBe("run");
  });

  test("live reservations survive an agent version upgrade (WM-491)", () => {
    const synthetic = { ...registry, agents: new Map(registry.agents), eventTypes: { ...registry.eventTypes } };
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
    const first = planEvent(db, synthetic, firstRef, { now: NOW, policyVersion: "git:test" });

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
    expect(planEvent(db, synthetic, nextRef, { now: NOW + 1000, policyVersion: "git:test" })).toMatchObject({
      decision: "noop",
      reason: "work_scan_already_in_flight",
      runId: first.runId,
    });
  });

  test("a duplicate dispatch for a ticket with a live dispatch is refused at plan time (WM-491)", () => {
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

    const first = planEvent(db, synthetic, firstRef, { now: NOW, policyVersion: "git:test" });
    const second = planEvent(db, synthetic, secondRef, { now: NOW + 1000, policyVersion: "git:test" });

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
    const malformed = planEvent(db, synthetic, malformedRef, { now: NOW + 2000, policyVersion: "git:test" });
    expect(malformed.decision).toBe("human_needed");
    expect(malformed.reason).toMatch(/^invalid_input: /);

    for (const to of ["APPROVED", "QUEUED", "LEASED", "RUNNING", "FAILED"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }
    const failedRetryRef = admit(db, dispatch("dispatch-while-retryable"));
    expect(planEvent(db, synthetic, failedRetryRef, { now: NOW + 3000, policyVersion: "git:test" })).toMatchObject({
      decision: "noop",
      reason: `ticket_dispatch_already_live:${first.runId}:same_ticket_worktree_held`,
    });

    for (const to of ["QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED"]) {
      transition(db, { runId: first.runId, to, actor: "test" });
    }
    const nextRef = admit(db, dispatch("dispatch-next-cycle"));
    expect(planEvent(db, synthetic, nextRef, { now: NOW + 4000, policyVersion: "git:test" }).decision).toBe("run");
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

describe("planEvent worktree gate (WM-108)", () => {
  // A synthetic worktree-workspace agent: the real dispatch@1 lands with its
  // own tests; this proves the gate itself, independent of any one agent.
  function syntheticRegistry() {
    const synthetic = { ...registry, agents: new Map(registry.agents), eventTypes: { ...registry.eventTypes } };
    synthetic.eventTypes["test.worktree.requested"] = {
      agent: "test-worktree@1",
      adapter: "claude",
      idempotencyScope: ["inputHash"],
    };
    synthetic.agents.set("test-worktree@1", {
      id: "test-worktree",
      version: 1,
      ref: "test-worktree@1",
      output_contract: "factory.test/v1",
      workspace: { type: "worktree" },
      capabilities: { services: [] },
      limits: { timeout_seconds: 60, attempts: 1 },
      mutating: true,
      inputSchema: { type: "object", required: ["repo", "ticket"], properties: { repo: { type: "string" }, ticket: { type: "string" } } },
    });
    return synthetic;
  }

  function withReposRoot(yaml, fn) {
    const root = mkdtempSync(path.join(os.tmpdir(), "evrt-plan-wt-"));
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

  const dispatchEnvelope = (payload) => ({
    type: "test.worktree.requested",
    eventId: `wt-${JSON.stringify(payload)}`,
    correlationId: null,
    payload,
  });

  test("a gate-declared merge-fix agent bypasses dispatch-only planning checks", () => {
    withReposRoot(`repos:\n  - name: repairable\n    path: /tmp/nowhere\n    base: develop\n`, () => {
      const synthetic = syntheticRegistry();
      synthetic.agents.set("test-worktree@1", {
        ...synthetic.agents.get("test-worktree@1"),
        gate: "merge-fix",
      });
      const db = openDb(":memory:");
      const ref = admit(db, dispatchEnvelope({ repo: "repairable", ticket: "WM-500" }));
      const outcome = planEvent(db, synthetic, ref, {
        now: NOW,
        dispatch: { fetchTicket: () => { throw new Error("dispatch gate must not run"); } },
      });
      expect(outcome.decision).toBe("run");
    });
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

    expect(worktreeMergeFixEligibility(payload, {
      fetchTicket: () => ({ ...ticket, labels: { nodes: [{ name: "ai:escalated" }] } }),
      fetchPullRequest: () => ({ state: "OPEN", headRefOid: payload.headSha }),
      now: NOW,
    }).refusal.reason).toBe("merge_fix_ticket_escalated");
    expect(worktreeMergeFixEligibility(payload, {
      fetchTicket: () => ticket,
      fetchPullRequest: () => ({ state: "OPEN", headRefOid: "b".repeat(40) }),
      now: NOW,
    }).refusal.reason).toBe("merge_fix_pr_moved");
    expect(worktreeMergeFixEligibility(payload, {
      fetchTicket: () => ticket,
      fetchPullRequest: () => ({ state: "OPEN", headRefOid: payload.headSha }),
      fetchNonTerminalRuns: () => [{ runId: "run_other", state: "RUNNING" }],
      now: NOW,
    }).refusal.reason).toBe("merge_fix_run_active");
    expect(worktreeMergeFixEligibility({ ...payload, ownedPaths: ["outside/scope.mjs"] }, {
      fetchTicket: () => ticket,
      fetchPullRequest: () => ({ state: "OPEN", headRefOid: payload.headSha }),
      now: NOW,
    }).refusal.reason).toBe("merge_fix_owned_paths_moved");
  });

  test("a repo with no worktree scripts declared → typed human_needed at plan time, no run", () => {
    withReposRoot(`repos:\n  - name: noscripts\n    path: /tmp/nowhere\n    base: develop\n`, () => {
      const synthetic = syntheticRegistry();
      const db = openDb(":memory:");
      const ref = admit(db, dispatchEnvelope({ repo: "noscripts", ticket: "WM-1" }));
      const outcome = planEvent(db, synthetic, ref, { now: NOW });
      expect(outcome.decision).toBe("human_needed");
      expect(outcome.reason).toBe("no_worktree_scripts");
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    });
  });

  test("a repo missing from config/repos.yaml → human_needed repo_unknown", () => {
    withReposRoot(`repos:\n  - name: real\n    path: /tmp/nowhere\n    base: develop\n`, () => {
      const synthetic = syntheticRegistry();
      const db = openDb(":memory:");
      const ref = admit(db, dispatchEnvelope({ repo: "ghost", ticket: "WM-1" }));
      const outcome = planEvent(db, synthetic, ref, { now: NOW });
      expect(outcome.decision).toBe("human_needed");
      expect(outcome.reason).toMatch(/^repo_unknown: /);
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    });
  });

  test("unknown Owned Paths refuses distinctly before wildcard escalation", () => {
    withReposRoot(
      `repos:\n  - name: gated\n    path: /tmp/nowhere\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    worktree_up: bin/up\n    worktree_down: bin/down\n` +
      `    worktree_root: /tmp/worktrees\n    escalate_paths:\n      - '**'\n`,
      () => {
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
              description: "",
            }),
            fetchInFlight: () => { fetchedInFlight = true; return []; },
          },
        );
        expect(result.refusal).toMatchObject({ decision: "noop", reason: "owned_paths_unknown" });
        expect(result.evidence.ticket).toMatchObject({ ownedPaths: ["**"], ownedPathsParsed: false });
        expect(result.evidence.escalatePathIntersections).toEqual([]);
        expect(fetchedInFlight).toBe(false);
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
          labels: { nodes: [{ name: "ai:in-progress" }, { name: "agent:claude-code" }] },
          description: "## Owned Paths\n- event-runtime/lib/worker.mjs\n",
        });
        const baseDispatch = {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchViewer: () => ({ id: "factory-user", name: "Factory" }),
          fetchInFlight: () => [],
          claimedRetry: { runId: "run_same", priorAttempt: 1, reasonCode: "lease_expired" },
        };

        const resumed = worktreeDispatchAutoEligibility(
          { repo: "gated", ticket: "WM-621" },
          { ...baseDispatch, fetchTicket: () => claimedTicket({ id: "factory-user" }) },
        );
        expect(resumed.ok).toBe(true);
        expect(resumed.evidence.checks).toMatchObject({
          ticket_claim_retry: true,
          ticket_in_progress_retry: true,
          ticket_in_progress_label_retry: true,
        });

        const foreign = worktreeDispatchAutoEligibility(
          { repo: "gated", ticket: "WM-621" },
          { ...baseDispatch, fetchTicket: () => claimedTicket({ id: "someone-else" }) },
        );
        expect(foreign.refusal).toMatchObject({ decision: "noop", reason: "ticket_assigned" });

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
        expect(ownAssignedTodo.refusal).toMatchObject({ decision: "noop", reason: "ticket_assigned" });
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
        expect(result.evidence.escalatePathIntersections).toEqual(["src/auth/**"]);

        const db = openDb(":memory:");
        const ref = admit(db, dispatchEnvelope({ repo: "gated", ticket: "WM-3" }));
        const outcome = planEvent(db, syntheticRegistry(), ref, { now: NOW, dispatch });
        expect(outcome).toMatchObject({ decision: "noop", reason: "escalate_paths_intersect" });
        expect(outcome.proposal.reason).toBe("intersecting escalate_paths globs: src/auth/**");
      },
    );
  });
});

describe("planEvent repo scoping (WM-64)", () => {
  // A synthetic agent per test keeps the check independent of any one real
  // definition (same approach as the worktree gate tests above).
  function scopedRegistry({ repos, workspace = { type: "ephemeral" } } = {}) {
    const synthetic = { ...registry, agents: new Map(registry.agents), eventTypes: { ...registry.eventTypes } };
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
    const outcome = planEvent(db, synthetic, ref, { now: NOW, policyVersion: "git:test" });
    expect(outcome.decision).toBe("run");
    // The proposal the operator approves names the scope (WM-64).
    expect(JSON.parse(outcome.proposal.spec_json).repos).toEqual(["bj29", "cw-app"]);
  });

  test("payload.repo outside the declared set parks human_needed with the named reason, no run", () => {
    const synthetic = scopedRegistry({ repos: ["bj29", "cw-app"] });
    const db = openDb(":memory:");
    const ref = admit(db, scopedEnvelope({ repo: "coach-wattz", ticket: "WM-1" }));
    const outcome = planEvent(db, synthetic, ref, { now: NOW, policyVersion: "git:test" });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toBe("repo_not_allowed: test-scoped@1 may not run over coach-wattz (allowed: bj29, cw-app)");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
    const event = db.query(`SELECT status FROM events WHERE event_id = ?`).get(ref.eventId);
    expect(event.status).toBe("human_needed");
  });

  test("a definition without repos is unrestricted — behaves exactly as today (regression)", () => {
    const synthetic = scopedRegistry();
    const db = openDb(":memory:");
    const ref = admit(db, scopedEnvelope({ repo: "anything-at-all", ticket: "WM-1" }));
    const outcome = planEvent(db, synthetic, ref, { now: NOW, policyVersion: "git:test" });
    expect(outcome.decision).toBe("run");
    expect(JSON.parse(outcome.proposal.spec_json).repos).toBeUndefined();
  });

  test("scope refusal precedes the repo pin: repository workspace parks repo_not_allowed, never touches the mirror", () => {
    // No FACTORY_REPOS_ROOT setup at all — if the planner reached pinRepo it
    // would fail as repo_pin_failed; the scope check must win first, so no
    // mirror fetch happens for a refused run.
    const synthetic = scopedRegistry({ repos: ["bj29"], workspace: { type: "repository" } });
    const db = openDb(":memory:");
    const ref = admit(db, scopedEnvelope({ repo: "coach-wattz", ticket: "WM-1" }));
    const outcome = planEvent(db, synthetic, ref, { now: NOW, policyVersion: "git:test" });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toMatch(/^repo_not_allowed: /);
    const stored = db.query(`SELECT envelope_json FROM events WHERE event_id = ?`).get(ref.eventId);
    expect(JSON.parse(stored.envelope_json).payload.repoPin).toBeUndefined();
  });

  test("scope refusal precedes the worktree dispatch gate: no Linear or lease reads for an out-of-scope repo", () => {
    const synthetic = scopedRegistry({ repos: ["bj29"], workspace: { type: "worktree" } });
    const db = openDb(":memory:");
    const ref = admit(db, scopedEnvelope({ repo: "coach-wattz", ticket: "WM-1" }));
    const dispatch = {
      fetchTicket: () => {
        throw new Error("gate consulted Linear for an out-of-scope repo");
      },
      fetchInFlight: () => {
        throw new Error("gate consulted Linear for an out-of-scope repo");
      },
    };
    const outcome = planEvent(db, synthetic, ref, { now: NOW, policyVersion: "git:test", dispatch });
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toMatch(/^repo_not_allowed: /);
  });
});

describe("planEvent model pinning (WM-135)", () => {
  // Synthetic agents again: the resolution semantics belong to the planner,
  // not to any one shipped definition.
  function tieredRegistry({ modelTier, model, adapter = "claude", modelTiers } = {}) {
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
      modelTiers: modelTiers ?? { claude: { strong: "default", standard: "sonnet", light: "haiku" } },
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
    const outcome = planEvent(db, tieredRegistry({ modelTier: "standard" }), ref, { now: NOW, policyVersion: "git:test" });
    expect(outcome.decision).toBe("run");
    const spec = JSON.parse(outcome.proposal.spec_json);
    expect(spec.model).toBe("sonnet");
    expect(spec.modelTier).toBe("standard");
  });

  test("tier resolving to the default sentinel pins \"default\" explicitly — visible, not implicit", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(db, tieredRegistry({ modelTier: "strong" }), ref, { now: NOW, policyVersion: "git:test" });
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

  test("a definition declaring nothing produces a spec without model fields — today's behavior (regression)", () => {
    const db = openDb(":memory:");
    const ref = admit(db, tieredEnvelope());
    const outcome = planEvent(db, tieredRegistry(), ref, { now: NOW, policyVersion: "git:test" });
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
      planEvent(db, tieredRegistry({ modelTier: "light", modelTiers: {} }), ref, { now: NOW, policyVersion: "git:test" }),
    ).toThrow(/no mapping for adapter "claude"/);
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
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


