/**
 * Run records and comparison for the eval runner (watt-mind/factory#1073).
 *
 * Determinism is honest, not assumed: every run records the model, the case
 * set, and per-case pass/fail into `evals/.results/<timestamp>.json`, and
 * `--compare <file>` diffs a run against a previous one. That makes a *drop*
 * detectable — a case that passed and now fails — not just an absolute score,
 * which is the number that quietly halves while nobody is looking.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RESULTS_VERSION = 1;
export const RESULTS_DIRNAME = ".results";

const caseKey = (c) => `${c.skill}/${c.name}`;

/** Assemble a run record from per-case results. Pure. */
export function buildRunRecord({ graderModel, cases, timestamp }) {
  const normalized = cases.map((c) => ({
    skill: c.skill,
    name: c.name,
    pass: c.pass === true,
    reason: c.reason ?? "",
  }));
  const passed = normalized.filter((c) => c.pass).length;
  return {
    version: RESULTS_VERSION,
    timestamp: timestamp ?? new Date().toISOString(),
    graderModel: graderModel ?? null,
    summary: {
      total: normalized.length,
      passed,
      failed: normalized.length - passed,
    },
    cases: normalized,
  };
}

/** A timestamp safe for a filename (colons break some filesystems/tools). */
export function resultsFilename(timestamp) {
  return `${String(timestamp).replace(/[:.]/g, "-")}.json`;
}

/** Persist a run record under `<root>/.results/`. Returns the file path. */
export function writeResults(root, record) {
  const dir = path.join(root, RESULTS_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, resultsFilename(record.timestamp));
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

/** Load a previously written run record. */
export function loadResults(file) {
  if (!existsSync(file)) {
    throw new Error(`compare file not found: ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Diff a current run against a baseline.
 *
 * @returns {{ regressions, fixed, added, removed }} where a **regression** is a
 *   case that passed in the baseline and fails now — the signal the whole
 *   `--compare` feature exists to surface.
 */
export function compareRuns(baseline, current) {
  const before = new Map((baseline.cases ?? []).map((c) => [caseKey(c), c]));
  const after = new Map((current.cases ?? []).map((c) => [caseKey(c), c]));

  const regressions = [];
  const fixed = [];
  const added = [];
  for (const [key, cur] of after) {
    const prev = before.get(key);
    if (!prev) {
      added.push(key);
      continue;
    }
    if (prev.pass && !cur.pass) regressions.push(key);
    else if (!prev.pass && cur.pass) fixed.push(key);
  }
  const removed = [];
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(key);
  }
  return { regressions, fixed, added, removed };
}
