import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashJson, sha256Hex } from "./canonical.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import { ContractViolation, verifyResult } from "./verify.mjs";

const registry = loadRegistry();
const def = getAgent(registry, "factory-status-report@1");
const dispatchDef = getAgent(registry, "dispatch@1");

function makeSpec(input = { repos: ["bj29"] }) {
  return {
    schemaVersion: "factory.run-spec/v1",
    runId: "run_verify_test",
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: true },
    adapter: "fake",
    promptVersion: "git:test",
    policyVersion: "git:test",
    outputContract: "factory.status-report/v1",
    capabilities: ["linear:read"],
    timeoutSeconds: 600,
    maxAttempts: 1,
    idempotencyKey: "verify-test",
  };
}

function makeWorkspace(result) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-verify-"));
  if (result !== undefined) {
    writeFileSync(path.join(dir, "result.json"), JSON.stringify(result), "utf8");
  }
  return dir;
}

const VALID_ARTIFACT = {
  repos: [{ name: "bj29", triage: 1, agentReady: 2, inProgress: 0, blocked: 0 }],
  recommendedAction: "dispatch",
};

describe("verifyResult", () => {
  test("valid completed result → result + receipt with recomputed hashes", () => {
    const evidence = { queries: ["q1"] };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      evidence,
      artifacts: [{ kind: "log", path: "logs/agent.log" }],
    });
    mkdirSync(path.join(dir, "logs"));
    writeFileSync(path.join(dir, "logs", "agent.log"), "hello\n", "utf8");

    const spec = makeSpec();
    const out = verifyResult({ spec, def, registry, workspaceDir: dir, attempt: 1, journalHead: "sha256:head" });
    expect(out.kind).toBe("completed");
    expect(out.result.terminalState).toBe("completed");
    expect(out.result.reasonCode).toBe("ok");
    expect(out.result.artifactHash).toBe(hashJson(VALID_ARTIFACT));
    expect(out.result.evidenceSetHash).toBe(hashJson(evidence));
    expect(out.result.verification.status).toBe("passed");
    expect(out.result.artifacts).toEqual([
      { kind: "log", uri: `file://${path.join(dir, "logs", "agent.log")}`, sha256: sha256Hex("hello\n") },
    ]);
    expect(out.receipt).toEqual({
      runId: spec.runId,
      runSpecHash: hashJson(spec),
      artifactHash: hashJson(VALID_ARTIFACT),
      evidenceSetHash: hashJson(evidence),
      journalHead: "sha256:head",
      verificationStatus: "passed",
    });
  });

  test("completed without evidence → evidenceSetHash null", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
    });
    const out = verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 });
    expect(out.result.evidenceSetHash).toBeNull();
    expect(out.receipt.journalHead).toBeNull();
  });

  test("schema-violating artifact → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: { repos: [{ name: "x", triage: -1, agentReady: 0, inProgress: 0, blocked: 0 }] },
    });
    expect(() => verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 }))
      .toThrow(ContractViolation);
  });

  test("missing result.json → ContractViolation [missing_result]", () => {
    const dir = makeWorkspace();
    try {
      verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toEqual(["missing_result"]);
    }
  });

  test("unparseable result.json → ContractViolation", () => {
    const dir = makeWorkspace();
    writeFileSync(path.join(dir, "result.json"), "{not json", "utf8");
    expect(() => verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 }))
      .toThrow(ContractViolation);
  });

  test("refused with a valid reasonCode → kind refused, no artifact fields", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
    });
    const out = verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 2 });
    expect(out.kind).toBe("refused");
    expect(out.reasonCode).toBe("needs_human");
    expect(out.result.terminalState).toBe("refused");
    expect(out.result.attempt).toBe(2);
    expect(out.result.artifact).toBeUndefined();
    expect(out.result.artifactHash).toBeUndefined();
  });

  test("refused with an unknown reasonCode → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "felt_like_it",
    });
    expect(() => verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 }))
      .toThrow(ContractViolation);
  });

  test("refused carrying run_6fe0cdb4's dispatch artifact shape → REFUSED with context retained", () => {
    const artifact = {
      outcome: "BLOCKED",
      repo: "factory",
      ticket: "WM-139",
      prUrl: null,
      verification: {
        command: null,
        passed: false,
        output: "Not run: production infrastructure and credential handling require a human.",
      },
      summary: "Human approval is required for production launchd and SSH credential changes.",
    };
    const evidence = {
      commands: ["gh auth status", "launchctl print gui/$(id -u)/com.wattmind.factory"],
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
      artifact,
      evidence,
    });
    const spec = { ...makeSpec({ repo: "factory", ticket: "WM-139" }), outputContract: "factory.dispatch-result/v1" };

    const out = verifyResult({ spec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });

    expect(out.kind).toBe("refused");
    expect(out.reasonCode).toBe("needs_human");
    expect(out.result.terminalState).toBe("refused");
    expect(out.result.artifact).toEqual(artifact);
    expect(out.result.artifactHash).toBe(hashJson(artifact));
    expect(out.result.evidence).toEqual(evidence);
    expect(out.result.evidenceSetHash).toBe(hashJson(evidence));
    expect(out.result.verification.checks).toContain("evidence_retained");
  });

  test("refused carrying an artifact that fails its output schema → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
      artifact: { outcome: "BLOCKED", repo: "factory" },
    });
    const spec = { ...makeSpec({ repo: "factory", ticket: "WM-139" }), outputContract: "factory.dispatch-result/v1" };
    expect(() => verifyResult({ spec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 }))
      .toThrow(ContractViolation);
  });

  test("artifact path escaping the workspace → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      artifacts: [{ kind: "log", path: "../outside.txt" }],
    });
    writeFileSync(path.resolve(dir, "..", "outside.txt"), "escaped\n", "utf8");
    try {
      verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toEqual(["artifact_path_escape: ../outside.txt"]);
    }
  });

  test("declared artifact that does not exist → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      artifacts: [{ kind: "log", path: "missing.log" }],
    });
    expect(() => verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 }))
      .toThrow(ContractViolation);
  });
});

describe("evidence retention (OPS-206)", () => {
  const completedWith = (evidence) => ({
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    artifact: VALID_ARTIFACT,
    ...(evidence !== undefined ? { evidence } : {}),
  });

  test("declared evidence is retained in the result and its hash recomputes from the stored bytes", () => {
    const evidence = { queries: ["df -h", "docker system df"] };
    const dir = makeWorkspace(completedWith(evidence));
    const { result } = verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 });
    expect(result.evidence).toEqual(evidence);
    expect(hashJson(result.evidence)).toBe(result.evidenceSetHash);
    expect(result.verification.checks).toContain("evidence_retained");
  });

  test("absent evidence stores null hash and no evidence field", () => {
    const dir = makeWorkspace(completedWith(undefined));
    const { result } = verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 });
    expect(result.evidenceSetHash).toBeNull();
    expect("evidence" in result).toBe(false);
    expect(result.verification.checks).not.toContain("evidence_retained");
  });

  test("oversize evidence fails closed as a contract violation", () => {
    const dir = makeWorkspace(completedWith({ blob: "x".repeat(300 * 1024) }));
    expect(() => verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 }))
      .toThrow(ContractViolation);
    try {
      verifyResult({ spec: makeSpec(), def, registry, workspaceDir: dir, attempt: 1 });
    } catch (err) {
      expect(err.violations[0]).toStartWith("evidence_too_large:");
    }
  });
});
