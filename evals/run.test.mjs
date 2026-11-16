/**
 * Tests for the eval runner (#1073).
 *
 * NOT ONE TEST IN THIS FILE MAKES A MODEL CALL. Every run goes through
 * `main({ deps })` with fake `runSkill`/`grade` functions, and the fixtures
 * are temporary directories rather than the repo's own cases — a suite that
 * needed a live grader to prove the gate works could never be the gate.
 */
import { withTmpDir } from "../event-runtime/test-support/tmp.mjs?file=evals-run-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, parseArgs } from "./run.mjs";
import { discoverCases } from "./lib/cases.mjs";
import {
  buildClaudeArgv,
  childEnvironment,
  parseCliJson,
  parseVerdict,
} from "./lib/grader.mjs";
import { EvalConfigError, loadEvalPolicy, requirePin } from "./lib/policy.mjs";
import { compareRuns } from "./lib/results.mjs";

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(EVALS_DIR);

const PINNED_POLICY = Object.freeze({
  file: "config/policy.yaml",
  grader: { model: "claude-sonnet-4-6" },
  subject: { model: "default" },
  limits: {
    caseTimeoutSeconds: 300,
    caseBudgetUsd: 2,
    totalSeconds: 3600,
    totalBudgetUsd: 20,
  },
  problem: null,
});

/**
 * A miniature repo: skill prompts under shared/skills, cases under evals/cases.
 * `cases` maps "<skill>/<case>" to the files it should contain; omitting a file
 * is how a malformed case is expressed.
 */
