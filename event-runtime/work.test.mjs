import { tmpDir } from "./test-support/tmp.mjs?file=event-runtime-work-test-mjs";
/**
 * Work chain (WM-110): work-scan@1 reads a repo's agent-ready Linear queue
 * against a pinned tree and emits a typed DISPATCH plan; the chain edge feeds
 * every planned ticket into factory.dispatch.requested, where WM-108's plan-time
 * gate re-checks the world — a stale scan cannot force a dispatch.
 * chain.mjs emits one event per selected plan item; candidates that cannot start
 * are carried in `deferred` with typed reasons for the next fresh scan. Follows the
 * triage-scan (OPS-229) and merge-scan (WM-109) precedents.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as fake from "./lib/adapters/fake.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { openDb } from "./lib/db.mjs";
import { admitEvent } from "./lib/intake.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { approveProposal, openProposals } from "./lib/proposals.mjs";
import { loadRegistry, resolveModel } from "./lib/registry.mjs";
import { runOnce } from "./lib/worker.mjs";

const registry = loadRegistry();
const PV = "git:test-pv";
// See repository.test.mjs: neutralise the operator's global git config so a
// signing key or a global hooks path cannot hang the fixture (OPS-441).
const HERMETIC = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.template=",
];
const git = (args, cwd) =>
  execFileSync("git", [...HERMETIC, ...args], { cwd, encoding: "utf8" }).trim();

// Hermetic repo fixtures: a real git repo (the scan's repository workspace
// pins a SHA) whose config also carries the worktree scripts and team/project
// the chained dispatch plan is gated on. Linear and the lease ledger are
// injected — no test here touches the network or ~/.factory.
const fixtures = [];
let previousReposRoot;
let previousEventHome;

function makeGitRepo(name) {
  const dir = tmpDir(`evrt-work-${name}-`);
  fixtures.push(dir);
  git(["init", "--quiet", "--initial-branch=develop"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(path.join(dir, "README.md"), `${name}\n`);
  git(["add", "."], dir);
  git(["commit", "--quiet", "-m", "init"], dir);
  return dir;
}

beforeAll(() => {
  const root = tmpDir("evrt-work-factory-");
  fixtures.push(root);
  mkdirSync(path.join(root, "config"), { recursive: true });
  const wm29 = makeGitRepo("wm29");
  const clean = makeGitRepo("clean");
  const low = makeGitRepo("low");
  const overlap = low;
  const cap = low;
  const lowBad = low;
  const wtRoot = tmpDir("evrt-work-trees-");
  fixtures.push(wtRoot);

  for (const r of [wm29, clean, low]) {
    mkdirSync(path.join(r, "bin"), { recursive: true });
    writeFileSync(
      path.join(r, "bin", "worktree-up.sh"),
      `#!/bin/bash\nset -e\nmkdir -p "${wtRoot}/$1"\n`,
    );
    writeFileSync(
      path.join(r, "bin", "worktree-down.sh"),
      `#!/bin/bash\nset -e\nrm -rf "${wtRoot}/$1"\n`,
    );
  }

  writeFileSync(path.join(root, "config", "policy.yaml"), "{}\n");
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n` +
      `  - name: wm29\n    path: ${wm29}\n    github: watt-mind/wm29\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    verify: echo verified\n    escalate_paths: []\n` +
      `  - name: clean\n    path: ${clean}\n    github: watt-mind/clean\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    escalate_paths: []\n` +
      `  - name: low\n    path: ${low}\n    github: watt-mind/low\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n` +
      `    verify: echo verified\n    escalate_paths: []\n` +
      `  - name: overlap\n    path: ${low}\n    github: watt-mind/overlap\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    escalate_paths: []\n` +
      `  - name: cap\n    path: ${low}\n    github: watt-mind/cap\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    escalate_paths: []\n` +
      `  - name: lowbad\n    path: ${low}\n    github: watt-mind/lowbad\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    escalate_paths: []\n` +
      `  - name: contradiction\n    path: ${low}\n    github: watt-mind/contradiction\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    escalate_paths: []\n`,
  );
  previousReposRoot = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  previousEventHome = process.env.FACTORY_EVENT_HOME;
  process.env.FACTORY_EVENT_HOME = tmpDir("evrt-work-home-");
  fixtures.push(process.env.FACTORY_EVENT_HOME);
});

afterAll(() => {
  if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
  else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  if (previousEventHome === undefined) delete process.env.FACTORY_EVENT_HOME;
  else process.env.FACTORY_EVENT_HOME = previousEventHome;
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const FIRST = "WM-601";
const SECOND = "WM-602";

// ---------------------------------------------------------------------------
// Chain e2e on the fake adapter. The shared fake (lib/adapters/fake.mjs) does
// not know the work-plan contract, so a local wrapper answers it the same way
// the fake answers triage/sweep — repo-keyed, contract-shaped — and delegates
// everything else to the fake.
// ---------------------------------------------------------------------------

const seenCandidate = (ticket, disposition) => ({ ticket, disposition });

function workScanEvidence(repo) {
  let candidates;
  let inFlightSeen = 0;
  if (["clean", "low"].includes(repo)) {
    candidates = [];
  } else if (repo === "lowbad") {
    candidates = [seenCandidate(FIRST, "selected")];
  } else if (repo === "contradiction") {
    // Regression fixture from run_0e25d228: three unassigned ready tickets
    // were read alongside two in-progress tickets, then reported queue_empty.
    candidates = [
      seenCandidate("WM-345", "selected"),
      seenCandidate("WM-294", "selected"),
      seenCandidate("WM-131", "selected"),
    ];
    inFlightSeen = 2;
  } else if (repo === "overlap") {
    candidates = [
      seenCandidate(FIRST, "owned_paths_overlap"),
      seenCandidate(SECOND, "owned_paths_overlap"),
    ];
  } else if (repo === "cap") {
    candidates = [
      seenCandidate(FIRST, "cap_full"),
      seenCandidate(SECOND, "cap_full"),
    ];
    inFlightSeen = 3;
  } else {
    candidates = [
      seenCandidate(FIRST, "selected"),
      seenCandidate(SECOND, "selected"),
    ];
  }
  return {
    commands: ["fake"],
    candidatesSeen: candidates.length,
    candidates,
    inFlightSeen,
    maxInFlight: 3,
  };
}

function workScanArtifact(repo) {
  if (repo === "clean") {
    return {
      recommendation: "NOOP",
      repo,
      ticket: null,
      plan: [],
      deferred: [],
      summary: "fake: no dispatchable tickets",
      readyCandidates: 0,
      triageBacklog: 0,
      noopReason: "queue_empty",
    };
  }
  if (repo === "low") {
    return {
      recommendation: "LOW_SUPPLY",
      repo,
      ticket: null,
      plan: [],
      deferred: [],
      summary: "fake: triage backlog exists",
      readyCandidates: 0,
      triageBacklog: 3,
    };
  }
  if (repo === "overlap") {
    return {
      recommendation: "NOOP",
      repo,
      ticket: null,
      plan: [],
      deferred: [],
      summary: "fake: overlap blocked",
      readyCandidates: 2,
      triageBacklog: 0,
      noopReason: "all_overlapping",
    };
  }
  if (repo === "cap") {
    return {
      recommendation: "NOOP",
      repo,
      ticket: null,
      plan: [],
      deferred: [],
      summary: "fake: cap blocked",
      readyCandidates: 2,
      triageBacklog: 0,
      noopReason: "cap_full",
    };
  }
  if (repo === "lowbad") {
    return {
      recommendation: "LOW_SUPPLY",
      repo,
      ticket: null,
      plan: [],
      deferred: [],
      summary: "fake: malformed low supply counts",
      triageBacklog: 3,
      readyCandidates: 1,
    };
  }
  if (repo === "contradiction") {
    return {
      recommendation: "NOOP",
      repo,
      ticket: null,
      plan: [],
      deferred: [],
      summary: "fake: discarded three ready candidates",
      triageBacklog: 0,
      readyCandidates: 3,
      noopReason: "queue_empty",
    };
  }
  return {
    recommendation: "DISPATCH",
    repo,
    ticket: FIRST,
    plan: [
      {
        ticket: FIRST,
        ownedPaths: ["src/feature-a/**"],
        reason: "fake: priority 1, disjoint",
      },
      {
        ticket: SECOND,
        ownedPaths: ["src/feature-b/**"],
        reason: "fake: priority 2, disjoint",
      },
    ],
    deferred: [],
    readyCandidates: 2,
    triageBacklog: 0,
    summary: `fake work plan for ${repo}`,
  };
}

const workFake = {
  async execute(opts) {
    const { spec, workspaceDir } = opts;
    if (spec.outputContract === "factory.work-plan/v1") {
      writeFileSync(
        path.join(workspaceDir, "result.json"),
        `${JSON.stringify(
          {
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: workScanArtifact(spec.input.repo),
            evidence: workScanEvidence(spec.input.repo),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { exitCode: 0, timedOut: false };
    }
    if (spec.outputContract === "factory.dispatch-result/v1") {
      writeFileSync(
        path.join(workspaceDir, "result.json"),
        `${JSON.stringify(
          {
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: {
              outcome: "PR_OPEN",
              repo: spec.input.repo,
              ticket: spec.input.ticket,
              prUrl: `https://github.com/watt-mind/${spec.input.repo}/pull/1`,
              verification: {
                command: "echo verified",
                passed: true,
                output: "verified",
              },
              summary: `fake dispatch of ${spec.input.ticket}`,
            },
            evidence: { commands: ["echo verified"] },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { exitCode: 0, timedOut: false };
    }
    return fake.execute(opts);
  },
};

/**
 * Injected dispatch-gate world for planning the CHAINED event: the planner's
 * worktree gate re-reads Linear and the lease ledger (dispatch doc §§2–4);
 * here both say "wide open" so the chained proposal is planned, proving the
 * re-gate ran without a network read. dispatch.test.mjs owns the refusal
 * matrix — not re-proven here.
 */
