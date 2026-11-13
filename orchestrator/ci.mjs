#!/usr/bin/env bun
/**
 * Is GitHub Actions itself wasting the factory's time?
 *
 *   bun orchestrator/ci.mjs                 # every configured repo
 *   bun orchestrator/ci.mjs --repo bj29
 *   bun orchestrator/ci.mjs --since 14d     # default 14d
 *
 * friction.mjs measures agent transcripts; this measures the other clock an
 * agent waits on — the PR-checks watch in factory-merge/factory-ship sits
 * idle for however long the workflow run takes. A slow or flaky CI job costs
 * every PR that touches it, not just the run that happened to hit it, so it
 * belongs in the same "repeats across runs" bucket factory-retro already
 * applies to transcripts.
 *
 * Pulls the workflow-run list (via the Forge connector, `lib/forge/`) per
 * repo's base branch, groups by workflow name, and
 * flags two shapes:
 *   - repeat failures: a workflow that failed more than once in the window
 *   - a duration trend: the recent third of runs running meaningfully slower
 *     than the oldest third — the "slow e2e tests" case, made visible instead
 *     of felt.
 *
 * It proposes nothing on its own, same as friction.mjs — /factory-retro reads
 * this, decides what's worth fixing, and files it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/schedule.mjs";
import { loadForge } from "../lib/forge/index.mjs";

export const WORKFLOW_RUN_FIELDS = [
  "databaseId",
  "url",
  "name",
  "workflowName",
  "status",
  "conclusion",
  "createdAt",
  "startedAt",
  "updatedAt",
];

/**
 * Read workflow runs through the configured forge without making callers
 * distinguish an unavailable GitHub Actions API from an empty history.
 */
