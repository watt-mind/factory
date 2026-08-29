#!/usr/bin/env node
/**
 * evals/run.mjs — the case runner that gates every prompt change
 * (watt-mind/factory#1073).
 *
 * Prompt changes are the only part of this system with no regression test.
 * This runs the frozen cases in `evals/cases/` against the skills under test
 * and grades each response against its `expect.md`. A case that regresses
 * fails the run, and the process exits non-zero — so the runner drops into CI
 * as a gate with no wrapper.
 *
 * Usage (matches evals/README.md):
 *   node evals/run.mjs                    run every case
 *   node evals/run.mjs --skill ticket-spec  run one skill's cases
 *   node evals/run.mjs --dry-run          list cases + skill source, no calls
 *   node evals/run.mjs --json             machine-readable output for CI
 *   node evals/run.mjs --compare <file>   diff this run against a prior one
 *
 * Bounds: --timeout <ms> per case (subject + grader each), --total-timeout
 * <ms> for the whole run. A hung grader fails its case, never the run.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCases, readCase } from "./lib/discover.mjs";
import { resolveGraderModel } from "./lib/policy.mjs";
import { makeClaudeGrader } from "./lib/grade.mjs";
import { makeClaudeSubject } from "./lib/skill.mjs";
import {
  buildRunRecord,
  compareRuns,
  loadResults,
  writeResults,
} from "./lib/results.mjs";
import { DEFAULT_MODEL_SENTINEL } from "./lib/spawn.mjs";

export const DEFAULT_PER_CASE_TIMEOUT_MS = 120_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;

const HELP = `evals/run.mjs — the case runner that gates every prompt change

Usage:
  node evals/run.mjs [options]

Options:
  --skill <name>       Run only this skill's cases
  --dry-run            List the cases that would run and their skill source; no model calls
  --json               Emit machine-readable JSON (for CI)
  --compare <file>     Diff this run against a prior .results/<ts>.json; report regressions
  --timeout <ms>       Per-case bound for the subject run and the grader (default ${DEFAULT_PER_CASE_TIMEOUT_MS})
  --total-timeout <ms> Total cap for the whole run (default ${DEFAULT_TOTAL_TIMEOUT_MS})
  --root <dir>         evals directory (default: the one containing this script)
  -h, --help           Show this help

Exit code is non-zero when any case fails, so this is usable as a CI gate.`;

/** Race a promise against a deadline; on timeout resolve to onTimeout() rather than reject. */
export function withDeadline(promise, ms, onTimeout) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

/**
 * Run cases and grade them. Model calls are injected (`runSkill`, `grade`) so
 * tests exercise the whole contract — discovery, exit, filtering, timeout,
 * compare — against fakes, with no real model call.
 *
 * @returns {Promise<{ record, cases, anyFail, totalCapped }>}
 */
export async function runEvals({
  root,
  factoryRoot = path.dirname(root),
  skill,
  runSkill,
  grade,
  graderModel,
  subjectModel = DEFAULT_MODEL_SENTINEL,
  perCaseTimeoutMs = DEFAULT_PER_CASE_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  clock = () => Date.now(),
  timestamp,
  persist = true,
  writeResultsFn = writeResults,
} = {}) {
  const discovered = discoverCases({ root, factoryRoot, skill });
  const started = clock();
  const elapsed = () => clock() - started;
  const results = [];
  let totalCapped = false;

  for (const testCase of discovered) {
    if (totalTimeoutMs && elapsed() > totalTimeoutMs) {
      totalCapped = true;
      results.push({
        skill: testCase.skill,
        name: testCase.name,
        pass: false,
        reason: "run exceeded total time cap",
      });
      continue;
    }
    if (testCase.error) {
      results.push({
        skill: testCase.skill,
        name: testCase.name,
        pass: false,
        reason: testCase.error,
      });
      continue;
    }

    let input;
    let expect;
    try {
      ({ input, expect } = readCase(testCase));
    } catch (err) {
      results.push({
        skill: testCase.skill,
        name: testCase.name,
        pass: false,
        reason: `unreadable case: ${err.message}`,
      });
      continue;
    }

    const subject = await withDeadline(
      Promise.resolve().then(() =>
        runSkill({
          testCase,
          input,
          model: subjectModel,
          timeoutMs: perCaseTimeoutMs,
          cwd: factoryRoot,
        }),
      ),
      perCaseTimeoutMs,
      () => ({ timedOut: true }),
    );
    if (!subject || subject.timedOut) {
      results.push({
        skill: testCase.skill,
        name: testCase.name,
        pass: false,
        reason: "skill run timed out",
      });
      continue;
    }

    const verdict = await withDeadline(
      Promise.resolve().then(() =>
        grade({
          testCase,
          expect,
          response: subject.response,
          model: graderModel,
          timeoutMs: perCaseTimeoutMs,
          cwd: factoryRoot,
        }),
      ),
      perCaseTimeoutMs,
      () => ({ pass: false, reason: "grader timed out" }),
    );

    results.push({
      skill: testCase.skill,
      name: testCase.name,
      pass: verdict?.pass === true,
      reason: verdict?.reason ?? "",
    });
  }

  const record = buildRunRecord({ graderModel, cases: results, timestamp });
  let resultsFile = null;
  if (persist) resultsFile = writeResultsFn(root, record);

  return {
    record,
    resultsFile,
    cases: results,
    anyFail: record.summary.failed > 0,
    totalCapped,
  };
}

