/**
 * Case discovery for the eval runner (watt-mind/factory#1073).
 *
 * A case is `cases/<skill>/<case-name>/` with `input.md` (what the skill
 * receives) and `expect.md` (the observable properties a correct response must
 * and must not have), exactly as `evals/README.md` specifies. Discovery is
 * pure filesystem work — no model calls — so `--dry-run` can list what would
 * run without spend, and the discovery contract is unit-testable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const CASES_DIRNAME = "cases";
export const INPUT_FILE = "input.md";
export const EXPECT_FILE = "expect.md";

/** Resolve where a skill's source lives, so a dry run can show it (or flag it missing). */
export function resolveSkillSource(skill, { factoryRoot }) {
  const rel = path.join("shared", "skills", skill, "SKILL.md");
  const abs = path.join(factoryRoot, rel);
  return existsSync(abs) ? rel : null;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir) {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => isDir(path.join(dir, name)))
    .sort();
}

/**
 * Discover eval cases under `<root>/cases`.
 *
 * @param {object} opts
 * @param {string} opts.root - the evals directory (contains `cases/`)
 * @param {string} [opts.factoryRoot] - repo root, for skill-source resolution
 * @param {string} [opts.skill] - restrict to one skill's cases (`--skill`)
 * @returns {Array<{skill,name,dir,inputPath,expectPath,skillSource,error}>}
 *   Sorted by `skill` then `name`. A case missing `input.md`/`expect.md`
 *   carries a non-null `error` string rather than being silently dropped —
 *   a broken case must be visible, not invisible.
 */
export function discoverCases({
  root,
  factoryRoot = path.dirname(root),
  skill,
} = {}) {
  const casesRoot = path.join(root, CASES_DIRNAME);
  const skills = skill ? [skill] : listDirs(casesRoot);
  const cases = [];
  for (const skillName of skills) {
    const skillDir = path.join(casesRoot, skillName);
    const skillSource = resolveSkillSource(skillName, { factoryRoot });
    for (const caseName of listDirs(skillDir)) {
      const dir = path.join(skillDir, caseName);
      const inputPath = path.join(dir, INPUT_FILE);
      const expectPath = path.join(dir, EXPECT_FILE);
      let error = null;
      if (!existsSync(inputPath)) error = `missing ${INPUT_FILE}`;
      else if (!existsSync(expectPath)) error = `missing ${EXPECT_FILE}`;
      cases.push({
        skill: skillName,
        name: caseName,
        dir,
        inputPath,
        expectPath,
        skillSource,
        error,
      });
    }
  }
  return cases;
}

/** Read a case's input/expect text. Throws if the case is malformed. */
export function readCase(testCase) {
  if (testCase.error) {
    throw new Error(`${testCase.skill}/${testCase.name}: ${testCase.error}`);
  }
  return {
    input: readFileSync(testCase.inputPath, "utf8"),
    expect: readFileSync(testCase.expectPath, "utf8"),
  };
}
