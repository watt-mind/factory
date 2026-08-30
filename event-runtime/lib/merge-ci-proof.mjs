const REQUIRED_CHECK_FIELDS = ["name", "bucket", "state"];
const CANCELLED_RUN_CONCLUSIONS = new Set(["cancelled", "stale"]);

function isCancelledWorkflowRun(run) {
  return (
    run?.status === "cancelled" ||
    CANCELLED_RUN_CONCLUSIONS.has(run?.conclusion)
  );
}

/**
 * Select the sole non-cancelled configured workflow run for a reviewed head.
 * `gh run list` returns newest first, but multiple live runs are ambiguous and
 * therefore fail closed rather than making list order into merge evidence.
 */
export function selectMergeCiRun({ workflow, headSha, runs }) {
  for (const [label, value] of [
    ["workflow", workflow],
    ["head SHA", headSha],
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${label} must be a nonempty string`);
    }
  }
  if (!Array.isArray(runs)) {
    throw new Error("workflow runs must be an array");
  }

  const matchingRuns = runs.filter(
    (run) =>
      run?.workflowName === workflow &&
      run?.headSha === headSha &&
      !isCancelledWorkflowRun(run),
  );
  if (matchingRuns.length !== 1) {
    throw new Error(
      "configured non-cancelled workflow run is missing or ambiguous",
    );
  }
  const [run] = matchingRuns;
  if (
    !Number.isInteger(run.databaseId) &&
    (typeof run.databaseId !== "string" || run.databaseId.length === 0)
  ) {
    throw new Error("configured workflow run has no valid database ID");
  }
  return run;
}

export function noRequiredChecksDiagnostic(headRef) {
  if (typeof headRef !== "string" || headRef.length === 0) {
    throw new Error("head ref must be a nonempty string");
  }
  return `no required checks reported on the '${headRef}' branch`;
}

/**
 * Resolve the supported required-checks result (GitHub CLI: `pr checks
 * --required --json name,bucket,state`). GitHub CLI uses status 1 plus an
 * exact diagnostic when the branch has
 * no required checks, so that one result is deliberately equivalent to `[]`.
 * Every other nonzero or ambiguous result fails closed.
 */
export function resolveRequiredContexts({ status, output, headRef }) {
  if (!Number.isInteger(status) || status < 0) {
    throw new Error("required-check status must be a nonnegative integer");
  }
  if (typeof output !== "string") {
    throw new Error("required-check output must be a string");
  }

  if (status !== 0) {
    if (status === 1 && output === noRequiredChecksDiagnostic(headRef)) {
      return [];
    }
    throw new Error(`required-context lookup failed with status ${status}`);
  }

  let contexts;
  try {
    contexts = JSON.parse(output);
  } catch {
    throw new Error("required contexts are not valid JSON");
  }
  if (!Array.isArray(contexts)) {
    throw new Error("required contexts must be a JSON array");
  }
  if (contexts.length === 0) {
    throw new Error("status-zero required contexts must be nonempty");
  }

  const names = [];
  for (const context of contexts) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new Error("required context entries must be objects");
    }
    for (const field of REQUIRED_CHECK_FIELDS) {
      if (typeof context[field] !== "string" || context[field].length === 0) {
        throw new Error(`required context ${field} must be a nonempty string`);
      }
    }
    names.push(context.name);
  }
  if (new Set(names).size !== names.length) {
    throw new Error("required context names must be unique");
  }

  return contexts;
}

/**
 * Prove the configured merge_ci fallback at one reviewed head SHA. The caller
 * must supply jobs from the selected run; visible PR checks are intentionally
 * not accepted as evidence.
 */
export function proveMergeCiFallback({
  workflow,
  requiredChecks,
  headSha,
  runs,
  jobs,
}) {
  if (
    !Array.isArray(requiredChecks) ||
    requiredChecks.length === 0 ||
    requiredChecks.some(
      (name) => typeof name !== "string" || name.trim().length === 0,
    ) ||
    new Set(requiredChecks).size !== requiredChecks.length
  ) {
    throw new Error("required checks must be a unique nonempty string list");
  }
  if (!Array.isArray(runs) || !Array.isArray(jobs)) {
    throw new Error("workflow runs and jobs must be arrays");
  }

  const run = selectMergeCiRun({ workflow, headSha, runs });

  for (const requiredName of requiredChecks) {
    const matches = jobs.filter((job) => job?.name === requiredName);
    if (matches.length !== 1) {
      throw new Error(`required job ${requiredName} is missing or ambiguous`);
    }
    if (
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    ) {
      throw new Error(
        `required job ${requiredName} is not completed successfully`,
      );
    }
  }

  return {
    runId: run.databaseId,
    workflow,
    requiredChecks: [...requiredChecks],
  };
}

async function main() {
  const [mode, rawStatus, headRef] = process.argv.slice(2);
  if (mode !== "resolve-required-contexts") {
    throw new Error(
      "usage: merge-ci-proof.mjs resolve-required-contexts <status> <head-ref>",
    );
  }
  if (!/^\d+$/.test(rawStatus ?? "")) {
    throw new Error("status must be a nonnegative integer");
  }
  const output = await Bun.stdin.text();
  const contexts = resolveRequiredContexts({
    status: Number(rawStatus),
    output,
    headRef,
  });
  process.stdout.write(`${JSON.stringify(contexts)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
