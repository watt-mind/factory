/**
 * Independent result verification (docs/event-runtime.md §9).
 *
 * The agent cannot certify its own result: this is ordinary code, outside the
 * model process, that reads the workspace's result.json and either produces
 * an accepted §5.3 run-result plus a compact receipt, or throws a typed
 * ContractViolation. Everything fails closed — a missing file, unparseable
 * JSON, an unknown refusal reason, a schema violation, an escaping artifact
 * path, or a declared artifact that does not exist are all violations, never
 * partial acceptances. These checks verify form, not truth (§9): semantic
 * evidence checking is slice 2.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hashBytes, hashJson, sha256Hex } from "./canonical.mjs";
import { validate } from "./schema.mjs";
import { PathViolation, safeJoin } from "./workspace.mjs";

/**
 * Declared evidence is retained inline in the accepted result (OPS-206): a
 * stored hash whose bytes were destroyed with the workspace could never be
 * rechecked, and slice 2's verifier recomputes derived values from evidence.
 * The limit is a §14 size bound — larger evidence fails closed until a real
 * case earns the content-addressed artifact store.
 */
export const EVIDENCE_INLINE_LIMIT_BYTES = 256 * 1024;

/**
 * Hang guard for the repository-owned verification command (WM-262), not a
 * performance budget — it exists to tell "wedged forever" from "running".
 *
 * 120s was below the real cost and failed every dispatch (WM-510): this repo's
 * own `bun test && bun build/emit.mjs --check` measures 196-217s, so nothing
 * could ever pass. Sized at ~3x the slowest observed run, which leaves room for
 * a loaded host while staying far under `limits.max_run_minutes: 45` in
 * config/policy.yaml — the bound that actually caps a wedged run.
 *
 * Raise this rather than trimming it to fit: a ceiling that only just fits is
 * the same outage with a longer fuse. Per-repo tuning goes through
 * FACTORY_REPO_VERIFY_TIMEOUT_MS.
 */
export const DEFAULT_REPO_VERIFY_TIMEOUT_MS = 600_000;

function repoVerifyTimeoutMs() {
  const configured = Number(process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REPO_VERIFY_TIMEOUT_MS;
}

export const REFUSAL_REASONS = [
  "missing_input",
  "permission_denied",
  "needs_human",
  "unsupported_capability",
];

export class ContractViolation extends Error {
  constructor(violations, { reasonCode = "contract_violation" } = {}) {
    super(`contract violation: ${violations.join("; ")}`);
    this.name = "ContractViolation";
    this.violations = violations;
    this.reasonCode = reasonCode;
  }
}

function normalizeFailureOutput(output) {
  return String(output ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Runners repeat these for unrelated failures; they are not evidence that
    // the same underlying check remains red.
    .filter((line) => !/^(\$ |bun test|error: script |error: ".*" exited|exited with code)/i.test(line));
}

/**
 * Deterministic normalized signature of a failure payload.
 * Exact equality is intentionally strict: any new signal (even a single
 * additional line) proves the failure signature changed.
 */
function failureSignature(output) {
  return normalizeFailureOutput(output).join("\n");
}

/**
 * Conservative evidence that post-agent verification hit the recorded red baseline.
 * Unlike partial line overlap, this compares full normalized signatures and fails
 * closed on ambiguous signal drift.
 */
function matchesRedBaseline(baseline, verifyOutput) {
  if (baseline?.status !== "red") return false;
  const baselineSig = failureSignature(baseline.output);
  const verifySig = failureSignature(verifyOutput);
  if (!baselineSig || !verifySig) return false;
  return baselineSig === verifySig;
}

export { normalizeFailureOutput, failureSignature };
/**
 * Verify one attempt's workspace output against the agent-result contract and
 * the agent definition's output schema.
 *
 * @returns {{ kind: "refused", reasonCode: string, result: object }
 *         | { kind: "completed", result: object, receipt: object }}
 * @throws {ContractViolation} on any contract failure — fail closed.
 */
export function verifyResult({
  spec,
  def,
  registry,
  workspaceDir,
  attempt,
  journalHead = null,
  extraArtifacts = [],
  worktreeRecord = null,
  verifyTimeoutMs = repoVerifyTimeoutMs(),
}) {
  let raw;
  try {
    raw = readFileSync(path.join(workspaceDir, "result.json"), "utf8");
  } catch {
    throw new ContractViolation(["missing_result"]);
  }

  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    throw new ContractViolation([`invalid_json: ${err.message}`]);
  }

  const shape = validate(registry.schemas.agentResult, candidate);
  if (!shape.valid) throw new ContractViolation(shape.errors);

  if (candidate.terminalState === "refused") return verifyRefused({ spec, def, candidate, attempt });
  return verifyCompleted({
    spec, def, candidate, workspaceDir, attempt, journalHead, extraArtifacts, worktreeRecord, verifyTimeoutMs,
  });
}

/**
 * Refusal is not failure (§5.3) — but only typed, known reasons are admitted.
 * An optional artifact explains the refusal through the same output contract
 * as a completion, so useful context is retained without weakening validation.
 */
function verifyRefused({ spec, def, candidate, attempt }) {
  const violations = [];
  if (!candidate.reasonCode) violations.push("refused_without_reason_code");
  else if (!REFUSAL_REASONS.includes(candidate.reasonCode)) {
    violations.push(`unknown_refusal_reason: ${candidate.reasonCode}`);
  }
  if (violations.length > 0) throw new ContractViolation(violations);

  const context = {};
  const checks = ["schema_valid"];
  if (candidate.artifact !== undefined) {
    const artifactCheck = validate(def.outputSchema, candidate.artifact);
    if (!artifactCheck.valid) throw new ContractViolation(artifactCheck.errors);

    const semantic = SEMANTIC_CHECKS[spec.outputContract];
    if (semantic) {
      const semanticViolations = semantic(candidate);
      if (semanticViolations.length > 0) throw new ContractViolation(semanticViolations);
      checks.push("evidence_recomputed");
    }

    context.artifact = candidate.artifact;
    context.artifactHash = hashJson(candidate.artifact);
    checks.push("hash_recomputed");
  }

  const { evidence, evidenceSetHash } = retainedEvidence(candidate);
  if (evidence !== undefined) {
    context.evidence = evidence;
    context.evidenceSetHash = evidenceSetHash;
    checks.push("evidence_retained");
  }

  const result = {
    schemaVersion: "factory.run-result/v1",
    runId: spec.runId,
    attempt,
    terminalState: "refused",
    reasonCode: candidate.reasonCode,
    outputContract: spec.outputContract,
    ...context,
    verification: { status: "passed", checks },
    artifacts: [],
  };
  return { kind: "refused", reasonCode: candidate.reasonCode, result };
}

function retainedEvidence(candidate) {
  if (candidate.evidence === undefined) return { evidence: undefined, evidenceSetHash: null };

  const canonical = canonicalJson(candidate.evidence);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > EVIDENCE_INLINE_LIMIT_BYTES) {
    throw new ContractViolation([`evidence_too_large: ${bytes} bytes > ${EVIDENCE_INLINE_LIMIT_BYTES}`]);
  }
  return { evidence: candidate.evidence, evidenceSetHash: hashBytes(canonical) };
}

