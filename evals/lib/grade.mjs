/**
 * Grading for the eval runner (watt-mind/factory#1073).
 *
 * `expect.md` states observable properties, not exact wording, so grading is a
 * model judgement, not a diff. The grader receives the case's `expect.md` and
 * the skill's response and returns `pass | fail` plus a one-line reason. It is
 * pinned to a named model (see `lib/policy.mjs`) so the pass bar only moves on
 * a reviewable config change.
 *
 * The prompt/parse contract here is pure and unit-testable; the model call is
 * injected, so tests grade against a fake and never spend.
 */
import { runClaude } from "./spawn.mjs";

export const GRADER_INSTRUCTIONS = `You are a strict evaluator for an AI agent skill.

You are given:
  1. EXPECTATIONS — the observable properties a correct response MUST have and
     MUST NOT have. Wording will differ from the response; grade on properties,
     never on phrasing.
  2. RESPONSE — what the skill actually produced.

A response PASSES only if it satisfies every "Must" and violates no "Must not".
When in doubt, FAIL: this is a regression gate, and a false pass hides a
degraded skill.

Reply with EXACTLY two lines and nothing else:
VERDICT: PASS   (or)   VERDICT: FAIL
REASON: <one short line naming the decisive property, met or violated>`;

/** Build the grader prompt for one case. Pure. */
export function buildGraderPrompt({ expect, response }) {
  return [
    GRADER_INSTRUCTIONS,
    "",
    "=== EXPECTATIONS ===",
    String(expect).trim(),
    "",
    "=== RESPONSE ===",
    String(response).trim(),
    "",
    "=== YOUR VERDICT ===",
  ].join("\n");
}

/**
 * Parse a grader reply into `{ pass, reason }`.
 * Unparseable output is a FAIL — a grader that will not say cannot pass a gate.
 */
export function parseVerdict(text) {
  const raw = String(text ?? "");
  const verdictMatch = /verdict:\s*(pass|fail)/i.exec(raw);
  const reasonMatch = /reason:\s*(.+)/i.exec(raw);
  const reason = reasonMatch
    ? reasonMatch[1].trim().split(/\r?\n/)[0].slice(0, 300)
    : "";
  if (!verdictMatch) {
    return {
      pass: false,
      reason: reason || "grader returned no parseable verdict",
    };
  }
  const pass = verdictMatch[1].toLowerCase() === "pass";
  return {
    pass,
    reason: reason || (pass ? "meets expectations" : "fails expectations"),
  };
}

/**
 * Default grader: a bounded `claude -p` call, verdict parsed from its text.
 * A timed-out or empty grader fails the case (never the run) — the runner's
 * per-case timeout is the outer bound; this is the inner honest default.
 */
export function makeClaudeGrader({ runFn = runClaude } = {}) {
  return async function grade({ expect, response, model, timeoutMs, cwd }) {
    const { text, timedOut } = await runFn({
      prompt: buildGraderPrompt({ expect, response }),
      model,
      timeoutMs,
      cwd,
    });
    if (timedOut) {
      return { pass: false, reason: "grader timed out" };
    }
    return parseVerdict(text);
  };
}
