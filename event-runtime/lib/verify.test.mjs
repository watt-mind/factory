import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-verify-test-mjs";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { storeCollected } from "./artifacts.mjs";
import { hashJson, sha256Hex } from "./canonical.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import { execFileSync } from "node:child_process";
import {
  ContractViolation,
  HANDOFF_FAILURE_OUTPUT_MAX_CHARS,
  handoffFailureOutput,
  HANDOFF_HOST_ENV,
  HANDOFF_SANDBOX_INIT,
  HANDOFF_SANDBOX_SETUP,
  SandboxUnavailable,
  changedFilesSince,
  composeHandoffVerification,
  normalizeFailureOutput,
  outputTail,
  ownedPathsDeviations,
  HANDOFF_SANDBOX_MARKER,
  handoffRuntimeBinaries,
  handoffGitMounts,
  handoffSandboxAvailable,
  HANDOFF_SANDBOX_PYTHON,
  MAX_HANDOFF_SANDBOX_TMPFS_MB,
  clampHandoffSandboxTmpfsMb,
  isBunTestFile,
  insideHandoffSandbox,
  policyHandoffSandboxTmpfsMb,
  policyOwnedPathsConformance,
  runHandoffCommand,
  ticketVerifyCoveredByRepoVerify,
  verifyResult,
} from "./verify.mjs";

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
  const dir = tmpDir("evrt-verify-");
  if (result !== undefined) {
    writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(result),
      "utf8",
    );
  }
  return dir;
}

const VALID_ARTIFACT = {
  repos: [
    { name: "bj29", triage: 1, agentReady: 2, inProgress: 0, blocked: 0 },
  ],
  recommendedAction: "dispatch",
};

