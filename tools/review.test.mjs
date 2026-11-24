import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  DEFAULT_HARNESS,
  DEFAULT_PROMPT,
  SCRUBBED_API_KEYS,
  buildGhDiffArgs,
  buildGhViewArgs,
  buildHarnessCommand,
  buildReviewStdin,
  buildReviewerEnv,
  parseReviewArgs,
  runReview,
} from "./review.mjs";

const REVIEW_SCRIPT = path.resolve(import.meta.dir, "review.mjs");

function makeCaptureStream() {
  let buf = "";
  return {
    write(chunk) {
      buf += String(chunk);
      return true;
    },
    text() {
      return buf;
    },
  };
}

describe("parseReviewArgs", () => {
  test("parses --help without requiring --pr", () => {
    expect(parseReviewArgs(["--help"])).toEqual({ help: true });
    expect(parseReviewArgs(["-h"])).toEqual({ help: true });
  });

  test("applies claude + opus defaults", () => {
    const parsed = parseReviewArgs(["--pr", "2448"]);
    expect(parsed).toEqual({
      help: false,
      pr: 2448,
      repo: null,
      harness: DEFAULT_HARNESS,
      model: "opus",
      prompt: DEFAULT_PROMPT,
      useApi: false,
      dryRun: false,
    });
  });

  test("omits default model for codex and agy unless --model is specified", () => {
    expect(
      parseReviewArgs(["--pr", "10", "--harness", "codex"]).model,
    ).toBeNull();
    expect(
      parseReviewArgs(["--pr", "10", "--harness", "agy"]).model,
    ).toBeNull();
    expect(
      parseReviewArgs(["--pr", "10", "--harness", "codex", "--model", "o3"])
        .model,
    ).toBe("o3");
    expect(
      parseReviewArgs([
        "--pr",
        "10",
        "--harness",
        "agy",
        "--model",
        "gemini-3.6-pro",
      ]).model,
    ).toBe("gemini-3.6-pro");
  });

  test("validates --pr, --repo, and --harness", () => {
    expect(() => parseReviewArgs([])).toThrow("--pr <N> is required");
    expect(() => parseReviewArgs(["--pr", "0"])).toThrow("invalid --pr value");
    expect(() => parseReviewArgs(["--pr=-5"])).toThrow("invalid --pr value");
    expect(() => parseReviewArgs(["--pr", "abc"])).toThrow(
      "invalid --pr value",
    );
    expect(() =>
      parseReviewArgs(["--pr", "12", "--repo", "not-a-slug"]),
    ).toThrow("invalid --repo value");
    expect(() =>
      parseReviewArgs(["--pr", "12", "--harness", "unknown"]),
    ).toThrow("unknown --harness");
  });
});

describe("buildReviewerEnv", () => {
  test("scrubs ANTHROPIC_API_KEY and other provider keys by default (F-5)", () => {
    const baseEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      ANTHROPIC_API_KEY: "sk-ant-invalid",
      OPENAI_API_KEY: "sk-openai",
      GEMINI_API_KEY: "AIza-gemini",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    const result = buildReviewerEnv(baseEnv);

    expect(result.authMode).toBe("subscription");
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.GEMINI_API_KEY).toBeUndefined();
    expect(result.env.CLAUDECODE).toBeUndefined();
    expect(result.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.env.PATH).toBe("/usr/bin");
    expect(result.env.HOME).toBe("/Users/test");
    expect(result.scrubbed).toEqual([
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
    ]);
    // Must not mutate caller env.
    expect(baseEnv.ANTHROPIC_API_KEY).toBe("sk-ant-invalid");
  });

  test("preserves ANTHROPIC_API_KEY when useApi is true while still clearing nested session markers", () => {
    const baseEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-valid",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    const result = buildReviewerEnv(baseEnv, { useApi: true });

    expect(result.authMode).toBe("api-key");
    expect(result.env.ANTHROPIC_API_KEY).toBe("sk-ant-valid");
    expect(result.env.CLAUDECODE).toBeUndefined();
    expect(result.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.scrubbed).toEqual([]);
  });

  test("scrubs every key listed in SCRUBBED_API_KEYS", () => {
    const baseEnv = Object.fromEntries(
      SCRUBBED_API_KEYS.map((key) => [key, `secret-${key}`]),
    );
    const result = buildReviewerEnv(baseEnv);
    for (const key of SCRUBBED_API_KEYS) {
      expect(result.env[key]).toBeUndefined();
    }
    expect(result.scrubbed).toEqual([...SCRUBBED_API_KEYS]);
  });
});

