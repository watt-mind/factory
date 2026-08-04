#!/usr/bin/env bun
/**
 * Where is the loop right now?
 *
 *   bun orchestrator/queue.mjs              # every configured repo
 *   bun orchestrator/queue.mjs --repo bj29
 *
 * Read-only. This is the `dry_command` for all three agent stages, so "what
 * would this job do" never means "spawn an agent and find out" — it means look
 * at the queue the job would draw from.
 *
 * It also answers the question that actually governs throughput: is the factory
 * about to idle? A deep Triage pile with an empty agent-ready queue means the
 * constraint is specification, not execution, and dispatching harder won't help.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths, pathsCollide } from "./owned-paths.mjs";
import { budgetExhausted } from "../lib/spend.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const only = (val("--repo") || "").split(",").map((s) => s.trim()).filter(Boolean);

// --gate <stage> turns this into a cheap predicate: exit 0 when that stage has
// work, 1 when it doesn't. That is what makes the loop continuous without being
// expensive — polling costs one Linear query, spawning an agent costs budget, so
// the supervisor checks often and acts only when there is something to do.
const GATE = val("--gate");
const JSON_OUT = argv.includes("--json");

const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const policy = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/policy.yaml"), "utf8"));
const defaultCap = policy?.concurrency?.max_in_flight_per_repo ?? 3;
const repos = (cfg.repos ?? []).filter((r) => !only.length || only.includes(r.name));

if (!repos.length) {
  console.error(only ? `no repo named "${only}" in config/repos.yaml` : "no repos configured");
  process.exit(2);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const QUERY = `
  query($team: String!, $project: String!) {
    issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        identifier title description priority url
        state { name type }
        assignee { name }
        labels(first: 20) { nodes { name } }
      }
    }
  }`;

// Finished work, for the done/total readout. Kept out of QUERY on purpose: the
// active-issue query feeds gates and dispatch decisions, and mixing hundreds of
// Done tickets into `nodes` would push live work past the 250-issue page long
// before the project gets big enough to notice any other way.
const CLOSED_QUERY = `
  query($team: String!, $project: String!) {
    issues(first: 250, filter: {
      team: { key: { eq: $team } },
      project: { name: { eq: $project } },
      state: { type: { in: ["completed", "canceled"] } }
    }) {
      nodes { state { type } }
    }
  }`;

/**
 * Open PRs that a merge run could actually act on: not drafts, and not already
 * escalated to a human. Returns [] rather than throwing when `gh` is missing or
 * unauthenticated — a gate that hard-fails takes the whole supervisor loop down
 * with it, and being unable to see GitHub is not the same as having no work.
 */
async function openMergeCandidates(nameWithOwner) {
  const p = Bun.spawnSync(["gh", "pr", "list", "--repo", nameWithOwner, "--state", "open",
    "--json", "number,isDraft,labels,title"]);
  if (p.exitCode !== 0) return [];
  try {
    return JSON.parse(p.stdout.toString())
      .filter((pr) => !pr.isDraft)
      .filter((pr) => !(pr.labels ?? []).some((l) => l.name === "escalated"));
  } catch { return []; }
}

const summary = [];

