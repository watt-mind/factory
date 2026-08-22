import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-sweep-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { resolveChains } from "./chain.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { approveProposal, openProposals } from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";
import { runOnce } from "./worker.mjs";

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

const fixtures = [];
let previousReposRoot;
let previousHome;

function makeGitRepo(name) {
  const dir = tmpDir(`evrt-${name}-`);
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
  const root = tmpDir("evrt-factory-");
  fixtures.push(root);
  mkdirSync(path.join(root, "config"), { recursive: true });
  const bj29 = makeGitRepo("bj29");
  const clean = makeGitRepo("clean");
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `repos:\n` +
      `  - name: bj29\n    path: ${bj29}\n    github: watt-mind/bj29\n    base: develop\n` +
      `  - name: clean\n    path: ${clean}\n    github: watt-mind/clean\n    base: develop\n`,
  );
  previousReposRoot = process.env.FACTORY_REPOS_ROOT;
  process.env.FACTORY_REPOS_ROOT = root;
  previousHome = process.env.FACTORY_EVENT_HOME;
  const home = tmpDir("evrt-home-");
  fixtures.push(home);
  process.env.FACTORY_EVENT_HOME = home;
});

afterAll(() => {
  if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
  else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  if (previousHome === undefined) delete process.env.FACTORY_EVENT_HOME;
  else process.env.FACTORY_EVENT_HOME = previousHome;
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = tmpDir("evrt-sweep-");
  fixtures.push(dir);
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = tmpDir("evrt-sweep-ws-");
  fixtures.push(workspaces);
  const adapters = { pi: fake, actions: fake };
  const workerOpts = {
    workspacesRoot: workspaces,
    owner: "w-test",
    policyVersion: PV,
  };

  async function approveNext(agentRef) {
    planAdmittedEvents(db, registry, { policyVersion: PV });
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
  return { db, approveNext };
}

const sweepEnvelope = (repo, eventId) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.sweep.requested",
  source: "operator",
  subject: repo,
  occurredAt: "2026-08-14T09:00:00Z",
  correlationId: eventId,
  payload: { repo },
});

describe("sweep chain: scan → approved apply (WM-74)", () => {
  test("a SWEEP verdict proposes the concrete retirement list, watched", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, sweepEnvelope("bj29", "sweep-1"));

    const scan = await approveNext("sweep-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");
    expect(scan.proposal.spec.input.repoPin.sha).toMatch(/^[0-9a-f]{40}$/);

    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = openProposals(db, {}).find(
      (p) => p.spec?.agent === "sweep-apply@1",
    );
    expect(apply.status).toBe("open"); // retirement never happens unapproved
    expect(apply.spec.input).toEqual({
      repo: "bj29",
      plan: [
        {
          issueId: "CLNT-997",
          action: "retire-shipped",
          reason: "fake: shipped in PR #1",
        },
        {
          issueId: "CLNT-997",
          action: "comment-evidence",
          reason: "fake: shipped in PR #1",
        },
      ],
    });

    const applied = await approveNext("sweep-apply@1");
    expect(applied.summary.terminalState).toBe("COMPLETED");
    const result = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(applied.runId).result_json,
    );
    expect(result.artifact.applied).toEqual([
      { issueId: "CLNT-997", action: "retire-shipped" },
      { issueId: "CLNT-997", action: "comment-evidence" },
    ]);
  });

  test("nothing retirable converges to NOOP — nothing proposed, nothing applied", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, sweepEnvelope("clean", "sweep-2"));
    await approveNext("sweep-scan@1");
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 1,
      errors: [],
    });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      openProposals(db, {}).find((p) => p.spec?.agent === "sweep-apply@1"),
    ).toBeUndefined();
  });

  test("the apply registry is state transitions and comments only — no delete, no archive", () => {
    const def = registry.agents.get("sweep-apply@1");
    expect(Object.keys(def.actionRegistry).sort()).toEqual([
      "comment-evidence",
      "mark-duplicate",
      "retire-shipped",
    ]);
    for (const action of Object.values(def.actionRegistry)) {
      expect(action.argv[1]).toBe("{factoryRoot}/tools/ticket.mjs");
      expect(["state", "comment"]).toContain(action.argv[2]);
    }
  });
});
