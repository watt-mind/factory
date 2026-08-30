import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-proposals-test-mjs";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { lifecycleOf, runState } from "./lifecycle.mjs";
import { planEvent } from "./planner.mjs";
import { computeDefHash } from "./receipts.mjs";
import {
  ambiguousOpenProposalRuns,
  approveProposal,
  closeOpenProposalForRun,
  getProposal,
  openProposals,
  rejectProposal,
  sweepOrphanedNonRunProposals,
} from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";
import { claimNext } from "./worker.mjs";

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
function planned(
  overrides = {},
  { now = NOW, policyVersion = "git:test" } = {},
) {
  const db = openDb(":memory:");
  const admitted = admitEvent(db, registry, envelope(overrides), { now });
  expect(admitted.admitted).toBe(true);
  const outcome = planEvent(
    db,
    registry,
    { source: admitted.event.source, eventId: admitted.event.event_id },
    { now, policyVersion },
  );
  expect(outcome.decision).toBe("run");
  return { db, proposal: outcome.proposal, runId: outcome.runId };
}

/**
 * Plan the dispatch against a repos root owned by this test, never the
 * ambient one. The dispatch gate resolves `repo: "factory"` through
 * `FACTORY_REPOS_ROOT`/`config/repos.yaml` and checks that the checkout path
 * exists; with the example config (`~/Develop/factory`) that only holds on an
 * operator host, and inside the handoff sandbox (`HOME=/tmp/home`) the plan
 * refuses with `owned_paths_not_closed` before any proposal exists.
 */
function withHermeticReposRoot(fn) {
  const root = tmpDir("evrt-proposals-ttl-");
  const repoPath = path.join(root, "checkout");
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n  - name: factory\n    path: ${repoPath}\n    base: develop\n` +
      `    github: watt-mind/factory\n    team: WM\n    project: Factory\n` +
      `    worktree_up: bin/up\n    worktree_down: bin/down\n` +
      `    worktree_root: ${path.join(root, "worktrees")}\n    escalate_paths: []\n`,
  );
  const previous = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previous;
  }
}

function dispatchPlanned() {
  const db = openDb(":memory:");
  const admitted = admitEvent(
    db,
    registry,
    envelope({
      eventId: "ttl-dispatch-1",
      type: "factory.dispatch.requested",
      source: "handoff",
      subject: "watt-mind/factory#1611",
      correlationId: "ttl-dispatch-1",
      payload: {
        repo: "factory",
        ticket: "watt-mind/factory#1611",
        modelTier: "light",
      },
    }),
    { now: NOW },
  );
  expect(admitted.admitted).toBe(true);
  const outcome = withHermeticReposRoot(() =>
    planEvent(
      db,
      registry,
      { source: admitted.event.source, eventId: admitted.event.event_id },
      {
        now: NOW,
        policyVersion: "git:test",
        dispatch: {
          countLeases: () => 0,
          budgetRefusal: () => null,
          fetchTicket: () => ({
            identifier: "watt-mind/factory#1611",
            state: { name: "Todo" },
            assignee: null,
            labels: { nodes: [{ name: "ai:agent-ready" }] },
            description: "## Owned Paths\n- event-runtime/lib/proposals.mjs\n",
          }),
          fetchInFlight: () => [],
        },
      },
    ),
  );
  expect(outcome.decision, outcome.reason ?? "").toBe("run");
  const spec = JSON.parse(outcome.proposal.spec_json);
  spec.idempotencyKey = `${spec.idempotencyKey}#1`;
  spec.configSnapshot = {
    root: "/policy/snapshot",
    repos: [{ name: "factory", base: "develop" }],
  };
  const specJson = JSON.stringify(spec);
  const specHash = hashJson(spec);
  db.query(
    `UPDATE runs SET idempotency_key = ?, spec_json = ?, spec_hash = ? WHERE run_id = ?`,
  ).run(spec.idempotencyKey, specJson, specHash, outcome.runId);
  db.query(
    `UPDATE proposals SET idempotency_key = ?, spec_json = ?, spec_hash = ? WHERE id = ?`,
  ).run(spec.idempotencyKey, specJson, specHash, outcome.proposal.id);
  return {
    db,
    proposal: getProposal(db, outcome.proposal.id),
    runId: outcome.runId,
  };
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

  test("does not expire a parked non-run proposal by TTL", () => {
    const db = openDb(":memory:");
    const admitted = admitEvent(
      db,
      registry,
      envelope({ eventId: "parked-past-ttl", type: "totally.unknown.type" }),
      { now: NOW },
    );
    const outcome = planEvent(
      db,
      registry,
      { source: admitted.event.source, eventId: admitted.event.event_id },
      { now: NOW },
    );

    expect(outcome.decision).toBe("human_needed");
    expect(openProposals(db, { now: NOW + TTL_MS + 1 })[0].expired).toBe(false);
  });
});

