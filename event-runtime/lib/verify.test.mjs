import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashJson, sha256Hex } from "./canonical.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import { ContractViolation, normalizeFailureOutput, verifyResult } from "./verify.mjs";

const registry = loadRegistry();
const def = getAgent(registry, "factory-status-report@1");
const dispatchDef = getAgent(registry, "dispatch@1");
const workScanDef = getAgent(registry, "work-scan@1");

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

  const candidate = (ticket, disposition) => ({ ticket, disposition });
  const candidateEvidence = (candidates, extra = {}) => ({
    commands: ["linear queue"],
    candidatesSeen: candidates.length,
    candidates,
    inFlightSeen: 0,
    maxInFlight: 3,
    ...extra,
  });

  const workPlanSpec = {
    ...makeSpec(),
    agent: "work-scan@1",
    outputContract: "factory.work-plan/v1",
  };

  function verifyWorkPlan(artifact, evidence) {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact,
      evidence,
    });
    return verifyResult({ spec: workPlanSpec, def: workScanDef, registry, workspaceDir: dir, attempt: 1 });
  }

  test("valid DISPATCH accounts for every candidate through plan or typed deferral", () => {
    const out = verifyWorkPlan({
      recommendation: "DISPATCH",
      repo: "factory",
      ticket: "WM-345",
      plan: [
        { ticket: "WM-345", ownedPaths: ["src/a/**"], reason: "priority Urgent, disjoint" },
      ],
      deferred: [
        { ticket: "WM-294", reason: "owned_paths_overlap" },
        { ticket: "WM-131", reason: "cap_full" },
      ],
      readyCandidates: 3,
      triageBacklog: 0,
      summary: "one candidate starts and two are accounted for",
    }, candidateEvidence([
      candidate("WM-345", "selected"),
      candidate("WM-294", "owned_paths_overlap"),
      candidate("WM-131", "cap_full"),
    ], { inFlightSeen: 2 }));

    expect(out.kind).toBe("completed");
    expect(out.result.verification.checks).toContain("evidence_recomputed");
  });

  test("regression: three ready tickets plus two in progress cannot validate as queue_empty", () => {
    try {
      verifyWorkPlan({
        recommendation: "NOOP",
        repo: "factory",
        ticket: null,
        plan: [],
        deferred: [],
        noopReason: "queue_empty",
        readyCandidates: 3,
        triageBacklog: 0,
        summary: "incorrectly discarded three ready candidates",
      }, candidateEvidence([
        candidate("WM-345", "selected"),
        candidate("WM-294", "selected"),
        candidate("WM-131", "selected"),
      ], { inFlightSeen: 2 }));
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toContain("queue_empty_readyCandidates_must_be_0 (got 3)");
      expect(err.violations).toContain("queue_empty_candidatesSeen_must_be_0 (got 3)");
    }
  });

  test("queue_empty requires complete candidate evidence to agree with the artifact", () => {
    try {
      verifyWorkPlan({
        recommendation: "NOOP",
        repo: "factory",
        ticket: null,
        plan: [],
        deferred: [],
        noopReason: "queue_empty",
        readyCandidates: 0,
        triageBacklog: 0,
        summary: "artifact says empty but evidence saw a candidate",
      }, candidateEvidence([candidate("WM-345", "selected")], { candidatesSeen: 0 }));
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toContain(
        "evidence_candidate_count_mismatch: candidatesSeen 0 != candidates.length 1",
      );
      expect(err.violations).toContain("queue_empty_candidates_must_be_empty");
    }
  });

  test("cap_full cannot hide startable candidates when capacity evidence shows a free slot", () => {
    try {
      verifyWorkPlan({
        recommendation: "NOOP",
        repo: "factory",
        ticket: null,
        plan: [],
        deferred: [],
        noopReason: "cap_full",
        readyCandidates: 3,
        triageBacklog: 0,
        summary: "incorrectly claims the cap is full",
      }, candidateEvidence([
        candidate("WM-345", "cap_full"),
        candidate("WM-294", "cap_full"),
        candidate("WM-131", "cap_full"),
      ], { inFlightSeen: 2, maxInFlight: 3 }));
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toContain(
        "cap_full_contradicts_capacity: inFlightSeen 2 < maxInFlight 3",
      );
    }
  });

  test("DISPATCH rejects an unaccounted candidate", () => {
    try {
      verifyWorkPlan({
        recommendation: "DISPATCH",
        repo: "factory",
        ticket: "WM-345",
        plan: [
          { ticket: "WM-345", ownedPaths: ["src/a/**"], reason: "priority Urgent, disjoint" },
        ],
        deferred: [{ ticket: "WM-294", reason: "owned_paths_overlap" }],
        readyCandidates: 3,
        triageBacklog: 0,
        summary: "one candidate disappeared",
      }, candidateEvidence([
        candidate("WM-345", "selected"),
        candidate("WM-294", "owned_paths_overlap"),
        candidate("WM-131", "cap_full"),
      ], { inFlightSeen: 2 }));
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toContain(
        "dispatch_candidate_accounting_mismatch: plan 1 + deferred 1 != candidatesSeen 3",
      );
    }
  });

  test("invalid LOW_SUPPLY counts violate work-scan semantics", () => {
    try {
      verifyWorkPlan({
        recommendation: "LOW_SUPPLY",
        repo: "low",
        ticket: null,
        plan: [],
        deferred: [],
        summary: "low supply with bad counts",
        readyCandidates: 3,
        triageBacklog: 0,
      }, candidateEvidence([
        candidate("WM-345", "selected"),
        candidate("WM-294", "selected"),
        candidate("WM-131", "selected"),
      ], { commands: ["linear queue", "linear triage"] }));
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toContain("low_supply_readyCandidates_must_be_0 (got 3)");
      expect(err.violations).toContain("low_supply_candidatesSeen_must_be_0 (got 3)");
    }
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

describe("failure normalization", () => {
  test("drops ANSI-colored warn lines so run-varying diagnostics do not change the signature", () => {
    expect(normalizeFailureOutput(
      "\u001b[33mwarn:\u001b[0m recorded ports 7740 / 7741 are occupied\nentry chunk exceeds budget\n",
    )).toEqual(["entry chunk exceeds budget"]);
    expect(normalizeFailureOutput(
      "warn: recorded ports 8120 / 8121 are occupied\nentry chunk exceeds budget\n",
    )).toEqual(["entry chunk exceeds budget"]);
  });
});

describe("worktree baseline verification (WM-334)", () => {
  const dispatchResult = {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: "ok",
    artifact: {
      outcome: "PR_OPEN",
      repo: "factory",
      ticket: "WM-334",
      prUrl: "https://github.com/watt-mind/factory/pull/334",
      verification: { command: "bun test", passed: true, output: "agent verification passed" },
      summary: "implemented WM-334",
    },
  };
  const dispatchSpec = {
    ...makeSpec({ repo: "factory", ticket: "WM-334" }),
    agent: "dispatch@1",
    outputContract: "factory.dispatch-result/v1",
  };

  function worktreeWorkspace(verify, baseline) {
    const dir = makeWorkspace(dispatchResult);
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(path.join(dir, ".worktree.json"), JSON.stringify({ path: repo, verify, baseline }), "utf8");
    return dir;
  }

  test("a matching pre-existing failure is rejected with the distinct baseline_red reason", () => {
    const dir = worktreeWorkspace(
      "printf 'entry chunk exceeds budget\\n' >&2; exit 9",
      { status: "red", check: "web_build", output: "entry chunk exceeds budget" },
    );
    try {
      verifyResult({ spec: dispatchSpec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.reasonCode).toBe("baseline_red");
      expect(err.violations[0]).toContain("repo_verify_failed");
    }
  });

  test("shared baseline output plus a new failure does not classify as baseline_red", () => {
    const dir = worktreeWorkspace(
      "printf 'entry chunk exceeds budget\\nnew failure in CI\\n' >&2; exit 9",
      { status: "red", check: "web_build", output: "entry chunk exceeds budget" },
    );
    try {
      verifyResult({ spec: dispatchSpec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.reasonCode).toBe("contract_violation");
    }
  });

  test("an unrelated post-agent failure remains an ordinary contract violation", () => {
    const dir = worktreeWorkspace(
      "printf 'new test regression\\nerror: script \"build\" exited with code 1\\n' >&2; exit 9",
      {
        status: "red",
        check: "web_build",
        output: "entry chunk exceeds budget\nerror: script \"build\" exited with code 1",
      },
    );
    try {
      verifyResult({ spec: dispatchSpec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.reasonCode).toBe("contract_violation");
    }
  });

  test("a multi-line verification failure retains the failing test name and full log", () => {
    const dir = worktreeWorkspace(
      "printf 'suite start\\n(fail) totals > rejects an invalid total\\nRan 2045 tests across 150 files.\\n'; printf 'error: expected 400, received 200\\n' >&2; exit 1",
      null,
    );
    try {
      verifyResult({ spec: dispatchSpec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations[0]).toContain("(fail) totals > rejects an invalid total");
      expect(err.violations[0]).toContain("error: expected 400, received 200");
    }

    const verifyLog = readFileSync(path.join(dir, ".verify.log"), "utf8");
    expect(verifyLog).toContain("suite start");
    expect(verifyLog).toContain("(fail) totals > rejects an invalid total");
    expect(verifyLog).toContain("Ran 2045 tests across 150 files.");
    expect(verifyLog).toContain("error: expected 400, received 200");
  });

  test("later error noise cannot displace a failing test name from the bounded reason", () => {
    const dir = worktreeWorkspace(
      "printf '(fail) billing > rejects a duplicate charge\\n'; i=1; while [ \"$i\" -le 45 ]; do printf 'error: detail %s\\n' \"$i\"; i=$((i + 1)); done; exit 1",
      null,
    );
    try {
      verifyResult({ spec: dispatchSpec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations[0]).toContain("(fail) billing > rejects a duplicate charge");
      expect(err.violations[0].split("\n").length).toBeLessThanOrEqual(40);
    }
  });

  test("a recorded red baseline never weakens a now-green post-agent verification", () => {
    const dir = worktreeWorkspace(
      "printf 'verification repaired\\n'",
      { status: "red", check: "web_build", output: "entry chunk exceeds budget" },
    );
    const out = verifyResult({ spec: dispatchSpec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });
    expect(out.kind).toBe("completed");
    expect(out.result.verification.checks).toContain("repo_verify_passed");
  });

  test("a timed-out repository verification fails closed without hanging", () => {
    const dir = worktreeWorkspace("while :; do :; done", null);
    const previous = process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS;
    process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS = "25";
    const started = Date.now();
    try {
      try {
        verifyResult({ spec: dispatchSpec, def: dispatchDef, registry, workspaceDir: dir, attempt: 1 });
        throw new Error("expected ContractViolation");
      } catch (err) {
        expect(err).toBeInstanceOf(ContractViolation);
        expect(err.violations).toEqual(["repo_verify_failed: timed out after 25ms"]);
        expect(Date.now() - started).toBeLessThan(1_000);
      }
    } finally {
      if (previous === undefined) delete process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS;
      else process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS = previous;
    }
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
