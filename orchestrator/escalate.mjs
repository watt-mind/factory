#!/usr/bin/env bun
/**
 * Mechanical escalation check: does a PR touch this repo's `escalate_paths`?
 *
 *   bun orchestrator/escalate.mjs --repo bj29 --pr 123
 *
 * Exit 0  — the list was checked and nothing matched; the merge stage's normal
 *           judgment applies
 * Exit 2  — a listed surface is in the diff; NEVER auto-merge, hand to a human
 * Exit 3  — the gate could not be evaluated (unknown repo, no `escalate_paths`
 *           key, the PR diff could not be read or named no files at all). NOT a pass:
 *           treat the PR as escalated until the check can actually run.
 *
 * "Nothing matched" and "there was nothing to match" are different answers and
 * must never share exit 0. Two shapes of the second:
 *
 *   - no list to match against — a stale checkout whose config/repos.yaml
 *     predates a repo's escalate_paths would otherwise read as a clean gate
 *     (WM-15). A repo that deliberately has nothing to check mechanically says
 *     so with an explicit `escalate_paths: []`.
 *   - no files to match — a PR always changes at least one file, so an empty
 *     changed-file list means the diff was never read: wrong PR number, a `gh`
 *     that failed while still exiting 0, or the test seam exported empty
 *     (WM-48). Matching zero files against any glob list trivially "passes".
 *
 * This turns the `escalate_paths` lists in config/repos.yaml from documentation
 * into a gate. It is deliberately one-directional: a match here forces
 * escalation, but a clean exit never overrides the global judgment list in
 * policy.yaml (auth, payments, secrets…) — path matching can't see whether a
 * diff CHANGES security-relevant behavior, only where it lives.
 *
 * Test seams (tests only; unset in normal use):
 *   FACTORY_ESCALATE_REPOS_YAML  read this config instead of config/repos.yaml
 *   FACTORY_ESCALATE_DIFF_FILES  newline-separated changed files, skips `gh`
 *                                (only when non-empty — exported-but-empty is
 *                                not an injected answer)
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { globsOverlap } from "./owned-paths.mjs";
import { configYamlPath, loadConfigYaml } from "../lib/schedule.mjs";
import { loadForge } from "../lib/forge/index.mjs";

export const EXIT = { CLEAN: 0, ESCALATE: 2, CANNOT_EVALUATE: 3 };

/** Which changed files hit which escalate globs? Pure, for tests. */
export function matchEscalations(files, globs) {
  const hits = [];
  for (const f of files) {
    const matched = globs.filter((g) => globsOverlap(f, g));
    if (matched.length) hits.push({ file: f, globs: matched });
  }
  return hits;
}

/**
 * The globs to check, or why the gate cannot be evaluated at all. An explicit
 * empty list is a valid answer ("checked, nothing to match"); a missing key is
 * not.
 */
export function resolveEscalateGlobs(repo) {
  const name = repo?.name ?? "?";
  const raw = repo?.escalate_paths;
  if (raw === undefined || raw === null)
    return {
      ok: false,
      reason: `"${name}" has no escalate_paths key in config/repos.yaml`,
    };
  if (
    !Array.isArray(raw) ||
    raw.some((g) => typeof g !== "string" || !g.trim())
  )
    return {
      ok: false,
      reason: `escalate_paths for "${name}" is not a list of path globs`,
    };
  return { ok: true, globs: raw };
}

/**
 * The changed files in a `--name-only` list, or why the gate cannot be
 * evaluated. Unlike `escalate_paths: []`, a zero-length file list is never a
 * valid answer — no PR changes nothing, so an empty list means the diff was not
 * read rather than read and found harmless.
 */
export function resolveChangedFiles(raw) {
  const files = String(raw ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!files.length)
    return {
      ok: false,
      reason: "the changed-file list is empty — the diff was never read",
    };
  return { ok: true, files };
}

/** Git facts about the checkout that supplied the config. Never throws. */
export function checkoutFreshness(configPath) {
  const dir = path.dirname(configPath);
  const git = (args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  };
  const upstream = git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  const behindRaw =
    upstream === null
      ? null
      : git(["rev-list", "--count", `HEAD..${upstream}`]);
  const behind = behindRaw === null ? null : Number(behindRaw);
  // Absolute pathspec: the config need not sit at the root of its checkout.
  const status = git(["status", "--porcelain", "--", path.resolve(configPath)]);
  return {
    root: git(["rev-parse", "--show-toplevel"]) ?? dir,
    upstream,
    behind: Number.isFinite(behind) ? behind : null,
    dirtyConfig: status === null ? null : status.length > 0,
  };
}

/**
 * Loud lines for anything that can silently change the answer. A failed git
 * command reports "unknown", never "clean" — that is the same fail-open shape
 * this gate exists to avoid.
 */