describe("sweepOrphanedNonRunProposals", () => {
  test("expires an orphaned row and leaves a still-parked row open", () => {
    const db = openDb(":memory:");
    const plan = (eventId) => {
      const admitted = admitEvent(
        db,
        registry,
        envelope({ eventId, type: "totally.unknown.type" }),
        { now: NOW },
      );
      return planEvent(
        db,
        registry,
        { source: admitted.event.source, eventId: admitted.event.event_id },
        { now: NOW },
      );
    };
    const orphaned = plan("orphaned-park");
    const parked = plan("still-parked");
    db.query(
      "UPDATE events SET status = 'admitted' WHERE source = ? AND event_id = ?",
    ).run(orphaned.proposal.event_source, orphaned.proposal.event_id);

    expect(sweepOrphanedNonRunProposals(db, { now: NOW + 1_000 })).toBe(1);
    expect(getProposal(db, orphaned.proposal.id)).toMatchObject({
      status: "expired",
      decided_by: "serve",
      reason: "event_moved_on",
      decided_at: new Date(NOW + 1_000).toISOString(),
    });
    expect(getProposal(db, parked.proposal.id).status).toBe("open");
  });
});

describe("approveProposal within TTL", () => {
  test("transitions the run PROPOSED → APPROVED → QUEUED and marks the proposal approved", () => {
    const { db, proposal, runId } = planned();
    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW + 60_000,
      policyVersion: "git:test",
    });
    expect(result).toEqual({ approved: true, runId });
    expect(runState(db, runId)).toBe("QUEUED");

    const row = getProposal(db, proposal.id);
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("operator");
    expect(row.decided_at).toBe(new Date(NOW + 60_000).toISOString());

    const journal = lifecycleOf(db, runId);
    expect(journal.map((e) => e.to_state)).toEqual([
      "PROPOSED",
      "APPROVED",
      "QUEUED",
    ]);
    expect(journal[1].actor).toBe("operator");
    expect(journal[1].correlation_id).toBe("workflow-01");
    expect(journal.at(-1).reason).toBe("approved");
  });

  test("re-plans a stale registry version, then queues the refreshed spec when only its versions changed", () => {
    const { db, proposal, runId } = planned({}, { policyVersion: "new" });
    const staleSpec = {
      ...getProposal(db, proposal.id).spec,
      promptVersion: "old",
      policyVersion: "new",
    };
    const staleJson = canonicalJson(staleSpec);
    const staleHash = hashJson(staleSpec);
    db.query(
      `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
    ).run(staleJson, staleHash, proposal.id);
    db.query(
      `UPDATE runs SET spec_json = ?, spec_hash = ? WHERE run_id = ?`,
    ).run(staleJson, staleHash, runId);

    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW + 1000,
      policyVersion: "new",
    });

    expect(result).toEqual({ approved: true, runId });
    expect(runState(db, runId)).toBe("QUEUED");
    expect(lifecycleOf(db, runId).at(-1).reason).toBe(
      "approved_after_registry_replan",
    );
    for (const specJson of [
      db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(runId)
        .spec_json,
      getProposal(db, proposal.id).spec_json,
    ]) {
      expect(JSON.parse(specJson)).toMatchObject({
        promptVersion: "new",
        policyVersion: "new",
      });
    }
    expect(
      claimNext(db, {
        owner: "fresh-worker",
        now: NOW + 2000,
        policyVersion: "new",
        registryVersion: "new",
      })?.runId,
    ).toBe(runId);
  });

  test("supersedes a stale registry version when re-planning changes another field", () => {
    const { db, proposal, runId } = planned({}, { policyVersion: "new" });
    const staleSpec = {
      ...getProposal(db, proposal.id).spec,
      promptVersion: "new",
      policyVersion: "old",
    };
    const staleJson = canonicalJson(staleSpec);
    const staleHash = hashJson(staleSpec);
    db.query(
      `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
    ).run(staleJson, staleHash, proposal.id);
    db.query(
      `UPDATE runs SET spec_json = ?, spec_hash = ? WHERE run_id = ?`,
    ).run(staleJson, staleHash, runId);

    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW + 1000,
      policyVersion: "new",
      adapterOverride: "claude",
    });

    expect(result).toMatchObject({ approved: false, replanned: true });
    expect(result.proposal).toMatchObject({
      status: "open",
      reason: "replanned_after_registry_replan",
      spec: { promptVersion: "new", policyVersion: "new", adapter: "claude" },
    });
    expect(getProposal(db, proposal.id)).toMatchObject({
      status: "superseded",
      reason: "superseded_by_registry_replan",
    });
    expect(runState(db, runId)).toBe("PROPOSED");
  });

  test.each([
    ["omitted", undefined],
    ["unknown", "unknown"],
  ])(
    "a version-pinned spec is replanned when policyVersion is %s, not approved as-is",
    (_label, policyVersion) => {
      const { db, proposal, runId } = planned();
      const recorded = getProposal(db, proposal.id).spec;
      expect(recorded.promptVersion).toBe("git:test");
      expect(recorded.policyVersion).toBe("git:test");

      const result = approveProposal(db, registry, proposal.id, {
        actor: "operator",
        now: NOW + 1000,
        ...(policyVersion === undefined ? {} : { policyVersion }),
      });

      expect(result).toMatchObject({ approved: false, replanned: true });
      expect(result.proposal.id).not.toBe(proposal.id);
      expect(result.proposal.status).toBe("open");
      expect(result.proposal.reason).toBe("replanned_after_registry_replan");
      expect(getProposal(db, proposal.id)).toMatchObject({
        status: "superseded",
        reason: "superseded_by_registry_replan",
      });
      expect(runState(db, runId)).toBe("PROPOSED");
      expect(
        JSON.parse(
          db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(runId)
            .spec_json,
        ),
      ).not.toMatchObject({
        promptVersion: "git:test",
        policyVersion: "git:test",
      });
    },
  );

  test.each([
    ["omitted", undefined],
    ["unknown", "unknown"],
  ])(
    "a spec without version pins remains approvable when policyVersion is %s",
    (_label, policyVersion) => {
      const { db, proposal, runId } = planned();
      const recorded = getProposal(db, proposal.id).spec;
      const legacySpec = { ...recorded };
      delete legacySpec.promptVersion;
      delete legacySpec.policyVersion;
      const legacyJson = canonicalJson(legacySpec);
      const legacyHash = hashJson(legacySpec);
      db.query(
        `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
      ).run(legacyJson, legacyHash, proposal.id);
      db.query(
        `UPDATE runs SET spec_json = ?, spec_hash = ? WHERE run_id = ?`,
      ).run(legacyJson, legacyHash, runId);

      const result = approveProposal(db, registry, proposal.id, {
        actor: "operator",
        now: NOW + 1000,
        ...(policyVersion === undefined ? {} : { policyVersion }),
      });

      expect(result).toEqual({ approved: true, runId });
      expect(runState(db, runId)).toBe("QUEUED");
      expect(getProposal(db, proposal.id).status).toBe("approved");
      expect(lifecycleOf(db, runId).at(-1).reason).toBe("approved");
      expect(
        JSON.parse(
          db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(runId)
            .spec_json,
        ),
      ).toEqual(legacySpec);
    },
  );

  test("a registry defHash change supersedes and creates one fresh open proposal", () => {
    const { db, proposal, runId } = planned();
    const stored = getProposal(db, proposal.id);
    const pinnedSpec = {
      ...stored.spec,
      defHash: computeDefHash(registry.agents.get(stored.spec.agent)),
    };
    const pinnedJson = canonicalJson(pinnedSpec);
    const pinnedHash = hashJson(pinnedSpec);
    db.query(
      `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
    ).run(pinnedJson, pinnedHash, proposal.id);
    db.query(
      `UPDATE runs SET spec_json = ?, spec_hash = ? WHERE run_id = ?`,
    ).run(pinnedJson, pinnedHash, runId);
    const agents = new Map(registry.agents);
    const previous = agents.get(pinnedSpec.agent);
    agents.set(pinnedSpec.agent, {
      ...previous,
      description: `${previous.description ?? ""} reloaded`,
    });
    const current = { ...registry, agents };

    const result = approveProposal(db, current, proposal.id, {
      actor: "operator",
      now: NOW + 1000,
      policyVersion: "git:test",
    });
    expect(result).toMatchObject({
      approved: false,
      replanned: true,
      registryReloaded: true,
    });
    expect(result.proposal.id).not.toBe(proposal.id);
    expect(result.proposal.reason).toBe("replanned_after_registry_reload");
    expect(getProposal(db, proposal.id)).toMatchObject({
      status: "superseded",
      reason: "superseded_by_registry_reload",
    });
    expect(openProposals(db, { now: NOW + 1000 })).toHaveLength(1);
    expect(runState(db, runId)).toBe("PROPOSED");
  });

  test("only open 'run' proposals are approvable", () => {
    const { db, proposal } = planned();
    approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW,
      policyVersion: "git:test",
    });
    expect(() =>
      approveProposal(db, registry, proposal.id, {
        actor: "operator",
        now: NOW,
        policyVersion: "git:test",
      }),
    ).toThrow(/not open/);
    expect(() =>
      approveProposal(db, registry, "prop_nope", {
        actor: "operator",
        now: NOW,
      }),
    ).toThrow(/unknown proposal/);
  });
});

