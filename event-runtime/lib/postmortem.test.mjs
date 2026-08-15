import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { pinRunArtifact } from "./artifacts.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { approveProposal, openProposals } from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";
import { runOnce } from "./worker.mjs";

const registry = loadRegistry();
const PV = "git:test-pv";
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));

function harness() {
  const db = openDb(path.join(tmp("evrt-pm-"), "runtime.db"));
  const opts = {
    workspacesRoot: tmp("evrt-pm-ws-"),
    artifactStore: tmp("evrt-pm-store-"),
    owner: "w",
    policyVersion: PV,
  };
  const adapters = { pi: fake, command: fake };

  async function runOne(envelope, agentRef) {
    expect(admitEvent(db, registry, envelope).admitted).toBe(true);
    planAdmittedEvents(db, registry, opts);
    const proposal = openProposals(db, {}).find((p) => p.spec?.agent === agentRef);
    expect(proposal).toBeTruthy();
    const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
    const summary = await runOnce(db, registry, adapters, opts);
    return { runId: approved.runId, summary, proposal };
  }
  return { db, opts, adapters, runOne };
}

const statusEnvelope = (eventId, repos = ["ok"]) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.status-report.requested",
  source: "test",
  occurredAt: "2026-08-13T10:00:00Z",
  correlationId: eventId,
  payload: { repos },
});

const postmortemEnvelope = (eventId, runId) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.run-postmortem.requested",
  source: "operator",
  occurredAt: "2026-08-13T11:00:00Z",
  correlationId: eventId,
  payload: { runId },
});

describe("run-postmortem: consuming an artifact across runs (OPS-373)", () => {
  test("the planner pins the earlier run's transcript, and the agent reads those bytes", async () => {
    const h = harness();

    // An ordinary run, unrelated to any postmortem — its transcript is captured
    // by the adapter as a matter of course.
    const subject = await h.runOne(statusEnvelope("subject-1"), "factory-status-report@1");
    expect(subject.summary.terminalState).toBe("COMPLETED");

    // Later, and with no chain between them, the operator asks why.
    const pm = await h.runOne(postmortemEnvelope("pm-1", subject.runId), "run-postmortem@1");
    expect(pm.summary.terminalState).toBe("COMPLETED");

    // The pin is in the approved spec: the operator approved specific bytes.
    expect(pm.proposal.spec.input.runPin).toMatchObject({ runId: subject.runId, state: "COMPLETED" });
    expect(pm.proposal.spec.input.runPin.transcript).toMatch(/^[0-9a-f]{64}$/);

    // And the agent actually read the materialized transcript.
    const result = JSON.parse(
      h.db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(pm.runId).result_json,
    );
    expect(result.artifact.runId).toBe(subject.runId);
    expect(result.evidence.transcriptBytes).toBeGreaterThan(0);
  });

  test("the pin names the exact stored bytes the subject run produced", async () => {
    const h = harness();
    const subject = await h.runOne(statusEnvelope("subject-2"), "factory-status-report@1");
    const pin = pinRunArtifact(h.db, subject.runId);
    const stored = JSON.parse(
      h.db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(subject.runId).result_json,
    ).artifacts.find((a) => a.kind === "transcript");
    expect(pin.transcript).toBe(stored.sha256);
    expect(readFileSync(path.join(h.opts.artifactStore, pin.transcript), "utf8").length).toBeGreaterThan(0);
  });

  test("an unknown run parks for a human instead of proposing a run over nothing", async () => {
    const h = harness();
    admitEvent(h.db, registry, postmortemEnvelope("pm-unknown", "run_does_not_exist"));
    planAdmittedEvents(h.db, registry, h.opts);
    const parked = openProposals(h.db, {}).find((p) => p.decision === "human_needed");
    expect(parked.reason).toContain("run_pin_failed");
    expect(parked.reason).toContain("unknown run");
  });

  test("a run that never produced a transcript parks with that reason, not a crash", async () => {
    const h = harness();
    // A run with an accepted result but no transcript artifact.
    h.db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES ('run_bare', 'k', '{"agent":"x@1"}', 'sha256:x', 'FAILED', 1, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    h.db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES ('run_bare', 1, '{"artifacts":[]}', 'sha256:x', '{}', '{}', ?)`,
    ).run(new Date().toISOString());

    admitEvent(h.db, registry, postmortemEnvelope("pm-bare", "run_bare"));
    planAdmittedEvents(h.db, registry, h.opts);
    const parked = openProposals(h.db, {}).find((p) => p.decision === "human_needed");
    expect(parked.reason).toContain('stored no "transcript" artifact');
  });
});
