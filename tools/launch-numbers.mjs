#!/usr/bin/env bun
/**
 * Reproducible launch metrics for OSS posts.
 *
 *   bun tools/launch-numbers.mjs
 *   bun tools/launch-numbers.mjs --json
 *   bun tools/launch-numbers.mjs --since 2026-08-03
 *
 * Two sources, both pinned to `--since` (default 2026-08-03, the first
 * dispatch day named in WM-802):
 *
 *   control plane       tickets dispatched / merged / escalated, human-touch,
 *                       median createdAt → completedAt. Linear answers the
 *                       GraphQL query below (with state history); GitHub
 *                       answers through the adapter's REST `raw` escape hatch
 *                       (labels + closed_at, no history — history-dependent
 *                       fields such as `blocked` are reported as null there).
 *   ~/.factory/logs     tokens by harness, via orchestrator/economics.mjs
 *
 * Humans post the drafts this feeds. This script never publishes.
 *
 * "Merged without human touch" means the ticket reached Done after an agent
 * claim (`agent:*` or `ai:in-progress` / `ai:needs-review` in current labels
 * or history) and never visited Blocked and never carried `ai:escalated`.
 * Filing (`source:human`) still counts — humans specify work; agents ship it.
 * A Blocked detour is human touch even if the operator later unblocked it.
 */
import {
  harnessTokenTotals,
  loadTranscriptRuns,
} from "../orchestrator/economics.mjs";
import { LOG_DIR } from "../lib/transcript.mjs";
import { loadControlPlane } from "../lib/control-plane/index.mjs";
import { loadRepos } from "../event-runtime/lib/repos.mjs";

export const DEFAULT_SINCE = "2026-08-03T00:00:00.000Z";
export const USAGE = `usage: bun tools/launch-numbers.mjs [--json] [--since YYYY-MM-DD]  (reads the factory repo's control plane — Linear or GitHub — plus ~/.factory/logs)`;

class UsageError extends Error {}

export class UnsupportedControlPlaneError extends Error {}

export const DISPATCH_LABELS = new Set([
  "ai:in-progress",
  "ai:needs-review",
  "ai:blocked",
  "ai:escalated",
]);

export const ISSUE_PAGE_SIZE = 50;
export const GITHUB_PAGE_SIZE = 100;
export const FACTORY_REPO_NAME = "factory";

export function parseSince(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new TypeError("since date is empty");
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`invalid since date: ${value}`);
  return { iso: new Date(ms).toISOString(), ms };
}

export function labelNames(issue) {
  return (issue?.labels?.nodes ?? []).map((l) => l.name).filter(Boolean);
}

export function historyNodes(issue) {
  return issue?.history?.nodes ?? [];
}

/** Every label the ticket currently has or ever had added in history. */
export function everLabels(issue) {
  const names = new Set(labelNames(issue));
  for (const h of historyNodes(issue)) {
    for (const l of h.addedLabels ?? []) {
      if (l?.name) names.add(l.name);
    }
    for (const l of h.removedLabels ?? []) {
      if (l?.name) names.add(l.name);
    }
  }
  return names;
}

export function visitedState(issue, name) {
  const want = String(name).toLowerCase();
  if (issue?.state?.name?.toLowerCase() === want) return true;
  return historyNodes(issue).some(
    (h) =>
      h.fromState?.name?.toLowerCase() === want ||
      h.toState?.name?.toLowerCase() === want,
  );
}

export function isCompleted(issue) {
  return Boolean(issue?.completedAt) || issue?.state?.type === "completed";
}

export function isDispatched(issue) {
  for (const name of everLabels(issue)) {
    if (name.startsWith("agent:") || DISPATCH_LABELS.has(name)) return true;
  }
  return false;
}

export function isEscalated(issue) {
  return everLabels(issue).has("ai:escalated");
}

