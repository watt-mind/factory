#!/usr/bin/env bun
/**
 * Resolve a repo's `security:` block from config/repos.yaml into shell exports.
 *
 *   eval "$(bun tools/security-env.mjs /path/inside/repo)"
 *
 * Prints `export SEMGREP_ARGS=...` / `export GITLEAKS_ARGS=...` /
 * `export PYTHON_VERSION=...` lines for the
 * configured repo containing the given path (match by realpath prefix), or
 * nothing when the repo has no entry or no security block — the check then
 * runs with defaults. Central config replaces per-repo dotfiles so scan
 * tuning lives next to schedule/policy and applies on every machine with a
 * factory checkout. (.gitleaks.toml stays in-repo: CI and git hooks need it.)
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfigYaml } from "../lib/schedule.mjs";

export const USAGE = "usage: bun tools/security-env.mjs [PATH]";

class UsageError extends Error {}

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.length > 1 || argv[0]?.startsWith("-")) throw new UsageError(USAGE);
  return { path: argv[0] ?? process.cwd() };
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  let target;
  try {
    target = realpathSync(args.path);
  } catch {
    throw new UsageError(USAGE);
  }

  const cfg = loadConfigYaml("repos");
  const expand = (p) => realpathSync(p.replace(/^~(?=\/|$)/, homedir()));

  // Worktrees live outside the configured path, so also match by origin remote
  // (normalized to owner/repo).
  const remote = (() => {
    const r = Bun.spawnSync([
      "git",
      "-C",
      target,
      "remote",
      "get-url",
      "origin",
    ]);
    if (r.exitCode !== 0) return null;
    const m = r.stdout
      .toString()
      .trim()
      .match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  })();

  for (const repo of cfg.repos || []) {
    let byPath = false;
    try {
      const repoPath = expand(repo.path);
      byPath = target === repoPath || target.startsWith(repoPath + path.sep);
    } catch {
      /* intentionally ignored */
    }
    if (!byPath && !(remote && repo.github === remote)) continue;
    const sec = repo.security || {};
    if (sec.semgrep_args)
      console.log(`export SEMGREP_ARGS=${JSON.stringify(sec.semgrep_args)}`);
    if (sec.gitleaks_args)
      console.log(`export GITLEAKS_ARGS=${JSON.stringify(sec.gitleaks_args)}`);
    if (sec.python_version)
      console.log(
        `export PYTHON_VERSION=${JSON.stringify(String(sec.python_version))}`,
      );
    break;
  }
}

if (import.meta.main) {
  try {
    run();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      console.error(`security-env: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