const openWorld = {
  fetchTicket: (ticketId) => ({
    identifier: ticketId ?? FIRST,
    title: "a fully specified ticket",
    state: { name: "Todo" },
    assignee: null,
    labels: { nodes: [{ name: "ai:agent-ready" }] },
    description:
      ticketId === SECOND
        ? "## Owned Paths\n- src/feature-b/**\n"
        : "## Owned Paths\n- src/feature-a/**\n",
  }),
  fetchInFlight: () => [],
  countLeases: () => 0,
};

function harness() {
  const dir = tmpDir("evrt-work-");
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = tmpDir("evrt-work-ws-");
  // work-scan@1 rides pi; dispatch@1 rides cursor (WM-215/WM-694) — the fake
  // dispatches on spec.outputContract, not the adapter key, so both routes
  // share it.
  const adapters = { pi: workFake, cursor: workFake };
  const workerOpts = {
    workspacesRoot: workspaces,
    owner: "w-test",
    policyVersion: PV,
    dispatch: openWorld,
  };

  const planAll = () =>
    planAdmittedEvents(db, registry, {
      policyVersion: PV,
      dispatch: openWorld,
    });

  async function approveNext(agentRef) {
    planAll();
    const proposal = openProposals(db, {}).find(
      (p) => p.spec?.agent === agentRef,
    );
    expect(proposal).toBeTruthy();
    const approved = approveProposal(db, registry, proposal.id, {
      actor: "operator",
      policyVersion: PV,
    });
    const summary = await runOnce(db, registry, adapters, workerOpts);
    return { proposal, runId: approved.runId, summary };
  }
  return { db, planAll, approveNext };
}

