import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-chain-test-mjs";
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { memoryForge } from "../../lib/forge/memory.mjs";
import * as fake from "./adapters/fake.mjs";
import { CHAIN_AUTO_APPROVAL_ACTOR } from "./auto-approval.mjs";
import { FACTORY_ROOT } from "./config.mjs";
import {
  admitChainEvent,
  buildChainInput,
  chainResolution,
  resolveChains,
} from "./chain.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { createRun, transition } from "./lifecycle.mjs";
import { enumerateMergeScan } from "./merge-reviews.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { approveProposal, openProposals } from "./proposals.mjs";
import { loadRegistry, RegistryError } from "./registry.mjs";
import { runOnce } from "./worker.mjs";
import { tick } from "../cli/serve.mjs";
import { loadAdjustedTimeout } from "./test-helpers-timing.mjs";
// Importing test-helpers pins FACTORY_EVENT_HOME/FACTORY_HOME to an isolated
// temp home for this whole file, so default-home lookups (artifactsRoot(),
// dbPath()) never reach the operator's real ~/.factory (OPS-425).
import { realFactorySnapshot } from "../test-helpers.mjs";

const registry = loadRegistry();
const PV = "git:test-pv";

function failedRunEnvelope(overrides = {}) {
  const id =
    overrides.eventId ?? `gh-${Math.random().toString(36).slice(2, 10)}`;
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type: "github.workflow-run.failed",
    source: "github",
    subject: "ci",
    occurredAt: "2026-08-12T10:00:00Z",
    correlationId: id,
    causationId: null,
    payload: { repo: "wm/factory", runId: 12345 },
    ...overrides,
  };
}

/**
 * The chain auto-approval allowlist is read from `<reposRoot>/config/policy.yaml`
 * at plan time (falling back to `config/policy.example.yaml` when the instance
 * file is absent). Tests must not depend on whichever policy the checkout
 * happens to carry, so each harness pins FACTORY_REPOS_ROOT to a temp root
 * whose policy is the shipped example with an explicit allowlist (GH-1727).
 */
const CI_DIAGNOSE = "factory.ci-diagnose.requested";
const envRestores = [];

function chainPolicyRoot(allowed) {
  const root = tmpDir("evrt-chain-policy-");
  mkdirSync(path.join(root, "config"));
  const policy = Bun.YAML.parse(
    readFileSync(
      path.join(FACTORY_ROOT, "config", "policy.example.yaml"),
      "utf8",
    ),
  );
  policy.chain_auto_approval = { allowed_event_types: allowed };
  // The day-budget guard scans the operator's real ~/.factory/logs; no
  // budget means no scan, keeping the harness hermetic.
  delete policy.budget;
  // YAML is a JSON superset, so the parsed object round-trips as-is.
  writeFileSync(
    path.join(root, "config", "policy.yaml"),
    JSON.stringify(policy, null, 2),
  );
  const previous = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  envRestores.push(() => {
    if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previous;
  });
  return root;
}

afterEach(() => {
  while (envRestores.length) envRestores.pop()();
});

function harness({ allowed = [CI_DIAGNOSE] } = {}) {
  chainPolicyRoot(allowed);
  const dir = tmpDir("evrt-chain-");
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = tmpDir("evrt-chain-ws-");
  // Chain flow under test never spawns real processes: pi AND command
  // both back onto the contract-shaped fake.
  const adapters = { pi: fake, command: fake };
  const workerOpts = {
    workspacesRoot: workspaces,
    owner: "w-test",
    policyVersion: PV,
  };

  async function runToCompletion(eventId) {
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find(
      (p) =>
        p.decision === "run" &&
        (p.event_id === eventId || p.spec?.idempotencyKey),
    );
    expect(proposal).toBeTruthy();
    const approved = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      policyVersion: PV,
    });
    expect(approved.approved).toBe(true);
    const summary = await runOnce(db, registry, adapters, workerOpts);
    expect(summary.terminalState).toBe("COMPLETED");
    return { proposal, runId: approved.runId };
  }

  return { db, adapters, workerOpts, runToCompletion };
}

describe("trusted chain admission", () => {
  test("assigns immutable chain provenance instead of preserving caller source", () => {
    const db = openDb(":memory:");
    const outcome = admitChainEvent(db, registry, {
      ...failedRunEnvelope({ eventId: "internal-chain-proof" }),
      source: "operator",
    });

    expect(outcome.admitted).toBe(true);
    expect(outcome.event.source).toBe("chain");
    expect(JSON.parse(outcome.event.envelope_json).source).toBe("chain");
  });
});

describe("buildChainInput", () => {
  const context = {
    input: { repo: "wm/x", runId: 7 },
    artifact: { verdict: "FLAKE", nested: { a: 1 } },
  };

  test("resolves $.input.* and $.artifact.* paths and passes literals through", () => {
    expect(
      buildChainInput(
        {
          repo: "$.input.repo",
          v: "$.artifact.verdict",
          deep: "$.artifact.nested.a",
          lit: "x",
        },
        context,
      ),
    ).toEqual({ repo: "wm/x", v: "FLAKE", deep: 1, lit: "x" });
  });

  test("resolves $.item.* and $.item in multi-emit item context (WM-119)", () => {
    const itemContext = {
      ...context,
      item: { ticket: "WM-119", count: 42, meta: { tag: "alpha" } },
    };
    expect(
      buildChainInput(
        {
          repo: "$.input.repo",
          ticket: "$.item.ticket",
          tag: "$.item.meta.tag",
          fullItem: "$.item",
          selected: ["$.item.count"],
          literal: "fixed",
        },
        itemContext,
      ),
    ).toEqual({
      repo: "wm/x",
      ticket: "WM-119",
      tag: "alpha",
      fullItem: { ticket: "WM-119", count: 42, meta: { tag: "alpha" } },
      selected: [42],
      literal: "fixed",
    });
  });

  test("missing path fails loudly", () => {
    expect(() =>
      buildChainInput({ nope: "$.artifact.absent" }, context),
    ).toThrow("resolves to nothing");
  });
});

/** Every proposal (any status) whose spec targets `agent`, oldest first. */
function proposalsForAgent(db, agent) {
  return db
    .query(`SELECT * FROM proposals ORDER BY created_at, rowid`)
    .all()
    .map((row) => ({
      ...row,
      spec: row.spec_json && JSON.parse(row.spec_json),
    }))
    .filter((p) => p.spec?.agent === agent);
}

