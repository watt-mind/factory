/**
 * Closing the loop (WM-112): a finished dispatch re-fires the work-scan —
 * dispatch@1 outcomes PR_OPEN and NOT_CLAIMED chain into
 * factory.work.requested {repo}, so the queue is re-read the moment a slot
 * frees (the latency half of rolling dispatch; the disabled schedules are the
 * heartbeat half). FAILED and BLOCKED terminate: a run that needs a human
 * must not spin the scanner.
 *
 * Follows the ci-doctor precedent (OPS-223) for mapping two verdicts onto one
 * target, and the dispatch e2e harness (WM-108) for the fixtures.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveChains } from "./lib/chain.mjs";
import { openDb } from "./lib/db.mjs";
import { admitEvent } from "./lib/intake.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { approveProposal, openProposals } from "./lib/proposals.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { emitDueTicks } from "./lib/schedules.mjs";
import { runOnce } from "./lib/worker.mjs";

const registry = loadRegistry();
const PV = "git:test-pv";
// See repository.test.mjs: neutralise the operator's global git config so a
// signing key or a global hooks path cannot hang the fixture (OPS-441).
const HERMETIC = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.template="];
const git = (args, cwd) => execFileSync("git", [...HERMETIC, ...args], { cwd, encoding: "utf8" }).trim();

// Hermetic fixtures: a real git repo (the chained work-scan's repository
// workspace pins a SHA) that also carries the worktree scripts the dispatch
// run delegates to. Linear and the lease ledger are injected — nothing here
// touches the network or ~/.factory.
const fixtures = [];
let previousReposRoot;
let previousEventHome;

beforeAll(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-loop-factory-"));
  fixtures.push(root);
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "evrt-loop-repo-"));
  const wtRoot = mkdtempSync(path.join(os.tmpdir(), "evrt-loop-trees-"));
  fixtures.push(repoDir, wtRoot);

  git(["init", "--quiet", "--initial-branch=develop"], repoDir);
  git(["config", "user.email", "test@example.com"], repoDir);
  git(["config", "user.name", "Test"], repoDir);
  writeFileSync(path.join(repoDir, "README.md"), "loop fixture\n");
  git(["add", "."], repoDir);
  git(["commit", "--quiet", "-m", "init"], repoDir);

  mkdirSync(path.join(repoDir, "bin"), { recursive: true });
  writeFileSync(path.join(repoDir, "bin", "worktree-up.sh"), `#!/bin/bash\nset -e\nmkdir -p "${wtRoot}/$1"\n`);
  writeFileSync(path.join(repoDir, "bin", "worktree-down.sh"), `#!/bin/bash\nset -e\nrm -rf "${wtRoot}/$1"\n`);

  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n` +
      `  - name: wt29\n    path: ${repoDir}\n    github: watt-mind/wt29\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 3\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    verify: echo verified\n`,
  );
  writeFileSync(path.join(root, "config", "policy.yaml"), `concurrency:\n  max_in_flight_per_repo: 2\n`);

  previousReposRoot = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  previousEventHome = process.env.FACTORY_EVENT_HOME;
  process.env.FACTORY_EVENT_HOME = mkdtempSync(path.join(os.tmpdir(), "evrt-loop-home-"));
  fixtures.push(process.env.FACTORY_EVENT_HOME);
});

afterAll(() => {
  if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
  else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  if (previousEventHome === undefined) delete process.env.FACTORY_EVENT_HOME;
  else process.env.FACTORY_EVENT_HOME = previousEventHome;
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/** Gate injection where the world is wide open — dispatch.test.mjs owns the refusal matrix. */
const openWorld = {
  fetchTicket: () => ({
    identifier: "WM-600",
    title: "a fully specified ticket",
    state: { name: "Todo" },
    assignee: null,
    labels: { nodes: [{ name: "ai:agent-ready" }] },
    description: "## Owned Paths\n- src/feature-a/**\n",
  }),
  fetchInFlight: () => [],
  countLeases: () => 0,
};

