/**
 * Deterministic test adapter (docs/event-runtime.md §6).
 *
 * Exercises every worker outcome — completion, refusal, contract violations,
 * crashes, timeouts, and workspace escape — without spawning a process or a
 * model. Behavior is selected by spec.input.repos[0], so the input still
 * validates against the real factory-status-report input schema and the rest
 * of the pipeline (planner, verifier, lifecycle) runs unmodified.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TRACE_EVENTS_CAP } from "../trace.mjs";

/**
 * Deterministic factory.trace/v1 sequence for the happy-path modes, so tests
 * can assert exact rows. Guarded: an adapter must never assume onTrace is
 * provided — adapters that ignore it (or callers that omit it) stay conformant.
 */
function emitTrace(onTrace, mode) {
  if (typeof onTrace !== "function") return;
  onTrace("assistant_text", { text: `fake: working on ${mode}` });
  onTrace("tool_use", { name: "Bash", input: { command: "fake-query" } });
  onTrace("tool_result", { content: "fake output" });
  onTrace("usage", { durationMs: 1, numTurns: 1, costUSD: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}

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

export async function execute({ spec, def, workspaceDir, timeoutMs, env, onTrace, abortSignal, signal }) {
  // Every real adapter captures the agent's output as a runtime artifact
  // (worker.mjs RUNTIME_ARTIFACTS). The fake must too, or it models a world
  // where transcripts do not exist — which is exactly what run-postmortem
  // consumes (OPS-373).
  writeFileSync(
    path.join(workspaceDir, ".transcript.json"),
    `${JSON.stringify(
      { adapter: "fake", agent: spec.agent, contract: spec.outputContract, input: spec.input },
      null,
      2,
    )}\n`,
    "utf8",
  );
  // Contract-shaped fakes for the chain slice (OPS-223) — behavior keyed on
  // the spec's output contract so planner/verifier/chain run unmodified.
  if (spec.outputContract === "factory.run-postmortem/v1") {
    const transcript = path.join(workspaceDir, "transcript.json");
    if (!existsSync(transcript)) {
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "refused",
        reasonCode: "missing_input",
      });
      return { exitCode: 0, timedOut: false };
    }
    const text = readFileSync(transcript, "utf8");
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        runId: spec.input.runId,
        category: "environment",
        whatHappened: `fake postmortem of ${spec.input.runId}`,
        operatorAction: "retry it",
        evidenceLines: [text.trim().split("\n").at(-1) ?? "empty"],
      },
      evidence: { transcriptBytes: text.length },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.ci-log/v1") {
    writeFileSync(path.join(workspaceDir, "failed.log"), `fake CI log for run ${spec.input?.runId}\nsocket hang up\n`, "utf8");
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: { command: ["fake"], exitCode: 0, outputTail: "", captured: "failed.log" },
      evidence: { command: ["fake"] },
      artifacts: [{ kind: "ci-log", path: "failed.log" }],
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.ci-doctor/v1") {
    // Prove the artifact was materialized: the fake reads the file the
    // workspace provider was supposed to write, and refuses if it is absent.
    const logPath = path.join(workspaceDir, "failed.log");
    if (!existsSync(logPath)) {
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "refused",
        reasonCode: "missing_input",
      });
      return { exitCode: 0, timedOut: false };
    }
    const logText = readFileSync(logPath, "utf8");
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: { ...ciDoctorArtifact(spec.input), evidenceLines: [logText.trim().split("\n").at(-1) ?? "empty"] },
      evidence: { commands: ["fake"], logBytes: logText.length },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.triage-plan/v1") {
    // Repo "clean" → NOOP; anything else proposes one agent-ready transition.
    const repo = spec.input?.repo;
    const clean = repo === "clean";
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: clean
        ? { recommendation: "NOOP", repo, plan: [], summary: "fake: queue already clean" }
        : {
            recommendation: "TRIAGE",
            repo,
            plan: [{ issueId: "CLNT-999", action: "label-agent-ready", reason: "fake: fully specified" }],
            summary: `fake triage of ${repo}`,
          },
      evidence: { commands: ["fake"], issuesSeen: 1 },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.unblock-plan/v1") {
    // Repo "clean" → NOOP; anything else releases one hold with evidence.
    const repo = spec.input?.repo;
    const clean = repo === "clean";
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: clean
        ? { recommendation: "NOOP", repo, plan: [], summary: "fake: no hold has new evidence" }
        : {
            recommendation: "UNBLOCK",
            repo,
            plan: [
              { issueId: "CLNT-998", action: "release-to-triage", reason: "fake: dependency merged" },
              { issueId: "CLNT-998", action: "comment-evidence", reason: "fake: dependency merged" },
            ],
            summary: `fake unblock of ${repo}`,
          },
      evidence: { commands: ["fake"], holdsSeen: 1 },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.unblock-applied/v1") {
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        repo: spec.input.repo,
        applied: (spec.input.plan ?? []).map((i) => ({ issueId: i.issueId, action: i.action })),
      },
      evidence: { commands: ["fake"] },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.sweep-plan/v1") {
    // Repo "clean" → NOOP; anything else retires one shipped ticket with evidence.
    const repo = spec.input?.repo;
    const clean = repo === "clean";
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: clean
        ? { recommendation: "NOOP", repo, plan: [], summary: "fake: nothing retirable with evidence" }
        : {
            recommendation: "SWEEP",
            repo,
            plan: [
              { issueId: "CLNT-997", action: "retire-shipped", reason: "fake: shipped in PR #1" },
              { issueId: "CLNT-997", action: "comment-evidence", reason: "fake: shipped in PR #1" },
            ],
            summary: `fake sweep of ${repo}`,
          },
      evidence: { commands: ["fake"], issuesSeen: 1 },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.sweep-applied/v1") {
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        repo: spec.input.repo,
        applied: (spec.input.plan ?? []).map((i) => ({ issueId: i.issueId, action: i.action })),
      },
      evidence: { commands: ["fake"] },
    });
    return { exitCode: 0, timedOut: false };
  }
  if (spec.outputContract === "factory.triage-applied/v1") {
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        repo: spec.input.repo,
        applied: (spec.input.plan ?? []).map((i) => ({ issueId: i.issueId, action: i.action })),
      },
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
  if (spec.outputContract === "factory.dispatch-result/v1") {
    const repo = spec.input?.repo ?? "factory";
    const ticket = spec.input?.ticket ?? "WM-100";
    const prUrl = `https://github.com/watt-mind/${repo}/pull/42`;
    writeResult(workspaceDir, {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "ok",
      artifact: {
        outcome: "PR_OPEN",
        repo,
        ticket,
        prUrl,
        verification: {
          command: "bun test",
          passed: true,
          output: "3 pass\n0 fail\nRan 3 tests across 1 file.",
        },
        summary: `fake dispatch completed with PR open for ${ticket}`,
      },
      evidence: {
        commands: ["bun test", "gh pr create"],
        prUrl,
        ticket,
      },
    });
    return { exitCode: 0, timedOut: false };
  }

  const mode = spec.input?.repos?.[0];

  switch (mode) {
    case "with-artifact": {
      emitTrace(onTrace, mode);
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

    case "hang": {
      // Resolves only when the timeout fires — or immediately when aborted (OPS-464).
      const sig = abortSignal ?? signal;
      if (sig?.aborted) return { exitCode: null, timedOut: false };
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        sig?.addEventListener?.("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return { exitCode: null, timedOut: !sig?.aborted };
    }

    case "trace-flood": {
      // Emits well past the per-attempt cap so tests can prove the recorder
      // stops at TRACE_EVENTS_CAP rows plus exactly one truncation marker.
      if (typeof onTrace === "function") {
        for (let i = 0; i < TRACE_EVENTS_CAP + 50; i += 1) {
          onTrace("assistant_text", { text: `flood ${i}` });
        }
      }
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode)], recommendedAction: "dispatch" },
        evidence: { queries: ["fake"] },
      });
      return { exitCode: 0, timedOut: false };
    }

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
      if (mode === "ok") emitTrace(onTrace, mode);
      writeResult(workspaceDir, {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        artifact: { repos: [repoRow(mode ?? "unknown")], recommendedAction: "dispatch" },
        evidence: { queries: ["fake"] },
      });
      return { exitCode: 0, timedOut: false };
  }
}