function buildFixture(
  dir,
  { skills = { "ticket-spec": "# ticket-spec" }, cases = {} } = {},
) {
  for (const [name, text] of Object.entries(skills)) {
    const skillDir = path.join(dir, "shared", "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `${text}\n`);
  }
  for (const [id, files] of Object.entries(cases)) {
    const [skill, name] = id.split("/");
    const caseDir = path.join(dir, "evals", "cases", skill, name);
    mkdirSync(caseDir, { recursive: true });
    if (files.input !== undefined)
      writeFileSync(path.join(caseDir, "input.md"), files.input);
    if (files.expect !== undefined)
      writeFileSync(path.join(caseDir, "expect.md"), files.expect);
  }
  return { repoRoot: dir, evalsDir: path.join(dir, "evals") };
}

function twoCases() {
  return {
    "ticket-spec/hidden-decision": {
      input: "ticket A",
      expect: "must not promote",
    },
    "ticket-spec/green-but-empty": {
      input: "ticket B",
      expect: "must name a command",
    },
  };
}

function sink() {
  const chunks = [];
  return {
    write(text) {
      chunks.push(text);
    },
    get text() {
      return chunks.join("");
    },
  };
}

/**
 * The model seam, faked. `verdicts` maps a case id to the grader's answer (or
 * to a function for the awkward shapes: hangs, throws, cost). Every call is
 * recorded so a test can assert what was — and was not — run.
 */
function fakeDeps({ verdicts = {}, subjectCost = 0, onSubject = null } = {}) {
  const calls = { subject: [], grade: [] };
  const runSkill = async ({ evalCase }) => {
    calls.subject.push(evalCase.id);
    if (onSubject) return onSubject(evalCase);
    return { text: `response for ${evalCase.id}`, costUsd: subjectCost };
  };
  const grade = async ({ evalCase }) => {
    calls.grade.push(evalCase.id);
    const verdict = verdicts[evalCase.id];
    if (typeof verdict === "function") return verdict(evalCase);
    return (
      verdict ?? {
        pass: true,
        reason: "meets every stated property",
        costUsd: 0,
      }
    );
  };
  return { runSkill, grade, calls };
}

function run(options) {
  const stdout = sink();
  const stderr = sink();
  return main({ policy: PINNED_POLICY, stdout, stderr, ...options }).then(
    (code) => ({
      code,
      stdout: stdout.text,
      stderr: stderr.text,
    }),
  );
}

describe("discovery", () => {
  test("finds cases/<skill>/<case> and resolves the skill source", () =>
    withTmpDir("evals-discovery-", (dir) => {
      const { repoRoot, evalsDir } = buildFixture(dir, { cases: twoCases() });
      const cases = discoverCases({ evalsDir, repoRoot });
      expect(cases.map((entry) => entry.id)).toEqual([
        "ticket-spec/green-but-empty",
        "ticket-spec/hidden-decision",
      ]);
      expect(cases[0].candidateName).toBe("ticket-spec");
      expect(cases[0].candidateSource).toBe(
        path.join(repoRoot, "shared", "skills", "ticket-spec", "SKILL.md"),
      );
      expect(cases[0].problem).toBeNull();
    }));

  test("falls back to the emitted plugins/core skill when shared/ has none", () =>
    withTmpDir("evals-discovery-emitted-", (dir) => {
      const { repoRoot, evalsDir } = buildFixture(dir, {
        skills: {},
        cases: { "ticket-spec/a": { input: "i", expect: "e" } },
      });
      const emitted = path.join(
        repoRoot,
        "plugins",
        "core",
        "skills",
        "ticket-spec",
      );
      mkdirSync(emitted, { recursive: true });
      writeFileSync(path.join(emitted, "SKILL.md"), "# emitted\n");
      const [entry] = discoverCases({ evalsDir, repoRoot });
      expect(entry.candidateSource).toBe(path.join(emitted, "SKILL.md"));
      expect(entry.problem).toBeNull();
    }));

  test("resolves a pinned event-runtime agent prompt", () =>
    withTmpDir("evals-discovery-agent-", (dir) => {
      const { repoRoot, evalsDir } = buildFixture(dir, {
        skills: {},
        cases: { "dispatch/a": { input: "i", expect: "e" } },
      });
      const agentDir = path.join(repoRoot, "event-runtime", "agents");
      mkdirSync(agentDir, { recursive: true });
      const agentPrompt = path.join(agentDir, "dispatch.md");
      writeFileSync(agentPrompt, "# dispatch\n");

      const [entry] = discoverCases({ evalsDir, repoRoot });
      expect(entry.candidateSource).toBe(agentPrompt);
      expect(entry.problem).toBeNull();
    }));

  test("prefers a shared skill over an agent prompt with the same name", () =>
    withTmpDir("evals-discovery-precedence-", (dir) => {
      const { repoRoot, evalsDir } = buildFixture(dir, {
        skills: { dispatch: "# shared dispatch" },
        cases: { "dispatch/a": { input: "i", expect: "e" } },
      });
      const agentDir = path.join(repoRoot, "event-runtime", "agents");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "dispatch.md"), "# dispatch\n");

      const [entry] = discoverCases({ evalsDir, repoRoot });
      expect(entry.candidateSource).toBe(
        path.join(repoRoot, "shared", "skills", "dispatch", "SKILL.md"),
      );
    }));

  test("a case missing expect.md, or naming an unknown skill, is reported not skipped", () =>
    withTmpDir("evals-discovery-broken-", (dir) => {
      const { repoRoot, evalsDir } = buildFixture(dir, {
        cases: {
          "ticket-spec/no-expect": { input: "i" },
          "ghost-skill/orphan": { input: "i", expect: "e" },
        },
      });
      const problems = Object.fromEntries(
        discoverCases({ evalsDir, repoRoot }).map((entry) => [
          entry.id,
          entry.problem,
        ]),
      );
      expect(problems["ticket-spec/no-expect"]).toBe("missing expect.md");
      expect(problems["ghost-skill/orphan"]).toContain(
        'no source for "ghost-skill"',
      );
      for (const lookedIn of [
        "shared/skills/ghost-skill/SKILL.md",
        "plugins/core/skills/ghost-skill/SKILL.md",
        "event-runtime/agents/ghost-skill.md",
      ]) {
        expect(problems["ghost-skill/orphan"]).toContain(lookedIn);
      }
    }));

  test("discovers the repo's own cases against the real skill tree", () => {
    const cases = discoverCases({ evalsDir: EVALS_DIR, repoRoot: REPO_ROOT });
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((entry) => entry.problem === null)).toBe(true);
  });
});