export function mergedWithoutHumanTouch(issue) {
  return (
    isCompleted(issue) &&
    isDispatched(issue) &&
    !isEscalated(issue) &&
    !visitedState(issue, "Blocked")
  );
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min`;
  if (h < 48) return `${round1(h)} h`;
  return `${round1(h / 24)} d`;
}

export function formatCompact(n) {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n));
}

export function weeksUnattended(sinceIso, nowMs = Date.now()) {
  const elapsed = Math.max(0, nowMs - Date.parse(sinceIso));
  const days = Math.floor(elapsed / 86_400_000);
  const weeks = Math.floor(days / 7);
  return {
    days,
    weeks,
    remainderDays: days % 7,
  };
}

export function inWindow(iso, sinceMs) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) && t >= sinceMs;
}

/** Claimed during the window, or created/completed in-window when startedAt is missing. */
export function dispatchedInWindow(issue, sinceMs = 0) {
  if (!isDispatched(issue)) return false;
  if (sinceMs <= 0) return true;
  if (issue.startedAt) return inWindow(issue.startedAt, sinceMs);
  return (
    inWindow(issue.createdAt, sinceMs) || inWindow(issue.completedAt, sinceMs)
  );
}

export function mergedInWindow(issue, sinceMs = 0) {
  if (!isCompleted(issue) || !isDispatched(issue)) return false;
  if (sinceMs <= 0) return true;
  return inWindow(issue.completedAt, sinceMs);
}

/**
 * `history: false` marks a source that cannot answer state-history questions
 * (GitHub issues carry labels and closed_at, not a Blocked/label timeline).
 * The fields that need history — `blocked`, `mergedWithoutHumanTouch` and its
 * percentage — are then null rather than a confident-looking zero.
 */
export function classifyIssues(issues, { sinceMs = 0, history = true } = {}) {
  const dispatched = issues.filter((i) => dispatchedInWindow(i, sinceMs));
  const merged = issues.filter((i) => mergedInWindow(i, sinceMs));
  const escalated = dispatched.filter(isEscalated);
  const blocked = dispatched.filter((i) => visitedState(i, "Blocked"));
  const untouched = merged.filter(mergedWithoutHumanTouch);
  const createdToMerge = merged
    .map((i) => Date.parse(i.completedAt) - Date.parse(i.createdAt))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const claimToMerge = merged
    .filter((i) => i.startedAt)
    .map((i) => Date.parse(i.completedAt) - Date.parse(i.startedAt))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const byTeam = new Map();
  for (const i of dispatched) {
    const team = i.team?.key ?? "(none)";
    const row = byTeam.get(team) ?? {
      team,
      dispatched: 0,
      merged: 0,
      escalated: 0,
    };
    row.dispatched++;
    if (mergedInWindow(i, sinceMs)) row.merged++;
    if (isEscalated(i)) row.escalated++;
    byTeam.set(team, row);
  }
  return {
    dispatched: dispatched.length,
    merged: merged.length,
    escalated: escalated.length,
    blocked: history ? blocked.length : null,
    mergedWithoutHumanTouch: history ? untouched.length : null,
    mergedWithoutHumanTouchPct:
      history && merged.length
        ? round1((100 * untouched.length) / merged.length)
        : null,
    medianTicketToMergeMs: median(createdToMerge),
    medianClaimToMergeMs: median(claimToMerge),
    byTeam: [...byTeam.values()].sort((a, b) => b.dispatched - a.dispatched),
  };
}

export const FACTORY_ISSUES_QUERY = `query($after: String) {
  issues(
    first: ${ISSUE_PAGE_SIZE}
    after: $after
    filter: {
      updatedAt: { gte: "__SINCE__" }
      or: [
        { labels: { name: { startsWith: "agent:" } } }
        { labels: { name: { in: ["ai:in-progress", "ai:needs-review", "ai:blocked", "ai:escalated"] } } }
      ]
    }
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier
      title
      url
      createdAt
      startedAt
      completedAt
      updatedAt
      state { name type }
      team { key }
      labels { nodes { name } }
      history(first: 50) {
        nodes {
          createdAt
          fromState { name }
          toState { name }
          addedLabels { name }
          removedLabels { name }
        }
      }
    }
  }
}`;

export function issuesQueryFor(sinceIso) {
  return FACTORY_ISSUES_QUERY.replace("__SINCE__", sinceIso);
}

export async function fetchFactoryIssues({
  gqlFn,
  sinceIso = DEFAULT_SINCE,
} = {}) {
  if (typeof gqlFn !== "function") {
    throw new TypeError("fetchFactoryIssues requires gqlFn");
  }
  const query = issuesQueryFor(sinceIso);
  const nodes = [];
  let after = null;
  for (;;) {
    const data = await gqlFn(query, { after });
    const page = data?.issues;
    nodes.push(...(page?.nodes ?? []));
    if (!page?.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
    if (!after) break;
  }
  return nodes;
}

export const GITHUB_ISSUES_PATH = (repo) => `/repos/${repo}/issues`;

/**
 * A GitHub REST issue reshaped into the Linear-shaped node the classifiers
 * read. GitHub has no workflow-state startedAt and no state/label history, so
 * `startedAt` is null and `history` is absent; `completedAt` is `closed_at`.
 * Pull requests share the issues endpoint and are dropped by the caller.
 */
export function githubIssueNode(issue, repo) {
  const closed = issue?.state === "closed";
  return {
    identifier: `${repo}#${issue.number}`,
    title: issue.title ?? "",
    url: issue.html_url ?? "",
    createdAt: issue.created_at ?? null,
    startedAt: null,
    completedAt: closed ? (issue.closed_at ?? null) : null,
    updatedAt: issue.updated_at ?? issue.created_at ?? null,
    state: closed
      ? { name: "Done", type: "completed" }
      : { name: "Open", type: "started" },
    team: { key: repo },
    labels: {
      nodes: (issue.labels ?? [])
        .map((l) => ({ name: typeof l === "string" ? l : l?.name }))
        .filter((l) => l.name),
    },
  };
}