describe("rejectProposal", () => {
  test("marks the proposal rejected and cancels the PROPOSED run", () => {
    const { db, proposal, runId } = planned();
    const result = rejectProposal(db, proposal.id, {
      actor: "operator",
      reason: "not today",
      now: NOW + 1000,
    });
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
    expect(
      closeOpenProposalForRun(db, runId, { actor: "operator", now: later }),
    ).toEqual({ closed: true, id: proposal.id });
    const row = getProposal(db, proposal.id);
    expect(row.status).toBe("rejected");
    expect(row.reason).toBe("run_cancelled");
    expect(row.decided_by).toBe("operator");
    expect(row.decided_at).toBe(new Date(later).toISOString());
    expect(openProposals(db, { now: later })).toHaveLength(0);
  });

  test("no-op when the run has no open proposal", () => {
    const { db, proposal, runId } = planned();
    approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW,
      policyVersion: "git:test",
    });
    expect(
      closeOpenProposalForRun(db, runId, { actor: "operator", now: NOW }),
    ).toEqual({ closed: false });
    expect(getProposal(db, proposal.id).status).toBe("approved");
    expect(
      closeOpenProposalForRun(db, "run_missing", {
        actor: "operator",
        now: NOW,
      }),
    ).toEqual({ closed: false });
  });

  test("leaves every proposal untouched when more than one is open for the run", () => {
    const { db, proposal, runId } = planned();
    expect(ambiguousOpenProposalRuns(db)).toEqual([]);
    const at = new Date(NOW).toISOString();
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', ?, 1800)`,
    ).run("prop_extra", proposal.event_source, proposal.event_id, runId, at);
    expect(
      closeOpenProposalForRun(db, runId, { actor: "operator", now: NOW }),
    ).toEqual({ closed: false, ambiguous: true, count: 2 });
    expect(getProposal(db, proposal.id).status).toBe("open");
    expect(getProposal(db, "prop_extra").status).toBe("open");
    expect(ambiguousOpenProposalRuns(db)).toEqual([{ runId, count: 2 }]);
  });
});

