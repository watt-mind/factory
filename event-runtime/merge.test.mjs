/**
 * Merge chain (WM-109): merge-scan@1 reviews a repo's open PRs cold and emits
 * a typed, head-SHA-pinned plan; merge-apply@1 executes the approved plan via
 * the closed actions registry; ESCALATE routes to the merge-notify push.
 * Follows the triage-scan → triage-apply precedent (OPS-229) and the
 * ci-doctor verdict edges (OPS-223).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fake from "./lib/adapters/fake.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { openDb } from "./lib/db.mjs";
import { admitEvent } from "./lib/intake.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { approveProposal, openProposals } from "./lib/proposals.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { runOnce } from "./lib/worker.mjs";

const registry = loadRegistry();

const PINNED_SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);

/**
 * Run the REAL merge-apply@1 registry definition against shimmed `gh` and
 * `factory` binaries: the probe → merge flow executes exactly the registered
 * templates, but nothing reaches GitHub or Telegram. The adapter's spawnSync
 * inherits the calling process's environ (not mutated process.env), so the
 * adapter runs in a `bun` child whose env carries the shim PATH. The shim's
 * `pr view` answers with $FAKE_HEAD_SHA; every mutating call is appended to
 * $SHIM_LOG.
 */
async function runApply(plan, { headSha = PINNED_SHA } = {}) {
  const shims = mkdtempSync(path.join(os.tmpdir(), "evrt-merge-shims-"));
  const log = path.join(shims, "shim.log");
  writeFileSync(
    path.join(shims, "gh"),
    `#!/bin/sh\nif [ "$1 $2" = "pr view" ]; then echo "$FAKE_HEAD_SHA"; else echo "gh $*" >> "$SHIM_LOG"; fi\n`,
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
      `  def: loadRegistry().agents.get("merge-apply@1"),\n` +
      `  workspaceDir: process.argv[3],\n` +
      `  timeoutMs: 10_000,\n` +
      `});\n` +
      `console.log(JSON.stringify(outcome));\n`,
  );

  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "evrt-merge-ws-"));
  const input = { repo: "bj29", github: "watt-mind/bj29", plan };
  const proc = spawnSync("bun", [driver, JSON.stringify(input), workspaceDir], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, FAKE_HEAD_SHA: headSha, SHIM_LOG: log },
  });
  expect(proc.status).toBe(0);
  return { outcome: JSON.parse(proc.stdout.trim().split("\n").at(-1)), workspaceDir, log };
}