describe("argv builders", () => {
  test("buildGhViewArgs and buildGhDiffArgs forward --repo when provided", () => {
    expect(buildGhViewArgs({ pr: 42 })).toEqual([
      "pr",
      "view",
      "42",
      "--json",
      "number,title,body,baseRefName,headRefName,url,author",
    ]);
    expect(buildGhViewArgs({ pr: 42, repo: "watt-mind/factory" })).toContain(
      "--repo",
    );
    expect(
      buildGhViewArgs({ pr: 42, repo: "watt-mind/factory" }).slice(-2),
    ).toEqual(["--repo", "watt-mind/factory"]);

    expect(buildGhDiffArgs({ pr: 42 })).toEqual(["pr", "diff", "42"]);
    expect(buildGhDiffArgs({ pr: 42, repo: "watt-mind/factory" })).toEqual([
      "pr",
      "diff",
      "42",
      "--repo",
      "watt-mind/factory",
    ]);
  });

  test("buildHarnessCommand builds argv for claude, codex, and agy", () => {
    expect(
      buildHarnessCommand({
        harness: "claude",
        model: "opus",
        prompt: "Check bugs",
      }),
    ).toEqual({
      cmd: "claude",
      args: ["-p", "--model", "opus", "Check bugs"],
    });

    expect(
      buildHarnessCommand({
        harness: "claude",
        model: null,
        prompt: "Check bugs",
      }),
    ).toEqual({
      cmd: "claude",
      args: ["-p", "Check bugs"],
    });

    expect(
      buildHarnessCommand({
        harness: "codex",
        model: null,
        prompt: "Check bugs",
      }),
    ).toEqual({
      cmd: "codex",
      args: ["exec", "-"],
    });

    expect(
      buildHarnessCommand({
        harness: "codex",
        model: "o3",
        prompt: "Check bugs",
      }),
    ).toEqual({
      cmd: "codex",
      args: ["exec", "--model", "o3", "-"],
    });

    expect(
      buildHarnessCommand({
        harness: "agy",
        model: null,
        prompt: "Check bugs",
      }),
    ).toEqual({
      cmd: "agy",
      args: ["-p", "-"],
    });

    expect(
      buildHarnessCommand({
        harness: "agy",
        model: "gemini-3.6-pro",
        prompt: "Check bugs",
      }),
    ).toEqual({
      cmd: "agy",
      args: ["-p", "-", "--model", "gemini-3.6-pro"],
    });
  });

  test("buildReviewStdin prepends prompt for codex/agy and passes PR context for claude", () => {
    const common = {
      prompt: "Focus on security",
      pr: 7,
      metadata: {
        number: 7,
        title: "Add review command",
        baseRefName: "develop",
        headRefName: "feat/review",
      },
      diff: "diff --git a/foo.js b/foo.js",
    };
    const claudeStdin = buildReviewStdin({ ...common, harness: "claude" });
    expect(claudeStdin).toContain("# PR #7: Add review command");
    expect(claudeStdin).toContain("diff --git a/foo.js b/foo.js");
    expect(claudeStdin).not.toStartWith("Focus on security");

    const codexStdin = buildReviewStdin({ ...common, harness: "codex" });
    expect(codexStdin).toStartWith("Focus on security\n\n# PR #7:");
  });
});

