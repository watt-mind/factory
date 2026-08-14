/**
 * Work chain (WM-110): work-scan@1 reads a repo's agent-ready Linear queue
 * against a pinned tree and emits a typed DISPATCH plan; the chain edge feeds
 * the FIRST planned ticket into factory.dispatch.requested, where WM-108's
 * plan-time gate re-checks the world — a stale scan cannot force a dispatch.
 * chain.mjs emits exactly one chain event per run (eventId chain-<runId>), so
 * the rest of the plan rides in the artifact as `deferred`; rolling dispatch
 * comes from re-firing the scan event, never a long-lived loop. Follows the
 * triage-scan (OPS-229) and merge-scan (WM-109) precedents.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fake from "./lib/adapters/fake.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { openDb } from "./lib/db.mjs";
import { admitEvent } from "./lib/intake.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { approveProposal, openProposals } from "./lib/proposals.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { runOnce } from "./lib/worker.mjs";

const registry = loadRegistry();
const PV = "git:test-pv";
// See repository.test.mjs: neutralise the operator's global git config so a
// signing key or a global hooks path cannot hang the fixture (OPS-441).
const HERMETIC = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.template="];
const git = (args, cwd) => execFileSync("git", [...HERMETIC, ...args], { cwd, encoding: "utf8" }).trim();

// Hermetic repo fixtures: a real git repo (the scan's repository workspace
// pins a SHA) whose config also carries the worktree scripts and team/project
// the chained dispatch plan is gated on. Linear and the lease ledger are
// injected — no test here touches the network or ~/.factory.
const fixtures = [];
let previousReposRoot;
let previousEventHome;

function makeGitRepo(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `evrt-work-${name}-`));
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
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-work-factory-"));
  fixtures.push(root);
  mkdirSync(path.join(root, "config"), { recursive: true });
  const wm29 = makeGitRepo("wm29");
  const clean = makeGitRepo("clean");
  const wtRoot = mkdtempSync(path.join(os.tmpdir(), "evrt-work-trees-"));
  fixtures.push(wtRoot);
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n` +
      `  - name: wm29\n    path: ${wm29}\n    github: watt-mind/wm29\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    verify: echo verified\n` +
      `  - name: clean\n    path: ${clean}\n    github: watt-mind/clean\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n`,
  );
  previousReposRoot = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  previousEventHome = process.env.FACTORY_EVENT_HOME;
  process.env.FACTORY_EVENT_HOME = mkdtempSync(path.join(os.tmpdir(), "evrt-work-home-"));
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

function workScanArtifact(repo) {
  if (repo === "clean") {
    return {
      recommendation: "NOOP",
      repo,
      ticket: null,
      plan: [],
      deferred: [],
      summary: "fake: no dispatchable tickets",
      noopReason: "queue_empty",
    };
  }
  return {
    recommendation: "DISPATCH",
    repo,
    ticket: FIRST,
    plan: [
      { ticket: FIRST, ownedPaths: ["src/feature-a/**"], reason: "fake: priority 1, disjoint" },
      { ticket: SECOND, ownedPaths: ["src/feature-b/**"], reason: "fake: priority 2, disjoint" },
    ],
    deferred: [SECOND],
    summary: `fake work plan for ${repo}`,
  };
}

const workFake = {
  async execute(opts) {
    const { spec, workspaceDir } = opts;
    if (spec.outputContract === "factory.work-plan/v1") {
      writeFileSync(
        path.join(workspaceDir, "result.json"),
        `${JSON.stringify({
          schemaVersion: "factory.agent-result/v1",
          terminalState: "completed",
          reasonCode: "ok",
          artifact: workScanArtifact(spec.input.repo),
          evidence: { commands: ["fake"], candidatesSeen: 2, inFlightSeen: 0 },
        }, null, 2)}\n`,
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
  fetchTicket: () => ({
    identifier: FIRST,
    title: "a fully specified ticket",
    state: { name: "Todo" },
    assignee: null,
    labels: { nodes: [{ name: "ai:agent-ready" }] },
    description: "## Owned Paths\n- src/feature-a/**\n",
  }),
  fetchInFlight: () => [],
  countLeases: () => 0,
};

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-work-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-work-ws-"));
  const adapters = { claude: workFake };
  const workerOpts = { workspacesRoot: workspaces, owner: "w-test", policyVersion: PV };

  const planAll = () => planAdmittedEvents(db, registry, { policyVersion: PV, dispatch: openWorld });

  async function approveNext(agentRef) {
    planAll();
    const proposal = openProposals(db, {}).find((p) => p.spec?.agent === agentRef);
    expect(proposal).toBeTruthy();
    const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
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
  test("work-scan@1 is a read-only claude agent over a repository workspace, like triage-scan", () => {
    const def = registry.agents.get("work-scan@1");
    expect(def.mutating).toBe(false);
    // It verifies Owned Paths globs against real paths, so it reads the
    // pinned tree — repository checkout, never a mutable worktree.
    expect(def.workspace).toEqual({ type: "repository", checkoutDir: "repo", retainOnFailure: true });
    expect(def.output_contract).toBe("factory.work-plan/v1");
    expect(def.capabilities.services).toEqual(["linear:read", "repo:read"]);
  });

  test("factory.work.requested maps to work-scan@1 on the claude adapter, deduped by inputHash", () => {
    expect(registry.eventTypes["factory.work.requested"]).toEqual({
      agent: "work-scan@1",
      adapter: "claude",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
  });

  test("the plan item shape pins {ticket, ownedPaths, reason}; NOOP reasons are the closed set", () => {
    const schema = registry.agents.get("work-scan@1").outputSchema;
    expect(schema.properties.plan.items.required).toEqual(["ticket", "ownedPaths", "reason"]);
    expect(schema.properties.plan.items.properties.ticket.pattern).toBe("^[A-Z]+-[0-9]+$");
    expect(schema.properties.noopReason.enum).toEqual(["queue_empty", "cap_full", "all_overlapping"]);
  });

  test("the DISPATCH edge is single-emit by construction: one {repo, ticket} into factory.dispatch.requested", () => {
    // chain.mjs derives eventId chain-<runId> — one chain event per run, ever
    // — so the edge carries exactly the artifact's single dispatch target and
    // the rest of the plan stays in `deferred`.
    expect(registry.edges["work-scan@1"]).toEqual({
      recommendationField: "recommendation",
      edges: {
        DISPATCH: {
          eventType: "factory.dispatch.requested",
          input: { repo: "$.artifact.repo", ticket: "$.artifact.ticket" },
        },
      },
    });
  });
});

describe("work chain: scan → chained dispatch proposal (WM-110)", () => {
  test("a DISPATCH plan chains its first ticket into a watched, re-gated dispatch proposal", async () => {
    const { db, planAll, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("wm29", "work-1"));

    const scan = await approveNext("work-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");
    // The scan run's spec pins an immutable SHA (OPS-228): reproducible, and
    // dedup distinguishes "same repo, new commit".
    expect(scan.proposal.spec.input.repoPin).toMatchObject({ repo: "wm29", ref: "develop" });
    expect(scan.proposal.spec.input.repoPin.sha).toMatch(/^[0-9a-f]{40}$/);

    // The single-emit shape: only plan[0] chains; the rest is recorded, typed.
    const result = JSON.parse(db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(scan.runId).result_json);
    expect(result.artifact.ticket).toBe(FIRST);
    expect(result.artifact.deferred).toEqual([SECOND]);

    expect(resolveChains(db, registry)).toEqual({ emitted: 1, skipped: 0, errors: [] });
    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${scan.runId}`);
    expect(chainEvent.type).toBe("factory.dispatch.requested");
    expect(chainEvent.correlation_id).toBe("work-1"); // inherited from the scan's event
    expect(chainEvent.causation_id).toBe(scan.runId);

    // The chained event is planned through WM-108's gate (injected world) and
    // lands as its own watched proposal with exactly the dispatch input shape.
    planAll();
    const dispatch = openProposals(db, {}).find((p) => p.spec?.agent === "dispatch@1");
    expect(dispatch).toBeTruthy();
    expect(dispatch.status).toBe("open"); // watched: nothing mutates without approval
    expect(dispatch.spec.input).toEqual({ repo: "wm29", ticket: FIRST });
    expect(dispatch.spec.workspace.type).toBe("worktree");

    // One chain event per run, ever: re-resolving emits nothing new.
    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 0, errors: [] });
  });

  test("a NOOP scan chains to nothing — no dispatch proposal exists", async () => {
    const { db, planAll, approveNext } = harness();
    admitEvent(db, registry, workEnvelope("clean", "work-2"));
    const scan = await approveNext("work-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");

    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
    planAll();
    expect(openProposals(db, {}).find((p) => p.spec?.agent === "dispatch@1")).toBeUndefined();
  });

  test("re-injecting the same envelope converges: one event, one scan proposal", async () => {
    const { db, planAll } = harness();
    expect(admitEvent(db, registry, workEnvelope("wm29", "work-3")).admitted).toBe(true);
    expect(admitEvent(db, registry, workEnvelope("wm29", "work-3")).duplicate).toBe(true);
    planAll();
    expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(1);
    expect(openProposals(db, {}).filter((p) => p.spec?.agent === "work-scan@1")).toHaveLength(1);
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
    const again = openProposals(db, {}).find((p) => p.spec?.agent === "work-scan@1" && p.decision === "run");
    expect(again).toBeTruthy();
    expect(again.reason).toBeNull();
  });
});
