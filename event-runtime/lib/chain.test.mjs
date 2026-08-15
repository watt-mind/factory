import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { buildChainInput, resolveChains } from "./chain.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { approveProposal, openProposals } from "./proposals.mjs";
import { loadRegistry, RegistryError } from "./registry.mjs";
import { runOnce } from "./worker.mjs";

const registry = loadRegistry();
const PV = "git:test-pv";

function failedRunEnvelope(overrides = {}) {
  const id = overrides.eventId ?? `gh-${Math.random().toString(36).slice(2, 10)}`;
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

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-chain-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-chain-ws-"));
  // Chain flow under test never spawns real processes: pi AND command
  // both back onto the contract-shaped fake.
  const adapters = { pi: fake, command: fake };
  const workerOpts = { workspacesRoot: workspaces, owner: "w-test", policyVersion: PV };

  async function runToCompletion(eventId) {
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find(
      (p) => p.decision === "run" && (p.event_id === eventId || p.spec?.idempotencyKey),
    );
    expect(proposal).toBeTruthy();
    const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
    expect(approved.approved).toBe(true);
    const summary = await runOnce(db, registry, adapters, workerOpts);
    expect(summary.terminalState).toBe("COMPLETED");
    return { proposal, runId: approved.runId };
  }

  return { db, adapters, workerOpts, runToCompletion };
}

describe("buildChainInput", () => {
  const context = { input: { repo: "wm/x", runId: 7 }, artifact: { verdict: "FLAKE", nested: { a: 1 } } };

  test("resolves $.input.* and $.artifact.* paths and passes literals through", () => {
    expect(
      buildChainInput({ repo: "$.input.repo", v: "$.artifact.verdict", deep: "$.artifact.nested.a", lit: "x" }, context),
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
          literal: "fixed",
        },
        itemContext,
      ),
    ).toEqual({
      repo: "wm/x",
      ticket: "WM-119",
      tag: "alpha",
      fullItem: { ticket: "WM-119", count: 42, meta: { tag: "alpha" } },
      literal: "fixed",
    });
  });

  test("missing path fails loudly", () => {
    expect(() => buildChainInput({ nope: "$.artifact.absent" }, context)).toThrow("resolves to nothing");
  });
});

/**
 * github.workflow-run.failed now lands on ci-log-capture@1, which stores the
 * log as an artifact and chains to ci-doctor@2 (OPS-372). Run that first hop
 * so these tests stay about the *verdict* edges they were written for.
 */
async function throughCapture(h, eventId) {
  const capture = await h.runToCompletion(eventId);
  expect(resolveChains(h.db, registry).emitted).toBe(1);
  planAdmittedEvents(h.db, registry, { policyVersion: PV });
  const diagnose = openProposals(h.db, {}).find((p) => p.spec?.agent === "ci-doctor@2");
  expect(diagnose).toBeTruthy();
  const approved = approveProposal(h.db, registry, diagnose.id, { actor: "operator", policyVersion: PV });
  const summary = await runOnce(h.db, registry, h.adapters, h.workerOpts);
  expect(summary.terminalState).toBe("COMPLETED");
  return { capture, diagnoseRunId: approved.runId, diagnoseProposal: diagnose };
}