describe("ambiguousOpenProposalRuns", () => {
  test("two open human_needed proposals with NULL run_id are not reported as ambiguous", () => {
    const db = openDb(":memory:");
    for (const eventId of ["hn-null-1", "hn-null-2"]) {
      const admitted = admitEvent(
        db,
        registry,
        envelope({ eventId, type: "totally.unknown.type" }),
        { now: NOW },
      );
      expect(admitted.admitted).toBe(true);
      const outcome = planEvent(
        db,
        registry,
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
  test("dispatch-shaped plan preserves its authorization, model, and generation key across TTL", () => {
    const { db, proposal, runId } = dispatchPlanned();
    const originalSpec = JSON.parse(proposal.spec_json);
    expect(originalSpec.approvalPolicy).toBeTruthy();
    expect(originalSpec.modelTier).toBe("light");
    expect(originalSpec.model).toBeTruthy();
    expect(originalSpec.configSnapshot).toEqual({
      root: "/policy/snapshot",
      repos: [{ name: "factory", base: "develop" }],
    });
    expect(originalSpec.idempotencyKey).toContain("#");

    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW + TTL_MS + 1,
      policyVersion: "git:test",
    });
    expect(result).toEqual({ approved: true, runId });
    expect(getProposal(db, proposal.id).status).toBe("approved");
    expect(runState(db, runId)).toBe("QUEUED");
    expect(
      JSON.parse(
        db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(runId)
          .spec_json,
      ),
    ).toEqual(originalSpec);
    expect(lifecycleOf(db, runId).at(-1).reason).toBe(
      "approved_after_ttl_replan",
    );
  });

  test("changed registry supersedes while retaining dispatch authorization and generation key", () => {
    const { db, proposal, runId } = dispatchPlanned();
    const originalSpec = JSON.parse(proposal.spec_json);
    const changedRegistry = {
      ...registry,
      agents: new Map(registry.agents),
    };
    changedRegistry.agents.set("dispatch@1", {
      ...changedRegistry.agents.get("dispatch@1"),
      limits: { timeout_seconds: 5401, attempts: 1, budget_usd: 15 },
    });

    const result = approveProposal(db, changedRegistry, proposal.id, {
      actor: "operator",
      now: NOW + TTL_MS + 1,
      policyVersion: "git:test",
    });
    expect(result).toMatchObject({ approved: false, replanned: true });
    expect(getProposal(db, proposal.id).status).toBe("superseded");
    expect(runState(db, runId)).toBe("PROPOSED");

    const freshSpec = result.proposal.spec;
    expect(freshSpec.timeoutSeconds).toBe(5401);
    expect(freshSpec.approvalPolicy).toEqual(originalSpec.approvalPolicy);
    expect(freshSpec.modelTier).toBe(originalSpec.modelTier);
    expect(freshSpec.model).toBe(originalSpec.model);
    expect(freshSpec.configSnapshot).toEqual(originalSpec.configSnapshot);
    expect(freshSpec.idempotencyKey).toBe(originalSpec.idempotencyKey);
    expect(
      JSON.parse(
        db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(runId)
          .spec_json,
      ),
    ).toEqual(freshSpec);
  });

  test("unchanged conditions: re-plan matches, run is approved with a replan reason", () => {
    const { db, proposal, runId } = planned();
    const later = NOW + TTL_MS + 1;
    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: later,
      policyVersion: "git:test",
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
      actor: "operator",
      now: later,
      policyVersion: "git:test",
      adapterOverride: "claude",
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
      actor: "operator",
      now: later + 1000,
      policyVersion: "git:test",
      adapterOverride: "claude",
    });
    expect(approved).toEqual({ approved: true, runId });
    expect(runState(db, runId)).toBe("QUEUED");
  });

  test("re-resolves a carried model through the fresh adapter after TTL expiry", () => {
    const { db, proposal, runId } = dispatchPlanned();
    const staleSpec = {
      ...getProposal(db, proposal.id).spec,
      adapter: "pi",
      model: "openai-codex/gpt-5.6-luna",
    };
    const staleJson = canonicalJson(staleSpec);
    const staleHash = hashJson(staleSpec);
    db.query(
      `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
    ).run(staleJson, staleHash, proposal.id);
    db.query(
      `UPDATE runs SET spec_json = ?, spec_hash = ? WHERE run_id = ?`,
    ).run(staleJson, staleHash, runId);

    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW + TTL_MS + 1,
      policyVersion: "git:test",
    });

    expect(result).toMatchObject({ approved: false, replanned: true });
    expect(result.proposal.spec).toMatchObject({
      adapter: "cursor",
      modelTier: "light",
      model: "cursor-grok-4.6-low-fast",
    });
  });

  test("refuses an invalid stored adapter/model pair before queueing", () => {
    const { db, proposal, runId } = dispatchPlanned();
    const invalidSpec = {
      ...getProposal(db, proposal.id).spec,
      model: "openai-codex/gpt-5.6-terra",
    };
    const invalidJson = canonicalJson(invalidSpec);
    const invalidHash = hashJson(invalidSpec);
    db.query(
      `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
    ).run(invalidJson, invalidHash, proposal.id);
    db.query(
      `UPDATE runs SET spec_json = ?, spec_hash = ? WHERE run_id = ?`,
    ).run(invalidJson, invalidHash, runId);

    try {
      approveProposal(db, registry, proposal.id, {
        actor: "operator",
        now: NOW + 1,
        policyVersion: "git:test",
      });
      throw new Error("expected approval to refuse the invalid model");
    } catch (err) {
      expect(err.code).toBe("model_adapter_mismatch");
    }
    expect(runState(db, runId)).toBe("PROPOSED");
    expect(getProposal(db, proposal.id).status).toBe("open");
  });
});

