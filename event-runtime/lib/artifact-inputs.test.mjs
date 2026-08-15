import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  materializeArtifact,
  pruneArtifacts,
  referencedHashes,
  storeStats,
} from "./artifacts.mjs";
import { sha256Hex } from "./canonical.mjs";
import * as fake from "./adapters/fake.mjs";
import { resolveChains } from "./chain.mjs";
import { openDb } from "./db.mjs";
import { admitEvent } from "./intake.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { approveProposal, openProposals } from "./proposals.mjs";
import { loadRegistry } from "./registry.mjs";
import { runOnce } from "./worker.mjs";
import { createWorkspace, resolveInputRef } from "./workspace.mjs";

const registry = loadRegistry();

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));

/** Put bytes in a store the way the worker does: keyed by their own hash. */
function store(bytes, storeRoot = tmp("evrt-store-")) {
  mkdirSync(storeRoot, { recursive: true });
  const hash = sha256Hex(Buffer.from(bytes));
  writeFileSync(path.join(storeRoot, hash), bytes);
  return { storeRoot, hash };
}

/** A results row referencing an artifact, so GC can see it as live. */
function recordResult(db, { runId, sha256, kind = "ci-log" }) {
  db.query(
    `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
     VALUES (?, 1, ?, 'sha256:x', '{}', '{}', ?)`,
  ).run(
    runId,
    JSON.stringify({ artifacts: [{ kind, sha256, uri: "file:///x" }] }),
    new Date().toISOString(),
  );
}

describe("materializeArtifact (OPS-372)", () => {
  test("writes the stored bytes into the workspace under the declared name", () => {
    const { storeRoot, hash } = store("first line\nsecond line\n");
    const workspaceDir = tmp("evrt-ws-");
    const out = materializeArtifact({ storeRoot, sha256hex: hash, workspaceDir, as: "failed.log" });
    expect(out.sha256).toBe(hash);
    expect(readFileSync(path.join(workspaceDir, "failed.log"), "utf8")).toBe("first line\nsecond line\n");
  });

  test("a hash that is not in the store fails closed", () => {
    const { storeRoot } = store("x");
    expect(() =>
      materializeArtifact({ storeRoot, sha256hex: "a".repeat(64), workspaceDir: tmp("evrt-ws-"), as: "x.log" }),
    ).toThrow(/not in the store/);
  });

  test("a malformed hash is rejected before touching the filesystem", () => {
    const { storeRoot } = store("x");
    expect(() =>
      materializeArtifact({ storeRoot, sha256hex: "../../etc/passwd", workspaceDir: tmp("evrt-ws-"), as: "x" }),
    ).toThrow();
  });

  test("the target name may not escape the workspace", () => {
    const { storeRoot, hash } = store("x");
    const workspaceDir = tmp("evrt-ws-");
    for (const as of ["../escaped.log", "/etc/passwd", ""]) {
      expect(() => materializeArtifact({ storeRoot, sha256hex: hash, workspaceDir, as })).toThrow();
    }
  });
});

describe("resolveInputRef", () => {
  test("resolves $.input.* paths and passes literals through", () => {
    const input = { logArtifact: "abc", nested: { hash: "def" } };
    expect(resolveInputRef(input, "$.input.logArtifact")).toBe("abc");
    expect(resolveInputRef(input, "$.input.nested.hash")).toBe("def");
    expect(resolveInputRef(input, "literal")).toBe("literal");
  });

  test("a ref that resolves to nothing fails loudly", () => {
    expect(() => resolveInputRef({}, "$.input.missing")).toThrow(/resolves to nothing/);
  });
});

describe("artifacts workspace provider (OPS-372)", () => {
  test("materializes every declared input and reports what it wrote", () => {
    const { storeRoot, hash } = store("ci log bytes\n");
    const created = createWorkspace({
      root: tmp("evrt-root-"),
      runId: "run_1",
      attempt: 1,
      input: { logArtifact: hash },
      workspace: { type: "artifacts", inputs: [{ from: "$.input.logArtifact", as: "failed.log" }] },
      artifactStore: storeRoot,
    });
    expect(created.materialized).toEqual([{ as: "failed.log", sha256: hash, sizeBytes: 13 }]);
    expect(readFileSync(path.join(created.dir, "failed.log"), "utf8")).toBe("ci log bytes\n");
    // input.json is still written: declared inputs and declared bytes coexist.
    expect(JSON.parse(readFileSync(path.join(created.dir, "input.json"), "utf8"))).toEqual({
      logArtifact: hash,
    });
  });

  test("an ephemeral workspace materializes nothing", () => {
    const created = createWorkspace({
      root: tmp("evrt-root-"),
      runId: "run_2",
      attempt: 1,
      input: {},
      workspace: { type: "ephemeral" },
      artifactStore: tmp("evrt-store-"),
    });
    expect(created.materialized).toEqual([]);
  });
});

