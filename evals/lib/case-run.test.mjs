import { describe, expect, test } from "bun:test";
import { runCase, runSuite } from "./case-run.mjs";

function evalCase(id = "skill/example") {
  const [candidateName, name] = id.split("/");
  return {
    id,
    candidateName,
    name,
    candidateSource: null,
    problem: null,
  };
}

describe("case budgets", () => {
  test("gives the grader only the subject's remaining budget", async () => {
    let graderBudget;
    const result = await runCase({
      evalCase: evalCase(),
      timeoutMs: 1_000,
      budgetUsd: 5,
      runSkill: async () => ({ costUsd: 1.75 }),
      grade: async ({ budgetUsd }) => {
        graderBudget = budgetUsd;
        return { pass: true, reason: "ok", costUsd: 0.5 };
      },
    });

    expect(graderBudget).toBe(3.25);
    expect(result).toMatchObject({ status: "pass", costUsd: 2.25 });
  });

  test("does not grade when the subject exhausts the case budget", async () => {
    let gradeCalls = 0;
    const result = await runCase({
      evalCase: evalCase(),
      timeoutMs: 1_000,
      budgetUsd: 2,
      runSkill: async () => ({ costUsd: 2 }),
      grade: async () => {
        gradeCalls += 1;
        return { pass: true, reason: "unexpected" };
      },
    });

    expect(gradeCalls).toBe(0);
    expect(result).toMatchObject({
      status: "fail",
      reason: "case budget exhausted by the subject run",
      costUsd: 2,
    });
  });

  test("preserves unbounded budget values for the grader", async () => {
    for (const budgetUsd of [undefined, Infinity, 0, -1]) {
      let graderBudget = Symbol("not-called");
      await runCase({
        evalCase: evalCase(),
        timeoutMs: 1_000,
        budgetUsd,
        runSkill: async () => ({ costUsd: 2 }),
        grade: async ({ budgetUsd: receivedBudget }) => {
          graderBudget = receivedBudget;
          return { pass: true, reason: "ok" };
        },
      });
      expect(graderBudget).toBe(budgetUsd);
    }
  });
});

test("suite case spending stays within each allocated case budget", async () => {
  const budgets = [];
  const suite = await runSuite({
    cases: [evalCase("skill/one"), evalCase("skill/two")],
    limits: {
      caseTimeoutSeconds: 1,
      caseBudgetUsd: 2,
      totalSeconds: 10,
      totalBudgetUsd: 3,
    },
    runSkill: async () => ({ costUsd: 1 }),
    grade: async ({ budgetUsd }) => {
      budgets.push(budgetUsd);
      return { pass: true, reason: "ok", costUsd: budgetUsd };
    },
  });

  expect(budgets).toEqual([1]);
  expect(suite.cases.map(({ costUsd }) => costUsd)).toEqual([2, 1]);
  expect(suite.totals.costUsd).toBe(3);
});