/**
 * github.workflow-run.failed now lands on ci-log-capture@1, which stores the
 * log as an artifact and chains to ci-doctor@2 (OPS-372). Run that first hop
 * so these tests stay about the *verdict* edges they were written for.
 *
 * With `factory.ci-diagnose.requested` allowlisted (the harness default) the
 * planner's chain pass approves the diagnosis unattended: no operator click,
 * the run is already QUEUED when planning returns (GH-1727).
 */
async function throughCapture(h, eventId) {
  const capture = await h.runToCompletion(eventId);
  expect(resolveChains(h.db, registry).emitted).toBe(1);
  planAdmittedEvents(h.db, registry, { policyVersion: PV });
  expect(
    openProposals(h.db, {}).find((p) => p.spec?.agent === "ci-doctor@2"),
  ).toBeUndefined();
  const [diagnose, ...extra] = proposalsForAgent(h.db, "ci-doctor@2");
  expect(extra).toEqual([]);
  expect(diagnose.status).toBe("approved");
  expect(diagnose.decided_by).toBe(CHAIN_AUTO_APPROVAL_ACTOR);
  const run = h.db
    .query(`SELECT state FROM runs WHERE run_id = ?`)
    .get(diagnose.run_id);
  expect(["APPROVED", "QUEUED"]).toContain(run.state);
  const summary = await runOnce(h.db, registry, h.adapters, h.workerOpts);
  expect(summary.terminalState).toBe("COMPLETED");
  return {
    capture,
    diagnoseRunId: diagnose.run_id,
    diagnoseProposal: diagnose,
  };
}

