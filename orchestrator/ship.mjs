#!/usr/bin/env bun
/**
 * Release pre-flight, and the publish → reconcile → pin chain (WM-1104).
 *
 *   bun orchestrator/ship.mjs preflight --repo legalease [--json] [--no-fetch]
 *   bun orchestrator/ship.mjs chain --repo legalease --until pin [--apply]
 *
 * Shipping legalease on 2026-09-15 took ~2.5h of an agent re-deriving, from
 * `ci.yml` and memory, a sequence that is entirely mechanical: a fully green
 * base run for the exact tip, then — because `docker/agent/**` had moved since
 * the pinned case-agent commit — a publisher dispatch, a reconcile PR, a pin
 * merge, another green base run, and only then the release PR. Every step of
 * that is a question about state a machine can read. This module reads it.
 *
 * `preflight` answers one question: is the base tip shippable right now? It
 * never writes. Each check prints PASS / FAIL / SKIP and, on FAIL, the exact
 * command that fixes it; the process exits 0 only when nothing failed.
 *
 * `chain` drives the loop the operator ran by hand. It is a dry run unless
 * `--apply` is passed: without it the chain prints the plan and makes no
 * mutating call at all.
 *
 * House shape (docs/event-runtime-conventions.md): the decisions are pure
 * functions over plain data, the effects arrive in a trailing options object
 * (`forge`, `git`, `shell`, `readManifest`, `now`, `sleep`), and nothing here
 * spawns `gh` — reads and writes both go through the Forge connector, so the
 * tests run on fixtures with no network, no clock and no checkout.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { resolveConfigPath } from "../event-runtime/lib/config.mjs";
import { loadForge } from "../lib/forge/index.mjs";
import { ROOT } from "../lib/schedule.mjs";

/** Bot pin-PR identity, overridable per repo with `pin_pr:`. */
export const DEFAULT_PIN_PR = Object.freeze({
  author: "app/watt-mind-factory",
  titlePrefix: "chore(runtime)",
});

/** The label that marks a PR a human still has to decide on. */
export const ESCALATED_LABEL = "escalated";

/** Conclusions that do not block a release. */
const NON_BLOCKING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

const PR_FIELDS = [
  "number",
  "title",
  "url",
  "author",
  "labels",
  "baseRefName",
  "headRefName",
  "headRefOid",
];

/** Thrown when the repo's ship configuration cannot be used as written. */
export class ShipConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShipConfigError";
  }
}

/** Thrown when the chain cannot continue (timeout, refused merge, red base). */
export class ShipChainError extends Error {
  constructor(message, { next = null } = {}) {
    super(message);
    this.name = "ShipChainError";
    this.next = next;
  }
}

const expandHome = (p) =>
  typeof p === "string" && p.startsWith("~/")
    ? path.join(homedir(), p.slice(2))
    : p;

const asList = (value, what) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v))
    throw new ShipConfigError(`${what} must be a list of non-empty strings`);
  return [...value];
};

/**
 * Read one repo's ship configuration out of `config/repos.yaml` (falling back
 * to the tracked example, as every other config reader does). `config` lets a
 * caller — the tests, and `chain` reusing a parsed tree — supply the parsed
 * YAML instead of touching the filesystem.
 */
