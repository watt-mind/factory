/**
 * ci-log-capture@1's command (#2076).
 *
 * `gh run view --log-failed` always reads a run's LATEST attempt, and the
 * failed-run webhook fires while a re-run is often already in flight — so by
 * capture time the failed attempt has been superseded, `gh` prints nothing,
 * exits 1, and the whole dispatch is recorded as `agent_exit_1`. The webhook
 * does carry `workflow_run.run_attempt` (lib/intake.mjs puts it in the
 * payload), so when it is present this pins the read to that exact attempt:
 *
 *     gh run view <runId> --log-failed --attempt <runAttempt> --repo <repo>
 *
 * Plaintext, failed jobs only — the same bytes ci-doctor@2 already consumes
 * from `failed.log`. (`gh api .../attempts/{n}/logs` is NOT usable here: it
 * returns a ZIP of every job's log, and `gh api` has no output-to-file flag.)
 * Without an attempt the pre-#2076 command is used unchanged.
 *
 * The second half of the ticket: "there is nothing to capture" is a normal
 * terminal outcome. A deleted run, an expired or cancelled attempt, or an
 * empty log leaves `artifact.captured === "none"`, declares no `ci-log`
 * artifact, and exits 0 — so the run records COMPLETED-with-no-logs and the
 * `captured: "failed.log"` edge to factory.ci-diagnose.requested (edges.json)
 * simply does not fire. Genuine faults — auth, network, quota, a missing
 * `gh` — still exit non-zero and are still `agent_exit_<code>`.
 *
 * Precedence, when `gh` exits non-zero with nothing captured: FAULT wins over
 * MISSING. GitHub masks some authorization failures as 404, so stderr that
 * matches `EXPECTED_FAULT` is a fault even when it also reads as a missing
 * log; only stderr that matches `EXPECTED_MISSING` and no fault signal exits
 * 0. Anything unrecognized is a fault — the safe default is to surface it.
 * That precedence makes `EXPECTED_FAULT` the narrower of the two: it lists
 * explicit auth/network/quota signals only, never bare words like `auth` or
 * `timeout` that appear in `gh`'s routine "Try authenticating with: gh auth
 * login" hint printed alongside an ordinary deleted-run 404.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** The capture target, and the `captured` value the ci-diagnose edge keys on. */
export const LOG_FILE = "failed.log";
/** `captured` when the attempt had no retrievable log. No edge keys on it. */
export const NO_CAPTURE = "none";

const DETAIL_LIMIT = 400;

/**
 * `gh` output that means "this attempt's logs are gone", not "the capture
 * broke": the run was deleted, the attempt 404/410s, the log retention window
 * closed, or the run was cancelled before any job produced a log.
 *
 * Matched anywhere in the line: `gh` prefixes its diagnostics ("gh: ",
 * "error: "), and a prefixed genuine missing-log message must not fall
 * through to the fault branch and re-create the #2076 `agent_exit_1` flood.
 */
const EXPECTED_MISSING =
  /(?:\bHTTP (?:404|410)\b|no logs|logs? (?:have )?expired|run (?:was )?cancell?ed)/im;

/**
 * A missing-log response must never conceal a failure to make the request.
 * GitHub deliberately masks some authorization failures as 404, so this
 * check deliberately wins over `EXPECTED_MISSING` above.
 *
 * Explicit signals only. Bare `auth`/`timeout`/`permission`/`forbidden` were
 * removed: `gh` appends "Try authenticating with: gh auth login" to plain
 * 404s, which would classify an ordinary deleted run as a fault.
 */
const EXPECTED_FAULT =
  /HTTP (?:401|403)\b|bad credentials|rate limit|context cancell?ed|context deadline exceeded|connection refused|EAI_AGAIN|ENOTFOUND|resource not accessible/i;

