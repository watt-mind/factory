/**
 * Output (#1073). Human-readable by default, `--json` for CI.
 *
 * The human form leads with the failures and their reasons, because the only
 * question anyone asks a red eval run is "which case, and why". The JSON form
 * is the same object that gets written to `evals/.results/`, plus the
 * comparison when one was requested, so a CI job can consume stdout or the
 * results file interchangeably.
 */
import path from "node:path";

function rel(root, file) {
  if (!file) return "(not found)";
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

/** `--dry-run`: the case set and where each case's skill prompt resolves. */
export function formatDryRun({ cases, policy, repoRoot }) {
  const lines = [];
  lines.push(
    `${cases.length} case${cases.length === 1 ? "" : "s"} discovered (no model calls — dry run)`,
  );
  lines.push("");
  const width = Math.max(0, ...cases.map((entry) => entry.id.length));
  for (const entry of cases) {
    const source = entry.problem
      ? `!! ${entry.problem}`
      : rel(repoRoot, entry.skillSource);
    lines.push(`  ${entry.id.padEnd(width)}  ->  ${source}`);
  }
  lines.push("");
  lines.push(
    policy.grader
      ? `grader: ${policy.grader.model} (pinned in ${rel(repoRoot, policy.file)})`
      : `grader: UNPINNED — ${policy.problem}. A real run refuses to start until it is pinned; see evals/README.md.`,
  );
  lines.push(`subject: ${policy.subject.model}`);
  const broken = cases.filter((entry) => entry.problem).length;
  if (broken > 0)
    lines.push(`${broken} case(s) are not runnable (marked !! above)`);
  return lines.join("\n");
}

export function formatRun({ run, comparison = null, repoRoot }) {
  const lines = [];
  for (const entry of run.cases) {
    const mark = entry.status === "pass" ? "PASS" : "FAIL";
    lines.push(`${mark}  ${entry.id}  ${entry.reason}`);
  }
  lines.push("");
  const { total, passed, failed, costUsd } = run.totals;
  lines.push(
    `${passed}/${total} passed, ${failed} failed  ·  grader ${run.grader.model}  ·  subject ${run.subject.model}  ·  $${costUsd.toFixed(4)} notional`,
  );
  if (run.resultsFile) lines.push(`results: ${rel(repoRoot, run.resultsFile)}`);
  if (comparison) lines.push("", ...formatComparison(comparison));
  return lines.join("\n");
}

export function formatComparison(comparison) {
  const lines = [
    `compared against ${comparison.previousFile}${comparison.previousAt ? ` (${comparison.previousAt})` : ""}`,
  ];
  if (comparison.graderChanged) {
    lines.push(
      `  WARNING: graded by a different model (${comparison.previousGrader} -> ${comparison.currentGrader}); these runs are not directly comparable`,
    );
  }
  if (comparison.regressions.length === 0) lines.push("  no regressions");
  for (const entry of comparison.regressions) {
    lines.push(
      `  REGRESSION  ${entry.id}: ${entry.was} -> ${entry.now}  ${entry.reason}`,
    );
  }
  for (const entry of comparison.fixes) {
    lines.push(`  fixed       ${entry.id}: ${entry.was} -> ${entry.now}`);
  }
  for (const id of comparison.added) lines.push(`  new case    ${id}`);
  for (const id of comparison.removed) lines.push(`  gone        ${id}`);
  return lines;
}
