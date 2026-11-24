import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_REGISTER_ATTEMPTS,
  DEFAULT_REGISTER_DELAY_SECONDS,
  DEFAULT_WORKFLOW,
  FAILING_CONCLUSIONS,
  evaluateCheckRuns,
  formatSummary,
  main,
  parseCheckRunsPayload,
  parseCliArgs,
  parseRepoFromRemoteUrl,
  waitCi,
} from "./wait-ci.mjs";

function makeExecMock(handlers) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    for (const handler of handlers) {
      const matched = handler(cmd, args, calls.length);
      if (matched !== undefined) return matched;
    }
    throw new Error(`unexpected exec call: ${cmd} ${args.join(" ")}`);
  };
  return { exec, calls };
}

describe("parseRepoFromRemoteUrl", () => {
  test("parses SSH, ssh://, and HTTPS GitHub remotes", () => {
    expect(parseRepoFromRemoteUrl("git@github.com:watt-mind/factory.git")).toBe(
      "watt-mind/factory",
    );
    expect(
      parseRepoFromRemoteUrl("ssh://git@github.com/watt-mind/factory.git"),
    ).toBe("watt-mind/factory");
    expect(
      parseRepoFromRemoteUrl("https://github.com/watt-mind/factory.git"),
    ).toBe("watt-mind/factory");
    expect(parseRepoFromRemoteUrl("https://github.com/watt-mind/factory")).toBe(
      "watt-mind/factory",
    );
    expect(parseRepoFromRemoteUrl("")).toBeNull();
    expect(parseRepoFromRemoteUrl("not-a-url")).toBeNull();
  });
});

describe("parseCliArgs", () => {
  test("applies defaults when invoked with no arguments", () => {
    expect(parseCliArgs([])).toEqual({
      help: false,
      sha: null,
      repo: null,
      workflow: DEFAULT_WORKFLOW,
      interval: DEFAULT_INTERVAL_SECONDS,
      registerAttempts: DEFAULT_REGISTER_ATTEMPTS,
      registerDelay: DEFAULT_REGISTER_DELAY_SECONDS,
      json: false,
    });
  });

  test("parses positional sha and all flags", () => {
    expect(
      parseCliArgs([
        "deadbeef1234",
        "--repo",
        "watt-mind/factory",
        "--workflow",
        "release.yml",
        "--interval",
        "45",
        "--register-attempts",
        "4",
        "--register-delay",
        "5",
        "--json",
      ]),
    ).toEqual({
      help: false,
      sha: "deadbeef1234",
      repo: "watt-mind/factory",
      workflow: "release.yml",
      interval: 45,
      registerAttempts: 4,
      registerDelay: 5,
      json: true,
    });
  });

  test("supports --help and -h", () => {
    expect(parseCliArgs(["--help"])).toEqual({ help: true });
    expect(parseCliArgs(["-h"])).toEqual({ help: true });
  });

  test("enforces minimum interval floor to avoid rate limits", () => {
    expect(() => parseCliArgs(["--interval", "10"])).toThrow(
      /--interval must be an integer >= 30/,
    );
    expect(() => parseCliArgs(["--interval", "29"])).toThrow(
      /--interval must be an integer >= 30/,
    );
    expect(parseCliArgs(["--interval", "30"]).interval).toBe(30);
  });

  test("rejects invalid repo, register options, and extra positionals", () => {
    expect(() => parseCliArgs(["--repo", "invalid"])).toThrow(/owner\/repo/);
    expect(() => parseCliArgs(["--register-attempts", "0"])).toThrow(
      /--register-attempts/,
    );
    expect(() => parseCliArgs(["--register-delay", "-1"])).toThrow(
      /--register-delay/,
    );
    expect(() => parseCliArgs(["sha1", "sha2"])).toThrow(/extra positional/);
  });
});

