import "../test-helpers.mjs";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-merge-verify-test-mjs";

import {
  CATCH_UP_DEFAULTS,
  catchUpMergedTickets,
  listCatchUpItems,
  normalizeTicket,
  pollSmoke,
  pollWorkflow,
  proveLanded,
  runMergeVerify,
} from "./merge-verify.mjs";

const SHA = "a".repeat(40);
const MERGE_SHA = "c".repeat(40);
const landed = {
  pr: 42,
  ticket: "WM-500",
  mergeSha: MERGE_SHA,
  headSha: SHA,
  headRef: "feat/WM-500",
};
const mergeCi = {
  mergeCi: { workflow: "CI", requiredChecks: ["Verify"] },
};

function result({ status = 0, stdout = "", stderr = "" } = {}) {
  return { status, stdout, stderr };
}

function tempInput() {
  const cwd = tmpDir("evrt-merge-verify-");
  writeFileSync(
    path.join(cwd, "input.json"),
    JSON.stringify({
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      landed: [landed],
      finalSha: MERGE_SHA,
    }),
  );
  return cwd;
}

describe("merge verification GitHub transport handling", () => {
  test("poll workflow returns github_unavailable after bounded gh failures", () => {
    const output = pollWorkflow({
      github: "watt-mind/factory",
      workflow: "CI",
      base: "develop",
      sha: MERGE_SHA,
      requiredChecks: ["Verify"],
      attempts: 2,
      pause: () => {},
      shell: () => result({ status: 1, stderr: "API rate limit exceeded" }),
    });

    expect(output).toEqual({
      ok: false,
      reason:
        "github_unavailable: configured CI workflow and required jobs did not settle at exact merge SHA (2 of 2 polls failed: list workflow runs: API rate limit exceeded)",
    });
  });

  test("flaky window that ends unsettled is github_unavailable, not a settle failure", () => {
    let poll = 0;
    const output = pollWorkflow({
      github: "watt-mind/factory",
      workflow: "CI",
      base: "develop",
      sha: MERGE_SHA,
      requiredChecks: ["Verify"],
      attempts: 3,
      pause: () => {},
      shell: () => {
        poll += 1;
        if (poll < 3) return result({ status: 1, stderr: "HTTP 502" });
        return result({ stdout: "[]" });
      },
    });

    expect(output).toEqual({
      ok: false,
      reason:
        "github_unavailable: configured CI workflow and required jobs did not settle at exact merge SHA (2 of 3 polls failed: list workflow runs: HTTP 502)",
    });
  });

  test("clean window that ends unsettled keeps the settle-failure reason", () => {
    const output = pollWorkflow({
      github: "watt-mind/factory",
      workflow: "CI",
      base: "develop",
      sha: MERGE_SHA,
      requiredChecks: ["Verify"],
      attempts: 2,
      pause: () => {},
      shell: () => result({ stdout: "[]" }),
    });

    expect(output).toEqual({
      ok: false,
      reason:
        "configured CI workflow and required jobs did not settle at exact merge SHA",
    });
  });

  test("junk status-0 run list body is github_unavailable, not a SyntaxError", () => {
    const output = pollWorkflow({
      github: "watt-mind/factory",
      workflow: "CI",
      base: "develop",
      sha: MERGE_SHA,
      requiredChecks: ["Verify"],
      attempts: 1,
      pause: () => {},
      shell: () => result({ stdout: "<html>502 Bad Gateway" }),
    });

    expect(output.ok).toBe(false);
    expect(output.reason).toMatch(
      /^github_unavailable: configured CI workflow .* \(1 of 1 polls failed: list workflow runs: unparseable JSON response/,
    );
  });

  test("junk status-0 jobs body is github_unavailable, not a SyntaxError", () => {
    const output = pollWorkflow({
      github: "watt-mind/factory",
      workflow: "CI",
      base: "develop",
      sha: MERGE_SHA,
      requiredChecks: ["Verify"],
      attempts: 1,
      pause: () => {},
      shell: (_cmd, args) =>
        args[1] === "list"
          ? result({
              stdout: JSON.stringify([
                { databaseId: 7, workflowName: "CI", headSha: MERGE_SHA },
              ]),
            })
          : result({ stdout: '{"jobs": [truncated' }),
    });

    expect(output.ok).toBe(false);
    expect(output.reason).toMatch(
      /^github_unavailable: .*\(1 of 1 polls failed: read workflow jobs for run 7: unparseable JSON response/,
    );
  });

  test("pollSmoke flaky-then-unsettled window is github_unavailable", () => {
    let poll = 0;
    const output = pollSmoke({
      github: "watt-mind/factory",
      workflow: "Smoke",
      base: "develop",
      sha: MERGE_SHA,
      attempts: 4,
      pause: () => {},
      shell: () => {
        poll += 1;
        if (poll === 4) return result({ stdout: "[]" });
        if (poll === 2) return result({ stdout: "not json" });
        return result({ status: 1, stderr: "API rate limit exceeded" });
      },
    });

    expect(output).toEqual({
      ok: false,
      reason: `github_unavailable: configured smoke workflow Smoke did not settle at ${MERGE_SHA} (3 of 4 polls failed: list smoke workflow runs: API rate limit exceeded)`,
    });
  });

  test("pollSmoke clean red run still reports smoke failure", () => {
    const output = pollSmoke({
      github: "watt-mind/factory",
      workflow: "Smoke",
      base: "develop",
      sha: MERGE_SHA,
      attempts: 1,
      pause: () => {},
      shell: () =>
        result({
          stdout: JSON.stringify([
            { databaseId: 1, status: "completed", conclusion: "failure" },
          ]),
        }),
    });

    expect(output).toEqual({
      ok: false,
      reason: `configured smoke workflow Smoke failed at ${MERGE_SHA}`,
    });
  });

  test("transport failure does not block landed tickets as CI red", () => {
    const cwd = tempInput();
    const calls = [];
    expect(() =>
      runMergeVerify({
        cwd,
        db: null,
        repoRecord: mergeCi,
        pollAttempts: 2,
        pause: () => {},
        shell: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === "gh" && args[0] === "api") {
            return result({
              stdout: JSON.stringify({
                merged: true,
                merge_commit_sha: MERGE_SHA,
              }),
            });
          }
          return result({ status: 1, stderr: "API rate limit exceeded" });
        },
      }),
    ).toThrow(
      "github_unavailable: configured CI workflow and required jobs did not settle at exact merge SHA (2 of 2 polls failed: list workflow runs: API rate limit exceeded)",
    );
    expect(calls.filter(([cmd]) => cmd === "factory")).toEqual([]);
  });

  test("flaky transport window does not block landed tickets as CI red", () => {
    const cwd = tempInput();
    const calls = [];
    let polls = 0;
    expect(() =>
      runMergeVerify({
        cwd,
        db: null,
        repoRecord: mergeCi,
        pollAttempts: 3,
        pause: () => {},
        shell: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === "gh" && args[0] === "api") {
            return result({
              stdout: JSON.stringify({
                merged: true,
                merge_commit_sha: MERGE_SHA,
              }),
            });
          }
          polls += 1;
          if (polls === 3) return result({ stdout: "[]" });
          return result({ status: 1, stderr: "HTTP 502" });
        },
      }),
    ).toThrow(
      "github_unavailable: configured CI workflow and required jobs did not settle at exact merge SHA (2 of 3 polls failed: list workflow runs: HTTP 502)",
    );
    expect(calls.filter(([cmd]) => cmd === "factory")).toEqual([]);
  });

  test("genuine red workflow still blocks every landed ticket", () => {
    const cwd = tempInput();
    const calls = [];
    expect(() =>
      runMergeVerify({
        cwd,
        db: null,
        repoRecord: mergeCi,
        pause: () => {},
        shell: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === "factory") return result();
          if (args[0] === "api") {
            return result({
              stdout: JSON.stringify({
                merged: true,
                merge_commit_sha: MERGE_SHA,
              }),
            });
          }
          if (args[1] === "list") {
            return result({
              stdout: JSON.stringify([
                {
                  databaseId: 1,
                  workflowName: "CI",
                  headSha: MERGE_SHA,
                },
              ]),
            });
          }
          return result({
            stdout: JSON.stringify([
              { name: "Verify", status: "completed", conclusion: "failure" },
            ]),
          });
        },
      }),
    ).toThrow("configured CI workflow failed at exact merge SHA");
    expect(calls.filter(([cmd]) => cmd === "factory")).toHaveLength(3);
    const blocked = calls.find(
      ([cmd, args]) =>
        cmd === "factory" &&
        args.slice(0, 4).join(" ") === "linear state WM-500 Blocked",
    );
    expect(blocked?.[1]).toContain("ai:needs-review");
    expect(blocked?.[1]).toContain("ai:in-progress");
    expect(blocked?.[1]).toContain("agent:claude-code");
    expect(
      calls.some(([cmd, args]) => cmd === "factory" && args.includes("Done")),
    ).toBe(false);
  });

  test("a green batch catches up a previously stranded closed and merged ticket", () => {
    const cwd = tempInput();
    const calls = [];
    const strandedSha = "d".repeat(40);
    const divergedSha = "f".repeat(40);
    const db = { query: () => ({ all: () => [] }) };

    expect(
      runMergeVerify({
        cwd,
        db,
        repoRecord: {
          ...mergeCi,
          controlPlane: "github",
          project: "Factory",
        },
        pause: () => {},
        shell: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === "factory") return result();
          if (args[0] === "issue") {
            return result({
              stdout: JSON.stringify([
                {
                  number: 499,
                  projectItems: [
                    { title: "Factory", status: { name: "In Review" } },
                  ],
                },
                {
                  number: 498,
                  projectItems: [
                    { title: "Factory", status: { name: "Done" } },
                  ],
                },
                {
                  number: 497,
                  projectItems: [
                    { title: "Factory", status: { name: "In Review" } },
                  ],
                },
                {
                  number: 496,
                  projectItems: [
                    { title: "Factory", status: { name: "In Review" } },
                  ],
                },
              ]),
            });
          }
          if (args[0] === "pr" && args[1] === "list") {
            return result({
              stdout: JSON.stringify([
                {
                  number: 42,
                  baseRefName: "develop",
                  mergeCommit: { oid: MERGE_SHA },
                  mergedAt: "2026-08-30T10:00:00Z",
                  closingIssuesReferences: [],
                },
                {
                  number: 41,
                  baseRefName: "develop",
                  mergeCommit: { oid: strandedSha },
                  mergedAt: "2026-08-30T09:00:00Z",
                  closingIssuesReferences: [
                    {
                      number: 499,
                      repository: {
                        name: "factory",
                        owner: { login: "watt-mind" },
                      },
                    },
                    {
                      number: 498,
                      repository: {
                        name: "factory",
                        owner: { login: "watt-mind" },
                      },
                    },
                  ],
                },
                {
                  number: 43,
                  baseRefName: "develop",
                  mergeCommit: { oid: "e".repeat(40) },
                  mergedAt: "2026-08-30T10:00:00Z",
                  closingIssuesReferences: [
                    {
                      number: 497,
                      repository: {
                        name: "factory",
                        owner: { login: "watt-mind" },
                      },
                    },
                  ],
                },
                {
                  number: 40,
                  baseRefName: "develop",
                  mergeCommit: { oid: divergedSha },
                  mergedAt: "2026-08-30T08:00:00Z",
                  closingIssuesReferences: [
                    {
                      number: 496,
                      repository: {
                        name: "factory",
                        owner: { login: "watt-mind" },
                      },
                    },
                  ],
                },
              ]),
            });
          }
          if (args[0] === "api" && args[1].includes("/pulls/")) {
            return result({
              stdout: JSON.stringify({
                merged: true,
                merge_commit_sha: MERGE_SHA,
              }),
            });
          }
          if (args[0] === "run" && args[1] === "list") {
            return result({
              stdout: JSON.stringify([
                {
                  databaseId: 7,
                  workflowName: "CI",
                  headSha: MERGE_SHA,
                },
              ]),
            });
          }
          if (args[0] === "run" && args[1] === "view") {
            return result({
              stdout: JSON.stringify({
                jobs: [
                  {
                    name: "Verify",
                    status: "completed",
                    conclusion: "success",
                  },
                ],
              }),
            });
          }
          if (args[0] === "api" && args[1].includes("/compare/")) {
            return result({
              stdout: args[1].includes(divergedSha) ? "diverged\n" : "ahead\n",
            });
          }
          if (args[0] === "api" && args[1].includes("/git/ref/heads/")) {
            return result({ status: 1, stderr: "HTTP 404" });
          }
          throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
        },
      }),
    ).toBe(0);

    const doneCalls = calls.filter(
      ([cmd, args]) => cmd === "factory" && args.includes("Done"),
    );
    expect(doneCalls.map(([, args]) => args[2])).toEqual([
      "WM-500",
      "watt-mind/factory#499",
    ]);
    expect(doneCalls[1][1]).toContain("ai:in-progress");
    expect(doneCalls[1][1]).toContain("agent:claude-code");
    expect(
      calls.some(
        ([cmd, args]) =>
          cmd === "gh" &&
          args[0] === "api" &&
          args[1].includes(`/compare/${divergedSha}...${MERGE_SHA}`),
      ),
    ).toBe(true);
    const issueList = calls.find(
      ([cmd, args]) => cmd === "gh" && args[0] === "issue",
    );
    expect(issueList?.[1][issueList[1].indexOf("--limit") + 1]).toBe(
      String(CATCH_UP_DEFAULTS.issueLimit),
    );
    expect(issueList?.[1][issueList[1].indexOf("--search") + 1]).toMatch(
      /^closed:>=\d{4}-\d{2}-\d{2}$/,
    );
    const prList = calls.find(
      ([cmd, args]) => cmd === "gh" && args[0] === "pr",
    );
    expect(prList?.[1][prList[1].indexOf("--limit") + 1]).toBe(
      String(CATCH_UP_DEFAULTS.pullLimit),
    );
  });

  function strandedFixture(count) {
    const issues = [];
    const pulls = [
      {
        number: 1000,
        baseRefName: "develop",
        mergeCommit: { oid: MERGE_SHA },
        mergedAt: "2026-08-30T10:00:00Z",
        closingIssuesReferences: [],
      },
    ];
    for (let i = 0; i < count; i += 1) {
      const number = 100 + i;
      issues.push({
        number,
        projectItems: [{ title: "Factory", status: { name: "In Review" } }],
      });
      pulls.push({
        number: 500 + i,
        baseRefName: "develop",
        mergeCommit: { oid: String(i % 10).repeat(40) },
        mergedAt: `2026-08-2${i % 9}T09:00:00Z`,
        closingIssuesReferences: [
          {
            number,
            repository: { name: "factory", owner: { login: "watt-mind" } },
          },
        ],
      });
    }
    // Newest-first, as gh returns them; the catch-up must reorder oldest-first.
    return { issues: issues.reverse(), pulls: pulls.reverse() };
  }

  function catchUpShell(fixture, calls) {
    return (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "factory") return result();
      if (args[0] === "issue") {
        return result({ stdout: JSON.stringify(fixture.issues) });
      }
      if (args[0] === "pr") {
        return result({ stdout: JSON.stringify(fixture.pulls) });
      }
      if (args[0] === "api" && args[1].includes("/compare/")) {
        return result({ stdout: "ahead\n" });
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    };
  }

  test("listCatchUpItems bounds both list reads to the configured window", () => {
    const calls = [];
    const now = Date.parse("2026-08-30T12:00:00Z");
    const items = listCatchUpItems({
      github: "watt-mind/factory",
      base: "develop",
      project: "Factory",
      verifiedSha: MERGE_SHA,
      shell: catchUpShell(strandedFixture(3), calls),
      issueLimit: 50,
      pullLimit: 75,
      closedWithinDays: 7,
      now,
    });
    expect(items.map((item) => item.issue)).toEqual([100, 101, 102]);
    const issueArgs = calls.find(([, args]) => args[0] === "issue")[1];
    expect(issueArgs).toContain("--search");
    expect(issueArgs[issueArgs.indexOf("--search") + 1]).toBe(
      "closed:>=2026-08-23",
    );
    expect(issueArgs[issueArgs.indexOf("--limit") + 1]).toBe("50");
    const prArgs = calls.find(([, args]) => args[0] === "pr")[1];
    expect(prArgs[prArgs.indexOf("--limit") + 1]).toBe("75");
    expect(prArgs).not.toContain("--search");
    expect(() =>
      listCatchUpItems({
        github: "watt-mind/factory",
        base: "develop",
        project: "Factory",
        verifiedSha: MERGE_SHA,
        shell: catchUpShell(strandedFixture(1), []),
        issueLimit: 0,
      }),
    ).toThrow(/issueLimit must be a positive integer/);
  });

  test("catchUpMergedTickets caps ancestry proofs per run, oldest first", () => {
    const calls = [];
    const outcome = catchUpMergedTickets(
      {
        github: "watt-mind/factory",
        base: "develop",
        project: "Factory",
        verifiedSha: MERGE_SHA,
        excludeTickets: ["#101"],
        maxItems: 2,
      },
      catchUpShell(strandedFixture(6), calls),
    );
    expect(outcome).toEqual({
      reconciled: 2,
      failures: [],
      processed: 2,
      deferred: 3,
    });
    const compares = calls.filter(
      ([cmd, args]) => cmd === "gh" && args[0] === "api",
    );
    expect(compares).toHaveLength(2);
    const doneCalls = calls.filter(
      ([cmd, args]) => cmd === "factory" && args.includes("Done"),
    );
    expect(doneCalls.map(([, args]) => args[2])).toEqual([
      "watt-mind/factory#100",
      "watt-mind/factory#102",
    ]);
  });

  test("catchUpMergedTickets defaults to the documented cap", () => {
    const calls = [];
    const outcome = catchUpMergedTickets(
      {
        github: "watt-mind/factory",
        base: "develop",
        project: "Factory",
        verifiedSha: MERGE_SHA,
      },
      catchUpShell(strandedFixture(CATCH_UP_DEFAULTS.maxItems + 5), calls),
    );
    expect(outcome.processed).toBe(CATCH_UP_DEFAULTS.maxItems);
    expect(outcome.deferred).toBe(5);
    expect(
      calls.filter(([cmd, args]) => cmd === "gh" && args[0] === "api"),
    ).toHaveLength(CATCH_UP_DEFAULTS.maxItems);
  });

  test("runMergeVerify forwards catchUp options and reports deferrals", () => {
    const cwd = tempInput();
    const calls = [];
    const fixture = strandedFixture(4);
    const inner = catchUpShell(fixture, calls);
    expect(
      runMergeVerify({
        cwd,
        db: { query: () => ({ all: () => [] }) },
        repoRecord: { ...mergeCi, controlPlane: "github", project: "Factory" },
        pause: () => {},
        catchUp: { maxItems: 1, issueLimit: 10 },
        shell: (cmd, args) => {
          if (
            cmd === "gh" &&
            args[0] === "api" &&
            args[1].includes("/pulls/")
          ) {
            calls.push([cmd, args]);
            return result({
              stdout: JSON.stringify({
                merged: true,
                merge_commit_sha: MERGE_SHA,
              }),
            });
          }
          if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
            calls.push([cmd, args]);
            return result({
              stdout: JSON.stringify([
                { databaseId: 7, workflowName: "CI", headSha: MERGE_SHA },
              ]),
            });
          }
          if (cmd === "gh" && args[0] === "run" && args[1] === "view") {
            calls.push([cmd, args]);
            return result({
              stdout: JSON.stringify({
                jobs: [
                  {
                    name: "Verify",
                    status: "completed",
                    conclusion: "success",
                  },
                ],
              }),
            });
          }
          if (
            cmd === "gh" &&
            args[0] === "api" &&
            args[1].includes("/git/ref/")
          ) {
            calls.push([cmd, args]);
            return result({ status: 1, stderr: "HTTP 404" });
          }
          return inner(cmd, args);
        },
      }),
    ).toBe(0);
    const issueArgs = calls.find(
      ([cmd, args]) => cmd === "gh" && args[0] === "issue",
    )[1];
    expect(issueArgs[issueArgs.indexOf("--limit") + 1]).toBe("10");
    expect(
      calls.filter(
        ([cmd, args]) =>
          cmd === "gh" && args[0] === "api" && args[1].includes("/compare/"),
      ),
    ).toHaveLength(1);
    const written = JSON.parse(
      readFileSync(path.join(cwd, "result.json"), "utf8"),
    );
    expect(written.artifact.outputTail).toContain(
      "reconciled 1 previously stranded ticket(s) (3 deferred to the next green batch)",
    );
  });

  test("normalizeTicket collapses equivalent GitHub issue spellings", () => {
    const github = "watt-mind/factory";
    for (const form of [
      "watt-mind/factory#499",
      "#499",
      "499",
      " Watt-Mind/Factory#499 ",
    ]) {
      expect(normalizeTicket(form, github)).toBe("watt-mind/factory#499");
    }
    expect(normalizeTicket("other/repo#499", github)).toBe("other/repo#499");
    expect(normalizeTicket("WM-500", github)).toBe("wm-500");
  });

  test("proveLanded uses one REST request and validates its exact merge SHA", () => {
    const calls = [];
    const shell = (cmd, args) => {
      calls.push([cmd, args]);
      return result({
        stdout: JSON.stringify({ merged: true, merge_commit_sha: MERGE_SHA }),
      });
    };

    expect(proveLanded("watt-mind/factory", landed, shell)).toBe(true);
    expect(calls).toEqual([
      ["gh", ["api", "repos/watt-mind/factory/pulls/42"]],
    ]);
    expect(
      proveLanded("watt-mind/factory", { ...landed, mergeSha: SHA }, shell),
    ).toBe(false);
  });

  test("proveLanded reports a junk status-0 body as a transport error", () => {
    expect(() =>
      proveLanded("watt-mind/factory", landed, () =>
        result({ stdout: "<html>502" }),
      ),
    ).toThrow(/^github_unavailable: read PR 42: unparseable JSON response/);
  });

  test("proveLanded reports gh stderr as a transport error", () => {
    expect(() =>
      proveLanded("watt-mind/factory", landed, () =>
        result({ status: 1, stderr: "API rate limit exceeded" }),
      ),
    ).toThrow("github_unavailable: read PR 42: API rate limit exceeded");
  });
});
