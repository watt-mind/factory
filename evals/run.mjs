/**
 * evals/run.mjs — the case runner that gates every prompt change (#1073).
 *
 * Prompt changes are the only part of this system with no regression test.
 * This runner is that test: it replays frozen cases through a skill and has a
 * PINNED grader model judge the response against `expect.md`, so a prompt edit
 * that quietly degrades a skill fails a PR instead of surfacing weeks later as
 * a halved merge rate.
 *
 *   node evals/run.mjs                    # every case
 *   node evals/run.mjs --skill ticket-spec
 *   node evals/run.mjs --dry-run          # discovery only, zero model calls
 *   node evals/run.mjs --json             # machine-readable, for CI
 *   node evals/run.mjs --compare evals/.results/<file>.json
 *
 * Exit codes: 0 everything passed · 1 a case failed or regressed · 2 the
 * runner could not run (bad flag, no cases, unpinned grader). The non-zero
 * exit is the whole CI contract — no wrapper script required.
 *
 * Model calls live behind a two-function seam (`runSkill`, `grade`) that
 * `main()` accepts as a parameter. `evals/run.test.mjs` passes fakes through
 * it, so the suite exercises discovery, filtering, the exit contract, the
 * timeout path, and regression comparison without spending anything.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "./lib/case-run.mjs";
import { discoverCases, knownSkills } from "./lib/cases.mjs";
import { modelRunners } from "./lib/grader.mjs";
import { EvalConfigError, loadEvalPolicy, requirePin } from "./lib/policy.mjs";
import { formatDryRun, formatRun } from "./lib/report.mjs";
import {
  RESULTS_DIRNAME,
  compareRuns,
  readResults,
  writeResults,
} from "./lib/results.mjs";

export const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.dirname(EVALS_DIR);

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = `usage: node evals/run.mjs [options]

  --skill <name>           run only this skill's cases
  --dry-run                list the cases and their resolved skill source; makes no model calls
  --json                   emit the run as JSON on stdout (for CI)
  --compare <file>         diff this run against a previous results file; a pass -> fail
                           transition is a regression and exits non-zero
  --results-dir <dir>      where to write the run record (default evals/${RESULTS_DIRNAME})
  --no-results             do not write a run record
  --timeout <seconds>      per-case timeout override
  --budget <usd>           per-case budget override
  --total-timeout <seconds>  whole-run time cap override
  --total-budget <usd>     whole-run budget cap override
  -h, --help               this text

Models come from the \`evals:\` stanza of config/policy.yaml. The grader is
pinned by name there so a grader upgrade is a reviewable change, never a
silent shift in the pass bar; see evals/README.md.`;

class UsageError extends Error {}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

function positive(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(
      `${flag} must be a positive number (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    skill: null,
    dryRun: false,
    json: false,
    compare: null,
    resultsDir: null,
    writeResults: true,
    help: false,
    overrides: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-results":
        options.writeResults = false;
        break;
      case "--skill":
        options.skill = requireValue(argv, i, arg);
        i += 1;
        break;
      case "--compare":
        options.compare = requireValue(argv, i, arg);
        i += 1;
        break;
      case "--results-dir":
        options.resultsDir = requireValue(argv, i, arg);
        i += 1;
        break;
      case "--timeout":
        options.overrides.caseTimeoutSeconds = positive(
          requireValue(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--budget":
        options.overrides.caseBudgetUsd = positive(
          requireValue(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--total-timeout":
        options.overrides.totalSeconds = positive(
          requireValue(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      case "--total-budget":
        options.overrides.totalBudgetUsd = positive(
          requireValue(argv, i, arg),
          arg,
        );
        i += 1;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

function writeLine(stream, text) {
  stream?.write?.(`${text}\n`);
}

/**
 * @param {object} options
 * @param {string[]} options.argv           process.argv.slice(2)
 * @param {{runSkill: Function, grade: Function}} [options.deps]  the model seam; tests pass fakes
 * @returns {Promise<number>} the process exit code
 */