describe("discovered chain: ci-doctor → follow-up (OPS-223)", () => {
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
    const followUp = openProposals(db, {}).find((p) => p.spec?.agent === "ci-rerun@1");
    expect(followUp).toBeTruthy();
    expect(followUp.status).toBe("open");
    expect(followUp.spec.adapter).toBe("command");
    expect(followUp.spec.input).toEqual({ repo: "wm/factory", runId: 12345 });

    // Re-resolving chains emits nothing new: the already-chained run is
    // excluded up front (NOT EXISTS on its chain event) — one event per run, ever.
    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 0, errors: [] });
  });

  test("TICKET verdict chains to ci-notify with the diagnosis summary mapped in", async () => {
    const h = harness();
    const { db, runToCompletion } = h;
    admitEvent(db, registry, failedRunEnvelope({
      eventId: "gh-ticket-1",
      payload: { repo: "wm/factory-ticket", runId: 777 },
    }));
    await throughCapture(h, "gh-ticket-1");

    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const followUp = openProposals(db, {}).find((p) => p.spec?.agent === "ci-notify@1");
    expect(followUp).toBeTruthy();
    expect(followUp.spec.input.summary).toContain("wm/factory-ticket");
  });

  test("full chain executes after approval: rerun completes under the command contract", async () => {
    const h = harness();
    const { db, adapters, workerOpts } = h;
    admitEvent(db, registry, failedRunEnvelope({ eventId: "gh-flake-2", payload: { repo: "wm/f2", runId: 2 } }));
    await throughCapture(h, "gh-flake-2");
    resolveChains(db, registry);
    planAdmittedEvents(db, registry, { policyVersion: PV });

    const followUp = openProposals(db, {}).find((p) => p.spec?.agent === "ci-rerun@1");
    const approved = approveProposal(db, registry, followUp.id, { actor: "operator", policyVersion: PV });
    expect(approved.approved).toBe(true);
    const summary = await runOnce(db, registry, adapters, workerOpts);
    expect(summary.terminalState).toBe("COMPLETED");

    // The command result has no registered edges — the chain terminates.
    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 0, errors: [] });
  });

  test("duplicate failed-run delivery converges: one doctor run, one chain event", async () => {
    const h = harness();
    const { db, runToCompletion } = h;
    admitEvent(db, registry, failedRunEnvelope({ eventId: "gh-dup-1", payload: { repo: "wm/d", runId: 9 } }));
    const dup = admitEvent(db, registry, failedRunEnvelope({ eventId: "gh-dup-1", payload: { repo: "wm/d", runId: 9 } }));
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
    const root = mkdtempSync(path.join(os.tmpdir(), "evrt-reg-"));
    cpSync(path.join(registry.root, "agents"), path.join(root, "agents"), { recursive: true });
    cpSync(path.join(registry.root, "schemas"), path.join(root, "schemas"), { recursive: true });
    cpSync(path.join(registry.root, "event-types.json"), path.join(root, "event-types.json"));

    writeFileSync(
      path.join(root, "edges.json"),
      JSON.stringify({ "ci-doctor@2": { recommendationField: "verdict", edges: { FLAKE: { eventType: "not.registered", input: {} } } } }),
    );
    expect(() => loadRegistry({ root })).toThrow(RegistryError);

    writeFileSync(
      path.join(root, "edges.json"),
      JSON.stringify({ "ci-doctor@2": { recommendationField: "verdict", edges: { FLAKE: { eventType: "factory.ci-rerun.requested", input: { x: "$.secrets.key" } } } } }),
    );
    expect(() => loadRegistry({ root })).toThrow("only $.input.*, $.artifact.* and $.artifactHash.*");
  });
});

describe("multi-emit chain resolution (WM-119)", () => {
  function seedCompletedRun(db, { runId, agent, input, artifact, eventId = `evt-${runId}`, correlationId = `corr-${runId}` }) {
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES ('operator', ?, 'test.event', 'test', ?, ?, ?, NULL, ?, 'hash', 'admitted', ?)`,
    ).run(eventId, now, now, correlationId, JSON.stringify({ payload: input }), now);

    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, spec_json, status, created_at, ttl_seconds)
       VALUES (?, 'operator', ?, ?, 'run', ?, 'approved', ?, 1800)`,
    ).run(`prop-${runId}`, eventId, runId, JSON.stringify({ agent, input }), now);

    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 1, ?, ?)`,
    ).run(runId, `idem-${runId}`, JSON.stringify({ agent, input }), now, now);

    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'art-hash', '{}', '{}', ?)`,
    ).run(runId, JSON.stringify({ artifact }), now);
  }

  test("fans out N planned items into N admitted chain events with chain-<runId>-<itemKey> IDs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-chain-multi-"));
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
      const event = db.query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`).get(`chain-run-fanout-1-${ticket}`);
      expect(event).toBeTruthy();
      expect(event.type).toBe("factory.dispatch.requested");
      expect(event.correlation_id).toBe("scan-corr-1");
      expect(event.causation_id).toBe("run-fanout-1");
      const envelope = JSON.parse(event.envelope_json);
      expect(envelope.payload).toEqual({ repo: "wm/multi", ticket });
    }

    // Idempotent: re-resolving chains emits 0
    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 0, errors: [] });
  });

  test("empty plan skips cleanly without error", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-chain-empty-"));
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

    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
  });

  test("custom eventId templating and perItem mapping overlays", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-chain-tmpl-"));
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
    const event = db.query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`).get("chain-run-tmpl-1-WM-201");
    expect(event).toBeTruthy();
    expect(JSON.parse(event.envelope_json).payload).toEqual({ repo: "wm/tmpl", ticket: "WM-201" });
  });

  test("missing itemKey records error cleanly", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-chain-err-"));
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
  });
});

