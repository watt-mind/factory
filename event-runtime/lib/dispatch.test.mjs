import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWorkerLease } from "../../lib/worker-leases.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { planAdmittedEvents, planEvent, worktreeDispatchGate } from "./planner.mjs";
import { approveProposal, openProposals } from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";
import { runOnce } from "./worker.mjs";

const registry = loadRegistry();
const PV = "git:test-pv";

// Hermetic fixtures: repos.yaml + policy.yaml under a temp FACTORY_REPOS_ROOT,
// fake worktree scripts that log every call (the tier-2 provider delegates to
// them, docs/event-runtime-dispatch.md §5), and injected Linear readers — the
// gate's transport is tools/linear.mjs in production, never exercised here.
const fixtures = [];
let repoDir;
let wtRoot;
let callsLog;
let previousReposRoot;
let previousEventHome;

const calls = () => (existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n") : []);

beforeAll(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-factory-"));
  fixtures.push(root);
  repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-repo-")));
  wtRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-trees-")));
  fixtures.push(repoDir, wtRoot);
  callsLog = path.join(repoDir, "calls.log");

  mkdirSync(path.join(repoDir, "bin"), { recursive: true });
  writeFileSync(
    path.join(repoDir, "bin", "worktree-up.sh"),
    `#!/bin/bash\nset -e\necho "up $1" >> "${callsLog}"\nmkdir -p "${wtRoot}/$1"\n`,
  );
  writeFileSync(
    path.join(repoDir, "bin", "worktree-down.sh"),
    `#!/bin/bash\nset -e\necho "down $1" >> "${callsLog}"\nrm -rf "${wtRoot}/$1"\n`,
  );

  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n` +
      `  - name: wt29\n    path: ${repoDir}\n    github: watt-mind/wt29\n    base: develop\n` +
      `    team: WM\n    project: Factory\n    max_in_flight: 1\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
      `    worktree_root: ${wtRoot}\n    verify: echo verified\n` +
      `  - name: watched\n    path: ${repoDir}\n    team: OPS\n    project: Watched\n    report_only: true\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n    worktree_root: ${wtRoot}\n` +
      `  - name: uncapped\n    path: ${repoDir}\n    team: WM\n    project: Factory\n` +
      `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n    worktree_root: ${wtRoot}\n`,
  );
  writeFileSync(path.join(root, "config", "policy.yaml"), `concurrency:\n  max_in_flight_per_repo: 2\n`);

  previousReposRoot = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  previousEventHome = process.env.FACTORY_EVENT_HOME;
  process.env.FACTORY_EVENT_HOME = mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-home-"));
  fixtures.push(process.env.FACTORY_EVENT_HOME);
});

afterAll(() => {
  if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
  else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  if (previousEventHome === undefined) delete process.env.FACTORY_EVENT_HOME;
  else process.env.FACTORY_EVENT_HOME = previousEventHome;
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/** A ticket exactly as `tools/linear.mjs get --json` reports one. */
const readyTicket = (overrides = {}) => ({
  identifier: "WM-500",
  title: "a fully specified ticket",
  state: { name: "Todo" },
  assignee: null,
  labels: { nodes: [{ name: "ai:agent-ready" }] },
  description: "## Owned Paths\n- src/feature-a/**\n",
  ...overrides,
});

/** Gate injection where the world is wide open — override per test. */
const openWorld = (overrides = {}) => ({
  fetchTicket: () => readyTicket(),
  fetchInFlight: () => [],
  countLeases: () => 0,
  ...overrides,
});

const dispatchEnvelope = (payload, eventId = "dispatch-1") => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.dispatch.requested",
  source: "operator",
  subject: payload.ticket ?? null,
  occurredAt: "2026-08-14T09:00:00Z",
  correlationId: eventId,
  payload,
});

function plan(payload, dispatch, eventId = `d-${Math.random().toString(36).slice(2)}`) {
  const db = openDb(":memory:");
  const admitted = admitEvent(db, registry, dispatchEnvelope(payload, eventId));
  expect(admitted.admitted).toBe(true);
  const outcome = planEvent(db, registry, { source: admitted.event.source, eventId: admitted.event.event_id }, {
    policyVersion: PV,
    dispatch,
  });
  return { db, outcome };
}