/**
 * Issues updated since `sinceIso` from the GitHub adapter's REST `raw` verb
 * (`/repos/<owner>/<name>/issues`, `state=all`, paged until a short page).
 * Adapter-neutral verbs are not enough here: `listTickets` reports neither
 * `closed_at` nor closed issues without a Projects v2 board read.
 */
export async function fetchGithubIssues({
  controlPlane,
  repo,
  sinceIso = DEFAULT_SINCE,
} = {}) {
  if (typeof controlPlane?.raw !== "function") {
    throw new UnsupportedControlPlaneError(
      `${controlPlane?.kind ?? "unknown"} control plane has no raw verb; launch-numbers needs it to read issues`,
    );
  }
  if (!repo || !String(repo).includes("/")) {
    throw new UnsupportedControlPlaneError(
      `github control plane needs a repository slug (owner/name) to read launch metrics; got ${JSON.stringify(repo ?? null)}`,
    );
  }
  const nodes = [];
  for (let page = 1; ; page += 1) {
    const batch = await controlPlane.raw(GITHUB_ISSUES_PATH(repo), {
      state: "all",
      since: sinceIso,
      per_page: GITHUB_PAGE_SIZE,
      page,
    });
    if (!Array.isArray(batch)) {
      throw new UnsupportedControlPlaneError(
        `github control plane returned a non-list for ${GITHUB_ISSUES_PATH(repo)} (page ${page})`,
      );
    }
    for (const issue of batch) {
      if (issue?.pull_request) continue;
      nodes.push(githubIssueNode(issue, repo));
    }
    if (batch.length < GITHUB_PAGE_SIZE) break;
  }
  return nodes;
}

/** `config/repos.yaml`'s GitHub slug for the factory's own registry entry. */
export function factoryRepoSlug({ root } = {}) {
  const repos = loadRepos(root ? { root } : {});
  return repos.get(FACTORY_REPO_NAME)?.github ?? null;
}

