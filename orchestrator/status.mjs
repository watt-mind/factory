#!/usr/bin/env bun
/**
 * At-a-glance status for the configured repository containing cwd.
 *
 *   factory status
 *   factory status --repo legalease
 *   factory status --json
 *
 * Read-only: refreshes remote refs, reads the live factory queue, and, when
 * configured, fetches the public deployment metadata endpoint.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfigYaml } from "../lib/schedule.mjs";
import { loadQueueConfig, fetchQueueSummaries } from "../lib/queue-summary.mjs";
import { recommendNext } from "../lib/next-recommend.mjs";
import {
  formatAge,
  deployedRevision,
  deploymentState,
  metadataUrl,
  resolveStatusBranches,
} from "../lib/repo-status.mjs";
import { latestReaperRunMs } from "./reaper.mjs";

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};
const JSON_OUT = argv.includes("--json");
const explicitRepo = val("--repo");
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const expand = (p) => p?.replace(/^~/, homedir());
const quoteArg = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
const sh = (args, cwd) => {
  const result = Bun.spawnSync({
    cmd: args,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
};

function normalizeGitRemote(raw) {
  if (!raw) return null;
  return raw
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/(?:www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .trim();
}

function gitRemote(cwd) {
  return normalizeGitRemote(
    sh(["git", "config", "--get", "remote.origin.url"], cwd).out,
  );
}

function checkoutMatchesRepo(
  repo,
  checkoutRoot,
  fallbackRemote = gitRemote(checkoutRoot),
) {
  const roots = [repo.path, repo.worktree_root].map(expand).filter(Boolean);
  const byPath = roots.some(
    (root) => checkoutRoot === root || checkoutRoot.startsWith(`${root}/`),
  );
  if (byPath) return true;
  if (!fallbackRemote || !repo.github) return false;
  return normalizeGitRemote(repo.github) === fallbackRemote;
}

function configuredRepo() {
  const cfg = loadConfigYaml("repos");
  const repos = cfg.repos ?? [];

  if (explicitRepo) {
    return repos.find((r) => r.name === explicitRepo) ?? null;
  }

  const cwd = process.cwd();
  const cwdTop = sh(["git", "rev-parse", "--show-toplevel"], cwd).out;
  const cwdRemote = gitRemote(cwd);

  const byPath = repos.find((r) => checkoutMatchesRepo(r, cwdTop, cwdRemote));
  if (byPath) return byPath;

  return repos.find((r) => normalizeGitRemote(r.github) === cwdRemote) ?? null;
}

function recommendationDto(plan, seen = new WeakSet()) {
  if (!plan || typeof plan !== "object") return null;
  if (seen.has(plan)) return null;
  seen.add(plan);
  return {
    repo: plan.repo,
    command: plan.command,
    args: plan.args,
    reason: plan.reason,
    constraint: plan.constraint,
    stage: plan.stage,
    exec: plan.exec,
    alternates: Array.isArray(plan.alternates)
      ? plan.alternates.map((a) => recommendationDto(a, seen)).filter(Boolean)
      : [],
  };
}

function recommendedCommand(plan, repoName) {
  if (!plan || typeof plan !== "object") return null;
  if (plan.exec) return plan.exec;

  if (plan.command === "tick")
    return `bun orchestrator/tick.mjs --repo ${quoteArg(repoName)} --apply`;
  if (plan.command === "reconcile")
    return `bun orchestrator/reconcile.mjs --repo ${quoteArg(repoName)} --apply`;
  if (plan.command === "digest")
    return `bun orchestrator/digest.mjs --repo ${quoteArg(repoName)}`;
  if (plan.command?.startsWith("factory-")) {
    const args = plan.args ? ` --args ${quoteArg(plan.args)}` : "";
    const readOnly = new Set([
      "factory-triage",
      "factory-unblock",
      "factory-sweep",
    ]).has(plan.command);
    const readOnlyFlag = readOnly ? " --read-only" : "";
    return `factory run --repo ${quoteArg(repoName)} --command ${plan.command}${args}${readOnlyFlag}`.trim();
  }
  return null;
}

function factoryQueueAvailability(config) {
  if (config.report_only) return "report-only repository";
  if (!config.team || !config.project)
    return "missing linear team/project configuration";
  return null;
}

// Resolve before doing network work so an unmapped cwd fails with an actionable message.
const repoConfig = configuredRepo();
if (!repoConfig) {
  const names =
    loadConfigYaml("repos")
      .repos?.map((r) => r.name)
      .join(", ") ?? "";
  console.error(
    `no configured repository for cwd${explicitRepo ? ` --repo ${explicitRepo}` : ""} — pass --repo <name>`,
  );
  if (!explicitRepo && names) console.error(`known repositories: ${names}`);
  process.exit(2);
}
const configuredPath = expand(repoConfig.path);
const cwdTop = sh(["git", "rev-parse", "--show-toplevel"], process.cwd()).out;
const repoPath =
  cwdTop && checkoutMatchesRepo(repoConfig, cwdTop, gitRemote(cwdTop))
    ? cwdTop
    : configuredPath;
if (!existsSync(repoPath)) {
  console.error(`configured path does not exist: ${repoPath}`);
  process.exit(2);
}

const { baseBranch, deployBranch, metadataBranch } =
  resolveStatusBranches(repoConfig);
const fetchResult = sh(
  [
    "git",
    "fetch",
    "--quiet",
    "origin",
    ...new Set([baseBranch, deployBranch, metadataBranch].filter(Boolean)),
  ],
  repoPath,
);
const branch =
  sh(["git", "branch", "--show-current"], repoPath).out || "(detached)";
const head = sh(["git", "rev-parse", "HEAD"], repoPath).out || null;
const dirty = sh(["git", "status", "--porcelain"], repoPath)
  .out.split("\n")
  .filter(Boolean);

function remoteRef(name) {
  // Cached origin refs are not trustworthy when refresh failed: reporting a
  // stale deployment as current is worse than reporting it unknown.
  if (!fetchResult.ok)
    return {
      branch: name,
      sha: null,
      checkoutAhead: null,
      checkoutBehind: null,
    };
  const sha = sh(["git", "rev-parse", `origin/${name}`], repoPath).out || null;
  const aheadBehind =
    head && sha
      ? sh(
          [
            "git",
            "rev-list",
            "--left-right",
            "--count",
            `HEAD...origin/${name}`,
          ],
          repoPath,
        )
          .out.split(/\s+/)
          .map(Number)
      : [];
  return {
    branch: name,
    sha,
    checkoutAhead: aheadBehind[0] ?? null,
    checkoutBehind: aheadBehind[1] ?? null,
  };
}
const base = remoteRef(baseBranch);
const deploy = deployBranch ? remoteRef(deployBranch) : null;
const metadataRef =
  metadataBranch === deployBranch && deploy
    ? deploy
    : metadataBranch === baseBranch
      ? base
      : remoteRef(metadataBranch);

let deployment = { configured: false, state: "not configured" };
if (repoConfig.deployment?.url) {
  const url = metadataUrl(repoConfig.deployment.url);
  deployment = {
    configured: true,
    url,
    branch: metadataBranch,
    state: "unknown",
  };
  if (!fetchResult.ok)
    deployment.error = `remote refresh failed: ${fetchResult.err || "unknown error"}`;
  try {
    if (!fetchResult.ok) throw new Error(deployment.error);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      deployment.error = `HTTP ${response.status}`;
    } else {
      const payload = await response.json();
      const revision = deployedRevision(
        payload,
        repoConfig.deployment.revision_field,
      );
      deployment.payload = payload;
      deployment.revision = revision?.value ?? null;
      deployment.revisionField = revision?.field ?? null;
      const contains =
        revision?.value && metadataRef.sha
          ? sh(
              [
                "git",
                "merge-base",
                "--is-ancestor",
                revision.value,
                `origin/${metadataBranch}`,
              ],
              repoPath,
            ).ok
          : null;
      Object.assign(
        deployment,
        deploymentState({
          deployed: revision?.value,
          remoteSha: metadataRef.sha,
          localContains: contains,
        }),
      );
    }
  } catch (error) {
    deployment.error = error.message;
  }
}

function latestJanitorRunMs(repo) {
  const dir = path.join(homedir(), ".factory/logs");
  let latest = null;
  try {
    for (const name of readdirSync(dir)) {
      if (
        !new RegExp(
          `^janitor-${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}-\\d{6}\\.log$`,
        ).test(name)
      )
        continue;
      const at = statSync(path.join(dir, name)).mtimeMs;
      if (latest === null || at > latest) latest = at;
    }
  } catch {
    /* no logs yet */
  }
  return latest;
}

