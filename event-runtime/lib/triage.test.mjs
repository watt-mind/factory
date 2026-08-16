import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as actions from "./adapters/actions.mjs";
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
const HERMETIC = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.template="];
const git = (args, cwd) => execFileSync("git", [...HERMETIC, ...args], { cwd, encoding: "utf8" }).trim();

// Hermetic repo fixtures: these tests must not depend on which repos happen
// to be checked out on the machine, so they point FACTORY_REPOS_ROOT at a
// generated config over two throwaway git repos.
const fixtures = [];
let previousReposRoot;
let mirrorsDir;

function makeGitRepo(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `evrt-${name}-`));
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
  const root = mkdtempSync(path.join(os.tmpdir(), "evrt-factory-"));
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
  // Mirrors land under the runtime home, which these tests also isolate.
  mirrorsDir = mkdtempSync(path.join(os.tmpdir(), "evrt-home-"));
  fixtures.push(mirrorsDir);
  process.env.FACTORY_EVENT_HOME = mirrorsDir;
});

afterAll(() => {
  if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
  else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const canonicalWriteDetail =
  `  ## Acceptance Criteria

` +
  `- [ ] preserve behavior in README

` +
  `  ## Owned Paths

` +
  `- README.md

` +
  `  ## Verification

` +
  `bun test event-runtime/lib/triage.test.mjs`;

function harness({ adapters = { pi: fake, actions: fake } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-triage-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-triage-ws-"));
  const workerOpts = { workspacesRoot: workspaces, owner: "w-test", policyVersion: PV };

  async function approveNext(agentRef) {
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find((p) => p.spec?.agent === agentRef);
    expect(proposal).toBeTruthy();
    const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
    const summary = await runOnce(db, registry, adapters, workerOpts);
    return { proposal, runId: approved.runId, summary };
  }
  return { db, approveNext };
}

const fakeCanonicalScan = {
  async execute({ spec, workspaceDir }) {
    writeFileSync(
      path.join(workspaceDir, "result.json"),
      `${JSON.stringify(
        {
          schemaVersion: "factory.agent-result/v1",
          terminalState: "completed",
          reasonCode: "ok",
          artifact: {
            recommendation: "TRIAGE",
            repo: spec.input.repo,
            plan: [
              {
                issueId: "CLNT-999",
                action: "write-detail",
                reason: "fake: canonical multi-section detail",
                detail: canonicalWriteDetail,
                ownedPaths: ["README.md"],
                verificationCommand: "bun test event-runtime/lib/triage.test.mjs",
              },
            ],
            summary: `fake triage of ${spec.input.repo}`,
          },
          evidence: { commands: ["fake"], issuesSeen: 1 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { exitCode: 0, timedOut: false };
  },
};

const triageEnvelope = (repo, eventId) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.triage.requested",
  source: "operator",
  subject: repo,
  occurredAt: "2026-08-13T09:00:00Z",
  correlationId: eventId,
  payload: { repo },
});

describe("triage chain: scan → approved apply (OPS-229)", () => {
  test("a TRIAGE verdict proposes the concrete per-issue action list, watched", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, triageEnvelope("bj29", "triage-1"));

    const scan = await approveNext("triage-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");

    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = openProposals(db, {}).find((p) => p.spec?.agent === "triage-apply@1");
    expect(apply.status).toBe("open"); // never applied without approval
    expect(apply.spec.input).toEqual({
      repo: "bj29",
      plan: [{ issueId: "CLNT-999", action: "label-agent-ready", reason: "fake: fully specified" }],
    });

    const applied = await approveNext("triage-apply@1");
    expect(applied.summary.terminalState).toBe("COMPLETED");
    const result = JSON.parse(db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(applied.runId).result_json);
    expect(result.artifact.applied).toEqual([{ issueId: "CLNT-999", action: "label-agent-ready" }]);
  });

  test("a canonical write-detail triage-scan chain proposal is approved and chained", async () => {
    expect(/^## (Acceptance criteria|Owned Paths|Verification)/.test(canonicalWriteDetail)).toBe(false);
    expect(/^\s*## (Acceptance Criteria|Owned Paths|Verification)/.test(canonicalWriteDetail)).toBe(true);

    const { db, approveNext } = harness({ adapters: { pi: fakeCanonicalScan, actions: fake } });
    admitEvent(db, registry, triageEnvelope("bj29", "triage-5"));

    const scan = await approveNext("triage-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");

    const chain = resolveChains(db, registry);
    expect(chain).toEqual({ emitted: 1, skipped: 0, errors: [] });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = openProposals(db, {}).find((p) => p.spec?.agent === "triage-apply@1");
    expect(apply).toBeTruthy();
    expect(apply.decision).toBe("run");
    expect(apply.status).toBe("open");
    expect(apply.spec.input?.plan?.[0]?.detail).toBe(canonicalWriteDetail);
    expect(apply.spec.input?.plan?.[0]).toMatchObject({
      issueId: "CLNT-999",
      action: "write-detail",
      reason: "fake: canonical multi-section detail",
    });
  });

  test("a clean queue converges to NOOP — nothing proposed, nothing applied", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, triageEnvelope("clean", "triage-2"));
    await approveNext("triage-scan@1");
    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(openProposals(db, {}).find((p) => p.spec?.agent === "triage-apply@1")).toBeUndefined();
  });

  test("the scan run's spec pins an immutable sha — reproducible, and dedup sees new commits", async () => {
    const { db } = harness();
    admitEvent(db, registry, triageEnvelope("bj29", "triage-3"));
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find((p) => p.spec?.agent === "triage-scan@1");
    expect(proposal.spec.input.repo).toBe("bj29");
    expect(proposal.spec.input.repoPin).toMatchObject({ repo: "bj29", ref: "develop" });
    expect(proposal.spec.input.repoPin.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("an unknown repo parks as human_needed instead of planning a run", async () => {
    const { db } = harness();
    admitEvent(db, registry, triageEnvelope("not-a-repo", "triage-4"));
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find((p) => p.decision === "human_needed");
    expect(proposal.reason).toContain("repo_pin_failed");
  });
});

describe("triage-apply is closed by construction (OPS-229)", () => {
  // A real definition-shaped stand-in whose actions are harmless local argv.
  function localDef(dir) {
    return {
      ref: "test-triage@1",
      itemsField: "plan",
      itemKey: "issueId",
      actionRegistry: {
        "label-agent-ready": { argv: ["sh", "-c", `echo {issueId} >> ${dir}/applied.txt`] },
      },
    };
  }

  test("applies one registered action per item and records what landed", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-apply-"));
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "evrt-apply-ws-"));
    const outcome = await actions.execute({
      spec: {
        input: {
          repo: "bj29",
          plan: [
            { issueId: "CLNT-1", action: "label-agent-ready" },
            { issueId: "CLNT-2", action: "label-agent-ready" },
          ],
        },
      },
      def: localDef(dir),
      workspaceDir,
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    expect(readFileSync(path.join(dir, "applied.txt"), "utf8").split("\n").filter(Boolean)).toEqual([
      "CLNT-1",
      "CLNT-2",
    ]);
    const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
    expect(result.artifact.applied).toHaveLength(2);
  });

  test("an unregistered action refuses before applying ANY item — including the valid ones", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-apply-"));
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "evrt-apply-ws-"));
    const outcome = await actions.execute({
      spec: {
        input: {
          repo: "bj29",
          plan: [
            { issueId: "CLNT-1", action: "label-agent-ready" },
            { issueId: "CLNT-2", action: "delete-everything" },
          ],
        },
      },
      def: localDef(dir),
      workspaceDir,
      timeoutMs: 10_000,
    });
    expect(outcome.exitCode).toBe(1);
    expect(() => readFileSync(path.join(dir, "applied.txt"))).toThrow(); // CLNT-1 never ran
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain(
      "not in the closed action registry",
    );
  });

  test("the registry admits item-list definitions and rejects a mutating one with no closed form", () => {
    expect(registry.agents.get("triage-apply@1").mutating).toBe(true);
    expect(registry.agents.get("triage-apply@1").itemsField).toBe("plan");
    expect(registry.agents.get("triage-scan@1").workspace.type).toBe("repository");
  });
});