describe("dispatch planner refusals (WM-108, dispatch doc §§2–5)", () => {
  test("report_only repo → human_needed repo_report_only, no run", () => {
    const { db, outcome } = plan({ repo: "watched", ticket: "WM-500" }, openWorld());
    expect(outcome.decision).toBe("human_needed");
    expect(outcome.reason).toBe("repo_report_only");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
  });

  test("per-repo cap reached → typed NOOP capacity_full, refusal carries its reason", () => {
    const { db, outcome } = plan({ repo: "wt29", ticket: "WM-500" }, openWorld({ countLeases: () => 1 }));
    expect(outcome.decision).toBe("noop");
    expect(outcome.reason).toBe("capacity_full");
    expect(outcome.proposal.status).toBe("resolved");
    expect(db.query(`SELECT status FROM events`).get().status).toBe("noop");
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(0);
  });

  test("the cap counts the dispatcher's own live lease ledger (shared budget, §3)", () => {
    const leaseDir = mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-leases-"));
    fixtures.push(leaseDir);
    writeWorkerLease({ repo: "wt29", ticket: "WM-400", owner: "tick-test", pid: process.pid, dir: leaseDir });
    const refusal = worktreeDispatchGate({ repo: "wt29", ticket: "WM-500" }, openWorld({
      countLeases: (name) => (name === "wt29" ? 1 : 0),
    }));
    expect(refusal).toEqual({ decision: "noop", reason: "capacity_full" });
  });

  test("no max_in_flight on the repo → policy.yaml fallback holds (cap 2)", () => {
    const twoLeases = openWorld({ countLeases: () => 2 });
    expect(worktreeDispatchGate({ repo: "uncapped", ticket: "WM-500" }, twoLeases))
      .toEqual({ decision: "noop", reason: "capacity_full" });
    expect(worktreeDispatchGate({ repo: "uncapped", ticket: "WM-500" }, openWorld({ countLeases: () => 1 })))
      .toBeNull();
  });

  test("assigned ticket → typed NOOP ticket_assigned; never stolen, never queued behind", () => {
    const { outcome } = plan(
      { repo: "wt29", ticket: "WM-500" },
      openWorld({ fetchTicket: () => readyTicket({ assignee: { id: "u1", name: "someone" } }) }),
    );
    expect(outcome.decision).toBe("noop");
    expect(outcome.reason).toBe("ticket_assigned");
  });

  test("ticket not in Todo → NOOP ticket_not_todo; missing ai:agent-ready → NOOP ticket_not_agent_ready", () => {
    const inReview = plan(
      { repo: "wt29", ticket: "WM-500" },
      openWorld({ fetchTicket: () => readyTicket({ state: { name: "In Review" } }) }),
    );
    expect(inReview.outcome).toMatchObject({ decision: "noop", reason: "ticket_not_todo" });

    const unlabelled = plan(
      { repo: "wt29", ticket: "WM-500" },
      openWorld({ fetchTicket: () => readyTicket({ labels: { nodes: [] } }) }),
    );
    expect(unlabelled.outcome).toMatchObject({ decision: "noop", reason: "ticket_not_agent_ready" });
  });

  test("vanished ticket → human_needed ticket_not_found", () => {
    const { outcome } = plan({ repo: "wt29", ticket: "WM-500" }, openWorld({ fetchTicket: () => null }));
    expect(outcome).toMatchObject({ decision: "human_needed", reason: "ticket_not_found" });
  });

  test("Owned Paths overlap with any in-flight ticket → NOOP owned_paths_overlap", () => {
    const { outcome } = plan(
      { repo: "wt29", ticket: "WM-500" },
      openWorld({
        fetchInFlight: () => [
          { identifier: "WM-400", description: "## Owned Paths\n- src/feature-a/api.ts\n" },
        ],
      }),
    );
    expect(outcome).toMatchObject({ decision: "noop", reason: "owned_paths_overlap" });
  });

  test("an in-flight ticket with NO parseable Owned Paths owns everything (imported bias, §4)", () => {
    const refusal = worktreeDispatchGate({ repo: "wt29", ticket: "WM-500" }, openWorld({
      fetchInFlight: () => [{ identifier: "WM-400", description: "no owned paths section at all" }],
    }));
    expect(refusal).toEqual({ decision: "noop", reason: "owned_paths_overlap" });
  });

  test("disjoint Owned Paths do not refuse; the ticket's own In Progress row is ignored", () => {
    const refusal = worktreeDispatchGate({ repo: "wt29", ticket: "WM-500" }, openWorld({
      fetchInFlight: () => [
        { identifier: "WM-401", description: "## Owned Paths\n- src/feature-b/**\n" },
        { identifier: "WM-500", description: "" }, // itself — never self-colliding
      ],
    }));
    expect(refusal).toBeNull();
  });

  test("a Linear transport failure throws — plan_failures/dead-letter own retries, not a one-shot refusal", () => {
    const db = openDb(":memory:");
    const admitted = admitEvent(db, registry, dispatchEnvelope({ repo: "wt29", ticket: "WM-500" }, "d-outage"));
    expect(() =>
      planEvent(db, registry, { source: admitted.event.source, eventId: admitted.event.event_id }, {
        policyVersion: PV,
        dispatch: openWorld({ fetchTicket: () => { throw new Error("linear_read_failed: HTTP 503"); } }),
      }),
    ).toThrow(/linear_read_failed/);
    expect(db.query(`SELECT status FROM events`).get().status).toBe("admitted");
  });
});