export function loadShipConfig(name, { root = ROOT, config } = {}) {
  const parsed =
    config ??
    Bun.YAML.parse(readFileSync(resolveConfigPath("repos", { root }), "utf8"));
  const entry = (parsed?.repos ?? []).find((repo) => repo?.name === name);
  if (!entry) throw new ShipConfigError(`no repo named "${name}" configured`);
  if (!entry.github)
    throw new ShipConfigError(`repo ${name} has no github remote configured`);
  if (!entry.base)
    throw new ShipConfigError(`repo ${name} has no base branch configured`);

  const roles = (entry.runtime_roles ?? []).map((role, index) => {
    const where = `repo ${name} runtime_roles[${index}]`;
    if (!role?.role) throw new ShipConfigError(`${where} needs a role key`);
    if (!role.manifest)
      throw new ShipConfigError(`${where} needs a manifest path`);
    if (!role.publisher_workflow)
      throw new ShipConfigError(`${where} needs a publisher_workflow`);
    return {
      role: role.role,
      manifest: role.manifest,
      publisherWorkflow: role.publisher_workflow,
      paths: asList(role.paths, `${where}.paths`),
      // A role built in another repository (legalease pins lawz's research
      // runner) has no commit this checkout can reason about. Say so rather
      // than answering an ancestry question about a foreign history.
      sourceRepo: role.source_repo ?? null,
    };
  });

  return {
    name,
    github: entry.github,
    path: expandHome(entry.path) ?? null,
    base: entry.base,
    deployBranch: entry.deploy_branch ?? null,
    ciWorkflow: entry.merge_ci?.workflow ?? "CI",
    advisoryJobs: asList(entry.advisory_jobs, `repo ${name} advisory_jobs`),
    serialPublishers: entry.serial_publishers === true,
    pinPr: {
      author: entry.pin_pr?.author ?? DEFAULT_PIN_PR.author,
      titlePrefix: entry.pin_pr?.title_prefix ?? DEFAULT_PIN_PR.titlePrefix,
    },
    sshProbe: entry.ssh_probe ?? null,
    postReleaseChecks: asList(
      entry.post_release_checks,
      `repo ${name} post_release_checks`,
    ),
    runtimeRoles: roles,
  };
}

// ---------------------------------------------------------------- decisions

/** `app/watt-mind-factory`, `watt-mind-factory[bot]` and `watt-mind-factory`. */
export function normalizeAuthor(author) {
  const login =
    typeof author === "string" ? author : (author?.login ?? author?.name ?? "");
  return String(login)
    .trim()
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
}

export function isPinPr(pr, pinPr = DEFAULT_PIN_PR) {
  return (
    normalizeAuthor(pr?.author) === normalizeAuthor(pinPr.author) &&
    String(pr?.title ?? "").startsWith(pinPr.titlePrefix)
  );
}

export function isEscalatedPr(pr, base) {
  return (
    pr?.baseRefName === base &&
    (pr?.labels ?? []).some(
      (label) => String(label?.name ?? label).toLowerCase() === ESCALATED_LABEL,
    )
  );
}

/**
 * The verdict for a commit is its newest run of the CI workflow, not the
 * newest run that happens to be listed: a re-push cancels the previous run and
 * the stale one reads as red (the "superseded runs look red" trap). Attempts
 * of the same run sort after run numbers.
 */
export function selectRun(runs, { workflow }) {
  const wanted = String(workflow ?? "").toLowerCase();
  const matches = (run) => {
    const name = String(run?.name ?? "").toLowerCase();
    const file = String(run?.path ?? "").toLowerCase();
    return name === wanted || file === wanted || file.endsWith(`/${wanted}`);
  };
  const ordered = (Array.isArray(runs) ? runs : [])
    .filter(matches)
    .sort(
      (a, b) =>
        (b.run_number ?? 0) - (a.run_number ?? 0) ||
        (b.run_attempt ?? 0) - (a.run_attempt ?? 0),
    );
  return ordered[0] ?? null;
}

/**
 * Split a run's jobs into what blocks a release and what does not.
 *
 * Deviation from WM-1104's literal "every non-advisory job success": a job
 * that is legitimately skipped (`deploy-prod` never runs on develop) can never
 * report success, so requiring it would make the check unpassable. A job
 * skipped because its dependency failed is still caught — through the
 * dependency, which is `failure`.
 */