// Keep this file set aligned with run_log_total_bytes in bin/worktree-common.sh:
// active *.log files plus every numbered archive (*.log.[0-9]*). A missing run
// directory is normal before the live stack has ever been started.
function liveStackLogBytes() {
  // Honour the same override bin/live-stack.sh uses for its run directory.
  const runDir =
    process.env.FACTORY_RUN_DIR || path.join(homedir(), ".factory", "run");
  let total = 0;
  try {
    for (const name of readdirSync(runDir)) {
      if (!/\.log(?:\.[0-9].*)?$/.test(name)) continue;
      try {
        const stat = statSync(path.join(runDir, name));
        if (stat.isFile()) total += stat.size;
      } catch {
        // A daemon may rotate or remove a log between readdir and stat.
      }
    }
  } catch {
    // No live stack run directory yet.
  }
  return total;
}

const { repos, defaultCap } = loadQueueConfig([repoConfig.name]);
let queue = null,
  next = null,
  queueError = null;
const queueUnavailable = factoryQueueAvailability(repoConfig);
if (!queueUnavailable) {
  try {
    queue = (await fetchQueueSummaries(repos, defaultCap))[0] ?? null;
    if (queue) next = recommendationDto(recommendNext(queue));
  } catch (error) {
    queueError = error.message;
  }
}

