import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { lifecycleOf, runState } from "./lifecycle.mjs";
import { planEvent } from "./planner.mjs";
import { ambiguousOpenProposalRuns, approveProposal, closeOpenProposalForRun, getProposal, openProposals, rejectProposal } from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const NOW = Date.parse("2026-08-12T10:30:02Z");
const TTL_MS = 1800 * 1000; // factory.status-report.requested proposalTtlSeconds

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

/** Admit and plan one event; returns { db, proposal, runId }. */
function planned(overrides = {}, { now = NOW, policyVersion = "git:test" } = {}) {
  const db = openDb(":memory:");
  const admitted = admitEvent(db, registry, envelope(overrides), { now });
  expect(admitted.admitted).toBe(true);
  const outcome = planEvent(
    db, registry,
    { source: admitted.event.source, eventId: admitted.event.event_id },
    { now, policyVersion },
  );
  expect(outcome.decision).toBe("run");
  return { db, proposal: outcome.proposal, runId: outcome.runId };
}

describe("openProposals / getProposal", () => {
  test("annotates open proposals with expired flag and parsed spec", () => {
    const { db, proposal, runId } = planned();
    const fresh = openProposals(db, { now: NOW + 60_000 });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe(proposal.id);
    expect(fresh[0].expired).toBe(false);
    expect(fresh[0].spec.runId).toBe(runId);
    expect(fresh[0].spec.agent).toBe("factory-status-report@1");

    const stale = openProposals(db, { now: NOW + TTL_MS + 1 });
    expect(stale[0].expired).toBe(true);

    expect(getProposal(db, proposal.id).spec.runId).toBe(runId);
    expect(getProposal(db, "prop_nope")).toBeNull();
  });
});

describe("approveProposal within TTL", () => {
  test("transitions the run PROPOSED → APPROVED → QUEUED and marks the proposal approved", () => {
    const { db, proposal, runId } = planned();
    const result = approveProposal(db, registry, proposal.id, { actor: "operator", now: NOW + 60_000 });
    expect(result).toEqual({ approved: true, runId });
    expect(runState(db, runId)).toBe("QUEUED");

    const row = getProposal(db, proposal.id);
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("operator");
    expect(row.decided_at).toBe(new Date(NOW + 60_000).toISOString());

    const journal = lifecycleOf(db, runId);
    expect(journal.map((e) => e.to_state)).toEqual(["PROPOSED", "APPROVED", "QUEUED"]);
    expect(journal[1].actor).toBe("operator");
    expect(journal[1].correlation_id).toBe("workflow-01");
  });

  test("only open 'run' proposals are approvable", () => {
    const { db, proposal } = planned();
    approveProposal(db, registry, proposal.id, { actor: "operator", now: NOW });
    expect(() => approveProposal(db, registry, proposal.id, { actor: "operator", now: NOW })).toThrow(/not open/);
    expect(() => approveProposal(db, registry, "prop_nope", { actor: "operator", now: NOW })).toThrow(/unknown proposal/);
  });
});

describe("rejectProposal", () => {
  test("marks the proposal rejected and cancels the PROPOSED run", () => {
    const { db, proposal, runId } = planned();
    const result = rejectProposal(db, proposal.id, { actor: "operator", reason: "not today", now: NOW + 1000 });
    expect(result).toEqual({ rejected: true, runId });
    expect(runState(db, runId)).toBe("CANCELLED");

    const row = getProposal(db, proposal.id);
    expect(row.status).toBe("rejected");
    expect(row.decided_by).toBe("operator");
    expect(row.reason).toBe("not today");

    const journal = lifecycleOf(db, runId);
    expect(journal.at(-1).to_state).toBe("CANCELLED");
    expect(journal.at(-1).reason).toBe("proposal_rejected");
    expect(journal.at(-1).actor).toBe("operator");
  });
});

