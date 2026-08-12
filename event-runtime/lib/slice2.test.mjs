import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function alertEnvelope(overrides = {}) {
  const id = overrides.alertId ?? `alert-${Math.random().toString(36).slice(2, 8)}`;
  return {
    schemaVersion: "factory.event/v1",
    eventId: `keep-${id}`,
    type: "keephq.disk-alert.raised",
    source: "keephq",
    subject: overrides.host ?? "lab",
    occurredAt: "2026-08-12T22:00:00Z",
    correlationId: id,
    causationId: null,
    payload: {
      host: overrides.host ?? "lab",
      mount: overrides.mount ?? "/",
      usedPct: overrides.usedPct ?? 93,
      alertId: id,
    },
  };
}

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-s2-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-s2-ws-"));
  const adapters = { claude: fake, actions: fake };
  const workerOpts = { workspacesRoot: workspaces, owner: "w-test", policyVersion: PV };

  async function approveNext(agentRef) {
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find((p) => p.spec?.agent === agentRef);
    expect(proposal).toBeTruthy();
    const approved = approveProposal(db, registry, proposal.id, { actor: "operator", policyVersion: PV });
    expect(approved.approved).toBe(true);
    const summary = await runOnce(db, registry, adapters, workerOpts);
    return { proposal, runId: approved.runId, summary };
  }
  return { db, approveNext };
}

describe("slice 2: disk alert → diagnose → approved remediation (OPS-208)", () => {
  test("full two-node chain, evidence-verified reclaim", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, alertEnvelope({ alertId: "a1", usedPct: 93 }));

    const diagnose = await approveNext("disk-diagnose@1");
    expect(diagnose.summary.terminalState).toBe("COMPLETED");

    // REMEDIATE recommendation → chain event → watched remediation proposal.
    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const remedProposal = openProposals(db, {}).find((p) => p.spec?.agent === "disk-remediate@1");
    expect(remedProposal.status).toBe("open"); // AC: no node B without approval
    expect(remedProposal.spec.input).toEqual({
      host: "lab",
      mount: "/",
      actions: [{ action: "docker-builder-prune", expectedReclaimBytes: 1_000_000 }],
    });

    const remediate = await approveNext("disk-remediate@1");
    expect(remediate.summary.terminalState).toBe("COMPLETED");

    const result = db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(remediate.runId);
    const parsed = JSON.parse(result.result_json);
    expect(parsed.artifact.reclaimedBytes).toBe(1_000_000);
    expect(parsed.verification.checks).toContain("evidence_recomputed");
    expect(parsed.evidenceSetHash).toMatch(/^sha256:/);

    // Remediation result has no registered edges — the chain terminates.
    expect(resolveChains(db, registry).emitted).toBe(0);
  });

  test("stale alert (healthy at diagnose time) → NOOP, no remediation proposed", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, alertEnvelope({ alertId: "a2", usedPct: 41 }));
    const diagnose = await approveNext("disk-diagnose@1");
    expect(diagnose.summary.terminalState).toBe("COMPLETED");

    expect(resolveChains(db, registry)).toEqual({ emitted: 0, skipped: 1, errors: [] });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(openProposals(db, {}).find((p) => p.spec?.agent === "disk-remediate@1")).toBeUndefined();
  });

  test("duplicate alert (same host+alertId) → one run", async () => {
    const { db } = harness();
    admitEvent(db, registry, alertEnvelope({ alertId: "a3", usedPct: 93 }));
    planAdmittedEvents(db, registry, { policyVersion: PV });
    // Re-fired alert: same alertId/host, different usedPct — must converge.
    admitEvent(db, registry, { ...alertEnvelope({ alertId: "a3", usedPct: 97 }), eventId: "keep-a3-refire" });
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get().n).toBe(1);
  });

  test("a lying artifact fails closed: verifier recomputes reclaim from evidence", async () => {
    const { db, approveNext } = harness();
    admitEvent(db, registry, alertEnvelope({ alertId: "a4", mount: "/bad", usedPct: 95 }));
    await approveNext("disk-diagnose@1");
    resolveChains(db, registry);
    const remediate = await approveNext("disk-remediate@1");
    expect(remediate.summary.terminalState).toBe("FAILED");
    expect(remediate.summary.reasonCode).toBe("contract_violation");
    // The journal carries the recomputation detail.
    const journal = db
      .query(`SELECT reason FROM lifecycle_events WHERE run_id = ? AND to_state = 'FAILED'`)
      .get(remediate.runId);
    expect(journal.reason).toContain("evidence_mismatch: reclaimedBytes 9999999 != recomputed 1000000");
  });
});

describe("actions adapter (OPS-208)", () => {
  // A local stand-in for ssh: exec = ["sh", "-c", "{remote}"] runs the remote
  // string in a local shell, so probes and actions are real but harmless.
  function localDef(dir) {
    return {
      ref: "test-actions@1",
      exec: ["sh", "-c", "{remote}"],
      hosts: { testhost: "unused-target" },
      probeRemote: `wc -c < ${dir}/blob | tr -d ' '`,
      actionRegistry: {
        shrink: { remote: `truncate -s 400 ${dir}/blob` },
      },
    };
  }

  test("probes before/after, executes registered actions, artifact matches evidence", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-act-"));
    writeFileSync(path.join(dir, "blob"), Buffer.alloc(1000));
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "evrt-act-ws-"));

    const outcome = await actions.execute({
      spec: { input: { host: "testhost", mount: "/", actions: [{ action: "shrink" }] } },
      def: localDef(dir),
      workspaceDir,
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
    expect(result.artifact.beforeUsedBytes).toBe(1000);
    expect(result.artifact.afterUsedBytes).toBe(400);
    expect(result.artifact.reclaimedBytes).toBe(600);
    expect(result.evidence.probeBefore.trim()).toBe("1000");
  });

  test("unregistered action ID refuses before executing anything", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-act-"));
    writeFileSync(path.join(dir, "blob"), Buffer.alloc(1000));
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "evrt-act-ws-"));

    const outcome = await actions.execute({
      spec: { input: { host: "testhost", mount: "/", actions: [{ action: "shrink" }, { action: "rm-rf-everything" }] } },
      def: localDef(dir),
      workspaceDir,
      timeoutMs: 10_000,
    });
    expect(outcome.exitCode).toBe(1);
    // The registered action in the same list did NOT run either.
    expect(readFileSync(path.join(dir, "blob")).length).toBe(1000);
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain("not in the closed action registry");
  });

  test("unknown host refuses before executing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-act-"));
    writeFileSync(path.join(dir, "blob"), Buffer.alloc(1000));
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "evrt-act-ws-"));
    const outcome = await actions.execute({
      spec: { input: { host: "prod-db", mount: "/", actions: [{ action: "shrink" }] } },
      def: localDef(dir),
      workspaceDir,
      timeoutMs: 10_000,
    });
    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(path.join(workspaceDir, ".actions.log"), "utf8")).toContain("host allowlist");
  });
});
