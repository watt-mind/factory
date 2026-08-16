import { describe, expect, test } from "bun:test";

import {
  autoApproveChains,
  chainRuntimeGuard,
  CHAIN_AUTO_APPROVAL_ACTOR,
  CHAIN_AUTO_APPROVAL_EVENT_TYPES,
  CHAIN_AUTO_APPROVAL_REASON,
  loadChainAutoApprovalPolicy,
} from "./auto-approval.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { lifecycleOf, runState } from "./lifecycle.mjs";
import { openProposals } from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const now = Date.parse("2026-08-19T12:00:00.000Z");
const policy = {
  allowed: new Set(CHAIN_AUTO_APPROVAL_EVENT_TYPES),
  reason: null,
};

function seed(
  db,
  {
    id = "proposal-1",
    runId = `run-${id}`,
    type = "factory.work.requested",
    source = "chain",
    input = { repo: "factory" },
    proposalSpec = null,
    runSpec = null,
    approvalPolicy = null,
  } = {},
) {
  const mapping = registry.eventTypes[type];
  const eventId = `event-${id}`;
  const envelope = {
    schemaVersion: "factory.event/v1",
    eventId,
    type,
    source,
    subject: input.ticket ?? input.repo,
    occurredAt: new Date(now).toISOString(),
    receivedAt: new Date(now).toISOString(),
    correlationId: `corr-${id}`,
    causationId: "parent-run",
    payload: input,
  };
  const defaultApprovalPolicy =
    approvalPolicy ??
    (source === "chain"
      ? {
          source: "chain",
          mode: CHAIN_AUTO_APPROVAL_EVENT_TYPES.has(type) ? "auto" : "watched",
          eventType: type,
          ...(CHAIN_AUTO_APPROVAL_EVENT_TYPES.has(type)
            ? {
                ...(type === "factory.dispatch.requested"
                  ? {
                      dispatchEvidence: {
                        ticket: { labels: [] },
                        escalatePathIntersections: [],
                      },
                    }
                  : {}),
              }
            : { reason: "not_allowlisted" }),
        }
      : null);
  const spec = {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: mapping.agent,
    input,
    ...(defaultApprovalPolicy ? { approvalPolicy: defaultApprovalPolicy } : {}),
    ...(runSpec ?? {}),
  };
  const proposalJson = canonicalJson(proposalSpec ?? spec);
  const runJson = canonicalJson(runSpec ?? spec);
  const proposalHash = hashJson(proposalSpec ?? spec);
  const runHash = hashJson(runSpec ?? spec);
  const createdAt = new Date(now).toISOString();

  db.query(
    `INSERT INTO events
       (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
  ).run(
    source,
    eventId,
    type,
    envelope.subject,
    createdAt,
    createdAt,
    envelope.correlationId,
    envelope.causationId,
    canonicalJson(envelope),
    hashJson(input),
    createdAt,
  );
  db.query(
    `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PROPOSED', 0, ?, ?)`,
  ).run(runId, `idem-${id}`, runJson, runHash, createdAt, createdAt);
  db.query(
    `INSERT INTO proposals
       (id, event_source, event_id, run_id, decision, spec_json, spec_hash, idempotency_key, status, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, 'run', ?, ?, ?, 'open', ?, 1800)`,
  ).run(
    id,
    source,
    eventId,
    runId,
    proposalJson,
    proposalHash,
    `idem-${id}`,
    createdAt,
  );
  return { id, runId };
}

const dispatchOk = () => ({
  ok: true,
  evidence: { ticket: { labels: [] }, escalatePathIntersections: [] },
});
const auto = (db, options = {}) =>
  autoApproveChains(db, registry, {
    now,
    policy,
    dispatchEligibility: dispatchOk,
    ...options,
  });