for (const repo of repos) {
  if (!GATE && !JSON_OUT) console.log(c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project}  ->  ${repo.base}`));

  const nodes = (await gql(QUERY, { team: repo.team, project: repo.project }))?.issues?.nodes ?? [];
  const closed = (await gql(CLOSED_QUERY, { team: repo.team, project: repo.project }))?.issues?.nodes ?? [];
  const done = closed.filter((i) => i.state?.type === "completed").length;
  const total = nodes.length + closed.length;
  // Either page hitting its 250 cap means these are floors, not counts.
  const countCapped = nodes.length === 250 || closed.length === 250;
  const labels = (i) => (i.labels?.nodes ?? []).map((l) => l.name);
  const state = (i) => i.state?.name ?? "?";

  // `ai:blocked` in Triage means a previous tick already decided this one needs
  // a human. Counting it as triage work is how the stage ends up re-deriving
  // the same hold every 5 minutes — the same shape as the merge stage
  // re-reviewing escalated PRs. It reappears the moment the label comes off.
  const triage = nodes.filter((i) => state(i) === "Triage" && !labels(i).includes("ai:blocked"));
  const triageHeld = nodes.filter((i) => state(i) === "Triage" && labels(i).includes("ai:blocked"));
  const ready = nodes.filter((i) => state(i) === "Todo" && labels(i).includes("ai:agent-ready") && !i.assignee);
  const notReady = nodes.filter((i) => state(i) === "Todo" && !labels(i).includes("ai:agent-ready"));
  const inProgress = nodes.filter((i) => state(i) === "In Progress");
  const inReview = nodes.filter((i) => state(i) === "In Review");
  const blocked = nodes.filter((i) => state(i) === "Blocked");

  // GitHub is the source of truth for what is waiting to merge, not Linear.
  // Gating the merge stage on `In Review` tickets meant a finished PR whose
  // ticket was never moved out of `In Progress` was invisible to it forever:
  // it held a dispatch slot AND never got reviewed. Two of bj29's three slots
  // sat that way for 13 hours with green-ish PRs open.
  //
  // `escalated` is the escape hatch that keeps this from becoming an infinite
  // poll: a PR the merge stage handed back to a human stays open by design, and
  // without the label every tick would re-review it and re-escalate. The merge
  // command applies the label when it escalates.
  const openPRs = repo.github ? await openMergeCandidates(repo.github) : [];

  const quiet = GATE || JSON_OUT;
  const line = (label, n, color = (s) => s) => {
    if (!quiet) console.log(`  ${label.padEnd(22)} ${color(String(n).padStart(3))}`);
  };

  line("Triage (unspecified)", triage.length, triage.length > 20 ? c.yellow : (s) => s);
  if (triageHeld.length) line("Triage, held for you", triageHeld.length, c.red);
  line("Todo, not ready", notReady.length);
  line("READY to dispatch", ready.length, ready.length ? c.green : c.red);
  line("In Progress", inProgress.length);
  line("In Review", inReview.length, inReview.length ? c.cyan : (s) => s);
  line("Blocked", blocked.length, blocked.length ? c.red : (s) => s);
  line("Done / project total", `${done}/${total}${countCapped ? "+" : ""}`, c.dim);

  // What dispatch would actually pick up, honouring Owned Paths against what is
  // already running. Sorted the way §7 sorts: priority asc, then created asc.
  //
  // report_only repos have no worktree tooling — dispatch must never target
  // them (see config/repos.yaml). Forcing slotsFree to 0 here is what keeps
  // the dispatch gate closed for them; without it the gate reports "work
  // available" from Linear state alone, run.mjs spawns tick.mjs, and tick.mjs
  // immediately exits 2 because the repo can't be dispatched — a FAIL every
  // tick for a repo that was never eligible to begin with.
  const inFlightPaths = inProgress.flatMap((i) => parseOwnedPaths(i.description ?? ""));
  const sorted = [...ready].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  const slotsFree = repo.report_only ? 0 : Math.max(0, (repo.max_in_flight ?? defaultCap) - inProgress.length);
  const free = [];
  const busyPaths = [...inFlightPaths];
  for (const t of sorted) {
    if (free.length >= slotsFree) break;
    const own = parseOwnedPaths(t.description ?? "");
    if (!own.length) continue;                       // no Owned Paths => not dispatchable
    if (pathsCollide(own, busyPaths)) continue;      // would collide with running work
    free.push(t);
    busyPaths.push(...own);                          // later tickets must clear this one too
  }

  summary.push({
    repo: repo.name,
    // Team key, so the monitor can scope actions like the reaper without
    // re-reading config/repos.yaml itself.
    team: repo.team,
    done,
    total,
    countCapped,
    triage: triage.length + notReady.length,
    // Triage-state only. The stage processes Triage tickets; gating on the
    // combined count kept the gate open for Todo-without-agent-ready tickets
    // the stage never touches, spawning a no-op agent every tick.
    triageState: triage.length,
    ready: ready.length,
    inProgress: inProgress.length,
    inReview: inReview.length,
    openPRs: openPRs.length,
    blocked: blocked.length,
    slotsFree,
    startable: free.map((t) => t.identifier),
    // Identifier + title + url — enough for a monitor (orchestrator/watch.jsx)
    // to render a ticket list and deep-link into Linear without re-querying
    // Linear itself.
    inProgressTickets: inProgress.map((t) => ({ identifier: t.identifier, title: t.title, url: t.url })),
    inReviewTickets: inReview.map((t) => ({ identifier: t.identifier, title: t.title, url: t.url })),
    blockedTickets: blocked.map((t) => ({ identifier: t.identifier, title: t.title, url: t.url })),
  });

  if (quiet) continue;

  if (free.length) {
    console.log(c.dim(`\n  dispatch would start (cap ${repo.max_in_flight}, ${inProgress.length} running, ${slotsFree} slot(s) free):`));
    for (const t of free) console.log(`    ${c.green(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`);
  } else if (repo.report_only && ready.length) {
    console.log(c.dim(`\n  report_only — dispatch is disabled here by design (${ready.length} ready ticket(s) would otherwise start)`));
  } else if (ready.length && slotsFree === 0) {
    // Distinguish "no room" from "nothing fits". Reporting the Owned Paths
    // reason when the cap is simply full sends you reading glob sets for a
    // problem that is a full slot table.
    console.log(c.dim(`\n  no free slot — ${inProgress.length}/${repo.max_in_flight ?? defaultCap} in flight, ${ready.length} ready and waiting`));
    for (const t of inProgress) console.log(c.dim(`    holding: ${t.identifier.padEnd(10)} ${t.title.slice(0, 55)}`));
  } else if (ready.length) {
    console.log(c.dim(`\n  nothing startable — all ready tickets collide with running work or lack Owned Paths`));
  } else {
    console.log(c.dim(`\n  queue empty — the constraint is specification, not dispatch.`));
    console.log(c.dim(`  ${triage.length} ticket(s) in Triage. Run the triage stage.`));
  }

  if (inReview.length) {
    console.log(c.dim(`\n  awaiting review/merge:`));
    for (const t of inReview) console.log(`    ${c.cyan(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`);
  }
  if (openPRs.length) {
    console.log(c.dim(`\n  open PRs the merge stage would look at:`));
    for (const pr of openPRs) console.log(`    ${c.cyan(("#" + pr.number).padEnd(10))} ${pr.title.slice(0, 60)}`);
  }
  if (blocked.length) {
    console.log(c.red(`\n  BLOCKED — needs a human:`));
    for (const t of blocked) console.log(`    ${t.identifier.padEnd(10)} ${t.title.slice(0, 60)}`);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (GATE) {
  // The day budget binds EVERY stage that spawns an agent, not just dispatch.
  // Gating it in tick.mjs alone inverted the intent: over budget, the stage
  // that makes progress stopped while triage and merge kept spawning opus
  // sessions on their timers.
  const spent = budgetExhausted(policy);
  if (spent) {
    console.log(`${spent} — no ${GATE} this tick. Running work finishes; nothing new starts.`);
    process.exit(1);
  }

  // Exit 0 = there is work for this stage, so the supervisor should run it.
  // Exit 1 = idle, skip. Anything else is a real error and stops the loop.
  const has = {
    // Only spawn a triage agent when a Triage-STATE ticket is waiting — the
    // stage never touches Todo tickets, ready or not.
    triage: (s) => s.triageState > 0,
    // Don't dispatch with no free slot or nothing startable — an agent that
    // wakes to find the cap full has burned a run to learn nothing.
    dispatch: (s) => s.slotsFree > 0 && s.startable.length > 0,
    // A PR waiting on GitHub is the work, whatever its ticket says — and
    // `openPRs` already excludes drafts and anything labelled `escalated`.
    //
    // This deliberately does NOT also fire on `In Review` tickets. It used to,
    // and that silently defeated the escalated-label escape hatch: an escalated
    // PR keeps its ticket In Review by design, so the gate stayed open and the
    // merge stage re-reviewed the same two PRs every 10 minutes — seven ticks,
    // ~$1.37 each, producing no new information and no way to stop short of
    // closing the PR. An In Review ticket with no actionable PR is drift for
    // the reconciler to explain, not merge work.
    merge: (s) => s.openPRs > 0,
  }[GATE];

  if (!has) {
    console.error(`unknown gate "${GATE}" (known: triage, dispatch, merge)`);
    process.exit(2);
  }

  const hits = summary.filter(has);
  if (hits.length) {
    console.log(hits.map((s) => `${s.repo}: ${GATE} work available`).join("; "));
    process.exit(0);
  }
  console.log(`no ${GATE} work in ${summary.map((s) => s.repo).join(", ")}`);
  process.exit(1);
}

console.log();