export async function main({
  argv = [],
  stdout = process.stdout,
  stderr = process.stderr,
  repoRoot = REPO_ROOT,
  evalsDir = EVALS_DIR,
  deps = null,
  policy: injectedPolicy = null,
  loadPolicy = loadEvalPolicy,
  now = () => Date.now(),
  date = () => new Date(),
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeLine(stderr, `evals: ${error.message}`);
    writeLine(stderr, USAGE);
    return EXIT_USAGE;
  }
  if (options.help) {
    writeLine(stdout, USAGE);
    return EXIT_OK;
  }

  let policy;
  try {
    policy = injectedPolicy ?? loadPolicy({ root: repoRoot });
  } catch (error) {
    if (!(error instanceof EvalConfigError)) throw error;
    writeLine(stderr, `evals: ${error.message}`);
    return EXIT_USAGE;
  }
  const limits = { ...policy.limits, ...options.overrides };

  if (options.skill !== null) {
    const available = knownSkills({ evalsDir });
    if (!available.includes(options.skill)) {
      writeLine(
        stderr,
        `evals: no cases for skill ${JSON.stringify(options.skill)} (have: ${available.join(", ") || "none"})`,
      );
      return EXIT_USAGE;
    }
  }
  const cases = discoverCases({ evalsDir, repoRoot, skill: options.skill });
  if (cases.length === 0) {
    writeLine(
      stderr,
      `evals: no cases found under ${path.join(evalsDir, "cases")}`,
    );
    return EXIT_USAGE;
  }

  if (options.dryRun) {
    const broken = cases.filter((entry) => entry.problem);
    if (options.json) {
      writeLine(
        stdout,
        JSON.stringify(
          {
            dryRun: true,
            grader: policy.grader ?? null,
            graderProblem: policy.problem ?? null,
            subject: policy.subject,
            limits,
            cases: cases.map((entry) => ({
              id: entry.id,
              candidateName: entry.candidateName,
              case: entry.name,
              candidateSource: entry.candidateSource,
              problem: entry.problem,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      writeLine(stdout, formatDryRun({ cases, policy, repoRoot }));
    }
    // Discovery is the cheap place to catch a case the suite cannot run;
    // reporting it and exiting 0 would hide a hole in the regression net.
    return broken.length > 0 ? EXIT_FAILED : EXIT_OK;
  }

  try {
    requirePin(policy);
  } catch (error) {
    if (!(error instanceof EvalConfigError)) throw error;
    writeLine(stderr, `evals: ${error.message}`);
    return EXIT_USAGE;
  }

  let previous = null;
  if (options.compare) {
    try {
      previous = readResults(options.compare);
    } catch (error) {
      writeLine(
        stderr,
        `evals: --compare ${options.compare}: ${error.message}`,
      );
      return EXIT_USAGE;
    }
  }

  const runners = deps ?? modelRunners({ repoRoot, policy });
  const suite = await runSuite({
    cases,
    runSkill: runners.runSkill,
    grade: runners.grade,
    limits,
    now,
    onResult: options.json
      ? null
      : (result) =>
          writeLine(
            stderr,
            `${result.status === "pass" ? "PASS" : "FAIL"}  ${result.id}  ${result.reason}`,
          ),
  });

  const run = {
    ...suite,
    grader: { model: policy.grader.model, source: policy.file },
    subject: { model: policy.subject.model },
    limits,
    skillFilter: options.skill,
    caseSet: cases.map((entry) => entry.id),
  };

  if (options.writeResults) {
    const dir = options.resultsDir ?? path.join(evalsDir, RESULTS_DIRNAME);
    try {
      run.resultsFile = writeResults(dir, run, { date: date() });
    } catch (error) {
      writeLine(
        stderr,
        `evals: could not write results to ${dir}: ${error.message}`,
      );
    }
  }

  const comparison = previous
    ? { ...compareRuns(previous, run), previousFile: options.compare }
    : null;

  if (options.json) {
    writeLine(stdout, JSON.stringify({ ...run, comparison }, null, 2));
  } else {
    writeLine(stdout, formatRun({ run, comparison, repoRoot }));
  }

  // status is "pass" | "fail" only (see evals/lib/case-run.mjs), so a
  // pass -> fail regression always increments totals.failed — one condition
  // covers both. A removed case is reported in the comparison (and the JSON)
  // but does not fail the run: case sets legitimately differ across branches,
  // so a --compare against a run from a different branch must stay usable.
  if (run.totals.failed > 0) return EXIT_FAILED;
  return EXIT_OK;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2) }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`evals: ${error?.stack ?? error}\n`);
      process.exitCode = EXIT_USAGE;
    },
  );
}