export function readWorkflowRuns({
  forge = loadForge(),
  repo,
  branch,
  created,
  limit = 200,
  timeout,
} = {}) {
  try {
    return forge.runList(repo, {
      branch,
      created,
      limit,
      fields: WORKFLOW_RUN_FIELDS,
      ...(timeout == null ? {} : { timeout }),
    });
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  const only = (val("--repo") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const JSON_OUT = argv.includes("--json");

  const sinceArg = val("--since") || "14d";
  const sinceDays = Number(sinceArg.replace(/[^\d]/g, "")) || 14;
  const sinceDate = new Date(Date.now() - sinceDays * 86400e3)
    .toISOString()
    .slice(0, 10);

  const cfg = Bun.YAML.parse(
    readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"),
  );
  const repos = (cfg.repos ?? []).filter(
    (r) => r.github && (!only.length || only.includes(r.name)),
  );

  if (!repos.length) {
    console.error(
      only.length
        ? `no repo named "${only}" in config/repos.yaml with a github remote`
        : "no repos with a github remote configured",
    );
    process.exit(2);
  }

  const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
  };

  const forge = loadForge();

  function runList(nameWithOwner, branch) {
    return readWorkflowRuns({
      forge,
      repo: nameWithOwner,
      branch,
      created: `>=${sinceDate}`,
    });
  }

  function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  const repoReports = [];

  for (const repo of repos) {
    const branch = repo.base || "main";
    const runs = runList(repo.github, branch);
    if (runs === null) {
      repoReports.push({
        repo: repo.name,
        error: "gh run list failed (no access, or repo has no Actions history)",
      });
      continue;
    }
    if (!runs.length) {
      repoReports.push({ repo: repo.name, error: null, workflows: [] });
      continue;
    }

    const byWorkflow = new Map();
    for (const r of runs) {
      if (r.status !== "completed") continue; // in-progress/queued have no duration yet
      const key = r.workflowName || r.name || "?";
      const hit = byWorkflow.get(key) ?? [];
      const durMs =
        new Date(r.updatedAt) - new Date(r.startedAt || r.createdAt);
      hit.push({
        conclusion: r.conclusion,
        durMs: Math.max(durMs, 0),
        createdAt: r.createdAt,
      });
      byWorkflow.set(key, hit);
    }

    const workflows = [];
    for (const [name, entries] of byWorkflow) {
      entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // oldest -> newest
      const failures = entries.filter((e) => e.conclusion === "failure").length;
      const durations = entries.map((e) => e.durMs).filter((d) => d > 0);
      const med = durations.length ? median(durations) : 0;

      // Trend: oldest third vs newest third average duration, only meaningful
      // with enough samples on both sides — and only on jobs with real duration,
      // since a percentage swing on a near-zero base (a fast/skipped check) is
      // noise, not a slowdown.
      let trendPct = null;
      if (entries.length >= 6 && med >= 30_000) {
        const third = Math.max(2, Math.floor(entries.length / 3));
        const oldest = entries
          .slice(0, third)
          .map((e) => e.durMs)
          .filter((d) => d > 0);
        const newest = entries
          .slice(-third)
          .map((e) => e.durMs)
          .filter((d) => d > 0);
        if (oldest.length && newest.length) {
          const oldAvg = oldest.reduce((a, b) => a + b, 0) / oldest.length;
          const newAvg = newest.reduce((a, b) => a + b, 0) / newest.length;
          if (oldAvg > 0) trendPct = ((newAvg - oldAvg) / oldAvg) * 100;
        }
      }

      workflows.push({
        name,
        runs: entries.length,
        failures,
        medianMs: med,
        trendPct,
      });
    }
    workflows.sort((a, b) => b.medianMs - a.medianMs);
    repoReports.push({ repo: repo.name, error: null, workflows });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(repoReports, null, 2));
    process.exit(0);
  }

  console.log(
    c.bold(`\nCI health across ${repos.length} repo(s), last ${sinceDays}d\n`),
  );

  const flaky = [];
  const slowing = [];

  for (const r of repoReports) {
    console.log(c.bold(r.repo));
    if (r.error) {
      console.log(c.yellow(`  ${r.error}`));
      continue;
    }
    if (!r.workflows.length) {
      console.log(c.dim(`  no completed runs on base branch in window`));
      continue;
    }
    for (const w of r.workflows) {
      const mins = (w.medianMs / 60000).toFixed(1);
      const failFlag =
        w.failures > 1
          ? c.red(`${w.failures} failures`)
          : w.failures === 1
            ? c.dim("1 failure")
            : c.green("0 failures");
      let trendFlag = "";
      if (w.trendPct !== null && w.trendPct > 20)
        trendFlag = c.red(
          `  ↑${w.trendPct.toFixed(0)}% slower (recent vs earlier)`,
        );
      else if (w.trendPct !== null && w.trendPct < -20)
        trendFlag = c.green(`  ↓${Math.abs(w.trendPct).toFixed(0)}% faster`);
      console.log(
        `  ${w.name.padEnd(28)} median ${mins}min  ${failFlag}  (${w.runs} runs)${trendFlag}`,
      );
      if (w.failures > 1) flaky.push({ repo: r.repo, ...w });
      if (w.trendPct !== null && w.trendPct > 20)
        slowing.push({ repo: r.repo, ...w });
    }
    console.log("");
  }

  if (flaky.length) {
    console.log(
      c.bold(`repeat failures`) +
        c.dim(
          "  (failed more than once in the window — worth fixing, not rerunning)\n",
        ),
    );
    for (const w of flaky.sort((a, b) => b.failures - a.failures)) {
      console.log(`  ${c.red(`×${w.failures}`)}  ${w.repo} / ${w.name}`);
    }
    console.log("");
  }

  if (slowing.length) {
    console.log(
      c.bold(`trending slower`) +
        c.dim(
          "  (recent runs meaningfully slower than earlier ones in the window)\n",
        ),
    );
    for (const w of slowing.sort((a, b) => b.trendPct - a.trendPct)) {
      console.log(
        `  ${c.red(`↑${w.trendPct.toFixed(0)}%`)}  ${w.repo} / ${w.name}  (now ~${(w.medianMs / 60000).toFixed(1)}min)`,
      );
    }
    console.log("");
  }

  console.log(
    c.dim(
      `Next: /factory-retro folds this in alongside friction.mjs — a repeat failure or a real trend is a harness defect, a one-off isn't.\n`,
    ),
  );
}