/** A contract-shaped dispatch result for one terminal outcome (dispatch.output.json). */
const dispatchArtifact = (outcome, { repo, ticket }) => ({
  outcome,
  repo,
  ticket,
  prUrl: outcome === "PR_OPEN" ? "https://github.com/watt-mind/wt29/pull/42" : null,
  verification:
    outcome === "PR_OPEN"
      ? { command: "echo verified", passed: true, output: "verified" }
      : { command: null, passed: false, output: "" },
  summary: `fake dispatch terminal ${outcome}`,
});

const dispatchFake = (outcome) => ({
  async execute({ spec, workspaceDir }) {
    writeFileSync(
      path.join(workspaceDir, "result.json"),
      `${JSON.stringify({
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        reasonCode: "ok",
        artifact: dispatchArtifact(outcome, spec.input),
        evidence: { commands: ["fake"] },
      }, null, 2)}\n`,
      "utf8",
    );
    return { exitCode: 0, timedOut: false };
  },
});

/** Admit → plan → approve → execute one dispatch run ending in `outcome`. */
async function dispatchTo(outcome, eventId, ticket) {
  const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), "evrt-loop-db-")), "runtime.db"));
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-loop-ws-"));
  fixtures.push(workspaces);
  const planAll = () => planAdmittedEvents(db, registry, { policyVersion: PV, dispatch: openWorld });

  admitEvent(db, registry, {
    schemaVersion: "factory.event/v1",
    eventId,
    type: "factory.dispatch.requested",
    source: "operator",
    subject: ticket,
    occurredAt: "2026-08-14T09:00:00Z",
    correlationId: eventId,
    causationId: null,
    payload: { repo: "wt29", ticket },
  });
  planAll();
  const proposal = openProposals(db, {}).find((p) => p.spec?.agent === "dispatch@1");
  expect(proposal).toBeTruthy();
  const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
  const summary = await runOnce(db, registry, { claude: dispatchFake(outcome) }, {
    workspacesRoot: workspaces, owner: "w-test", policyVersion: PV,
  });
  expect(summary.terminalState).toBe("COMPLETED");
  return { db, planAll, runId: approved.runId };
}

describe("dispatch-completion edge registration (WM-112)", () => {
  test("PR_OPEN and NOT_CLAIMED both map onto factory.work.requested {repo} — ci-doctor's two-verdicts-one-target shape", () => {
    expect(registry.edges["dispatch@1"]).toEqual({
      recommendationField: "outcome",
      edges: {
        PR_OPEN: { eventType: "factory.work.requested", input: { repo: "$.input.repo" } },
        NOT_CLAIMED: { eventType: "factory.work.requested", input: { repo: "$.input.repo" } },
      },
    });
  });
});

