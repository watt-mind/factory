#!/usr/bin/env bun
/**
 * `factory wait-ci` — wait for a GitHub Actions workflow run on a commit SHA
 * and enforce the REST check-runs gate (F-8 + F-15).
 *
 * Replaces ad-hoc `sleep` / `for i in $(seq 8)` shell loops and prevents a
 * superseded or false-green `gh run watch` from ever exiting 0 when any
 * check run on `<sha>` is still running or failed.
 */
import { parseArgs } from "node:util";

export const DEFAULT_WORKFLOW = "ci.yml";
export const DEFAULT_INTERVAL_SECONDS = 60;
export const MIN_INTERVAL_SECONDS = 30;
export const DEFAULT_REGISTER_ATTEMPTS = 8;
export const DEFAULT_REGISTER_DELAY_SECONDS = 15;

export const FAILING_CONCLUSIONS = Object.freeze([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

export const PASSING_CONCLUSIONS = Object.freeze([
  "success",
  "neutral",
  "skipped",
]);

const FAILING_SET = new Set(FAILING_CONCLUSIONS);
const PASSING_SET = new Set(PASSING_CONCLUSIONS);

export const HELP = `factory wait-ci — wait for a CI workflow run and verify all REST check-runs

Usage:
  factory wait-ci [sha] [options]

Options:
  --repo <owner/repo>          GitHub repository (default: auto-detected from gh/git)
  --workflow <name>            Workflow file or name (default: ${DEFAULT_WORKFLOW})
  --interval <seconds>         Poll interval for gh run watch (default: ${DEFAULT_INTERVAL_SECONDS}, min: ${MIN_INTERVAL_SECONDS})
  --register-attempts <count>  Max polls waiting for the run to register (default: ${DEFAULT_REGISTER_ATTEMPTS})
  --register-delay <seconds>   Delay between registration polls (default: ${DEFAULT_REGISTER_DELAY_SECONDS})
  --json                       Emit structured JSON result
  --help, -h                   Show this help

Examples:
  factory wait-ci
  factory wait-ci abc1234 --workflow ci.yml --interval 60
  factory wait-ci abc1234 --repo owner/repo --json
`;

export function parseRepoFromRemoteUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Match SSH (git@github.com:owner/repo.git) or URL (https://github.com/owner/repo.git, ssh://git@github.com/owner/repo.git)
  const sshScp = trimmed.match(/^[^@]+@[^:]+:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  if (sshScp) return sshScp[1];

  const httpOrSshUrl = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i,
  );
  if (httpOrSshUrl) return httpOrSshUrl[1];

  return null;
}

function parseIntOption(raw, name, min) {
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new Error(`${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  }
  const value = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (got ${raw})`);
  }
  return value;
}

function parseNumberOption(raw, name, min) {
  const trimmed = String(raw).trim();
  if (!trimmed || !/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`${name} must be a number >= ${min} (got ${JSON.stringify(raw)})`);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min} (got ${raw})`);
  }
  return value;
}

export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      workflow: { type: "string" },
      interval: { type: "string" },
      "register-attempts": { type: "string" },
      "register-delay": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    return { help: true };
  }

  if (positionals.length > 1) {
    throw new Error(
      `unexpected extra positional arguments: ${positionals.slice(1).join(" ")}`,
    );
  }

  const sha = positionals[0]?.trim() || null;

  let repo = null;
  if (values.repo !== undefined) {
    const trimmedRepo = values.repo.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(trimmedRepo)) {
      throw new Error(
        `--repo must be in owner/repo format (got ${JSON.stringify(values.repo)})`,
      );
    }
    repo = trimmedRepo;
  }

  const workflow =
    values.workflow !== undefined ? values.workflow.trim() : DEFAULT_WORKFLOW;
  if (!workflow) {
    throw new Error("--workflow must be a non-empty workflow file or name");
  }

  const interval =
    values.interval !== undefined
      ? parseIntOption(values.interval, "--interval", MIN_INTERVAL_SECONDS)
      : DEFAULT_INTERVAL_SECONDS;

  const registerAttempts =
    values["register-attempts"] !== undefined
      ? parseIntOption(values["register-attempts"], "--register-attempts", 1)
      : DEFAULT_REGISTER_ATTEMPTS;

  const registerDelay =
    values["register-delay"] !== undefined
      ? parseNumberOption(values["register-delay"], "--register-delay", 0)
      : DEFAULT_REGISTER_DELAY_SECONDS;

  return {
    help: false,
    sha,
    repo,
    workflow,
    interval,
    registerAttempts,
    registerDelay,
    json: Boolean(values.json),
  };
}

export function parseCheckRunsPayload(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);

  if (Array.isArray(parsed)) {
    const runs = [];
    for (const item of parsed) {
      if (item && Array.isArray(item.check_runs)) {
        runs.push(...item.check_runs);
      } else if (item && typeof item === "object" && "status" in item) {
        runs.push(item);
      }
    }
    return runs;
  }

  if (parsed && typeof parsed === "object" && Array.isArray(parsed.check_runs)) {
    return parsed.check_runs;
  }

  throw new Error("unexpected check-runs JSON shape");
}

function summarizeRun(run) {
  return {
    name: run?.name || "(unnamed check)",
    status: run?.status ?? "unknown",
    conclusion: run?.conclusion ?? null,
    html_url: run?.html_url ?? null,
  };
}

export function evaluateCheckRuns(checkRuns) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  if (runs.length === 0) {
    return {
      ok: false,
      total: 0,
      passed: [],
      failed: [],
      pending: [],
      reason: "no check runs found for commit",
    };
  }

  const passed = [];
  const failed = [];
  const pending = [];

  for (const run of runs) {
    const summary = summarizeRun(run);
    if (summary.status !== "completed") {
      pending.push(summary);
      continue;
    }
    if (FAILING_SET.has(summary.conclusion) || !PASSING_SET.has(summary.conclusion)) {
      failed.push(summary);
      continue;
    }
    passed.push(summary);
  }

  const ok = pending.length === 0 && failed.length === 0;
  let reason = null;
  if (!ok) {
    const parts = [];
    if (failed.length > 0) {
      parts.push(
        `${failed.length} failed (${failed.map((r) => `${r.name}=${r.conclusion ?? "null"}`).join(", ")})`,
      );
    }
    if (pending.length > 0) {
      parts.push(
        `${pending.length} incomplete (${pending.map((r) => `${r.name}=${r.status}`).join(", ")})`,
      );
    }
    reason = parts.join("; ");
  }

  return {
    ok,
    total: runs.length,
    passed,
    failed,
    pending,
    reason,
  };
}

export async function defaultExec(cmd, args, { cwd } = {}) {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

async function resolveSha(exec, cwd, rawSha = null) {
  if (!rawSha) {
    const res = await exec("git", ["rev-parse", "HEAD"], { cwd });
    const sha = String(res.stdout ?? "").trim();
    if (res.exitCode !== 0 || !sha) {
      const detail = String(res.stderr ?? "").trim() || `exit ${res.exitCode}`;
      throw new Error(
        `failed to resolve HEAD sha via git rev-parse HEAD: ${detail}`,
      );
    }
    return sha;
  }

  if (FULL_SHA_RE.test(rawSha)) {
    return rawSha;
  }

  // GitHub's Actions API requires a full 40-char SHA for `gh run list --commit`.
  // Expand short SHAs or refs locally when available; fall back to the raw value
  // if git resolution fails (e.g. targeting a remote --repo not checked out here).
  const res = await exec(
    "git",
    ["rev-parse", "--verify", `${rawSha}^{commit}`],
    { cwd },
  );
  const expanded = String(res.stdout ?? "").trim();
  if (res.exitCode === 0 && FULL_SHA_RE.test(expanded)) {
    return expanded;
  }
  return rawSha;
}

async function resolveRepo(exec, cwd) {
  const ghRes = await exec("gh", ["repo", "view", "--json", "nameWithOwner"], {
    cwd,
  });
  if (ghRes.exitCode === 0) {
    try {
      const parsed = JSON.parse(String(ghRes.stdout ?? ""));
      if (
        typeof parsed?.nameWithOwner === "string" &&
        /^[^/\s]+\/[^/\s]+$/.test(parsed.nameWithOwner.trim())
      ) {
        return parsed.nameWithOwner.trim();
      }
    } catch {
      // Fall through to git remote fallback.
    }
  }

  const gitRes = await exec("git", ["remote", "get-url", "origin"], { cwd });
  if (gitRes.exitCode === 0) {
    const fromRemote = parseRepoFromRemoteUrl(gitRes.stdout);
    if (fromRemote) return fromRemote;
  }

  throw new Error(
    "failed to auto-detect GitHub repo from gh repo view or git remote origin; pass --repo owner/repo",
  );
}

export async function waitCi(options = {}, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? defaultSleep;
  const cwd = deps.cwd;

  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  const interval = options.interval ?? DEFAULT_INTERVAL_SECONDS;
  const registerAttempts =
    options.registerAttempts ?? DEFAULT_REGISTER_ATTEMPTS;
  const registerDelay =
    options.registerDelay ?? DEFAULT_REGISTER_DELAY_SECONDS;

  let sha;
  try {
    sha = await resolveSha(exec, cwd, options.sha ?? null);
  } catch (err) {
    return {
      ok: false,
      stage: "resolve-sha",
      repo: options.repo ?? null,
      sha: null,
      workflow,
      runId: null,
      registerAttemptsUsed: 0,
      watchExitCode: null,
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: [],
      pendingChecks: [],
      error: err.message,
    };
  }

  let repo = options.repo ?? null;
  if (!repo) {
    try {
      repo = await resolveRepo(exec, cwd);
    } catch (err) {
      return {
        ok: false,
        stage: "resolve-repo",
        repo: null,
        sha,
        workflow,
        runId: null,
        registerAttemptsUsed: 0,
        watchExitCode: null,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: [],
        pendingChecks: [],
        error: err.message,
      };
    }
  }

  let runId = null;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= registerAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const listRes = await exec(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        workflow,
        "--commit",
        sha,
        "--json",
        "databaseId",
        "--limit",
        "1",
      ],
      { cwd },
    );

    if (listRes.exitCode !== 0) {
      const detail =
        String(listRes.stderr ?? "").trim() || `exit ${listRes.exitCode}`;
      return {
        ok: false,
        stage: "register",
        repo,
        sha,
        workflow,
        runId: null,
        registerAttemptsUsed: attemptsUsed,
        watchExitCode: null,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: [],
        pendingChecks: [],
        error: `gh run list failed: ${detail}`,
      };
    }

    let runs;
    try {
      runs = JSON.parse(String(listRes.stdout ?? "[]"));
    } catch (err) {
      return {
        ok: false,
        stage: "register",
        repo,
        sha,
        workflow,
        runId: null,
        registerAttemptsUsed: attemptsUsed,
        watchExitCode: null,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: [],
        pendingChecks: [],
        error: `failed to parse gh run list JSON: ${err.message}`,
      };
    }

    const found = Array.isArray(runs) ? runs[0]?.databaseId : null;
    if (found != null && String(found).trim() !== "") {
      runId = String(found).trim();
      break;
    }

    if (attempt < registerAttempts && registerDelay > 0) {
      await sleep(registerDelay * 1000);
    }
  }

  if (!runId) {
    return {
      ok: false,
      stage: "register",
      repo,
      sha,
      workflow,
      runId: null,
      registerAttemptsUsed: attemptsUsed,
      watchExitCode: null,
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: [],
      pendingChecks: [],
      error: `no workflow run registered for ${workflow} on ${sha} after ${registerAttempts} attempt(s)`,
    };
  }

  const watchRes = await exec(
    "gh",
    [
      "run",
      "watch",
      runId,
      "--repo",
      repo,
      "--exit-status",
      "--interval",
      String(interval),
    ],
    { cwd },
  );
  const watchExitCode = watchRes.exitCode;

  // F-15 invariant: regardless of `gh run watch` exit code (including a
  // superseded/false-green 0), always verify every check run on <sha> via REST.
  const apiRes = await exec(
    "gh",
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/commits/${sha}/check-runs`,
    ],
    { cwd },
  );

  if (apiRes.exitCode !== 0) {
    const detail =
      String(apiRes.stderr ?? "").trim() || `exit ${apiRes.exitCode}`;
    return {
      ok: false,
      stage: "check-runs",
      repo,
      sha,
      workflow,
      runId,
      registerAttemptsUsed: attemptsUsed,
      watchExitCode,
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: [],
      pendingChecks: [],
      error: `gh api check-runs failed: ${detail}`,
    };
  }

  let checkRuns;
  try {
    checkRuns = parseCheckRunsPayload(apiRes.stdout);
  } catch (err) {
    return {
      ok: false,
      stage: "check-runs",
      repo,
      sha,
      workflow,
      runId,
      registerAttemptsUsed: attemptsUsed,
      watchExitCode,
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: [],
      pendingChecks: [],
      error: `failed to parse check-runs JSON: ${err.message}`,
    };
  }

  const evaluation = evaluateCheckRuns(checkRuns);
  return {
    ok: evaluation.ok,
    stage: evaluation.ok ? "passed" : "check-runs",
    repo,
    sha,
    workflow,
    runId,
    registerAttemptsUsed: attemptsUsed,
    watchExitCode,
    totalChecks: evaluation.total,
    passedChecks: evaluation.passed.length,
    failedChecks: evaluation.failed,
    pendingChecks: evaluation.pending,
    error: evaluation.ok ? null : evaluation.reason,
  };
}