const output = {
  repo: repoConfig.name,
  path: repoPath,
  configuredPath,
  github: repoConfig.github,
  reportOnly: !!repoConfig.report_only,
  checkout: { branch, head, dirtyFiles: dirty.length },
  fetch: fetchResult.ok ? null : fetchResult.err,
  branches: { base, deploy },
  deployment,
  maintenance: {
    reaperLastRun: latestReaperRunMs(),
    janitorLastRun: latestJanitorRunMs(repoConfig.name),
  },
  liveStack: { logBytes: liveStackLogBytes() },
  factory: queueUnavailable
    ? {
        available: false,
        reason: queueUnavailable,
        queue: null,
        next: null,
        error: null,
      }
    : queue
      ? { available: true, queue, next }
      : {
          available: false,
          reason: queueError ?? "unknown error",
          queue: null,
          next: null,
          error: queueError,
        },
};

if (JSON_OUT) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

console.log(c.bold(`\nfactory status — ${repoConfig.name}`));
console.log(
  c.dim(`${repoPath}${repoConfig.report_only ? "  · report-only" : ""}`),
);
console.log(
  `\nCheckout   ${branch}  ${(head ?? "unknown").slice(0, 12)}  ${dirty.length ? c.yellow(`${dirty.length} changed file(s)`) : c.green("clean")}`,
);
for (const [label, ref] of [
  ["Base", base],
  ["Deploy", deploy],
]) {
  if (!ref) {
    console.log(`${label.padEnd(10)} ${c.dim("not configured")}`);
    continue;
  }
  const delta =
    ref.checkoutAhead == null
      ? "unavailable"
      : `checkout +${ref.checkoutAhead}/-${ref.checkoutBehind}`;
  console.log(
    `${label.padEnd(10)} origin/${ref.branch}  ${(ref.sha ?? "unavailable").slice(0, 12)}  ${c.dim(delta)}`,
  );
}
console.log(
  `\nDeployment ${deployment.configured ? deployment.url : c.dim("not configured")}`,
);
if (deployment.configured) {
  console.log(c.dim(`  comparing with origin/${deployment.branch}`));
  if (deployment.revision)
    console.log(
      `  ${deployment.revisionField}  ${deployment.revision.slice(0, 12)}`,
    );
  const color =
    deployment.state === "current"
      ? c.green
      : ["stale", "diverged", "different"].includes(deployment.state)
        ? c.yellow
        : c.red;
  console.log(
    `  ${color(deployment.state)} — ${deployment.message ?? deployment.error ?? "could not fetch endpoint"}`,
  );
}

const factoryStatus = output.factory;
console.log(
  `\nMaintenance  reaper ${formatAge(output.maintenance.reaperLastRun)}  ·  janitor ${formatAge(output.maintenance.janitorLastRun)}`,
);
console.log(
  `Live stack   ${(output.liveStack.logBytes / (1024 * 1024)).toFixed(1)} MiB of logs`,
);
console.log(c.bold("\nFactory now:"));

if (!factoryStatus.available) {
  console.log(c.red(`  queue unavailable — ${factoryStatus.reason}`));
} else if (queue) {
  console.log(
    `  Triage ${queue.triageState} · Todo ${queue.todoNotReady} · Ready ${queue.ready} · In progress ${queue.inProgress} · Review ${queue.inReview} · Blocked ${queue.blocked}`,
  );
  const command = next.command
    ? `${next.command}${next.args ? ` ${next.args}` : ""}`
    : "(wait)";
  console.log(`  Next ${c.green(command)} — ${next.reason}`);

  const suggested = recommendedCommand(next, repoConfig.name);
  console.log(c.bold("\nSuggested action:"));
  if (suggested) {
    console.log(`  ${c.green(suggested)} — ${next.reason}.`);
  } else {
    const waitExplanation = {
      capacity:
        "Workers are already at capacity; let an active ticket finish before dispatching another.",
      "path collision":
        "Ready tickets overlap paths with active work; wait rather than create a conflicting worktree.",
      report_only:
        "This repository is intentionally report-only until its safe worktree lifecycle exists.",
      idle: "No ticket needs action right now; re-run after a branch, deploy, or ticket changes.",
    };
    const alternate =
      waitExplanation[next?.constraint] ??
      "No safe factory command is applicable yet; re-run after the state changes.";
    console.log(`  ${c.dim(alternate)}`);
  }
} else {
  console.log(c.red(`  queue unavailable — ${queueError ?? "unknown error"}`));
}

console.log(
  c.dim(
    "  `factory status --json` is available for scripts; this view is the human-facing hub.",
  ),
);
console.log();