describe("retention (OPS-372)", () => {
  const db = () => openDb(path.join(tmp("evrt-db-"), "runtime.db"));

  test("referencedHashes finds every hash an accepted result points at", () => {
    const d = db();
    const { hash } = store("kept");
    recordResult(d, { runId: "run_1", sha256: hash });
    expect([...referencedHashes(d)]).toEqual([hash]);
  });

  test("storeStats separates referenced bytes from orphans", () => {
    const d = db();
    const kept = store("kept bytes");
    const orphan = store("orphan bytes", kept.storeRoot);
    recordResult(d, { runId: "run_1", sha256: kept.hash });

    const stats = storeStats(d, kept.storeRoot);
    expect(stats.files).toBe(2);
    expect(stats.orphans).toBe(1);
    expect(stats.orphanBytes).toBe("orphan bytes".length);
  });

  test("pruning deletes only old orphans — a referenced artifact is never touched", () => {
    const d = db();
    const kept = store("kept bytes");
    const orphan = store("orphan bytes", kept.storeRoot);
    recordResult(d, { runId: "run_1", sha256: kept.hash });

    // Age both files past the window; only the unreferenced one may go.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(kept.storeRoot, kept.hash), old, old);
    utimesSync(path.join(kept.storeRoot, orphan.hash), old, old);

    const outcome = pruneArtifacts(d, kept.storeRoot, { olderThanMs: 7 * 24 * 60 * 60 * 1000 });
    expect(outcome.deleted).toBe(1);
    expect(readFileSync(path.join(kept.storeRoot, kept.hash), "utf8")).toBe("kept bytes");
    expect(storeStats(d, kept.storeRoot).orphans).toBe(0);
  });

  test("a fresh orphan survives — bytes may be referenced by a run still in flight", () => {
    const d = db();
    const { storeRoot } = store("just written");
    expect(pruneArtifacts(d, storeRoot, { olderThanMs: 7 * 24 * 60 * 60 * 1000 }).deleted).toBe(0);
  });
});

describe("POC chain: capture a CI log, diagnose from the stored bytes (OPS-372)", () => {
  test("the log becomes an artifact, chains by hash, and is materialized for the doctor", async () => {
    const dir = tmp("evrt-poc-");
    const db = openDb(path.join(dir, "runtime.db"));
    const workspaces = tmp("evrt-poc-ws-");
    const artifactStore = tmp("evrt-poc-store-");
    const adapters = { pi: fake, command: fake };
    const opts = { workspacesRoot: workspaces, artifactStore, owner: "w", policyVersion: "git:test" };

    admitEvent(db, registry, {
      schemaVersion: "factory.event/v1",
      eventId: "gh-poc-1",
      type: "github.workflow-run.failed",
      source: "github",
      occurredAt: "2026-08-13T10:00:00Z",
      correlationId: "gh-poc-1",
      payload: { repo: "wm/factory", runId: 4242 },
    });

    // Node 1: capture. The whole log is stored content-addressed.
    planAdmittedEvents(db, registry, opts);
    const capture = openProposals(db, {}).find((p) => p.spec?.agent === "ci-log-capture@1");
    expect(capture).toBeTruthy();
    const captureRun = approveProposal(db, registry, capture.id, { actor: "operator", policyVersion: "git:test" });
    expect((await runOnce(db, registry, adapters, opts)).terminalState).toBe("COMPLETED");

    const captured = JSON.parse(
      db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(captureRun.runId).result_json,
    );
    const logEntry = captured.artifacts.find((a) => a.kind === "ci-log");
    expect(logEntry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path.join(artifactStore, logEntry.sha256), "utf8")).toContain("socket hang up");

    // The chain passes the HASH, not the bytes.
    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, opts);
    const diagnose = openProposals(db, {}).find((p) => p.spec?.agent === "ci-doctor@2");
    expect(diagnose.spec.input.logArtifact).toBe(logEntry.sha256);

    // Node 2: the doctor reads ./failed.log, proving materialization happened.
    const diagnoseRun = approveProposal(db, registry, diagnose.id, { actor: "operator", policyVersion: "git:test" });
    expect((await runOnce(db, registry, adapters, opts)).terminalState).toBe("COMPLETED");
    const diagnosis = JSON.parse(
      db.query(`SELECT result_json FROM results WHERE run_id = ?`).get(diagnoseRun.runId).result_json,
    );
    expect(diagnosis.artifact.evidenceLines).toEqual(["socket hang up"]);
    expect(diagnosis.evidence.logBytes).toBeGreaterThan(0);
  });

  test("a run whose declared artifact is missing parks for a human instead of proposing", () => {
    const db = openDb(path.join(tmp("evrt-poc-"), "runtime.db"));
    admitEvent(db, registry, {
      schemaVersion: "factory.event/v1",
      eventId: "diag-orphan",
      type: "factory.ci-diagnose.requested",
      source: "chain",
      occurredAt: "2026-08-13T10:00:00Z",
      correlationId: "diag-orphan",
      payload: { repo: "wm/factory", runId: 1, logArtifact: "b".repeat(64) },
    });
    planAdmittedEvents(db, registry, { policyVersion: "git:test" });
    const parked = openProposals(db, {}).find((p) => p.decision === "human_needed");
    expect(parked.reason).toContain("artifact_missing");
  });
});