describe("parseCheckRunsPayload & evaluateCheckRuns", () => {
  test("flattens slurped multi-page check-runs responses", () => {
    const payload = JSON.stringify([
      {
        total_count: 3,
        check_runs: [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "docs", status: "completed", conclusion: "skipped" },
        ],
      },
      {
        total_count: 3,
        check_runs: [
          { name: "audit", status: "completed", conclusion: "neutral" },
        ],
      },
    ]);

    const runs = parseCheckRunsPayload(payload);
    expect(runs).toHaveLength(3);
    const verdict = evaluateCheckRuns(runs);
    expect(verdict.ok).toBe(true);
    expect(verdict.total).toBe(3);
    expect(verdict.passed).toHaveLength(3);
    expect(verdict.failed).toEqual([]);
    expect(verdict.pending).toEqual([]);
  });

  test("fails when zero check runs exist", () => {
    const verdict = evaluateCheckRuns([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no check runs found");
  });

  test("fails when any check run is not completed", () => {
    const verdict = evaluateCheckRuns([
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "e2e", status: "in_progress", conclusion: null },
      { name: "deploy", status: "queued", conclusion: null },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.pending.map((r) => r.name)).toEqual(["e2e", "deploy"]);
    expect(verdict.reason).toContain("e2e=in_progress");
    expect(verdict.reason).toContain("deploy=queued");
  });

  test("rejects every failing conclusion", () => {
    for (const conclusion of FAILING_CONCLUSIONS) {
      const verdict = evaluateCheckRuns([
        { name: "lint", status: "completed", conclusion: "success" },
        { name: `job-${conclusion}`, status: "completed", conclusion },
      ]);
      expect(verdict.ok).toBe(false);
      expect(verdict.failed).toHaveLength(1);
      expect(verdict.failed[0].name).toBe(`job-${conclusion}`);
      expect(verdict.failed[0].conclusion).toBe(conclusion);
    }
  });
});

describe("waitCi workflow", () => {
  test("auto-detects sha and repo, polls until run registers, watches, and passes check-runs gate", async () => {
    let listCalls = 0;
    const sleeps = [];
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (cmd === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: "abcdef1234567890\n", stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ nameWithOwner: "watt-mind/factory" }),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          listCalls += 1;
          if (listCalls < 3) {
            return { exitCode: 0, stdout: "[]", stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ databaseId: 987654321 }]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "watch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                total_count: 2,
                check_runs: [
                  { name: "unit", status: "completed", conclusion: "success" },
                  { name: "lint", status: "completed", conclusion: "success" },
                ],
              },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      { registerAttempts: 5, registerDelay: 15, interval: 60 },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stage).toBe("passed");
    expect(result.repo).toBe("watt-mind/factory");
    expect(result.sha).toBe("abcdef1234567890");
    expect(result.runId).toBe("987654321");
    expect(result.registerAttemptsUsed).toBe(3);
    expect(result.watchExitCode).toBe(0);
    expect(result.totalChecks).toBe(2);
    expect(result.passedChecks).toBe(2);
    expect(sleeps).toEqual([15_000, 15_000]);
    expect(calls).toContainEqual([
      "gh",
      "run",
      "watch",
      "987654321",
      "--repo",
      "watt-mind/factory",
      "--exit-status",
      "--interval",
      "60",
    ]);
    expect(calls).toContainEqual([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      "repos/watt-mind/factory/commits/abcdef1234567890/check-runs",
    ]);
  });

  test("falls back to git remote origin when gh repo view fails", async () => {
    const fullSha = "1111222233334444555566667777888899990000";
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "repo") {
          return { exitCode: 1, stdout: "", stderr: "not logged in" };
        }
      },
      (cmd, args) => {
        if (cmd === "git" && args[0] === "remote") {
          return {
            exitCode: 0,
            stdout: "git@github.com:watt-mind/factory.git\n",
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ databaseId: 42 }]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "watch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                check_runs: [
                  { name: "ci", status: "completed", conclusion: "success" },
                ],
              },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      { sha: fullSha },
      { exec, sleep: async () => {} },
    );

    expect(result.ok).toBe(true);
    expect(result.repo).toBe("watt-mind/factory");
  });

  test("expands short SHA or ref via git rev-parse --verify before calling gh", async () => {
    const expandedSha = "bf5a7840123456789abcdef0123456789abcdef0";
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "git" &&
          args[0] === "rev-parse" &&
          args[1] === "--verify" &&
          args[2] === "bf5a784^{commit}"
        ) {
          return { exitCode: 0, stdout: `${expandedSha}\n`, stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ databaseId: 777 }]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "watch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                check_runs: [
                  { name: "ci", status: "completed", conclusion: "success" },
                ],
              },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      { sha: "bf5a784", repo: "watt-mind/factory" },
      { exec, sleep: async () => {} },
    );

    expect(result.ok).toBe(true);
    expect(result.sha).toBe(expandedSha);
    expect(calls).toContainEqual([
      "gh",
      "run",
      "list",
      "--repo",
      "watt-mind/factory",
      "--workflow",
      "ci.yml",
      "--commit",
      expandedSha,
      "--json",
      "databaseId",
      "--limit",
      "1",
    ]);
    expect(calls).toContainEqual([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/watt-mind/factory/commits/${expandedSha}/check-runs`,
    ]);
  });

  test("falls back to raw sha when git rev-parse --verify fails (e.g. remote repo)", async () => {
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
          return { exitCode: 128, stdout: "", stderr: "fatal: Needed a single revision" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ databaseId: 888 }]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "watch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                check_runs: [
                  { name: "ci", status: "completed", conclusion: "success" },
                ],
              },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      { sha: "remote123", repo: "other-org/other-repo" },
      { exec, sleep: async () => {} },
    );

    expect(result.ok).toBe(true);
    expect(result.sha).toBe("remote123");
    expect(calls).toContainEqual([
      "gh",
      "run",
      "list",
      "--repo",
      "other-org/other-repo",
      "--workflow",
      "ci.yml",
      "--commit",
      "remote123",
      "--json",
      "databaseId",
      "--limit",
      "1",
    ]);
  });

  test("F-15: exits non-zero when gh run watch returns 0 (false-green) but REST check-runs shows failure", async () => {
    const fullSha = "deadbeef00001111222233334444555566667777";
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ databaseId: 1001 }]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "watch") {
          // Superseded/false-green watch exits 0!
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                total_count: 2,
                check_runs: [
                  { name: "lint", status: "completed", conclusion: "success" },
                  {
                    name: "unit-tests",
                    status: "completed",
                    conclusion: "failure",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      [fullSha, "--repo", "watt-mind/factory"],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      },
      { exec, sleep: async () => {} },
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("FAIL:");
    expect(stderr).toContain("unit-tests");
    expect(stderr).toContain("failure");
  });

  test("F-15: queries REST check-runs even when gh run watch exits non-zero", async () => {
    const fullSha = "cafebabe00001111222233334444555566667777";
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ databaseId: 2002 }]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "watch") {
          return { exitCode: 1, stdout: "", stderr: "job failed" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                check_runs: [
                  { name: "e2e", status: "completed", conclusion: "timed_out" },
                ],
              },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      { sha: fullSha, repo: "watt-mind/factory" },
      { exec, sleep: async () => {} },
    );

    expect(result.ok).toBe(false);
    expect(result.watchExitCode).toBe(1);
    expect(result.failedChecks.map((c) => c.name)).toEqual(["e2e"]);
    expect(calls.some((c) => c[0] === "gh" && c[1] === "api")).toBe(true);
  });

  test("fails after register attempts are exhausted without sleeping after the last attempt", async () => {
    const fullSha = "0000111122223333444455556666777788889999";
    const sleeps = [];
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
      },
    ]);

    const result = await waitCi(
      {
        sha: fullSha,
        repo: "watt-mind/factory",
        registerAttempts: 3,
        registerDelay: 10,
      },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("register");
    expect(result.registerAttemptsUsed).toBe(3);
    expect(result.error).toContain("no workflow run registered");
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(calls).toHaveLength(3);
  });

  test("emits JSON when --json is passed", async () => {
    const fullSha = "abc1234000011112222333344445555666677778";
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ databaseId: 555 }]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "run" && args[1] === "watch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                check_runs: [
                  { name: "ci", status: "completed", conclusion: "success" },
                ],
              },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      [fullSha, "--repo", "watt-mind/factory", "--json"],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      },
      { exec, sleep: async () => {} },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBe("555");
    expect(parsed.totalChecks).toBe(1);
    expect(parsed.passedChecks).toBe(1);
  });

  test("formatSummary formats pass and fail output concisely", () => {
    expect(
      formatSummary({
        ok: true,
        repo: "watt-mind/factory",
        sha: "abcdef1234567890",
        workflow: "ci.yml",
        runId: "99",
        passedChecks: 3,
        totalChecks: 3,
      }),
    ).toBe(
      "PASS: watt-mind/factory@abcdef123456 (ci.yml run 99) — 3/3 check runs passed",
    );

    expect(
      formatSummary({
        ok: false,
        stage: "check-runs",
        repo: "watt-mind/factory",
        sha: "abcdef1234567890",
        workflow: "ci.yml",
        runId: "99",
        error: "1 failed (unit=failure)",
        failedChecks: [
          { name: "unit", status: "completed", conclusion: "failure" },
        ],
        pendingChecks: [{ name: "e2e", status: "in_progress" }],
      }),
    ).toContain("  - unit: completed (failure)\n  - e2e: in_progress");
  });
});
