/**
 * Ship chain (WM-111): ship-scan@1 assembles the release candidate — base
 * ahead of the deploy branch, real checks green on the head commit, changelog
 * of shipped tickets — and emits a typed, double-SHA-pinned plan. The watched
 * approval of the chained ship-apply proposal IS the human deploy-branch
 * decision (docs/event-runtime-dispatch.md §7): it is permanently watched,
 * structurally — auto approval of the ship-apply event type cannot load and
 * cannot execute. Follows the merge chain precedent (WM-109).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fake from "./lib/adapters/fake.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { RUNTIME_ROOT } from "./lib/config.mjs";
import { openDb } from "./lib/db.mjs";
import { admitEvent } from "./lib/intake.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { approveProposal, getProposal, openProposals } from "./lib/proposals.mjs";
import { RegistryError, loadRegistry } from "./lib/registry.mjs";
import { runState } from "./lib/lifecycle.mjs";
import { SCHEDULE_SOURCE } from "./lib/schedules.mjs";
import { runOnce } from "./lib/worker.mjs";

const registry = loadRegistry();

const PV = "git:test-pv";
const BASE_SHA = "a".repeat(40);
const DEPLOY_SHA = "b".repeat(40);
const MOVED_SHA = "c".repeat(40);

describe("ship-scan registration (WM-111)", () => {
  test("ship-scan@1 is a read-only claude agent with no repository workspace", () => {
    const def = registry.agents.get("ship-scan@1");
    expect(def.mutating).toBe(false);
    // It reads branches and CI via gh, not a source tree — ephemeral, like
    // merge-scan, never a repository checkout.
    expect(def.workspace.type).toBe("ephemeral");
    expect(def.output_contract).toBe("factory.ship-plan/v1");
    expect(def.capabilities.services).toContain("gh:read");
  });

  test("factory.ship.requested maps to ship-scan@1 on the claude adapter, deduped by inputHash", () => {
    expect(registry.eventTypes["factory.ship.requested"]).toEqual({
      agent: "ship-scan@1",
      adapter: "claude",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
  });

  test("the artifact pins BOTH branch tips — a moved base or deploy head is detectable at apply time", () => {
    const props = registry.agents.get("ship-scan@1").outputSchema.properties;
    expect(props.headSha.pattern).toBe("^[0-9a-f]{40}$");
    expect(props.deployHeadSha.pattern).toBe("^[0-9a-f]{40}$");
    expect(props.recommendation.enum).toEqual(["SHIP", "NOOP"]);
    // The plan is the closed ship set, nothing else nameable.
    expect(props.plan.items.properties.action.enum).toEqual(["open_rc_pr", "merge_rc_pr", "smoke_check"]);
    // NOOP is typed: not ahead, CI red/pending, no real checks, or no deploy config.
    expect(props.noopReason.enum).toEqual(["not_ahead", "ci_red", "ci_pending", "no_checks", "no_deploy_config"]);
  });
});

/**
 * Run the REAL ship-apply@1 registry definition against shimmed `gh`,
 * `factory` (and the real `bun` for the smoke helper): the probe → act flow
 * executes exactly the registered templates, but nothing reaches GitHub or
 * Telegram. Branch reads answer from $FAKE_BASE_HEAD / $FAKE_DEPLOY_HEAD, PR
 * reads from $FAKE_OPEN_PRS / $FAKE_PR_HEAD; every mutating call is appended
 * to $SHIM_LOG.
 */