describe("--dry-run", () => {
  test("lists each case and its resolved skill source without calling a model", () =>
    withTmpDir("evals-dry-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps();
      const result = await run({ argv: ["--dry-run"], deps, ...fixture });
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toContain("ticket-spec/hidden-decision");
      expect(result.stdout).toContain(
        path.join("shared", "skills", "ticket-spec", "SKILL.md"),
      );
      expect(deps.calls.subject).toEqual([]);
      expect(deps.calls.grade).toEqual([]);
    }));

  test("works with an unpinned grader, and says so, so discovery is testable without spend", () =>
    withTmpDir("evals-dry-unpinned-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const result = await run({
        argv: ["--dry-run"],
        deps: fakeDeps(),
        policy: {
          ...PINNED_POLICY,
          grader: null,
          problem: "no `evals:` stanza",
        },
        ...fixture,
      });
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toContain("UNPINNED");
    }));

  test("exits non-zero when a discovered case is not runnable", () =>
    withTmpDir("evals-dry-broken-", async (dir) => {
      const fixture = buildFixture(dir, {
        cases: { "ticket-spec/no-expect": { input: "i" } },
      });
      const result = await run({
        argv: ["--dry-run"],
        deps: fakeDeps(),
        ...fixture,
      });
      expect(result.code).toBe(EXIT_FAILED);
      expect(result.stdout).toContain("missing expect.md");
    }));

  test("the documented `node evals/run.mjs --dry-run` invocation works from the CLI", () => {
    const result = spawnSync(
      "node",
      [path.join(EVALS_DIR, "run.mjs"), "--dry-run"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain("ticket-spec/");
  });
});

describe("pass/fail exit contract", () => {
  test("every case passing exits 0 and grades each case exactly once", () =>
    withTmpDir("evals-pass-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps();
      const result = await run({ argv: [], deps, ...fixture });
      expect(result.code).toBe(EXIT_OK);
      expect(deps.calls.grade.sort()).toEqual([
        "ticket-spec/green-but-empty",
        "ticket-spec/hidden-decision",
      ]);
      expect(result.stdout).toContain("2/2 passed");
    }));

  test("one failing case exits 1 and reports the grader's one-line reason", () =>
    withTmpDir("evals-fail-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps({
        verdicts: {
          "ticket-spec/hidden-decision": {
            pass: false,
            reason: "promoted the ticket anyway",
          },
        },
      });
      const result = await run({ argv: ["--json"], deps, ...fixture });
      expect(result.code).toBe(EXIT_FAILED);
      const report = JSON.parse(result.stdout);
      expect(report.totals).toMatchObject({ total: 2, passed: 1, failed: 1 });
      const failed = report.cases.find((entry) => entry.status === "fail");
      expect(failed.id).toBe("ticket-spec/hidden-decision");
      expect(failed.reason).toBe("promoted the ticket anyway");
    }));

  test("a case the runner cannot read fails rather than silently passing", () =>
    withTmpDir("evals-unrunnable-", async (dir) => {
      const fixture = buildFixture(dir, {
        cases: { "ticket-spec/no-expect": { input: "i" } },
      });
      const deps = fakeDeps();
      const result = await run({ argv: [], deps, ...fixture });
      expect(result.code).toBe(EXIT_FAILED);
      expect(result.stderr).toContain("case not runnable");
      expect(deps.calls.subject).toEqual([]);
    }));

  test("a grader that throws fails its case and the run continues", () =>
    withTmpDir("evals-grader-throws-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps({
        verdicts: {
          "ticket-spec/green-but-empty": () => {
            throw new Error("grader returned no PASS/FAIL verdict");
          },
        },
      });
      const result = await run({ argv: ["--json"], deps, ...fixture });
      expect(result.code).toBe(EXIT_FAILED);
      const report = JSON.parse(result.stdout);
      expect(report.totals).toMatchObject({ passed: 1, failed: 1 });
      expect(report.cases.find((c) => c.status === "fail").reason).toContain(
        "no PASS/FAIL",
      );
    }));
});