export function freshnessWarnings(
  freshness,
  dir = freshness.root ?? "the factory checkout",
) {
  const out = [];
  const ref = freshness.upstream ?? "origin";
  if (freshness.behind === null)
    out.push(
      `WARNING: cannot tell whether ${dir} is current ` +
        `(${freshness.upstream ? `git rev-list against ${ref} failed` : "no upstream configured"}) ` +
        `— the escalate_paths read below may not be the ones on ${ref}`,
    );
  else if (freshness.behind > 0)
    out.push(
      `WARNING: ${dir} is ${freshness.behind} commit(s) behind ${ref} — ` +
        `config/repos.yaml may be missing escalate_paths that exist upstream. ` +
        `Run \`git -C ${dir} pull --ff-only\` and re-check before trusting this result.`,
    );
  if (freshness.dirtyConfig === null)
    out.push(
      `WARNING: cannot tell whether config/repos.yaml is locally modified in ${dir}`,
    );
  else if (freshness.dirtyConfig)
    out.push(
      `WARNING: config/repos.yaml has uncommitted local changes — ` +
        `the list checked here is not the list on ${ref}`,
    );
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };

  const pr = val("--pr");
  if (!val("--repo") || !pr) {
    console.error(
      `usage: bun orchestrator/escalate.mjs --repo <name> --pr <number>`,
    );
    process.exit(EXIT.CANNOT_EVALUATE);
  }

  const overrideConfigPath = process.env.FACTORY_ESCALATE_REPOS_YAML || null;
  let configPath;
  let cfg;
  try {
    configPath = configYamlPath("repos", { configPath: overrideConfigPath });
    cfg = loadConfigYaml("repos", { configPath: overrideConfigPath });
  } catch (err) {
    console.error(
      `CANNOT EVALUATE — could not read ${overrideConfigPath ?? "config/repos.yaml"}: ${err.message}`,
    );
    console.error(
      `the escalation gate did not run => treat the PR as ESCALATED until it can`,
    );
    process.exit(EXIT.CANNOT_EVALUATE);
  }
  const repo = (cfg?.repos ?? []).find((r) => r.name === val("--repo"));

  for (const line of freshnessWarnings(checkoutFreshness(configPath)))
    console.error(line);

  if (!repo) {
    console.error(
      `CANNOT EVALUATE — no repo named "${val("--repo")}" in ${configPath}`,
    );
    console.error(
      `the escalation gate did not run => treat PR #${pr} as ESCALATED until it can`,
    );
    process.exit(EXIT.CANNOT_EVALUATE);
  }

  const resolved = resolveEscalateGlobs(repo);
  if (!resolved.ok) {
    console.error(`CANNOT EVALUATE — ${resolved.reason}`);
    console.error(
      `the escalation gate did not run => treat PR #${pr} as ESCALATED until it can.`,
    );
    console.error(
      `Fix: give ${repo.name} an escalate_paths list, or an explicit \`escalate_paths: []\` if there is deliberately nothing to check mechanically.`,
    );
    process.exit(EXIT.CANNOT_EVALUATE);
  }
  const globs = resolved.globs;

  // Non-empty is the whole test for an injection: an exported-but-empty seam is
  // an absent answer, not a diff with no files in it.
  const injected = process.env.FACTORY_ESCALATE_DIFF_FILES;
  let raw;
  if (injected?.trim()) {
    raw = injected;
  } else {
    const repoPath = String(repo.path).replace(/^~/, homedir());
    try {
      raw = loadForge().prDiffFiles(null, pr, { cwd: repoPath }).join("\n");
    } catch (err) {
      console.error(
        `PR diff read failed: ${String(err.stderr || err.message || "").trim()}`,
      );
      console.error(`cannot see the diff => treat as ESCALATE, not as clean`);
      process.exit(EXIT.CANNOT_EVALUATE);
    }
  }

  const changed = resolveChangedFiles(raw);
  if (!changed.ok) {
    console.error(`CANNOT EVALUATE — PR #${pr}: ${changed.reason}`);
    console.error(
      `zero files match every glob list => treat PR #${pr} as ESCALATED, not as clean`,
    );
    console.error(
      `Check the changed-file list of PR #${pr} in ${repo.name} directly on the forge — an empty result usually means the wrong PR number, a closed or cross-fork PR, or a forge auth failure.`,
    );
    process.exit(EXIT.CANNOT_EVALUATE);
  }
  const files = changed.files;

  const hits = matchEscalations(files, globs);
  if (hits.length) {
    console.log(
      `ESCALATE — PR #${pr} touches ${hits.length} protected file(s) in ${repo.name}:`,
    );
    for (const h of hits) console.log(`  ${h.file}  (${h.globs.join(", ")})`);
    process.exit(EXIT.ESCALATE);
  }
  const list = globs.length
    ? `${globs.length} escalate_paths glob(s)`
    : `an explicitly empty escalate_paths list`;
  console.log(
    `PR #${pr}: none of ${files.length} changed file(s) hit ${list} — mechanical check clean (judgment list still applies)`,
  );
  process.exit(EXIT.CLEAN);
}
