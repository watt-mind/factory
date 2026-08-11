#!/usr/bin/env bun
/**
 * Resolve a repo's `security:` block from config/repos.yaml into shell exports.
 *
 *   eval "$(bun tools/security-env.mjs /path/inside/repo)"
 *
 * Prints `export SEMGREP_ARGS=...` / `export GITLEAKS_ARGS=...` lines for the
 * configured repo containing the given path (match by realpath prefix), or
 * nothing when the repo has no entry or no security block — the check then
 * runs with defaults. Central config replaces per-repo dotfiles so scan
 * tuning lives next to schedule/policy and applies on every machine with a
 * factory checkout. (.gitleaks.toml stays in-repo: CI and git hooks need it.)
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));

const target = realpathSync(process.argv[2] || process.cwd());
const expand = (p) => realpathSync(p.replace(/^~(?=\/|$)/, homedir()));

// Worktrees live outside the configured path, so also match by origin remote
// (normalized to owner/repo).
const remote = (() => {
  const r = Bun.spawnSync(["git", "-C", target, "remote", "get-url", "origin"]);
  if (r.exitCode !== 0) return null;
  const m = r.stdout.toString().trim().match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
  return m ? m[1] : null;
})();

for (const repo of cfg.repos || []) {
  let byPath = false;
  try {
    const repoPath = expand(repo.path);
    byPath = target === repoPath || target.startsWith(repoPath + path.sep);
  } catch {}
  if (!byPath && !(remote && repo.github === remote)) continue;
  const sec = repo.security || {};
  if (sec.semgrep_args) console.log(`export SEMGREP_ARGS=${JSON.stringify(sec.semgrep_args)}`);
  if (sec.gitleaks_args) console.log(`export GITLEAKS_ARGS=${JSON.stringify(sec.gitleaks_args)}`);
  break;
}