describe("--skill filtering", () => {
  test("runs only the named skill's cases", () =>
    withTmpDir("evals-skill-", async (dir) => {
      const fixture = buildFixture(dir, {
        skills: { "ticket-spec": "# a", "merge-review": "# b" },
        cases: {
          "ticket-spec/hidden-decision": { input: "i", expect: "e" },
          "merge-review/green-but-empty": { input: "i", expect: "e" },
        },
      });
      const deps = fakeDeps();
      const result = await run({
        argv: ["--skill", "ticket-spec"],
        deps,
        ...fixture,
      });
      expect(result.code).toBe(EXIT_OK);
      expect(deps.calls.grade).toEqual(["ticket-spec/hidden-decision"]);
    }));

  test("an unknown skill is a usage error, not an empty green run", () =>
    withTmpDir("evals-skill-unknown-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps();
      const result = await run({ argv: ["--skill", "nope"], deps, ...fixture });
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stderr).toContain("no cases for skill");
      expect(deps.calls.subject).toEqual([]);
    }));

  test("a cases directory with nothing in it is a usage error", () =>
    withTmpDir("evals-empty-", async (dir) => {
      const fixture = buildFixture(dir, { cases: {} });
      const result = await run({ argv: [], deps: fakeDeps(), ...fixture });
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stderr).toContain("no cases found");
    }));
});

describe("bounds", () => {
  test("a hung grader fails its own case, not the run", () =>
    withTmpDir("evals-timeout-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps({
        verdicts: {
          "ticket-spec/green-but-empty": () => new Promise(() => {}), // never settles
        },
      });
      const result = await run({
        argv: ["--json", "--timeout", "0.05"],
        deps,
        ...fixture,
      });
      expect(result.code).toBe(EXIT_FAILED);
      const report = JSON.parse(result.stdout);
      const hung = report.cases.find(
        (entry) => entry.id === "ticket-spec/green-but-empty",
      );
      expect(hung.status).toBe("fail");
      expect(hung.reason).toMatch(/timed out after \d+ms/);
      // The second case still ran and still passed: one hung grader is one
      // failed case, never a dead run.
      expect(
        report.cases.find((entry) => entry.id === "ticket-spec/hidden-decision")
          .status,
      ).toBe("pass");
    }));

  test("the total time cap fails the cases it stopped, naming the cap", () =>
    withTmpDir("evals-total-time-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const clock = { t: 1_000_000 };
      const deps = fakeDeps({
        verdicts: {
          "ticket-spec/green-but-empty": () => {
            clock.t += 60_000; // this case ate the whole window
            return { pass: true, reason: "ok" };
          },
        },
      });
      const result = await run({
        argv: ["--json", "--total-timeout", "30"],
        deps,
        now: () => clock.t,
        ...fixture,
      });
      expect(result.code).toBe(EXIT_FAILED);
      const report = JSON.parse(result.stdout);
      const stopped = report.cases.find(
        (entry) => entry.id === "ticket-spec/hidden-decision",
      );
      expect(stopped.status).toBe("fail");
      expect(stopped.reason).toContain("run time cap of 30s");
      expect(deps.calls.subject).toEqual(["ticket-spec/green-but-empty"]);
    }));

  test("the total budget cap stops spending and fails the remaining cases", () =>
    withTmpDir("evals-total-budget-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps({
        verdicts: {
          "ticket-spec/green-but-empty": {
            pass: true,
            reason: "ok",
            costUsd: 9,
          },
        },
      });
      const result = await run({
        argv: ["--json", "--total-budget", "4"],
        deps,
        ...fixture,
      });
      expect(result.code).toBe(EXIT_FAILED);
      const report = JSON.parse(result.stdout);
      expect(
        report.cases.find((entry) => entry.id === "ticket-spec/hidden-decision")
          .reason,
      ).toContain("run budget cap of $4");
      expect(deps.calls.subject).toEqual(["ticket-spec/green-but-empty"]);
    }));
});