export function formatSummary(result) {
  const shortSha = result.sha ? result.sha.slice(0, 12) : "unknown";
  if (result.ok) {
    return `PASS: ${result.repo}@${shortSha} (${result.workflow} run ${result.runId}) — ${result.passedChecks}/${result.totalChecks} check runs passed`;
  }

  const lines = [];
  if (result.repo && result.sha && result.runId) {
    lines.push(
      `FAIL: ${result.repo}@${shortSha} (${result.workflow} run ${result.runId}) — ${result.error}`,
    );
  } else {
    lines.push(`FAIL [${result.stage}]: ${result.error}`);
  }

  for (const check of result.failedChecks ?? []) {
    lines.push(`  - ${check.name}: ${check.status} (${check.conclusion ?? "null"})`);
  }
  for (const check of result.pendingChecks ?? []) {
    lines.push(`  - ${check.name}: ${check.status}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), io = {}, deps = {}) {
  const writeOut = io.stdout ?? ((s) => process.stdout.write(s));
  const writeErr = io.stderr ?? ((s) => process.stderr.write(s));

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    writeErr(`wait-ci: ${err.message}\n`);
    return 2;
  }

  if (parsed.help) {
    writeOut(HELP);
    return 0;
  }

  const result = await waitCi(parsed, deps);
  if (parsed.json) {
    writeOut(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    writeOut(`${formatSummary(result)}\n`);
  } else {
    writeErr(`${formatSummary(result)}\n`);
  }

  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