const VALID_DECISION = {
  schemaVersion: "factory.decision-request/v1",
  question: "May I proceed within the ticket's owned paths?",
  recommended: "authorise",
  options: [
    {
      id: "authorise",
      label: "Authorise",
      effect: "authorise",
      scope: {
        paths: ["event-runtime/lib/verify.mjs"],
        summary: "Apply the scoped change.",
      },
    },
    { id: "dismiss", label: "Dismiss", effect: "dismiss" },
  ],
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
    const out = verifyResult({
      spec,
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
      journalHead: "sha256:head",
    });
    expect(out.kind).toBe("completed");
    expect(out.result.terminalState).toBe("completed");
    expect(out.result.reasonCode).toBe("ok");
    expect(out.result.artifactHash).toBe(hashJson(VALID_ARTIFACT));
    expect(out.result.evidenceSetHash).toBe(hashJson(evidence));
    expect(out.result.verification.status).toBe("passed");
    expect(out.result.artifacts).toEqual([
      {
        kind: "log",
        uri: `file://${path.join(dir, "logs", "agent.log")}`,
        sha256: sha256Hex("hello\n"),
      },
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
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
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
    return verifyResult({
      spec: workPlanSpec,
      def: workScanDef,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
  }

  test("valid DISPATCH accounts for every candidate through plan or typed deferral", () => {
    const out = verifyWorkPlan(
      {
        recommendation: "DISPATCH",
        repo: "factory",
        ticket: "WM-345",
        plan: [
          {
            ticket: "WM-345",
            ownedPaths: ["src/a/**"],
            reason: "priority Urgent, disjoint",
          },
        ],
        deferred: [
          { ticket: "WM-294", reason: "owned_paths_overlap" },
          { ticket: "WM-131", reason: "cap_full" },
        ],
        readyCandidates: 3,
        triageBacklog: 0,
        summary: "one candidate starts and two are accounted for",
      },
      candidateEvidence(
        [
          candidate("WM-345", "selected"),
          candidate("WM-294", "owned_paths_overlap"),
          candidate("WM-131", "cap_full"),
        ],
        { inFlightSeen: 2 },
      ),
    );

    expect(out.kind).toBe("completed");
    expect(out.result.verification.checks).toContain("evidence_recomputed");
  });

  test("regression: three ready tickets plus two in progress cannot validate as queue_empty", () => {
    try {
      verifyWorkPlan(
        {
          recommendation: "NOOP",
          repo: "factory",
          ticket: null,
          plan: [],
          deferred: [],
          noopReason: "queue_empty",
          readyCandidates: 3,
          triageBacklog: 0,
          summary: "incorrectly discarded three ready candidates",
        },
        candidateEvidence(
          [
            candidate("WM-345", "selected"),
            candidate("WM-294", "selected"),
            candidate("WM-131", "selected"),
          ],
          { inFlightSeen: 2 },
        ),
      );
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toContain(
        "queue_empty_readyCandidates_must_be_0 (got 3)",
      );
      expect(err.violations).toContain(
        "queue_empty_candidatesSeen_must_be_0 (got 3)",
      );
    }
  });

  test("queue_empty requires complete candidate evidence to agree with the artifact", () => {
    try {
      verifyWorkPlan(
        {
          recommendation: "NOOP",
          repo: "factory",
          ticket: null,
          plan: [],
          deferred: [],
          noopReason: "queue_empty",
          readyCandidates: 0,
          triageBacklog: 0,
          summary: "artifact says empty but evidence saw a candidate",
        },
        candidateEvidence([candidate("WM-345", "selected")], {
          candidatesSeen: 0,
        }),
      );
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
      verifyWorkPlan(
        {
          recommendation: "NOOP",
          repo: "factory",
          ticket: null,
          plan: [],
          deferred: [],
          noopReason: "cap_full",
          readyCandidates: 3,
          triageBacklog: 0,
          summary: "incorrectly claims the cap is full",
        },
        candidateEvidence(
          [
            candidate("WM-345", "cap_full"),
            candidate("WM-294", "cap_full"),
            candidate("WM-131", "cap_full"),
          ],
          { inFlightSeen: 2, maxInFlight: 3 },
        ),
      );
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
      verifyWorkPlan(
        {
          recommendation: "DISPATCH",
          repo: "factory",
          ticket: "WM-345",
          plan: [
            {
              ticket: "WM-345",
              ownedPaths: ["src/a/**"],
              reason: "priority Urgent, disjoint",
            },
          ],
          deferred: [{ ticket: "WM-294", reason: "owned_paths_overlap" }],
          readyCandidates: 3,
          triageBacklog: 0,
          summary: "one candidate disappeared",
        },
        candidateEvidence(
          [
            candidate("WM-345", "selected"),
            candidate("WM-294", "owned_paths_overlap"),
            candidate("WM-131", "cap_full"),
          ],
          { inFlightSeen: 2 },
        ),
      );
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
      verifyWorkPlan(
        {
          recommendation: "LOW_SUPPLY",
          repo: "low",
          ticket: null,
          plan: [],
          deferred: [],
          summary: "low supply with bad counts",
          readyCandidates: 3,
          triageBacklog: 0,
        },
        candidateEvidence(
          [
            candidate("WM-345", "selected"),
            candidate("WM-294", "selected"),
            candidate("WM-131", "selected"),
          ],
          { commands: ["linear queue", "linear triage"] },
        ),
      );
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toContain(
        "low_supply_readyCandidates_must_be_0 (got 3)",
      );
      expect(err.violations).toContain(
        "low_supply_candidatesSeen_must_be_0 (got 3)",
      );
    }
  });

  test("schema-violating artifact → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: {
        repos: [
          { name: "x", triage: -1, agentReady: 0, inProgress: 0, blocked: 0 },
        ],
      },
    });
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
  });

  test("missing result.json → ContractViolation [missing_result]", () => {
    const dir = makeWorkspace();
    try {
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toEqual(["missing_result"]);
    }
  });

  test("unparseable result.json → ContractViolation", () => {
    const dir = makeWorkspace();
    writeFileSync(path.join(dir, "result.json"), "{not json", "utf8");
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
  });

  test("refused with a valid reasonCode → kind refused, no artifact fields", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
    });
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 2,
    });
    expect(out.kind).toBe("refused");
    expect(out.reasonCode).toBe("needs_human");
    expect(out.result.terminalState).toBe("refused");
    expect(out.result.attempt).toBe(2);
    expect(out.result.artifact).toBeUndefined();
    expect(out.result.artifactHash).toBeUndefined();
  });

  test("refused with a valid decision → decision retained", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
      decision: VALID_DECISION,
    });
    const spec = makeSpec({ repo: "factory", ticket: "WM-389" });
    const out = verifyResult({
      spec,
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("refused");
    expect(out.result.decision).toEqual(VALID_DECISION);
    expect(out.result.decisionErrors).toBeUndefined();
  });

  test("refused with an invalid decision → refusal retained with decision errors", () => {
    const decision = { ...VALID_DECISION, recommended: "missing" };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
      decision,
    });
    const spec = makeSpec({ repo: "factory", ticket: "WM-389" });
    const out = verifyResult({
      spec,
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("refused");
    expect(out.result.decision).toBeUndefined();
    expect(out.result.decisionErrors).toBeArray();
    expect(out.result.decisionErrors[0]).toContain("recommended");
  });

  test("completed with a decision → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      decision: VALID_DECISION,
    });
    try {
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toEqual([
        "decision_not_allowed_on_completed_result",
      ]);
    }
  });

  test("completed with a valid presentation → kept on the result, hash unchanged, run completes", () => {
    const presentation = {
      schemaVersion: "factory.presentation/v1",
      blocks: [
        { type: "heading", text: "Status report" },
        {
          type: "keyvalue",
          items: [
            {
              label: "Action",
              value: { $ref: "/recommendedAction" },
              format: "state",
            },
          ],
        },
      ],
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      presentation,
    });
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("completed");
    expect(out.result.presentation).toEqual(presentation);
    expect(out.result.presentationErrors).toBeUndefined();
    // presentation is view-only: not in the artifact hash or the receipt.
    expect(out.result.artifactHash).toBe(hashJson(VALID_ARTIFACT));
    expect(out.receipt.artifactHash).toBe(hashJson(VALID_ARTIFACT));
    expect(out.receipt.presentation).toBeUndefined();
    expect(out.result.verification.checks).toContain("presentation_validated");
  });

  test("completed with an invalid presentation → dropped with errors, still completed, hash unchanged", () => {
    const bad = {
      schemaVersion: "factory.presentation/v1",
      blocks: [
        {
          type: "keyvalue",
          items: [{ label: "x", value: { $ref: "/no/such/path" } }],
        },
      ],
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      presentation: bad,
    });
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("completed");
    expect(out.result.terminalState).toBe("completed");
    expect(out.result.presentation).toBeUndefined();
    expect(out.result.presentationErrors).toBeArray();
    expect(out.result.presentationErrors[0]).toContain("/no/such/path");
    // a malformed summary must not change the artifact hash vs no presentation
    expect(out.result.artifactHash).toBe(hashJson(VALID_ARTIFACT));
    expect(out.receipt.artifactHash).toBe(hashJson(VALID_ARTIFACT));
  });

  test("refused with a presentation → validated against the accepted artifact (or {})", () => {
    const presentation = {
      schemaVersion: "factory.presentation/v1",
      blocks: [{ type: "heading", text: "Why I stopped" }],
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
      presentation,
    });
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("refused");
    expect(out.result.presentation).toEqual(presentation);
    expect(out.result.presentationErrors).toBeUndefined();
    expect(out.result.verification.checks).toContain("presentation_validated");
  });

  test("refused with a presentation whose $ref needs the artifact → dropped when no artifact", () => {
    const presentation = {
      schemaVersion: "factory.presentation/v1",
      blocks: [
        {
          type: "keyvalue",
          items: [{ label: "x", value: { $ref: "/anything" } }],
        },
      ],
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
      presentation,
    });
    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("refused");
    expect(out.result.presentation).toBeUndefined();
    expect(out.result.presentationErrors).toBeArray();
    expect(out.result.presentationErrors[0]).toContain("/anything");
  });

  test("refused with an unknown reasonCode → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "felt_like_it",
    });
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
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
        output:
          "Not run: production infrastructure and credential handling require a human.",
      },
      summary:
        "Human approval is required for production launchd and SSH credential changes.",
    };
    const evidence = {
      commands: [
        "gh auth status",
        "launchctl print gui/$(id -u)/com.wattmind.factory",
      ],
    };
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "refused",
      reasonCode: "needs_human",
      artifact,
      evidence,
    });
    const spec = {
      ...makeSpec({ repo: "factory", ticket: "WM-139" }),
      outputContract: "factory.dispatch-result/v1",
    };

    const out = verifyResult({
      spec,
      def: dispatchDef,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });

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
    const spec = {
      ...makeSpec({ repo: "factory", ticket: "WM-139" }),
      outputContract: "factory.dispatch-result/v1",
    };
    expect(() =>
      verifyResult({
        spec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
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
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations).toEqual(["artifact_path_escape: ../outside.txt"]);
    }
  });

  for (const linkType of ["absolute", "relative"]) {
    test(`artifact path through ${linkType} intermediate symlink → ContractViolation`, () => {
      const dir = makeWorkspace({
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: VALID_ARTIFACT,
        artifacts: [{ kind: "log", path: "hop/secret.txt" }],
      });
      const outside = tmpDir("evrt-verify-outside-");
      writeFileSync(path.join(outside, "secret.txt"), "host secret\n", "utf8");
      const target =
        linkType === "absolute" ? outside : path.relative(dir, outside);
      symlinkSync(target, path.join(dir, "hop"), "dir");

      expect(() =>
        verifyResult({
          spec: makeSpec(),
          def,
          registry,
          workspaceDir: dir,
          attempt: 1,
        }),
      ).toThrow(ContractViolation);
    });
  }

  test("final symlink artifact → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      artifacts: [{ kind: "log", path: "linked.log" }],
    });
    writeFileSync(path.join(dir, "real.log"), "ordinary bytes\n", "utf8");
    symlinkSync("real.log", path.join(dir, "linked.log"));

    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
  });

  // WM-1017: on macOS a workspace enters as `/tmp/...` while its realpath is
  // `/private/tmp/...`. verifyCompleted() must record the workspace provenance
  // root in the same canonical namespace as the realpath'd artifact URI, or
  // storeCollected()'s `path.relative(root, src)` escapes the lexical root and
  // rejects a valid regular artifact with a PathViolation.
  test("workspace behind a symlinked parent → canonical provenance persists via storeCollected", () => {
    // A workspace directory reached through a symlinked parent, mimicking the
    // /tmp → /private/tmp alias without depending on the host's own /tmp.
    const realParent = tmpDir("evrt-verify-realparent-");
    const realWorkspace = path.join(realParent, "ws");
    mkdirSync(path.join(realWorkspace, "logs"), { recursive: true });

    const linkBase = tmpDir("evrt-verify-linkbase-");
    const aliasedParent = path.join(linkBase, "aliased");
    symlinkSync(realParent, aliasedParent, "dir");
    const workspaceDir = path.join(aliasedParent, "ws");

    writeFileSync(
      path.join(workspaceDir, "result.json"),
      JSON.stringify({
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: VALID_ARTIFACT,
        artifacts: [{ kind: "log", path: "logs/agent.log" }],
      }),
      "utf8",
    );
    writeFileSync(
      path.join(workspaceDir, "logs", "agent.log"),
      "hello\n",
      "utf8",
    );

    const out = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir,
      attempt: 1,
    });

    // The URI is spelled in the resolved namespace, not the symlinked alias.
    const canonicalFile = realpathSync(
      path.join(workspaceDir, "logs", "agent.log"),
    );
    const entry = out.result.artifacts[0];
    expect(entry.uri).toBe(`file://${canonicalFile}`);
    expect(entry.uri).not.toContain("aliased");
    expect(entry.sha256).toBe(sha256Hex("hello\n"));

    // Provenance shares that canonical namespace and stays internal: the
    // workspaceRoot property is non-enumerable and never serialized.
    const descriptor = Object.getOwnPropertyDescriptor(entry, "workspaceRoot");
    expect(descriptor.enumerable).toBe(false);
    expect(entry.workspaceRoot).toBe(realpathSync(workspaceDir));
    expect(JSON.stringify(out.result)).not.toContain("workspaceRoot");

    // The end-to-end proof: durable storage repeats confinement against the
    // canonical root and persists the artifact instead of throwing.
    const storeRoot = tmpDir("evrt-verify-store-");
    const stored = storeCollected({
      entries: out.result.artifacts,
      storeRoot,
      workspaceDir,
    });
    expect(stored[0].uri).toBe(`file://${path.join(storeRoot, entry.sha256)}`);
    expect(readFileSync(path.join(storeRoot, entry.sha256), "utf8")).toBe(
      "hello\n",
    );
  });

  test("declared artifact that does not exist → ContractViolation", () => {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      artifact: VALID_ARTIFACT,
      artifacts: [{ kind: "log", path: "missing.log" }],
    });
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
  });
});