export function collectLaunchNumbers({
  issues,
  runs,
  sinceIso = DEFAULT_SINCE,
  nowMs = Date.now(),
  generatedAt = new Date().toISOString(),
  history = true,
} = {}) {
  const tickets = classifyIssues(issues ?? [], {
    sinceMs: Date.parse(sinceIso) || 0,
    history,
  });
  const window = weeksUnattended(sinceIso, nowMs);
  const byHarness = harnessTokenTotals(runs ?? []);
  const tokenTotals = byHarness.reduce(
    (a, h) => ({
      runs: a.runs + h.runs,
      in: a.in + h.in,
      out: a.out + h.out,
      cacheRead: a.cacheRead + h.cacheRead,
      cacheWrite: a.cacheWrite + h.cacheWrite,
      tokens: a.tokens + h.tokens,
      cost: a.cost + h.cost,
      estCost: a.estCost + h.estCost,
    }),
    {
      runs: 0,
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
      estCost: 0,
    },
  );
  return {
    generatedAt,
    since: sinceIso,
    window,
    tickets,
    tokens: { totals: tokenTotals, byHarness },
  };
}

export function formatReport(metrics) {
  const t = metrics.tickets;
  const w = metrics.window;
  const weekLabel =
    w.weeks === 0
      ? `${w.days} day${w.days === 1 ? "" : "s"}`
      : `${w.weeks} week${w.weeks === 1 ? "" : "s"}${
          w.remainderDays ? ` + ${w.remainderDays}d` : ""
        } (${w.days} days)`;
  const orNa = (n) => (n == null ? "n/a" : String(n));
  const pct =
    t.mergedWithoutHumanTouchPct == null
      ? "n/a"
      : `${t.mergedWithoutHumanTouchPct}%`;
  const lines = [
    `factory launch numbers`,
    `  generated  ${metrics.generatedAt}`,
    `  window     ${metrics.since.slice(0, 10)} → ${metrics.generatedAt.slice(0, 10)}  ${weekLabel} unattended`,
    ``,
    `  tickets    dispatched ${t.dispatched}   merged ${t.merged}   escalated ${t.escalated}   blocked ${orNa(t.blocked)}`,
    `             merged without human touch ${orNa(t.mergedWithoutHumanTouch)} (${pct} of merged)`,
    `             median ticket→merge ${formatDuration(t.medianTicketToMergeMs)}   median claim→merge ${formatDuration(t.medianClaimToMergeMs)}`,
  ];
  if (t.byTeam.length) {
    lines.push(``, `  by team`);
    for (const row of t.byTeam) {
      lines.push(
        `    ${row.team.padEnd(6)}  dispatched ${String(row.dispatched).padStart(4)}  merged ${String(row.merged).padStart(4)}  escalated ${String(row.escalated).padStart(3)}`,
      );
    }
  }
  lines.push(``, `  tokens by harness`);
  if (!metrics.tokens.byHarness.length) {
    lines.push(
      `    (no ~/.factory/logs/*.jsonl on this host — re-run on the dispatch machine)`,
    );
  } else {
    lines.push(
      `    ${"harness".padEnd(10)} ${"runs".padStart(6)} ${"input".padStart(8)} ${"output".padStart(8)} ${"cache-rd".padStart(9)} ${"fresh".padStart(8)}`,
    );
    for (const h of metrics.tokens.byHarness) {
      lines.push(
        `    ${h.harness.padEnd(10)} ${String(h.runs).padStart(6)} ${formatCompact(h.in).padStart(8)} ${formatCompact(h.out).padStart(8)} ${formatCompact(h.cacheRead).padStart(9)} ${formatCompact(h.tokens).padStart(8)}`,
      );
    }
    const tot = metrics.tokens.totals;
    lines.push(
      `    ${"total".padEnd(10)} ${String(tot.runs).padStart(6)} ${formatCompact(tot.in).padStart(8)} ${formatCompact(tot.out).padStart(8)} ${formatCompact(tot.cacheRead).padStart(9)} ${formatCompact(tot.tokens).padStart(8)}`,
    );
  }
  lines.push(
    ``,
    `Re-run: bun tools/launch-numbers.mjs --since ${metrics.since.slice(0, 10)}`,
    `Humans post the drafts. This command does not publish.`,
  );
  return lines.join("\n");
}

