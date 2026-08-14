#!/usr/bin/env bun
/**
 * Reclaim stale agent claims in Linear.
 *
 * An agent that crashes mid-ticket leaves the issue in `In Progress` with itself as
 * assignee, forever. No other agent will touch it (it looks like a live claim) and
 * no human will notice (it looks like work in flight). This script reaps those.
 *
 * Only tickets carrying the claim markers (`ai:in-progress` / `agent:*`) count as
 * agent claims. A human working a ticket in `In Progress` without commenting is not
 * a stale claim, and unassigning their work would do far more damage than the
 * crashed agent this exists to clean up.
 *
 * A claim is stale when the newest of {last comment, startedAt} is older than the
 * threshold. The protocol in docs/orgs/linear.md requires a heartbeat at every phase
 * change and at least every 20 minutes, so 45 minutes of silence means the agent is
 * gone.
 *
 * Dry-run by default. Nothing is written without --apply.
 *
 *     bun orchestrator/reaper.mjs                     # show stale claims
 *     bun orchestrator/reaper.mjs --apply             # reclaim them
 *     bun orchestrator/reaper.mjs --minutes 90        # different threshold
 *     bun orchestrator/reaper.mjs --team CW --apply   # one team
 *     bun orchestrator/reaper.mjs --any-assignee      # audit unlabeled ones too
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { emitFactoryEvent } from "../lib/emit-event.mjs";

export const REAPER_LOG_DIR = path.join(homedir(), ".factory/logs");

/**
 * When the reaper last ran, from its own log files' mtimes — null when never.
 * run.mjs uses this at startup to decide whether the factory has been off
 * long enough that stale claims may have piled up unreaped.
 */
export function latestReaperRunMs(logDir = REAPER_LOG_DIR) {
  let best = null;
  try {
    for (const f of readdirSync(logDir)) {
      if (!/^reaper-\d{8}-\d{6}\.log$/.test(f)) continue;
      const m = statSync(path.join(logDir, f)).mtimeMs;
      if (best === null || m > best) best = m;
    }
  } catch { /* no log dir yet */ }
  return best;
}

/**
 * Tee console output to ~/.factory/logs/reaper-<stamp>.log so every run —
 * supervisor tick, watch.jsx keybinding, or bare CLI — leaves a record. A
 * reclaim nobody was watching used to leave no trace beyond the Linear
 * comment. Logging must never break the run: append failures are swallowed.
 */
function teeToLogFile() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const file = path.join(REAPER_LOG_DIR, `reaper-${stamp}.log`);
  try { mkdirSync(REAPER_LOG_DIR, { recursive: true }); } catch { return; }
  const wrap = (orig) => (...args) => {
    orig(...args);
    try { appendFileSync(file, args.join(" ") + "\n"); } catch { /* keep running */ }
  };
  console.log = wrap(console.log.bind(console));
  console.error = wrap(console.error.bind(console));
}

export const IN_PROGRESS = "in progress";
export const RECLAIM_TO = "todo";
export const HEARTBEAT_LABEL = "ai:in-progress";
export const AGENT_LABEL_PREFIX = "agent:";
const LINEAR_API_URL = "https://api.linear.app/graphql";

function loadEnv() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;

  const envPaths = [
    path.join(homedir(), "Develop/hdkiller/.env"),
    path.join(process.cwd(), ".env"),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
            const idx = trimmed.indexOf("=");
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return process.env.LINEAR_API_KEY || null;
}

export function getApiKey() {
  const key = loadEnv();
  if (!key) {
    console.error("Linear API error: LINEAR_API_KEY not found in env or ~/Develop/hdkiller/.env");
    process.exit(1);
  }
  return key;
}