describe("failure normalization", () => {
  test("drops ANSI-colored warn lines so run-varying diagnostics do not change the signature", () => {
    expect(
      normalizeFailureOutput(
        "\u001b[33mwarn:\u001b[0m recorded ports 7740 / 7741 are occupied\nentry chunk exceeds budget\n",
      ),
    ).toEqual(["entry chunk exceeds budget"]);
    expect(
      normalizeFailureOutput(
        "warn: recorded ports 8120 / 8121 are occupied\nentry chunk exceeds budget\n",
      ),
    ).toEqual(["entry chunk exceeds budget"]);
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
      verification: {
        command: "bun test",
        passed: true,
        output: "agent verification passed",
      },
      summary: "implemented WM-334",
    },
  };
  const dispatchSpec = {
    ...makeSpec({ repo: "factory", ticket: "WM-334" }),
    agent: "dispatch@1",
    outputContract: "factory.dispatch-result/v1",
  };

  // The worker holds the worktree record in memory and passes it to the
  // verifier; the on-disk marker is written because a real worktree workspace
  // has one, but it is agent-writable and the gate never reads it (#944).
  function worktreeWorkspace(verify, baseline) {
    const dir = makeWorkspace(dispatchResult);
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const record = { path: repo, verify, baseline };
    writeFileSync(
      path.join(dir, ".worktree.json"),
      JSON.stringify(record),
      "utf8",
    );
    return { dir, record };
  }

  test("a matching pre-existing failure is rejected with the distinct baseline_red reason", () => {
    const { dir, record } = worktreeWorkspace(
      "printf 'entry chunk exceeds budget\\n' >&2; exit 9",
      {
        status: "red",
        check: "web_build",
        output: "entry chunk exceeds budget",
      },
    );
    try {
      verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.reasonCode).toBe("baseline_red");
      expect(err.violations[0]).toContain("repo_verify_failed");
    }
  });

  // WM-718: a post-agent repo verify failure at handoff is the handoff gate
  // refusing (`handoff_verification_failed`), no longer a generic
  // `contract_violation` — same FAILED path, but named so the ticket goes back
  // to Todo + ai:agent-ready and the PR is held as draft.
  test("shared baseline output plus a new failure does not classify as baseline_red", () => {
    const { dir, record } = worktreeWorkspace(
      "printf 'entry chunk exceeds budget\\nnew failure in CI\\n' >&2; exit 9",
      {
        status: "red",
        check: "web_build",
        output: "entry chunk exceeds budget",
      },
    );
    try {
      verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.reasonCode).toBe("handoff_verification_failed");
      expect(err.handoff.repoVerify.exitCode).toBe(9);
    }
  });

  test("an unrelated post-agent failure refuses the handoff (not baseline_red)", () => {
    const { dir, record } = worktreeWorkspace(
      "printf 'new test regression\\nerror: script \"build\" exited with code 1\\n' >&2; exit 9",
      {
        status: "red",
        check: "web_build",
        output:
          'entry chunk exceeds budget\nerror: script "build" exited with code 1',
      },
    );
    try {
      verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.reasonCode).toBe("handoff_verification_failed");
      expect(err.violations[0]).toStartWith("repo_verify_failed:");
    }
  });

  test("a multi-line verification failure retains the failing test name and full log", () => {
    const { dir, record } = worktreeWorkspace(
      "printf 'suite start\\n(pass) timing-test registry (WM-918) > parseFailingTests reads bun (fail) and ✗ lines\\n(fail) totals > rejects an invalid total\\nRan 2045 tests across 150 files.\\n'; printf 'error: expected 400, received 200\\n' >&2; exit 1",
      null,
    );
    try {
      verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations[0]).toContain(
        "(fail) totals > rejects an invalid total",
      );
      expect(err.violations[0]).toContain("error: expected 400, received 200");
      // A passing test whose name contains "(fail)" is not a failure marker.
      expect(err.violations[0]).not.toContain("(pass) timing-test registry");
    }

    const verifyLog = readFileSync(path.join(dir, ".verify.log"), "utf8");
    expect(verifyLog).toContain("suite start");
    expect(verifyLog).toContain("(fail) totals > rejects an invalid total");
    expect(verifyLog).toContain("Ran 2045 tests across 150 files.");
    expect(verifyLog).toContain("error: expected 400, received 200");
  });

  test("handoff commands scrub instance FACTORY_* values and pin the worktree root", () => {
    const instanceRoot = tmpDir("evrt-handoff-instance-");
    const { dir, record } = worktreeWorkspace(
      'printf \'repos=%s\\nroot=%s\\nhome=%s\\nport=%s\\n\' "$FACTORY_REPOS_ROOT" "${FACTORY_ROOT-unset}" "${FACTORY_EVENT_HOME-unset}" "${FACTORY_EVENT_PORT-unset}"',
      null,
    );
    const keys = [
      "FACTORY_REPOS_ROOT",
      "FACTORY_ROOT",
      "FACTORY_EVENT_HOME",
      "FACTORY_EVENT_PORT",
    ];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      FACTORY_REPOS_ROOT: instanceRoot,
      FACTORY_ROOT: instanceRoot,
      FACTORY_EVENT_HOME: instanceRoot,
      FACTORY_EVENT_PORT: "9999",
    });
    try {
      const out = verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      expect(out.kind).toBe("completed");
      const observed = out.handoff.repoVerify.output;
      // The worktree is mounted at /workspace in the sandbox (#967); the pin
      // still names the worktree root, in the coordinates the command sees.
      // When this suite is itself running inside a sandbox the boundary does
      // not nest and the command keeps the real paths.
      expect(observed).toContain(
        `repos=${insideHandoffSandbox() ? realpathSync(record.path) : "/workspace"}`,
      );
      expect(observed).toContain("root=unset");
      expect(observed).toContain("home=unset");
      expect(observed).toContain("port=unset");
      expect(observed).not.toContain(instanceRoot);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("the web build pins FACTORY_REPOS_ROOT to the worktree root, not its web cwd", () => {
    const instanceRoot = tmpDir("evrt-handoff-instance-");
    const { dir, record } = worktreeWorkspace("true", null);
    record.base = "develop";
    const repo = record.path;
    const git = (...args) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "develop");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    const webDir = path.join(repo, "event-runtime", "web");
    mkdirSync(path.join(webDir, "src"), { recursive: true });
    writeFileSync(
      path.join(webDir, "package.json"),
      JSON.stringify({
        name: "web-fixture",
        scripts: {
          build:
            'printf \'cwd=%s\\nrepos=%s\\nroot=%s\\ntimeout=%s\\n\' "$PWD" "$FACTORY_REPOS_ROOT" "${FACTORY_ROOT-unset}" "${FACTORY_REPO_VERIFY_TIMEOUT_MS-unset}"',
        },
      }),
    );
    git("add", "-A");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    git("checkout", "-qb", "feat/x");
    writeFileSync(path.join(webDir, "src", "app.ts"), "export {};\n");
    git("add", "-A");
    git("commit", "-qm", "work");
    const keys = ["FACTORY_REPOS_ROOT", "FACTORY_ROOT"];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      FACTORY_REPOS_ROOT: instanceRoot,
      FACTORY_ROOT: instanceRoot,
    });
    try {
      const out = verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      expect(out.kind).toBe("completed");
      expect(out.result.verification.checks).toContain("web_build_passed");
      const observed = out.handoff.webBuild.output;
      const guestRoot = insideHandoffSandbox()
        ? realpathSync(repo)
        : "/workspace";
      expect(observed).toContain(`cwd=${guestRoot}/event-runtime/web`);
      expect(observed).toContain(`repos=${guestRoot}\n`);
      expect(observed).not.toContain(`repos=${guestRoot}/event-runtime/web`);
      expect(observed).toContain("root=unset");
      expect(observed).toContain("timeout=unset");
      expect(observed).not.toContain(instanceRoot);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("later error noise cannot displace a failing test name from the bounded reason", () => {
    const { dir, record } = worktreeWorkspace(
      "printf '(fail) billing > rejects a duplicate charge\\n'; i=1; while [ \"$i\" -le 45 ]; do printf 'error: detail %s\\n' \"$i\"; i=$((i + 1)); done; exit 1",
      null,
    );
    try {
      verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations[0]).toContain(
        "(fail) billing > rejects a duplicate charge",
      );
      expect(err.violations[0].split("\n").length).toBeLessThanOrEqual(40);
    }
  });

  test("a recorded red baseline never weakens a now-green post-agent verification", () => {
    const { dir, record } = worktreeWorkspace(
      "printf 'verification repaired\\n'",
      {
        status: "red",
        check: "web_build",
        output: "entry chunk exceeds budget",
      },
    );
    const out = verifyResult({
      spec: dispatchSpec,
      def: dispatchDef,
      registry,
      workspaceDir: dir,
      attempt: 1,
      worktreeRecord: record,
    });
    expect(out.kind).toBe("completed");
    expect(out.result.verification.checks).toContain("repo_verify_passed");
  });

  test("a ticket test command covered by the repo verify does not run a second sandbox step", () => {
    const { dir, record } = worktreeWorkspace(
      "bun test event-runtime/lib --timeout 20000",
      null,
    );
    const testFile = path.join(
      record.path,
      "event-runtime",
      "lib",
      "covered.test.mjs",
    );
    mkdirSync(path.dirname(testFile), { recursive: true });
    writeFileSync(
      testFile,
      'import { expect, test } from "bun:test"; test("covered", () => expect(true).toBe(true));\n',
    );
    record.handoff = {
      verificationCommand:
        "bun test event-runtime/lib/covered.test.mjs --timeout 30000",
    };

    const out = verifyResult({
      spec: dispatchSpec,
      def: dispatchDef,
      registry,
      workspaceDir: dir,
      attempt: 1,
      worktreeRecord: record,
    });

    expect(out.kind).toBe("completed");
    expect(out.handoff.verification).toBe(out.handoff.repoVerify);
    expect(out.result.verification.checks).toContain(
      "ticket_verify_covered_by_repo_verify",
    );
    expect(existsSync(path.join(dir, ".verify.ticket.log"))).toBe(false);
  });

  test("a ticket-step failure names its sandbox limits", () => {
    const { dir, record } = worktreeWorkspace("true", null);
    record.handoff = { verificationCommand: "printf ticket-red >&2; exit 7" };
    try {
      verifyResult({
        spec: dispatchSpec,
        def: dispatchDef,
        registry,
        workspaceDir: dir,
        attempt: 1,
        worktreeRecord: record,
      });
      throw new Error("expected ContractViolation");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect(err.violations[0]).toContain("ticket_verify_failed");
      expect(err.violations[0]).toContain("sandbox_limits: tmpfs=1024MiB");
      expect(err.violations[0]).toContain("namespaces=user,mount,pid,network");
    }
  });

  test("a timed-out repository verification fails closed without hanging", () => {
    const { dir, record } = worktreeWorkspace("while :; do :; done", null);
    const previous = process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS;
    process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS = "25";
    const started = Date.now();
    try {
      try {
        verifyResult({
          spec: dispatchSpec,
          def: dispatchDef,
          registry,
          workspaceDir: dir,
          attempt: 1,
          worktreeRecord: record,
        });
        throw new Error("expected ContractViolation");
      } catch (err) {
        expect(err).toBeInstanceOf(ContractViolation);
        expect(err.violations).toEqual([
          "repo_verify_failed: timed out after 25ms",
        ]);
        expect(Date.now() - started).toBeLessThan(1_000);
      }
    } finally {
      if (previous === undefined)
        delete process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS;
      else process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS = previous;
    }
  });
});