describe("--compare", () => {
  test("a pass that becomes a fail is reported as a regression and exits non-zero", () =>
    withTmpDir("evals-compare-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const previous = path.join(dir, "previous.json");
      writeFileSync(
        previous,
        JSON.stringify({
          startedAt: "2026-08-01T00:00:00.000Z",
          grader: { model: "claude-sonnet-4-6" },
          cases: [
            { id: "ticket-spec/hidden-decision", status: "pass" },
            { id: "ticket-spec/green-but-empty", status: "pass" },
          ],
        }),
      );
      const deps = fakeDeps({
        verdicts: {
          "ticket-spec/hidden-decision": {
            pass: false,
            reason: "promoted the ticket",
          },
        },
      });
      const result = await run({
        argv: ["--json", "--compare", previous, "--no-results"],
        deps,
        ...fixture,
      });
      expect(result.code).toBe(EXIT_FAILED);
      const report = JSON.parse(result.stdout);
      expect(report.comparison.regressions).toEqual([
        {
          id: "ticket-spec/hidden-decision",
          was: "pass",
          now: "fail",
          reason: "promoted the ticket",
        },
      ]);
      expect(report.comparison.fixes).toEqual([]);
    }));

  test("a fail that becomes a pass is a fix, not a regression", () =>
    withTmpDir("evals-compare-fix-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const previous = path.join(dir, "previous.json");
      writeFileSync(
        previous,
        JSON.stringify({
          startedAt: "2026-08-01T00:00:00.000Z",
          grader: { model: "claude-sonnet-4-6" },
          cases: [{ id: "ticket-spec/hidden-decision", status: "fail" }],
        }),
      );
      const result = await run({
        argv: ["--json", "--compare", previous, "--no-results"],
        deps: fakeDeps(),
        ...fixture,
      });
      expect(result.code).toBe(EXIT_OK);
      const report = JSON.parse(result.stdout);
      expect(report.comparison.regressions).toEqual([]);
      expect(report.comparison.fixes.map((entry) => entry.id)).toEqual([
        "ticket-spec/hidden-decision",
      ]);
      expect(report.comparison.added).toEqual(["ticket-spec/green-but-empty"]);
    }));

  test("a passing case present in the previous run and absent from the current one is reported and does not fail the run", () =>
    withTmpDir("evals-compare-removed-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const previous = path.join(dir, "previous.json");
      writeFileSync(
        previous,
        JSON.stringify({
          startedAt: "2026-08-01T00:00:00.000Z",
          grader: { model: "claude-sonnet-4-6" },
          cases: [
            { id: "ticket-spec/hidden-decision", status: "pass" },
            { id: "ticket-spec/green-but-empty", status: "pass" },
            { id: "ticket-spec/deleted-case", status: "pass" },
          ],
        }),
      );
      const result = await run({
        argv: ["--json", "--compare", previous, "--no-results"],
        deps: fakeDeps(),
        ...fixture,
      });
      expect(result.code).toBe(EXIT_OK);
      const report = JSON.parse(result.stdout);
      expect(report.comparison.removed).toEqual(["ticket-spec/deleted-case"]);
      expect(report.comparison.regressions).toEqual([]);
    }));

  test("a missing or malformed comparison file is a usage error", () =>
    withTmpDir("evals-compare-bad-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const bad = path.join(dir, "not-results.json");
      writeFileSync(bad, JSON.stringify({ hello: "world" }));
      const result = await run({
        argv: ["--compare", bad],
        deps: fakeDeps(),
        ...fixture,
      });
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stderr).toContain("not an evals results file");
    }));

  test("comparing across grader models is flagged as not comparable", () => {
    const comparison = compareRuns(
      {
        grader: { model: "old-judge" },
        cases: [{ id: "a/b", status: "pass" }],
      },
      {
        grader: { model: "new-judge" },
        cases: [{ id: "a/b", status: "fail" }],
      },
    );
    expect(comparison.graderChanged).toBe(true);
    expect(comparison.regressions).toHaveLength(1);
  });
});

