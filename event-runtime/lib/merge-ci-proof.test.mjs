import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  noRequiredChecksDiagnostic,
  proveMergeCiFallback,
  resolveRequiredContexts,
  selectMergeCiRun,
} from "./merge-ci-proof.mjs";

const HEAD_REF = "feat/WM-243";
const HEAD_SHA = "a".repeat(40);
const protectedContexts = [
  { name: "Verify", bucket: "pass", state: "SUCCESS" },
  { name: "Lint", bucket: "pass", state: "SUCCESS" },
];

function resolve(status, output) {
  return resolveRequiredContexts({ status, output, headRef: HEAD_REF });
}

describe("required-context resolver", () => {
  test("status 0 with unique nonempty contexts is authoritative", () => {
    expect(resolve(0, JSON.stringify(protectedContexts))).toEqual(
      protectedContexts,
    );
  });

  test("the exact GitHub CLI no-required-checks result resolves to an empty list", () => {
    const diagnostic = noRequiredChecksDiagnostic(HEAD_REF);
    expect(diagnostic).toBe(
      "no required checks reported on the 'feat/WM-243' branch",
    );
    expect(resolve(1, diagnostic)).toEqual([]);
    expect(() => resolve(1, `${diagnostic}\n`)).toThrow();
    expect(() =>
      resolve(1, "no required checks reported on the feat/WM-243 branch"),
    ).toThrow();
    expect(() => resolve(2, diagnostic)).toThrow();
  });

  test("unavailable branch protection and every other command failure fail closed", () => {
    for (const output of [
      "HTTP 403: Upgrade to GitHub Pro or make this repository public",
      "HTTP 502: upstream unavailable",
      "no required checks reported on the 'another' branch",
    ]) {
      expect(() => resolve(1, output), output).toThrow(
        "required-context lookup failed",
      );
    }
  });

  test("malformed or ambiguous status-0 output fails closed", () => {
    for (const output of [
      "not-json",
      "{}",
      "[]",
      JSON.stringify([{ name: "", bucket: "pass", state: "SUCCESS" }]),
      JSON.stringify([{ name: "Verify", bucket: "", state: "SUCCESS" }]),
      JSON.stringify([
        { name: "Verify", bucket: "pass", state: "SUCCESS" },
        { name: "Verify", bucket: "pass", state: "SUCCESS" },
      ]),
    ]) {
      expect(() => resolve(0, output), output).toThrow();
    }
  });

  test("the resolver remains behaviorally aligned with merge-apply", () => {
    const apply = readFileSync(
      new URL("./merge-apply.mjs", import.meta.url),
      "utf8",
    );

    expect(apply).toContain("--required");
    expect(apply).toContain("name,bucket,state");
    expect(apply).toContain("noRequiredChecksDiagnostic");
    expect(apply).not.toContain("/protection");
  });
});

describe("configured merge_ci proof", () => {
  const fallback = {
    workflow: "CI",
    requiredChecks: ["Shadow runner fleet available", "Verify"],
    headSha: HEAD_SHA,
    runs: [
      {
        databaseId: 409,
        status: "completed",
        conclusion: "success",
        headSha: HEAD_SHA,
        workflowName: "CI",
      },
    ],
    jobs: [
      {
        name: "Shadow runner fleet available",
        status: "completed",
        conclusion: "success",
      },
      { name: "Verify", status: "completed", conclusion: "success" },
    ],
  };

  test("the selector ignores cancelled runs and requires exactly one live run", () => {
    const live = fallback.runs[0];
    const cancelled = {
      ...live,
      databaseId: 410,
      conclusion: "cancelled",
    };

    expect(
      selectMergeCiRun({
        workflow: fallback.workflow,
        headSha: fallback.headSha,
        runs: [cancelled, live],
      }),
    ).toBe(live);
    expect(() =>
      selectMergeCiRun({
        workflow: fallback.workflow,
        headSha: fallback.headSha,
        runs: [live, { ...live, databaseId: 411 }],
      }),
    ).toThrow("configured non-cancelled workflow run is missing or ambiguous");
    expect(() =>
      selectMergeCiRun({
        workflow: fallback.workflow,
        headSha: fallback.headSha,
        runs: [cancelled],
      }),
    ).toThrow("configured non-cancelled workflow run is missing or ambiguous");
  });

  test("Factory PR #409 uses the configured workflow and every exact job", () => {
    expect(
      proveMergeCiFallback({
        ...fallback,
        // An auxiliary visible check is deliberately not part of proof input.
        visibleChecks: [{ name: "docs", bucket: "pass", state: "SUCCESS" }],
      }),
    ).toEqual({
      runId: 409,
      workflow: "CI",
      requiredChecks: ["Shadow runner fleet available", "Verify"],
    });
  });

  test("a failed job outside the configured allow-list does not block proof", () => {
    expect(
      proveMergeCiFallback({
        ...fallback,
        runs: [{ ...fallback.runs[0], conclusion: "failure" }],
        jobs: [
          ...fallback.jobs,
          { name: "docs", status: "completed", conclusion: "failure" },
        ],
      }),
    ).toEqual({
      runId: 409,
      workflow: "CI",
      requiredChecks: ["Shadow runner fleet available", "Verify"],
    });
  });

  test("missing, duplicate, stale, or non-green fallback evidence fails closed", () => {
    expect(() =>
      proveMergeCiFallback({ ...fallback, jobs: fallback.jobs.slice(0, 1) }),
    ).toThrow("required job Verify is missing or ambiguous");
    expect(() =>
      proveMergeCiFallback({
        ...fallback,
        jobs: [...fallback.jobs, fallback.jobs[1]],
      }),
    ).toThrow("required job Verify is missing or ambiguous");
    expect(() =>
      proveMergeCiFallback({
        ...fallback,
        runs: [...fallback.runs, { ...fallback.runs[0], databaseId: 410 }],
      }),
    ).toThrow("configured non-cancelled workflow run is missing or ambiguous");
    expect(() =>
      proveMergeCiFallback({
        ...fallback,
        runs: [{ ...fallback.runs[0], headSha: "b".repeat(40) }],
      }),
    ).toThrow("configured non-cancelled workflow run is missing or ambiguous");
    expect(() =>
      proveMergeCiFallback({
        ...fallback,
        jobs: [
          fallback.jobs[0],
          { ...fallback.jobs[1], conclusion: "failure" },
        ],
      }),
    ).toThrow("required job Verify is not completed successfully");
  });

  test("a cancelled Verify success is not merge evidence", () => {
    const cancelled = {
      ...fallback.runs[0],
      databaseId: 410,
      conclusion: "cancelled",
    };

    expect(() =>
      proveMergeCiFallback({
        ...fallback,
        runs: [cancelled],
      }),
    ).toThrow("configured non-cancelled workflow run is missing or ambiguous");

    expect(
      proveMergeCiFallback({
        ...fallback,
        // Run-list order is newest first. The cancelled run is ignored, so
        // jobs from the remaining non-cancelled run are authoritative.
        runs: [cancelled, fallback.runs[0]],
      }),
    ).toEqual({
      runId: 409,
      workflow: "CI",
      requiredChecks: ["Shadow runner fleet available", "Verify"],
    });
  });
});