export function classifyJobs(jobs, { advisoryJobs = [] } = {}) {
  const advisory = new Set(advisoryJobs);
  const out = {
    passed: [],
    skipped: [],
    failing: [],
    pending: [],
    advisory: [],
  };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const name = job?.name ?? "(unnamed job)";
    const conclusion = String(job?.conclusion ?? "").toLowerCase();
    const completed = String(job?.status ?? "").toLowerCase() === "completed";
    if (advisory.has(name)) {
      out.advisory.push(name);
      continue;
    }
    if (!completed) {
      out.pending.push(name);
      continue;
    }
    if (conclusion === "success") out.passed.push(name);
    else if (NON_BLOCKING_CONCLUSIONS.has(conclusion)) out.skipped.push(name);
    else out.failing.push(`${name} (${conclusion || "no conclusion"})`);
  }
  return out;
}

/**
 * Whether a commit's check runs permit a merge. This — not a `gh run watch`
 * exit status — is the merge gate: a watched workflow can exit 0 while another
 * check run on the same head is red, which is how a red PR got merged once.
 */
export function checkRunsGreen(checkRuns) {
  const pending = [];
  const failing = [];
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    const name = run?.name ?? "(unnamed check)";
    const conclusion = String(run?.conclusion ?? "").toLowerCase();
    if (String(run?.status ?? "").toLowerCase() !== "completed") {
      pending.push(name);
    } else if (!NON_BLOCKING_CONCLUSIONS.has(conclusion)) {
      failing.push(`${name} (${conclusion || "no conclusion"})`);
    }
  }
  return { ok: !pending.length && !failing.length, pending, failing };
}

/**
 * The source commit a manifest role is pinned to. `provenance.commit_sha` is
 * the publisher's own receipt and wins; `reviewed_commit` and a `tag` that
 * ends in a full SHA (`develop-<sha>`) are the documented fallbacks.
 */
export function pinnedCommit(entry) {
  const candidates = [
    entry?.provenance?.commit_sha,
    entry?.reviewed_commit,
    entry?.tag,
  ];
  for (const candidate of candidates) {
    const sha = /([0-9a-f]{40})$/i.exec(String(candidate ?? ""))?.[1];
    if (sha) return sha.toLowerCase();
  }
  return null;
}

// ------------------------------------------------------------------ effects

const runCommand = (cmd, args, opts = {}) => {
  const r =
    spawnSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    }) ?? {};
  return {
    status: r.status ?? r.exitCode ?? null,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
};