export async function buildLaunchNumbers({
  controlPlane,
  gqlFn,
  repo,
  logDir = LOG_DIR,
  since = DEFAULT_SINCE,
  nowMs = Date.now(),
} = {}) {
  const { iso, ms } = parseSince(since);
  // `gqlFn` remains a test seam for the Linear query path. Production selects
  // the factory repository's adapter explicitly: the workspace default may
  // still be Linear while factory's own tickets live on GitHub.
  const plane =
    controlPlane ??
    (gqlFn ? null : loadControlPlane({ repoName: FACTORY_REPO_NAME }));
  const kind = gqlFn ? "linear" : (plane?.kind ?? "unknown");
  let issues;
  let history = true;
  if (gqlFn || ["linear", "memory"].includes(kind)) {
    const graphQL =
      gqlFn ?? ((query, variables) => plane.raw(query, variables));
    if (
      typeof graphQL !== "function" ||
      (!gqlFn && typeof plane.raw !== "function")
    ) {
      throw new UnsupportedControlPlaneError(
        `${kind} control plane cannot run the launch metrics query`,
      );
    }
    issues = await fetchFactoryIssues({ gqlFn: graphQL, sinceIso: iso });
  } else if (kind === "github") {
    const slug = repo ?? (controlPlane ? null : factoryRepoSlug());
    issues = await fetchGithubIssues({
      controlPlane: plane,
      repo: slug,
      sinceIso: iso,
    });
    history = false;
  } else {
    throw new UnsupportedControlPlaneError(
      `${kind} control plane is unsupported; launch-numbers reads Linear or GitHub`,
    );
  }
  const loaded = loadTranscriptRuns({ logDir, sinceMs: ms });
  const runs = loaded.ok ? loaded.runs : [];
  return {
    metrics: collectLaunchNumbers({
      issues,
      runs,
      sinceIso: iso,
      nowMs,
      history,
    }),
    transcripts: loaded.ok
      ? { ok: true, files: loaded.files.length }
      : { ok: false, code: loaded.code, message: loaded.message },
  };
}

export function parseArgv(argv) {
  const flags = { json: false, since: DEFAULT_SINCE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      if (argv.length !== 1) throw new UsageError(USAGE);
      return { help: true };
    }
    if (arg === "--json" && !flags.json) {
      flags.json = true;
      continue;
    }
    if (arg === "--since" && flags.since === DEFAULT_SINCE) {
      const since = argv[++i];
      if (!since || since.startsWith("--")) throw new UsageError(USAGE);
      try {
        flags.since = parseSince(since).iso;
      } catch {
        throw new UsageError(USAGE);
      }
      continue;
    }
    throw new UsageError(USAGE);
  }
  return flags;
}

export async function main(
  argv = process.argv.slice(2),
  {
    controlPlane,
    repo,
    logDir,
    stdout = console.log,
    stderr = console.error,
  } = {},
) {
  const flags = parseArgv(argv);
  if (flags.help) {
    stdout(USAGE);
    return 0;
  }
  const { metrics, transcripts } = await buildLaunchNumbers({
    since: flags.since,
    controlPlane,
    repo,
    ...(logDir ? { logDir } : {}),
  });
  if (!transcripts.ok) {
    stderr(`transcripts: ${transcripts.message}`);
  }
  if (flags.json) {
    stdout(JSON.stringify({ ...metrics, transcripts }, null, 2));
    return 0;
  }
  stdout(formatReport(metrics));
  return 0;
}

/** The process entry: usage and unsupported-plane errors are one line, exit 2. */
export async function runCli(argv, deps = {}) {
  const stderr = deps.stderr ?? console.error;
  try {
    return await main(argv, deps);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof UnsupportedControlPlaneError
    ) {
      stderr(error.message);
      return 2;
    }
    stderr(`launch-numbers: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli();
}