describe("dispatch-completion edge: a finished dispatch re-fires the work-scan (WM-112)", () => {
  test("PR_OPEN chains to work.requested with inherited correlation — and plans a fresh watched scan", async () => {
    const { db, planAll, runId } = await dispatchTo("PR_OPEN", "loop-pr-open", "WM-601");

    expect(resolveChains(db, registry)).toEqual({ emitted: 1, skipped: 0, errors: [] });
    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${runId}`);
    expect(chainEvent.type).toBe("factory.work.requested");
    expect(chainEvent.correlation_id).toBe("loop-pr-open"); // inherited from the dispatch's event
    expect(chainEvent.causation_id).toBe(runId);
    expect(JSON.parse(chainEvent.envelope_json).payload).toEqual({ repo: "wt29" });

    // The latency half of rolling dispatch: the freed slot is re-scanned NOW,
    // through the ordinary planner, as a watched proposal — never auto.
    planAll();
    const scan = openProposals(db, {}).find((p) => p.spec?.agent === "work-scan@1");
    expect(scan).toBeTruthy();
    expect(scan.status).toBe("open");

    // One chain event per run, ever.
    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 0, errors: [] });
  });

  test("NOT_CLAIMED chains the same way — a lost claim frees the slot just as a PR does", async () => {
    const { db, runId } = await dispatchTo("NOT_CLAIMED", "loop-not-claimed", "WM-602");

    expect(resolveChains(db, registry)).toEqual({ emitted: 1, skipped: 0, errors: [] });
    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${runId}`);
    expect(chainEvent.type).toBe("factory.work.requested");
    expect(chainEvent.correlation_id).toBe("loop-not-claimed");
    expect(JSON.parse(chainEvent.envelope_json).payload).toEqual({ repo: "wt29" });
  });

  test("FAILED and BLOCKED terminate: no chain, no work.requested, no scanner spin", async () => {
    for (const [outcome, eventId, ticket] of [
      ["FAILED", "loop-failed", "WM-603"],
      ["BLOCKED", "loop-blocked", "WM-604"],
    ]) {
      const { db, planAll } = await dispatchTo(outcome, eventId, ticket);
      expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
      planAll();
      expect(db.query(`SELECT COUNT(*) AS n FROM events WHERE type = 'factory.work.requested'`).get().n).toBe(0);
      expect(openProposals(db, {}).find((p) => p.spec?.agent === "work-scan@1")).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The heartbeat half (WM-112): work/merge/ship loop schedules per dispatchable
// repo, every one shipped disabled — switching a loop on stays a deliberate
// operator act, and `approval: auto` appears nowhere (WM-107 §7).
// ---------------------------------------------------------------------------

/** The repos in config/repos.yaml that are NOT report_only, enumerated by hand
 *  from the actual file — dispatch doc §5: report_only repos are never loop
 *  targets. coach-wattz, watts-mobile, proxies, hdkiller and eslint-config
 *  are report_only. factory is dispatchable since OPS-463 but its loop
 *  schedules are deliberate follow-up scope, so it is asserted absent below
 *  alongside the report_only set rather than listed here. */
const DISPATCHABLE = ["bj29", "wm-home", "legalease", "cashsaas"];

const loopEntry = (eventType, repo, every) => ({
  every,
  eventType,
  payload: { repo },
  catchUp: "none",
  singleton: true,
  approval: "watched",
  enabled: false,
});

describe("loop schedules ship disabled (WM-112)", () => {
  test("every dispatchable repo gets work/merge every 30m and ship weekly — all off, all watched, all singleton", () => {
    for (const repo of DISPATCHABLE) {
      expect(registry.schedules[`work-${repo}`]).toEqual(loopEntry("factory.work.requested", repo, "30m"));
      expect(registry.schedules[`merge-${repo}`]).toEqual(loopEntry("factory.merge.requested", repo, "30m"));
      expect(registry.schedules[`ship-${repo}`]).toEqual(loopEntry("factory.ship.requested", repo, "7d"));
    }
  });

  test("no loop targets a report_only repo (nor factory, whose loops are follow-up scope), and no loop anywhere declares approval auto", () => {
    for (const repo of ["coach-wattz", "watts-mobile", "proxies", "hdkiller", "eslint-config", "factory"]) {
      expect(registry.schedules[`work-${repo}`]).toBeUndefined();
      expect(registry.schedules[`merge-${repo}`]).toBeUndefined();
      expect(registry.schedules[`ship-${repo}`]).toBeUndefined();
    }
    for (const [loop, schedule] of Object.entries(registry.schedules)) {
      expect({ loop, approval: schedule.approval }).toEqual({ loop, approval: "watched" });
      expect({ loop, enabled: schedule.enabled }).toEqual({ loop, enabled: false });
    }
  });

  test("enabling a loop in a fixture registry fires exactly its event type with its repo payload", () => {
    const cases = [
      ["work-bj29", "factory.work.requested", "bj29"],
      ["merge-wm-home", "factory.merge.requested", "wm-home"],
      ["ship-legalease", "factory.ship.requested", "legalease"],
    ];
    for (const [loop, eventType, repo] of cases) {
      const db = openDb(":memory:");
      const fixture = { ...registry, schedules: { [loop]: { ...registry.schedules[loop], enabled: true } } };
      const outcome = emitDueTicks(db, fixture, { now: Date.parse("2026-08-14T10:05:00Z") });
      expect(outcome.errors).toEqual([]);
      expect(outcome.emitted).toHaveLength(1);
      expect(outcome.emitted[0].loop).toBe(loop);

      const row = db.query(`SELECT envelope_json FROM events`).get();
      const envelope = JSON.parse(row.envelope_json);
      expect(envelope.type).toBe(eventType);
      expect(envelope.source).toBe("schedule");
      expect(envelope.payload).toMatchObject({ repo, loop });
      db.close();
    }
    // WM-112 shipped these loops inert: the scan input schemas rejected the
    // tick bookkeeping fields, parking every tick as human_needed. WM-123
    // whitelisted the fields (repo-loop.input.json's approach) — the describe
    // below proves each tick now plans a real run.
  });

  test("a disabled loop never fires — the shipped default is silence", () => {
    const db = openDb(":memory:");
    expect(emitDueTicks(db, registry, { now: Date.now() }).emitted).toEqual([]);
    expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// First-enable gap closed (WM-123): a real clock tick — payload assembled by
// emitDueTicks itself, never hand-written here — must plan an actual scan run
// for each of the three loop heads, not park as human_needed(invalid_input).
// The scan input schemas whitelist the tick bookkeeping fields exactly the way
// repo-loop.input.json does.
// ---------------------------------------------------------------------------

describe("an enabled loop's tick plans a real scan run (WM-123)", () => {
  /** A fixture registry with exactly one enabled loop for the wt29 test repo. */
  const oneLoop = (loop, eventType) => ({
    ...registry,
    schedules: {
      [loop]: {
        every: "30m", eventType, payload: { repo: "wt29" },
        catchUp: "none", singleton: true, approval: "watched", enabled: true,
      },
    },
  });

  const cases = [
    ["work-wt29", "factory.work.requested", "work-scan@1"],
    ["merge-wt29", "factory.merge.requested", "merge-scan@1"],
    ["ship-wt29", "factory.ship.requested", "ship-scan@1"],
  ];

  for (const [loop, eventType, agent] of cases) {
    test(`${eventType} tick carries {repo, loop, slot, cadenceSeconds, skippedSlots} and plans a watched ${agent} run`, () => {
      const db = openDb(":memory:");
      const fixture = oneLoop(loop, eventType);
      const ticks = emitDueTicks(db, fixture, { now: Date.parse("2026-08-14T10:05:00Z") });
      expect(ticks.errors).toEqual([]);
      expect(ticks.emitted).toHaveLength(1);

      // Pin the payload shape to what the scheduler actually emits — if
      // emitDueTicks ever grows a field, this fails before the schema does.
      const envelope = JSON.parse(db.query(`SELECT envelope_json FROM events`).get().envelope_json);
      expect(Object.keys(envelope.payload).sort()).toEqual(["cadenceSeconds", "loop", "repo", "skippedSlots", "slot"]);

      expect(planAdmittedEvents(db, fixture, { policyVersion: PV })).toEqual({ planned: 1, failed: 0, deadLettered: 0 });
      const proposal = openProposals(db, {}).find((p) => p.spec?.agent === agent);
      expect(proposal).toBeTruthy();
      expect(proposal.decision).toBe("run");
      expect(db.query(`SELECT status FROM events`).get().status).toBe("planned");
      db.close();
    });
  }

  test("plain {repo} payloads (webhook / injected) still plan unchanged", () => {
    for (const [, eventType, agent] of cases) {
      const db = openDb(":memory:");
      admitEvent(db, registry, {
        schemaVersion: "factory.event/v1",
        eventId: `inject-${agent}`,
        type: eventType,
        source: "operator",
        subject: "wt29",
        occurredAt: "2026-08-14T09:00:00Z",
        correlationId: `inject-${agent}`,
        causationId: null,
        payload: { repo: "wt29" },
      });
      expect(planAdmittedEvents(db, registry, { policyVersion: PV })).toEqual({ planned: 1, failed: 0, deadLettered: 0 });
      const proposal = openProposals(db, {}).find((p) => p.spec?.agent === agent);
      expect(proposal).toBeTruthy();
      expect(proposal.decision).toBe("run");
      db.close();
    }
  });
});
