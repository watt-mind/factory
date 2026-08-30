/**
 * Recorded runs and the comparison between two of them (#1073).
 *
 * Determinism is honest here rather than assumed: two runs of the same cases
 * on the same models can disagree, so an absolute score alone cannot tell an
 * operator whether a prompt edit made things worse. What can is the DIFF —
 * which specific cases went from pass to fail — which is why every run is
 * written to `evals/.results/<timestamp>.json` with the models and the case
 * set it ran, and why `--compare` reports transitions rather than totals.
 *
 * The comparison also reports a grader change, because a run graded by a
 * different judge is not a comparable measurement, and reading it as one is
 * exactly the silent shift the pinned grader exists to prevent.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RESULTS_DIRNAME = ".results";

/** Colons are legal in a POSIX filename and miserable everywhere else. */
export function resultsFilename(date = new Date()) {
  return `${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

export function writeResults(dir, run, { date = new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, resultsFilename(date));
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return file;
}

export function readResults(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error(`${file}: not an evals results file (no "cases" array)`);
  }
  return parsed;
}

function byId(run) {
  return new Map((run?.cases ?? []).map((entry) => [entry.id, entry]));
}

/**
 * @returns {{regressions: Array, fixes: Array, added: Array<string>, removed: Array<string>, graderChanged: boolean, previousGrader: string|null, currentGrader: string|null, previousAt: string|null}}
 */
export function compareRuns(previous, current) {
  const before = byId(previous);
  const after = byId(current);
  const regressions = [];
  const fixes = [];
  const added = [];
  for (const [id, entry] of after) {
    const prior = before.get(id);
    if (!prior) {
      added.push(id);
      continue;
    }
    if (prior.status === "pass" && entry.status !== "pass") {
      regressions.push({
        id,
        was: prior.status,
        now: entry.status,
        reason: entry.reason,
      });
    } else if (prior.status !== "pass" && entry.status === "pass") {
      fixes.push({
        id,
        was: prior.status,
        now: entry.status,
        reason: entry.reason,
      });
    }
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const previousGrader = previous?.grader?.model ?? null;
  const currentGrader = current?.grader?.model ?? null;
  return {
    regressions,
    fixes,
    added,
    removed,
    graderChanged: Boolean(
      previousGrader && currentGrader && previousGrader !== currentGrader,
    ),
    previousGrader,
    currentGrader,
    previousAt: previous?.startedAt ?? null,
  };
}