/** Default effects. Every one of them is replaceable by a test. */
export function defaultDeps({ cwd } = {}) {
  return {
    forge: loadForge(),
    git: (args, opts = {}) => runCommand("git", args, { cwd, ...opts }),
    shell: (command, opts = {}) =>
      runCommand("bash", ["-lc", command], { cwd, ...opts }),
    readManifest: (file) =>
      JSON.parse(readFileSync(path.join(cwd, file), "utf8")),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

const json = (forge, apiPath) => JSON.parse(forge.apiRaw(apiPath));

const runsForSha = (forge, repo, sha) =>
  json(forge, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)
    ?.workflow_runs ?? [];

const jobsForRun = (forge, repo, runId) =>
  json(forge, `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)?.jobs ??
  [];

const checkRunsForSha = (forge, repo, sha) =>
  json(forge, `repos/${repo}/commits/${sha}/check-runs?per_page=100`)
    ?.check_runs ?? [];

const activeRuns = (forge, repo) => [
  ...(json(forge, `repos/${repo}/actions/runs?status=in_progress&per_page=100`)
    ?.workflow_runs ?? []),
  ...(json(forge, `repos/${repo}/actions/runs?status=queued&per_page=100`)
    ?.workflow_runs ?? []),
];

const openPrs = (forge, repo) =>
  forge.prList(repo, { state: "open", limit: 100, fields: PR_FIELDS });

/** Resolve the base tip. A failed fetch is reported, never assumed clean. */
export function resolveTip(cfg, { git, fetch = true }) {
  // null = not attempted (--no-fetch), true = refreshed, false = tried and
  // failed. A failed fetch is reported, never quietly read as "not behind".
  let fetched = fetch ? true : null;
  let fetchError = null;
  if (fetch) {
    const r = git(["fetch", "--quiet", "origin", cfg.base]);
    if (r.status !== 0) {
      fetched = false;
      fetchError = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
    }
  }
  const r = git(["rev-parse", `origin/${cfg.base}`]);
  if (r.status !== 0) {
    throw new ShipConfigError(
      `could not resolve origin/${cfg.base} in ${cfg.path}: ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return { sha: r.stdout.trim(), fetched, fetchError };
}

// ----------------------------------------------------------------- checks

const pass = (id, title, detail) => ({ id, title, status: "pass", detail });
const fail = (id, title, detail, next = null) => ({
  id,
  title,
  status: "fail",
  detail,
  next,
});
const skip = (id, title, detail) => ({ id, title, status: "skip", detail });

/** Run one check, turning any adapter failure into a FAIL rather than a crash. */
function guarded(id, title, next, body) {
  try {
    return body();
  } catch (err) {
    return fail(id, title, `could not be determined: ${err.message}`, next);
  }
}

export function checkBaseGreen(cfg, tip, { forge }) {
  const id = "base-green";
  const title = `${cfg.base} tip fully green`;
  const next = `gh run list --workflow ${cfg.ciWorkflow} --commit ${tip} --repo ${cfg.github}`;
  return guarded(id, title, next, () => {
    const run = selectRun(runsForSha(forge, cfg.github, tip), {
      workflow: cfg.ciWorkflow,
    });
    if (!run)
      return fail(
        id,
        title,
        `no ${cfg.ciWorkflow} run for ${tip.slice(0, 8)} — the tip has never been built`,
        next,
      );
    if (String(run.status).toLowerCase() !== "completed")
      return fail(
        id,
        title,
        `run ${run.id} is ${run.status} — wait for it`,
        `gh run watch ${run.id} --repo ${cfg.github} --exit-status --interval 60`,
      );
    const jobs = classifyJobs(jobsForRun(forge, cfg.github, run.id), cfg);
    const summary = `run ${run.id}: ${jobs.passed.length} success, ${jobs.skipped.length} skipped, ${jobs.advisory.length} advisory`;
    if (jobs.failing.length || jobs.pending.length)
      return fail(
        id,
        title,
        `${summary}; blocking: ${[...jobs.failing, ...jobs.pending.map((j) => `${j} (incomplete)`)].join(", ")}`,
        `gh run view ${run.id} --repo ${cfg.github} --log-failed`,
      );
    return pass(id, title, summary);
  });
}

export function checkRuntimeRole(cfg, tip, role, { git, readManifest }) {
  const id = `runtime-pin:${role.role}`;
  const title = `runtime pin ${role.role} fresh`;
  const next = `gh workflow run ${role.publisherWorkflow} --repo ${cfg.github} --ref ${cfg.base} -f commit_sha=${tip}`;
  return guarded(id, title, next, () => {
    if (role.sourceRepo && role.sourceRepo !== cfg.github)
      return skip(
        id,
        title,
        `built from ${role.sourceRepo}; its pinned commit is not in this history, so freshness is that repo's publisher to prove`,
      );
    const manifest = readManifest(role.manifest);
    const pinned = pinnedCommit(manifest?.[role.role]);
    if (!pinned)
      return fail(
        id,
        title,
        `${role.manifest} has no commit for role ${role.role} (looked at provenance.commit_sha, reviewed_commit, tag)`,
        next,
      );
    if (git(["merge-base", "--is-ancestor", pinned, tip]).status !== 0)
      return fail(
        id,
        title,
        `pinned ${pinned.slice(0, 8)} is not an ancestor of ${tip.slice(0, 8)} — the pin points off this branch`,
        next,
      );
    if (!role.paths.length)
      return skip(
        id,
        title,
        `pinned ${pinned.slice(0, 8)} is an ancestor; no paths configured, so staleness is unproven`,
      );
    const diff = git([
      "diff",
      "--name-only",
      `${pinned}..${tip}`,
      "--",
      ...role.paths,
    ]);
    if (diff.status !== 0)
      return fail(
        id,
        title,
        `git diff ${pinned.slice(0, 8)}..${tip.slice(0, 8)} failed: ${(diff.stderr || diff.stdout).trim()}`,
        next,
      );
    const changed = diff.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (changed.length)
      return fail(
        id,
        title,
        `${changed.length} publisher path(s) changed since ${pinned.slice(0, 8)}: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}`,
        next,
      );
    return pass(
      id,
      title,
      `pinned ${pinned.slice(0, 8)}, no publisher path changed since`,
    );
  });
}

export function checkPublishersIdle(cfg, { forge }) {
  const id = "publishers-idle";
  const title = "no publisher run in progress";
  const next = `gh run list --repo ${cfg.github} --status in_progress`;
  return guarded(id, title, next, () => {
    const workflows = new Set(
      cfg.runtimeRoles.map((role) => role.publisherWorkflow),
    );
    if (!workflows.size) return skip(id, title, "no publishers configured");
    const busy = activeRuns(forge, cfg.github).filter((run) =>
      [...workflows].some((wf) => String(run?.path ?? "").endsWith(`/${wf}`)),
    );
    if (busy.length)
      return fail(
        id,
        title,
        busy
          .map((run) => `${run.name} run ${run.id} is ${run.status}`)
          .join("; "),
        `gh run watch ${busy[0].id} --repo ${cfg.github} --exit-status --interval 60`,
      );
    return pass(id, title, `${workflows.size} publisher workflow(s) idle`);
  });
}

export function checkNoPinPr(cfg, prs) {
  const id = "pin-pr";
  const title = "no open bot pin PR";
  const open = (prs ?? []).filter((pr) => isPinPr(pr, cfg.pinPr));
  if (open.length)
    return fail(
      id,
      title,
      open.map((pr) => `#${pr.number} ${pr.title}`).join("; "),
      `gh pr merge ${open[0].number} --repo ${cfg.github} --merge  # once its check runs are green`,
    );
  return pass(id, title, `none by ${cfg.pinPr.author}`);
}

export function checkNoEscalatedPr(cfg, prs) {
  const id = "escalated-pr";
  const title = `no escalated PR targeting ${cfg.base}`;
  const open = (prs ?? []).filter((pr) => isEscalatedPr(pr, cfg.base));
  if (open.length)
    return fail(
      id,
      title,
      open.map((pr) => `#${pr.number} ${pr.title}`).join("; "),
      `gh pr view ${open[0].number} --repo ${cfg.github}  # a human decides this one`,
    );
  return pass(id, title, "none");
}

export function checkSshProbe(cfg, { shell }) {
  const id = "ssh-probe";
  const title = "promotion journal clean";
  if (!cfg.sshProbe)
    return skip(id, title, "no ssh_probe configured for this repo");
  return guarded(id, title, cfg.sshProbe, () => {
    const r = shell(cfg.sshProbe);
    const out = r.stdout.trim().split("\n").pop() ?? "";
    if (r.status !== 0)
      return fail(
        id,
        title,
        `probe exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-200)}`,
        cfg.sshProbe,
      );
    if (out !== "clean")
      return fail(
        id,
        title,
        `probe printed ${JSON.stringify(out)}, expected "clean" — a foreign publisher transaction is still open`,
        cfg.sshProbe,
      );
    return pass(id, title, "clean");
  });
}

/**
 * The whole read-only verdict. Never writes, never waits.
 * @returns {{ ok: boolean, repo: string, base: string, tip: string, checks: object[] }}
 */
export function preflight(cfg, deps, { fetch = true } = {}) {
  const tip = resolveTip(cfg, { git: deps.git, fetch });
  const checks = [checkBaseGreen(cfg, tip.sha, deps)];
  for (const role of cfg.runtimeRoles)
    checks.push(checkRuntimeRole(cfg, tip.sha, role, deps));
  checks.push(checkPublishersIdle(cfg, deps));

  const prs = (() => {
    try {
      return openPrs(deps.forge, cfg.github);
    } catch (err) {
      return { error: err.message };
    }
  })();
  if (Array.isArray(prs)) {
    checks.push(checkNoPinPr(cfg, prs));
    checks.push(checkNoEscalatedPr(cfg, prs));
  } else {
    const detail = `could not list open PRs: ${prs.error}`;
    checks.push(fail("pin-pr", "no open bot pin PR", detail));
    checks.push(
      fail("escalated-pr", `no escalated PR targeting ${cfg.base}`, detail),
    );
  }
  checks.push(checkSshProbe(cfg, deps));

  return {
    repo: cfg.name,
    base: cfg.base,
    tip: tip.sha,
    fetched: tip.fetched,
    ...(tip.fetchError ? { fetchError: tip.fetchError } : {}),
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

// ------------------------------------------------------------------- chain

/** Poll `probe` until it returns something truthy, or give up loudly. */
export async function waitFor(
  probe,
  { label, timeoutMs = 45 * 60_000, intervalMs = 60_000, now, sleep },
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (now() >= deadline)
      throw new ShipChainError(
        `timed out after ${Math.round(timeoutMs / 60_000)}min waiting for ${label}`,
      );
    await sleep(intervalMs);
  }
}

const UNTIL = ["preflight", "pin", "release"];

/**
 * Drive preflight → publish → reconcile → pin → (release).
 *
 * Dry run unless `apply` — and a dry run is a *plan*, not a rehearsal: it
 * makes no mutating call and does no waiting, because there is nothing to wait
 * for when nothing was dispatched.
 */
export async function shipChain(
  cfg,
  { until = "pin", apply = false, rounds = 3, waitOpts = {} } = {},
  deps,
) {
  if (!UNTIL.includes(until))
    throw new ShipConfigError(`--until must be one of ${UNTIL.join(", ")}`);
  if (until === "release" && !cfg.deployBranch)
    throw new ShipConfigError(
      `repo ${cfg.name} has no deploy_branch — there is no release to drive`,
    );
  const { forge, now, sleep } = deps;
  const wait = { now, sleep, ...waitOpts };
  const plan = [];
  const record = (action, detail) => {
    plan.push({ action, detail, applied: apply });
    return plan[plan.length - 1];
  };

  let report = preflight(cfg, deps);
  if (until === "preflight") return { ok: report.ok, report, plan };

  for (let round = 1; !report.ok && round <= rounds; round++) {
    const failed = (predicate) =>
      report.checks.filter(
        (check) => check.status === "fail" && predicate(check),
      );
    const stale = failed((check) => check.id.startsWith("runtime-pin:"));
    const pinPrOpen = failed((check) => check.id === "pin-pr");
    const blocking = failed(
      (check) => !check.id.startsWith("runtime-pin:") && check.id !== "pin-pr",
    );
    if (blocking.length)
      throw new ShipChainError(
        `${blocking[0].title} failed: ${blocking[0].detail}`,
        { next: blocking[0].next },
      );

    // An open pin PR is not an obstacle to the chain, it *is* a step of it:
    // reconcile has already produced what a publisher dispatch would wait for.
    // Merge it (when its check runs are green) before looking at staleness,
    // since merging it moves the tip and re-dates every pin answer.
    if (pinPrOpen.length) {
      for (const pr of openPrs(forge, cfg.github).filter((candidate) =>
        isPinPr(candidate, cfg.pinPr),
      )) {
        record("merge-pin-pr", `#${pr.number} ${pr.title}`);
        if (apply) await mergeWhenGreen(cfg, pr, deps, wait);
      }
      if (!apply) break;
      report = preflight(cfg, deps);
      continue;
    }

    if (!stale.length) break;

    // One publisher at a time when they share the promotion lock; the rest
    // are picked up by the next round's preflight.
    const batch = cfg.serialPublishers ? stale.slice(0, 1) : stale;
    for (const check of batch) {
      const role = cfg.runtimeRoles.find(
        (candidate) => `runtime-pin:${candidate.role}` === check.id,
      );
      record(
        "dispatch-publisher",
        `${role.publisherWorkflow} --ref ${cfg.base} -f commit_sha=${report.tip}`,
      );
      if (!apply) continue;
      forge.workflowDispatch(cfg.github, role.publisherWorkflow, {
        ref: cfg.base,
        inputs: { commit_sha: report.tip },
      });
      await waitFor(
        () => {
          const busy = activeRuns(forge, cfg.github).some((run) =>
            String(run?.path ?? "").endsWith(`/${role.publisherWorkflow}`),
          );
          return busy ? null : true;
        },
        { label: `${role.publisherWorkflow} to finish`, ...wait },
      );
      const pinPr = await waitFor(
        () =>
          openPrs(forge, cfg.github).find((pr) => isPinPr(pr, cfg.pinPr)) ??
          null,
        { label: "the reconcile pin PR", ...wait },
      );
      record("merge-pin-pr", `#${pinPr.number} ${pinPr.title}`);
      await mergeWhenGreen(cfg, pinPr, deps, wait);
    }
    if (!apply) break;
    report = preflight(cfg, deps);
  }

  if (!report.ok && apply) report = preflight(cfg, deps);
  if (until === "pin" || !report.ok) return { ok: report.ok, report, plan };

  // ------------------------------------------------------------- release
  record(
    "open-release-pr",
    `${cfg.base} → ${cfg.deployBranch} at ${report.tip.slice(0, 8)}`,
  );
  if (!apply) {
    record(
      "merge-release-pr",
      "--merge (never squash: it wrecks the ship list)",
    );
    for (const command of cfg.postReleaseChecks)
      record("post-release-check", command);
    return { ok: report.ok, report, plan };
  }

  const existing = openPrs(forge, cfg.github).find(
    (pr) => pr.baseRefName === cfg.deployBranch && pr.headRefName === cfg.base,
  );
  const releasePr =
    existing ??
    (() => {
      const url = forge.prCreate(cfg.github, {
        base: cfg.deployBranch,
        head: cfg.base,
        title: `release: ${cfg.base} → ${cfg.deployBranch} (${new Date(now()).toISOString().slice(0, 10)})`,
        body: `Release of ${cfg.base}@${report.tip}.`,
      });
      const number = Number(url.split("/").pop());
      return openPrs(forge, cfg.github).find(
        (pr) => Number(pr.number) === number,
      );
    })();
  record("merge-release-pr", `#${releasePr.number} --merge`);
  await mergeWhenGreen(cfg, releasePr, deps, wait);

  const results = [];
  for (const command of cfg.postReleaseChecks) {
    const r = deps.shell(command);
    record("post-release-check", `${command} → exit ${r.status}`);
    results.push({
      command,
      ok: r.status === 0,
      output: (r.stdout || r.stderr).trim().slice(-400),
    });
  }
  return {
    ok: report.ok && results.every((result) => result.ok),
    report,
    plan,
    postRelease: results,
  };
}

/**
 * Merge a PR once its head commit's check runs are all success or skipped.
 * The gate is the check-run summary, never a watched run's exit status.
 */
export async function mergeWhenGreen(cfg, pr, deps, wait) {
  const { forge } = deps;
  const sha = pr.headRefOid;
  if (!sha)
    throw new ShipChainError(`PR #${pr.number} has no head SHA to check`);
  await waitFor(
    () => {
      const summary = checkRunsGreen(checkRunsForSha(forge, cfg.github, sha));
      if (summary.failing.length)
        throw new ShipChainError(
          `PR #${pr.number} has red check runs: ${summary.failing.join(", ")}`,
          { next: `gh pr checks ${pr.number} --repo ${cfg.github}` },
        );
      return summary.ok ? summary : null;
    },
    { label: `check runs on #${pr.number}`, ...wait },
  );
  forge.prMerge(cfg.github, pr.number, { method: "merge" });
}

// ------------------------------------------------------------------ output

const ICON = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

export function formatPreflight(report, { color = false } = {}) {
  const c = color
    ? {
        bold: (s) => `\x1b[1m${s}\x1b[0m`,
        dim: (s) => `\x1b[2m${s}\x1b[0m`,
        red: (s) => `\x1b[31m${s}\x1b[0m`,
        green: (s) => `\x1b[32m${s}\x1b[0m`,
        yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      }
    : {
        bold: (s) => s,
        dim: (s) => s,
        red: (s) => s,
        green: (s) => s,
        yellow: (s) => s,
      };
  const paint = { pass: c.green, fail: c.red, skip: c.yellow };
  const lines = [
    "",
    c.bold(
      `ship pre-flight: ${report.repo} (${report.base} @ ${report.tip.slice(0, 8)})`,
    ),
    "",
  ];
  for (const check of report.checks) {
    lines.push(
      `  ${paint[check.status](ICON[check.status])}  ${check.title.padEnd(34)} ${c.dim(check.detail)}`,
    );
    if (check.next) lines.push(`        ${c.bold("next:")} ${check.next}`);
  }
  if (report.fetched === false)
    lines.push(
      "",
      c.yellow(
        `  warning: git fetch failed (${report.fetchError}); the tip may be stale`,
      ),
    );
  const failed = report.checks.filter((check) => check.status === "fail");
  lines.push(
    "",
    report.ok
      ? c.green(
          `PASS — ${report.checks.length} checks, nothing blocking. The release PR may be opened.`,
        )
      : c.red(
          `FAIL — ${failed.length} of ${report.checks.length} checks blocking. Do not open the release PR.`,
        ),
    "",
  );
  return lines.join("\n");
}

export function formatChain(result, { apply }) {
  const lines = [
    "",
    `ship chain: ${result.report.repo} (${apply ? "APPLY" : "dry run — nothing was changed"})`,
    "",
  ];
  if (!result.plan.length)
    lines.push("  nothing to do — the base is shippable");
  for (const step of result.plan)
    lines.push(
      `  ${step.applied ? "did " : "would"}  ${step.action}: ${step.detail}`,
    );
  for (const check of result.postRelease ?? [])
    lines.push(`  ${check.ok ? "ok  " : "RED "}  ${check.command}`);
  lines.push(
    "",
    result.ok ? "chain complete" : "chain stopped — see the pre-flight above",
    "",
  );
  return lines.join("\n");
}

// --------------------------------------------------------------------- cli

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const usage = `usage: ship.mjs preflight --repo <name> [--json] [--no-fetch]
       ship.mjs chain --repo <name> --until <${UNTIL.join("|")}> [--apply] [--json]`;
  if (!["preflight", "chain"].includes(verb)) {
    console.error(usage);
    process.exit(2);
  }
  const repoName = val("--repo");
  if (!repoName) {
    console.error(usage);
    process.exit(2);
  }
  const asJson = argv.includes("--json");

  let cfg;
  try {
    cfg = loadShipConfig(repoName);
  } catch (err) {
    console.error(`ship: ${err.message}`);
    process.exit(2);
  }
  if (!cfg.path) {
    console.error(`ship: repo ${cfg.name} has no local path configured`);
    process.exit(2);
  }
  const deps = defaultDeps({ cwd: cfg.path });

  try {
    if (verb === "preflight") {
      const report = preflight(cfg, deps, {
        fetch: !argv.includes("--no-fetch"),
      });
      console.log(
        asJson
          ? JSON.stringify(report, null, 2)
          : formatPreflight(report, { color: process.stdout.isTTY }),
      );
      process.exit(report.ok ? 0 : 1);
    }
    const apply = argv.includes("--apply");
    const result = await shipChain(
      cfg,
      { until: val("--until") ?? "pin", apply },
      deps,
    );
    console.log(
      asJson
        ? JSON.stringify(result, null, 2)
        : formatPreflight(result.report, { color: process.stdout.isTTY }) +
            formatChain(result, { apply }),
    );
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(`ship: ${err.message}`);
    if (err.next) console.error(`next: ${err.next}`);
    process.exit(err instanceof ShipConfigError ? 2 : 1);
  }
}