describe("dispatch e2e: propose → approve → execute → receipt (WM-108)", () => {
  // A local contract-shaped fake for the claude adapter: the run's value here
  // is the pipeline around it — worktree delegation, verification, receipt —
  // not the model. It proves the delegated tree is reachable where the prompt
  // says (./repo) before reporting success.
  const dispatchFake = {
    async execute({ spec, workspaceDir }) {
      writeFileSync(path.join(workspaceDir, ".transcript.json"), `{"fake":"dispatch transcript"}\n`, "utf8");
      const treeVisible = existsSync(path.join(workspaceDir, "repo"));
      writeFileSync(
        path.join(workspaceDir, "result.json"),
        `${JSON.stringify({
          schemaVersion: "factory.agent-result/v1",
          terminalState: "completed",
          reasonCode: "ok",
          artifact: {
            outcome: "PR_OPEN",
            repo: spec.input.repo,
            ticket: spec.input.ticket,
            prUrl: "https://github.com/watt-mind/wt29/pull/42",
            verification: { command: "echo verified", passed: true, output: "verified" },
            summary: `fake dispatch of ${spec.input.ticket} (tree visible: ${treeVisible})`,
          },
          evidence: { commands: ["fake"], treeVisible },
        }, null, 2)}\n`,
        "utf8",
      );
      return { exitCode: 0, timedOut: false };
    },
  };

  test("an approved dispatch run builds the worktree by delegation, completes, and tears it down", async () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-db-")), "runtime.db"));
    const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-ws-"));
    fixtures.push(path.dirname(db.filename ?? workspaces), workspaces);

    admitEvent(db, registry, dispatchEnvelope({ repo: "wt29", ticket: "WM-501" }, "d-e2e"));
    planAdmittedEvents(db, registry, { policyVersion: PV, dispatch: openWorld() });

    const proposal = openProposals(db, {}).find((p) => p.spec?.agent === "dispatch@1");
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe("open"); // watched: nothing mutates without approval
    expect(proposal.spec.workspace).toEqual({ type: "worktree", checkoutDir: "repo", retainOnFailure: true });
    expect(proposal.spec.input).toEqual({ repo: "wt29", ticket: "WM-501" });
    expect(calls()).not.toContain("up WM-501"); // claim → worktree → spawn: nothing before approval

    const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
    const summary = await runOnce(db, registry, { claude: dispatchFake }, {
      workspacesRoot: workspaces, owner: "w-test", policyVersion: PV,
    });

    expect(summary.terminalState).toBe("COMPLETED");
    expect(summary.reasonCode).toBe("ok");
    expect(summary.receipt).toBeTruthy();
    expect(calls()).toContain("up WM-501");
    expect(calls()).toContain("down WM-501"); // torn down on completion
    expect(existsSync(path.join(wtRoot, "WM-501"))).toBe(false);

    const row = db.query(`SELECT result_json, receipt_json FROM results WHERE run_id = ?`).get(approved.runId);
    const result = JSON.parse(row.result_json);
    expect(result.artifact.outcome).toBe("PR_OPEN");
    expect(result.artifact.prUrl).toContain("/pull/42");
    expect(result.artifact.verification.passed).toBe(true);
    expect(result.evidence.treeVisible).toBe(true);
    expect(JSON.parse(row.receipt_json).runId).toBe(approved.runId);
  });

  test("a failing run without retain still tears the worktree down (down-on-failure)", async () => {
    const db = openDb(":memory:");
    const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-dispatch-ws-"));
    fixtures.push(workspaces);

    admitEvent(db, registry, dispatchEnvelope({ repo: "wt29", ticket: "WM-502" }, "d-fail"));
    planAdmittedEvents(db, registry, { policyVersion: PV, dispatch: openWorld() });
    const proposal = openProposals(db, {}).find((p) => p.spec?.agent === "dispatch@1");
    // dispatch@1 declares retainOnFailure: true; override to prove the
    // non-retained failure path runs worktree_down (WM-108 stage 1 contract).
    const crashing = { async execute() { return { exitCode: 1, timedOut: false }; } };
    approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
    // After approval (which re-verifies the spec hash), flip retainOnFailure
    // off for the claim below — the worker reads the run's spec at claim time.
    const spec = { ...proposal.spec, workspace: { ...proposal.spec.workspace, retainOnFailure: false } };
    db.query(`UPDATE runs SET spec_json = ? WHERE run_id = ?`).run(JSON.stringify(spec), proposal.run_id);

    const summary = await runOnce(db, registry, { claude: crashing }, {
      workspacesRoot: workspaces, owner: "w-test", policyVersion: PV,
    });
    expect(summary.terminalState).toBe("FAILED");
    expect(calls()).toContain("up WM-502");
    expect(calls()).toContain("down WM-502");
    expect(existsSync(path.join(wtRoot, "WM-502"))).toBe(false);
  });
});
