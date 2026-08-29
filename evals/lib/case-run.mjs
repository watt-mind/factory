/**
 * Running cases, bounded (#1073).
 *
 * The bounds are the point. An eval suite is only usable as a CI gate if a
 * hung grader costs one case, not the run — so every failure mode here
 * (timeout, crash, a grader that answers with prose instead of a verdict,
 * a malformed case directory) resolves to `fail` with a reason, and the run
 * carries on. Nothing in this file makes a model call: `runSkill` and `grade`
 * arrive as parameters, which is the seam the tests use.
 */
const TIMED_OUT = Symbol("timed-out");

export const PASS = "pass";
export const FAIL = "fail";

/**
 * Race `work` against a deadline, aborting it on the way out.
 * Resolves `{ok: true, value}`, `{ok: false, error}`, or `{timedOut: true}`.
 */
export async function withDeadline(timeoutMs, work) {
  const controller = new AbortController();
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => work(controller.signal))
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
      deadline,
    ]);
    if (outcome === TIMED_OUT) return { timedOut: true };
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

function message(error) {
  const text = String(error?.message ?? error ?? "unknown error").trim();
  return text.replace(/\s+/g, " ");
}

/**
 * Run one case: subject model produces a response, grader judges it against
 * `expect.md`. Both halves share the one per-case deadline, because a case
 * that spends its whole budget in the subject run has not been graded.
 *
 * @returns {Promise<{id: string, skill: string, case: string, status: "pass"|"fail", reason: string, durationMs: number, costUsd: number, skillSource: string|null}>}
 */
export async function runCase({
  evalCase,
  runSkill,
  grade,
  timeoutMs,
  budgetUsd,
  now = () => Date.now(),
}) {
  const startedAt = now();
  const record = (status, reason, costUsd = 0) => ({
    id: evalCase.id,
    skill: evalCase.skill,
    case: evalCase.name,
    status,
    reason,
    durationMs: Math.max(0, now() - startedAt),
    costUsd,
    skillSource: evalCase.skillSource,
  });

  // A case the runner cannot even read is a hole in the net, never a pass.
  if (evalCase.problem)
    return record(FAIL, `case not runnable: ${evalCase.problem}`);

  let spent = 0;
  const outcome = await withDeadline(timeoutMs, async (signal) => {
    const response = await runSkill({ evalCase, timeoutMs, budgetUsd, signal });
    spent += Number(response?.costUsd) || 0;
    const verdict = await grade({
      evalCase,
      response,
      timeoutMs,
      budgetUsd,
      signal,
    });
    spent += Number(verdict?.costUsd) || 0;
    return verdict;
  });

  if (outcome.timedOut) {
    return record(FAIL, `timed out after ${timeoutMs}ms`, spent);
  }
  if (!outcome.ok) {
    return record(FAIL, message(outcome.error), spent);
  }
  const verdict = outcome.value;
  return record(
    verdict?.pass ? PASS : FAIL,
    String(verdict?.reason ?? "").trim() || "(grader gave no reason)",
    spent,
  );
}

/**
 * Run every case under the suite-wide caps.
 *
 * When a cap is reached the remaining cases are recorded as failures with the
 * cap named as the reason. That is deliberate: reporting them as passes would
 * be a lie, and reporting them as "skipped" with a zero exit would let a slow
 * or expensive regression walk straight through the gate.
 */
export async function runSuite({
  cases,
  runSkill,
  grade,
  limits,
  now = () => Date.now(),
  onResult = null,
}) {
  const startedAt = now();
  const caseTimeoutMs = limits.caseTimeoutSeconds * 1000;
  const totalMs = limits.totalSeconds * 1000;
  const results = [];
  let spent = 0;

  for (const evalCase of cases) {
    const elapsed = now() - startedAt;
    const remainingMs = totalMs - elapsed;
    let result;
    if (remainingMs <= 0) {
      result = capped(
        evalCase,
        `run time cap of ${limits.totalSeconds}s reached before this case ran`,
      );
    } else if (spent >= limits.totalBudgetUsd) {
      result = capped(
        evalCase,
        `run budget cap of $${limits.totalBudgetUsd} reached before this case ran`,
      );
    } else {
      result = await runCase({
        evalCase,
        runSkill,
        grade,
        timeoutMs: Math.min(caseTimeoutMs, remainingMs),
        budgetUsd: Math.min(
          limits.caseBudgetUsd,
          limits.totalBudgetUsd - spent,
        ),
        now,
      });
      spent += result.costUsd;
    }
    results.push(result);
    onResult?.(result);
  }

  const failed = results.filter((r) => r.status === FAIL).length;
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    cases: results,
    totals: {
      total: results.length,
      passed: results.length - failed,
      failed,
      costUsd: round(spent),
    },
  };
}

function capped(evalCase, reason) {
  return {
    id: evalCase.id,
    skill: evalCase.skill,
    case: evalCase.name,
    status: FAIL,
    reason,
    durationMs: 0,
    costUsd: 0,
    skillSource: evalCase.skillSource,
  };
}

function round(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}
