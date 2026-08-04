#!/usr/bin/env bun
/**
 * Every repo's stuck tickets in one flat, worst-first list.
 *
 * "Stuck" means specifically: eligible for agent work, but will not move
 * without a human noticing something the per-repo dashboards don't surface on
 * their own — a parked supervisor, an Owned Paths section that fails to
 * parse, a crashed agent's abandoned claim, a finished PR the ticket doesn't
 * reflect yet, or a held ticket whose answer nobody re-read.
 *
 * Composes checks that already exist one-repo-at-a-time (queue.mjs's Owned
 * Paths parse, reaper.mjs's stale-claim detection, reconcile.mjs's
 * orphaned-PR detection, reply-detection.mjs's answered-hold detection) plus
 * one thing none of them checks: whether a supervisor process is even running
 * for a repo. Read-only — this never writes to Linear or GitHub.
 *
 *   bun orchestrator/stuck.mjs                  # every configured repo
 *   bun orchestrator/stuck.mjs --repo cashsaas,bj29
 *   bun orchestrator/stuck.mjs --json
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gql, isAgentClaim, lastActivity } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths } from "./owned-paths.mjs";
import { AI_BLOCKED, answeredHeldTickets } from "./reply-detection.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);
const JSON_OUT = argv.includes("--json");
const STALE_MIN = 45;   // matches reaper.mjs's default claim-silence threshold
const QUIET_MIN = 25;   // matches reconcile.mjs's default

const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));
if (!repos.length) { console.error(only.length ? `no repo named "${only}" in config/repos.yaml` : "no repos configured"); process.exit(2); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const QUERY = `
  query($team: String!, $project: String!) {
    issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        identifier title priority url description startedAt updatedAt
        state { name }
        assignee { name }
        labels(first: 20) { nodes { name } }
        comments(last: 1) { nodes { createdAt } }
        attachments(first: 20) { nodes { url } }
      }
    }
  }`;

/** Is a `run.mjs --repo <name>` (or a `--repo a,name,b` list) process alive right now? */
function supervisorAlive(name) {
  const p = Bun.spawnSync(["ps", "-eo", "command"]);
  if (p.exitCode !== 0) return null; // unknown, not "no" — never assert a false negative from a broken `ps`
  const lines = p.stdout.toString().split("\n").filter((l) => l.includes("run.mjs") && l.includes("--repo"));
  return lines.some((l) => {
    const m = /--repo\s+(\S+)/.exec(l);
    return m && m[1].split(",").includes(name);
  });
}

/** Open, non-draft PR numbers for a repo, via `gh` — [] on any failure. */
function openPRs(nameWithOwner) {
  const p = Bun.spawnSync(["gh", "pr", "list", "--repo", nameWithOwner, "--state", "open", "--json", "number,isDraft"]);
  if (p.exitCode !== 0) return [];
  try { return JSON.parse(p.stdout.toString()).filter((pr) => !pr.isDraft).map((pr) => pr.number); } catch { return []; }
}

function prNumbersOnIssue(issue, nameWithOwner) {
  const re = new RegExp(`github\\.com/${nameWithOwner.replace("/", "\\/")}/pull/(\\d+)`, "i");
  const out = new Set();
  for (const a of issue.attachments?.nodes ?? []) {
    const m = re.exec(a.url ?? "");
    if (m) out.add(Number(m[1]));
  }
  return [...out];
}

const rows = [];   // one per repo, for the summary table
const details = []; // { repo, category, severity, items: [{id, title, why}] }