describe("approveProposal adapter/model consistency (gh-1704)", () => {
  const DISPATCH = "factory.dispatch.requested";
  /** The registry with the dispatch route flipped to another adapter. */
  function routedTo(adapter) {
    return {
      ...registry,
      eventTypes: {
        ...registry.eventTypes,
        [DISPATCH]: { ...registry.eventTypes[DISPATCH], adapter },
      },
    };
  }
  function storeSpec(db, proposal, runId, spec) {
    const json = canonicalJson(spec);
    const hash = hashJson(spec);
    db.query(
      `UPDATE proposals SET spec_json = ?, spec_hash = ? WHERE id = ?`,
    ).run(json, hash, proposal.id);
    db.query(
      `UPDATE runs SET spec_json = ?, spec_hash = ? WHERE run_id = ?`,
    ).run(json, hash, runId);
  }

  test("within TTL, a consistent recorded pair is approved as-is even after the route flips adapter", () => {
    const { db, proposal, runId } = dispatchPlanned();
    const recorded = getProposal(db, proposal.id).spec;
    expect(recorded).toMatchObject({
      adapter: "cursor",
      model: "cursor-grok-4.6-low-fast",
    });

    const result = approveProposal(db, routedTo("pi"), proposal.id, {
      actor: "operator",
      now: NOW + 1,
      policyVersion: "git:test",
    });

    expect(result).toEqual({ approved: true, runId });
    expect(runState(db, runId)).toBe("QUEUED");
    expect(
      JSON.parse(
        db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(runId)
          .spec_json,
      ),
    ).toMatchObject({ adapter: "cursor", model: "cursor-grok-4.6-low-fast" });
  });

  test("within TTL, the recorded model is checked against the recorded adapter, not the flipped route", () => {
    const { db, proposal, runId } = dispatchPlanned();
    // cursor spec carrying pi's light model: consistent with the *route*
    // (now pi), inconsistent with the adapter the spec will execute on.
    storeSpec(db, proposal, runId, {
      ...getProposal(db, proposal.id).spec,
      model: "openai-codex/gpt-5.6-luna",
    });

    expect(() =>
      approveProposal(db, routedTo("pi"), proposal.id, {
        actor: "operator",
        now: NOW + 1,
        policyVersion: "git:test",
      }),
    ).toThrow(expect.objectContaining({ code: "model_adapter_mismatch" }));
    expect(runState(db, runId)).toBe("PROPOSED");
    expect(getProposal(db, proposal.id).status).toBe("open");
  });

  test("a registry-version refresh re-resolves a carried model through the fresh adapter", () => {
    const { db, proposal, runId } = dispatchPlanned();
    storeSpec(db, proposal, runId, {
      ...getProposal(db, proposal.id).spec,
      promptVersion: "old",
      policyVersion: "old",
      adapter: "pi",
      model: "openai-codex/gpt-5.6-luna",
    });

    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW + 1,
      policyVersion: "git:test",
    });

    expect(result).toMatchObject({ approved: false, replanned: true });
    expect(result.proposal.spec).toMatchObject({
      adapter: "cursor",
      modelTier: "light",
      model: "cursor-grok-4.6-low-fast",
      promptVersion: "git:test",
      policyVersion: "git:test",
    });
    expect(getProposal(db, proposal.id).status).toBe("superseded");
    expect(runState(db, runId)).toBe("PROPOSED");
  });

  test("a registry-version refresh keeps a still-consistent model and queues the refreshed spec", () => {
    const { db, proposal, runId } = dispatchPlanned();
    storeSpec(db, proposal, runId, {
      ...getProposal(db, proposal.id).spec,
      promptVersion: "old",
    });

    const result = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      now: NOW + 1,
      policyVersion: "git:test",
    });

    expect(result).toEqual({ approved: true, runId });
    expect(lifecycleOf(db, runId).at(-1).reason).toBe(
      "approved_after_registry_replan",
    );
    expect(
      JSON.parse(
        db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(runId)
          .spec_json,
      ),
    ).toMatchObject({
      adapter: "cursor",
      model: "cursor-grok-4.6-low-fast",
      promptVersion: "git:test",
    });
  });

  test("an explicit definition model pin outside the tier map survives the re-plan instead of being refused", () => {
    const { db, proposal, runId } = dispatchPlanned();
    const pinned = {
      ...registry,
      agents: new Map(registry.agents),
    };
    pinned.agents.set("dispatch@1", {
      ...registry.agents.get("dispatch@1"),
      model: "claude-opus-4-1",
    });
    // The stored pi pin is dropped by the adapter change, so the fresh spec
    // takes the definition's own pin — a value in no adapter's tier map.
    storeSpec(db, proposal, runId, {
      ...getProposal(db, proposal.id).spec,
      adapter: "pi",
      model: "openai-codex/gpt-5.6-luna",
    });

    const result = approveProposal(db, pinned, proposal.id, {
      actor: "operator",
      now: NOW + TTL_MS + 1,
      policyVersion: "git:test",
    });

    expect(result).toMatchObject({ approved: false, replanned: true });
    expect(result.proposal.spec).toMatchObject({
      adapter: "cursor",
      modelTier: "light",
      model: "claude-opus-4-1",
    });
    expect(runState(db, runId)).toBe("PROPOSED");
  });
});
