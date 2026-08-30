import "../test-helpers.mjs";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-merge-verify-test-mjs";

import { pollWorkflow, proveLanded, runMergeVerify } from "./merge-verify.mjs";

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
      reason: "github_unavailable: list workflow runs: API rate limit exceeded",
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
      "github_unavailable: list workflow runs: API rate limit exceeded",
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

  test("proveLanded reports gh stderr as a transport error", () => {
    expect(() =>
      proveLanded("watt-mind/factory", landed, () =>
        result({ status: 1, stderr: "API rate limit exceeded" }),
      ),
    ).toThrow("github_unavailable: read PR 42: API rate limit exceeded");
  });
});
