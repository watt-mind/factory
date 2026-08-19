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
import { createHookRegistry, hookDecisionsFor } from "./hooks.mjs";
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
    trustedPredecessor = source === "chain",
    predecessorAgent = null,
    predecessorRecommendation = null,
    predecessorArtifact = null,
    predecessorInput = input,
    parentRunId = `parent-${id}`,
    seedPredecessor = true,
    timeoutSeconds = 600,
  } = {},
) {
  const mapping = registry.eventTypes[type];
  const eventId = `event-${id}`;
  const predecessor = Object.entries(registry.edges)
    .flatMap(([agent, rule]) =>
      Object.entries(rule.edges).map(([recommendation, edge]) => ({
        agent,
        rule,
        recommendation,
        edge,
      })),
    )
    .find((entry) => entry.edge.eventType === type);
  if (trustedPredecessor && seedPredecessor) {
    if (!predecessor && !predecessorAgent)
      throw new Error(`test fixture has no registered predecessor for ${type}`);
    const parentEventId = `parent-event-${id}`;
    const parentAgent = predecessorAgent ?? predecessor.agent;
    const parentRule = registry.edges[parentAgent];
    const parentSpec = { agent: parentAgent, input: predecessorInput };
    const parentResult = {
      artifact:
        predecessorArtifact ??
        (parentRule
          ? {
              [parentRule.recommendationField]:
                predecessorRecommendation ?? predecessor.recommendation,
            }
          : {}),
    };
    const at = new Date(now).toISOString();
    db.query(
      `INSERT INTO events
         (source,event_id,type,subject,occurred_at,received_at,correlation_id,envelope_json,payload_hash,status,admitted_at)
       VALUES ('operator',?,'test.parent','test',?,?,?,?,'hash','planned',?)`,
    ).run(
      parentEventId,
      at,
      at,
      parentEventId,
      canonicalJson({ payload: input }),
      at,
    );
    db.query(
      `INSERT INTO runs
         (run_id,idempotency_key,spec_json,spec_hash,state,attempts,created_at,updated_at)
       VALUES (?,?,?,'hash','COMPLETED',1,?,?)`,
    ).run(parentRunId, `parent-idem-${id}`, canonicalJson(parentSpec), at, at);
    db.query(
      `INSERT INTO proposals
         (id,event_source,event_id,run_id,decision,spec_json,status,created_at,ttl_seconds)
       VALUES (?,'operator',?,?,'run',?,'approved',?,1800)`,
    ).run(
      `parent-proposal-${id}`,
      parentEventId,
      parentRunId,
      canonicalJson(parentSpec),
      at,
    );
    db.query(
      `INSERT INTO results
         (run_id,attempt,result_json,artifact_hash,verification_json,receipt_json,accepted_at)
       VALUES (?,1,?,'hash','{}','{}',?)`,
    ).run(parentRunId, canonicalJson(parentResult), at);
  }
  const envelope = {
    schemaVersion: "factory.event/v1",
    eventId,
    type,
    source,
    subject: input.ticket ?? input.repo,
    occurredAt: new Date(now).toISOString(),
    receivedAt: new Date(now).toISOString(),
    correlationId: `corr-${id}`,
    causationId: trustedPredecessor ? parentRunId : "forged-parent-run",
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
    timeoutSeconds,
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
const auto = (db, options = {}) => {
  const { approvalRegistry = registry, ...approvalOptions } = options;
  return autoApproveChains(db, approvalRegistry, {
    now,
    policy,
    dispatchEligibility: dispatchOk,
    ...approvalOptions,
  });
};

const independentMergeRegistry = ({
  independent = true,
  selectors = {},
} = {}) => {
  const mergeRule = registry.edges["merge-scan@2"];
  return {
    ...registry,
    edges: {
      ...registry.edges,
      "merge-scan@2": {
        ...mergeRule,
        independent,
        edges: Object.fromEntries(
          Object.entries(mergeRule.edges).map(([name, edge]) => [
            name,
            {
              ...edge,
              whenItemsField:
                selectors[name] ??
                { MERGE: "plan", FIX: "fix", ESCALATE: "escalate" }[name],
            },
          ]),
        ),
      },
    },
  };
};

function reviewedMergeInput({
  pr = 409,
  ticket = `WM-${pr}`,
  headSha = "a".repeat(40),
} = {}) {
  return {
    repo: "factory",
    github: "watt-mind/factory",
    base: "develop",
    deployBranch: "master",
    plan: [
      {
        pr,
        headSha,
        baseSha: "b".repeat(40),
        headRef: `feat/${ticket}`,
        ticket,
        action: "merge_pr",
        reason: "reviewed merge fixture",
        checksGreen: true,
        mergeable: true,
        ownedPathsValid: true,
        handoffValid: true,
        testsFalsifiable: true,
        policySafe: true,
        sensitive: false,
        ambiguous: false,
      },
    ],
  };
}

function seedHistoricalApply(
  db,
  { id, runId = `run-${id}`, input = reviewedMergeInput(), state },
) {
  const apply = seed(db, {
    id,
    runId,
    type: "factory.merge-apply.requested",
    input,
    predecessorArtifact: {
      recommendation: "MERGE",
      ...input,
      fix: [],
      escalate: [],
      summary: "historical merge fixture",
    },
  });
  db.query(`UPDATE runs SET state = ? WHERE run_id = ?`).run(
    state,
    apply.runId,
  );
  db.query(`UPDATE proposals SET status = 'approved' WHERE id = ?`).run(
    apply.id,
  );
  return apply;
}

function seedMergeResolution(
  db,
  {
    id,
    applyRunId = `run-${id}`,
    verifyRunId = `verify-${id}`,
    input = reviewedMergeInput(),
    verifierState = "COMPLETED",
    includeVerifier = true,
    verifierInputOverrides = {},
    proposalDecision = "run",
  },
) {
  const apply = seedHistoricalApply(db, {
    id,
    runId: applyRunId,
    input,
    state: "COMPLETED",
  });
  const item = input.plan[0];
  const landedInput = {
    repo: input.repo,
    github: input.github,
    base: input.base,
    pr: item.pr,
    ticket: item.ticket,
    headSha: item.headSha,
    headRef: item.headRef,
    mergeCommitSha: "c".repeat(40),
  };
  const eventId = `event-landed-${id}`;
  const at = new Date(now).toISOString();
  const envelope = {
    schemaVersion: "factory.event/v1",
    eventId,
    type: "factory.merge-landed",
    source: "chain",
    subject: input.repo,
    occurredAt: at,
    receivedAt: at,
    correlationId: eventId,
    causationId: apply.runId,
    payload: landedInput,
  };
  db.query(
    `INSERT INTO events
       (source,event_id,type,subject,occurred_at,received_at,correlation_id,causation_id,
        envelope_json,payload_hash,status,admitted_at)
     VALUES ('chain',?,'factory.merge-landed',?,?,?,?,?,?,'hash','planned',?)`,
  ).run(
    eventId,
    input.repo,
    at,
    at,
    eventId,
    apply.runId,
    canonicalJson(envelope),
    at,
  );
  if (!includeVerifier) return apply;

  const verifySpec = {
    schemaVersion: "factory.run-spec/v1",
    runId: verifyRunId,
    agent: "merge-verify@1",
    input: { ...landedInput, ...verifierInputOverrides },
  };
  db.query(
    `INSERT INTO runs
       (run_id,idempotency_key,spec_json,spec_hash,state,attempts,created_at,updated_at)
     VALUES (?, ?, ?, 'hash', ?, 1, ?, ?)`,
  ).run(
    verifyRunId,
    `idem-${verifyRunId}`,
    canonicalJson(verifySpec),
    verifierState,
    at,
    at,
  );
  db.query(
    `INSERT INTO proposals
       (id,event_source,event_id,run_id,decision,spec_json,spec_hash,idempotency_key,
        status,created_at,ttl_seconds)
     VALUES (?,'chain',?,?,?,?,'hash',?,'approved',?,7200)`,
  ).run(
    `proposal-${verifyRunId}`,
    eventId,
    verifyRunId,
    proposalDecision,
    canonicalJson(verifySpec),
    `idem-${verifyRunId}`,
    at,
  );
  return apply;
}

function autoMerge(db) {
  return auto(db, {
    policy: {
      ...policy,
      autoMergeBase: new Set(["develop"]),
      autoMergeOwners: new Set(["watt-mind"]),
    },
    runtimeGuard: () => null,
  });
}

describe("declared chain command edge characterization (WM-469)", () => {
  test.each([
    ["factory.merge.requested", { repo: "factory" }],
    [
      "factory.merge-landed",
      {
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 469,
        ticket: "WM-469",
        headSha: "a".repeat(40),
        headRef: "feat/WM-469",
        mergeCommitSha: "c".repeat(40),
      },
    ],
  ])("merge-apply@2 auto-approves its %s command edge", async (type, input) => {
    const db = openDb(":memory:");
    const predecessorInput = reviewedMergeInput({ pr: 469, ticket: "WM-469" });
    const candidate = seed(db, {
      id: `merge-apply-command-${type}`,
      type,
      input,
      predecessorAgent: "merge-apply@2",
      predecessorInput,
      predecessorArtifact: { outcome: "applied" },
    });

    expect((await autoMerge(db)).approved).toEqual([
      { proposalId: candidate.id, runId: candidate.runId },
    ]);
  });

  test("merge-verify@1 auto-approves factory.merge.requested when repo matches input", async () => {
    const db = openDb(":memory:");
    const candidate = seed(db, {
      id: "merge-verify-command-match",
      type: "factory.merge.requested",
      input: { repo: "factory" },
      predecessorAgent: "merge-verify@1",
      predecessorInput: { repo: "factory" },
      predecessorArtifact: { outcome: "verified" },
    });

    expect((await autoMerge(db)).approved).toEqual([
      { proposalId: candidate.id, runId: candidate.runId },
    ]);
  });

  test("merge-verify@1 repo mismatch remains chain_command_edge_payload_mismatch", async () => {
    const db = openDb(":memory:");
    const candidate = seed(db, {
      id: "merge-verify-command-mismatch",
      type: "factory.merge.requested",
      input: { repo: "other" },
      predecessorAgent: "merge-verify@1",
      predecessorInput: { repo: "factory" },
      predecessorArtifact: { outcome: "verified" },
    });

    expect((await autoMerge(db)).approved).toEqual([]);
    expect(runState(db, candidate.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_command_edge_payload_mismatch",
    );
  });
});

describe("chain auto approval (WM-357)", () => {
  test("git-owned policy is an explicit closed allowlist", async () => {
    const loaded = loadChainAutoApprovalPolicy();
    expect([...loaded.allowed].sort()).toEqual(
      [...CHAIN_AUTO_APPROVAL_EVENT_TYPES].sort(),
    );
    expect(loaded.reason).toBeNull();
  });

  test("budget, worker cap, and circuit breaker each stop unattended approvals", async () => {
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
        .query(
          `UPDATE runs SET state = 'FAILED', attempts = 1 WHERE run_id = ?`,
        )
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
    const result = await auto(guardedDb, {
      runtimeGuard: () => "circuit_breaker_tripped",
    });
    expect(result.approved).toEqual([]);
    expect(runState(guardedDb, candidate.runId)).toBe("PROPOSED");
    expect(openProposals(guardedDb, {})[0].reason).toContain(
      "circuit_breaker_tripped",
    );
  });

  test("eligible chain work and triage proposals advance with an auditable actor and reason", async () => {
    const db = openDb(":memory:");
    const work = seed(db, { id: "work", type: "factory.work.requested" });
    const triage = seed(db, {
      id: "triage",
      type: "factory.triage-apply.requested",
      input: {
        repo: "factory",
        plan: [{ issueId: "WM-10", action: "label-agent-ready" }],
      },
    });

    expect((await auto(db)).approved.map((row) => row.runId).sort()).toEqual(
      [work.runId, triage.runId].sort(),
    );
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

  test("the planner's bounded pass leaves a caller-fabricated chain proposal watched", async () => {
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
    expect(openProposals(db, {})).toHaveLength(1);
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_predecessor_or_result_missing",
    );
    expect(db.query(`SELECT state FROM runs`).get().state).toBe("PROPOSED");
  });

  test("operator proposals and protected or incomplete merge/ship proposals remain watched", async () => {
    const db = openDb(":memory:");
    const manual = seed(db, { id: "manual", source: "operator" });
    const mergeInput = {
      repo: "factory",
      github: "untrusted-owner/factory",
      base: "develop",
      deployBranch: "master",
      plan: [
        {
          pr: 430,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          headRef: "feat/WM-430",
          ticket: "WM-430",
          action: "merge_pr",
          reason: "fixture reaches repository policy",
          checksGreen: true,
          mergeable: true,
          ownedPathsValid: true,
          handoffValid: true,
          testsFalsifiable: true,
          policySafe: true,
          sensitive: false,
          ambiguous: false,
        },
      ],
    };
    const merge = seed(db, {
      id: "merge",
      type: "factory.merge-apply.requested",
      input: mergeInput,
      predecessorArtifact: {
        recommendation: "MERGE",
        ...mergeInput,
        fix: [],
        escalate: [],
        summary: "one selected merge",
      },
    });
    const ship = seed(db, { id: "ship", type: "factory.ship-apply.requested" });

    const result = await auto(db, {
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

  test("terminal merge applies never hold the barrier", async () => {
    for (const state of [
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
      "REFUSED",
      "COMPLETED",
    ]) {
      const db = openDb(":memory:");
      seedHistoricalApply(db, {
        id: `terminal-${state.toLowerCase()}`,
        state,
      });
      const input = reviewedMergeInput({ pr: 410 });
      const candidate = seed(db, {
        id: `candidate-after-${state.toLowerCase()}`,
        type: "factory.merge-apply.requested",
        input,
        predecessorArtifact: {
          recommendation: "MERGE",
          ...input,
          fix: [],
          escalate: [],
          summary: "next merge candidate",
        },
      });

      expect((await autoMerge(db)).approved).toEqual([
        { proposalId: candidate.id, runId: candidate.runId },
      ]);
      expect(runState(db, candidate.runId)).toBe("QUEUED");
    }
  });

  test("failed or missing exact verification does not clear the hold", async () => {
    for (const [id, options] of [
      ["failed", { verifierState: "FAILED" }],
      ["missing", { includeVerifier: false }],
    ]) {
      const db = openDb(":memory:");
      seedHistoricalApply(db, {
        id: `verification-hold-${id}`,
        state: "FAILED",
      });
      seedMergeResolution(db, {
        id: `verification-resolution-${id}`,
        ...options,
      });
      const nextInput = reviewedMergeInput({ pr: 410 });
      seed(db, {
        id: `verification-candidate-${id}`,
        type: "factory.merge-apply.requested",
        input: nextInput,
        predecessorArtifact: {
          recommendation: "MERGE",
          ...nextInput,
          fix: [],
          escalate: [],
          summary: "verification hold candidate",
        },
      });

      expect((await autoMerge(db)).approved).toEqual([]);
      expect(openProposals(db, {})[0].reason).toContain(
        "merge_barrier_unverified",
      );
    }
  });

  test("in-flight merge applies hold with state and age until their own timeout", async () => {
    for (const state of ["QUEUED", "LEASED", "RUNNING", "VERIFYING"]) {
      const db = openDb(":memory:");
      const active = seedHistoricalApply(db, {
        id: `active-${state.toLowerCase()}`,
        state,
      });
      db.query(`UPDATE runs SET created_at = ? WHERE run_id = ?`).run(
        new Date(now - 599_000).toISOString(),
        active.runId,
      );
      const input = reviewedMergeInput({ pr: 410 });
      const candidate = seed(db, {
        id: `candidate-during-${state.toLowerCase()}`,
        type: "factory.merge-apply.requested",
        input,
        predecessorArtifact: {
          recommendation: "MERGE",
          ...input,
          fix: [],
          escalate: [],
          summary: "active barrier candidate",
        },
      });

      expect((await autoMerge(db)).approved).toEqual([]);
      expect(openProposals(db, {})[0].reason).toContain(
        `merge_barrier_active:${active.runId}:state=${state}:age=599s`,
      );

      db.query(`UPDATE runs SET created_at = ? WHERE run_id = ?`).run(
        new Date(now - 600_000).toISOString(),
        active.runId,
      );
      expect((await autoMerge(db)).approved).toEqual([
        { proposalId: candidate.id, runId: candidate.runId },
      ]);
    }
  });

  test("active apply and unverified-landed barriers remain unchanged", async () => {
    const activeDb = openDb(":memory:");
    const active = seedHistoricalApply(activeDb, {
      id: "active-apply",
      input: reviewedMergeInput({ pr: 408 }),
      state: "RUNNING",
    });
    const activeCandidateInput = reviewedMergeInput({ pr: 410 });
    seed(activeDb, {
      id: "active-barrier-candidate",
      type: "factory.merge-apply.requested",
      input: activeCandidateInput,
      predecessorArtifact: {
        recommendation: "MERGE",
        ...activeCandidateInput,
        fix: [],
        escalate: [],
        summary: "active barrier candidate",
      },
    });
    expect((await autoMerge(activeDb)).approved).toEqual([]);
    expect(openProposals(activeDb, {})[0].reason).toContain(
      `merge_barrier_active:${active.runId}`,
    );

    const unverifiedDb = openDb(":memory:");
    seedMergeResolution(unverifiedDb, {
      id: "unverified-landing",
      includeVerifier: false,
    });
    const unverifiedCandidateInput = reviewedMergeInput({ pr: 410 });
    seed(unverifiedDb, {
      id: "unverified-barrier-candidate",
      type: "factory.merge-apply.requested",
      input: unverifiedCandidateInput,
      predecessorArtifact: {
        recommendation: "MERGE",
        ...unverifiedCandidateInput,
        fix: [],
        escalate: [],
        summary: "unverified barrier candidate",
      },
    });
    expect((await autoMerge(unverifiedDb)).approved).toEqual([]);
    expect(openProposals(unverifiedDb, {})[0].reason).toContain(
      "merge_barrier_unverified:event-landed-unverified-landing",
    );
  });

  test("closed triage apply is approved, while unknown actions remain visible and watched", async () => {
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

    expect((await auto(db)).approved.map((row) => row.runId)).toEqual([
      valid.runId,
    ]);
    expect(runState(db, invalid.runId)).toBe("PROPOSED");
    expect(
      openProposals(db, {}).find((proposal) => proposal.id === invalid.id)
        .reason,
    ).toContain("input_schema_invalid");
  });

  test("dispatch rechecks escalated and path-sensitive tickets before approval", async () => {
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

    expect((await auto(db, { dispatchEligibility })).approved).toEqual([]);
    expect(runState(db, escalated.runId)).toBe("PROPOSED");
    expect(runState(db, sensitive.runId)).toBe("PROPOSED");
    const reasons = openProposals(db, {})
      .map((proposal) => proposal.reason)
      .join(" ");
    expect(reasons).toContain("escalated_or_security");
    expect(reasons).toContain("escalate_paths_intersect");
  });

  test("a spoofed chain event without a durable registered predecessor remains watched", async () => {
    const db = openDb(":memory:");
    const spoofed = seed(db, {
      id: "spoofed",
      type: "factory.work.requested",
      trustedPredecessor: false,
    });

    expect((await auto(db)).approved).toEqual([]);
    expect(runState(db, spoofed.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_predecessor_or_result_missing",
    );
  });

  test("a mixed merge result approves every selected edge while preserving escalation", async () => {
    const db = openDb(":memory:");
    const mergeInput = {
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      deployBranch: "master",
      plan: [
        {
          pr: 431,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          headRef: "feat/WM-431",
          ticket: "WM-431",
          action: "merge_pr",
          reason: "independently selected merge",
          checksGreen: true,
          mergeable: true,
          ownedPathsValid: true,
          handoffValid: true,
          testsFalsifiable: true,
          policySafe: true,
          sensitive: false,
          ambiguous: false,
        },
      ],
    };
    const fixItem = {
      pr: 430,
      headSha: "c".repeat(40),
      baseSha: "d".repeat(40),
      headRef: "feat/WM-430",
      ticket: "WM-430",
      finding: "mechanical in-scope fix",
      findingHash: "e".repeat(64),
      round: 1,
      mechanical: true,
      withinOwnedPaths: true,
      ownedPaths: ["event-runtime/lib/chain.mjs"],
    };
    const fixInput = {
      repo: mergeInput.repo,
      github: mergeInput.github,
      base: mergeInput.base,
      ...fixItem,
    };
    const parentRunId = "parent-mixed-result";
    const predecessorArtifact = {
      recommendation: "ESCALATE",
      ...mergeInput,
      fix: [fixItem],
      escalate: [{ pr: 429, reason: "human review required" }],
      summary: "human review still required",
    };
    const merge = seed(db, {
      id: "mixed-merge",
      type: "factory.merge-apply.requested",
      input: mergeInput,
      predecessorAgent: "merge-scan@2",
      predecessorArtifact,
      predecessorInput: { repo: "factory" },
      parentRunId,
    });
    const fix = seed(db, {
      id: "mixed-fix",
      type: "factory.merge-fix.requested",
      input: fixInput,
      parentRunId,
      seedPredecessor: false,
    });
    const escalation = seed(db, {
      id: "mixed-escalation",
      type: "factory.merge-escalate.requested",
      input: { repo: "factory", summary: predecessorArtifact.summary },
      parentRunId,
      seedPredecessor: false,
    });

    const result = await auto(db, {
      approvalRegistry: independentMergeRegistry(),
      policy: {
        ...policy,
        maxFixRounds: 2,
        autoMergeBase: new Set(["develop"]),
        autoMergeOwners: new Set(["watt-mind"]),
      },
      runtimeGuard: () => null,
    });

    expect(result.approved.map((row) => row.runId).sort()).toEqual(
      [merge.runId, fix.runId, escalation.runId].sort(),
    );
    for (const candidate of [merge, fix, escalation]) {
      expect(runState(db, candidate.runId)).toBe("QUEUED");
    }
  });

  test("an independent recommendation edge with an empty selector remains watched", async () => {
    const db = openDb(":memory:");
    const escalation = seed(db, {
      id: "independent-recommendation-empty-selector",
      type: "factory.merge-escalate.requested",
      input: { repo: "factory", summary: "selected escalation" },
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        repo: "factory",
        summary: "selected escalation",
        plan: [],
        fix: [],
        escalate: [],
      },
      predecessorInput: { repo: "factory" },
    });

    expect(
      (
        await auto(db, {
          approvalRegistry: independentMergeRegistry(),
          runtimeGuard: () => null,
        })
      ).approved,
    ).toEqual([]);
    expect(runState(db, escalation.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_edge_not_registered",
    );
  });

  test("an independent recommendation edge with a tampered payload remains watched", async () => {
    const db = openDb(":memory:");
    const escalation = seed(db, {
      id: "independent-recommendation-tampered-payload",
      type: "factory.merge-escalate.requested",
      input: { repo: "factory", summary: "tampered escalation" },
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        repo: "factory",
        summary: "selected escalation",
        plan: [],
        fix: [],
        escalate: [{ pr: 429, reason: "human review required" }],
      },
      predecessorInput: { repo: "factory" },
    });

    expect(
      (
        await auto(db, {
          approvalRegistry: independentMergeRegistry(),
          runtimeGuard: () => null,
        })
      ).approved,
    ).toEqual([]);
    expect(runState(db, escalation.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_edge_not_registered",
    );
  });

  test("a non-independent recommendation edge preserves legacy approval", async () => {
    const db = openDb(":memory:");
    const escalation = seed(db, {
      id: "legacy-recommendation-edge",
      type: "factory.merge-escalate.requested",
      input: { repo: "factory", summary: "legacy escalation" },
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        repo: "factory",
        summary: "legacy escalation",
      },
      predecessorInput: { repo: "factory" },
    });

    expect(
      (
        await auto(db, {
          approvalRegistry: independentMergeRegistry({ independent: false }),
          runtimeGuard: () => null,
        })
      ).approved,
    ).toEqual([{ proposalId: escalation.id, runId: escalation.runId }]);
    expect(runState(db, escalation.runId)).toBe("QUEUED");
  });

  test("a sibling edge declared via `also` is a registered edge (dispatch PR_OPEN → merge.requested)", async () => {
    const db = openDb(":memory:");
    // dispatch@1 PR_OPEN maps to work.requested and fans out to
    // merge.requested via `also: ["PR_OPEN_MERGE"]`; the merge-scan proposal
    // must auto-approve instead of waiting as chain_edge_not_registered.
    const merge = seed(db, {
      id: "dispatch-also-merge",
      type: "factory.merge.requested",
      input: { repo: "factory", prNumbers: [777] },
      predecessorAgent: "dispatch@1",
      predecessorArtifact: {
        outcome: "PR_OPEN",
        repo: "factory",
        prNumber: 777,
      },
      predecessorInput: { repo: "factory", ticket: "WM-777" },
    });
    const result = await auto(db, { runtimeGuard: () => null });
    expect(result.approved.map((a) => a.proposalId)).toContain(merge.id);
    expect(runState(db, merge.runId)).toBe("QUEUED");
  });

  test("a non-independent array sibling remains watched", async () => {
    const db = openDb(":memory:");
    const mergeInput = {
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      deployBranch: "master",
      plan: [
        {
          pr: 431,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          headRef: "feat/WM-431",
          ticket: "WM-431",
          action: "merge_pr",
          reason: "selected sibling",
          checksGreen: true,
          mergeable: true,
          ownedPathsValid: true,
          handoffValid: true,
          testsFalsifiable: true,
          policySafe: true,
          sensitive: false,
          ambiguous: false,
        },
      ],
    };
    const sibling = seed(db, {
      id: "non-independent-array-sibling",
      type: "factory.merge-apply.requested",
      input: mergeInput,
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        ...mergeInput,
        fix: [],
        escalate: [{ pr: 429, reason: "human review required" }],
        summary: "merge and escalation selected",
      },
      predecessorInput: { repo: "factory" },
    });

    expect(
      (
        await auto(db, {
          approvalRegistry: independentMergeRegistry({ independent: false }),
          policy: {
            ...policy,
            autoMergeBase: new Set(["develop"]),
            autoMergeOwners: new Set(["watt-mind"]),
          },
          runtimeGuard: () => null,
        })
      ).approved,
    ).toEqual([]);
    expect(runState(db, sibling.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_edge_not_registered",
    );
  });

  test("a sibling with a nonempty payload array but empty selector remains watched", async () => {
    const db = openDb(":memory:");
    const mergeInput = {
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      deployBranch: "master",
      plan: [
        {
          pr: 431,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          headRef: "feat/WM-431",
          ticket: "WM-431",
          action: "merge_pr",
          reason: "selected sibling",
          checksGreen: true,
          mergeable: true,
          ownedPathsValid: true,
          handoffValid: true,
          testsFalsifiable: true,
          policySafe: true,
          sensitive: false,
          ambiguous: false,
        },
      ],
    };
    const sibling = seed(db, {
      id: "empty-independent-selector",
      type: "factory.merge-apply.requested",
      input: mergeInput,
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        ...mergeInput,
        fix: [],
        escalate: [{ pr: 429, reason: "human review required" }],
        summary: "merge payload exists but its selector is empty",
      },
      predecessorInput: { repo: "factory" },
    });

    expect(
      (
        await auto(db, {
          approvalRegistry: independentMergeRegistry({
            selectors: { MERGE: "fix" },
          }),
          policy: {
            ...policy,
            autoMergeBase: new Set(["develop"]),
            autoMergeOwners: new Set(["watt-mind"]),
          },
          runtimeGuard: () => null,
        })
      ).approved,
    ).toEqual([]);
    expect(runState(db, sibling.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_edge_not_registered",
    );
  });

  test("a declared but unselected sibling edge still fails closed", async () => {
    const db = openDb(":memory:");
    const fabricated = seed(db, {
      id: "unselected-merge",
      type: "factory.merge-apply.requested",
      input: {
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        plan: [
          {
            pr: 431,
            headSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            headRef: "feat/WM-431",
            ticket: "WM-431",
            action: "merge_pr",
            reason: "fabricated sibling edge",
            checksGreen: true,
            mergeable: true,
            ownedPathsValid: true,
            handoffValid: true,
            testsFalsifiable: true,
            policySafe: true,
            sensitive: false,
            ambiguous: false,
          },
        ],
      },
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        plan: [],
        fix: [],
        escalate: [{ pr: 429, reason: "human review required" }],
        summary: "only escalation was selected",
      },
      predecessorInput: { repo: "factory" },
    });

    expect((await auto(db, { runtimeGuard: () => null })).approved).toEqual([]);
    expect(runState(db, fabricated.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_edge_not_registered",
    );
  });

  test("a primitive fan-out sibling reconstructs the router's injected item key", async () => {
    const db = openDb(":memory:");
    const primitive = seed(db, {
      id: "primitive-independent-item",
      type: "factory.work.requested",
      input: { repo: "factory" },
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        repos: ["factory"],
        summary: "independent primitive item",
      },
      predecessorInput: { repo: "factory" },
    });
    const approvalRegistry = {
      ...registry,
      edges: {
        ...registry.edges,
        "merge-scan@2": {
          recommendationField: "recommendation",
          independent: true,
          edges: {
            ESCALATE: registry.edges["merge-scan@2"].edges.ESCALATE,
            WORK: {
              eventType: "factory.work.requested",
              whenItemsField: "$.artifact.repos",
              itemsField: "repos",
              itemKey: "repo",
              input: {},
            },
          },
        },
      },
    };

    expect(
      (await auto(db, { approvalRegistry, runtimeGuard: () => null })).approved,
    ).toEqual([{ proposalId: primitive.id, runId: primitive.runId }]);
    expect(runState(db, primitive.runId)).toBe("QUEUED");
  });

  test("a selected sibling edge with a payload not derived from the artifact fails closed", async () => {
    const db = openDb(":memory:");
    const selectedPlan = {
      pr: 431,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      headRef: "feat/WM-431",
      ticket: "WM-431",
      action: "merge_pr",
      reason: "selected predecessor payload",
      checksGreen: true,
      mergeable: true,
      ownedPathsValid: true,
      handoffValid: true,
      testsFalsifiable: true,
      policySafe: true,
      sensitive: false,
      ambiguous: false,
    };
    const tampered = seed(db, {
      id: "tampered-independent-payload",
      type: "factory.merge-apply.requested",
      input: {
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        plan: [{ ...selectedPlan, headSha: "f".repeat(40) }],
      },
      predecessorAgent: "merge-scan@2",
      predecessorArtifact: {
        recommendation: "ESCALATE",
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        plan: [selectedPlan],
        fix: [],
        escalate: [{ pr: 429, reason: "human review required" }],
        summary: "merge and escalation selected",
      },
      predecessorInput: { repo: "factory" },
    });

    expect((await auto(db, { runtimeGuard: () => null })).approved).toEqual([]);
    expect(runState(db, tampered.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_edge_not_registered",
    );
  });

  test("an event type absent from the predecessor rule still fails closed", async () => {
    const db = openDb(":memory:");
    const undeclared = seed(db, {
      id: "undeclared-edge",
      type: "factory.work.requested",
      predecessorAgent: "merge-scan@2",
      predecessorRecommendation: "ESCALATE",
    });

    expect((await auto(db, { runtimeGuard: () => null })).approved).toEqual([]);
    expect(runState(db, undeclared.runId)).toBe("PROPOSED");
    expect(openProposals(db, {})[0].reason).toContain(
      "chain_edge_not_registered",
    );
  });

  test("a tampered proposal fails closed and duplicate passes do not double-approve", async () => {
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

    expect((await auto(db)).approved.map((row) => row.runId)).toEqual([
      safe.runId,
    ]);
    expect((await auto(db)).approved).toEqual([]);
    expect(runState(db, tampered.runId)).toBe("PROPOSED");
    expect(
      openProposals(db, {}).find((proposal) => proposal.id === tampered.id)
        .reason,
    ).toContain("proposal_run_spec_mismatch");
  });
  const dispatchSeed = (
    db,
    id,
    { labels = [], intersections = [], ticket = "WM-900" } = {},
  ) =>
    seed(db, {
      id,
      type: "factory.dispatch.requested",
      input: { repo: "factory", ticket },
      approvalPolicy: {
        source: "chain",
        mode: "auto",
        eventType: "factory.dispatch.requested",
        dispatchEvidence: {
          ticket: { labels },
          escalatePathIntersections: intersections,
        },
      },
    });
  const evidenceFor = (labels, intersections) => () => ({
    ok: true,
    evidence: {
      ticket: { labels },
      escalatePathIntersections: intersections,
    },
  });
  const hookModule = (id, fn) => ({ id, default: fn });
  const reasonOf = (db, id) =>
    openProposals(db, {}).find((proposal) => proposal.id === id)?.reason;

  test("approve.before hooks (WM-842): the built-in escalation hook keeps the old reason and order, and every decision is persisted", async () => {
    const db = openDb(":memory:");
    // Both an escalation label and a path intersection: the label refusal
    // still wins, exactly where the inline check used to run.
    const both = dispatchSeed(db, "both", {
      ticket: "WM-901",
      labels: ["ai:escalated"],
      intersections: ["src/auth/**"],
    });
    const clean = dispatchSeed(db, "clean", { ticket: "WM-902" });
    const dispatchEligibility = (payload) =>
      payload.ticket === "WM-901"
        ? evidenceFor(["ai:escalated"], ["src/auth/**"])()
        : evidenceFor([], [])();
    const hooks = createHookRegistry();
    const result = await auto(db, {
      dispatchEligibility,
      hooks,
      runtimeGuard: () => null,
    });
    expect(result.approved).toEqual([
      { proposalId: clean.id, runId: clean.runId },
    ]);
    expect(reasonOf(db, both.id)).toBe(
      "auto_approval_ineligible:dispatch_ineligible:escalated_or_security",
    );
    expect(
      hookDecisionsFor(db, both.id).map((r) => [
        r.hookId,
        r.source,
        r.decision,
        r.reason,
        r.runId,
      ]),
    ).toEqual([
      [
        "factory:escalation-labels",
        "builtin",
        "deny",
        "escalated_or_security",
        both.runId,
      ],
    ]);
    expect(
      hookDecisionsFor(db, clean.id).map((r) => [r.hookId, r.decision]),
    ).toEqual([["factory:escalation-labels", "allow"]]);
    expect(hookDecisionsFor(db, clean.id)[0].at).toBe(
      new Date(now).toISOString(),
    );
  });

  test("an extension hook deny keeps a dispatch open as dispatch_ineligible:<reason>, other events as hook_denied:<reason>", async () => {
    const db = openDb(":memory:");
    const dispatch = dispatchSeed(db, "gated");
    const work = seed(db, { id: "work" });
    const seen = [];
    const hooks = createHookRegistry();
    hooks.register(
      "approve.before",
      hookModule("acme/gate:no-factory", (ctx) => {
        seen.push(ctx);
        return ctx.repo === "factory"
          ? { decision: "deny", reason: "repo_gated" }
          : { decision: "allow" };
      }),
      { source: "extension:acme/gate", config: () => ({ blocked: true }) },
    );
    const result = await auto(db, { hooks, runtimeGuard: () => null });
    expect(result.approved).toEqual([]);
    expect(reasonOf(db, dispatch.id)).toBe(
      "auto_approval_ineligible:dispatch_ineligible:repo_gated",
    );
    expect(reasonOf(db, work.id)).toBe(
      "auto_approval_ineligible:hook_denied:repo_gated",
    );
    expect(runState(db, dispatch.runId)).toBe("PROPOSED");
    expect(runState(db, work.runId)).toBe("PROPOSED");
    // The hook context: proposal, RunSpec, evidence (dispatch only), policy, repo, clock, config.
    const dispatchCtx = seen.find((c) => c.proposal.id === dispatch.id);
    expect(dispatchCtx).toMatchObject({
      proposal: {
        id: dispatch.id,
        runId: dispatch.runId,
        eventType: "factory.dispatch.requested",
      },
      spec: { runId: dispatch.runId, input: { repo: "factory" } },
      evidence: { ticket: { labels: [] }, escalatePathIntersections: [] },
      policy: { source: "chain", mode: "auto" },
      repo: "factory",
      now,
      config: { blocked: true },
    });
    expect(seen.find((c) => c.proposal.id === work.id).evidence).toBeNull();
    // Persisted for both, built-in first.
    expect(
      hookDecisionsFor(db, dispatch.id).map((r) => [r.hookId, r.decision]),
    ).toEqual([
      ["factory:escalation-labels", "allow"],
      ["acme/gate:no-factory", "deny"],
    ]);
  });

  test("a throwing, hanging or malformed hook fails closed as hook_error:<id>", async () => {
    const db = openDb(":memory:");
    const throwing = dispatchSeed(db, "throwing");
    const hooks = createHookRegistry();
    hooks.register(
      "approve.before",
      hookModule("acme/bad:throws", () => {
        throw new Error("boom");
      }),
      { source: "extension:acme/bad" },
    );
    expect(
      (await auto(db, { hooks, runtimeGuard: () => null })).approved,
    ).toEqual([]);
    expect(reasonOf(db, throwing.id)).toBe(
      "auto_approval_ineligible:dispatch_ineligible:hook_error:acme/bad:throws",
    );

    const hangDb = openDb(":memory:");
    const hanging = seed(hangDb, { id: "hanging" });
    const slow = createHookRegistry();
    slow.register(
      "approve.before",
      hookModule("acme/slow:hangs", () => new Promise(() => {})),
      { source: "extension:acme/slow" },
    );
    const started = performance.now();
    expect(
      (
        await auto(hangDb, {
          hooks: slow,
          hookTimeoutMs: 20,
          runtimeGuard: () => null,
        })
      ).approved,
    ).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(reasonOf(hangDb, hanging.id)).toBe(
      "auto_approval_ineligible:hook_denied:hook_error:acme/slow:hangs",
    );
    expect(hookDecisionsFor(hangDb, hanging.id).at(-1)).toMatchObject({
      decision: "deny",
      reason: "hook_error:acme/slow:hangs",
      error: expect.stringMatching(/did not answer within 20ms/),
    });
  });

  test("an async hook defers the pass; concurrent passes on one database are serialized, not interleaved", async () => {
    const db = openDb(":memory:");
    const safe = seed(db, { id: "safe" });
    let calls = 0;
    const hooks = createHookRegistry();
    hooks.register(
      "approve.before",
      hookModule("acme/async:allow", async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { decision: "allow" };
      }),
      { source: "extension:acme/async" },
    );
    const first = auto(db, { hooks, runtimeGuard: () => null });
    const second = auto(db, { hooks, runtimeGuard: () => null });
    // Nothing is decided synchronously once a hook goes async.
    expect(runState(db, safe.runId)).toBe("PROPOSED");
    const [a, b] = await Promise.all([first, second]);
    expect(a.approved).toEqual([{ proposalId: safe.id, runId: safe.runId }]);
    expect(b.approved).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(calls).toBe(1);
    expect(runState(db, safe.runId)).toBe("QUEUED");
  });

  test("with only synchronous hooks the pass completes before the promise is returned", () => {
    const db = openDb(":memory:");
    const safe = seed(db, { id: "safe" });
    const pending = auto(db, { runtimeGuard: () => null });
    expect(typeof pending.then).toBe("function");
    expect(runState(db, safe.runId)).toBe("QUEUED");
    // A synchronously completed pass leaves nothing queued: the next call in
    // the same tick (planAdmittedEvents twice in a row) is eager as well.
    const later = seed(db, { id: "later" });
    const second = auto(db, { runtimeGuard: () => null });
    expect(runState(db, later.runId)).toBe("QUEUED");
    return Promise.all([pending, second]);
  });
});