describe("results records", () => {
  test("a run records the models, the case set, and per-case pass/fail", () =>
    withTmpDir("evals-results-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const resultsDir = path.join(dir, "results");
      const result = await run({
        argv: ["--json", "--results-dir", resultsDir],
        deps: fakeDeps(),
        date: () => new Date("2026-08-29T10:11:12.000Z"),
        ...fixture,
      });
      expect(result.code).toBe(EXIT_OK);
      const report = JSON.parse(result.stdout);
      expect(report.resultsFile).toBe(
        path.join(resultsDir, "2026-08-29T10-11-12-000Z.json"),
      );
      const recorded = JSON.parse(await Bun.file(report.resultsFile).text());
      expect(recorded.grader.model).toBe("claude-sonnet-4-6");
      expect(recorded.subject.model).toBe("default");
      expect(recorded.caseSet).toEqual([
        "ticket-spec/green-but-empty",
        "ticket-spec/hidden-decision",
      ]);
      expect(recorded.cases.map((entry) => entry.status)).toEqual([
        "pass",
        "pass",
      ]);
    }));
});

describe("the grader pin", () => {
  test("a real run refuses to start when the grader is not pinned, and spends nothing", () =>
    withTmpDir("evals-unpinned-", async (dir) => {
      const fixture = buildFixture(dir, { cases: twoCases() });
      const deps = fakeDeps();
      const result = await run({
        argv: [],
        deps,
        policy: {
          ...PINNED_POLICY,
          grader: null,
          problem: "config/policy.yaml has no `evals:` stanza",
        },
        ...fixture,
      });
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stderr).toContain("Add this stanza to config/policy.yaml");
      expect(result.stderr).toContain("grader:");
      expect(deps.calls.subject).toEqual([]);
    }));

  test("the stanza is read out of policy.yaml, limits and all", () => {
    const policy = loadEvalPolicy({
      root: "/nowhere",
      file: "/nowhere/config/policy.yaml",
      text: `budget:\n  per_day_usd: 2000.00\n\nevals:\n  subject:\n    model: default\n  grader:\n    model: claude-sonnet-4-6 # pinned deliberately\n  limits:\n    case_timeout_seconds: 120\n    total_budget_usd: 5\n\nlimits:\n  max_run_minutes: 90\n`,
    });
    expect(policy.problem).toBeNull();
    expect(policy.grader).toEqual({ model: "claude-sonnet-4-6" });
    expect(policy.subject).toEqual({ model: "default" });
    expect(policy.limits.caseTimeoutSeconds).toBe(120);
    expect(policy.limits.totalBudgetUsd).toBe(5);
    expect(policy.limits.totalSeconds).toBe(3600); // untouched default
  });

  test('a grader left on the "default" sentinel is refused — the judge must be named', () => {
    const policy = loadEvalPolicy({
      root: "/nowhere",
      file: "/nowhere/config/policy.yaml",
      text: "evals:\n  grader:\n    model: default\n",
    });
    expect(policy.grader).toBeNull();
    expect(policy.problem).toContain("must name a model");
  });

  test("block-scalar bodies are skipped instead of becoming policy keys", () => {
    const policy = loadEvalPolicy({
      root: "/nowhere",
      file: "/nowhere/config/policy.yaml",
      text: `evals:
  note: |
    grader:
      model: evil-judge
`,
    });
    expect(policy.grader).toBeNull();
    expect(policy.problem).toContain("evals.grader.model is not set");
  });

  test("block scalars with explicit indentation indicators are skipped too", () => {
    const policy = loadEvalPolicy({
      root: "/nowhere",
      file: "/nowhere/config/policy.yaml",
      text: `evals:
  note: |2
    grader:
      model: evil-judge
  other: >2-
    limits:
      case_timeout_seconds: 1
`,
    });
    expect(policy.grader).toBeNull();
    expect(policy.problem).toContain("evals.grader.model is not set");
    expect(policy.limits.caseTimeoutSeconds).not.toBe(1);
  });

  test("a limits map with no recognized keys is named as such", () => {
    expect(() =>
      loadEvalPolicy({
        root: "/nowhere",
        file: "/nowhere/config/policy.yaml",
        text: `evals:
  grader:
    model: claude-sonnet-4-6
  limits:
    case_timeout_secs: 10
`,
      }),
    ).toThrow(
      "/nowhere/config/policy.yaml: evals.limits has no recognized keys (expected: case_timeout_seconds, case_budget_usd, total_seconds, total_budget_usd)",
    );
  });

  test("a limits sequence is rejected instead of falling back to defaults", () => {
    expect(() =>
      loadEvalPolicy({
        root: "/nowhere",
        file: "/nowhere/config/policy.yaml",
        text: `evals:
  grader:
    model: claude-sonnet-4-6
  limits:
    - case_timeout_seconds: 10
`,
      }),
    ).toThrow("/nowhere/config/policy.yaml: evals.limits must be a map");
  });

  test.each(["null", "~"])(
    "YAML %s is not accepted as a grader model",
    (model) => {
      const policy = loadEvalPolicy({
        root: "/nowhere",
        file: "/nowhere/config/policy.yaml",
        text: `evals:\n  grader:\n    model: ${model}\n`,
      });
      expect(policy.grader).toBeNull();
      expect(policy.problem).toContain("must name a model");
      expect(() => requirePin(policy)).toThrow(/Add this stanza/);
    },
  );

  test("an absent stanza is reported, never guessed at", () => {
    const policy = loadEvalPolicy({
      root: "/nowhere",
      file: "/nowhere/config/policy.yaml",
      text: "models:\n  claude:\n    strong: default\n",
    });
    expect(policy.grader).toBeNull();
    expect(policy.problem).toContain("no `evals:` stanza");
  });

  test("an EvalConfigError from the policy loader is a usage error", async () => {
    const result = await run({
      argv: [],
      policy: null,
      deps: fakeDeps(),
      loadPolicy: () => {
        throw new EvalConfigError("bad limits");
      },
    });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("evals: bad limits");
  });

  test("a non-EvalConfigError from the policy loader is rethrown, not reported as exit 2", async () => {
    await expect(
      main({
        argv: [],
        stdout: sink(),
        stderr: sink(),
        loadPolicy: () => {
          throw new TypeError("parser exploded");
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the model call the runner would make", () => {
  test("argv pins the grader model and loads no MCP server", () => {
    const argv = buildClaudeArgv({
      prompt: "grade this",
      model: "claude-sonnet-4-6",
      budgetUsd: 2,
      disallowedTools: ["Bash", "Read"],
    });
    expect(argv.slice(0, 4)).toEqual([
      "-p",
      "grade this",
      "--output-format",
      "json",
    ]);
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("Bash,Read");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("2");
    expect(argv).toContain("--strict-mcp-config");
  });

  test('the "default" sentinel passes no --model, matching the adapters', () => {
    expect(buildClaudeArgv({ prompt: "p", model: "default" })).not.toContain(
      "--model",
    );
  });

  test("the child never inherits ANTHROPIC_API_KEY (subscription auth)", () => {
    const env = childEnvironment({
      HOME: "/home/x",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-secret",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/home/x");
  });

  test("a verdict is read from the grader's line, and prose alone is no verdict", () => {
    expect(parseVerdict("PASS: leaves the ticket in Triage")).toEqual({
      pass: true,
      reason: "leaves the ticket in Triage",
    });
    expect(parseVerdict("**FAIL** — promoted the ticket")).toEqual({
      pass: false,
      reason: "promoted the ticket",
    });
    expect(
      parseVerdict("I think this response is quite good overall."),
    ).toBeNull();
  });

  test("cost and text come off the CLI's json result, with a raw fallback", () => {
    expect(parseCliJson('{"result":"PASS: ok","total_cost_usd":0.25}')).toEqual(
      {
        text: "PASS: ok",
        costUsd: 0.25,
      },
    );
    expect(parseCliJson("not json at all")).toEqual({
      text: "not json at all",
      costUsd: 0,
    });
  });
});

describe("argument parsing", () => {
  test("the two invocations evals/README.md documents parse", () => {
    expect(parseArgs([])).toMatchObject({
      skill: null,
      dryRun: false,
      json: false,
    });
    expect(parseArgs(["--skill", "ticket-spec"])).toMatchObject({
      skill: "ticket-spec",
    });
  });

  test("an unknown flag or a missing value is a usage error, not a default", async () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--skill"])).toThrow(/needs a value/);
    const result = await run({ argv: ["--nope"], deps: fakeDeps() });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("usage: node evals/run.mjs");
  });
});