async function runApply(plan, env = {}) {
  const shims = mkdtempSync(path.join(os.tmpdir(), "evrt-ship-shims-"));
  const log = path.join(shims, "shim.log");
  writeFileSync(
    path.join(shims, "gh"),
    `#!/bin/sh
if [ "$1" = "api" ]; then
  case "$2" in
    */branches/develop) echo "$FAKE_BASE_HEAD" ;;
    */branches/master) echo "$FAKE_DEPLOY_HEAD" ;;
    *) echo "unexpected gh api $2" >&2; exit 1 ;;
  esac
elif [ "$1 $2" = "pr list" ]; then
  case "$*" in
    *"--jq length"*) echo "\${FAKE_OPEN_PRS:-0}" ;;
    *) if [ "\${FAKE_OPEN_PRS:-0}" != "0" ]; then echo "7"; fi ;;
  esac
elif [ "$1 $2" = "pr view" ]; then
  echo "$FAKE_PR_HEAD"
else
  echo "gh $*" >> "$SHIM_LOG"
fi
`,
  );
  writeFileSync(path.join(shims, "factory"), `#!/bin/sh\necho "factory $*" >> "$SHIM_LOG"\n`);
  chmodSync(path.join(shims, "gh"), 0o755);
  chmodSync(path.join(shims, "factory"), 0o755);

  const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
  const driver = path.join(shims, "driver.mjs");
  writeFileSync(
    driver,
    `import * as actions from ${JSON.stringify(path.join(runtimeRoot, "lib", "adapters", "actions.mjs"))};\n` +
      `import { loadRegistry } from ${JSON.stringify(path.join(runtimeRoot, "lib", "registry.mjs"))};\n` +
      `const outcome = await actions.execute({\n` +
      `  spec: { input: JSON.parse(process.argv[2]) },\n` +
      `  def: loadRegistry().agents.get("ship-apply@1"),\n` +
      `  workspaceDir: process.argv[3],\n` +
      `  timeoutMs: 20_000,\n` +
      `});\n` +
      `console.log(JSON.stringify(outcome));\n`,
  );

  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "evrt-ship-ws-"));
  const input = {
    repo: "bj29",
    github: "watt-mind/bj29",
    base: "develop",
    deployBranch: "master",
    headSha: BASE_SHA,
    deployHeadSha: DEPLOY_SHA,
    changelog: [],
    plan,
  };
  const proc = spawnSync("bun", [driver, JSON.stringify(input), workspaceDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shims}:${process.env.PATH}`,
      FAKE_BASE_HEAD: BASE_SHA,
      FAKE_DEPLOY_HEAD: DEPLOY_SHA,
      FAKE_PR_HEAD: BASE_SHA,
      FAKE_OPEN_PRS: "0",
      SHIM_LOG: log,
      SHIP_SMOKE_DEADLINE_SECONDS: "0",
      ...env,
    },
  });
  expect(proc.status).toBe(0);
  return { outcome: JSON.parse(proc.stdout.trim().split("\n").at(-1)), workspaceDir, log };
}

describe("ship-apply is closed by construction (WM-111)", () => {
  test("the registry admits ship-apply@1 as an item-list definition with exactly the three closed actions", () => {
    const def = registry.agents.get("ship-apply@1");
    expect(def.mutating).toBe(true);
    expect(def.itemsField).toBe("plan");
    // A release plan has one step per action, not one per ticket — the item
    // key IS the action id (recorded as issueId by the item-list adapter).
    expect(def.itemKey).toBe("action");
    expect(Object.keys(def.actionRegistry).sort()).toEqual(["merge_rc_pr", "open_rc_pr", "smoke_check"]);
    // Every script substitutes only trailing positional args — never into the script text.
    expect(def.actionRegistry.open_rc_pr.argv.slice(-6)).toEqual([
      "{github}", "{base}", "{headSha}", "{deployBranch}", "{title}", "{body}",
    ]);
    expect(def.actionRegistry.merge_rc_pr.argv.slice(-5)).toEqual([
      "{github}", "{deployBranch}", "{deployHeadSha}", "{base}", "{headSha}",
    ]);
    expect(def.actionRegistry.smoke_check.argv.slice(-6)).toEqual([
      "{github}", "{smokeBranch}", "{url}", "{factoryRoot}", "{repo}", "{revisionField}",
    ]);
    // A release PR merges with a merge commit — never squash, never
    // --delete-branch (its head is the integration branch): factory-ship §4.
    const mergeScript = def.actionRegistry.merge_rc_pr.argv[2];
    expect(mergeScript).toContain("gh pr merge");
    expect(mergeScript).toContain("--merge");
    expect(mergeScript).not.toContain("--squash");
    expect(mergeScript).not.toContain("--delete-branch");
    // Smoke reuses the factory-status freshness helpers, and never reverts.
    expect(def.actionRegistry.smoke_check.argv[2]).toContain("lib/repo-status.mjs");
    expect(def.actionRegistry.smoke_check.argv[2]).toContain("SMOKE RED");
  });

  test("factory.ship-apply.requested maps to ship-apply@1 on the actions adapter — and is humanApprovalOnly", () => {
    expect(registry.eventTypes["factory.ship-apply.requested"]).toEqual({
      agent: "ship-apply@1",
      adapter: "actions",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
      humanApprovalOnly: true,
    });
  });

  test("open_rc_pr probes the base head and opens the release PR when it matches the pin", async () => {
    const { outcome, log } = await runApply([
      { action: "open_rc_pr", title: "release: develop → master (2026-08-14)", body: "the changelog" },
    ]);
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const shimLog = readFileSync(log, "utf8");
    expect(shimLog).toContain(
      "gh pr create --repo watt-mind/bj29 --base master --head develop --title release: develop → master (2026-08-14) --body the changelog",
    );
  });

  test("open_rc_pr reuses an existing open release PR instead of stacking a second", async () => {
    const { outcome, log } = await runApply(
      [{ action: "open_rc_pr", title: "release: develop → master (2026-08-14)", body: "the changelog" }],
      { FAKE_OPEN_PRS: "1" },
    );
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    expect(existsSync(log)).toBe(false); // nothing mutating ran
  });

  test("a moved base head is a refusal, not a blind release: the PR never opens", async () => {
    const { outcome, workspaceDir, log } = await runApply(
      [{ action: "open_rc_pr", title: "release: develop → master (2026-08-14)", body: "the changelog" }],
      { FAKE_BASE_HEAD: MOVED_SHA },
    );
    expect(outcome.exitCode).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain("refusing open_rc_pr");
  });

  test("merge_rc_pr waits on the PR's checks, then merges with a merge commit", async () => {
    const { outcome, log } = await runApply([{ action: "merge_rc_pr" }], { FAKE_OPEN_PRS: "1" });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const shimLog = readFileSync(log, "utf8");
    expect(shimLog).toContain("gh pr checks 7 --repo watt-mind/bj29 --watch --fail-fast");
    expect(shimLog).toContain("gh pr merge 7 --repo watt-mind/bj29 --merge");
    expect(shimLog).not.toContain("--squash");
    expect(shimLog).not.toContain("--delete-branch");
  });

  test("a deploy branch that moved since the scan refuses the merge — someone committed to it directly", async () => {
    const { outcome, workspaceDir, log } = await runApply([{ action: "merge_rc_pr" }], {
      FAKE_OPEN_PRS: "1",
      FAKE_DEPLOY_HEAD: MOVED_SHA,
    });
    expect(outcome.exitCode).toBe(1);
    expect(existsSync(log)).toBe(false); // the merge never executed
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain("refusing merge_rc_pr");
  });

  test("a release PR head that is not the scanned pin refuses the merge", async () => {
    const { outcome, workspaceDir, log } = await runApply([{ action: "merge_rc_pr" }], {
      FAKE_OPEN_PRS: "1",
      FAKE_PR_HEAD: MOVED_SHA,
    });
    expect(outcome.exitCode).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain("refusing release PR #7");
  });

  // The endpoint runs as a child process: runApply's spawnSync blocks this
  // process's event loop, so an in-process Bun.serve could never answer.
  async function withSmokeServer(payload, fn) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-ship-smoke-"));
    const script = path.join(dir, "server.mjs");
    writeFileSync(
      script,
      `const server = Bun.serve({ port: 0, fetch: () => Response.json(${JSON.stringify(payload)}) });\nconsole.log(server.port);\n`,
    );
    const proc = Bun.spawn(["bun", script], { stdout: "pipe" });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const port = Number(new TextDecoder().decode(value).trim());
    expect(port).toBeGreaterThan(0);
    try {
      return await fn(port);
    } finally {
      proc.kill();
    }
  }

  test("smoke_check goes green when the endpoint serves the deployed branch's tip (factory-status form)", async () => {
    await withSmokeServer({ revision: BASE_SHA }, async (port) => {
      const { outcome, workspaceDir } = await runApply([
        { action: "smoke_check", url: `http://127.0.0.1:${port}`, smokeBranch: "develop", revisionField: "" },
      ]);
      expect(outcome).toEqual({ exitCode: 0, timedOut: false });
      const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
      expect(result.artifact).toEqual({ repo: "bj29", applied: [{ issueId: "smoke_check", action: "smoke_check" }] });
    });
  }, 20_000);

  test("smoke red pushes SMOKE RED and fails the attempt — never an auto-revert", async () => {
    await withSmokeServer({ revision: "0123456789abcdef" }, async (port) => {
      const { outcome, workspaceDir, log } = await runApply([
        { action: "smoke_check", url: `http://127.0.0.1:${port}`, smokeBranch: "develop", revisionField: "" },
      ]);
      expect(outcome.exitCode).toBe(1);
      expect(readFileSync(log, "utf8")).toContain("factory notify SMOKE RED bj29:");
      expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain("smoke red");
      // Never auto-revert: the only mutation a red smoke performs is the push.
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    });
  }, 20_000);

  test("an unregistered action refuses before applying ANY item — including the valid ones", async () => {
    const { outcome, workspaceDir, log } = await runApply([
      { action: "merge_rc_pr" },
      { action: "revert_release" },
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain(
      "not in the closed action registry",
    );
  });
});