export async function gql(query, variables = {}, retries = 5) {
  const apiKey = getApiKey();
  const headers = {
    "Content-Type": "application/json",
    Authorization: apiKey,
  };
  const body = JSON.stringify({ query, variables });
  let delay = 1000;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers,
        body,
      });

      if (!res.ok) {
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, delay));
          delay *= 2;
          continue;
        }
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();
      if (data.errors && data.errors.length > 0) {
        const msg = JSON.stringify(data.errors);
        if (msg.toUpperCase().includes("RATELIMITED") && attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, delay));
          delay *= 2;
          continue;
        }
        throw new Error(msg);
      }

      return data.data || {};
    } catch (err) {
      if (attempt < retries - 1 && !(err.message && err.message.startsWith("HTTP 4"))) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Exhausted retries");
}

export function parseTs(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export async function fetchTeams() {
  const q = `
    query {
      teams(first: 25) {
        nodes { id key states(first: 30) { nodes { id name } } }
      }
    }
  `;
  const data = await gql(q);
  const result = {};
  for (const t of data.teams?.nodes || []) {
    const states = {};
    for (const s of t.states?.nodes || []) {
      states[s.name.toLowerCase()] = s.id;
    }
    result[t.key] = { id: t.id, states };
  }
  return result;
}

/**
 * The Linear filter for one reaper run. Pure and exported so the two questions
 * this script asks stay testable without a network call.
 *
 * Default: the UNION of both claim signals — any ticket carrying
 * `ai:in-progress` in ANY state, plus anything sitting in `In Progress`.
 *
 * The union is the point. Querying the heartbeat label alone (what this did
 * until OPS-63) contradicted isAgentClaim(), which also accepts `agent:*`: a
 * ticket claimed with `agent:claude-code` but no heartbeat label — exactly what
 * a run that dies before its first heartbeat leaves behind — was never fetched
 * and so could never be reaped, however long it sat. CLNT-688 sat that way for
 * 190 minutes while the reaper reported "no stale claims".
 *
 * The label half of the union is still needed alongside the state half: triage
 * claims tickets while specifying them and leaves them in `Triage`, so a
 * crashed triage run strands `ai:in-progress` on a ticket no state-based query
 * ever looks at.
 *
 * Widening the fetch does NOT widen what gets reclaimed. main() still filters
 * everything through isAgentClaim() before touching it, so a human's In
 * Progress ticket is fetched, counted in the "skipping N" line, and left alone.
 *
 * --any-assignee: the audit view exists specifically to see In Progress work
 * REGARDLESS of any agent label — including a human's. It skips the
 * isAgentClaim() pre-filter in main() rather than the query, which is what
 * still makes it different from the default now that the default includes
 * In Progress.
 */
export function buildIssueFilter(teamKey = null, anyAssignee = false) {
  const team = teamKey ? `, team: { key: { eq: "${teamKey}" } }` : "";
  if (anyAssignee) return `state: { name: { eq: "In Progress" } }${team}`;
  return `or: [ { labels: { name: { eq: "${HEARTBEAT_LABEL}" } } }, { state: { name: { eq: "In Progress" } } } ]${team}`;
}

export async function fetchInProgress(teamKey = null, anyAssignee = false) {
  const filter = buildIssueFilter(teamKey, anyAssignee);
  const q = `
    query {
      issues(first: 250, filter: { ${filter} }) {
        nodes {
          id identifier title url startedAt updatedAt
          team { key }
          state { name }
          assignee { id name }
          labels(first: 20) { nodes { id name } }
          comments(last: 1) { nodes { createdAt } }
        }
      }
    }
  `;
  const data = await gql(q);
  return data.issues?.nodes || [];
}

export function isAgentClaim(issue) {
  const labels = issue.labels?.nodes || [];
  const names = labels.map((l) => (l.name || "").toLowerCase());
  return names.some(
    (n) => n === HEARTBEAT_LABEL || n.startsWith(AGENT_LABEL_PREFIX)
  );
}

export function lastActivity(issue) {
  const stamps = [];
  const started = parseTs(issue.startedAt);
  if (started) stamps.push(started);

  const comments = issue.comments?.nodes || [];
  if (comments.length > 0) {
    const lastCommentTs = parseTs(comments[comments.length - 1].createdAt);
    if (lastCommentTs) stamps.push(lastCommentTs);
  }

  if (stamps.length > 0) {
    return new Date(Math.max(...stamps.map((d) => d.getTime())));
  }

  return parseTs(issue.updatedAt);
}

export async function reclaim(issue, todoStateId, minutes, apply, quiet = false) {
  const labels = issue.labels?.nodes || [];
  const keep = labels
    .filter((l) => {
      const name = (l.name || "").toLowerCase();
      return name !== HEARTBEAT_LABEL && !name.startsWith(AGENT_LABEL_PREFIX);
    })
    .map((l) => l.id);

  if (!apply) return;

  // Two different repairs, because the two claims mean different things.
  //
  // In Progress: an implementation claim. The agent is gone, so the ticket goes
  // back to Todo, unassigned, ready for someone else.
  //
  // Any other state: a stale claim MARKER (triage claims while specifying and
  // leaves the state at Triage). Strip the labels only — the assignee on a
  // Triage or Todo ticket is more likely a human's deliberate assignment than
  // an agent's leftover, and while agents share the human's Linear identity
  // (OPS-40) the two are indistinguishable. Removing the label is unambiguous
  // and sufficient; clearing the assignee would be guessing.
  const input = { labelIds: keep };
  if (todoStateId) { input.stateId = todoStateId; input.assigneeId = null; }

  await gql(
    `
    mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
    `,
    { id: issue.id, input }
  );

  // Clearing a stale marker off a finished ticket needs no audit trail — 50
  // comments on Done tickets is noise, not a record.
  if (quiet) return;

  const who = issue.assignee?.name || "an agent";
  const body =
    `**Reclaimed by the stale-claim reaper.**\n\n` +
    `This ticket was claimed by ${who} with no heartbeat for over ${minutes} ` +
    `minutes, so the claim was presumed abandoned. ` +
    (todoStateId
      ? `It has been unassigned and returned to \`Todo\`.`
      : `Its \`ai:in-progress\` marker was cleared; state and assignee are unchanged.`) +
    `\n\n` +
    `If the agent is still working, it must re-claim the ticket before ` +
    `continuing — see the claim protocol in \`docs/orgs/linear.md\`.`;

  await gql(
    `
    mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }
    `,
    {
      input: {
        issueId: issue.id,
        body,
      },
    }
  );
}

export function parseArgs(argv = process.argv.slice(2)) {
  let apply = false;
  let minutes = 45;
  let team = null;
  let anyAssignee = false;
  let markersOnly = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--minutes") {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val > 0) minutes = val;
    } else if (arg === "--team") {
      team = argv[++i] || null;
    } else if (arg === "--any-assignee") {
      anyAssignee = true;
    } else if (arg === "--markers-only") {
      markersOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { apply, minutes, team, anyAssignee, markersOnly, help };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Reclaim stale agent claims in Linear.

Usage:
  bun orchestrator/reaper.mjs [options]

Options:
  --apply          Actually reclaim tickets (default is dry-run)
  --minutes <N>    Silence threshold before a claim is stale (default: 45)
  --team <KEY>     Limit reaping to a single team key (e.g. CW)
  --any-assignee   Audit all In Progress tickets regardless of agent claim labels
  --markers-only   Only clear stale ai:in-progress markers from tickets that are
                   NOT In Progress (finished or unstarted work whose claim label
                   was never removed). Never touches running work — pure
                   cleanup, so "Agents In Flight" means what it says.
  -h, --help       Show this help message
`);
    process.exit(0);
  }

  teeToLogFile();

  const mode = args.apply ? "APPLY" : "DRY RUN";
  console.log(`=== Stale-claim reaper [${mode}] threshold=${args.minutes}min${args.team ? ` team=${args.team}` : ""} ===\n`);

  const teams = await fetchTeams();
  let issues = await fetchInProgress(args.team, args.anyAssignee);
  const now = new Date();
  const cutoff = new Date(now.getTime() - args.minutes * 60 * 1000);

  if (!args.anyAssignee) {
    const claims = issues.filter(isAgentClaim);
    const skipped = issues.length - claims.length;
    if (skipped > 0) {
      console.log(`  (skipping ${skipped} In Progress ticket(s) with no agent claim labels -- not agent work)\n`);
    }
    issues = claims;
  }

  const stale = [];
  const live = [];

  for (const issue of issues) {
    const seen = lastActivity(issue);
    if (seen && seen < cutoff) {
      stale.push({ issue, seen });
    } else {
      live.push({ issue, seen });
    }
  }

  for (const { issue, seen } of live) {
    const age = seen ? Math.floor((now.getTime() - seen.getTime()) / 60000).toString() : "?";
    const who = issue.assignee?.name || "unassigned";
    const id = (issue.identifier || "").padEnd(10);
    const ageStr = age.padStart(4);
    const whoStr = who.padEnd(16);
    const titleStr = (issue.title || "").slice(0, 44);
    console.log(`  ok    ${id} ${ageStr}m  ${whoStr} ${titleStr}`);
  }

  if (stale.length === 0) {
    console.log(`\n=== No stale claims among ${issues.length} in progress. ===`);
    return;
  }

  console.log();
  const considered = args.markersOnly
    ? stale.filter(({ issue }) => (issue.state?.name || "").toLowerCase() !== IN_PROGRESS)
    : stale;
  if (args.markersOnly && considered.length !== stale.length) {
    console.log(`  (markers-only: leaving ${stale.length - considered.length} In Progress claim(s) alone)\n`);
  }

  for (const { issue, seen } of considered) {
    const age = seen ? Math.floor((now.getTime() - seen.getTime()) / 60000).toString() : "?";
    const who = issue.assignee?.name || "unassigned";
    const id = (issue.identifier || "").padEnd(10);
    const ageStr = age.padStart(4);
    const whoStr = who.padEnd(16);
    const titleStr = (issue.title || "").slice(0, 44);
    console.log(`  STALE ${id} ${ageStr}m  ${whoStr} ${titleStr}`);

    // Enforced here, not just by the upstream fetch: --any-assignee queries by
    // state so it can show human work for audit purposes, which means a stale
    // ticket in `considered` may not be an agent claim at all. Unassigning a
    // human's ticket because they didn't comment in 45 minutes would be far
    // worse than the crashed agent this reaper exists to clean up after.
    if (!isAgentClaim(issue)) {
      console.log(`        (no agent claim label — a human's work, not touching it)`);
      continue;
    }

    const teamKey = issue.team?.key;
    const team = teams[teamKey];
    const stateName = (issue.state?.name || "").toLowerCase();

    // An implementation claim goes back to Todo so it can be picked up again.
    // A triage claim (any other state) only loses its markers — moving a ticket
    // that was mid-specification into Todo would assert it is ready when it is
    // not.
    const todoId = stateName === IN_PROGRESS ? team?.states?.[RECLAIM_TO] : null;
    if (stateName === IN_PROGRESS && !todoId) {
      console.log(`        ! no '${RECLAIM_TO}' state on team ${teamKey}, skipping`);
      continue;
    }

    try {
      await reclaim(issue, todoId, args.minutes, args.apply, !todoId);
    } catch (err) {
      console.log(`        ! failed: ${err.message || err}`);
      continue;
    }

    if (args.apply) {
      console.log(`        -> unassigned, returned to Todo`);
      // Lifecycle observation (WM-75): fire-and-forget; the last-activity
      // timestamp keys the id, so retrying the same stale claim re-admits
      // nothing while the next genuine reap is a new event.
      await emitFactoryEvent("factory.ticket.reaped",
        { ticket: issue.identifier, reason: todoId ? "returned_to_todo" : "marker_cleared" },
        { eventId: `reap:${issue.identifier}:${seen?.getTime() ?? "unknown"}`, subject: issue.identifier });
    }
  }

  console.log(
    `\n=== ${args.apply ? "Reclaimed" : "Would reclaim"}: ${considered.length} | Healthy: ${live.length} ===`
  );
  if (!args.apply) {
    console.log("Run again with --apply to reclaim these.");
  }
}

if (import.meta.main || process.argv[1]?.endsWith("reaper.mjs")) {
  main().catch((err) => {
    console.error(`Linear API error: ${err.message || err}`);
    process.exit(1);
  });
}