describe("discovered chain: ci-doctor → follow-up (OPS-223)", () => {
  test("ci-doctor stays a watched proposal when the allowlist omits factory.ci-diagnose.requested", async () => {
    const h = harness({ allowed: ["factory.work.requested"] });
    const { db, adapters, workerOpts, runToCompletion } = h;
    expect(
      admitEvent(db, registry, failedRunEnvelope({ eventId: "gh-watched-1" }))
        .admitted,
    ).toBe(true);
    await runToCompletion("gh-watched-1");
    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });

    const diagnose = openProposals(db, {}).find(
      (p) => p.spec?.agent === "ci-doctor@2",
    );
    expect(diagnose).toBeTruthy();
    expect(diagnose.status).toBe("open");
    expect(diagnose.reason).toBe(
      "auto_approval_ineligible:run_approval_policy_watched",
    );
    expect(diagnose.spec.approvalPolicy).toEqual({
      source: "chain",
      mode: "watched",
      eventType: CI_DIAGNOSE,
      reason: "event_type_not_allowlisted",
    });
    expect(
      db.query(`SELECT state FROM runs WHERE run_id = ?`).get(diagnose.run_id)
        .state,
    ).toBe("PROPOSED");

    // The human click still works exactly as before.
    const approved = approveProposal(db, registry, diagnose.id, {
      actor: "operator",
      policyVersion: PV,
    });
    expect(approved.approved).toBe(true);
    const summary = await runOnce(db, registry, adapters, workerOpts);
    expect(summary.terminalState).toBe("COMPLETED");
  });

  test("FLAKE verdict chains to a watched ci-rerun proposal with inherited correlation", async () => {
    const h = harness();
    const { db, runToCompletion } = h;
    const envelope = failedRunEnvelope({ eventId: "gh-flake-1" });
    expect(admitEvent(db, registry, envelope).admitted).toBe(true);
    const { diagnoseRunId: runId } = await throughCapture(h, "gh-flake-1");

    const outcome = resolveChains(db, registry);
    expect(outcome).toEqual({ emitted: 1, skipped: 0, errors: [] });

    // The chain event went through the same intake, with provenance.
    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${runId}`);
    expect(chainEvent.type).toBe("factory.ci-rerun.requested");
    expect(chainEvent.correlation_id).toBe("gh-flake-1");
    expect(chainEvent.causation_id).toBe(runId);

    // The planner proposes the follow-up — open and watched, not auto-run.
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const followUp = openProposals(db, {}).find(
      (p) => p.spec?.agent === "ci-rerun@1",
    );
    expect(followUp).toBeTruthy();
    expect(followUp.status).toBe("open");
    expect(followUp.spec.adapter).toBe("command");
    expect(followUp.spec.input).toEqual({ repo: "wm/factory", runId: 12345 });

    // Re-resolving chains emits nothing new: the already-chained run is
    // excluded up front (NOT EXISTS on its chain event) — one event per run, ever.
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("TICKET verdict chains to ci-notify with the diagnosis summary mapped in", async () => {
    const h = harness();
    const { db, runToCompletion } = h;
    admitEvent(
      db,
      registry,
      failedRunEnvelope({
        eventId: "gh-ticket-1",
        payload: { repo: "wm/factory-ticket", runId: 777 },
      }),
    );
    await throughCapture(h, "gh-ticket-1");

    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const followUp = openProposals(db, {}).find(
      (p) => p.spec?.agent === "ci-notify@1",
    );
    expect(followUp).toBeTruthy();
    expect(followUp.spec.input.summary).toContain("wm/factory-ticket");
  });

  test("full chain executes after approval: rerun completes under the command contract", async () => {
    const h = harness();
    const { db, adapters, workerOpts } = h;
    admitEvent(
      db,
      registry,
      failedRunEnvelope({
        eventId: "gh-flake-2",
        payload: { repo: "wm/f2", runId: 2 },
      }),
    );
    await throughCapture(h, "gh-flake-2");
    resolveChains(db, registry);
    planAdmittedEvents(db, registry, { policyVersion: PV });

    const followUp = openProposals(db, {}).find(
      (p) => p.spec?.agent === "ci-rerun@1",
    );
    const approved = approveProposal(db, registry, followUp.id, {
      actor: "operator",
      policyVersion: PV,
    });
    expect(approved.approved).toBe(true);
    const summary = await runOnce(db, registry, adapters, workerOpts);
    expect(summary.terminalState).toBe("COMPLETED");

    // The command result has no registered edges — the chain terminates.
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("duplicate failed-run delivery converges: one doctor run, one chain event", async () => {
    const h = harness();
    const { db, runToCompletion } = h;
    admitEvent(
      db,
      registry,
      failedRunEnvelope({
        eventId: "gh-dup-1",
        payload: { repo: "wm/d", runId: 9 },
      }),
    );
    const dup = admitEvent(
      db,
      registry,
      failedRunEnvelope({
        eventId: "gh-dup-1",
        payload: { repo: "wm/d", runId: 9 },
      }),
    );
    expect(dup.duplicate).toBe(true);
    await runToCompletion("gh-dup-1");
    expect(resolveChains(db, registry).emitted).toBe(1); // capture → diagnose
    expect(resolveChains(db, registry).emitted).toBe(0); // one chain event per run, ever
  });
});

describe("registry gates (OPS-223)", () => {
  test("command definitions with mutating: true are admitted; the loaded registry proves it", () => {
    expect(registry.agents.get("ci-rerun@1").mutating).toBe(true);
    expect(registry.agents.get("ci-rerun@1").command[0]).toBe("gh");
  });

  test("edges validation fails closed: unregistered targets and stray input roots", () => {
    const root = tmpDir("evrt-reg-");
    cpSync(path.join(registry.root, "agents"), path.join(root, "agents"), {
      recursive: true,
    });
    cpSync(path.join(registry.root, "schemas"), path.join(root, "schemas"), {
      recursive: true,
    });
    cpSync(
      path.join(registry.root, "event-types.json"),
      path.join(root, "event-types.json"),
    );

    writeFileSync(
      path.join(root, "edges.json"),
      JSON.stringify({
        "ci-doctor@2": {
          recommendationField: "verdict",
          edges: { FLAKE: { eventType: "not.registered", input: {} } },
        },
      }),
    );
    expect(() => loadRegistry({ root })).toThrow(RegistryError);

    writeFileSync(
      path.join(root, "edges.json"),
      JSON.stringify({
        "ci-doctor@2": {
          recommendationField: "verdict",
          edges: {
            FLAKE: {
              eventType: "factory.ci-rerun.requested",
              input: { x: "$.secrets.key" },
            },
          },
        },
      }),
    );
    expect(() => loadRegistry({ root })).toThrow(
      "only $.input.*, $.artifact.* and $.artifactHash.*",
    );

    const independentRule = (edge) => ({
      "ci-doctor@2": {
        recommendationField: "verdict",
        independent: true,
        edges: { FLAKE: edge },
      },
    });
    writeFileSync(
      path.join(root, "edges.json"),
      JSON.stringify(
        independentRule({ eventType: "factory.ci-rerun.requested", input: {} }),
      ),
    );
    expect(() => loadRegistry({ root })).toThrow(
      "independent edge has no whenItemsField",
    );

    writeFileSync(
      path.join(root, "edges.json"),
      JSON.stringify(
        independentRule({
          eventType: "factory.ci-rerun.requested",
          whenItemsField: "signals",
          input: {},
        }),
      ),
    );
    expect(() => loadRegistry({ root })).toThrow(
      "independent edge needs a mixedEventId containing ${runId}",
    );

    writeFileSync(
      path.join(root, "edges.json"),
      JSON.stringify(
        independentRule({
          eventType: "factory.ci-rerun.requested",
          whenItemsField: "signals",
          mixedEventId: "chain-${runId}-flake",
          input: {},
        }),
      ),
    );
    expect(() => loadRegistry({ root })).not.toThrow();
  });
});

describe("multi-emit chain resolution (WM-119)", () => {
  function seedCompletedRun(
    db,
    {
      runId,
      agent,
      input,
      artifact,
      eventId = `evt-${runId}`,
      correlationId = `corr-${runId}`,
    },
  ) {
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES ('operator', ?, 'test.event', 'test', ?, ?, ?, NULL, ?, 'hash', 'admitted', ?)`,
    ).run(
      eventId,
      now,
      now,
      correlationId,
      JSON.stringify({ payload: input }),
      now,
    );

    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, spec_json, status, created_at, ttl_seconds)
       VALUES (?, 'operator', ?, ?, 'run', ?, 'approved', ?, 1800)`,
    ).run(
      `prop-${runId}`,
      eventId,
      runId,
      JSON.stringify({ agent, input }),
      now,
    );

    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 1, ?, ?)`,
    ).run(runId, `idem-${runId}`, JSON.stringify({ agent, input }), now, now);

    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'art-hash', '{}', '{}', ?)`,
    ).run(runId, JSON.stringify({ artifact }), now);
  }

  function seedChainChild(db, runId, eventId) {
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES ('chain', ?, 'factory.work.requested', 'perf-edge@1', ?, ?, ?, ?, '{}', 'hash', 'admitted', ?)`,
    ).run(eventId, now, now, `corr-${runId}`, runId, now);
  }

  test("fans out N planned items into N admitted chain events with chain-<runId>-<itemKey> IDs", () => {
    const dir = tmpDir("evrt-chain-multi-");
    const db = openDb(path.join(dir, "runtime.db"));

    seedCompletedRun(db, {
      runId: "run-fanout-1",
      agent: "work-scan@1",
      input: { repo: "wm/multi" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/multi",
        plan: [
          { ticket: "WM-101", ownedPaths: ["a/**"], reason: "p1" },
          { ticket: "WM-102", ownedPaths: ["b/**"], reason: "p2" },
          { ticket: "WM-103", ownedPaths: ["c/**"], reason: "p3" },
        ],
      },
      correlationId: "scan-corr-1",
    });

    const outcome = resolveChains(db, registry);
    expect(outcome).toEqual({ emitted: 3, skipped: 0, errors: [] });

    for (const ticket of ["WM-101", "WM-102", "WM-103"]) {
      const event = db
        .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
        .get(`chain-run-fanout-1-${ticket}`);
      expect(event).toBeTruthy();
      expect(event.type).toBe("factory.dispatch.requested");
      expect(event.correlation_id).toBe("scan-corr-1");
      expect(event.causation_id).toBe("run-fanout-1");
      const envelope = JSON.parse(event.envelope_json);
      expect(envelope.payload).toEqual({ repo: "wm/multi", ticket });
    }

    // Idempotent: re-resolving chains emits 0
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("partially emitted fan-out resumes missing siblings before marking the run resolved", () => {
    const db = openDb(":memory:");
    seedCompletedRun(db, {
      runId: "run-partial-fanout",
      agent: "work-scan@1",
      input: { repo: "wm/partial" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/partial",
        plan: [
          { ticket: "WM-301" },
          { ticket: "WM-302" },
          { ticket: "WM-303" },
        ],
      },
    });
    seedChainChild(db, "run-partial-fanout", "chain-run-partial-fanout-WM-301");

    expect(resolveChains(db, registry)).toEqual({
      emitted: 2,
      skipped: 0,
      errors: [],
    });
    expect(
      db
        .query(
          `SELECT chain_resolved_at FROM runs WHERE run_id = 'run-partial-fanout'`,
        )
        .get().chain_resolved_at,
    ).not.toBeNull();
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("production-shaped resolved history keeps a no-planning tick and health responsive", async () => {
    const realHomeBefore = realFactorySnapshot();
    expect(process.env.FACTORY_EVENT_HOME).toBeDefined();
    const db = openDb(":memory:");
    const perfRegistry = {
      ...registry,
      edges: {
        "perf-edge@1": {
          recommendationField: "recommendation",
          edges: {
            NEXT: {
              eventType: "factory.work.requested",
              input: { repo: "$.input.repo" },
            },
          },
        },
      },
    };

    // Production had ~1,300 completed edge runs and ~6,000 chain events. Use
    // 2,000/6,000 so this guards both that shape and future history growth.
    db.transaction(() => {
      for (let i = 0; i < 2_000; i += 1) {
        const runId = `run-perf-${i}`;
        seedCompletedRun(db, {
          runId,
          agent: "perf-edge@1",
          input: { repo: "factory" },
          artifact: { recommendation: "NEXT" },
        });
        seedChainChild(db, runId, `chain-${runId}`);
        seedChainChild(db, runId, `chain-${runId}-legacy-a`);
        seedChainChild(db, runId, `chain-${runId}-legacy-b`);
      }
    })();

    let childEventLookups = 0;
    const instrumented = new Proxy(db, {
      get(target, property) {
        if (property === "query") {
          return (sql) => {
            if (/JOIN events child\s+ON child\.causation_id/s.test(sql)) {
              childEventLookups += 1;
            }
            return target.query(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const noPlanning = Object.fromEntries(
      [
        "tick emit",
        "plan",
        "auto-approve",
        "auto-approve-chains",
        "announce",
        "inbox",
        "notify",
        "reap",
        "announce-after",
        "outbox",
        "GC",
      ].map((name) => [name, () => {}]),
    );
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true });
      },
    });

    try {
      const healthRequests = Array.from({ length: 20 }, async () => {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${server.port}/health`);
        expect(response.status).toBe(200);
        return performance.now() - started;
      });
      const tickStarted = performance.now();
      await tick({
        db: instrumented,
        registry: perfRegistry,
        policyVersion: PV,
        subsystems: noPlanning,
        log: () => {},
      });
      const tickMs = performance.now() - tickStarted;
      const healthMs = (await Promise.all(healthRequests)).sort(
        (a, b) => a - b,
      );
      const healthP95 = healthMs[Math.ceil(healthMs.length * 0.95) - 1];

      console.info(
        `chain benchmark: tick=${tickMs.toFixed(1)}ms health_p95=${healthP95.toFixed(1)}ms child_event_lookups=${childEventLookups}`,
      );
      expect(childEventLookups).toBe(1); // one bulk lookup, never 2,000
      expect(tickMs).toBeLessThan(loadAdjustedTimeout(200));
      // /health p95 is measured against the stub Bun.serve above: it proves the tick does not block the event loop, not real API latency.
      expect(healthP95).toBeLessThan(loadAdjustedTimeout(500));
      // The production-shaped benchmark must never touch the operator's real
      // ~/.factory/event-runtime/runtime.db (no default-home openDb/migration).
      expect(realFactorySnapshot().dbMtime).toBe(realHomeBefore.dbMtime);

      childEventLookups = 0;
      expect(resolveChains(instrumented, perfRegistry)).toEqual({
        emitted: 0,
        skipped: 0,
        errors: [],
      });
      expect(childEventLookups).toBe(0); // resolved history is not re-examined
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("empty plan skips cleanly without error", () => {
    const dir = tmpDir("evrt-chain-empty-");
    const db = openDb(path.join(dir, "runtime.db"));

    seedCompletedRun(db, {
      runId: "run-empty-1",
      agent: "work-scan@1",
      input: { repo: "wm/empty" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/empty",
        plan: [],
      },
    });

    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 1,
      errors: [],
    });
  });

  test("custom eventId templating and perItem mapping overlays", () => {
    const dir = tmpDir("evrt-chain-tmpl-");
    const db = openDb(path.join(dir, "runtime.db"));

    const customRegistry = {
      ...registry,
      edges: {
        "work-scan@1": {
          recommendationField: "recommendation",
          edges: {
            DISPATCH: {
              eventType: "factory.dispatch.requested",
              itemsField: "plan",
              itemKey: "ticket",
              eventId: "chain-${runId}-${item.ticket}",
              input: { repo: "$.artifact.repo" },
              perItem: { ticket: "$.item.ticket" },
            },
          },
        },
      },
    };

    seedCompletedRun(db, {
      runId: "run-tmpl-1",
      agent: "work-scan@1",
      input: { repo: "wm/tmpl" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/tmpl",
        plan: [{ ticket: "WM-201" }],
      },
    });

    const outcome = resolveChains(db, customRegistry);
    expect(outcome).toEqual({ emitted: 1, skipped: 0, errors: [] });
    const event = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get("chain-run-tmpl-1-WM-201");
    expect(event).toBeTruthy();
    expect(JSON.parse(event.envelope_json).payload).toEqual({
      repo: "wm/tmpl",
      ticket: "WM-201",
    });
  });

  test("missing itemKey records error cleanly", () => {
    const dir = tmpDir("evrt-chain-err-");
    const db = openDb(path.join(dir, "runtime.db"));

    seedCompletedRun(db, {
      runId: "run-err-1",
      agent: "work-scan@1",
      input: { repo: "wm/err" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/err",
        plan: [{ missingTicket: "bad" }],
      },
    });

    const outcome = resolveChains(db, registry);
    expect(outcome.emitted).toBe(0);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain('missing key "ticket"');
    expect(
      db
        .query(`SELECT chain_resolved_at FROM runs WHERE run_id = 'run-err-1'`)
        .get().chain_resolved_at,
    ).not.toBeNull();
    expect(chainResolution(db, "run-err-1")).toMatchObject({
      note: "chain_resolved",
      reason: "invalid_chain_data",
    });
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("foreign chain-event duplicates resolve and report their collision once", () => {
    const db = openDb(":memory:");
    const collisionRegistry = {
      ...registry,
      edges: {
        "collision-edge@1": {
          recommendationField: "recommendation",
          edges: {
            NEXT: {
              eventType: "factory.work.requested",
              input: { repo: "$.input.repo" },
            },
          },
        },
      },
    };
    const now = Date.parse("2026-08-30T00:00:00.000Z");
    seedCompletedRun(db, {
      runId: "run-foreign-duplicate",
      agent: "collision-edge@1",
      input: { repo: "wm/collision" },
      artifact: { recommendation: "NEXT" },
    });
    expect(
      admitChainEvent(
        db,
        collisionRegistry,
        {
          schemaVersion: "factory.event/v1",
          eventId: "chain-run-foreign-duplicate",
          type: "factory.work.requested",
          subject: "collision-edge@1",
          occurredAt: new Date(now).toISOString(),
          correlationId: "corr-run-foreign-duplicate",
          causationId: "run-other",
          payload: { repo: "wm/collision" },
        },
        { now },
      ).admitted,
    ).toBe(true);

    const outcome = resolveChains(db, collisionRegistry, { now });
    expect(outcome.emitted).toBe(0);
    expect(outcome.skipped).toBe(0);
    expect(outcome.errors).toEqual([
      "chain-run-foreign-duplicate: duplicate chain event belongs to run-other",
    ]);
    expect(
      db
        .query(
          `SELECT chain_resolved_at FROM runs WHERE run_id = 'run-foreign-duplicate'`,
        )
        .get().chain_resolved_at,
    ).not.toBeNull();
    expect(resolveChains(db, collisionRegistry, { now })).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("intake conflicts resolve and report their refusal once", () => {
    const db = openDb(":memory:");
    const conflictRegistry = {
      ...registry,
      edges: {
        "conflict-edge@1": {
          recommendationField: "recommendation",
          edges: {
            NEXT: {
              eventType: "factory.work.requested",
              input: { repo: "$.input.repo" },
            },
          },
        },
      },
    };
    const now = Date.parse("2026-08-30T00:00:00.000Z");
    seedCompletedRun(db, {
      runId: "run-intake-conflict",
      agent: "conflict-edge@1",
      input: { repo: "wm/expected" },
      artifact: { recommendation: "NEXT" },
    });
    expect(
      admitChainEvent(
        db,
        conflictRegistry,
        {
          schemaVersion: "factory.event/v1",
          eventId: "chain-run-intake-conflict",
          type: "factory.work.requested",
          subject: "conflict-edge@1",
          occurredAt: new Date(now).toISOString(),
          correlationId: "corr-run-intake-conflict",
          causationId: "run-other",
          payload: { repo: "wm/conflicting" },
        },
        { now },
      ).admitted,
    ).toBe(true);

    const outcome = resolveChains(db, conflictRegistry, { now });
    expect(outcome.emitted).toBe(0);
    expect(outcome.skipped).toBe(0);
    expect(outcome.errors).toEqual([
      "chain-run-intake-conflict: eventId: already admitted with a different payload",
    ]);
    expect(
      db
        .query(
          `SELECT chain_resolved_at FROM runs WHERE run_id = 'run-intake-conflict'`,
        )
        .get().chain_resolved_at,
    ).not.toBeNull();
    expect(chainResolution(db, "run-intake-conflict")).toMatchObject({
      reason: "intake_refused",
      errors: [
        "chain-run-intake-conflict: eventId: already admitted with a different payload",
      ],
    });
    expect(resolveChains(db, conflictRegistry, { now })).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  /** Make intake of one chain child fail like a busy/corrupt database would. */
  function failInsertOf(db, eventId) {
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS fail_${eventId.replace(/[^a-z0-9]/gi, "_")}
         BEFORE INSERT ON events
         WHEN NEW.event_id = '${eventId}'
       BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`,
    );
    return () =>
      db.exec(
        `DROP TRIGGER IF EXISTS fail_${eventId.replace(/[^a-z0-9]/gi, "_")}`,
      );
  }

  function resolvedAtOf(db, runId) {
    return db
      .query(`SELECT chain_resolved_at FROM runs WHERE run_id = ?`)
      .get(runId).chain_resolved_at;
  }

  test("a transient intake throw leaves the chain step open and lands on a later pass (#1458)", () => {
    const db = openDb(":memory:");
    seedCompletedRun(db, {
      runId: "run-transient",
      agent: "work-scan@1",
      input: { repo: "wm/transient" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/transient",
        plan: [{ ticket: "WM-401" }],
      },
    });
    const heal = failInsertOf(db, "chain-run-transient-WM-401");

    const first = resolveChains(db, registry);
    expect(first.emitted).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toContain("database is locked");
    expect(resolvedAtOf(db, "run-transient")).toBeNull();
    expect(chainResolution(db, "run-transient")).toBeNull();

    heal();
    expect(resolveChains(db, registry)).toEqual({
      emitted: 1,
      skipped: 0,
      errors: [],
    });
    expect(resolvedAtOf(db, "run-transient")).not.toBeNull();
    expect(chainResolution(db, "run-transient")).toMatchObject({
      reason: "emitted",
      events: ["chain-run-transient-WM-401"],
    });
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("persistent transient failures give up after the bounded pass count with a recorded reason (#1458)", () => {
    const db = openDb(":memory:");
    seedCompletedRun(db, {
      runId: "run-stuck",
      agent: "work-scan@1",
      input: { repo: "wm/stuck" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/stuck",
        plan: [{ ticket: "WM-402" }],
      },
    });
    failInsertOf(db, "chain-run-stuck-WM-402");

    for (let pass = 1; pass < 3; pass += 1) {
      const outcome = resolveChains(db, registry, { maxTransientPasses: 3 });
      expect(outcome.emitted).toBe(0);
      expect(outcome.errors).toHaveLength(1);
      expect(resolvedAtOf(db, "run-stuck")).toBeNull();
    }
    const last = resolveChains(db, registry, { maxTransientPasses: 3 });
    expect(last.emitted).toBe(0);
    expect(last.errors).toHaveLength(2);
    expect(last.errors[1]).toBe(
      "chain-run-stuck: gave up after 3 transient failure(s)",
    );
    expect(resolvedAtOf(db, "run-stuck")).not.toBeNull();
    expect(chainResolution(db, "run-stuck")).toMatchObject({
      reason: "chain_gave_up",
      passes: 3,
    });
    expect(
      db
        .query(
          `SELECT COUNT(*) AS n FROM attempt_trace
            WHERE run_id = 'run-stuck'
              AND json_extract(payload_json, '$.note') = 'chain_transient_error'`,
        )
        .get().n,
    ).toBe(3);
    expect(resolveChains(db, registry, { maxTransientPasses: 3 })).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("returns the outcome when bookkeeping cannot acquire a held write lock (#1589)", () => {
    const dir = tmpDir("evrt-chain-bookkeeping-lock-");
    const file = path.join(dir, "runtime.db");
    const db = openDb(file);
    const writer = openDb(file);
    db.exec("PRAGMA busy_timeout = 10;");
    seedCompletedRun(db, {
      runId: "run-bookkeeping-lock",
      agent: "work-scan@1",
      input: { repo: "wm/bookkeeping-lock" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/bookkeeping-lock",
        plan: [{ ticket: "WM-1589" }],
      },
    });
    failInsertOf(db, "chain-run-bookkeeping-lock-WM-1589");

    writer.exec("BEGIN IMMEDIATE;");
    try {
      const outcome = resolveChains(db, registry);
      expect(outcome.emitted).toBe(0);
      expect(outcome.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("chain-run-bookkeeping-lock-WM-1589"),
          expect.stringContaining("chain-bookkeeping: database is locked"),
        ]),
      );
      expect(resolvedAtOf(db, "run-bookkeeping-lock")).toBeNull();
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
      db.close();
    }
  });

  test("a non-busy bookkeeping throw propagates instead of being retried every tick (#1589)", () => {
    const db = openDb(":memory:");
    seedCompletedRun(db, {
      runId: "run-bookkeeping-bug",
      agent: "work-scan@1",
      input: { repo: "wm/bookkeeping-bug" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/bookkeeping-bug",
        plan: [{ ticket: "WM-1591" }],
      },
    });
    failInsertOf(db, "chain-run-bookkeeping-bug-WM-1591");
    // A permanent bookkeeping bug: the transient marker itself cannot be written.
    db.exec(
      `CREATE TRIGGER fail_bookkeeping_bug
         BEFORE INSERT ON attempt_trace
         WHEN NEW.run_id = 'run-bookkeeping-bug'
       BEGIN SELECT RAISE(ABORT, 'constraint failed: attempt_trace'); END;`,
    );

    expect(() =>
      resolveChains(db, registry, { maxTransientPasses: 1 }),
    ).toThrow(/constraint failed: attempt_trace/);
    expect(resolvedAtOf(db, "run-bookkeeping-bug")).toBeNull();
    expect(
      db
        .query(
          `SELECT COUNT(*) AS n FROM attempt_trace
            WHERE run_id = 'run-bookkeeping-bug'`,
        )
        .get().n,
    ).toBe(0);
  });

  test("records later transient passes and gives up once a bookkeeping lock is released (#1589)", () => {
    const dir = tmpDir("evrt-chain-bookkeeping-recovery-");
    const file = path.join(dir, "runtime.db");
    const db = openDb(file);
    const writer = openDb(file);
    db.exec("PRAGMA busy_timeout = 10;");
    seedCompletedRun(db, {
      runId: "run-bookkeeping-recovery",
      agent: "work-scan@1",
      input: { repo: "wm/bookkeeping-recovery" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/bookkeeping-recovery",
        plan: [{ ticket: "WM-1590" }],
      },
    });
    failInsertOf(db, "chain-run-bookkeeping-recovery-WM-1590");

    writer.exec("BEGIN IMMEDIATE;");
    try {
      expect(
        resolveChains(db, registry, { maxTransientPasses: 2 }).errors,
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("chain-bookkeeping: database is locked"),
        ]),
      );
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }

    const first = resolveChains(db, registry, { maxTransientPasses: 2 });
    expect(first.errors).toHaveLength(1);
    expect(resolvedAtOf(db, "run-bookkeeping-recovery")).toBeNull();
    expect(
      db
        .query(
          `SELECT COUNT(*) AS n FROM attempt_trace
            WHERE run_id = 'run-bookkeeping-recovery'
              AND json_extract(payload_json, '$.note') = 'chain_transient_error'`,
        )
        .get().n,
    ).toBe(1);

    const last = resolveChains(db, registry, { maxTransientPasses: 2 });
    expect(last.errors).toEqual(
      expect.arrayContaining([
        "chain-run-bookkeeping-recovery: gave up after 2 transient failure(s)",
      ]),
    );
    expect(resolvedAtOf(db, "run-bookkeeping-recovery")).not.toBeNull();
    expect(chainResolution(db, "run-bookkeeping-recovery")).toMatchObject({
      reason: "chain_gave_up",
      passes: 2,
    });
    db.close();
  });

  test("a transient failure on one sibling keeps the fan-out open and retries only that sibling (#1458)", () => {
    const db = openDb(":memory:");
    seedCompletedRun(db, {
      runId: "run-partial-transient",
      agent: "work-scan@1",
      input: { repo: "wm/partial-transient" },
      artifact: {
        recommendation: "DISPATCH",
        repo: "wm/partial-transient",
        plan: [
          { ticket: "WM-501" },
          { ticket: "WM-502" },
          { ticket: "WM-503" },
        ],
      },
    });
    const heal = failInsertOf(db, "chain-run-partial-transient-WM-502");

    const first = resolveChains(db, registry);
    expect(first.emitted).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.errors).toEqual([
      expect.stringContaining(
        "chain-run-partial-transient-WM-502: database is locked",
      ),
    ]);
    expect(resolvedAtOf(db, "run-partial-transient")).toBeNull();
    expect(
      db
        .query(
          `SELECT event_id FROM events
            WHERE causation_id = 'run-partial-transient' ORDER BY event_id`,
        )
        .all()
        .map((row) => row.event_id),
    ).toEqual([
      "chain-run-partial-transient-WM-501",
      "chain-run-partial-transient-WM-503",
    ]);

    heal();
    expect(resolveChains(db, registry)).toEqual({
      emitted: 1,
      skipped: 0,
      errors: [],
    });
    expect(resolvedAtOf(db, "run-partial-transient")).not.toBeNull();
    expect(chainResolution(db, "run-partial-transient")).toMatchObject({
      reason: "emitted",
    });
    expect(
      db
        .query(
          `SELECT COUNT(*) AS n FROM events WHERE causation_id = 'run-partial-transient'`,
        )
        .get().n,
    ).toBe(3);
  });

  test("triage-apply outcome edges route to the correct follow-up", () => {
    const dir = tmpDir("evrt-chain-triage-apply-1");
    const db = openDb(path.join(dir, "runtime.db"));

    seedCompletedRun(db, {
      runId: "run-triage-supply",
      agent: "triage-apply@1",
      input: { repo: "wm/triage" },
      artifact: {
        outcome: "SUPPLY_CHANGED",
        repo: "wm/triage",
        applied: [{ issueId: "WM-1", action: "label-agent-ready" }],
      },
    });

    const supplyOutcome = resolveChains(db, registry);
    expect(supplyOutcome).toEqual({ emitted: 1, skipped: 0, errors: [] });
    const supplyEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get("chain-run-triage-supply");
    expect(supplyEvent.type).toBe("factory.work.requested");
    expect(JSON.parse(supplyEvent.envelope_json).payload).toEqual({
      repo: "wm/triage",
    });

    const dir2 = tmpDir("evrt-chain-triage-apply-2");
    const db2 = openDb(path.join(dir2, "runtime.db"));
    seedCompletedRun(db2, {
      runId: "run-triage-detail",
      agent: "triage-apply@1",
      input: { repo: "wm/triage" },
      artifact: {
        outcome: "DETAIL_CHANGED",
        repo: "wm/triage",
        applied: [{ issueId: "WM-2", action: "write-detail" }],
      },
    });
    // DETAIL_CHANGED no longer chains into factory.triage.requested (WM:
    // operator decision 2026-08-18, to stop burning the pi/codex adapter's
    // quota on ~30-minute chain loops). The triage floor is now the 8h
    // triage-factory schedule plus manual operator injection.
    const detailOutcome = resolveChains(db2, registry);
    expect(detailOutcome).toEqual({ emitted: 0, skipped: 1, errors: [] });
    const detailEvent = db2
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get("chain-run-triage-detail");
    expect(detailEvent).toBeNull();

    const dir3 = tmpDir("evrt-chain-triage-apply-3");
    const db3 = openDb(path.join(dir3, "runtime.db"));
    seedCompletedRun(db3, {
      runId: "run-triage-nochange",
      agent: "triage-apply@1",
      input: { repo: "wm/triage" },
      artifact: {
        outcome: "NO_CHANGE",
        repo: "wm/triage",
        applied: [{ issueId: "WM-3", action: "move-to-todo" }],
      },
    });
    expect(resolveChains(db3, registry)).toEqual({
      emitted: 0,
      skipped: 1,
      errors: [],
    });
  });

  test("dispatch PR_OPEN fans out work continuation and scoped merge review (WM-576)", () => {
    const db = openDb(":memory:");
    seedCompletedRun(db, {
      runId: "run-dispatch-pr-open",
      agent: "dispatch@1",
      input: { repo: "factory", ticket: "WM-576" },
      artifact: {
        outcome: "PR_OPEN",
        repo: "factory",
        ticket: "WM-576",
        prNumber: 576,
      },
    });

    expect(resolveChains(db, registry)).toEqual({
      emitted: 2,
      skipped: 0,
      errors: [],
    });
    const events = db
      .query(
        `SELECT event_id,type,envelope_json FROM events WHERE source = 'chain' ORDER BY event_id`,
      )
      .all();
    expect(
      events.map(({ event_id, type }) => ({ eventId: event_id, type })),
    ).toEqual([
      { eventId: "chain-run-dispatch-pr-open", type: "factory.work.requested" },
      {
        eventId: "chain-run-dispatch-pr-open-merge",
        type: "factory.merge.requested",
      },
    ]);
    expect(JSON.parse(events[0].envelope_json).payload).toEqual({
      repo: "factory",
    });
    expect(JSON.parse(events[1].envelope_json).payload).toEqual({
      repo: "factory",
      prNumbers: [576],
    });
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("merge-scan REVIEW fans out per-PR merge-review.requested (WM-907)", () => {
    const dir = tmpDir("evrt-chain-merge-review-");
    const db = openDb(path.join(dir, "runtime.db"));
    const head = "a".repeat(40);
    const base = "b".repeat(40);

    seedCompletedRun(db, {
      runId: "run-scan-reviews",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "REVIEW",
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        reviews: [
          { pr: 12, headSha: head, baseSha: base },
          { pr: 13, headSha: head, baseSha: base },
        ],
        plan: [],
        fix: [],
        escalate: [],
        summary: "two misses",
      },
    });

    expect(resolveChains(db, registry)).toEqual({
      emitted: 2,
      skipped: 0,
      errors: [],
    });
    for (const pr of [12, 13]) {
      const event = db
        .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
        .get(`chain-run-scan-reviews-${pr}`);
      expect(event).toBeTruthy();
      expect(event.type).toBe("factory.merge-review.requested");
      expect(JSON.parse(event.envelope_json).payload).toEqual({
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr,
        headSha: head,
        baseSha: base,
      });
    }
  });

  test("a refused review with no verdict is proposed again on the next scan cycle", () => {
    const dir = tmpDir("evrt-chain-merge-review-refused-");
    const db = openDb(path.join(dir, "runtime.db"));
    const github = "watt-mind/factory";
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const now = "2026-08-24T10:00:00.000Z";
    const reviewInput = {
      repo: "factory",
      github,
      base: "develop",
      pr: 12,
      headSha: head,
      baseSha: base,
    };
    const reviewSpec = {
      agent: "merge-review@1",
      input: reviewInput,
    };

    db.query(
      `INSERT INTO events
         (source, event_id, type, subject, occurred_at, received_at,
          correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES ('chain', 'chain-first-scan-12', 'factory.merge-review.requested',
               'merge-scan@2', ?, ?, 'merge-cycle', 'run-first-scan', ?,
               'sha256:event', 'planned', ?)`,
    ).run(
      now,
      now,
      JSON.stringify({
        schemaVersion: "factory.event/v1",
        eventId: "chain-first-scan-12",
        type: "factory.merge-review.requested",
        source: "chain",
        subject: "merge-scan@2",
        occurredAt: now,
        correlationId: "merge-cycle",
        causationId: "run-first-scan",
        payload: reviewInput,
      }),
      now,
    );
    createRun(db, {
      runId: "run-refused-review",
      idempotencyKey: "merge-review-family",
      spec: reviewSpec,
      specJson: JSON.stringify(reviewSpec),
      specHash: "sha256:spec",
      actor: "planner",
      correlationId: "merge-cycle",
      causationId: "run-first-scan",
      policyVersion: PV,
      now: Date.parse(now),
    });
    // This is the persisted suppression seam: an open proposal linked to a
    // terminal run is not actionable, but older data can retain one.
    db.query(
      `INSERT INTO proposals
         (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
          idempotency_key, status, created_at, ttl_seconds)
       VALUES ('prop-refused-review', 'chain', 'chain-first-scan-12',
               'run-refused-review', 'run', ?, 'sha256:spec',
               'merge-review-family', 'open', ?, 1800)`,
    ).run(JSON.stringify(reviewSpec), now);
    for (const [from, to] of [
      ["PROPOSED", "APPROVED"],
      ["APPROVED", "QUEUED"],
      ["QUEUED", "LEASED"],
      ["LEASED", "RUNNING"],
      ["RUNNING", "VERIFYING"],
      ["VERIFYING", "REFUSED"],
    ]) {
      transition(db, {
        runId: "run-refused-review",
        to,
        expectFrom: from,
        actor: "test-worker",
        reason: to === "REFUSED" ? "needs_human" : "test lifecycle",
        policyVersion: PV,
        now: Date.parse(now),
      });
    }
    db.query(
      `INSERT INTO results
         (run_id, attempt, result_json, artifact_hash, verification_json,
          receipt_json, accepted_at)
       VALUES ('run-refused-review', 1, ?, 'none', '{}', '{}', ?)`,
    ).run(
      JSON.stringify({
        schemaVersion: "factory.agent-result/v1",
        terminalState: "refused",
        reasonCode: "needs_human",
      }),
      now,
    );
    expect(db.query(`SELECT COUNT(*) AS n FROM merge_reviews`).get().n).toBe(0);

    const forge = memoryForge({
      repos: {
        [github]: {
          prs: [
            {
              number: 12,
              state: "OPEN",
              isDraft: false,
              headRefOid: head,
              headRefName: "feat/gh-1034",
              baseRefName: "develop",
              title: "Fix retry starvation",
              body: "Fixes watt-mind/factory#1034",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
            },
          ],
        },
      },
      api: { [`repos/${github}/git/ref/heads/develop`]: base },
    });
    const scan = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge,
      repos: new Map([
        [
          "factory",
          {
            name: "factory",
            github,
            base: "develop",
            deployBranch: "main",
          },
        ],
      ]),
    });
    expect(scan.artifact.reviews.map((item) => item.pr)).toEqual([12]);

    seedCompletedRun(db, {
      runId: "run-second-scan",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: scan.artifact,
      correlationId: "merge-cycle",
    });
    expect(resolveChains(db, registry)).toEqual({
      emitted: 1,
      skipped: 0,
      errors: [],
    });
    db.query(
      `UPDATE events SET status = 'planned'
        WHERE source = 'operator' AND event_id = 'evt-run-second-scan'`,
    ).run();

    const synthetic = { ...registry, agents: new Map(registry.agents) };
    synthetic.agents.set("merge-review@1", {
      ...synthetic.agents.get("merge-review@1"),
      workspace: { type: "none" },
    });
    expect(
      planAdmittedEvents(db, synthetic, {
        policyVersion: PV,
        now: Date.parse("2026-08-24T10:01:00.000Z"),
      }),
    ).toMatchObject({ planned: 1, failed: 0 });
    const fresh = db
      .query(
        `SELECT p.run_id AS runId, p.status, r.state
           FROM proposals p
           JOIN runs r ON r.run_id = p.run_id
          WHERE p.event_source = 'chain'
            AND p.event_id = 'chain-run-second-scan-12'`,
      )
      .get();
    expect(fresh).toMatchObject({ status: "approved", state: "QUEUED" });
    expect(fresh.runId).not.toBe("run-refused-review");
    expect(db.query(`SELECT COUNT(*) AS n FROM merge_reviews`).get().n).toBe(0);
  });

  test("merge-fix UPDATED targets merge-review.requested for the new head (WM-907)", () => {
    const dir = tmpDir("evrt-chain-merge-fix-review-");
    const db = openDb(path.join(dir, "runtime.db"));
    const oldHead = "a".repeat(40);
    const newHead = "c".repeat(40);
    const base = "b".repeat(40);

    seedCompletedRun(db, {
      runId: "run-fix-updated",
      agent: "merge-fix@1",
      input: {
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 12,
        headSha: oldHead,
        baseSha: base,
        headRef: "feat/WM-12",
        ticket: "WM-12",
        finding: "rebase_onto_base",
        findingHash: "d".repeat(64),
        round: 1,
        mechanical: true,
        withinOwnedPaths: true,
        ownedPaths: ["event-runtime/lib/chain.mjs"],
      },
      artifact: {
        outcome: "UPDATED",
        repo: "factory",
        ticket: "WM-12",
        pr: 12,
        headSha: newHead,
        round: 1,
        summary: "rebased",
      },
    });

    expect(resolveChains(db, registry)).toEqual({
      emitted: 1,
      skipped: 0,
      errors: [],
    });
    const event = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get("chain-run-fix-updated");
    expect(event.type).toBe("factory.merge-review.requested");
    expect(JSON.parse(event.envelope_json).payload).toEqual({
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      pr: 12,
      headSha: newHead,
      baseSha: base,
    });
  });

  test("non-completed runs do not generate chain candidates", () => {
    const dir = tmpDir("evrt-chain-triage-fail-");
    const db = openDb(path.join(dir, "runtime.db"));
    const now = new Date().toISOString();

    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES ('run-triage-failed', 'idem-run-triage-failed', '{"agent":"triage-apply@1","input":{"repo":"wm/triage"}}', 'hash', 'FAILED', 1, ?, ?)`,
    ).run(now, now);

    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });
});