describe("merge-scan registration (WM-109)", () => {
  test("merge-scan@1 is a read-only pi agent with no repository workspace", () => {
    const def = registry.agents.get("merge-scan@1");
    expect(def.mutating).toBe(false);
    // It reads PRs via gh, not a source tree — ephemeral, like the other
    // pure-CLI readers (factory-status-report), never a repository checkout.
    expect(def.workspace.type).toBe("ephemeral");
    expect(def.output_contract).toBe("factory.merge-plan/v1");
    expect(def.capabilities.services).toContain("gh:read");
  });

  test("factory.merge.requested maps to merge-scan@1 on the pi adapter, deduped by inputHash", () => {
    const mapping = registry.eventTypes["factory.merge.requested"];
    expect(mapping).toEqual({
      agent: "merge-scan@1",
      adapter: "pi",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
  });

  test("the plan item shape pins {pr, headSha, ticket} — a moved head is detectable at apply time", () => {
    const item = registry.agents.get("merge-scan@1").outputSchema.properties.plan.items;
    expect(item.required).toEqual(["pr", "headSha", "ticket", "action", "reason"]);
    expect(item.properties.headSha.pattern).toBe("^[0-9a-f]{40}$");
    expect(item.properties.action.enum).toEqual(["merge_pr", "ticket_done", "notify_escalate"]);
  });
});

describe("merge-apply is closed by construction (WM-109)", () => {
  test("the registry admits merge-apply@1 as an item-list definition with exactly the three closed actions", () => {
    const def = registry.agents.get("merge-apply@1");
    expect(def.mutating).toBe(true);
    expect(def.itemsField).toBe("plan");
    expect(def.itemKey).toBe("ticket");
    expect(Object.keys(def.actionRegistry).sort()).toEqual(["merge_pr", "notify_escalate", "ticket_done"]);
    // ticket_done is the fixed merge-protocol Done transition, nothing else.
    expect(def.actionRegistry.ticket_done.argv).toEqual([
      "bun", "{factoryRoot}/tools/linear.mjs", "state", "{ticket}", "Done",
      "--remove", "ai:needs-review", "--remove", "ai:escalated", "--remove", "ai:blocked",
    ]);
    // notify_escalate follows ci-notify's `factory notify` invocation form.
    expect(def.actionRegistry.notify_escalate.argv).toEqual([
      "factory", "notify", "ESCALATED PR#{pr} ({ticket}): {reason}",
    ]);
    // merge_pr substitutes only trailing positional args — never into the script.
    expect(def.actionRegistry.merge_pr.argv.slice(-3)).toEqual(["{pr}", "{github}", "{headSha}"]);
  });

  test("factory.merge-apply.requested maps to merge-apply@1 on the actions adapter, deduped by inputHash", () => {
    expect(registry.eventTypes["factory.merge-apply.requested"]).toEqual({
      agent: "merge-apply@1",
      adapter: "actions",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
  });

  test("merge_pr probes the live head first and merges when it matches the pin", async () => {
    const { outcome, workspaceDir, log } = await runApply([
      { pr: 101, headSha: PINNED_SHA, ticket: "WM-500", action: "merge_pr", reason: "clean review" },
      { pr: 102, headSha: PINNED_SHA, ticket: "WM-501", action: "notify_escalate", reason: "touches auth" },
    ]);
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const shimLog = readFileSync(log, "utf8");
    expect(shimLog).toContain("gh pr merge 101 --repo watt-mind/bj29 --squash --delete-branch");
    expect(shimLog).toContain("factory notify ESCALATED PR#102 (WM-501): touches auth");
    const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
    expect(result.artifact).toEqual({
      repo: "bj29",
      applied: [
        { issueId: "WM-500", action: "merge_pr" },
        { issueId: "WM-501", action: "notify_escalate" },
      ],
    });
  });

  test("a moved head is a refusal, not a re-review: the merge never executes", async () => {
    const { outcome, workspaceDir, log } = await runApply(
      [{ pr: 101, headSha: PINNED_SHA, ticket: "WM-500", action: "merge_pr", reason: "clean review" }],
      { headSha: MOVED_SHA },
    );
    expect(outcome.exitCode).toBe(1);
    expect(existsSync(log)).toBe(false); // no mutating call ever reached the shim
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain("refusing PR #101");
  });

  test("an unregistered action refuses before applying ANY item — including the valid ones", async () => {
    const { outcome, workspaceDir, log } = await runApply([
      { pr: 101, headSha: PINNED_SHA, ticket: "WM-500", action: "merge_pr", reason: "clean review" },
      { pr: 102, headSha: PINNED_SHA, ticket: "WM-501", action: "delete-everything", reason: "nope" },
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(existsSync(log)).toBe(false); // the valid merge_pr beside it never ran
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain(
      "not in the closed action registry",
    );
  });
});

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-merge-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-merge-e2e-ws-"));
  const adapters = { pi: fake, actions: fake, command: fake };
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

const PV = "git:test-pv";

const mergeEnvelope = (repo, eventId) => ({
  schemaVersion: "factory.event/v1",
  eventId,
  type: "factory.merge.requested",
  source: "operator",
  subject: repo,
  occurredAt: "2026-08-14T09:00:00Z",
  correlationId: eventId,
  payload: { repo },
});

describe("merge chain: scan → approved apply (WM-109)", () => {
  test("a MERGE recommendation chains the pinned plan into a watched merge-apply proposal", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, mergeEnvelope("bj29", "merge-1"));

    const scan = await approveNext("merge-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");

    expect(resolveChains(db, registry).emitted).toBe(1);
    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${scan.runId}`);
    expect(chainEvent.type).toBe("factory.merge-apply.requested");
    expect(chainEvent.correlation_id).toBe("merge-1");
    expect(chainEvent.causation_id).toBe(scan.runId);

    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = openProposals(db, {}).find((p) => p.spec?.agent === "merge-apply@1");
    expect(apply.status).toBe("open"); // never applied without approval
    expect(apply.spec.input).toEqual({
      repo: "bj29",
      github: "watt-mind/bj29",
      plan: [
        { pr: 42, headSha: fake.FAKE_PLAN_SHA, ticket: "CLNT-777", action: "merge_pr", reason: "fake: clean review" },
        { pr: 42, headSha: fake.FAKE_PLAN_SHA, ticket: "CLNT-777", action: "ticket_done", reason: "fake: clean review" },
      ],
    });

    const applied = await approveNext("merge-apply@1");
    expect(applied.summary.terminalState).toBe("COMPLETED");
    const row = db.query(`SELECT result_json, receipt_json FROM results WHERE run_id = ?`).get(applied.runId);
    expect(JSON.parse(row.result_json).artifact.applied).toEqual([
      { issueId: "CLNT-777", action: "merge_pr" },
      { issueId: "CLNT-777", action: "ticket_done" },
    ]);
    expect(JSON.parse(row.receipt_json).runId).toBe(applied.runId); // accepted with a receipt
  });

  test("a MERGE recommendation with escalations includes notify_escalate in the plan and applies both", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, mergeEnvelope("wm-merge-esc", "merge-1b"));

    const scan = await approveNext("merge-scan@1");
    expect(scan.summary.terminalState).toBe("COMPLETED");

    expect(resolveChains(db, registry).emitted).toBe(1);
    const chainEvent = db
      .query(`SELECT * FROM events WHERE source = 'chain' AND event_id = ?`)
      .get(`chain-${scan.runId}`);
    expect(chainEvent.type).toBe("factory.merge-apply.requested");

    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = openProposals(db, {}).find((p) => p.spec?.agent === "merge-apply@1");
    expect(apply.status).toBe("open");
    expect(apply.spec.input).toEqual({
      repo: "wm-merge-esc",
      github: "watt-mind/wm-merge-esc",
      plan: [
        { pr: 42, headSha: fake.FAKE_PLAN_SHA, ticket: "CLNT-777", action: "merge_pr", reason: "fake: clean review" },
        { pr: 42, headSha: fake.FAKE_PLAN_SHA, ticket: "CLNT-777", action: "ticket_done", reason: "fake: clean review" },
        { pr: 44, headSha: fake.FAKE_PLAN_SHA, ticket: "CLNT-778", action: "notify_escalate", reason: "fake: touches auth" },
      ],
    });

    const applied = await approveNext("merge-apply@1");
    expect(applied.summary.terminalState).toBe("COMPLETED");
    const row = db.query(`SELECT result_json, receipt_json FROM results WHERE run_id = ?`).get(applied.runId);
    expect(JSON.parse(row.result_json).artifact.applied).toEqual([
      { issueId: "CLNT-777", action: "merge_pr" },
      { issueId: "CLNT-777", action: "ticket_done" },
      { issueId: "CLNT-778", action: "notify_escalate" },
    ]);
  });

  test("an ESCALATE recommendation routes to the merge-notify push, watched", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, mergeEnvelope("wm-esc", "merge-2"));
    await approveNext("merge-scan@1");

    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const notify = openProposals(db, {}).find((p) => p.spec?.agent === "merge-notify@1");
    expect(notify.status).toBe("open");
    expect(notify.spec.adapter).toBe("command");
    expect(notify.spec.input).toEqual({ repo: "wm-esc", summary: "fake: PR #44 on wm-esc changes auth behavior" });

    const pushed = await approveNext("merge-notify@1");
    expect(pushed.summary.terminalState).toBe("COMPLETED");
  });

  test("FIX chains to NOTHING in v1 — the findings stay in the scan artifact for a human", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, mergeEnvelope("wm-fix", "merge-3"));
    const scan = await approveNext("merge-scan@1");
    const result = JSON.parse(db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(scan.runId).result_json);
    expect(result.artifact.fix).toHaveLength(1);

    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(openProposals(db, {}).find((p) => ["merge-apply@1", "merge-notify@1"].includes(p.spec?.agent))).toBeUndefined();
  });

  test("an empty queue converges to NOOP — nothing proposed, nothing applied", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, mergeEnvelope("clean", "merge-4"));
    await approveNext("merge-scan@1");
    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(openProposals(db, {}).find((p) => ["merge-apply@1", "merge-notify@1"].includes(p.spec?.agent))).toBeUndefined();
  });
});