describe("closeOpenProposalForRun", () => {
  test("closes the unique open proposal with reason run_cancelled", () => {
    const { db, proposal, runId } = planned();
    const later = NOW + 1000;
    expect(closeOpenProposalForRun(db, runId, { actor: "operator", now: later }))
      .toEqual({ closed: true, id: proposal.id });
    const row = getProposal(db, proposal.id);
    expect(row.status).toBe("rejected");
    expect(row.reason).toBe("run_cancelled");
    expect(row.decided_by).toBe("operator");
    expect(row.decided_at).toBe(new Date(later).toISOString());
    expect(openProposals(db, { now: later })).toHaveLength(0);
  });

  test("no-op when the run has no open proposal", () => {
    const { db, proposal, runId } = planned();
    approveProposal(db, registry, proposal.id, { actor: "operator", now: NOW });
    expect(closeOpenProposalForRun(db, runId, { actor: "operator", now: NOW }))
      .toEqual({ closed: false });
    expect(getProposal(db, proposal.id).status).toBe("approved");
    expect(closeOpenProposalForRun(db, "run_missing", { actor: "operator", now: NOW }))
      .toEqual({ closed: false });
  });

  test("leaves every proposal untouched when more than one is open for the run", () => {
    const { db, proposal, runId } = planned();
    expect(ambiguousOpenProposalRuns(db)).toEqual([]);
    const at = new Date(NOW).toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', ?, 1800)`,
    ).run("prop_extra", proposal.event_source, proposal.event_id, runId, at);
    expect(closeOpenProposalForRun(db, runId, { actor: "operator", now: NOW }))
      .toEqual({ closed: false, ambiguous: true, count: 2 });
    expect(getProposal(db, proposal.id).status).toBe("open");
    expect(getProposal(db, "prop_extra").status).toBe("open");
    expect(ambiguousOpenProposalRuns(db)).toEqual([{ runId, count: 2 }]);
  });
});

describe("ambiguousOpenProposalRuns", () => {
  test("two open human_needed proposals with NULL run_id are not reported as ambiguous", () => {
    const db = openDb(":memory:");
    for (const eventId of ["hn-null-1", "hn-null-2"]) {
      const admitted = admitEvent(db, registry, envelope({ eventId, type: "totally.unknown.type" }), { now: NOW });
      expect(admitted.admitted).toBe(true);
      const outcome = planEvent(
        db, registry,
        { source: admitted.event.source, eventId: admitted.event.event_id },
        { now: NOW },
      );
      expect(outcome.decision).toBe("human_needed");
      expect(outcome.proposal.run_id).toBeNull();
    }
    expect(openProposals(db, { now: NOW })).toHaveLength(2);
    expect(ambiguousOpenProposalRuns(db)).toEqual([]);
  });
});

describe("approveProposal after TTL expiry (§12)", () => {
  test("unchanged conditions: re-plan matches, run is approved with a replan reason", () => {
    const { db, proposal, runId } = planned();
    const later = NOW + TTL_MS + 1;
    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator", now: later, policyVersion: "git:test",
    });
    expect(result).toEqual({ approved: true, runId });
    expect(runState(db, runId)).toBe("QUEUED");
    expect(getProposal(db, proposal.id).status).toBe("approved");

    const journal = lifecycleOf(db, runId);
    expect(journal.at(-1).reason).toBe("approved_after_ttl_replan");
  });

  test("changed conditions: stale proposal superseded, new open proposal, run stays PROPOSED with fresh spec", () => {
    const { db, proposal, runId } = planned();
    const later = NOW + TTL_MS + 1;
    // adapterOverride forces the re-planned spec to differ from the stale one
    // (the registered route is pi since WM-215, so claude is the off-route value).
    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator", now: later, policyVersion: "git:test", adapterOverride: "claude",
    });

    expect(result.approved).toBe(false);
    expect(result.replanned).toBe(true);
    expect(result.proposal.id).not.toBe(proposal.id);
    expect(result.proposal.status).toBe("open");
    expect(result.proposal.run_id).toBe(runId);
    expect(result.proposal.spec.adapter).toBe("claude");
    expect(result.proposal.created_at).toBe(new Date(later).toISOString());

    // The stale proposal was never executed.
    expect(getProposal(db, proposal.id).status).toBe("superseded");
    expect(runState(db, runId)).toBe("PROPOSED");

    // The still-PROPOSED run carries the fresh spec, atomically with the swap.
    const run = db.query(`SELECT * FROM runs WHERE run_id = ?`).get(runId);
    expect(JSON.parse(run.spec_json).adapter).toBe("claude");
    expect(run.spec_hash).toBe(result.proposal.spec_hash);
    expect(run.updated_at).toBe(new Date(later).toISOString());

    // Exactly one open proposal remains, unexpired under its fresh TTL.
    const open = openProposals(db, { now: later });
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(result.proposal.id);
    expect(open[0].expired).toBe(false);

    // Approving the fresh proposal (same override, so specs match) queues the run.
    const approved = approveProposal(db, registry, result.proposal.id, {
      actor: "operator", now: later + 1000, policyVersion: "git:test", adapterOverride: "claude",
    });
    expect(approved).toEqual({ approved: true, runId });
    expect(runState(db, runId)).toBe("QUEUED");
  });
});
