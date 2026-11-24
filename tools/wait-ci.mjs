#!/usr/bin/env bun
/**
 * `factory wait-ci` — wait for CI on a PR (single or batch) or commit SHA
 * via GitHub's REST API and enforce the check-runs gate (F-8 + F-15).
 *
 * Replaces ad-hoc `sleep` / `for i in $(seq 8)` shell loops and GraphQL-heavy
 * `gh pr checks` polling, follows superseded head pushes on PRs, and prevents
 * a superseded or false-green `gh run watch` from ever exiting 0 when any
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

export const HELP = `factory wait-ci — wait for CI via GitHub REST and verify all check-runs

Usage:
  factory wait-ci [sha] [options]
  factory wait-ci --pr <N|URL> [--pr <N|URL> ...] [options]

Options:
  --pr <N|URL>                 PR number or GitHub PR URL (repeatable for batch watching)
  --no-wait                    One-shot REST snapshot (no polling); exit 0 only if all checks passed
  --fail-fast                  In --pr wait mode, fail a PR as soon as any check-run fails
  --max-wait <seconds>         Optional max wait ceiling in seconds (--pr wait mode)
  --repo <owner/repo>          GitHub repository (default: auto-detected from gh/git or PR URL)
  --workflow <name>            Workflow file or name for SHA mode (default: ${DEFAULT_WORKFLOW})
  --interval <seconds>         Poll interval in seconds (default: ${DEFAULT_INTERVAL_SECONDS}, min: ${MIN_INTERVAL_SECONDS})
  --register-attempts <count>  Max polls waiting for runs/checks to register (default: ${DEFAULT_REGISTER_ATTEMPTS})
  --register-delay <seconds>   Delay between registration polls (default: ${DEFAULT_REGISTER_DELAY_SECONDS})
  --json                       Emit structured JSON result on stdout
  --help, -h                   Show this help

Examples:
  factory wait-ci
  factory wait-ci abc1234 --workflow ci.yml --interval 60
  factory wait-ci --pr 2451
  factory wait-ci --pr 2449 --pr 2450 --interval 60
  factory wait-ci --pr https://github.com/watt-mind/factory/pull/2451 --no-wait
  factory wait-ci --pr 2451 --json
`;

export function parseRepoFromRemoteUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Match SSH (git@github.com:owner/repo.git) or URL (https://github.com/owner/repo.git, ssh://git@github.com/owner/repo.git)
  const sshScp = trimmed.match(
    /^[^@]+@[^:]+:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/,
  );
  if (sshScp) return sshScp[1];

  const httpOrSshUrl = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i,
  );
  if (httpOrSshUrl) return httpOrSshUrl[1];

  return null;
}

export function parsePrRef(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error("--pr must be a PR number or GitHub pull request URL");
  }

  const numMatch = trimmed.match(/^#?([1-9]\d*)$/);
  if (numMatch) {
    const number = Number.parseInt(numMatch[1], 10);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error(
        `--pr must be a positive PR number (got ${JSON.stringify(raw)})`,
      );
    }
    return { number, repo: null };
  }

  const urlMatch = trimmed.match(
    /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/i,
  );
  if (urlMatch) {
    const number = Number.parseInt(urlMatch[2], 10);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error(
        `--pr URL must contain a valid PR number (got ${JSON.stringify(raw)})`,
      );
    }
    return { number, repo: urlMatch[1] };
  }

  throw new Error(
    `--pr must be a PR number or GitHub pull request URL (got ${JSON.stringify(raw)})`,
  );
}

function parseIntOption(raw, name, min) {
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new Error(
      `${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`,
    );
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
    throw new Error(
      `${name} must be a number >= ${min} (got ${JSON.stringify(raw)})`,
    );
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
      pr: { type: "string", multiple: true },
      "no-wait": { type: "boolean", default: false },
      "fail-fast": { type: "boolean", default: false },
      "max-wait": { type: "string" },
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

  const prs = [];
  const seenPrs = new Set();
  for (const rawPr of values.pr ?? []) {
    const parsedPr = parsePrRef(rawPr);
    const key = `${parsedPr.repo ?? ""}:${parsedPr.number}`;
    if (!seenPrs.has(key)) {
      seenPrs.add(key);
      prs.push(parsedPr);
    }
  }

  if (sha && prs.length > 0) {
    throw new Error(
      "cannot combine positional <sha> with --pr; pass either a commit SHA or --pr <N|URL>",
    );
  }

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

  const maxWait =
    values["max-wait"] !== undefined
      ? parseIntOption(values["max-wait"], "--max-wait", 1)
      : null;

  return {
    help: false,
    sha,
    prs,
    noWait: Boolean(values["no-wait"]),
    failFast: Boolean(values["fail-fast"]),
    maxWait,
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

  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray(parsed.check_runs)
  ) {
    return parsed.check_runs;
  }

  throw new Error("unexpected check-runs JSON shape");
}

export function parsePrPayload(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    throw new Error("empty PR response payload");
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unexpected PR JSON shape");
  }
  const headSha =
    typeof parsed.head?.sha === "string" && parsed.head.sha.trim()
      ? parsed.head.sha.trim()
      : null;
  if (!headSha) {
    throw new Error("PR payload is missing head.sha");
  }

  return {
    headSha,
    state: typeof parsed.state === "string" ? parsed.state : null,
    merged: Boolean(parsed.merged || parsed.merged_at),
    draft: Boolean(parsed.draft),
    mergeable: typeof parsed.mergeable === "boolean" ? parsed.mergeable : null,
    mergeableState:
      typeof parsed.mergeable_state === "string"
        ? parsed.mergeable_state
        : null,
    title: typeof parsed.title === "string" ? parsed.title : null,
    baseRef: typeof parsed.base?.ref === "string" ? parsed.base.ref : null,
    headRef: typeof parsed.head?.ref === "string" ? parsed.head.ref : null,
  };
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
    if (
      FAILING_SET.has(summary.conclusion) ||
      !PASSING_SET.has(summary.conclusion)
    ) {
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

async function fetchCheckRunsRest(exec, cwd, repo, sha) {
  const apiRes = await exec(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${repo}/commits/${sha}/check-runs`],
    { cwd },
  );
  if (apiRes.exitCode !== 0) {
    const detail =
      String(apiRes.stderr ?? "").trim() || `exit ${apiRes.exitCode}`;
    return { ok: false, error: `gh api check-runs failed: ${detail}` };
  }
  try {
    const checkRuns = parseCheckRunsPayload(apiRes.stdout);
    return { ok: true, checkRuns };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse check-runs JSON: ${err.message}`,
    };
  }
}

async function fetchPrMetadataRest(exec, cwd, repo, prNumber) {
  const apiRes = await exec("gh", ["api", `repos/${repo}/pulls/${prNumber}`], {
    cwd,
  });
  if (apiRes.exitCode !== 0) {
    const detail =
      String(apiRes.stderr ?? "").trim() || `exit ${apiRes.exitCode}`;
    return {
      ok: false,
      error: `gh api pulls/${prNumber} failed: ${detail}`,
    };
  }
  try {
    const meta = parsePrPayload(apiRes.stdout);
    return { ok: true, meta };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse PR #${prNumber} JSON: ${err.message}`,
    };
  }
}

function makePrResultBase(repo, prNumber, noWait) {
  return {
    ok: false,
    stage: "pending",
    repo,
    pr: prNumber,
    sha: null,
    title: null,
    state: null,
    merged: false,
    draft: false,
    mergeable: null,
    mergeableState: null,
    baseRef: null,
    headRef: null,
    headUpdates: 0,
    noWait,
    totalChecks: 0,
    passedChecks: 0,
    failedChecks: [],
    pendingChecks: [],
    error: null,
  };
}

function applyPrMeta(entry, meta) {
  entry.sha = meta.headSha;
  entry.state = meta.state;
  entry.merged = meta.merged;
  entry.draft = meta.draft;
  entry.mergeable = meta.mergeable;
  entry.mergeableState = meta.mergeableState;
  entry.title = meta.title;
  entry.baseRef = meta.baseRef;
  entry.headRef = meta.headRef;
}

function applyEvaluation(entry, evaluation) {
  entry.totalChecks = evaluation.total;
  entry.passedChecks = evaluation.passed.length;
  entry.failedChecks = evaluation.failed;
  entry.pendingChecks = evaluation.pending;
}

export function formatPrLine(result) {
  const shortSha = result.sha ? result.sha.slice(0, 12) : "unknown";
  const statusBits = [];
  if (result.state) {
    statusBits.push(result.merged ? "merged" : result.state);
  }
  if (result.draft) {
    statusBits.push("draft");
  }
  if (
    result.mergeableState &&
    !(result.draft && result.mergeableState === "draft")
  ) {
    statusBits.push(result.mergeableState);
  }
  const metaSuffix = statusBits.length > 0 ? `, ${statusBits.join(", ")}` : "";
  const refLabel = result.repo
    ? `${result.repo}@${shortSha}${metaSuffix}`
    : `${shortSha}${metaSuffix}`;

  if (result.ok) {
    return `PASS: PR #${result.pr} (${refLabel}) — ${result.passedChecks}/${result.totalChecks} check runs passed`;
  }
  return `FAIL: PR #${result.pr} (${refLabel}) — ${result.error}`;
}

function createProgressEmitter(options, deps) {
  if (options.json) {
    return () => {};
  }
  if (typeof deps.onProgress === "function") {
    return deps.onProgress;
  }
  if (typeof deps.stdout === "function" || typeof deps.stderr === "function") {
    return (line, { isError = false } = {}) => {
      const writer = isError
        ? (deps.stderr ?? deps.stdout)
        : (deps.stdout ?? deps.stderr);
      writer(`${line}\n`);
    };
  }
  return () => {};
}

function normalizePrTargets(rawPrs) {
  return rawPrs.map((item) => {
    if (typeof item === "number" || typeof item === "string") {
      return parsePrRef(item);
    }
    if (item && typeof item === "object" && Number.isSafeInteger(item.number)) {
      return { number: item.number, repo: item.repo ?? null };
    }
    throw new Error(`invalid PR target: ${JSON.stringify(item)}`);
  });
}

async function waitPrs(options, deps) {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? defaultSleep;
  const cwd = deps.cwd;
  const emit = createProgressEmitter(options, deps);

  const noWait = Boolean(options.noWait);
  const failFast = Boolean(options.failFast);
  const interval = options.interval ?? DEFAULT_INTERVAL_SECONDS;
  const registerAttempts =
    options.registerAttempts ?? DEFAULT_REGISTER_ATTEMPTS;
  const registerDelay = options.registerDelay ?? DEFAULT_REGISTER_DELAY_SECONDS;
  const maxWait = options.maxWait ?? null;

  const targets = normalizePrTargets(options.prs);
  const needsDefaultRepo = targets.some((t) => !t.repo);

  let defaultRepo = options.repo ?? null;
  if (needsDefaultRepo && !defaultRepo) {
    try {
      defaultRepo = await resolveRepo(exec, cwd);
    } catch (err) {
      if (targets.length === 1) {
        const single = makePrResultBase(null, targets[0].number, noWait);
        single.stage = "resolve-repo";
        single.error = err.message;
        return single;
      }
      const failedPrs = targets.map((t) => {
        const entry = makePrResultBase(t.repo ?? null, t.number, noWait);
        entry.stage = "resolve-repo";
        entry.error = err.message;
        return entry;
      });
      return {
        ok: false,
        stage: "resolve-repo",
        noWait,
        totalPrs: failedPrs.length,
        passedPrs: 0,
        failedPrs: failedPrs.length,
        error: err.message,
        prs: failedPrs,
      };
    }
  }

  const states = targets.map((t) => ({
    result: makePrResultBase(t.repo ?? defaultRepo, t.number, noWait),
    settled: false,
    registerPolls: 0,
  }));

  let elapsedSeconds = 0;

  while (true) {
    for (const item of states) {
      if (item.settled) continue;
      const { result } = item;

      const prevSha = result.sha;
      const prFetch = await fetchPrMetadataRest(
        exec,
        cwd,
        result.repo,
        result.pr,
      );
      if (!prFetch.ok) {
        result.ok = false;
        result.stage = "pr-fetch";
        result.error = prFetch.error;
        item.settled = true;
        if (!noWait) emit(formatPrLine(result), { ok: false, isError: true });
        continue;
      }

      applyPrMeta(result, prFetch.meta);

      if (prevSha && prevSha !== result.sha) {
        result.headUpdates += 1;
        item.registerPolls = 0;
        if (!noWait) {
          emit(
            `UPDATE: PR #${result.pr} (${result.repo}) head updated ${prevSha.slice(0, 12)} -> ${result.sha.slice(0, 12)} — watching new head`,
            { ok: true, isError: false },
          );
        }
      }

      if (!noWait && result.state !== "open") {
        result.ok = false;
        result.stage = "pr-closed";
        result.error = result.merged
          ? `PR #${result.pr} is already merged`
          : `PR #${result.pr} is ${result.state ?? "closed"}`;
        item.settled = true;
        emit(formatPrLine(result), { ok: false, isError: true });
        continue;
      }

      const checksFetch = await fetchCheckRunsRest(
        exec,
        cwd,
        result.repo,
        result.sha,
      );
      if (!checksFetch.ok) {
        result.ok = false;
        result.stage = "check-runs";
        result.error = checksFetch.error;
        item.settled = true;
        if (!noWait) emit(formatPrLine(result), { ok: false, isError: true });
        continue;
      }

      const evaluation = evaluateCheckRuns(checksFetch.checkRuns);
      applyEvaluation(result, evaluation);

      if (noWait) {
        result.ok = evaluation.ok;
        result.stage = evaluation.ok ? "passed" : "check-runs";
        result.error = evaluation.ok ? null : evaluation.reason;
        item.settled = true;
        continue;
      }

      if (evaluation.total === 0) {
        item.registerPolls += 1;
        if (item.registerPolls >= registerAttempts) {
          result.ok = false;
          result.stage = "register";
          result.error = `no check runs registered for PR #${result.pr} (${result.sha.slice(0, 12)}) after ${registerAttempts} attempt(s)`;
          item.settled = true;
          emit(formatPrLine(result), { ok: false, isError: true });
        }
        continue;
      }

      if (evaluation.pending.length === 0) {
        result.ok = evaluation.ok;
        result.stage = evaluation.ok ? "passed" : "check-runs";
        result.error = evaluation.ok ? null : evaluation.reason;
        item.settled = true;
        emit(formatPrLine(result), {
          ok: result.ok,
          isError: !result.ok,
        });
        continue;
      }

      if (failFast && evaluation.failed.length > 0) {
        result.ok = false;
        result.stage = "check-runs";
        result.error = evaluation.reason;
        item.settled = true;
        emit(formatPrLine(result), { ok: false, isError: true });
      }
    }

    const active = states.filter((s) => !s.settled);
    if (active.length === 0) {
      break;
    }

    if (maxWait !== null && elapsedSeconds >= maxWait) {
      for (const item of active) {
        const { result } = item;
        result.ok = false;
        result.stage = "timeout";
        const pendingNames = result.pendingChecks
          .map((c) => `${c.name}=${c.status}`)
          .join(", ");
        result.error = pendingNames
          ? `timed out after ${maxWait}s with incomplete checks (${pendingNames})`
          : `timed out after ${maxWait}s waiting for check runs`;
        item.settled = true;
        emit(formatPrLine(result), { ok: false, isError: true });
      }
      break;
    }

    const allWaitingRegistration = active.every(
      (s) => s.result.totalChecks === 0,
    );
    let nextSleep = allWaitingRegistration ? registerDelay : interval;
    if (maxWait !== null && elapsedSeconds + nextSleep > maxWait) {
      nextSleep = Math.max(0, maxWait - elapsedSeconds);
    }

    if (nextSleep > 0) {
      await sleep(nextSleep * 1000);
      elapsedSeconds += nextSleep;
    } else if (maxWait !== null) {
      elapsedSeconds = maxWait;
    }
  }

  const results = states.map((s) => s.result);
  if (results.length === 1) {
    return results[0];
  }

  const passedPrs = results.filter((r) => r.ok).length;
  const failedPrs = results.length - passedPrs;
  return {
    ok: failedPrs === 0,
    noWait,
    totalPrs: results.length,
    passedPrs,
    failedPrs,
    prs: results,
  };
}

export async function waitCi(options = {}, deps = {}) {
  if (Array.isArray(options.prs) && options.prs.length > 0) {
    return waitPrs(options, deps);
  }

  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? defaultSleep;
  const cwd = deps.cwd;

  const noWait = Boolean(options.noWait);
  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  const interval = options.interval ?? DEFAULT_INTERVAL_SECONDS;
  const registerAttempts =
    options.registerAttempts ?? DEFAULT_REGISTER_ATTEMPTS;
  const registerDelay = options.registerDelay ?? DEFAULT_REGISTER_DELAY_SECONDS;

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

  if (noWait) {
    const checksFetch = await fetchCheckRunsRest(exec, cwd, repo, sha);
    if (!checksFetch.ok) {
      return {
        ok: false,
        stage: "check-runs",
        repo,
        sha,
        workflow,
        runId: null,
        registerAttemptsUsed: 0,
        watchExitCode: null,
        noWait: true,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: [],
        pendingChecks: [],
        error: checksFetch.error,
      };
    }
    const evaluation = evaluateCheckRuns(checksFetch.checkRuns);
    return {
      ok: evaluation.ok,
      stage: evaluation.ok ? "passed" : "check-runs",
      repo,
      sha,
      workflow,
      runId: null,
      registerAttemptsUsed: 0,
      watchExitCode: null,
      noWait: true,
      totalChecks: evaluation.total,
      passedChecks: evaluation.passed.length,
      failedChecks: evaluation.failed,
      pendingChecks: evaluation.pending,
      error: evaluation.ok ? null : evaluation.reason,
    };
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
  const checksFetch = await fetchCheckRunsRest(exec, cwd, repo, sha);
  if (!checksFetch.ok) {
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
      error: checksFetch.error,
    };
  }

  const evaluation = evaluateCheckRuns(checksFetch.checkRuns);
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
  if (Array.isArray(result.prs)) {
    const lines = result.prs.map((pr) => formatPrLine(pr));
    if (result.ok) {
      lines.push(
        `BATCH PASS: ${result.passedPrs}/${result.totalPrs} PRs passed`,
      );
    } else {
      const failedNums = result.prs
        .filter((pr) => !pr.ok)
        .map((pr) => `#${pr.pr}`)
        .join(", ");
      lines.push(
        `BATCH FAIL: ${result.passedPrs}/${result.totalPrs} PRs passed, ${result.failedPrs} failed (${failedNums})`,
      );
    }
    return lines.join("\n");
  }

  if (result.pr != null) {
    return formatPrLine(result);
  }

  const shortSha = result.sha ? result.sha.slice(0, 12) : "unknown";
  if (result.ok) {
    if (result.noWait) {
      return `PASS: ${result.repo}@${shortSha} (snapshot) — ${result.passedChecks}/${result.totalChecks} check runs passed`;
    }
    return `PASS: ${result.repo}@${shortSha} (${result.workflow} run ${result.runId}) — ${result.passedChecks}/${result.totalChecks} check runs passed`;
  }

  const lines = [];
  if (result.repo && result.sha && result.runId) {
    lines.push(
      `FAIL: ${result.repo}@${shortSha} (${result.workflow} run ${result.runId}) — ${result.error}`,
    );
  } else if (result.repo && result.sha && result.noWait) {
    lines.push(`FAIL: ${result.repo}@${shortSha} (snapshot) — ${result.error}`);
  } else {
    lines.push(`FAIL [${result.stage}]: ${result.error}`);
  }

  for (const check of result.failedChecks ?? []) {
    lines.push(
      `  - ${check.name}: ${check.status} (${check.conclusion ?? "null"})`,
    );
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

  const isPrWaitMode = parsed.prs.length > 0 && !parsed.noWait;
  let emittedCount = 0;
  const effectiveDeps =
    isPrWaitMode && !parsed.json
      ? {
          ...deps,
          onProgress: (line, meta = {}) => {
            emittedCount += 1;
            if (meta.isError) {
              writeErr(`${line}\n`);
            } else {
              writeOut(`${line}\n`);
            }
            if (typeof deps.onProgress === "function") {
              deps.onProgress(line, meta);
            }
          },
        }
      : deps;

  const result = await waitCi(parsed, effectiveDeps);

  if (parsed.json) {
    writeOut(`${JSON.stringify(result, null, 2)}\n`);
  } else if (isPrWaitMode && emittedCount > 0) {
    if (Array.isArray(result.prs)) {
      if (result.ok) {
        writeOut(
          `BATCH PASS: ${result.passedPrs}/${result.totalPrs} PRs passed\n`,
        );
      } else {
        const failedNums = result.prs
          .filter((pr) => !pr.ok)
          .map((pr) => `#${pr.pr}`)
          .join(", ");
        writeErr(
          `BATCH FAIL: ${result.passedPrs}/${result.totalPrs} PRs passed, ${result.failedPrs} failed (${failedNums})\n`,
        );
      }
    }
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