function printHuman(out, { record, resultsFile, comparison }) {
  for (const c of record.cases) {
    out(`${c.pass ? "PASS" : "FAIL"}  ${c.skill}/${c.name} — ${c.reason}`);
  }
  const { total, passed, failed } = record.summary;
  out("");
  out(
    `${passed}/${total} passed, ${failed} failed  (grader: ${record.graderModel})`,
  );
  if (resultsFile) out(`results: ${resultsFile}`);
  if (comparison) {
    if (comparison.regressions.length > 0) {
      out(`REGRESSIONS vs baseline: ${comparison.regressions.join(", ")}`);
    } else {
      out("no regressions vs baseline");
    }
    if (comparison.fixed.length > 0) {
      out(`fixed vs baseline: ${comparison.fixed.join(", ")}`);
    }
  }
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      skill: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      compare: { type: "string" },
      timeout: { type: "string" },
      "total-timeout": { type: "string" },
      root: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  return values;
}

export async function main(argv = process.argv.slice(2), io = {}, deps = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  let values;
  try {
    values = parseCliArgs(argv);
  } catch (e) {
    err(e.message);
    return 2;
  }
  if (values.help) {
    out(HELP);
    return 0;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = values.root ? path.resolve(values.root) : here;
  const factoryRoot = path.dirname(root);
  const skill = values.skill;

  if (values["dry-run"]) {
    const cases = discoverCases({ root, factoryRoot, skill });
    if (values.json) {
      out(
        JSON.stringify(
          {
            dryRun: true,
            skill: skill ?? null,
            cases: cases.map((c) => ({
              skill: c.skill,
              name: c.name,
              skillSource: c.skillSource,
              error: c.error,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      out(`Would run ${cases.length} case(s):`);
      for (const c of cases) {
        const src = c.skillSource ?? "MISSING skill source";
        const flag = c.error ? `  [${c.error}]` : "";
        out(`  ${c.skill}/${c.name}  <- ${src}${flag}`);
      }
    }
    return 0;
  }

  const { model: graderModel, source: graderSource } = resolveGraderModel({
    factoryRoot,
  });
  const perCaseTimeoutMs = values.timeout
    ? Number(values.timeout)
    : DEFAULT_PER_CASE_TIMEOUT_MS;
  const totalTimeoutMs = values["total-timeout"]
    ? Number(values["total-timeout"])
    : DEFAULT_TOTAL_TIMEOUT_MS;

  if (!values.json) {
    out(`grader model: ${graderModel} (${graderSource})`);
  }

  const runSkill = deps.runSkill ?? makeClaudeSubject({ factoryRoot });
  const grade = deps.grade ?? makeClaudeGrader();

  let result;
  try {
    result = await runEvals({
      root,
      factoryRoot,
      skill,
      runSkill,
      grade,
      graderModel,
      perCaseTimeoutMs,
      totalTimeoutMs,
      persist: deps.persist ?? true,
    });
  } catch (e) {
    err(`eval run failed: ${e.message}`);
    return 2;
  }

  let comparison = null;
  if (values.compare) {
    try {
      const baseline = loadResults(path.resolve(values.compare));
      comparison = compareRuns(baseline, result.record);
    } catch (e) {
      err(`--compare failed: ${e.message}`);
      return 2;
    }
  }

  if (values.json) {
    out(JSON.stringify({ ...result.record, comparison }, null, 2));
  } else {
    printHuman(out, {
      record: result.record,
      resultsFile: result.resultsFile,
      comparison,
    });
  }

  const regressed = comparison ? comparison.regressions.length > 0 : false;
  return result.anyFail || regressed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
