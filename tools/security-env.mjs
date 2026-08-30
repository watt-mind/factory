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
import { findRepoForPath, loadRepos } from "../event-runtime/lib/repos.mjs";

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

  // Worktrees live outside the configured path, so preserve the normalized
  // origin remote as a fallback after the registry's canonical path match.
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

  const repo = findRepoForPath(loadRepos(), target, { remote });
  const security = repo?.security;
  if (security?.semgrepArgs)
    console.log(`export SEMGREP_ARGS=${JSON.stringify(security.semgrepArgs)}`);
  if (security?.gitleaksArgs)
    console.log(
      `export GITLEAKS_ARGS=${JSON.stringify(security.gitleaksArgs)}`,
    );
  if (security?.pythonVersion)
    console.log(
      `export PYTHON_VERSION=${JSON.stringify(String(security.pythonVersion))}`,
    );
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