// ---------------------------------------------------------------------------
// The structural block (docs/event-runtime-dispatch.md §7, WM-111): the
// deploy-branch merge decision is PERMANENTLY the human's. Two fail-closed
// layers, both tested by ATTEMPTING the auto path: config that would delete
// the decision cannot load, and an approval by any non-operator actor is
// rejected at the single choke point every approval goes through.
// ---------------------------------------------------------------------------

const applyPayload = {
  repo: "bj29",
  github: "watt-mind/bj29",
  base: "develop",
  deployBranch: "master",
  headSha: BASE_SHA,
  deployHeadSha: DEPLOY_SHA,
  changelog: [{ sha: BASE_SHA, subject: "fix(app): guard null session (CLNT-123)", ticket: "CLNT-123" }],
  plan: [
    { action: "open_rc_pr", title: "release: develop → master (2026-08-14)", body: "the changelog" },
    { action: "merge_rc_pr" },
  ],
};

function openShipApplyProposal(db) {
  admitEvent(db, registry, {
    schemaVersion: "factory.event/v1",
    eventId: "ship-apply-direct-1",
    type: "factory.ship-apply.requested",
    source: "operator",
    subject: "bj29",
    occurredAt: "2026-08-14T09:00:00Z",
    correlationId: "ship-apply-direct-1",
    payload: applyPayload,
  });
  planAdmittedEvents(db, registry, { policyVersion: PV });
  const proposal = openProposals(db, {}).find((p) => p.spec?.agent === "ship-apply@1");
  expect(proposal).toBeTruthy();
  return proposal;
}

