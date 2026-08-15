#!/usr/bin/env bun
/**
 * Mechanical branch deletion guard: is a PR's branch safe to delete?
 *
 *   bun orchestrator/branch-guard.mjs --repo bj29 --pr 123 [--head branch]
 *
 * Exit 0 — Safe to delete (not protected, not held by another open PR)
 * Exit 2 — Refused (branch is protected base/deploy_branch or held by another open PR)
 * Exit 3 — Cannot evaluate (gh command failure, unknown repo, unreadable repos.yaml)
 *
 * Prevents:
 *  - Deleting protected branches (base, deploy_branch, develop, master, main)
 *  - Deleting branches that are still the head of other open PRs (WM-17, Legalease #261)
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT } from "../lib/schedule.mjs";

export const EXIT = {
  SAFE: 0,
  REFUSED: 2,
  CANNOT_EVALUATE: 3,
};

/** Protected branches for a given repo (including base, deploy_branch, and factory defaults). */
export function protectedBranchesFor(repo) {
  const list = new Set();
  if (repo?.base) list.add(repo.base);
  if (repo?.deploy_branch) list.add(repo.deploy_branch);
  list.add("develop");
  list.add("master");
  list.add("main");
  return Array.from(list);
}

/** Normalize branch refs for protected-branch comparisons. */
function normalizeBranchName(branch) {
  return String(branch).toLowerCase().replace(/^(?:refs\/heads\/|origin\/|heads\/)/, "");
}

/** Check if a branch name matches any protected branch for this repo. */
export function isProtectedBranch(branch, repo) {
  if (!branch) return false;
  const candidate = normalizeBranchName(branch);
  return protectedBranchesFor(repo).some((protectedBranch) => normalizeBranchName(protectedBranch) === candidate);
}

/**
 * Check if another open PR is still using this branch as its head.
 * Excludes targetPr from being counted as a holder.
 */
export function openPrHold(branch, targetPr, openPrs) {
  if (!branch) return null;
  const targetStr = targetPr !== null && targetPr !== undefined ? String(targetPr) : null;
  const holders = (openPrs ?? []).filter((pr) => String(pr?.number) !== targetStr && pr?.headRefName === branch);
  if (!holders.length) return null;
  const list = holders.map((pr) => `#${pr.number}`).join(", ");
  return `branch "${branch}" is still the head of other open PR(s): ${list} (WM-17)`;
}

/**
 * Pure evaluation function for branch deletion safety.
 */
export function evaluateBranchGuard({ branch, repo, targetPr, openPrs }) {
  if (!branch) {
    return { ok: false, exitCode: EXIT.CANNOT_EVALUATE, reason: "head branch is empty or missing" };
  }
  if (!repo) {
    return { ok: false, exitCode: EXIT.CANNOT_EVALUATE, reason: "repo configuration is missing" };
  }
  if (isProtectedBranch(branch, repo)) {
    return {
      ok: false,
      exitCode: EXIT.REFUSED,
      reason: `branch "${branch}" is a protected branch (${protectedBranchesFor(repo).join(", ")})`,
    };
  }
  const hold = openPrHold(branch, targetPr, openPrs);
  if (hold) {
    return {
      ok: false,
      exitCode: EXIT.REFUSED,
      reason: hold,
    };
  }
  return {
    ok: true,
    exitCode: EXIT.SAFE,
    branch,
  };
}

/**
 * Resolve the head branch for a PR using gh pr view.
 * Returns null when gh fails.
 */
export function resolveHeadBranch(repoPath, pr, run = spawnSync) {
  const r = run("gh", ["pr", "view", String(pr), "--json", "headRefName", "-q", ".headRefName"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = (r.stdout || "").trim();
  return out || null;
}

/**
 * List open PRs in a repository using gh pr list.
 * Returns null when gh fails.
 */
export function listOpenPrs(repoPath, run = spawnSync) {
  const r = run("gh", ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

  const repoName = val("--repo");
  const pr = val("--pr");
  const explicitHead = val("--head");

  if (!repoName || !pr) {
    console.error("usage: bun orchestrator/branch-guard.mjs --repo <name> --pr <number> [--head <branch>]");
    process.exit(EXIT.CANNOT_EVALUATE);
  }

  const configPath = process.env.FACTORY_BRANCH_GUARD_REPOS_YAML || path.join(ROOT, "config/repos.yaml");
  let cfg;
  try {
    cfg = Bun.YAML.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`CANNOT EVALUATE — could not read ${configPath}: ${err.message}`);
    process.exit(EXIT.CANNOT_EVALUATE);
  }

  const repo = (cfg?.repos ?? []).find((r) => r.name === repoName);
  if (!repo) {
    console.error(`CANNOT EVALUATE — no repo named "${repoName}" in ${configPath}`);
    process.exit(EXIT.CANNOT_EVALUATE);
  }

  const repoPath = String(repo.path || "").replace(/^~/, homedir());

  let branch = explicitHead?.trim() || null;
  if (!branch) {
    branch = resolveHeadBranch(repoPath, pr);
    if (!branch) {
      console.error(`CANNOT EVALUATE — could not resolve head branch for PR #${pr} in ${repoName}`);
      process.exit(EXIT.CANNOT_EVALUATE);
    }
  }

  let openPrs;
  if (process.env.FACTORY_BRANCH_GUARD_OPEN_PRS_JSON) {
    try {
      openPrs = JSON.parse(process.env.FACTORY_BRANCH_GUARD_OPEN_PRS_JSON);
    } catch {
      openPrs = null;
    }
  } else {
    openPrs = listOpenPrs(repoPath);
  }
  if (openPrs === null) {
    console.error(`CANNOT EVALUATE — could not list open PRs in ${repoName}`);
    process.exit(EXIT.CANNOT_EVALUATE);
  }

  const result = evaluateBranchGuard({ branch, repo, targetPr: pr, openPrs });
  if (result.exitCode === EXIT.SAFE) {
    console.log(`SAFE — PR #${pr} branch "${branch}" in ${repoName} is safe to delete`);
    process.exit(EXIT.SAFE);
  } else if (result.exitCode === EXIT.REFUSED) {
    console.error(`REFUSED — ${result.reason}`);
    process.exit(EXIT.REFUSED);
  } else {
    console.error(`CANNOT EVALUATE — ${result.reason}`);
    process.exit(EXIT.CANNOT_EVALUATE);
  }
}
