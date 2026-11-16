import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-ci-log-capture-test-mjs";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LOG_FILE,
  NO_CAPTURE,
  buildArgv,
  captureCiLog,
} from "./ci-log-capture.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const INPUT = { repo: "watt-mind/factory", runId: 33300511167 };

/** A `gh` stand-in: writes `stdout` to the log file and returns its exit. */
function fakeGh({ stdout = "", stderr = "", exitCode = 0, spawnError = null }) {
  const calls = [];
  const spawn = (argv, logPath) => {
    calls.push(argv);
    writeFileSync(logPath, stdout, "utf8");
    return { exitCode, stderr, spawnError };
  };
  spawn.calls = calls;
  return spawn;
}

function readResult(cwd) {
  return JSON.parse(readFileSync(path.join(cwd, "result.json"), "utf8"));
}

describe("ci-log-capture command (#2076)", () => {
  test("pins the failed attempt with gh run view --log-failed --attempt", () => {
    expect(buildArgv({ ...INPUT, runAttempt: 3 }).argv).toEqual([
      "gh",
      "run",
      "view",
      "33300511167",
      "--log-failed",
      "--attempt",
      "3",
      "--repo",
      "watt-mind/factory",
    ]);
  });

  // `gh api` has no output-to-file flag and its attempts/logs endpoint returns
  // a ZIP; ci-doctor@2 reads failed.log as plaintext, so the argv must stay
  // `gh run view`.
  test("never reaches for gh api", () => {
    for (const runAttempt of [undefined, 2]) {
      const { argv } = buildArgv({ ...INPUT, runAttempt });
      expect(argv.slice(0, 3)).toEqual(["gh", "run", "view"]);
      expect(argv).not.toContain("api");
      expect(argv).not.toContain("--output");
    }
  });

  test("an unusable attempt degrades to the no-attempt fallback", () => {
    for (const runAttempt of [undefined, null, 0, -1, 1.5, "2"]) {
      const { attempt, argv } = buildArgv({ ...INPUT, runAttempt });
      expect(attempt).toBeNull();
      expect(argv).not.toContain("--attempt");
    }
  });

  test("a captured attempt declares the ci-log artifact and fires the ci-diagnose edge", () => {
    const cwd = tmpDir("evrt-ci-log-capture-hit-");
    const spawn = fakeGh({ stdout: "##[error]socket hang up\n" });
    const outcome = captureCiLog({
      cwd,
      input: { ...INPUT, runAttempt: 1 },
      spawn,
    });

    expect(spawn.calls[0]).toContain("--attempt");
    expect(outcome.ok).toBe(true);
    expect(existsSync(path.join(cwd, LOG_FILE))).toBe(true);

    const result = readResult(cwd);
    expect(result.artifact.captured).toBe("failed.log");
    expect(result.terminalState).toBe("completed");
    expect(result.artifacts).toEqual([{ kind: "ci-log", path: "failed.log" }]);

    // The captured value is exactly the edge key the chain resolver selects on
    // (lib/chain.mjs reads result.artifact[recommendationField]).
    const rule = registry.edges["ci-log-capture@1"];
    expect(rule.recommendationField).toBe("captured");
    expect(rule.edges[result.artifact.captured].eventType).toBe(
      "factory.ci-diagnose.requested",
    );
  });

  test("a superseded or deleted attempt completes with captured: none and no edge", () => {
    for (const stderr of [
      "gh: Not Found (HTTP 404)",
      "no logs found for this run",
      "run was cancelled; logs were not produced",
      // `gh` prefixes its diagnostics; a prefixed missing-log message must
      // still be MISSING, not the #2076 agent_exit_1 fault.
      "gh: run was cancelled; logs were unavailable",
      "gh: no logs found for this run",
      "error: logs expired",
      "error: no logs found for this run",
    ]) {
      const cwd = tmpDir("evrt-ci-log-capture-miss-");
      const outcome = captureCiLog({
        cwd,
        input: { ...INPUT, runAttempt: 2 },
        spawn: fakeGh({ stderr, exitCode: 1 }),
      });
      expect(outcome.ok).toBe(true);

      const result = readResult(cwd);
      expect(result.artifact.captured).toBe(NO_CAPTURE);
      expect(result.artifact.exitCode).toBe(0);
      expect(result.artifact.outputTail).toStartWith("no_logs:");
      expect(result.artifacts).toBeUndefined();
      // No zero-byte file is left behind to be stored as an "artifact".
      expect(existsSync(path.join(cwd, LOG_FILE))).toBe(false);
      expect(
        registry.edges["ci-log-capture@1"].edges[result.artifact.captured],
      ).toBeUndefined();
    }
  });

  test("auth and network failures do not masquerade as missing logs", () => {
    for (const stderr of [
      "HTTP 401: Bad credentials",
      "HTTP 403: rate limit exceeded",
      'Post "https://api.github.com/repos/watt-mind/factory": context canceled',
    ]) {
      const cwd = tmpDir("evrt-ci-log-capture-fault-taxonomy-");
      const outcome = captureCiLog({
        cwd,
        input: INPUT,
        spawn: fakeGh({ stderr, exitCode: 1 }),
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.exitCode).toBe(1);
      expect(existsSync(path.join(cwd, "result.json"))).toBe(false);
    }
  });

  test("classifies an HTTP status before its accompanying message", () => {
    for (const stderr of [
      "HTTP 500: log not found in cache",
      "HTTP 403: the cancelled run cannot be read",
    ]) {
      const cwd = tmpDir("evrt-ci-log-capture-status-fault-");
      const outcome = captureCiLog({
        cwd,
        input: INPUT,
        spawn: fakeGh({ stderr, exitCode: 1 }),
      });

      expect(outcome.ok).toBe(false);
      expect(existsSync(path.join(cwd, "result.json"))).toBe(false);
    }

    for (const stderr of ["HTTP 410: cancelled run logs expired"]) {
      const cwd = tmpDir("evrt-ci-log-capture-status-missing-");
      const outcome = captureCiLog({
        cwd,
        input: INPUT,
        spawn: fakeGh({ stderr, exitCode: 1 }),
      });

      expect(outcome.ok).toBe(true);
      expect(readResult(cwd).artifact.captured).toBe(NO_CAPTURE);
    }
  });

  test("treats authorization-worded HTTP 404 responses as faults", () => {
    for (const stderr of [
      "HTTP 404: Resource not accessible by integration",
      "HTTP 404: permission denied",
      "HTTP 404: must have admin rights to Repository.",
      "HTTP 404: requires actions:read scope",
    ]) {
      const cwd = tmpDir("evrt-ci-log-capture-authz-404-");
      const outcome = captureCiLog({
        cwd,
        input: INPUT,
        spawn: fakeGh({ stderr, exitCode: 1 }),
      });

      expect(outcome.ok).toBe(false);
      expect(existsSync(path.join(cwd, "result.json"))).toBe(false);
    }
  });

  test("keeps a deleted HTTP 404 as expected-missing", () => {
    const cwd = tmpDir("evrt-ci-log-capture-deleted-404-");
    const outcome = captureCiLog({
      cwd,
      input: INPUT,
      spawn: fakeGh({ stderr: "HTTP 404: run was deleted", exitCode: 1 }),
    });

    expect(outcome.ok).toBe(true);
    expect(readResult(cwd).artifact.captured).toBe(NO_CAPTURE);
  });

  test("uses narrow missing-log text only when stderr has no HTTP status", () => {
    const cwd = tmpDir("evrt-ci-log-capture-statusless-missing-");
    const outcome = captureCiLog({
      cwd,
      input: INPUT,
      spawn: fakeGh({ stderr: "failed job logs have expired", exitCode: 1 }),
    });

    expect(outcome.ok).toBe(true);
    expect(readResult(cwd).artifact.captured).toBe(NO_CAPTURE);
  });

  test("does not treat a statusless cancelled run without log wording as missing", () => {
    const cwd = tmpDir("evrt-ci-log-capture-cancelled-fault-");
    const outcome = captureCiLog({
      cwd,
      input: INPUT,
      spawn: fakeGh({ stderr: "run was cancelled by the user", exitCode: 1 }),
    });

    expect(outcome.ok).toBe(false);
    expect(existsSync(path.join(cwd, "result.json"))).toBe(false);
  });

  test("a spawn failure remains a fault even when its message resembles missing logs", () => {
    const cwd = tmpDir("evrt-ci-log-capture-spawn-failure-");
    const outcome = captureCiLog({
      cwd,
      input: INPUT,
      spawn: fakeGh({
        stderr: "logs expired",
        exitCode: 1,
        spawnError: new Error("gh executable not found"),
      }),
    });

    expect(outcome.ok).toBe(false);
    expect(existsSync(path.join(cwd, "result.json"))).toBe(false);
  });

  test("gh's routine auth hint on a plain 404 stays a missing log", () => {
    const cwd = tmpDir("evrt-ci-log-capture-404-hint-");
    const outcome = captureCiLog({
      cwd,
      input: { ...INPUT, runAttempt: 2 },
      spawn: fakeGh({
        stderr: "HTTP 404: Not Found\nTry authenticating with: gh auth login",
        exitCode: 1,
      }),
    });

    expect(outcome.ok).toBe(true);
    const result = readResult(cwd);
    expect(result.artifact.captured).toBe(NO_CAPTURE);
    expect(result.artifact.exitCode).toBe(0);
    expect(existsSync(path.join(cwd, LOG_FILE))).toBe(false);
  });

  test("an empty log on a clean exit is no_logs, not a zero-byte artifact", () => {
    const cwd = tmpDir("evrt-ci-log-capture-empty-");
    captureCiLog({ cwd, input: INPUT, spawn: fakeGh({ stdout: "" }) });
    const result = readResult(cwd);
    expect(result.artifact.captured).toBe(NO_CAPTURE);
    expect(existsSync(path.join(cwd, LOG_FILE))).toBe(false);
  });

  test("a genuine fault stays non-zero and writes no result", () => {
    const cwd = tmpDir("evrt-ci-log-capture-fault-");
    const outcome = captureCiLog({
      cwd,
      input: INPUT,
      spawn: fakeGh({ stderr: "gh: authentication required", exitCode: 4 }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(4);
    expect(existsSync(path.join(cwd, "result.json"))).toBe(false);
  });
});