describe("runReview", () => {
  test("--help exits 0 and prints usage", async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runReview(["--help"], { stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("factory review");
    expect(stderr.text()).toBe("");
  });

  test("missing --pr exits 2 with error message", async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runReview([], { stdout, stderr });
    expect(code).toBe(2);
    expect(stderr.text()).toContain("--pr <N> is required");
  });

  test("--dry-run prints resolved command and scrubbed env without calling gh or harness", async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    let ghCalled = false;
    let harnessCalled = false;

    const code = await runReview(
      [
        "--pr",
        "2448",
        "--repo",
        "watt-mind/factory",
        "--prompt",
        "Audit carefully",
        "--dry-run",
      ],
      {
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-stale" },
        stdout,
        stderr,
        runGh: () => {
          ghCalled = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        runHarness: async () => {
          harnessCalled = true;
          return { exitCode: 0 };
        },
      },
    );

    expect(code).toBe(0);
    expect(ghCalled).toBe(false);
    expect(harnessCalled).toBe(false);
    const out = stdout.text();
    expect(out).toContain("PR:      #2448 (watt-mind/factory)");
    expect(out).toContain("scrubbed: ANTHROPIC_API_KEY");
    expect(out).toContain("--repo watt-mind/factory");
    expect(out).toContain("Command: claude -p --model opus 'Audit carefully'");
  });

  test("fetches PR metadata + diff, scrubs ANTHROPIC_API_KEY, and propagates harness exit code", async () => {
    const ghCalls = [];
    let capturedHarness = null;
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();

    const code = await runReview(
      ["--pr", "99", "--repo", "watt-mind/factory", "--prompt", "Review this"],
      {
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-stale" },
        stdout,
        stderr,
        runGh: (args) => {
          ghCalls.push(args);
          if (args[1] === "view") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                number: 99,
                title: "Fix bug",
                baseRefName: "develop",
                headRefName: "fix/99",
                url: "https://github.com/watt-mind/factory/pull/99",
                author: { login: "alice" },
                body: "Fixes #99",
              }),
              stderr: "",
            };
          }
          return {
            exitCode: 0,
            stdout: "diff --git a/a.mjs b/a.mjs\n+hello\n",
            stderr: "",
          };
        },
        runHarness: async (invocation) => {
          capturedHarness = invocation;
          return { exitCode: 3 };
        },
      },
    );

    expect(code).toBe(3);
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[0]).toContain("--repo");
    expect(ghCalls[0]).toContain("watt-mind/factory");
    expect(ghCalls[1]).toEqual([
      "pr",
      "diff",
      "99",
      "--repo",
      "watt-mind/factory",
    ]);
    expect(capturedHarness.cmd).toBe("claude");
    expect(capturedHarness.args).toEqual([
      "-p",
      "--model",
      "opus",
      "Review this",
    ]);
    expect(capturedHarness.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedHarness.stdin).toContain("# PR #99: Fix bug");
    expect(capturedHarness.stdin).toContain("+hello");
  });

  test("preserves ANTHROPIC_API_KEY when --use-api is passed", async () => {
    let capturedEnv = null;
    const code = await runReview(["--pr", "5", "--use-api"], {
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-explicit" },
      stdout: makeCaptureStream(),
      stderr: makeCaptureStream(),
      runGh: (args) =>
        args[1] === "view"
          ? { exitCode: 0, stdout: "{}", stderr: "" }
          : { exitCode: 0, stdout: "diff", stderr: "" },
      runHarness: async ({ env }) => {
        capturedEnv = env;
        return { exitCode: 0 };
      },
    });

    expect(code).toBe(0);
    expect(capturedEnv.ANTHROPIC_API_KEY).toBe("sk-ant-explicit");
  });

  test("propagates gh failure without invoking harness", async () => {
    const stderr = makeCaptureStream();
    let harnessCalled = false;
    const code = await runReview(["--pr", "404"], {
      env: { PATH: "/usr/bin" },
      stdout: makeCaptureStream(),
      stderr,
      runGh: () => ({
        exitCode: 1,
        stdout: "",
        stderr: "no pull requests found for 404",
      }),
      runHarness: async () => {
        harnessCalled = true;
        return { exitCode: 0 };
      },
    });

    expect(code).toBe(1);
    expect(harnessCalled).toBe(false);
    expect(stderr.text()).toContain("gh pr view failed");
  });

  test("CLI entrypoint exits 0 on --help", () => {
    const res = Bun.spawnSync({
      cmd: ["bun", REVIEW_SCRIPT, "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain("factory review");
  });
});