const workEnvelope = (repo, eventId) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.work.requested",
  source: "operator",
  subject: repo,
  occurredAt: "2026-08-14T09:00:00Z",
  correlationId: eventId,
  payload: { repo },
});

describe("work-scan registration (WM-110)", () => {
  test("work-scan@1 is a read-only pi agent over a repository workspace, like triage-scan", () => {
    const def = registry.agents.get("work-scan@1");
    expect(def.mutating).toBe(false);
    // It verifies Owned Paths globs against real paths, so it reads the
    // pinned tree — repository checkout, never a mutable worktree.
    expect(def.workspace).toEqual({
      type: "repository",
      checkoutDir: "repo",
      retainOnFailure: true,
    });
    expect(def.output_contract).toBe("factory.work-plan/v1");
    expect(def.capabilities.services).toEqual(["linear:read", "repo:read"]);
  });

  test("factory.work.requested maps to work-scan@1 on the pi adapter, deduped by inputHash", () => {
    expect(registry.eventTypes["factory.work.requested"]).toEqual({
      agent: "work-scan@1",
      adapter: "pi",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
  });

  // WM-215/WM-694: dispatch@1 rides cursor (Grok 4.6) since 2026-08-19
  // (operator decision to spare codex quota — see WM-215 test above). The
  // §14 admission rule that lets a mutating LLM agent exist at all is the
  // tier-2 worktree carve-out (WM-108, generalized to any adapter by
  // OPS-296) — assert it holds for dispatch@1 on cursor, since a regression
  // here would refuse the whole registry at load, not just this route.
  test("dispatch@1 is admissible as a mutating cursor agent over a tier-2 worktree (WM-215)", () => {
    expect(registry.eventTypes["factory.dispatch.requested"]).toEqual({
      agent: "dispatch@1",
      adapter: "cursor",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
    const def = registry.agents.get("dispatch@1");
    expect(def.mutating).toBe(true);
    expect(def.workspace.type).toBe("worktree");
    // The registry loaded at module scope: loadRegistry() already ran the §14
    // admission check and the WM-135 fail-closed model resolution over this
    // route, so a cursor+worktree+mutating definition is admitted and its
    // strong tier resolves against models.cursor.
    expect(def.model_tier).toBe("strong");
    expect(resolveModel(def, "cursor", registry.modelTiers)).toBe(
      registry.modelTiers.cursor.strong,
    );
  });

  test("every LLM route is the pi adapter except the merge exceptions (agy since 2026-08-18); command/actions routes are untouched (WM-215)", () => {
    const byAdapter = {};
    for (const mapping of Object.values(registry.eventTypes)) {
      if (!mapping.agent) continue;
      (byAdapter[mapping.adapter] ??= []).push(mapping.agent);
    }
    // The default harness is pi. The only committed non-pi LLM routes are the
    // merge-scan/merge-fix exceptions (WM-722 put them on claude/sonnet;
    // operator decision 2026-08-18 moved them to agy, gemini-3.7-flash, which
    // is fast and on a separate subscription; triage-scan followed on 2026-08-18
    // evening to spare codex quota). agy-smoke rides agy by
    // definition. Any other route leaving pi must be an explicit, reviewed
    // decision. No route rides claude any more.
    expect(byAdapter.claude).toBeUndefined();
    expect([...byAdapter.agy].sort()).toEqual([
      "agy-smoke@1",
      "merge-fix@1",
      "merge-scan@2",
      "triage-scan@1",
    ]);
    // dispatch@1 rides cursor (Grok 4.6) since 2026-08-19 — operator decision to
    // spare codex quota; cursor-smoke rides cursor by definition.
    expect([...byAdapter.cursor].sort()).toEqual([
      "cursor-smoke@1",
      "dispatch@1",
    ]);
    expect(
      resolveModel(
        registry.agents.get("dispatch@1"),
        "cursor",
        registry.modelTiers,
      ),
    ).toBe(registry.modelTiers.cursor.standard);
    for (const ref of ["merge-fix@1", "merge-scan@2", "triage-scan@1"]) {
      const resolved = resolveModel(
        registry.agents.get(ref),
        "agy",
        registry.modelTiers,
      );
      expect(resolved).toBe(registry.modelTiers.agy.standard);
    }
    expect(byAdapter.pi.length).toBeGreaterThan(0);
    // Every pi route resolves a model: loadRegistry fails closed otherwise,
    // but assert the values so a silently-null resolution can't pass.
    for (const ref of byAdapter.pi) {
      const resolved = resolveModel(
        registry.agents.get(ref),
        "pi",
        registry.modelTiers,
      );
      expect(Object.values(registry.modelTiers.pi)).toContain(resolved);
    }
  });

  test("the plan item shape pins {ticket, ownedPaths, reason}; NOOP reasons are the closed set", () => {
    const schema = registry.agents.get("work-scan@1").outputSchema;
    expect(schema.properties.plan.items.required).toEqual([
      "ticket",
      "ownedPaths",
      "reason",
    ]);
    expect(schema.properties.plan.items.properties.ticket.pattern).toBe(
      "^[A-Z]+-[0-9]+$",
    );
    expect(schema.properties.deferred.items.required).toEqual([
      "ticket",
      "reason",
    ]);
    expect(schema.properties.deferred.items.properties.reason.enum).toEqual([
      "cap_full",
      "owned_paths_overlap",
    ]);
    expect(schema.properties.noopReason.enum).toEqual([
      "queue_empty",
      "cap_full",
      "all_overlapping",
    ]);
  });

  test("DISPATCH remains multi-emit; LOW_SUPPLY no longer chains to triage", () => {
    // chain.mjs derives eventId chain-<runId>-<ticket> — multi-emit fan-out
    // edge feeds every planned ticket into factory.dispatch.requested.
    // LOW_SUPPLY no longer has a chain edge (WM: operator decision
    // 2026-08-18, to stop burning the pi/codex adapter's quota on
    // ~30-minute chain loops). The triage floor is now the 8h
    // triage-factory schedule plus manual operator injection.
    expect(registry.edges["work-scan@1"]).toEqual({
      recommendationField: "recommendation",
      edges: {
        DISPATCH: {
          eventType: "factory.dispatch.requested",
          itemsField: "plan",
          itemKey: "ticket",
          input: { repo: "$.artifact.repo" },
        },
      },
    });
  });
});

describe("work chain: scan → chained dispatch proposal (WM-110, WM-119)", () => {
  test("a DISPATCH plan fans out N tickets into separate watched, re-gated dispatch proposals (WM-119)", async () => {
    const { db, planAll, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("wm29", "work-1"));

    const scan = await approveNext("work-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");
    // The scan run's spec pins an immutable SHA (OPS-228): reproducible, and
    // dedup distinguishes "same repo, new commit".
    expect(scan.proposal.spec.input.repoPin).toMatchObject({
      repo: "wm29",
      ref: "develop",
    });
    expect(scan.proposal.spec.input.repoPin.sha).toMatch(/^[0-9a-f]{40}$/);

    // Multi-emit fan-out: every item in plan becomes an admitted internal event.
    const result = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(scan.runId).result_json,
    );
    expect(result.artifact.plan).toHaveLength(2);

    expect(resolveChains(db, registry)).toEqual({
      emitted: 2,
      skipped: 0,
      errors: [],
    });
    const chainEvent1 = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${scan.runId}-${FIRST}`);
    expect(chainEvent1.type).toBe("factory.dispatch.requested");
    expect(chainEvent1.correlation_id).toBe("work-1"); // inherited from the scan's event
    expect(chainEvent1.causation_id).toBe(scan.runId);
    expect(JSON.parse(chainEvent1.envelope_json).payload).toEqual({
      repo: "wm29",
      ticket: FIRST,
    });

    const chainEvent2 = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${scan.runId}-${SECOND}`);
    expect(chainEvent2.type).toBe("factory.dispatch.requested");
    expect(chainEvent2.correlation_id).toBe("work-1");
    expect(chainEvent2.causation_id).toBe(scan.runId);
    expect(JSON.parse(chainEvent2.envelope_json).payload).toEqual({
      repo: "wm29",
      ticket: SECOND,
    });

    // Both chained events are planned through WM-108's gate (injected world) and
    // land as watched proposals with their respective dispatch input shape.
    planAll();
    const dispatches = openProposals(db, {}).filter(
      (p) => p.spec?.agent === "dispatch@1",
    );
    expect(dispatches).toHaveLength(2);
    for (const dispatch of dispatches) {
      expect(dispatch.status).toBe("open"); // watched: nothing mutates without approval
      expect(dispatch.spec.workspace.type).toBe("worktree");
      expect(dispatch.spec.input.repo).toBe("wm29");
    }
    expect(dispatches.map((p) => p.spec.input.ticket).sort()).toEqual(
      [FIRST, SECOND].sort(),
    );

    // One chain pass per run: re-resolving emits nothing new.
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("a LOW_SUPPLY scan no longer chains to a triage scan", async () => {
    // LOW_SUPPLY is still computed as advisory evidence, but it no longer
    // fires a chained triage-scan run (WM: operator decision 2026-08-18,
    // to stop burning the pi/codex adapter's quota on ~30-minute chain
    // loops). The triage floor is now the 8h triage-factory schedule plus
    // manual operator injection of factory.triage.requested.
    const { db, planAll, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("low", "work-low-1"));
    const scan = await approveNext("work-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");
    const scanResult = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(scan.runId).result_json,
    );
    expect(scanResult.artifact.readyCandidates).toBe(0);
    expect(scanResult.artifact.triageBacklog).toBe(3);

    const chain = resolveChains(db, registry);
    expect(chain).toEqual({ emitted: 0, skipped: 1, errors: [] });

    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND causation_id = ?`)
      .get(scan.runId);
    expect(chainEvent).toBeNull();

    planAll();
    expect(
      openProposals(db, {}).find((p) => p.spec?.agent === "triage-scan@1"),
    ).toBeUndefined();
  });

  test("cap-overlap NOOP outcomes still do not fallback to triage", async () => {
    for (const [repo, reason] of [
      ["overlap", "all_overlapping"],
      ["cap", "cap_full"],
    ]) {
      const { db, planAll, approveNext } = harness();
      admitEvent(db, registry, workEnvelope(repo, `work-${repo}-1`));
      const scan = await approveNext("work-scan@1");
      expect(scan.summary.terminalState).toBe("COMPLETED");
      const scanResult = JSON.parse(
        db
          .query(`SELECT result_json FROM results WHERE run_id = ?`)
          .get(scan.runId).result_json,
      );
      expect(scanResult.artifact.noopReason).toBe(reason);
      expect(scanResult.artifact.readyCandidates).toBe(2);
      expect(scanResult.artifact.triageBacklog).toBe(0);

      const chain = resolveChains(db, registry);
      expect(chain).toEqual({ emitted: 0, skipped: 1, errors: [] });

      planAll();
      expect(
        openProposals(db, {}).find((p) => p.spec?.agent === "triage-scan@1"),
      ).toBeUndefined();
      expect(
        openProposals(db, {}).find((p) => p.spec?.agent === "dispatch@1"),
      ).toBeUndefined();
    }
  });

  test("invalid LOW_SUPPLY counts fail verification and do not chain", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("lowbad", "work-lowbad-1"));
    const scan = await approveNext("work-scan@1");
    expect(scan.summary.terminalState).toBe("FAILED");
    expect(scan.summary.reasonCode).toBe("contract_violation");

    const chain = resolveChains(db, registry);
    expect(chain).toEqual({ emitted: 0, skipped: 0, errors: [] });
    expect(
      openProposals(db, {}).find((p) => p.spec?.agent === "triage-scan@1"),
    ).toBeUndefined();

    const journal = db
      .query(
        `SELECT reason FROM lifecycle_events WHERE run_id = ? AND to_state = 'FAILED'`,
      )
      .get(scan.runId);
    expect(journal.reason).toContain("low_supply_readyCandidates_must_be_0");
  });

  test("three ready tickets plus two in progress cannot complete as queue_empty", async () => {
    const { db, approveNext } = harness();
    admitEvent(
      db,
      registry,
      workEnvelope("contradiction", "work-contradiction-1"),
    );
    const scan = await approveNext("work-scan@1");
    expect(scan.summary.terminalState).toBe("FAILED");
    expect(scan.summary.reasonCode).toBe("contract_violation");

    const chain = resolveChains(db, registry);
    expect(chain).toEqual({ emitted: 0, skipped: 0, errors: [] });
    const journal = db
      .query(
        `SELECT reason FROM lifecycle_events WHERE run_id = ? AND to_state = 'FAILED'`,
      )
      .get(scan.runId);
    expect(journal.reason).toContain("queue_empty_candidatesSeen_must_be_0");
  });

  test("a NOOP scan chains to nothing — no dispatch proposal exists", async () => {
    const { db, planAll, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("clean", "work-2"));
    const scan = await approveNext("work-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");

    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 1,
      errors: [],
    });
    planAll();
    expect(
      openProposals(db, {}).find((p) => p.spec?.agent === "dispatch@1"),
    ).toBeUndefined();
  });

  test("re-injecting the same envelope converges: one event, one scan proposal", async () => {
    const { db, planAll } = harness();
    expect(
      admitEvent(db, registry, workEnvelope("wm29", "work-3")).admitted,
    ).toBe(true);
    expect(
      admitEvent(db, registry, workEnvelope("wm29", "work-3")).duplicate,
    ).toBe(true);
    planAll();
    expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(1);
    expect(
      openProposals(db, {}).filter((p) => p.spec?.agent === "work-scan@1"),
    ).toHaveLength(1);
  });

  test("a re-fired scan (new eventId, same repo) plans a NEW run — rolling re-fires are not deduped away", async () => {
    const { db, planAll, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("wm29", "work-4"));
    await approveNext("work-scan@1");

    // Same payload, same pinned SHA — but the idempotency key carries the
    // correlation (planner.mjs suffixes it when the scope omits it), so each
    // re-fire re-reads the queue instead of resolving as duplicate_run.
    admitEvent(db, registry, workEnvelope("wm29", "work-5"));
    planAll();
    const again = openProposals(db, {}).find(
      (p) => p.spec?.agent === "work-scan@1" && p.decision === "run",
    );
    expect(again).toBeTruthy();
    expect(again.reason).toBeNull();
  });

  test("the chained dispatch proposal can be approved and executed through worktree delegation and repo verification (WM-115)", async () => {
    const { db, planAll, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("wm29", "work-exec-1"));
    await approveNext("work-scan@1");
    resolveChains(db, registry);
    planAll();

    const dispatch = await approveNext("dispatch@1");
    expect(dispatch.summary.terminalState).toBe("COMPLETED");
    expect(dispatch.summary.reasonCode).toBe("ok");
    const resultRow = db
      .query(`SELECT result_json FROM results WHERE run_id = ?`)
      .get(dispatch.runId);
    const result = JSON.parse(resultRow.result_json);
    expect(result.artifact.outcome).toBe("PR_OPEN");
    expect(result.verification.checks).toContain("repo_verify_passed");
  });
});
