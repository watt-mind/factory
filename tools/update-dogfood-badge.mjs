#!/usr/bin/env bun
/**
 * Rolling 30-day "dogfood-in-public" badge (WM-958).
 *
 *   bun tools/update-dogfood-badge.mjs                 # rewrite README.md
 *   bun tools/update-dogfood-badge.mjs --dry-run       # print, no writes
 *   bun tools/update-dogfood-badge.mjs --json          # Shields.io endpoint JSON
 *
 * Counts merged PRs via lib/forge (never shells out to `gh` itself). A PR is
 * autonomous when its body matches the factory protocol (`Fixes <TICKET>`).
 * The number is a rolling 30-day window on `mergedAt`, not a calendar month.
 *
 * `--dry-run` is the local verification path: no README write, no git
 * mutations. The scheduled workflow commits README only when the badge text
 * actually changed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadForge } from "../lib/forge/index.mjs";

export const WINDOW_DAYS = 30;
export const DEFAULT_REPO = "watt-mind/factory";
export const DEFAULT_README = "README.md";
export const DEFAULT_PR_LIMIT = 1000;
export const BADGE_START = "<!-- factory-dogfood-badge -->";
export const BADGE_END = "<!-- /factory-dogfood-badge -->";
export const BADGE_COLOR = "0B6E4F";
export const BADGE_LABEL = "Maintained by the factory";
export const PR_FIELDS = Object.freeze([
  "number",
  "title",
  "body",
  "mergedAt",
  "url",
  "headRefName",
]);

/** Factory protocol: `Fixes WM-958` / `Fixes CLNT-123` in the PR body. */
export const FIXES_TICKET_RE = /\bFixes\s+[A-Z]{2,}-\d+\b/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function isAutonomousPr(pr) {
  return FIXES_TICKET_RE.test(String(pr?.body ?? ""));
}

export function mergedAtMs(pr) {
  const v = pr?.mergedAt;
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function inRollingWindow(
  pr,
  now = new Date(),
  windowDays = WINDOW_DAYS,
) {
  const t = mergedAtMs(pr);
  if (t == null) return false;
  const end = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(end)) return false;
  const start = end - windowDays * MS_PER_DAY;
  return t >= start && t <= end;
}

export function countAutonomousMerges(
  prs,
  { now = new Date(), windowDays = WINDOW_DAYS } = {},
) {
  return (prs ?? []).filter(
    (pr) => isAutonomousPr(pr) && inRollingWindow(pr, now, windowDays),
  ).length;
}

export function badgeMessage(count) {
  return `${count} PRs merged autonomously this month`;
}

export function shieldsEndpointPayload(count, extras = {}) {
  return {
    schemaVersion: 1,
    label: BADGE_LABEL,
    message: badgeMessage(count),
    color: BADGE_COLOR,
    ...extras,
  };
}

export function shieldsBadgeUrl(count) {
  const params = new URLSearchParams({
    label: BADGE_LABEL,
    message: badgeMessage(count),
    color: BADGE_COLOR,
  });
  return `https://img.shields.io/static/v1?${params.toString()}`;
}

/**
 * The blank lines around the badge are the Prettier contract, not decoration
 * (WM-1031). CI runs `prettier --check .` over README.md, and the weekly job
 * commits its rewrite straight to `develop`; a block Prettier would reformat
 * turns the base branch red every week from a commit nobody is watching.
 */