/** Last integer in a raw probe output — `df --output=used -B1` style. */
function parseProbeBytes(raw) {
  const match = String(raw ?? "").trim().match(/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

/** `LOW_SUPPLY` in work-scan must carry exact candidate-count semantics. */
function checkWorkPlan(candidate) {
  const artifact = candidate?.artifact;
  if (artifact?.recommendation !== "LOW_SUPPLY") return [];
  const violations = [];

  if (!Number.isInteger(artifact.readyCandidates) || artifact.readyCandidates < 0) {
    violations.push("readyCandidates_required_for_low_supply");
  } else if (artifact.readyCandidates !== 0) {
    violations.push(`low_supply_readyCandidates_must_be_0 (got ${artifact.readyCandidates})`);
  }

  if (!Number.isInteger(artifact.triageBacklog) || artifact.triageBacklog < 0) {
    violations.push("triageBacklog_required_for_low_supply");
  } else if (artifact.triageBacklog < 1) {
    violations.push(`low_supply_triage_backlog_must_be_at_least_1 (got ${artifact.triageBacklog})`);
  }

  return violations;
}

/**
 * Semantic verification (§9, slice 2 / OPS-208): closed, data-only predicates
 * keyed by output contract. These check *truth*, not form — the claimed
 * numbers must be recomputable from the declared evidence, and a mismatch is
 * a ContractViolation, never a warning.
 */
const SEMANTIC_CHECKS = {
  "factory.disk-remediation/v1": (candidate) => {
    const violations = [];
    const { artifact, evidence } = candidate;
    if (evidence === undefined) return ["evidence_required: factory.disk-remediation/v1 claims are recomputed from probes"];
    const before = parseProbeBytes(evidence.probeBefore);
    const after = parseProbeBytes(evidence.probeAfter);
    if (before === null) violations.push("evidence_unparseable: probeBefore has no byte count");
    if (after === null) violations.push("evidence_unparseable: probeAfter has no byte count");
    if (violations.length > 0) return violations;
    if (artifact.beforeUsedBytes !== before) {
      violations.push(`evidence_mismatch: beforeUsedBytes ${artifact.beforeUsedBytes} != probed ${before}`);
    }
    if (artifact.afterUsedBytes !== after) {
      violations.push(`evidence_mismatch: afterUsedBytes ${artifact.afterUsedBytes} != probed ${after}`);
    }
    if (artifact.reclaimedBytes !== before - after) {
      violations.push(`evidence_mismatch: reclaimedBytes ${artifact.reclaimedBytes} != recomputed ${before - after}`);
    }
    return violations;
  },
  "factory.dispatch-result/v1": (candidate) => {
    const violations = [];
    const { artifact } = candidate;
    if (artifact.outcome === "PR_OPEN") {
      if (!artifact.prUrl) violations.push("pr_url_required_for_pr_open");
      if (artifact.verification?.passed !== true) violations.push("verification_must_pass_for_pr_open");
    }
    return violations;
  },
  "factory.work-plan/v1": (candidate) => checkWorkPlan(candidate),
};

function verifyCompleted({
  spec,
  def,
  candidate,
  workspaceDir,
  attempt,
  journalHead,
  extraArtifacts = [],
  worktreeRecord = null,
  verifyTimeoutMs,
}) {
  if (candidate.artifact === undefined) throw new ContractViolation(["missing_artifact"]);

  const artifactCheck = validate(def.outputSchema, candidate.artifact);
  if (!artifactCheck.valid) throw new ContractViolation(artifactCheck.errors);

  const semantic = SEMANTIC_CHECKS[spec.outputContract];
  if (semantic) {
    const semanticViolations = semantic(candidate);
    if (semanticViolations.length > 0) throw new ContractViolation(semanticViolations);
  }

  // Execute repo's declared verify command for tier-2 mutating runs (docs/event-runtime-dispatch.md §5, §9, WM-115)
  const markerPath = path.join(workspaceDir, ".worktree.json");
  if (!worktreeRecord && existsSync(markerPath)) {
    try {
      worktreeRecord = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {}
  }

  let repoVerifyPassed = false;
  if (worktreeRecord?.verify && candidate.artifact?.outcome === "PR_OPEN") {
    const worktreePath = worktreeRecord.path && existsSync(worktreeRecord.path)
      ? worktreeRecord.path
      : path.join(workspaceDir, "repo");
    const vres = spawnSync("/bin/bash", ["-c", worktreeRecord.verify], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: verifyTimeoutMs,
    });
    if (vres.error?.code === "ETIMEDOUT" || vres.status !== 0) {
      const output = [vres.stdout, vres.stderr].filter(Boolean).join("\n").trim();
      const timedOut = vres.error?.code === "ETIMEDOUT";
      const why = timedOut
        ? `timed out after ${verifyTimeoutMs}ms`
        : output.split("\n").filter(Boolean).pop() || `exit ${vres.status}`;
      const baselineStillRed = !timedOut && matchesRedBaseline(worktreeRecord.baseline, output);
      throw new ContractViolation(
        [`repo_verify_failed: ${why}`],
        { reasonCode: baselineStillRed ? "baseline_red" : "contract_violation" },
      );
    }
    repoVerifyPassed = true;
  }

  // Runtime-injected artifacts (e.g. the adapter's transcript): best-effort —
  // included when present, never a violation when absent, and never allowed
  // to shadow something the agent itself declared.
  const declared = candidate.artifacts ?? [];
  const declaredPaths = new Set(declared.map((entry) => entry.path));
  const injected = extraArtifacts.filter(
    (entry) => !declaredPaths.has(entry.path) && existsSync(path.join(workspaceDir, entry.path)),
  );

  const violations = [];
  const collected = [];
  for (const entry of [...declared, ...injected]) {
    let abs;
    try {
      abs = safeJoin(workspaceDir, entry.path);
    } catch (err) {
      if (!(err instanceof PathViolation)) throw err;
      violations.push(`artifact_path_escape: ${entry.path}`);
      continue;
    }
    if (!existsSync(abs)) {
      violations.push(`artifact_missing: ${entry.path}`);
      continue;
    }
    collected.push({ kind: entry.kind, uri: `file://${abs}`, sha256: sha256Hex(readFileSync(abs)) });
  }
  if (violations.length > 0) throw new ContractViolation(violations);

  const artifactHash = hashJson(candidate.artifact);

  const { evidence, evidenceSetHash } = retainedEvidence(candidate);

  const result = {
    schemaVersion: "factory.run-result/v1",
    runId: spec.runId,
    attempt,
    terminalState: "completed",
    reasonCode: "ok",
    outputContract: spec.outputContract,
    artifact: candidate.artifact,
    artifactHash,
    ...(evidence !== undefined ? { evidence } : {}),
    evidenceSetHash,
    verification: {
      status: "passed",
      checks: [
        "schema_valid", "hash_recomputed", "paths_confined", "artifacts_exist",
        ...(evidence !== undefined ? ["evidence_retained"] : []),
        ...(SEMANTIC_CHECKS[spec.outputContract] ? ["evidence_recomputed"] : []),
        ...(repoVerifyPassed ? ["repo_verify_passed"] : []),
      ],
    },
    artifacts: collected,
  };
  const receipt = {
    runId: spec.runId,
    runSpecHash: hashJson(spec),
    artifactHash,
    evidenceSetHash,
    journalHead,
    verificationStatus: "passed",
  };
  return { kind: "completed", result, receipt };
}