describe("ship-apply approval is structurally human-only (WM-111)", () => {
  test("schedules.json declaring approval auto on the ship-apply event type cannot load", () => {
    // Copy the real registry into a temp root so the test can corrupt it safely.
    const root = mkdtempSync(path.join(os.tmpdir(), "evrt-ship-registry-"));
    for (const dir of ["agents", "schemas"]) {
      cpSync(path.join(RUNTIME_ROOT, dir), path.join(root, dir), { recursive: true });
    }
    cpSync(path.join(RUNTIME_ROOT, "event-types.json"), path.join(root, "event-types.json"));
    const withApproval = (approval) =>
      writeFileSync(
        path.join(root, "schedules.json"),
        JSON.stringify({
          "ship-apply-creep": { every: "1h", eventType: "factory.ship-apply.requested", approval, enabled: true },
        }),
      );
    withApproval("auto");
    expect(() => loadRegistry({ root })).toThrow(RegistryError);
    expect(() => loadRegistry({ root })).toThrow(/humanApprovalOnly/);
    // Watched is the permanent mode — the same loop loads fine watched.
    withApproval("watched");
    expect(() => loadRegistry({ root })).not.toThrow();
  });

  test("a schedule-actor approval attempt is rejected fail-closed with a typed reason — then the human's still works", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-ship-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const proposal = openShipApplyProposal(db);

    // The exact call autoApproveScheduled makes (lib/schedules.mjs): actor
    // "schedule" through approveProposal. There is no other approval path.
    let rejection;
    try {
      approveProposal(db, registry, proposal.id, { actor: SCHEDULE_SOURCE, policyVersion: PV });
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBeTruthy();
    expect(rejection.code).toBe("human_approval_only");
    expect(rejection.message).toContain("humanApprovalOnly");

    // Fail-closed means NOTHING moved: proposal still open, run still PROPOSED.
    expect(getProposal(db, proposal.id).status).toBe("open");
    expect(runState(db, proposal.run_id)).toBe("PROPOSED");

    // Any other machine actor is rejected identically — the gate allowlists
    // the human operator; it does not blocklist known robots.
    expect(() => approveProposal(db, registry, proposal.id, { actor: "chain", policyVersion: PV })).toThrow(
      /human_approval_only/,
    );

    // The human operator's approval — the deploy-branch decision — succeeds.
    const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
    expect(approved).toEqual({ approved: true, runId: proposal.run_id });
  });
});

