/**
 * Deterministic test adapter (docs/event-runtime.md §6).
 *
 * Exercises every worker outcome — completion, refusal, contract violations,
 * crashes, timeouts, and workspace escape — without spawning a process or a
 * model. Behavior is selected by spec.input.repos[0], so the input still
 * validates against the real factory-status-report input schema and the rest
 * of the pipeline (planner, verifier, lifecycle) runs unmodified.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

function writeResult(workspaceDir, result) {
  writeFileSync(
    path.join(workspaceDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

function repoRow(name, overrides = {}) {
  return { name, triage: 1, agentReady: 2, inProgress: 0, blocked: 0, ...overrides };
}

/**
 * ci-doctor artifacts for chain tests/demos: the verdict rides in on the repo
 * name's suffix — `wm/x-ticket` → TICKET, `wm/x-env` → ENV, else FLAKE.
 */
function ciDoctorArtifact(input) {
  const repo = String(input?.repo ?? "");
  const verdict = repo.endsWith("-ticket") ? "TICKET" : repo.endsWith("-env") ? "ENV" : "FLAKE";
  return {
    verdict,
    culprit: "job Verify, step Setup bun",
    summary: `fake diagnosis of ${repo} run ${input?.runId}`,
    evidenceLines: ["socket hang up", "##[error]Error: socket hang up"],
  };
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({ spec, def, workspaceDir, timeoutMs, env }) {
  // Contract-shaped fakes for the chain slice (OPS-223) — behavior keyed on
  // the spec's output contract so planner/verifier/chain run unmodified.
  if (spec.outputContract === "factory.ci-doctor/v1") {
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: ciDoctorArtifact(spec.input),
      evidence: { commands: ["fake"] },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.disk-diagnosis/v1") {
    // Stale-alert semantics ride on the alert's own number: < 85% → NOOP.
    const stale = (spec.input?.usedPct ?? 100) < 85;
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: stale
        ? { recommendation: "NOOP", mount: spec.input.mount, usedPct: spec.input.usedPct, plan: [], analysis: "fake: disk healthy at diagnose time" }
        : {
            recommendation: "REMEDIATE",
            mount: spec.input.mount,
            usedPct: spec.input.usedPct,
            plan: [{ action: "docker-builder-prune", expectedReclaimBytes: 1_000_000 }],
            analysis: "fake: docker build cache is eating the disk",
          },
      evidence: { commands: ["fake df"], outputs: { df: "fake" } },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.disk-remediation/v1") {
    // mount "/bad" → a lying artifact, so tests can prove the verifier fails closed.
    const lying = spec.input?.mount === "/bad";
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        host: spec.input.host,
        mount: spec.input.mount,
        actions: (spec.input.actions ?? []).map((a) => a.action),
        beforeUsedBytes: 5_000_000,
        afterUsedBytes: 4_000_000,
        reclaimedBytes: lying ? 9_999_999 : 1_000_000,
      },
      evidence: { probeBefore: "5000000", probeAfter: "4000000", commands: ["fake"], outputs: {} },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.command-result/v1") {
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: { command: ["fake"], exitCode: 0, outputTail: "" },
      evidence: { command: ["fake"] },
    });
    return { exitCode: 0, timedOut: false };
  }

  const mode = spec.input?.repos?.[0];

  switch (mode) {
    case "with-artifact": {
      // Declares a file artifact and a transcript — exercises the §7 store.
      writeFileSync(path.join(workspaceDir, "report.txt"), `fake report for ${mode}\n`, "utf8");
      writeFileSync(path.join(workspaceDir, ".transcript.json"), `{"fake":"transcript"}\n`, "utf8");
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode)], recommendedAction: "wait" },
        evidence: { queries: ["fake"] },
        artifacts: [{ kind: "report", path: "report.txt" }],
      });
      return { exitCode: 0, timedOut: false };
    }

    case "refuse":
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "refused",
        reasonCode: "needs_human",
      });
      return { exitCode: 0, timedOut: false };

    case "invalid-artifact":
      // Violates the output schema: negative count and missing recommendedAction.
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode, { triage: -1 })] },
      });
      return { exitCode: 0, timedOut: false };

    case "no-result":
      return { exitCode: 0, timedOut: false };

    case "crash":
      return { exitCode: 1, timedOut: false };

    case "hang":
      // Resolves only when the timeout fires — no real long sleep in tests.
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return { exitCode: null, timedOut: true };

    case "escape":
      writeFileSync(path.resolve(workspaceDir, "..", "outside.txt"), "escaped\n", "utf8");
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode)], recommendedAction: "dispatch" },
        artifacts: [{ kind: "log", path: "../outside.txt" }],
      });
      return { exitCode: 0, timedOut: false };

    default:
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode ?? "unknown")], recommendedAction: "dispatch" },
        evidence: { queries: ["fake"] },
      });
      return { exitCode: 0, timedOut: false };
  }
}
