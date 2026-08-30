import "../test-helpers.mjs";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-merge-verify-test-mjs";

import {
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
