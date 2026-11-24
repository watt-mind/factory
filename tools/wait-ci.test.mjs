import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_REGISTER_ATTEMPTS,
  DEFAULT_REGISTER_DELAY_SECONDS,
  DEFAULT_WORKFLOW,
  FAILING_CONCLUSIONS,
  evaluateCheckRuns,
  formatPrLine,
  formatSummary,
  main,
  parseCheckRunsPayload,
  parseCliArgs,
  parsePrPayload,
  parsePrRef,
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

describe("parsePrRef", () => {
  test("parses PR numbers, #numbers, and GitHub PR URLs", () => {
    expect(parsePrRef("2451")).toEqual({ number: 2451, repo: null });
    expect(parsePrRef("#2451")).toEqual({ number: 2451, repo: null });
    expect(
      parsePrRef("https://github.com/watt-mind/factory/pull/2451"),
    ).toEqual({ number: 2451, repo: "watt-mind/factory" });
    expect(
      parsePrRef("https://github.com/watt-mind/factory/pull/2451/files?w=1"),
    ).toEqual({ number: 2451, repo: "watt-mind/factory" });
  });

  test("rejects invalid PR refs", () => {
    expect(() => parsePrRef("")).toThrow(/--pr/);
    expect(() => parsePrRef("0")).toThrow(/--pr/);
    expect(() => parsePrRef("-5")).toThrow(/--pr/);
    expect(() => parsePrRef("not-a-pr")).toThrow(/--pr/);
    expect(() =>
      parsePrRef("https://github.com/watt-mind/factory/issues/2451"),
    ).toThrow(/--pr/);
  });
});

describe("parsePrPayload", () => {
  test("extracts REST pull request metadata", () => {
    const meta = parsePrPayload(
      JSON.stringify({
        head: {
          sha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
          ref: "feat/x",
        },
        base: { ref: "develop" },
        state: "open",
        merged: false,
        draft: true,
        mergeable: true,
        mergeable_state: "clean",
        title: "feat: test PR",
      }),
    );
    expect(meta).toEqual({
      headSha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
      state: "open",
      merged: false,
      draft: true,
      mergeable: true,
      mergeableState: "clean",
      title: "feat: test PR",
      baseRef: "develop",
      headRef: "feat/x",
    });
  });

  test("rejects missing head.sha or invalid payloads", () => {
    expect(() => parsePrPayload("")).toThrow(/empty PR/);
    expect(() => parsePrPayload("{}")).toThrow(/missing head\.sha/);
    expect(() => parsePrPayload("[]")).toThrow(/unexpected PR JSON/);
  });
});

