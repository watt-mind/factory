#!/usr/bin/env bun
/**
 * Reclaim worktrees whose tickets are finished.
 *
 *   bun orchestrator/janitor.mjs --repo bj29           # dry run
 *   bun orchestrator/janitor.mjs --repo bj29 --apply
 *   bun orchestrator/janitor.mjs --repo bj29 --gate    # exit 0 if there is work
 *   bun orchestrator/janitor.mjs --repo bj29 --json    # same survey, machine-readable
 *
 * Every worktree holds a checkout and (here) a per-ticket database. The merge
 * stage is supposed to tear its own down, but a crashed run, a merge done by
 * hand, or a ticket closed in Linear all leave one behind — and nothing
 * notices, because an orphaned worktree looks exactly like an active one.
 *
 * When this was written bj29 had 21 ticket worktrees, 20 of them for Done
 * tickets, on a disk at 89%. That is the failure mode: silent accumulation.
 *
 * SAFETY: this calls the repo's own worktree-down.sh WITHOUT --force, so a
 * worktree with uncommitted changes or unpushed commits refuses to be removed.
 * Losing an agent's unpushed work would be far worse than the disk it holds.
 * Never add --force here; if a worktree won't go, that is a finding to look at.
 *
 * Second safety property (WM-17): a worktree whose branch is still the head of
 * an OPEN pull request is left alone, even when its ticket reads finished. On
 * legalease, PR #261 was auto-closed by GitHub when a merge run deleted
 * `feat/CLNT-520` during PR #253's cleanup — a second agent was still shipping
 * from that branch, and its work had to be recovered from a dangling commit.
 * Pushed-and-open is exactly the state the uncommitted/unpushed guard cannot
 * see: the work is safely on the remote, so the checkout looks disposable.
 *
 * Note the direction of the two failure modes, because they pull opposite ways
 * and conflating them produces a fix that reintroduces the other:
 *   - WM-16 is cleanup *skipped* — stale worktrees and branches accumulate.
 *   - WM-17 (this) is cleanup *too eager* — it removes what is still in use.
 * A held worktree here is deliberate, not a WM-16 miss; it is reported as held
 * with the PR that holds it, and reclaims itself once that PR closes.
 *
 * `--json` (OPS-301) is the same survey the human CLI prints, as one object
 * per `--repo` so the loopback control API can spawn this script rather than
 * reimplement Linear + worktree discovery. Stdout is JSON only; the colour
 * log is skipped. `--force` is still not a flag and must never become one.
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { emitFactoryEvent } from "../lib/emit-event.mjs";

export function parseArgs(argv) {
  const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
  return {
    apply: argv.includes("--apply"),
    gate: argv.includes("--gate"),
    json: argv.includes("--json"),
    only: (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

const expand = (p) => p.replace(/^~/, homedir());

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/**
 * Which branch each worktree has checked out, from `git worktree list
 * --porcelain`. A detached worktree emits `detached` instead of `branch` and is
 * simply absent from the map — no branch, nothing an open PR can point at.
 */
export function parseWorktreeBranches(porcelain) {
  const branches = {};
  let current = null;
  for (const line of String(porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && current) branches[current] = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (!line.trim()) current = null;
  }
  return branches;
}

/**
 * WM-17: the reason this branch must not be torn down, or null when it is free.
 *
 * `openPrs` is what `gh pr list --state open --json number,headRefName`
 * returned, and only an actual list belongs here: an empty one means "no open
 * PR", a null one means "could not tell", and the caller has to separate those
 * two before it deletes anything — this function cannot.
 */
export function openPrHold(branch, openPrs) {
  if (!branch) return null;
  const holders = (openPrs ?? []).filter((pr) => pr?.headRefName === branch);
  if (!holders.length) return null;
  const list = holders.map((pr) => `#${pr.number}`).join(", ");
  return `branch ${branch} is still the head of open PR ${list} — leaving it in place (WM-17)`;
}

/**
 * Open PRs in a repo, or null when `gh` could not answer.
 * Fail closed (return null) when hitting the fetch limit so we never miss
 * an open PR holder due to pagination limits (WM-56).
 */
