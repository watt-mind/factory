import { describe, expect, test } from "bun:test";

import { resolveTemplate } from "./lib/adapters/command.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { canonicalJson } from "./lib/canonical.mjs";
import { openDb } from "./lib/db.mjs";
import { admitEvent } from "./lib/intake.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { openProposals } from "./lib/proposals.mjs";
import { loadRegistry } from "./lib/registry.mjs";

const registry = loadRegistry();
const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const FINDING_HASH = "d".repeat(64);
const PV = "git:test";

const candidate = (pr = 42, ticket = "WM-500") => ({
  pr,
  headSha: SHA,
  baseSha: BASE_SHA,
  headRef: `feat/${ticket}`,
  ticket,
  action: "merge_pr",
  reason: "cold review passed",
  checksGreen: true,
  mergeable: true,
  ownedPathsValid: true,
  handoffValid: true,
  testsFalsifiable: true,
  policySafe: true,
  sensitive: false,
  ambiguous: false,
});

const applyPayload = (pr = 42, ticket = "WM-500") => ({
  repo: "factory",
  github: "watt-mind/factory",
  base: "develop",
  deployBranch: "master",
  plan: [candidate(pr, ticket)],
});

function envelope(type, payload, id) {
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type,
    source: "chain",
    subject: payload.repo,
    occurredAt: "2026-08-16T12:00:00.000Z",
    correlationId: id,
    causationId: "parent-run",
    payload,
  };
}

function seedCompleted(db, { runId, agent, input, artifact }) {
  const now = "2026-08-16T12:00:00.000Z";
  const eventId = `event-${runId}`;
  db.query(
    `INSERT INTO events (source,event_id,type,subject,occurred_at,received_at,correlation_id,envelope_json,payload_hash,status,admitted_at)
     VALUES ('operator',?,'test.event','test',?,?,?,?,'hash','planned',?)`,
  ).run(eventId, now, now, eventId, canonicalJson({ payload: input }), now);
  db.query(
    `INSERT INTO runs (run_id,idempotency_key,spec_json,spec_hash,state,attempts,created_at,updated_at)
     VALUES (?,?,?,'hash','COMPLETED',1,?,?)`,
  ).run(runId, `idem-${runId}`, canonicalJson({ agent, input }), now, now);
  db.query(
    `INSERT INTO proposals (id,event_source,event_id,run_id,decision,spec_json,status,created_at,ttl_seconds)
     VALUES (?,'operator',?,?,'run',?,'approved',?,1800)`,
  ).run(
    `proposal-${runId}`,
    eventId,
    runId,
    canonicalJson({ agent, input }),
    now,
  );
  db.query(
    `INSERT INTO results (run_id,attempt,result_json,artifact_hash,verification_json,receipt_json,accepted_at)
     VALUES (?,1,?,'hash','{}','{}',?)`,
  ).run(runId, canonicalJson({ artifact }), now);
}