/**
 * The pinned-attempt argv, and the legacy fallback when the event carries no
 * usable attempt. A non-integer or sub-1 attempt degrades to the fallback
 * rather than producing a nonsense `--attempt` value.
 */
export function buildArgv(input = {}) {
  const raw = input.runAttempt;
  const attempt = Number.isInteger(raw) && raw >= 1 ? raw : null;
  return {
    attempt,
    argv: [
      "gh",
      "run",
      "view",
      String(input.runId),
      "--log-failed",
      ...(attempt === null ? [] : ["--attempt", String(attempt)]),
      "--repo",
      String(input.repo),
    ],
  };
}

/**
 * Spawn `gh` with stdout wired straight to the log file: a failed-job log is
 * routinely multi-megabyte, so it must never pass through a stdout buffer.
 */
function spawnToFile(argv, logPath) {
  const fd = openSync(logPath, "w");
  try {
    const child = spawnSync(argv[0], argv.slice(1), {
      stdio: ["ignore", fd, "pipe"],
      encoding: "utf8",
    });
    if (child.error) {
      // Could not even start `gh` — a fault, never an expected-missing log.
      return {
        exitCode: child.status ?? 1,
        stderr: String(child.error.message),
      };
    }
    return { exitCode: child.status ?? 1, stderr: child.stderr ?? "" };
  } finally {
    closeSync(fd);
  }
}

/**
 * @returns {{ ok: boolean, captured: string, reason: string, argv: string[],
 *             exitCode: number, result?: object }}
 *   `ok: false` is a genuine fault: the caller exits `exitCode` and writes no
 *   result, so the worker records FAILED as it always has.
 */
export function captureCiLog({
  cwd = process.cwd(),
  input,
  spawn = spawnToFile,
} = {}) {
  const logPath = path.join(cwd, LOG_FILE);
  const { argv, attempt } = buildArgv(input);
  const { exitCode, stderr } = spawn(argv, logPath);

  const bytes = existsSync(logPath) ? statSync(logPath).size : 0;
  const captured = exitCode === 0 && bytes > 0;
  // An empty or partial file is not an artifact; leaving it would declare
  // zero bytes to the store and hand ci-doctor@2 an empty log.
  if (!captured && existsSync(logPath)) unlinkSync(logPath);

  const detail = String(stderr ?? "");
  if (
    !captured &&
    exitCode !== 0 &&
    (EXPECTED_FAULT.test(detail) || !EXPECTED_MISSING.test(detail))
  ) {
    return {
      ok: false,
      captured: NO_CAPTURE,
      reason: detail.trim().slice(0, DETAIL_LIMIT) || "gh failed",
      argv,
      exitCode: exitCode || 1,
    };
  }

  const reason = captured
    ? `captured ${attempt === null ? "current run" : `attempt ${attempt}`} logs`
    : exitCode === 0
      ? "no_logs: gh reported no failed-job logs"
      : `no_logs: ${detail.trim().slice(0, DETAIL_LIMIT) || "logs unavailable"}`;

  const result = {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: "ok",
    artifact: {
      command: argv,
      exitCode: 0,
      outputTail: reason,
      captured: captured ? LOG_FILE : NO_CAPTURE,
    },
    evidence: { command: argv, outputTail: reason },
    ...(captured ? { artifacts: [{ kind: "ci-log", path: LOG_FILE }] } : {}),
  };
  writeFileSync(
    path.join(cwd, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return {
    ok: true,
    captured: result.artifact.captured,
    reason,
    argv,
    exitCode: 0,
    result,
  };
}

export function main(cwd = process.cwd()) {
  const input = JSON.parse(readFileSync(path.join(cwd, "input.json"), "utf8"));
  const outcome = captureCiLog({ cwd, input });
  if (!outcome.ok) {
    process.stderr.write(`${outcome.reason}\n`);
    return outcome.exitCode;
  }
  process.stdout.write(`${outcome.reason}\n`);
  return 0;
}

if (import.meta.main) process.exit(main());