for (const repo of repos) {
  const labels = (i) => (i.labels?.nodes ?? []).map((l) => l.name);
  const state = (i) => i.state?.name ?? "?";

  const nodes = (await gql(QUERY, { team: repo.team, project: repo.project }))?.issues?.nodes ?? [];

  const ready = nodes.filter((i) => state(i) === "Todo" && labels(i).includes("ai:agent-ready") && !i.assignee);
  const readyUnparseable = ready.filter((i) => parseOwnedPaths(i.description ?? "").length === 0);

  const inProgress = nodes.filter((i) => state(i) === "In Progress" && isAgentClaim({ labels: { nodes: (i.labels?.nodes ?? []) } }));
  const staleClaims = inProgress.filter((i) => {
    const seen = lastActivity({ startedAt: i.startedAt, updatedAt: i.updatedAt, comments: i.comments });
    return seen && (Date.now() - seen.getTime()) / 60000 > STALE_MIN;
  });

  let orphanedPR = [];
  if (repo.github) {
    const open = new Set(openPRs(repo.github));
    orphanedPR = inProgress.filter((i) => {
      const prs = prNumbersOnIssue(i, repo.github).filter((n) => open.has(n));
      if (!prs.length) return false;
      const seen = lastActivity({ startedAt: i.startedAt, updatedAt: i.updatedAt, comments: i.comments });
      return seen && (Date.now() - seen.getTime()) / 60000 > QUIET_MIN;
    });
  }

  const heldAny = nodes.filter((i) => ["Triage", "Blocked"].includes(state(i)) && labels(i).includes(AI_BLOCKED));
  const answeredIds = heldAny.length ? await answeredHeldTickets(repo) : new Set();
  const answeredHolds = nodes.filter((i) => answeredIds.has(i.identifier));

  const backlog = nodes.filter((i) => state(i) === "Backlog");

  const alive = repo.report_only ? null : supervisorAlive(repo.name);

  const cats = [
    { key: "no-supervisor", severity: 3, items: (!repo.report_only && alive === false) ? [{ id: "", title: "no `run.mjs --repo " + repo.name + "` process is running", why: "nothing will dispatch, triage, or merge here regardless of what's queued" }] : [] },
    { key: "report-only-ready", severity: 3, items: repo.report_only ? ready.map((i) => ({ id: i.identifier, title: i.title, why: "repo is report_only — dispatch will never target it" })) : [] },
    { key: "unparseable-owned-paths", severity: 2, items: readyUnparseable.map((i) => ({ id: i.identifier, title: i.title, why: "ai:agent-ready but Owned Paths parses to zero paths — dispatch skips it every tick" })) },
    { key: "stale-claim", severity: 2, items: staleClaims.map((i) => ({ id: i.identifier, title: i.title, why: `In Progress, no heartbeat in over ${STALE_MIN}m — likely a crashed agent` })) },
    { key: "orphaned-pr", severity: 2, items: orphanedPR.map((i) => ({ id: i.identifier, title: i.title, why: `open PR but ticket still In Progress and quiet ${QUIET_MIN}m+ — holding a dispatch slot for nothing` })) },
    { key: "answered-hold", severity: 1, items: answeredHolds.map((i) => ({ id: i.identifier, title: i.title, why: "ai:blocked with a newer reply — ready for the triage sweep to re-examine" })) },
  ];

  for (const cat of cats) if (cat.items.length) details.push({ repo: repo.name, category: cat.key, severity: cat.severity, items: cat.items });

  rows.push({
    repo: repo.name,
    supervisor: repo.report_only ? "n/a" : alive === null ? "?" : alive ? "up" : "DOWN",
    noSupervisor: cats[0].items.length,
    reportOnlyReady: cats[1].items.length,
    unparseable: cats[2].items.length,
    staleClaims: cats[3].items.length,
    orphanedPR: cats[4].items.length,
    answeredHolds: cats[5].items.length,
    backlogParked: backlog.length,
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ rows, details }, null, 2));
  process.exit(0);
}

console.log(c.bold("\nstuck, by repo") + c.dim("  (0 cells omitted)\n"));
const COLS = [["repo", 12], ["loop", 7], ["parse", 7], ["stale", 7], ["orphan", 7], ["answrd", 7], ["backlog", 7]];
console.log("  " + COLS.map(([h, w]) => h.padEnd(w)).join(""));
for (const r of rows) {
  const pad = (s, w, colorFn = (x) => x) => colorFn(s) + " ".repeat(Math.max(0, w - s.length));
  const cellN = (n, w) => pad(n ? String(n) : "-", w, n ? c.yellow : c.dim);
  const loopText = r.supervisor === "DOWN" ? "DOWN" : r.supervisor;
  const loopColor = r.supervisor === "DOWN" ? c.red : r.supervisor === "n/a" ? c.dim : c.green;
  console.log(
    "  " + pad(r.repo, 12) +
    pad(loopText, 7, loopColor) +
    cellN(r.unparseable, 7) + cellN(r.staleClaims, 7) + cellN(r.orphanedPR, 7) + cellN(r.answeredHolds, 7) +
    pad(r.backlogParked ? String(r.backlogParked) : "-", 7, c.dim)
  );
}

const bySeverity = [...details].sort((a, b) => b.severity - a.severity);
const LABELS = {
  "no-supervisor": "NO SUPERVISOR RUNNING",
  "report-only-ready": "READY BUT REPORT-ONLY (can never dispatch)",
  "unparseable-owned-paths": "READY BUT UNPARSEABLE OWNED PATHS",
  "stale-claim": "STALE CLAIM (reaper candidate)",
  "orphaned-pr": "ORPHANED PR (reconcile candidate)",
  "answered-hold": "ANSWERED HOLD (triage candidate)",
};

const MAX_SHOWN = 6;

if (!bySeverity.length) {
  console.log(c.dim("\nnothing stuck — every ready/in-progress/held ticket is moving normally.\n"));
} else {
  for (const d of bySeverity) {
    const tone = d.severity === 3 ? c.red : d.severity === 2 ? c.yellow : (s) => s;
    console.log(`\n${c.bold(d.repo)}  ${tone(LABELS[d.category])}`);
    console.log(c.dim(`  ${d.items[0].why}`));
    for (const it of d.items.slice(0, MAX_SHOWN)) {
      const id = it.id ? it.id.padEnd(10) : "";
      console.log(`    ${id} ${it.title.slice(0, 60)}`);
    }
    if (d.items.length > MAX_SHOWN) console.log(c.dim(`    … +${d.items.length - MAX_SHOWN} more`));
  }
  console.log();
}