describe("chain auto approval (WM-357)", () => {
  test("git-owned policy is an explicit closed allowlist", () => {
    const loaded = loadChainAutoApprovalPolicy();
    expect([...loaded.allowed].sort()).toEqual(
      [...CHAIN_AUTO_APPROVAL_EVENT_TYPES].sort(),
    );
    expect(loaded.reason).toBeNull();
  });

  test("budget, worker cap, and circuit breaker each stop unattended approvals", () => {
    const runtimePolicy = {
      budget: { per_day_usd: 1 },
      workers: { max: 1 },
      circuit_breaker: { consecutive_env_failures: 2 },
    };

    const budgetDb = openDb(":memory:");
    expect(
      chainRuntimeGuard(budgetDb, {
        runtimePolicy,
        budgetCheck: () => "spent",
      }),
    ).toBe("budget_exhausted");

    const capDb = openDb(":memory:");
    const cap = seed(capDb, { id: "cap-active" });
    capDb
      .query(`UPDATE runs SET state = 'QUEUED' WHERE run_id = ?`)
      .run(cap.runId);
    expect(
      chainRuntimeGuard(capDb, {
        runtimePolicy,
        budgetCheck: () => null,
      }),
    ).toBe("worker_cap_full");

    const circuitDb = openDb(":memory:");
    for (const id of ["env-1", "env-2"]) {
      const failed = seed(circuitDb, { id });
      circuitDb
        .query(`UPDATE runs SET state = 'FAILED', attempts = 1 WHERE run_id = ?`)
        .run(failed.runId);
      circuitDb
        .query(
          `INSERT INTO attempts
             (run_id, attempt, fencing_token, lease_owner, lease_expires_at,
              finished_at, terminal_state, reason_code)
           VALUES (?, 1, 1, 'test', ?, ?, 'FAILED', 'adapter_error')`,
        )
        .run(
          failed.runId,
          new Date(now).toISOString(),
          new Date(now).toISOString(),
        );
    }
    expect(
      chainRuntimeGuard(circuitDb, {
        runtimePolicy: { ...runtimePolicy, workers: { max: 3 } },
        budgetCheck: () => null,
      }),
    ).toBe("circuit_breaker_tripped");

    const guardedDb = openDb(":memory:");
    const candidate = seed(guardedDb, { id: "guarded" });
    const result = auto(guardedDb, {
      runtimeGuard: () => "circuit_breaker_tripped",
    });
    expect(result.approved).toEqual([]);
    expect(runState(guardedDb, candidate.runId)).toBe("PROPOSED");
    expect(openProposals(guardedDb, {})[0].reason).toContain(
      "circuit_breaker_tripped",
    );
  });

  test("eligible chain work and triage proposals advance with an auditable actor and reason", () => {
    const db = openDb(":memory:");
    const work = seed(db, { id: "work", type: "factory.work.requested" });
    const triage = seed(db, { id: "triage", type: "factory.triage.requested" });

    expect(
      auto(db)
        .approved.map((row) => row.runId)
        .sort(),
    ).toEqual([work.runId, triage.runId].sort());
    for (const runId of [work.runId, triage.runId]) {
      expect(runState(db, runId)).toBe("QUEUED");
      const approved = lifecycleOf(db, runId).find(
        (event) => event.to_state === "APPROVED",
      );
      expect(approved).toMatchObject({
        actor: CHAIN_AUTO_APPROVAL_ACTOR,
        reason: CHAIN_AUTO_APPROVAL_REASON,
      });
    }
  });

  test("the planner's bounded pass advances a newly planned chain proposal", () => {
    const db = openDb(":memory:");
    const synthetic = {
      ...registry,
      agents: new Map(registry.agents),
      eventTypes: { ...registry.eventTypes },
    };
    synthetic.agents.set("test-chain-work@1", {
      ref: "test-chain-work@1",
      output_contract: "factory.test/v1",
      workspace: { type: "ephemeral" },
      capabilities: { services: [] },
      limits: { timeout_seconds: 60, attempts: 1 },
      inputSchema: {
        type: "object",
        required: ["repo"],
        additionalProperties: false,
        properties: { repo: { type: "string" } },
      },
      mutating: false,
    });
    synthetic.eventTypes["factory.work.requested"] = {
      ...synthetic.eventTypes["factory.work.requested"],
      agent: "test-chain-work@1",
    };
    const event = admitEvent(
      db,
      synthetic,
      {
        schemaVersion: "factory.event/v1",
        eventId: "chain-planner-pass",
        type: "factory.work.requested",
        source: "chain",
        subject: "factory",
        occurredAt: new Date(now).toISOString(),
        correlationId: "chain-planner-pass",
        causationId: "parent-run",
        payload: { repo: "factory" },
      },
      { now },
    );

    expect(event.admitted).toBe(true);
    planAdmittedEvents(db, synthetic, { now, policyVersion: "git:test" });
    expect(openProposals(db, {})).toEqual([]);
    expect(db.query(`SELECT state FROM runs`).get().state).toBe("QUEUED");
  });

  test("operator proposals and protected or incomplete merge/ship proposals remain watched", () => {
    const db = openDb(":memory:");
    const manual = seed(db, { id: "manual", source: "operator" });
    const merge = seed(db, {
      id: "merge",
      type: "factory.merge-apply.requested",
    });
    const ship = seed(db, { id: "ship", type: "factory.ship-apply.requested" });

    const result = auto(db, {
      policy: {
        allowed: new Set([
          "factory.merge-apply.requested",
          "factory.ship-apply.requested",
        ]),
        reason: null,
      },
    });
    expect(result.approved).toEqual([]);
    expect(
      openProposals(db, {})
        .map((proposal) => proposal.id)
        .sort(),
    ).toEqual([manual.id, merge.id, ship.id].sort());
    expect(
      openProposals(db, {}).find((proposal) => proposal.id === merge.id).reason,
    ).toContain("merge_owner_not_allowed");
  });

  test("closed triage apply is approved, while unknown actions remain visible and watched", () => {
    const db = openDb(":memory:");
    const valid = seed(db, {
      id: "triage-valid",
      type: "factory.triage-apply.requested",
      input: {
        repo: "factory",
        plan: [{ issueId: "WM-9", action: "label-agent-ready" }],
      },
    });
    const invalid = seed(db, {
      id: "triage-invalid",
      type: "factory.triage-apply.requested",
      input: {
        repo: "factory",
        plan: [{ issueId: "WM-10", action: "rm-everything" }],
      },
    });

    expect(auto(db).approved.map((row) => row.runId)).toEqual([valid.runId]);
    expect(runState(db, invalid.runId)).toBe("PROPOSED");
    expect(
      openProposals(db, {}).find((proposal) => proposal.id === invalid.id)
        .reason,
    ).toContain("input_schema_invalid");
  });

  test("dispatch rechecks escalated and path-sensitive tickets before approval", () => {
    const db = openDb(":memory:");
    const escalated = seed(db, {
      id: "escalated",
      type: "factory.dispatch.requested",
      input: { repo: "factory", ticket: "WM-11" },
      approvalPolicy: {
        source: "chain",
        mode: "auto",
        eventType: "factory.dispatch.requested",
        dispatchEvidence: {
          ticket: { labels: ["ai:agent-ready", "ai:escalated"] },
          escalatePathIntersections: [],
        },
      },
    });
    const sensitive = seed(db, {
      id: "sensitive",
      type: "factory.dispatch.requested",
      input: { repo: "factory", ticket: "WM-12" },
      approvalPolicy: {
        source: "chain",
        mode: "auto",
        eventType: "factory.dispatch.requested",
        dispatchEvidence: {
          ticket: { labels: ["ai:agent-ready"] },
          escalatePathIntersections: ["src/auth/**"],
        },
      },
    });
    const dispatchEligibility = (payload) =>
      payload.ticket === "WM-11"
        ? {
            ok: true,
            evidence: {
              ticket: { labels: ["ai:agent-ready", "ai:escalated"] },
              escalatePathIntersections: [],
            },
          }
        : {
            ok: true,
            evidence: {
              ticket: { labels: ["ai:agent-ready"] },
              escalatePathIntersections: ["src/auth/**"],
            },
          };

    expect(auto(db, { dispatchEligibility }).approved).toEqual([]);
    expect(runState(db, escalated.runId)).toBe("PROPOSED");
    expect(runState(db, sensitive.runId)).toBe("PROPOSED");
    const reasons = openProposals(db, {})
      .map((proposal) => proposal.reason)
      .join(" ");
    expect(reasons).toContain("escalated_or_security");
    expect(reasons).toContain("escalate_paths_intersect");
  });

  test("a tampered proposal fails closed and duplicate passes do not double-approve", () => {
    const db = openDb(":memory:");
    const safe = seed(db, { id: "safe" });
    const tampered = seed(db, {
      id: "tampered",
      proposalSpec: {
        schemaVersion: "factory.run-spec/v1",
        runId: "run-tampered",
        agent: "work-scan@1",
        input: { repo: "other" },
      },
    });

    expect(auto(db).approved.map((row) => row.runId)).toEqual([safe.runId]);
    expect(auto(db).approved).toEqual([]);
    expect(runState(db, tampered.runId)).toBe("PROPOSED");
    expect(
      openProposals(db, {}).find((proposal) => proposal.id === tampered.id)
        .reason,
    ).toContain("proposal_run_spec_mismatch");
  });
});