describe("parseCliArgs", () => {
  test("applies defaults when invoked with no arguments", () => {
    expect(parseCliArgs([])).toEqual({
      help: false,
      sha: null,
      prs: [],
      noWait: false,
      failFast: false,
      maxWait: null,
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
        "--no-wait",
        "--json",
      ]),
    ).toEqual({
      help: false,
      sha: "deadbeef1234",
      prs: [],
      noWait: true,
      failFast: false,
      maxWait: null,
      repo: "watt-mind/factory",
      workflow: "release.yml",
      interval: 45,
      registerAttempts: 4,
      registerDelay: 5,
      json: true,
    });
  });

  test("parses repeatable --pr flags and deduplicates identical refs", () => {
    const parsed = parseCliArgs([
      "--pr",
      "2449",
      "--pr",
      "https://github.com/watt-mind/factory/pull/2450",
      "--pr",
      "2449",
      "--fail-fast",
      "--max-wait",
      "300",
    ]);
    expect(parsed.prs).toEqual([
      { number: 2449, repo: null },
      { number: 2450, repo: "watt-mind/factory" },
    ]);
    expect(parsed.failFast).toBe(true);
    expect(parsed.maxWait).toBe(300);
  });

  test("rejects combining positional sha and --pr with exit code 2 in main", async () => {
    expect(() => parseCliArgs(["deadbeef", "--pr", "2451"])).toThrow(
      /cannot combine positional <sha> with --pr/,
    );

    let stderr = "";
    const code = await main(
      ["deadbeef", "--pr", "2451"],
      {
        stdout: () => {},
        stderr: (s) => {
          stderr += s;
        },
      },
      {},
    );
    expect(code).toBe(2);
    expect(stderr).toContain("cannot combine positional <sha> with --pr");
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

  test("rejects invalid repo, register options, max-wait, and extra positionals", () => {
    expect(() => parseCliArgs(["--repo", "invalid"])).toThrow(/owner\/repo/);
    expect(() => parseCliArgs(["--register-attempts", "0"])).toThrow(
      /--register-attempts/,
    );
    expect(() => parseCliArgs(["--register-delay", "-1"])).toThrow(
      /--register-delay/,
    );
    expect(() => parseCliArgs(["--max-wait", "0"])).toThrow(/--max-wait/);
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
        if (
          cmd === "git" &&
          args[0] === "rev-parse" &&
          args[1] === "--verify"
        ) {
          return {
            exitCode: 128,
            stdout: "",
            stderr: "fatal: Needed a single revision",
          };
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

function prPayload(sha, overrides = {}) {
  return JSON.stringify({
    head: { sha, ref: "feat/test" },
    base: { ref: "develop" },
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    title: "feat: test",
    ...overrides,
  });
}

function checkRunsPayload(runs) {
  return JSON.stringify([{ total_count: runs.length, check_runs: runs }]);
}

describe("--no-wait snapshot mode", () => {
  test("SHA --no-wait fetches check-runs once without calling gh run list/watch", async () => {
    const fullSha = "1234567890abcdef1234567890abcdef12345678";
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${fullSha}/check-runs`
        ) {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "lint", status: "completed", conclusion: "success" },
              { name: "unit", status: "completed", conclusion: "success" },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      [fullSha, "--repo", "watt-mind/factory", "--no-wait"],
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
    expect(stdout).toContain("PASS: watt-mind/factory@1234567890ab (snapshot)");
    expect(calls).toHaveLength(1);
  });

  test("SHA --no-wait exits 1 when any check is pending or missing", async () => {
    const fullSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api") {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "unit", status: "in_progress", conclusion: null },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      [fullSha, "--repo", "watt-mind/factory", "--no-wait"],
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
    expect(stderr).toContain("FAIL: watt-mind/factory@aaaaaaaaaaaa (snapshot)");
    expect(stderr).toContain("unit=in_progress");
  });

  test("PR --no-wait fetches REST PR metadata + check-runs once and prints 1-line summary", async () => {
    const sha = "bbbb111122223333444455556666777788889999";
    const sleeps = [];
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2451"
        ) {
          return { exitCode: 0, stdout: prPayload(sha), stderr: "" };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${sha}/check-runs`
        ) {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "completed", conclusion: "success" },
              { name: "security", status: "completed", conclusion: "neutral" },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      ["--pr", "https://github.com/watt-mind/factory/pull/2451", "--no-wait"],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(sleeps).toEqual([]);
    expect(stdout.trim()).toBe(
      "PASS: PR #2451 (watt-mind/factory@bbbb11112222, open, clean) — 2/2 check runs passed",
    );
    // Zero GraphQL or gh repo view calls — repo came from PR URL
    expect(calls).toHaveLength(2);
  });

  test("batch --pr --no-wait exits 1 when one PR has pending or 0 checks and emits pure JSON with --json", async () => {
    const sha1 = "1111111111111111111111111111111111111111";
    const sha2 = "2222222222222222222222222222222222222222";
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2449"
        ) {
          return { exitCode: 0, stdout: prPayload(sha1), stderr: "" };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2450"
        ) {
          return {
            exitCode: 0,
            stdout: prPayload(sha2, { mergeable_state: "blocked" }),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${sha1}/check-runs`
        ) {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "completed", conclusion: "success" },
            ]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${sha2}/check-runs`
        ) {
          return { exitCode: 0, stdout: checkRunsPayload([]), stderr: "" };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      [
        "--pr",
        "2449",
        "--pr",
        "2450",
        "--repo",
        "watt-mind/factory",
        "--no-wait",
        "--json",
      ],
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
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.noWait).toBe(true);
    expect(parsed.totalPrs).toBe(2);
    expect(parsed.passedPrs).toBe(1);
    expect(parsed.failedPrs).toBe(1);
    expect(parsed.prs[0].pr).toBe(2449);
    expect(parsed.prs[0].ok).toBe(true);
    expect(parsed.prs[1].pr).toBe(2450);
    expect(parsed.prs[1].ok).toBe(false);
    expect(parsed.prs[1].error).toContain("no check runs found");
  });
});

describe("PR-native REST wait mode", () => {
  test("retries initial 0 check runs with registerDelay then polls on interval until green", async () => {
    const sha = "cccc111122223333444455556666777788889999";
    let checkCalls = 0;
    const sleeps = [];
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2451"
        ) {
          return { exitCode: 0, stdout: prPayload(sha), stderr: "" };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${sha}/check-runs`
        ) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return { exitCode: 0, stdout: checkRunsPayload([]), stderr: "" };
          }
          if (checkCalls === 2) {
            return {
              exitCode: 0,
              stdout: checkRunsPayload([
                { name: "ci", status: "in_progress", conclusion: null },
              ]),
              stderr: "",
            };
          }
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "completed", conclusion: "success" },
              { name: "lint", status: "completed", conclusion: "success" },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      [
        "--pr",
        "2451",
        "--repo",
        "watt-mind/factory",
        "--interval",
        "60",
        "--register-delay",
        "15",
      ],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(sleeps).toEqual([15_000, 60_000]);
    expect(stdout.trim()).toBe(
      "PASS: PR #2451 (watt-mind/factory@cccc11112222, open, clean) — 2/2 check runs passed",
    );
  });

  test("follows superseded push when head.sha changes mid-wait and logs head update", async () => {
    const oldSha = "old1111111111111111111111111111111111111";
    const newSha = "new2222222222222222222222222222222222222";
    let prCalls = 0;
    const sleeps = [];
    const { exec, calls } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2451"
        ) {
          prCalls += 1;
          return {
            exitCode: 0,
            stdout: prPayload(prCalls === 1 ? oldSha : newSha),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${oldSha}/check-runs`
        ) {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "in_progress", conclusion: null },
            ]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${newSha}/check-runs`
        ) {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "completed", conclusion: "success" },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      ["--pr", "2451", "--repo", "watt-mind/factory", "--interval", "30"],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(sleeps).toEqual([30_000]);
    expect(stdout).toContain(
      "UPDATE: PR #2451 (watt-mind/factory) head updated old111111111 -> new222222222 — watching new head",
    );
    expect(stdout).toContain(
      "PASS: PR #2451 (watt-mind/factory@new222222222, open, clean) — 1/1 check runs passed",
    );
    expect(calls).toContainEqual([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/watt-mind/factory/commits/${newSha}/check-runs`,
    ]);
  });

  test("stops immediately when PR is closed or merged mid-wait", async () => {
    const sha = "dddd111122223333444455556666777788889999";
    let prCalls = 0;
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2451"
        ) {
          prCalls += 1;
          if (prCalls === 1) {
            return { exitCode: 0, stdout: prPayload(sha), stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: prPayload(sha, { state: "closed", merged: true }),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api" && args[1] === "--paginate") {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "in_progress", conclusion: null },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      { prs: [{ number: 2451, repo: "watt-mind/factory" }], interval: 30 },
      { exec, sleep: async () => {} },
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("pr-closed");
    expect(result.merged).toBe(true);
    expect(result.error).toContain("already merged");
  });

  test("supports --fail-fast while other checks are still in progress", async () => {
    const sha = "eeee111122223333444455556666777788889999";
    const sleeps = [];
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2451"
        ) {
          return { exitCode: 0, stdout: prPayload(sha), stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api" && args[1] === "--paginate") {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "lint", status: "completed", conclusion: "failure" },
              { name: "e2e", status: "in_progress", conclusion: null },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      {
        prs: [{ number: 2451, repo: "watt-mind/factory" }],
        failFast: true,
        interval: 60,
      },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("check-runs");
    expect(result.failedChecks.map((c) => c.name)).toEqual(["lint"]);
    expect(result.pendingChecks.map((c) => c.name)).toEqual(["e2e"]);
    expect(sleeps).toEqual([]);
  });

  test("enforces --max-wait safety ceiling and reports timeout", async () => {
    const sha = "ffff111122223333444455556666777788889999";
    const sleeps = [];
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2451"
        ) {
          return { exitCode: 0, stdout: prPayload(sha), stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api" && args[1] === "--paginate") {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "e2e", status: "in_progress", conclusion: null },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    const result = await waitCi(
      {
        prs: [{ number: 2451, repo: "watt-mind/factory" }],
        interval: 60,
        maxWait: 90,
      },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("timeout");
    expect(result.error).toContain("timed out after 90s");
    expect(result.error).toContain("e2e=in_progress");
    expect(sleeps).toEqual([60_000, 30_000]);
  });

  test("fails PR after registerAttempts exhausted when 0 check runs exist", async () => {
    const sha = "9999111122223333444455556666777788880000";
    const sleeps = [];
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2451"
        ) {
          return { exitCode: 0, stdout: prPayload(sha), stderr: "" };
        }
      },
      (cmd, args) => {
        if (cmd === "gh" && args[0] === "api" && args[1] === "--paginate") {
          return { exitCode: 0, stdout: checkRunsPayload([]), stderr: "" };
        }
      },
    ]);

    const result = await waitCi(
      {
        prs: [{ number: 2451, repo: "watt-mind/factory" }],
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
    expect(result.error).toContain("no check runs registered for PR #2451");
    expect(sleeps).toEqual([10_000, 10_000]);
  });

  test("multi-PR batch polls on one shared tick, emits settled PRs immediately, and drops them from later ticks", async () => {
    const shaA = "aaaa000000000000000000000000000000000001";
    const shaB = "bbbb000000000000000000000000000000000002";
    let prACalls = 0;
    let prBCalls = 0;
    const sleeps = [];
    const progressEvents = [];

    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2449"
        ) {
          prACalls += 1;
          return { exitCode: 0, stdout: prPayload(shaA), stderr: "" };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2450"
        ) {
          prBCalls += 1;
          return { exitCode: 0, stdout: prPayload(shaB), stderr: "" };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${shaA}/check-runs`
        ) {
          // PR #2449 settles green on tick 1
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "completed", conclusion: "success" },
            ]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${shaB}/check-runs`
        ) {
          // PR #2450 is pending on tick 1, settles green on tick 2
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              prBCalls === 1
                ? { name: "ci", status: "in_progress", conclusion: null }
                : { name: "ci", status: "completed", conclusion: "success" },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      [
        "--pr",
        "2449",
        "--pr",
        "2450",
        "--repo",
        "watt-mind/factory",
        "--interval",
        "60",
      ],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      },
      {
        exec,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        onProgress: (line) => {
          progressEvents.push(line);
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    // PR #2449 was only fetched once (removed from active set after tick 1)
    expect(prACalls).toBe(1);
    expect(prBCalls).toBe(2);
    // Single shared sleep between tick 1 and tick 2
    expect(sleeps).toEqual([60_000]);
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]).toContain("PASS: PR #2449");
    expect(progressEvents[1]).toContain("PASS: PR #2450");
    expect(stdout).toContain("BATCH PASS: 2/2 PRs passed");
  });

  test("multi-PR batch --json emits pure JSON without progress lines and exits 1 if any PR fails", async () => {
    const shaA = "aaaa000000000000000000000000000000000003";
    const shaB = "bbbb000000000000000000000000000000000004";
    const { exec } = makeExecMock([
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2449"
        ) {
          return { exitCode: 0, stdout: prPayload(shaA), stderr: "" };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[1] === "repos/watt-mind/factory/pulls/2450"
        ) {
          return { exitCode: 0, stdout: prPayload(shaB), stderr: "" };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${shaA}/check-runs`
        ) {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "ci", status: "completed", conclusion: "success" },
            ]),
            stderr: "",
          };
        }
      },
      (cmd, args) => {
        if (
          cmd === "gh" &&
          args[0] === "api" &&
          args[3] === `repos/watt-mind/factory/commits/${shaB}/check-runs`
        ) {
          return {
            exitCode: 0,
            stdout: checkRunsPayload([
              { name: "unit", status: "completed", conclusion: "failure" },
            ]),
            stderr: "",
          };
        }
      },
    ]);

    let stdout = "";
    let stderr = "";
    const code = await main(
      ["--pr", "2449", "--pr", "2450", "--repo", "watt-mind/factory", "--json"],
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
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.passedPrs).toBe(1);
    expect(parsed.failedPrs).toBe(1);
    expect(parsed.prs[1].failedChecks[0].name).toBe("unit");
  });

  test("formatPrLine formats draft and merged metadata cleanly", () => {
    expect(
      formatPrLine({
        ok: true,
        pr: 42,
        repo: "watt-mind/factory",
        sha: "abcdef1234567890",
        state: "open",
        draft: true,
        mergeableState: "draft",
        passedChecks: 4,
        totalChecks: 4,
      }),
    ).toBe(
      "PASS: PR #42 (watt-mind/factory@abcdef123456, open, draft) — 4/4 check runs passed",
    );
  });
});
