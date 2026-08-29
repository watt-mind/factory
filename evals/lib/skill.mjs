/**
 * Subject run for the eval runner (watt-mind/factory#1073).
 *
 * Before a response can be graded it has to exist: this runs the skill under
 * test against a case's `input.md` and returns the response text. The default
 * loads the skill's `SKILL.md` and applies it to the input via a bounded
 * `claude -p` call. It is injected into the runner, so tests substitute a fake
 * subject and never spend.
 *
 * This is intentionally a lightweight harness, not the full dispatch path: it
 * has no repository workspace, no MCP, no Linear. That is enough to exercise a
 * skill's judgement on a self-contained case (the shape #1074 writes), and it
 * keeps the runner runnable as a CI gate. Cases needing a live repo are a
 * deferral noted in evals/README.md, not a silent gap.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runClaude } from "./spawn.mjs";

/** Build the subject prompt: the skill's own instructions, applied to the case input. */
export function buildSubjectPrompt({ skillText, input }) {
  return [
    "You are executing the following skill. Follow it exactly.",
    "",
    "=== SKILL ===",
    String(skillText).trim(),
    "",
    "=== INPUT ===",
    String(input).trim(),
    "",
    "=== TASK ===",
    "Produce the response this skill would produce for the input above.",
    "State the decision you reach and the reasoning behind it.",
  ].join("\n");
}

/** Read a skill's SKILL.md text. Throws if the skill source is missing. */
export function readSkillText({ skill, skillSource, factoryRoot }) {
  const rel = skillSource ?? path.join("shared", "skills", skill, "SKILL.md");
  const abs = path.join(factoryRoot, rel);
  if (!existsSync(abs)) {
    throw new Error(`skill source not found for "${skill}" (${rel})`);
  }
  return readFileSync(abs, "utf8");
}

/**
 * Default subject runner: a bounded `claude -p` call executing the skill on the
 * case input. Returns `{ response, timedOut }`.
 */
export function makeClaudeSubject({ factoryRoot, runFn = runClaude } = {}) {
  return async function runSkill({ testCase, input, model, timeoutMs, cwd }) {
    const skillText = readSkillText({
      skill: testCase.skill,
      skillSource: testCase.skillSource,
      factoryRoot,
    });
    const { text, timedOut } = await runFn({
      prompt: buildSubjectPrompt({ skillText, input }),
      model,
      timeoutMs,
      cwd,
    });
    return { response: text, timedOut };
  };
}
