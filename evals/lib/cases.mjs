/**
 * Case discovery (#1073). A case is exactly what `evals/README.md` specifies:
 *
 *   cases/<skill>/<case-name>/
 *     input.md    what the skill receives
 *     expect.md   the properties a correct response must and must not have
 *
 * Discovery is pure filesystem work and makes no model call, which is what
 * lets `--dry-run` be the cheap, always-runnable half of this runner.
 *
 * A malformed case is reported, never skipped. A case directory missing its
 * `expect.md`, or naming a skill with no source on disk, is a hole in the
 * regression net; silently dropping it would make the suite report green for
 * a case it never ran — the exact failure mode evals exist to prevent.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where a case prompt lives, most authoritative first. `shared/` is the
 * source of truth; `plugins/core/` is emitted from it (`bun build/emit.mjs`)
 * and is the fallback for a checkout where only the emitted tree is present.
 * Pinned event-runtime agents are the final fallback because their prompts
 * are not skills, but can still be exercised by the eval runner.
 */
export function candidateSourceCandidates(repoRoot, name) {
  return [
    path.join(repoRoot, "shared", "skills", name, "SKILL.md"),
    path.join(repoRoot, "plugins", "core", "skills", name, "SKILL.md"),
    path.join(repoRoot, "event-runtime", "agents", `${name}.md`),
  ];
}

export function resolveCandidateSource(repoRoot, candidateName) {
  for (const candidate of candidateSourceCandidates(repoRoot, candidateName)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function dirEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Discover cases under `<evalsDir>/cases`, optionally filtered to one skill.
 *
 * @param {{evalsDir: string, repoRoot: string, skill?: string|null}} options
 * @returns {Array<{id: string, candidateName: string, name: string, dir: string, inputPath: string, expectPath: string, candidateSource: string|null, problem: string|null}>}
 *   sorted by candidate then case name, so a results file and its comparison are
 *   stable across runs.
 */
export function discoverCases({ evalsDir, repoRoot, skill = null }) {
  const casesDir = path.join(evalsDir, "cases");
  const skills = dirEntries(casesDir).filter(
    (name) => skill === null || name === skill,
  );
  const cases = [];
  for (const candidateName of skills) {
    const candidateDir = path.join(casesDir, candidateName);
    const candidateSource = resolveCandidateSource(repoRoot, candidateName);
    for (const caseName of dirEntries(candidateDir)) {
      const dir = path.join(candidateDir, caseName);
      const inputPath = path.join(dir, "input.md");
      const expectPath = path.join(dir, "expect.md");
      const missing = [
        existsSync(inputPath) ? null : "input.md",
        existsSync(expectPath) ? null : "expect.md",
      ].filter(Boolean);
      let problem = null;
      if (missing.length > 0) problem = `missing ${missing.join(" and ")}`;
      else if (!candidateSource) {
        problem = `no source for "${candidateName}" (looked in ${candidateSourceCandidates(
          repoRoot,
          candidateName,
        )
          .map((p) => path.relative(repoRoot, p))
          .join(", ")})`;
      }
      cases.push({
        id: `${candidateName}/${caseName}`,
        candidateName,
        name: caseName,
        dir,
        inputPath,
        expectPath,
        candidateSource,
        problem,
      });
    }
  }
  return cases;
}

/** The skills that have at least one case — what `--skill` can be given. */
export function knownSkills({ evalsDir }) {
  return dirEntries(path.join(evalsDir, "cases"));
}