export function listOpenPrs(repoPath, run = spawnSync, limit = 200) {
  const r = run("gh", ["pr", "list", "--state", "open", "--limit", String(limit), "--json", "number,headRefName"], { cwd: repoPath, encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    if (!Array.isArray(parsed)) return null;
    if (parsed.length >= limit) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Branch checked out in each ticket worktree under `root`, keyed by ticket.
 * Returns null when `git worktree list` could not answer — same fail-closed
 * shape as `listOpenPrs`: "don't know" is not "no branch, so nothing is held".
 */
export function ticketBranches(repoPath, root, tickets, run = spawnSync) {
  const r = run("git", ["worktree", "list", "--porcelain"], { cwd: repoPath, encoding: "utf8" });
  if (r.status !== 0) return null;
  const byPath = parseWorktreeBranches(r.stdout);
  const byTicket = {};
  for (const t of tickets) {
    const branch = byPath[path.join(root, t)];
    if (branch) byTicket[t] = branch;
  }
  return byTicket;
}

/**
 * Tear down the finished worktrees that nothing else is using.
 *
 * Split out of `survey` so the guard can be exercised without a Linear query or
 * a real checkout: `run` is the only way this reaches the filesystem, so a test
 * that injects a recorder proves a held ticket never reaches worktree-down.sh.
 */
export function reclaim(finished, { repoPath, down, branches = {}, openPrs, run = spawnSync } = {}) {
  if (!Array.isArray(openPrs)) {
    throw new Error("reclaim requires openPrs array — refusing unguarded teardown (WM-56)");
  }
  const removed = [];
  const refused = [];
  const held = [];
  for (const t of finished) {
    const hold = openPrHold(branches[t], openPrs);
    if (hold) {
      held.push({ id: t, branch: branches[t], reason: hold });
      continue;
    }
    // No --force, deliberately: the script's refusal on uncommitted or unpushed
    // work is the safety property, not an obstacle to work around.
    const r = run("/bin/bash", [down, t], { cwd: repoPath, encoding: "utf8" });
    if (r.status === 0) removed.push(t);
    else {
      const reason = (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.status}`;
      refused.push({ id: t, reason });
    }
  }
  return { removed, refused, held };
}

function emptySurvey(repo, apply) {
  return {
    name: repo.name,
    apply,
    missingRoot: false,
    reclaimable: [],
    kept: [],
    named: [],
    unknown: [],
    removed: [],
    refused: [],
    held: [],
    skippedApplyReason: null,
  };
}

export async function survey(repo, { apply }, {
  readdir = readdirSync,
  exists = existsSync,
  queryIssues,
  getBranches = ticketBranches,
  getOpenPrs = listOpenPrs,
  doReclaim = reclaim,
} = {}) {
  const result = emptySurvey(repo, apply);
  const root = expand(repo.worktree_root ?? "");
  const repoPath = expand(repo.path);
  if (!root || !exists(root)) {
    result.missingRoot = true;
    return result;
  }

  // Only ever consider <TEAM>-<number> directories. Named worktrees (a release
  // branch, a scratch checkout) are somebody's deliberate workspace and are not
  // this tool's business.
  const pattern = new RegExp(`^${repo.team}-\\d+$`);
  const all = readdir(root);
  const tickets = all.filter((d) => pattern.test(d));
  result.named = all.filter((d) => !pattern.test(d) && !d.startsWith("."));

  let states = {};
  if (tickets.length) {
    const nums = tickets.map((t) => Number(t.split("-")[1]));
    let nodes = [];
    if (queryIssues) {
      nodes = await queryIssues(repo.team, nums);
    } else {
      const q = `query($n:[Float!]){ issues(first:250, filter:{ number:{in:$n}, team:{key:{eq:"${repo.team}"}} }){ nodes{ identifier state{name type} } } }`;
      nodes = (await gql(q, { n: nums }))?.issues?.nodes ?? [];
    }
    states = Object.fromEntries(nodes.map((n) => [n.identifier, n.state]));
  }

  const allFinished = tickets.filter((t) => ["completed", "canceled"].includes(states[t]?.type));
  result.kept = tickets
    .filter((t) => states[t] && !["completed", "canceled"].includes(states[t].type))
    .map((t) => ({ id: t, state: states[t].name }));
  result.unknown = tickets.filter((t) => !states[t]);

  // WM-17: the open-PR hold is evaluated in the survey, not just under --apply,
  // so a held worktree is neither reported as reclaimable nor allowed to keep
  // the --gate firing on work that every apply run will correctly decline.
  const branches = allFinished.length ? getBranches(repoPath, root, allFinished) : {};
  const openPrs = allFinished.length ? getOpenPrs(repoPath) : [];
  const cannotTell = openPrs === null || branches === null;
  if (cannotTell) {
    // Dry and apply both: do not advertise as reclaimable what we will not
    // (or cannot) tear down — otherwise --gate and the Dry UI count a set
    // Apply then refuses wholesale.
    result.skippedApplyReason =
      branches === null
        ? `${repo.name}: could not list worktree branches (git worktree list failed) — refusing to tear down worktrees blind (WM-17)`
        : `${repo.name}: could not list open PRs (gh pr list failed) — refusing to tear down worktrees blind (WM-17)`;
    result.reclaimable = [];
    return result;
  }
  const finished = allFinished.filter((t) => !openPrHold(branches[t], openPrs));
  result.held = allFinished
    .filter((t) => !finished.includes(t))
    .map((t) => ({ id: t, state: states[t].name, branch: branches[t], reason: openPrHold(branches[t], openPrs) }));
  result.reclaimable = finished.map((t) => ({ id: t, state: states[t].name }));

  if (!apply || !allFinished.length) return result;

  if (!finished.length) return result;

  // `report_only` disables dispatch, not safe cleanup. A repo with its own
  // configured teardown script can be reclaimed; one without it is surveyed
  // only, because removing a worktree by hand leaves its database behind.
  const down = repo.worktree_down;
  if (repo.report_only && !down) {
    result.skippedApplyReason = `report-only: ${repo.name} has no worktree teardown script (PC-15 pending)`;
    return result;
  }

  if (!down || !exists(path.join(repoPath, down))) {
    result.skippedApplyReason = `${repo.name} has no worktree_down script (${down}) — refusing to remove by hand`;
    return result;
  }

  // `finished` is already free of open-PR heads; reclaim() re-checks anyway so
  // the guard travels with the teardown call rather than with this caller.
  const outcome = doReclaim(finished, { repoPath, down, branches, openPrs });
  result.removed = outcome.removed;
  result.refused = outcome.refused;
  return result;
}

function printHuman(repo, result) {
  if (result.missingRoot) return;
  const n = result.reclaimable.length + result.kept.length + result.unknown.length;
  console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${n} ticket worktree(s) in ${repo.worktree_root}`));
  if (result.kept.length) {
    console.log(c.dim(`  keeping ${result.kept.length} live: ${result.kept.map((t) => `${t.id} (${t.state})`).join(", ")}`));
  }
  if (result.named.length) console.log(c.dim(`  ignoring ${result.named.length} named worktree(s): ${result.named.join(", ")}`));
  if (result.unknown.length) {
    console.log(c.yellow(`  ${result.unknown.length} worktree(s) with no matching ticket — left alone: ${result.unknown.join(", ")}`));
  }
  for (const t of result.held) {
    console.log(c.yellow(`  holding ${t.id} — ${t.reason}`));
  }
  if (!result.reclaimable.length) {
    console.log(c.green("  nothing to reclaim"));
    return;
  }
  console.log(`  ${c.bold(String(result.reclaimable.length))} reclaimable (ticket finished):`);
  for (const t of result.reclaimable) console.log(`    ${t.id}  ${c.dim(t.state)}`);
  if (!result.apply) {
    console.log(c.dim(`\n  dry run — re-run with --apply to remove them`));
    return;
  }
  if (result.skippedApplyReason) {
    console.log(c.yellow(`\n  ${result.skippedApplyReason}`));
    if (result.skippedApplyReason.startsWith("report-only:")) {
      console.log(c.dim(`  Not removing anything. These need the repo's own worktree-down.sh so the`));
      console.log(c.dim(`  per-ticket database goes with the checkout.`));
    }
    return;
  }
  for (const t of result.removed) console.log(`    ${c.green("removed")} ${t}`);
  for (const t of result.refused) console.log(`    ${c.yellow("kept")}    ${t.id} — ${t.reason}`);
  console.log(`\n  ${result.removed.length} removed, ${result.refused.length} kept (unpushed or uncommitted work).`);
}

async function main() {
  const { apply: APPLY, gate: GATE, json: JSON_OUT, only } = parseArgs(process.argv.slice(2));
  const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
  const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));
  if (!repos.length) { console.error("no matching repo in config/repos.yaml"); process.exit(2); }

  const quiet = JSON_OUT || GATE;

  // Keep a lightweight per-repo run marker. Unlike worktree discovery this does
  // not depend on there being an orphan, so `factory status` can accurately say
  // when the janitor was last invoked even when it found nothing.
  if (!GATE) {
    try {
      const logDir = path.join(homedir(), ".factory/logs");
      mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
      for (const repo of repos) appendFileSync(path.join(logDir, `janitor-${repo.name}-${stamp}.log`), `${new Date().toISOString()} ${APPLY ? "apply" : "dry"}\n`);
    } catch { /* observability must never block safe cleanup */ }
  }

  const surveys = [];
  for (const repo of repos) {
    // `--gate` is a probe: it must never tear down, even if `--apply` is also set.
    const result = await survey(repo, { apply: APPLY && !GATE });
    surveys.push(result);
    // Lifecycle observation (WM-75): fire-and-forget, day-scoped id so a
    // re-run reports the same removal once but a later worktree for the same
    // ticket is a new event.
    for (const t of result.removed) {
      await emitFactoryEvent("factory.worktree.reclaimed",
        { repo: repo.name, ticket: t },
        { eventId: `janitor:${repo.name}:${t}:${new Date().toISOString().slice(0, 10)}`, subject: t });
    }
    if (GATE) continue;
    if (!quiet) printHuman(repo, result);
  }

  if (GATE) {
    const totalReclaimable = surveys.reduce((n, s) => n + s.reclaimable.length, 0);
    if (totalReclaimable > 0) { console.log(`${totalReclaimable} reclaimable worktree(s)`); process.exit(0); }
    console.log("no worktrees to reclaim");
    process.exit(1);
  }

  if (JSON_OUT) {
    // One `--repo` is the API's contract (a single selected project). Several
    // names wrap in `{ results }` so a human ` --repo a,b --json` still parses.
    const payload = surveys.length === 1 ? surveys[0] : { apply: APPLY, results: surveys };
    console.log(JSON.stringify(payload));
  } else {
    console.log();
  }
}

if (import.meta.main || process.argv[1]?.endsWith("janitor.mjs")) await main();