test("handoff sandbox exposes bunx through the Bun executable", () => {
  const binaries = handoffRuntimeBinaries((name) =>
    name === "bun" ? Bun.which("bun") : null,
  );
  const bun = binaries.find((entry) => entry.name === "bun");
  const bunx = binaries.find((entry) => entry.name === "bunx");
  expect(bunx).toEqual({ name: "bunx", executable: bun.executable });
});

// The workspace directory is agent-writable — the agent authors `result.json`
// there. Trusting a `.worktree.json` found next to it let an agent hand the
// gate its own activation flag, its own "repo verify" command and its own
// Owned Paths, i.e. certify its own PR_OPEN. Only the record the worker holds
// in memory (from createWorkspace) may drive the gate.
describe("handoff gate provenance (#944)", () => {
  const dispatchSpec = {
    ...makeSpec({ repo: "factory", ticket: "WM-944" }),
    agent: "dispatch@1",
    outputContract: "factory.dispatch-result/v1",
  };

  function forgedWorkspace(marker) {
    const dir = makeWorkspace({
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        outcome: "PR_OPEN",
        repo: "factory",
        ticket: "WM-944",
        prUrl: "https://github.com/watt-mind/factory/pull/944",
        verification: {
          command: "bun test",
          passed: true,
          output: "agent verification passed",
        },
        summary: "implemented WM-944",
      },
    });
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(
      path.join(dir, ".worktree.json"),
      JSON.stringify({ path: repo, ...marker }),
      "utf8",
    );
    return dir;
  }

  test("an agent-authored marker never activates the gate and its command is never executed", () => {
    const sentinel = path.join(tmpDir("evrt-marker-sentinel-"), "ran");
    const dir = forgedWorkspace({
      repo: "factory",
      verify: `printf 'forged verification\\n' > ${sentinel}`,
    });
    const out = verifyResult({
      spec: dispatchSpec,
      def: dispatchDef,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    // Form-only acceptance: schema and semantic checks still run, but nothing
    // the marker claimed was executed or recorded as a worker observation.
    expect(out.kind).toBe("completed");
    expect(out.handoff).toBeUndefined();
    expect(out.result.verification.checks).not.toContain("repo_verify_passed");
    expect(out.result.verification.checks).not.toContain(
      "ticket_verify_passed",
    );
    expect(existsSync(sentinel)).toBe(false);
  });

  test("a marker cannot supply the ticket verification command or Owned Paths", () => {
    const dir = forgedWorkspace({
      repo: "factory",
      handoff: {
        verificationCommand: "true",
        ownedPaths: ["**"],
        ownedPathsParsed: true,
      },
    });
    const out = verifyResult({
      spec: dispatchSpec,
      def: dispatchDef,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(out.kind).toBe("completed");
    expect(out.handoff).toBeUndefined();
    expect(existsSync(path.join(dir, ".verify.ticket.log"))).toBe(false);
  });

  test("the worker's in-memory record still drives the gate for the same workspace", () => {
    const dir = forgedWorkspace({
      repo: "factory",
      verify: "printf 'forged\\n'",
    });
    // Same on-disk marker, but the worker hands over the record it created:
    // the gate runs the worker's command, not the marker's.
    const out = verifyResult({
      spec: dispatchSpec,
      def: dispatchDef,
      registry,
      workspaceDir: dir,
      attempt: 1,
      worktreeRecord: {
        path: path.join(dir, "repo"),
        verify: "printf 'worker verification\\n'",
      },
    });
    expect(out.kind).toBe("completed");
    expect(out.result.verification.checks).toContain("repo_verify_passed");
    expect(readFileSync(path.join(dir, ".verify.log"), "utf8")).toContain(
      "worker verification",
    );
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
    const { result } = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(result.evidence).toEqual(evidence);
    expect(hashJson(result.evidence)).toBe(result.evidenceSetHash);
    expect(result.verification.checks).toContain("evidence_retained");
  });

  test("absent evidence stores null hash and no evidence field", () => {
    const dir = makeWorkspace(completedWith(undefined));
    const { result } = verifyResult({
      spec: makeSpec(),
      def,
      registry,
      workspaceDir: dir,
      attempt: 1,
    });
    expect(result.evidenceSetHash).toBeNull();
    expect("evidence" in result).toBe(false);
    expect(result.verification.checks).not.toContain("evidence_retained");
  });

  test("oversize evidence fails closed as a contract violation", () => {
    const dir = makeWorkspace(completedWith({ blob: "x".repeat(300 * 1024) }));
    expect(() =>
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      }),
    ).toThrow(ContractViolation);
    try {
      verifyResult({
        spec: makeSpec(),
        def,
        registry,
        workspaceDir: dir,
        attempt: 1,
      });
    } catch (err) {
      expect(err.violations[0]).toStartWith("evidence_too_large:");
    }
  });
});

describe("handoff failure diagnostics (#1529)", () => {
  test("a passing bun test that dies on a missing bunx keeps the fatal tail line", () => {
    const passes = Array.from(
      { length: 120 },
      (_, index) => `(pass) verify > case ${index} handles an error path`,
    ).join("\n");
    const output = `${passes}\n\n 120 pass\n 0 fail\nRan 120 tests across 3 files. [1.20s]\n\x1b[31mbash: line 1: bunx: command not found\x1b[0m\n`;
    const why = handoffFailureOutput({
      passed: false,
      exitCode: 127,
      timedOut: false,
      output,
    });
    expect(why.length).toBeLessThanOrEqual(HANDOFF_FAILURE_OUTPUT_MAX_CHARS);
    expect(why).toContain("bunx: command not found");
    expect(why).not.toContain("\x1b[");
  });

  test("timeouts, explicit failures, and silent exits keep the curated reason", () => {
    expect(
      handoffFailureOutput(
        { passed: false, exitCode: null, timedOut: true, output: "x" },
        { timeoutMs: 1234 },
      ),
    ).toBe("timed out after 1234ms");
    expect(
      handoffFailureOutput({
        passed: false,
        exitCode: 1,
        timedOut: false,
        output: "(pass) a\n(fail) b\n 1 pass\n 1 fail\n",
      }),
    ).toBe("(fail) b\n 1 fail");
    expect(
      handoffFailureOutput({
        passed: false,
        exitCode: 9,
        timedOut: false,
        output: "   \n",
      }),
    ).toBe("exit 9");
  });

  test("oversized diagnostics are bounded from the tail", () => {
    const output = `${"src/views/Ticket.tsx(12,34): error TS7053: element implicitly has an any type because expression cannot index noise\n".repeat(200)}src/views/Ticket.tsx: error TS2322 last\n`;
    const why = handoffFailureOutput({
      passed: false,
      exitCode: 2,
      timedOut: false,
      output,
    });
    expect(why.length).toBeLessThanOrEqual(HANDOFF_FAILURE_OUTPUT_MAX_CHARS);
    expect(why.startsWith("…")).toBe(true);
    expect(why.endsWith("error TS2322 last")).toBe(true);
  });
});

describe("handoff verification helpers (WM-718)", () => {
  test("ticket commands get a credential-free environment and namespace/chroot confinement", () => {
    const worktree = tmpDir("evrt-handoff-confined-");
    const logPath = path.join(worktree, "handoff.log");
    let invocation;
    const spawn = (file, args, options) => {
      invocation = { file, args, options };
      writeSync(options.stdio[1], "confined command ran\n");
      return { status: 0, error: null };
    };

    const obs = runHandoffCommand({
      command: "bun test focused.test.mjs",
      cwd: worktree,
      worktreePath: worktree,
      logPath,
      timeoutMs: 1_000,
      spawn,
      nested: false,
      sandboxAvailable: () => true,
      runtimeBinaries: [{ name: "bun", executable: "/safe/toolchain/bun" }],
    });

    expect(obs.passed).toBe(true);
    expect(obs.confinement).toContain("network namespace");
    expect(invocation.file).toBe("/usr/bin/timeout");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--signal=TERM",
        "--kill-after=0.1s",
        "/usr/bin/unshare",
        "--user",
        "--map-root-user",
        "--net",
        "--mount",
        "--pid",
        "--fork",
        "--kill-child=KILL",
        "/usr/bin/python3",
        HANDOFF_SANDBOX_INIT,
        HANDOFF_SANDBOX_SETUP,
        realpathSync(worktree),
        "/workspace",
        "bun",
        "/safe/toolchain/bun",
        "bun test focused.test.mjs",
      ]),
    );
    expect(HANDOFF_SANDBOX_SETUP).toContain("/usr/sbin/chroot");
    expect(HANDOFF_SANDBOX_INIT).toContain("os.wait()");
    expect(HANDOFF_SANDBOX_INIT).toContain("os.kill(-1, signal.SIGTERM)");
    expect(HANDOFF_SANDBOX_SETUP).toContain('mount --rbind "$workspace"');
    expect(HANDOFF_SANDBOX_SETUP).toContain('mount -t proc proc "$root/proc"');
    expect(HANDOFF_SANDBOX_SETUP).toContain('size="${tmpfs_mb}m"');
    expect(invocation.options.env).toEqual(HANDOFF_HOST_ENV);
    // GH-967: FACTORY_ROOT (which reposRoot() only reads as a fallback, and
    // which config.mjs derives from its own location anyway) is gone; the
    // repos-root pin #1214 established is re-established in guest
    // coordinates, at the mounted worktree.
    expect(HANDOFF_SANDBOX_SETUP).not.toContain("FACTORY_ROOT=");
    expect(HANDOFF_SANDBOX_SETUP).toContain("FACTORY_REPOS_ROOT=/workspace");
    for (const credential of [
      "LINEAR_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "SSH_AUTH_SOCK",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "FACTORY_EXTENSION_SECRET",
    ]) {
      expect(invocation.options.env[credential]).toBeUndefined();
    }
  });

  test("an unavailable sandbox refuses distinctly instead of running unconfined", () => {
    const worktree = tmpDir("evrt-handoff-nosandbox-");
    expect(() =>
      runHandoffCommand({
        command: "true",
        cwd: worktree,
        worktreePath: worktree,
        logPath: path.join(worktree, "handoff.log"),
        timeoutMs: 1_000,
        spawn: () => {
          throw new Error("must not spawn without a sandbox");
        },
        nested: false,
        sandboxAvailable: () => false,
      }),
    ).toThrow(SandboxUnavailable);
    // The probe itself answers from a spawn, never from a guess.
    expect(
      handoffSandboxAvailable({
        spawn: () => ({ status: 0, error: null }),
        cache: false,
        nested: false,
      }),
    ).toBe(true);
    expect(
      handoffSandboxAvailable({
        spawn: () => ({ status: 1, error: null }),
        cache: false,
        nested: false,
      }),
    ).toBe(false);
    expect(
      handoffSandboxAvailable({
        spawn: () => ({ status: null, error: new Error("ENOENT") }),
        cache: false,
        nested: false,
      }),
    ).toBe(false);
    // The init/setup interpreter is part of the boundary: without
    // /usr/bin/python3 the host reports sandbox_unavailable before spawning.
    let spawned = 0;
    expect(
      handoffSandboxAvailable({
        spawn: () => {
          spawned += 1;
          return { status: 0, error: null };
        },
        exists: (p) => p !== HANDOFF_SANDBOX_PYTHON,
        cache: false,
        nested: false,
      }),
    ).toBe(false);
    expect(spawned).toBe(0);
    expect(
      handoffSandboxAvailable({
        spawn: () => ({ status: 0, error: null }),
        exists: () => true,
        cache: false,
        nested: false,
      }),
    ).toBe(true);
  });

  test("only timeout's own verdict counts as a timeout", () => {
    const worktree = tmpDir("evrt-handoff-timeout-");
    let seq = 0;
    const run = (result, timeoutMs = 0) =>
      runHandoffCommand({
        command: "flaky",
        cwd: worktree,
        worktreePath: worktree,
        logPath: path.join(worktree, `handoff-${seq++}.log`),
        timeoutMs,
        nested: false,
        spawn: (_file, _args, options) => {
          writeSync(options.stdio[1], "output the reviewer needs\n");
          return result;
        },
        sandboxAvailable: () => true,
        runtimeBinaries: [],
      });

    // Elapsed >= budget is not evidence: a fast command on a slow host, or a
    // 137 the suite itself exited with, is a real red with real output.
    const killed = run({ status: 137, error: null });
    expect(killed.timedOut).toBe(false);
    expect(killed.exitCode).toBe(137);
    expect(killed.tail).toContain("output the reviewer needs");

    expect(run({ status: 124, error: null }).timedOut).toBe(true);
    // `timeout`'s own --kill-after escalation can take `timeout` with it.
    expect(run({ status: null, signal: "SIGKILL", error: null }).timedOut).toBe(
      true,
    );
    expect(run({ status: null, error: { code: "ETIMEDOUT" } }).timedOut).toBe(
      true,
    );
    // ...but a SIGKILL nowhere near the budget is somebody else's kill.
    expect(
      run({ status: null, signal: "SIGKILL", error: null }, 600_000).timedOut,
    ).toBe(false);
  });

  test("a git worktree's gitdir and the shared repo .git are reachable in the sandbox", () => {
    const base = realpathSync(tmpDir("evrt-handoff-git-"));
    const repo = path.join(base, "repo");
    mkdirSync(repo);
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q", "-b", "develop");
    writeFileSync(path.join(repo, "base.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const worktree = path.join(base, "wt");
    git("worktree", "add", "-q", "--detach", worktree);

    // A linked worktree's `.git` is a FILE pointing at an absolute host path.
    const mounts = handoffGitMounts(worktree);
    expect(mounts[0]).toEqual({
      path: path.join(repo, ".git", "worktrees", "wt"),
      mode: "rw",
    });
    expect(mounts[1]).toEqual({ path: path.join(repo, ".git"), mode: "ro" });
    // A plain checkout keeps its .git inside the bound workspace: no mounts.
    expect(handoffGitMounts(repo)).toEqual([]);

    if (insideHandoffSandbox()) return;
    if (!handoffSandboxAvailable({ cache: false, nested: false })) return;
    const obs = runHandoffCommand({
      command: "git status --porcelain=v1 && git log --oneline -1",
      cwd: worktree,
      worktreePath: worktree,
      logPath: path.join(base, "handoff.log"),
      timeoutMs: 60_000,
    });
    expect(obs.output).toContain("base");
    expect(obs.exitCode).toBe(0);
    expect(obs.passed).toBe(true);
  });

  test("the guest env carries only the worktree repos-root pin (GH-1214)", () => {
    // Skipped when this suite is itself running inside a handoff sandbox: the
    // boundary cannot nest, so there is no guest env to inspect.
    if (insideHandoffSandbox()) return;
    if (!handoffSandboxAvailable({ cache: false, nested: false })) return;
    const worktree = realpathSync(tmpDir("evrt-handoff-env-"));
    const obs = runHandoffCommand({
      command: "env | sort",
      cwd: worktree,
      worktreePath: worktree,
      logPath: path.join(worktree, "handoff.log"),
      timeoutMs: 60_000,
    });
    expect(obs.passed).toBe(true);
    // reposRoot() resolves inside the sandbox to the verified worktree, never
    // to the worker's factory root — which is not mounted at all.
    expect(obs.output).toContain("FACTORY_REPOS_ROOT=/workspace");
    const factoryVars = obs.output
      .split("\n")
      .filter((line) => line.startsWith("FACTORY_"))
      .sort();
    // The marker is the only other FACTORY_* the guest sees: the boundary
    // cannot nest (CLONE_NEWUSER is EPERM under chroot), so a handoff gate
    // running inside the sandbox passes commands through instead of refusing.
    expect(factoryVars).toEqual([
      `${HANDOFF_SANDBOX_MARKER}=1`,
      "FACTORY_REPOS_ROOT=/workspace",
    ]);
    expect(insideHandoffSandbox({ [HANDOFF_SANDBOX_MARKER]: "1" })).toBe(true);
    expect(insideHandoffSandbox({})).toBe(false);
  });

  test("inside the sandbox the command is passed through, not re-sandboxed", () => {
    const worktree = realpathSync(tmpDir("evrt-handoff-nested-"));
    {
      let invocation;
      const obs = runHandoffCommand({
        nested: true,
        command: "bun test focused.test.mjs",
        cwd: worktree,
        worktreePath: worktree,
        logPath: path.join(worktree, "handoff.log"),
        timeoutMs: 1_000,
        spawn: (file, args, options) => {
          invocation = { file, args, options };
          writeSync(options.stdio[1], "passed through\n");
          return { status: 0, error: null };
        },
        runtimeBinaries: [],
      });
      expect(obs.passed).toBe(true);
      expect(obs.confinement).toContain("inherited handoff sandbox");
      expect(invocation.args).not.toContain("/usr/bin/unshare");
      expect(invocation.args).toEqual([
        "--signal=TERM",
        "--kill-after=0.1s",
        "1s",
        "/bin/bash",
        "-c",
        "bun test focused.test.mjs",
      ]);
      // Still confined to the worktree, still pinned, still credential-free.
      expect(invocation.options.cwd).toBe(worktree);
      expect(invocation.options.env.FACTORY_REPOS_ROOT).toBe(worktree);
      expect(invocation.options.env.GITHUB_TOKEN).toBeUndefined();
      expect(invocation.options.env.LINEAR_API_KEY).toBeUndefined();
    }
  });

  test("the sandbox has a working loopback and no host network", () => {
    if (insideHandoffSandbox()) return;
    if (!handoffSandboxAvailable({ cache: false, nested: false })) return;
    const worktree = realpathSync(tmpDir("evrt-handoff-loopback-"));
    const obs = runHandoffCommand({
      // Bind + connect on 127.0.0.1: what 10+ suites in this repo do.
      command:
        "exec 3<>/dev/tcp/127.0.0.1/1 || true; ip -o link show lo; ip -o link | wc -l",
      cwd: worktree,
      worktreePath: worktree,
      logPath: path.join(worktree, "handoff.log"),
      timeoutMs: 60_000,
    });
    expect(obs.output).toContain("lo: <LOOPBACK,UP");
    // Loopback is the ONLY interface: the namespace still has no host network.
    expect(obs.output.trim().split("\n").pop().trim()).toBe("1");
  });

  test("the sandbox supplies standard fd links for Bash process substitution", () => {
    if (insideHandoffSandbox()) return;
    if (!handoffSandboxAvailable({ cache: false, nested: false })) return;
    const worktree = realpathSync(tmpDir("evrt-handoff-fd-"));
    const obs = runHandoffCommand({
      command:
        "bash -c 'cat <(echo ok)' && readlink /dev/fd && readlink /dev/stdin && readlink /dev/stdout && readlink /dev/stderr && find /dev -mindepth 1 -maxdepth 1 -printf '%f\\n' | sort",
      cwd: worktree,
      worktreePath: worktree,
      logPath: path.join(worktree, "handoff.log"),
      timeoutMs: 60_000,
    });
    expect(obs.passed).toBe(true);
    expect(obs.output).toContain("ok\n/proc/self/fd\n/proc/self/fd/0");
    expect(obs.output).toContain("/proc/self/fd/1\n/proc/self/fd/2");
    expect(obs.output.trim().split("\n").slice(-8)).toEqual([
      "fd",
      "null",
      "random",
      "stderr",
      "stdin",
      "stdout",
      "urandom",
      "zero",
    ]);
  });

  test("the sandbox exposes only read-only host alternatives under /etc", () => {
    if (insideHandoffSandbox()) return;
    if (!handoffSandboxAvailable({ cache: false, nested: false })) return;
    const worktree = realpathSync(tmpDir("evrt-handoff-alternatives-"));
    const hostHasAlternatives = existsSync("/etc/alternatives");
    const obs = runHandoffCommand({
      command:
        "test ! -e /etc/hostname && test ! -e /etc/passwd && if [ -d /etc/alternatives ]; then awk 'BEGIN { print 1 }'; test -r /etc/alternatives; ! touch /etc/alternatives/.factory-write-probe 2>/dev/null; else test ! -e /etc/alternatives; fi",
      cwd: worktree,
      worktreePath: worktree,
      logPath: path.join(worktree, "handoff.log"),
      timeoutMs: 60_000,
    });
    expect(obs.passed).toBe(true);
    if (hostHasAlternatives) expect(obs.output.trim()).toBe("1");
    else expect(obs.output.trim()).toBe("");
  });

  test("the PID-namespace init reaps a forked grandchild", () => {
    if (insideHandoffSandbox()) return;
    if (!handoffSandboxAvailable({ cache: false, nested: false })) return;
    const worktree = realpathSync(tmpDir("evrt-handoff-reap-"));
    const obs = runHandoffCommand({
      // The Python child exits without waiting for its forked child. The shell
      // remains active while polling /proc, so a zombie is observable unless
      // namespace PID 1 reaps it.
      command: String.raw`pid=$(/usr/bin/python3 -c 'import os; pid = os.fork(); os.write(1, f"{pid}\n".encode()) if pid else None; os._exit(0)'); for i in $(seq 1 10000); do [ ! -e /proc/$pid ] && exit 0; done; echo unreaped:$pid; exit 1`,
      cwd: worktree,
      worktreePath: worktree,
      logPath: path.join(worktree, "handoff.log"),
      timeoutMs: 60_000,
    });
    expect(obs.passed).toBe(true);
  });

  test("outputTail keeps the last N non-empty lines, ANSI stripped", () => {
    const out = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
      "\n\n",
    );
    const tail = outputTail(`\u001b[31m${out}\u001b[0m\n`);
    expect(tail.split("\n")).toHaveLength(40);
    expect(tail.startsWith("line 11")).toBe(true);
    expect(tail).not.toContain("\u001b");
  });

  test("ownedPathsDeviations: files outside every glob; ** or unknown owns everything", () => {
    const files = ["src/a.mjs", "docs/x.md", "web/src/App.tsx", "Makefile"];
    expect(ownedPathsDeviations(files, ["src/**", "web/src/*.tsx"])).toEqual([
      "docs/x.md",
      "Makefile",
    ]);
    expect(ownedPathsDeviations(files, ["**"])).toEqual([]);
    expect(ownedPathsDeviations(files, [])).toEqual([]);
    expect(ownedPathsDeviations(null, ["src/**"])).toEqual([]);
  });

  test("changedFilesSince diffs merge-base(origin/<base>)..HEAD and reports an unusable tree instead of guessing", () => {
    const dir = tmpDir("evrt-handoff-diff-");
    const git = (...args) => execFileSync("git", args, { cwd: dir });
    git("init", "-q", "-b", "develop");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(path.join(dir, "base.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    git("checkout", "-qb", "feat/x");
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "new.mjs"), "x\n");
    writeFileSync(path.join(dir, "base.txt"), "changed\n");
    git("add", "-A");
    git("commit", "-qm", "work");
    // Uncommitted noise is not part of the PR and is not counted.
    writeFileSync(path.join(dir, "scratch.txt"), "wip\n");
    const diff = changedFilesSince({ worktreePath: dir, base: "develop" });
    expect(diff.ok).toBe(true);
    expect(diff.baseRef).toBe("origin/develop");
    expect(diff.files).toEqual(["base.txt", "src/new.mjs"]);

    const notGit = tmpDir("evrt-handoff-nogit-");
    const none = changedFilesSince({ worktreePath: notGit, base: "develop" });
    expect(none.ok).toBe(false);
    expect(none.files).toBeNull();
    expect(
      changedFilesSince({ worktreePath: dir, base: null }).error,
    ).toContain("no base branch");
  });

  test("changedFilesSince fetches origin/<base> before computing merge-base (WM-718 F4)", () => {
    const calls = [];
    const gitStub = (args) => {
      calls.push(args);
      if (args[0] === "fetch") return "";
      if (args[0] === "merge-base") return "deadbeef";
      if (args[0] === "diff") return "a.txt\nb.txt";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const diff = changedFilesSince({
      worktreePath: "/irrelevant",
      base: "develop",
      git: gitStub,
    });
    expect(diff.ok).toBe(true);
    expect(diff.files).toEqual(["a.txt", "b.txt"]);
    expect(diff.base_ref_stale).toBeUndefined();
    // The fetch must precede the merge-base computation it is meant to keep
    // honest — not race it, not follow it.
    expect(calls[0]).toEqual(["fetch", "--quiet", "origin", "develop"]);
    expect(calls[1][0]).toBe("merge-base");
  });

  test("changedFilesSince proceeds on the local ref and flags base_ref_stale when the fetch fails (WM-718 F4)", () => {
    const calls = [];
    const gitStub = (args) => {
      calls.push(args);
      if (args[0] === "fetch") throw new Error("network unreachable");
      if (args[0] === "merge-base") return "deadbeef";
      if (args[0] === "diff") return "a.txt";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const diff = changedFilesSince({
      worktreePath: "/irrelevant",
      base: "develop",
      git: gitStub,
    });
    expect(diff.ok).toBe(true);
    expect(diff.base_ref_stale).toBe(true);
    // Still computed against the local origin/develop ref — a fetch failure
    // degrades, it never blocks the gate.
    expect(diff.baseRef).toBe("origin/develop");
    expect(calls[0][0]).toBe("fetch");
    expect(calls[1]).toEqual(["merge-base", "origin/develop", "HEAD"]);
  });

  test("policyOwnedPathsConformance defaults to advisory and only 'strict' tightens", () => {
    const root = tmpDir("evrt-handoff-policy-");
    expect(policyOwnedPathsConformance(root)).toBe("advisory");
    mkdirSync(path.join(root, "config"));
    const file = path.join(root, "config", "policy.yaml");
    writeFileSync(file, "dispatch:\n  owned_paths_conformance: strict\n");
    expect(policyOwnedPathsConformance(root)).toBe("strict");
    writeFileSync(file, "dispatch:\n  owned_paths_conformance: bogus\n");
    expect(policyOwnedPathsConformance(root)).toBe("advisory");
    writeFileSync(file, "dispatch: [not: valid\n");
    expect(policyOwnedPathsConformance(root)).toBe("advisory");
  });

  test("handoff tmpfs policy defaults safely and accepts configured MiB", () => {
    const root = tmpDir("evrt-handoff-tmpfs-policy-");
    expect(policyHandoffSandboxTmpfsMb(root)).toBe(1024);
    mkdirSync(path.join(root, "config"));
    const file = path.join(root, "config", "policy.yaml");
    writeFileSync(file, "sandbox:\n  tmpfs_mb: 2048\n");
    expect(policyHandoffSandboxTmpfsMb(root)).toBe(2048);
    writeFileSync(file, "sandbox:\n  tmpfs_mb: 512\n");
    expect(policyHandoffSandboxTmpfsMb(root)).toBe(1024);
    writeFileSync(file, "sandbox:\n  tmpfs_mb: 1024.5\n");
    expect(policyHandoffSandboxTmpfsMb(root)).toBe(1024);
    // Policy cannot hand the guest more host memory than the cap.
    writeFileSync(file, "sandbox:\n  tmpfs_mb: 65536\n");
    expect(policyHandoffSandboxTmpfsMb(root)).toBe(
      MAX_HANDOFF_SANDBOX_TMPFS_MB,
    );
    writeFileSync(file, "sandbox:\n  tmpfs_mb: 8192\n");
    expect(policyHandoffSandboxTmpfsMb(root)).toBe(8192);
    expect(clampHandoffSandboxTmpfsMb(Number.MAX_SAFE_INTEGER)).toBe(8192);
    expect(clampHandoffSandboxTmpfsMb(4096)).toBe(4096);
  });

  test("ticket verification coverage requires every test path within repo verify", () => {
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/verify.test.mjs --timeout 30000",
        "bun test event-runtime/lib --timeout 20000 && bun run format:check",
        { root: path.resolve(import.meta.dir, "..", "..") },
      ),
    ).toBe(true);
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/verify.test.mjs",
        "bun test event-runtime/cli.test.mjs",
      ),
    ).toBe(false);
  });

  test("directory coverage requires an existing bun test file; flag values never widen it", () => {
    const root = tmpDir("evrt-handoff-coverage-");
    mkdirSync(path.join(root, "event-runtime", "lib"), { recursive: true });
    writeFileSync(
      path.join(root, "event-runtime", "lib", "verify.test.mjs"),
      "",
    );
    writeFileSync(path.join(root, "event-runtime", "lib", "verify.mjs"), "");
    const repoVerify = "bun test event-runtime/lib --timeout 20000";
    // Real test file under the covering directory: covered.
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/verify.test.mjs",
        repoVerify,
        { root },
      ),
    ).toBe(true);
    // Missing file: directory discovery never ran it, so step 2 must run.
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/missing.test.mjs",
        repoVerify,
        { root },
      ),
    ).toBe(false);
    // Existing non-test module: not picked up by discovery either.
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/verify.mjs",
        repoVerify,
        { root },
      ),
    ).toBe(false);
    // Without a root, directory containment alone is not proof.
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/verify.test.mjs",
        repoVerify,
      ),
    ).toBe(false);
    // Exact path match still stands on its own.
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/other.test.mjs",
        "bun test event-runtime/lib/other.test.mjs",
      ),
    ).toBe(true);
    // A value-taking flag's argument is not a covering path.
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test event-runtime/lib/verify.test.mjs",
        "bun test --preload event-runtime/lib -t verify.test event-runtime/cli.test.mjs",
        { root },
      ),
    ).toBe(false);
    expect(
      ticketVerifyCoveredByRepoVerify(
        "bun test --timeout 30000 event-runtime/lib/verify.test.mjs",
        "bun test --preload ./setup.mjs event-runtime/lib",
        { root },
      ),
    ).toBe(true);
    expect(isBunTestFile("a/b.spec.ts")).toBe(true);
    expect(isBunTestFile("a/b_test.tsx")).toBe(true);
    expect(isBunTestFile("a/b.mjs")).toBe(false);
  });

  test("composeHandoffVerification only qualifies the PR draft state when it is known", () => {
    const base = { verification: null, repoVerify: null, webBuild: null };
    expect(
      composeHandoffVerification({ ...base, prNumber: 7, prDraft: true }),
    ).toContain("- PR: #7 (draft)");
    expect(
      composeHandoffVerification({ ...base, prNumber: 7, prDraft: false }),
    ).toContain("- PR: #7 (ready)");
    // pr_base_unreadable never sets prDraft; the worker drafts the PR after
    // this comment is composed, so "ready" would be a lie.
    expect(composeHandoffVerification({ ...base, prNumber: 7 })).toContain(
      "- PR: #7 (draft state unknown)",
    );
    expect(
      composeHandoffVerification({ ...base, prNumber: 7, prDraft: null }),
    ).toContain("- PR: #7 (draft state unknown)");
  });

  test("composeHandoffVerification is built from observation; the agent's claim is only agent-reported", () => {
    const body = composeHandoffVerification({
      prNumber: 42,
      prDraft: true,
      verification: {
        source: "ticket",
        command: "bun test",
        exitCode: 1,
        timedOut: false,
        passed: false,
        tail: "(fail) x > y\n1 fail",
      },
      repoVerify: {
        source: "repo_verify",
        command: "bun test event-runtime/lib",
        exitCode: 0,
        passed: true,
        tail: "ok",
      },
      webBuild: null,
      diff: {
        ok: true,
        baseRef: "origin/develop",
        mergeBase: "abcdef1234567890",
        files: ["a.mjs", "docs/b.md"],
      },
      ownedPathsKnown: true,
      ownedPathsConformance: "advisory",
      ownedPathsDeviations: ["docs/b.md"],
      descriptionHash: "sha256:deadbeef",
      agentReported: { command: "bun test", passed: true, output: "all green" },
    });
    const lines = body.split("\n");
    expect(lines[0]).toBe("## Handoff verification (worker-observed)");
    expect(lines[1]).toBe(
      "- PR: #42 (draft) · Fixes: unknown · run trailer: unknown",
    );
    expect(lines[2]).toBe("- Verification: `bun test` — exit 1 (FAIL)");
    expect(body).toContain("(fail) x > y");
    expect(body).toContain(
      "- Repo verify: `bun test event-runtime/lib` — exit 0 (pass)",
    );
    expect(body).toContain("- Web build: skipped");
    expect(body).toContain(
      "- Files: 2 changed vs origin/develop (abcdef123456)",
    );
    expect(body).toContain(
      "- Owned Paths deviations (advisory): 1 file(s) outside the ticket's Owned Paths",
    );
    expect(body).toContain("  - `docs/b.md`");
    // WM-718 F5: descriptionHash is otherwise dead — this is the one place
    // it is read, so a reader can tell if the ticket was amended after claim.
    expect(body).toContain(
      "- ticket description hash at claim: `sha256:deadbeef`",
    );
    expect(body).toContain("- agent-reported: `bun test` — pass, all green");
    expect(lines.filter((l) => l.startsWith("- Verification:"))).toHaveLength(
      1,
    );
  });

  test("composeHandoffVerification reports fetched PR form evidence", () => {
    const body = composeHandoffVerification({
      verification: null,
      repoVerify: null,
      webBuild: null,
      pr: {
        number: 77,
        draft: false,
        hasFixesLine: true,
        hasRunTrailer: false,
      },
    });
    expect(body).toContain("- PR: #77 (ready) · Fixes: yes · run trailer: no");
  });
});