describe("durable autonomous merge registry (WM-398/WM-403)", () => {
  test("central mappings register scan, bounded fix, deterministic apply, landed verify, and explicit verify", () => {
    expect(registry.eventTypes["factory.merge.requested"].agent).toBe(
      "merge-scan@2",
    );
    expect(registry.eventTypes["factory.merge-fix.requested"].agent).toBe(
      "merge-fix@1",
    );
    expect(registry.eventTypes["factory.merge-apply.requested"].agent).toBe(
      "merge-apply@2",
    );
    expect(registry.eventTypes["factory.merge-landed"].agent).toBe(
      "merge-verify@1",
    );
    expect(registry.eventTypes["factory.merge-verify.requested"].agent).toBe(
      "merge-verify@1",
    );
    expect(
      registry.agents.get("merge-fix@1").inputSchema.properties.round.maximum,
    ).toBe(2);
  });

  test("cold plan pins head and base, permits one PR, and records every policy proof", () => {
    const plan =
      registry.agents.get("merge-scan@2").outputSchema.properties.plan;
    expect(plan.maxItems).toBe(1);
    expect(plan.items.required).toContain("baseSha");
    expect(plan.items.required).toContain("testsFalsifiable");
    expect(plan.items.properties.sensitive.const).toBe(false);
    expect(plan.items.properties.ambiguous.const).toBe(false);
  });

  test("apply has one action and cannot mark Done or delete a branch", () => {
    const def = registry.agents.get("merge-apply@2");
    expect(Object.keys(def.actionRegistry)).toEqual(["merge_pr"]);
    const script = def.actionRegistry.merge_pr.argv[2];
    expect(script).toContain("--match-head-commit");
    expect(script).toContain("actual_base");
    expect(script).toContain("isDraft");
    expect(script).toContain("--required --json bucket");
    expect(script).toContain("factory.merge-landed");
    expect(script).not.toContain("--delete-branch");
    expect(script).not.toContain(" Done ");
  });

  test("merge verifier command loads and resolves only declared input templates", () => {
    const def = registry.agents.get("merge-verify@1");
    expect(def).toBeTruthy();
    expect([...def.command[2].matchAll(/\{([A-Za-z0-9_]+)\}/g)]).toEqual([]);
    expect(
      resolveTemplate(def.command, {
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 398,
        ticket: "WM-398",
        headSha: SHA,
        headRef: "feat/WM-398",
        mergeCommitSha: MERGE_SHA,
      }),
    ).toHaveLength(def.command.length);
  });

  test("verify waits on exact merge SHA, blocks and notifies red, then performs exact cleanup and Done", () => {
    const script = registry.agents.get("merge-verify@1").command[2];
    expect(script).toContain("commits/$merge/check-runs");
    expect(script).toContain('--commit "$merge"');
    expect(script).toContain("CI RED");
    expect(script).toContain("SMOKE RED");
    expect(script).toContain("git/ref/heads/$headref");
    expect(script).toContain("HTTP 404"); // exact prior cleanup is replay-safe
    expect(script).toContain('linear state "$ticket" Done');
    expect(script.indexOf('linear state "$ticket" Done')).toBeGreaterThan(
      script.indexOf("check-runs"),
    );
  });

  test("all enabled merge schedules are singleton autonomous cold scans", () => {
    const schedules = Object.entries(registry.schedules).filter(
      ([name, schedule]) => name.startsWith("merge-") && schedule.enabled,
    );
    expect(schedules.map(([name]) => name)).toEqual(["merge-factory"]);
    for (const [, schedule] of schedules) {
      expect(schedule).toMatchObject({
        eventType: "factory.merge.requested",
        singleton: true,
        approval: "auto",
        enabled: true,
      });
    }
  });
});

describe("merge transition chains", () => {
  test("MERGE emits one SHA-pinned apply event", () => {
    const db = openDb(":memory:");
    seedCompleted(db, {
      runId: "scan-merge",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "MERGE",
        ...applyPayload(),
        fix: [],
        escalate: [],
        summary: "one merge",
      },
    });
    expect(resolveChains(db, registry)).toEqual({
      emitted: 1,
      skipped: 0,
      errors: [],
    });
    const payload = JSON.parse(
      db.query(`SELECT envelope_json FROM events WHERE source='chain'`).get()
        .envelope_json,
    ).payload;
    expect(payload).toEqual(applyPayload());
  });

  test("FIX fans out one durable request per PR with round and finding hash", () => {
    const db = openDb(":memory:");
    const fix = ["WM-501", "WM-502"].map((ticket, index) => ({
      pr: 50 + index,
      headSha: SHA,
      baseSha: BASE_SHA,
      headRef: `feat/${ticket}`,
      ticket,
      finding: `mechanical ${index}`,
      findingHash: FINDING_HASH,
      round: 1,
      mechanical: true,
      withinOwnedPaths: true,
      ownedPaths: [`src/${index}.mjs`],
    }));
    seedCompleted(db, {
      runId: "scan-fix",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "FIX",
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        plan: [],
        fix,
        escalate: [],
        summary: "two fixes",
      },
    });
    expect(resolveChains(db, registry).emitted).toBe(2);
    const rows = db
      .query(
        `SELECT envelope_json FROM events WHERE source='chain' ORDER BY event_id`,
      )
      .all();
    expect(
      rows.map((row) => JSON.parse(row.envelope_json).payload.ticket),
    ).toEqual(["WM-501", "WM-502"]);
    expect(JSON.parse(rows[0].envelope_json).payload).toMatchObject({
      round: 1,
      findingHash: FINDING_HASH,
      mechanical: true,
    });
  });

  test("a fixer can only request a fresh independent scan, never apply", () => {
    const db = openDb(":memory:");
    seedCompleted(db, {
      runId: "fix-done",
      agent: "merge-fix@1",
      input: { repo: "factory" },
      artifact: {
        outcome: "UPDATED",
        repo: "factory",
        ticket: "WM-501",
        pr: 50,
        headSha: SHA,
        round: 1,
        summary: "pushed",
      },
    });
    expect(resolveChains(db, registry).emitted).toBe(1);
    const row = db
      .query(`SELECT type,envelope_json FROM events WHERE source='chain'`)
      .get();
    expect(row.type).toBe("factory.merge.requested");
    expect(JSON.parse(row.envelope_json).payload).toEqual({ repo: "factory" });
  });
});

