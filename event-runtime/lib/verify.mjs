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
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
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
 * own verify at the time (`bun test && bun build/emit.mjs --check`, the full
 * suite) measured 196-217s, so nothing could ever pass. Sized at ~3x the
 * slowest observed run, which leaves room for a loaded host while staying far
 * under `limits.max_run_minutes: 90` in config/policy.yaml — the bound that
 * actually caps a wedged run. (The factory verify has since been narrowed to
 * `bun test event-runtime/lib && bun build/emit.mjs --check`, ~70s, WM-528 —
 * the ceiling stays where it is for the other repos.)
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

const REPO_VERIFY_REASON_MAX_LINES = 40;
const REPO_VERIFY_REASON_MAX_CHARS = 8 * 1024;
const REPO_VERIFY_TEST_FAILURE_LINE = /\(fail\)|✗/i;
const REPO_VERIFY_ERROR_LINE = /\berror\b/i;

function boundedDiagnostic(lines) {
  const excerpt = [];
  let remaining = REPO_VERIFY_REASON_MAX_CHARS;
  for (const line of lines) {
    const separatorLength = excerpt.length === 0 ? 0 : 1;
    if (remaining <= separatorLength) break;
    remaining -= separatorLength;
    if (line.length <= remaining) {
      excerpt.push(line);
      remaining -= line.length;
      continue;
    }
    excerpt.push(`${line.slice(0, Math.max(0, remaining - 1))}…`);
    break;
  }
  return excerpt.join("\n");
}

/**
 * Keep the actionable lines from a failed repository verification bounded for
 * the run reason. Explicit test-failure markers are retained before generic
 * errors, so later runner noise cannot displace the failing test names.
 */