export function renderBadgeBlock(count, { repo = DEFAULT_REPO } = {}) {
  const img = shieldsBadgeUrl(count);
  const href = `https://github.com/${repo}/pulls?q=is%3Apr+is%3Amerged`;
  return `${BADGE_START}\n\n[![${BADGE_LABEL}](${img})](${href})\n\n${BADGE_END}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyBadgeToReadme(
  markdown,
  count,
  { repo = DEFAULT_REPO } = {},
) {
  const block = renderBadgeBlock(count, { repo });
  const re = new RegExp(
    `${escapeRegExp(BADGE_START)}[\\s\\S]*?${escapeRegExp(BADGE_END)}`,
  );
  if (re.test(markdown)) return markdown.replace(re, block);

  const lines = String(markdown).split("\n");
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 === -1) {
    return markdown ? `${block}\n\n${markdown}` : `${block}\n`;
  }
  const before = lines.slice(0, h1 + 1);
  const after = lines.slice(h1 + 1);
  if (after[0] === "") after.shift();
  return [...before, "", block, "", ...after].join("\n");
}

export function collectMetrics(
  forge,
  repo,
  { now = new Date(), windowDays = WINDOW_DAYS, limit = DEFAULT_PR_LIMIT } = {},
) {
  const prs = forge.prList(repo, {
    state: "merged",
    limit,
    fields: [...PR_FIELDS],
  });
  if (!Array.isArray(prs)) {
    throw new Error(`forge.prList(${repo}) did not return an array`);
  }
  const mergedInWindow = prs.filter((pr) =>
    inRollingWindow(pr, now, windowDays),
  );
  // gh pr list is newest-first and caps at --limit. If every returned PR is
  // still inside the window we did not finish the scan, and publishing that
  // count would under-state the trust signal.
  if (prs.length === limit && mergedInWindow.length === prs.length) {
    throw new Error(
      `merged PR scan hit the --limit of ${limit} and every result is inside the ${windowDays}-day window; raise --limit (GitHub caps gh pr list at 1000) or the badge would under-count`,
    );
  }
  return {
    repo,
    windowDays,
    scanned: prs.length,
    mergedInWindow: mergedInWindow.length,
    autonomousMerges: mergedInWindow.filter(isAutonomousPr).length,
    asOf: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

export function parseCliArgs(argv) {
  const args = [...argv];
  const flags = {
    dryRun: false,
    json: false,
    help: false,
    repo: null,
    readme: null,
    limit: null,
  };
  while (args.length) {
    const a = args.shift();
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--repo") flags.repo = args.shift() ?? null;
    else if (a === "--readme") flags.readme = args.shift() ?? null;
    else if (a === "--limit") flags.limit = Number(args.shift());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (flags.limit != null && !Number.isFinite(flags.limit)) {
    throw new Error(`--limit must be a number`);
  }
  return flags;
}

const USAGE = `tools/update-dogfood-badge.mjs — rolling 30-day autonomous merge badge

Usage:
  bun tools/update-dogfood-badge.mjs [options]

Options:
  --dry-run         Print metrics and the badge block; do not write README
  --json            Print a Shields.io endpoint payload on stdout
  --repo owner/name GitHub repo to scan (default: watt-mind/factory)
  --readme PATH     README to update (default: README.md)
  --limit N         Max merged PRs to scan (default: 1000)
  --help, -h        Show this help
`;

export function runUpdate({
  argv = [],
  forge,
  now = new Date(),
  cwd = DEFAULT_ROOT,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
} = {}) {
  const flags = parseCliArgs(argv);
  if (flags.help) {
    stdout.write(USAGE);
    return { ok: true, help: true };
  }

  const repo =
    flags.repo || env.GITHUB_REPOSITORY || env.DOGFOOD_REPO || DEFAULT_REPO;
  const readmePath = path.resolve(cwd, flags.readme || DEFAULT_README);
  const loaded = forge ?? loadForge({ root: cwd });
  const metrics = collectMetrics(loaded, repo, {
    now,
    limit: flags.limit ?? DEFAULT_PR_LIMIT,
  });
  const count = metrics.autonomousMerges;
  const payload = shieldsEndpointPayload(count, {
    count,
    repo: metrics.repo,
    windowDays: metrics.windowDays,
    scanned: metrics.scanned,
    mergedInWindow: metrics.mergedInWindow,
    asOf: metrics.asOf,
    dryRun: flags.dryRun,
  });

  let markdown = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
  const next = applyBadgeToReadme(markdown, count, { repo });
  const changed = next !== markdown;

  if (flags.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    stdout.write(
      [
        `repo: ${repo}`,
        `autonomousMerges: ${count}`,
        `mergedInWindow: ${metrics.mergedInWindow}`,
        `scanned: ${metrics.scanned}`,
        `windowDays: ${metrics.windowDays}`,
        `readme: ${flags.dryRun ? "dry-run" : changed ? "updated" : "unchanged"}`,
        "",
        renderBadgeBlock(count, { repo }),
        "",
      ].join("\n"),
    );
  }

  if (flags.dryRun) {
    return { ok: true, dryRun: true, changed, count, metrics, payload };
  }

  if (!changed) {
    return { ok: true, dryRun: false, changed: false, count, metrics, payload };
  }

  writeFileSync(readmePath, next);
  stderr.write(`wrote ${readmePath}\n`);
  return { ok: true, dryRun: false, changed: true, count, metrics, payload };
}

if (import.meta.main) {
  try {
    const result = runUpdate({ argv: process.argv.slice(2) });
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(`update-dogfood-badge: ${err.message}`);
    process.exit(1);
  }
}