describe("policy approval and global merge barrier", () => {
  test("an ordinary policy-safe develop apply auto-queues, while main and sensitive plans remain open", () => {
    const db = openDb(":memory:");
    admitEvent(
      db,
      registry,
      envelope("factory.merge-apply.requested", applyPayload(), "safe"),
    );
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        { ...applyPayload(43, "WM-503"), base: "main" },
        "main",
      ),
    );
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        {
          ...applyPayload(44, "WM-504"),
          plan: [
            { ...candidate(44, "WM-504"), sensitive: true, policySafe: false },
          ],
        },
        "sensitive",
      ),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      db
        .query(
          `SELECT state FROM runs WHERE json_extract(spec_json,'$.input.plan[0].pr')=42`,
        )
        .get().state,
    ).toBe("QUEUED");
    const reasons = openProposals(db, {})
      .map((p) => p.reason)
      .join(" ");
    expect(reasons).toContain("merge_base_not_allowed");
    expect(reasons).toContain("invalid_input");
  });

  test("only one merge apply queues globally; a second remains durably watched", () => {
    const db = openDb(":memory:");
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        applyPayload(60, "WM-560"),
        "first",
      ),
    );
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        applyPayload(61, "WM-561"),
        "second",
      ),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      db.query(`SELECT COUNT(*) n FROM runs WHERE state='QUEUED'`).get().n,
    ).toBe(1);
    expect(openProposals(db, {})).toHaveLength(1);
    expect(openProposals(db, {})[0].reason).toContain("merge_barrier_active");
  });

  test("a landed event queues deterministic verification, and failed verification holds every next merge", () => {
    const db = openDb(":memory:");
    const landed = {
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      pr: 70,
      ticket: "WM-570",
      headSha: SHA,
      headRef: "feat/WM-570",
      mergeCommitSha: MERGE_SHA,
    };
    admitEvent(
      db,
      registry,
      envelope("factory.merge-landed", landed, "landed"),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const verify = db
      .query(
        `SELECT run_id,state FROM runs WHERE json_extract(spec_json,'$.agent')='merge-verify@1'`,
      )
      .get();
    expect(verify.state).toBe("QUEUED");
    db.query(`UPDATE runs SET state='FAILED' WHERE run_id=?`).run(
      verify.run_id,
    );

    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        applyPayload(71, "WM-571"),
        "after-red",
      ),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find(
      (p) => p.spec?.agent === "merge-apply@2",
    );
    expect(proposal.reason).toContain("merge_barrier_unverified");
  });

  test("mechanical fix rounds are bounded and exhausted rounds fail schema/policy closed", () => {
    const schema = registry.agents.get("merge-fix@1").inputSchema;
    expect(schema.properties.round.maximum).toBe(2);
    const prompt = registry.agents.get("merge-fix@1").promptPath;
    expect(prompt).toContain("merge-fix.md");
  });
});