// ---------------------------------------------------------------------------
// Chain e2e on the fake adapter. The shared fake (lib/adapters/fake.mjs) does
// not know the ship contracts, so a local wrapper answers them the same way
// the merge tests answer theirs — repo-keyed, contract-shaped — and delegates
// everything else to the fake. The local runtime demo (port 7620) plays no
// part here.
// ---------------------------------------------------------------------------

const FAKE_HEAD_SHA = "d".repeat(40);
const FAKE_DEPLOY_HEAD_SHA = "e".repeat(40);

function writeResult(workspaceDir, result) {
  writeFileSync(path.join(workspaceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function shipScanArtifact(repo) {
  const base = { repo, github: `watt-mind/${repo}`, changelog: [], plan: [] };
  if (repo === "clean") {
    return { ...base, recommendation: "NOOP", summary: "fake: nothing to ship", noopReason: "not_ahead" };
  }
  return {
    ...base,
    recommendation: "SHIP",
    base: "develop",
    deployBranch: "master",
    headSha: FAKE_HEAD_SHA,
    deployHeadSha: FAKE_DEPLOY_HEAD_SHA,
    changelog: [{ sha: FAKE_HEAD_SHA, subject: "feat(app): fake thing (CLNT-901)", ticket: "CLNT-901" }],
    plan: [
      { action: "open_rc_pr", title: "release: develop → master (2026-08-14)", body: "- feat(app): fake thing\nCLNT-901" },
      { action: "merge_rc_pr" },
      { action: "smoke_check", url: `https://${repo}.projects.watt-mind.com`, smokeBranch: "develop", revisionField: "" },
    ],
    summary: `fake release candidate for ${repo}: 1 commit, CI green`,
  };
}

const shipFake = {
  async execute(opts) {
    const { spec, workspaceDir } = opts;
    if (spec.outputContract === "factory.ship-plan/v1") {
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        reasonCode: "ok",
        artifact: shipScanArtifact(spec.input.repo),
        evidence: { commands: ["fake"], aheadBy: 1 },
      });
      return { exitCode: 0, timedOut: false };
    }
    if (spec.outputContract === "factory.ship-applied/v1") {
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        reasonCode: "ok",
        artifact: {
          repo: spec.input.repo,
          applied: (spec.input.plan ?? []).map((i) => ({ issueId: i.action, action: i.action })),
        },
        evidence: { commands: ["fake"] },
      });
      return { exitCode: 0, timedOut: false };
    }
    return fake.execute(opts);
  },
};

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-ship-e2e-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-ship-e2e-ws-"));
  const adapters = { claude: shipFake, actions: shipFake, command: shipFake };
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

