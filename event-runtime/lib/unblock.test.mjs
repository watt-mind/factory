import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-unblock-test-mjs";
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
  const dir = tmpDir("evrt-unblock-");
  fixtures.push(dir);
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = tmpDir("evrt-unblock-ws-");
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

const unblockEnvelope = (repo, eventId) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.unblock.requested",
  source: "operator",
  subject: repo,
  occurredAt: "2026-08-14T09:00:00Z",
  correlationId: eventId,
  payload: { repo },
});

describe("unblock chain: scan → approved apply (WM-73)", () => {
  test("an UNBLOCK verdict proposes the concrete hold-release list, watched", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, unblockEnvelope("bj29", "unblock-1"));

    const scan = await approveNext("unblock-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");
    // The scan's spec pins an immutable sha — reproducible reads.
    expect(scan.proposal.spec.input.repoPin.sha).toMatch(/^[0-9a-f]{40}$/);

    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = openProposals(db, {}).find(
      (p) => p.spec?.agent === "unblock-apply@1",
    );
    expect(apply.status).toBe("open"); // never applied without approval
    expect(apply.spec.input).toEqual({
      repo: "bj29",
      plan: [
        {
          issueId: "CLNT-998",
          action: "release-to-triage",
          reason: "fake: dependency merged",
        },
        {
          issueId: "CLNT-998",
          action: "comment-evidence",
          reason: "fake: dependency merged",
        },
      ],
    });

    const applied = await approveNext("unblock-apply@1");
    expect(applied.summary.terminalState).toBe("COMPLETED");
    const result = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(applied.runId).result_json,
    );
    expect(result.artifact.applied).toEqual([
      { issueId: "CLNT-998", action: "release-to-triage" },
      { issueId: "CLNT-998", action: "comment-evidence" },
    ]);
  });

  test("no hold with new evidence converges to NOOP — nothing proposed, nothing applied", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, unblockEnvelope("clean", "unblock-2"));
    await approveNext("unblock-scan@1");
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 1,
      errors: [],
    });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      openProposals(db, {}).find((p) => p.spec?.agent === "unblock-apply@1"),
    ).toBeUndefined();
  });

  test("the apply registry cannot add ai:blocked or touch anything but the closed verbs", () => {
    const def = registry.agents.get("unblock-apply@1");
    expect(Object.keys(def.actionRegistry).sort()).toEqual([
      "comment-evidence",
      "release-hold",
      "release-to-triage",
    ]);
    for (const action of Object.values(def.actionRegistry)) {
      expect(action.argv[0]).toBe("bun");
      expect(action.argv[1]).toBe("{factoryRoot}/tools/ticket.mjs");
      expect(action.argv).not.toContain("ai:blocked-add");
    }
  });
});