function repoVerifyFailureExcerpt(output) {
  const lines = String(output ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";

  const testFailures = lines.filter((line) => REPO_VERIFY_TEST_FAILURE_LINE.test(line));
  const errors = lines.filter(
    (line) => !REPO_VERIFY_TEST_FAILURE_LINE.test(line) && REPO_VERIFY_ERROR_LINE.test(line),
  );
  if (testFailures.length === 0 && errors.length === 0) {
    return boundedDiagnostic(lines.slice(-REPO_VERIFY_REASON_MAX_LINES));
  }

  const excerpt = testFailures.slice(-REPO_VERIFY_REASON_MAX_LINES);
  const errorCapacity = Math.max(0, REPO_VERIFY_REASON_MAX_LINES - excerpt.length - 1);
  if (errorCapacity > 0) excerpt.push(...errors.slice(-errorCapacity));
  const summary = lines.at(-1);
  if (excerpt.length < REPO_VERIFY_REASON_MAX_LINES && !excerpt.includes(summary)) excerpt.push(summary);
  return boundedDiagnostic(excerpt);
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

/**
 * Work-scan is model-authored, so its individually valid fields still need a
 * deterministic consistency check (WM-350). The normalized candidate evidence
 * lets this verifier reconcile identities and dispositions instead of trusting
 * a summary count or model prose.
 */
function checkWorkPlan(candidate) {
  const { artifact, evidence } = candidate;
  const violations = [];
  const candidatesSeen = evidence?.candidatesSeen;
  const candidates = evidence?.candidates;
  const dispositions = new Set(["selected", "cap_full", "owned_paths_overlap"]);

  if (!Number.isInteger(candidatesSeen) || candidatesSeen < 0) {
    violations.push("evidence_candidatesSeen_required");
  }
  if (!Array.isArray(candidates)) {
    violations.push("evidence_candidates_required");
  }

  const normalizedCandidates = [];
  if (Array.isArray(candidates)) {
    for (const [index, entry] of candidates.entries()) {
      const valid = entry !== null
        && typeof entry === "object"
        && !Array.isArray(entry)
        && Object.keys(entry).length === 2
        && typeof entry.ticket === "string"
        && /^[A-Z]+-[0-9]+$/.test(entry.ticket)
        && dispositions.has(entry.disposition);
      if (!valid) {
        violations.push(`evidence_candidate_invalid_at_index_${index}`);
      } else {
        normalizedCandidates.push(entry);
      }
    }
    const candidateTickets = normalizedCandidates.map((entry) => entry.ticket);
    if (new Set(candidateTickets).size !== candidateTickets.length) {
      violations.push("evidence_candidate_tickets_must_be_unique");
    }
    if (Number.isInteger(candidatesSeen) && candidatesSeen !== candidates.length) {
      violations.push(
        `evidence_candidate_count_mismatch: candidatesSeen ${candidatesSeen} != candidates.length ${candidates.length}`,
      );
    }
  }

  if (!Number.isInteger(artifact.readyCandidates) || artifact.readyCandidates < 0) {
    violations.push("readyCandidates_required_for_work_plan");
  } else if (Number.isInteger(candidatesSeen) && artifact.readyCandidates !== candidatesSeen) {
    violations.push(
      `candidate_count_mismatch: readyCandidates ${artifact.readyCandidates} != evidence.candidatesSeen ${candidatesSeen}`,
    );
  }

  if (!Number.isInteger(artifact.triageBacklog) || artifact.triageBacklog < 0) {
    violations.push("triageBacklog_required_for_work_plan");
  }

  const planTickets = artifact.plan.map((item) => item.ticket);
  const deferredTickets = artifact.deferred.map((item) => item.ticket);
  const accountedTickets = [...planTickets, ...deferredTickets];
  if (new Set(accountedTickets).size !== accountedTickets.length) {
    violations.push("work_plan_ticket_accounting_must_be_unique");
  }

  const expectedTicket = planTickets[0] ?? null;
  if (artifact.ticket !== expectedTicket) {
    violations.push(`work_plan_ticket_must_equal_first_plan_ticket (expected ${expectedTicket})`);
  }

  if (artifact.recommendation === "DISPATCH") {
    if (artifact.plan.length === 0) violations.push("dispatch_plan_must_not_be_empty");
    if (Object.hasOwn(artifact, "noopReason")) violations.push("dispatch_must_not_have_noopReason");

    const evidencePlan = normalizedCandidates
      .filter((entry) => entry.disposition === "selected")
      .map((entry) => entry.ticket);
    const evidenceDeferred = normalizedCandidates
      .filter((entry) => entry.disposition !== "selected")
      .map((entry) => ({ ticket: entry.ticket, reason: entry.disposition }));
    if (JSON.stringify(planTickets) !== JSON.stringify(evidencePlan)) {
      violations.push("dispatch_plan_must_match_candidate_evidence");
    }
    if (JSON.stringify(artifact.deferred) !== JSON.stringify(evidenceDeferred)) {
      violations.push("dispatch_deferred_must_match_candidate_evidence");
    }
    if (Number.isInteger(candidatesSeen) && accountedTickets.length !== candidatesSeen) {
      violations.push(
        `dispatch_candidate_accounting_mismatch: plan ${artifact.plan.length} + deferred ${artifact.deferred.length} != candidatesSeen ${candidatesSeen}`,
      );
    }

    const hasCapDeferral = normalizedCandidates.some((entry) => entry.disposition === "cap_full");
    if (hasCapDeferral) {
      const inFlightSeen = evidence?.inFlightSeen;
      const maxInFlight = evidence?.maxInFlight;
      if (!Number.isInteger(inFlightSeen) || inFlightSeen < 0
        || !Number.isInteger(maxInFlight) || maxInFlight < 1) {
        violations.push("capacity_evidence_required_for_cap_full");
      } else if (inFlightSeen + artifact.plan.length < maxInFlight) {
        violations.push(
          `cap_full_contradicts_capacity: inFlightSeen ${inFlightSeen} + plan ${artifact.plan.length} < maxInFlight ${maxInFlight}`,
        );
      }
    }
    if (artifact.triageBacklog !== 0) {
      violations.push(`dispatch_triageBacklog_must_be_0 (got ${artifact.triageBacklog})`);
    }
  } else if (artifact.recommendation === "LOW_SUPPLY") {
    if (artifact.plan.length > 0 || artifact.deferred.length > 0) {
      violations.push("low_supply_plan_and_deferred_must_be_empty");
    }
    if (Object.hasOwn(artifact, "noopReason")) violations.push("low_supply_must_not_have_noopReason");
    if (artifact.readyCandidates !== 0) {
      violations.push(`low_supply_readyCandidates_must_be_0 (got ${artifact.readyCandidates})`);
    }
    if (Number.isInteger(candidatesSeen) && candidatesSeen !== 0) {
      violations.push(`low_supply_candidatesSeen_must_be_0 (got ${candidatesSeen})`);
    }
    if (normalizedCandidates.length !== 0) violations.push("low_supply_candidates_must_be_empty");
    if (Number.isInteger(artifact.triageBacklog) && artifact.triageBacklog < 1) {
      violations.push(`low_supply_triage_backlog_must_be_at_least_1 (got ${artifact.triageBacklog})`);
    }
  } else if (artifact.recommendation === "NOOP") {
    if (artifact.plan.length > 0 || artifact.deferred.length > 0) {
      violations.push("noop_plan_and_deferred_must_be_empty");
    }
    if (!Object.hasOwn(artifact, "noopReason")) {
      violations.push("noopReason_required_for_noop");
    } else if (artifact.noopReason === "queue_empty") {
      if (artifact.readyCandidates !== 0) {
        violations.push(`queue_empty_readyCandidates_must_be_0 (got ${artifact.readyCandidates})`);
      }
      if (Number.isInteger(candidatesSeen) && candidatesSeen !== 0) {
        violations.push(`queue_empty_candidatesSeen_must_be_0 (got ${candidatesSeen})`);
      }
      if (normalizedCandidates.length !== 0) violations.push("queue_empty_candidates_must_be_empty");
    } else if (artifact.noopReason === "cap_full") {
      if (normalizedCandidates.length === 0) violations.push("cap_full_candidates_must_not_be_empty");
      if (normalizedCandidates.some((entry) => entry.disposition !== "cap_full")) {
        violations.push("cap_full_candidates_must_all_have_cap_full_disposition");
      }
      const inFlightSeen = evidence?.inFlightSeen;
      const maxInFlight = evidence?.maxInFlight;
      if (!Number.isInteger(inFlightSeen) || inFlightSeen < 0
        || !Number.isInteger(maxInFlight) || maxInFlight < 1) {
        violations.push("capacity_evidence_required_for_cap_full");
      } else if (inFlightSeen < maxInFlight) {
        violations.push(`cap_full_contradicts_capacity: inFlightSeen ${inFlightSeen} < maxInFlight ${maxInFlight}`);
      }
    } else if (artifact.noopReason === "all_overlapping") {
      if (normalizedCandidates.length === 0) violations.push("all_overlapping_candidates_must_not_be_empty");
      if (normalizedCandidates.some((entry) => entry.disposition !== "owned_paths_overlap")) {
        violations.push("all_overlapping_candidates_must_all_have_overlap_disposition");
      }
    }
    if (artifact.triageBacklog !== 0) {
      violations.push(`noop_triageBacklog_must_be_0 (got ${artifact.triageBacklog})`);
    }
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
    const verifyLogPath = path.join(workspaceDir, ".verify.log");
    const verifyLogFd = openSync(verifyLogPath, "w");
    let vres;
    try {
      vres = spawnSync("/bin/bash", ["-c", worktreeRecord.verify], {
        cwd: worktreePath,
        stdio: ["ignore", verifyLogFd, verifyLogFd],
        timeout: verifyTimeoutMs,
      });
    } finally {
      closeSync(verifyLogFd);
    }
    const output = readFileSync(verifyLogPath, "utf8");
    if (vres.error?.code === "ETIMEDOUT" || vres.status !== 0) {
      const timedOut = vres.error?.code === "ETIMEDOUT";
      const why = timedOut
        ? `timed out after ${verifyTimeoutMs}ms`
        : repoVerifyFailureExcerpt(output) || `exit ${vres.status}`;
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