const shipEnvelope = (repo, eventId) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.ship.requested",
  source: "operator",
  subject: repo,
  occurredAt: "2026-08-14T09:00:00Z",
  correlationId: eventId,
  payload: { repo },
});

describe("ship chain: scan → human-approved apply (WM-111)", () => {
  test("a SHIP recommendation chains the pinned plan into a watched ship-apply proposal the human approves", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, shipEnvelope("bj29", "ship-1"));

    const scan = await approveNext("ship-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");

    expect(resolveChains(db, registry).emitted).toBe(1);
    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${scan.runId}`);
    expect(chainEvent.type).toBe("factory.ship-apply.requested");
    expect(chainEvent.correlation_id).toBe("ship-1"); // inherited from the origin
    expect(chainEvent.causation_id).toBe(scan.runId); // caused by the scan run

    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = openProposals(db, {}).find((p) => p.spec?.agent === "ship-apply@1");
    expect(apply.status).toBe("open"); // never applied without the human
    expect(apply.spec.input).toEqual({
      repo: "bj29",
      github: "watt-mind/bj29",
      base: "develop",
      deployBranch: "master",
      headSha: FAKE_HEAD_SHA, // the pin the probes hold the release to
      deployHeadSha: FAKE_DEPLOY_HEAD_SHA,
      changelog: [{ sha: FAKE_HEAD_SHA, subject: "feat(app): fake thing (CLNT-901)", ticket: "CLNT-901" }],
      plan: [
        { action: "open_rc_pr", title: "release: develop → master (2026-08-14)", body: "- feat(app): fake thing\nCLNT-901" },
        { action: "merge_rc_pr" },
        { action: "smoke_check", url: "https://bj29.projects.watt-mind.com", smokeBranch: "develop", revisionField: "" },
      ],
    });

    // The chained proposal itself rejects the auto path — this approval IS
    // the human deploy-branch decision, and no schedule can take it.
    expect(() =>
      approveProposal(db, registry, apply.id, { actor: SCHEDULE_SOURCE, policyVersion: PV }),
    ).toThrow(/human_approval_only/);
    expect(getProposal(db, apply.id).status).toBe("open");

    const applied = await approveNext("ship-apply@1");
    expect(applied.summary.terminalState).toBe("COMPLETED");
    const row = db.query(`SELECT result_json, receipt_json FROM results WHERE run_id = ?`).get(applied.runId);
    expect(JSON.parse(row.result_json).artifact.applied).toEqual([
      { issueId: "open_rc_pr", action: "open_rc_pr" },
      { issueId: "merge_rc_pr", action: "merge_rc_pr" },
      { issueId: "smoke_check", action: "smoke_check" },
    ]);
    expect(JSON.parse(row.receipt_json).runId).toBe(applied.runId); // accepted with a receipt
  });

  test("a NOOP converges quietly — nothing chained, nothing proposed, nothing to approve", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, shipEnvelope("clean", "ship-2"));
    const scan = await approveNext("ship-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");
    const result = JSON.parse(db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(scan.runId).result_json);
    expect(result.artifact.noopReason).toBe("not_ahead");

    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(openProposals(db, {}).find((p) => p.spec?.agent === "ship-apply@1")).toBeUndefined();
  });
});
