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
 * threshold. The protocol in docs/protocol.md requires a heartbeat at every phase
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

import {
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { emitFactoryEvent } from "../lib/emit-event.mjs";
import { loadControlPlane } from "../lib/control-plane/index.mjs";
import { loadRepos } from "../event-runtime/lib/repos.mjs";
import { dbPath } from "../event-runtime/lib/config.mjs";
import { HEARTBEAT_STALE_MS } from "../event-runtime/lib/workers.mjs";
import { ticketSlug } from "../lib/ticket-slug.mjs";
import {
  assertLinearNetworkAllowed,
  parseRateLimitReset,
} from "../tools/ticket.mjs";

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
  } catch {
    /* no log dir yet */
  }
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
  try {
    mkdirSync(REAPER_LOG_DIR, { recursive: true });
  } catch {
    return;
  }
  const wrap =
    (orig) =>
    (...args) => {
      orig(...args);
      try {
        appendFileSync(file, args.join(" ") + "\n");
      } catch {
        /* keep running */
      }
    };
  console.log = wrap(console.log.bind(console));
  console.error = wrap(console.error.bind(console));
}

export const IN_PROGRESS = "in progress";
export const RECLAIM_TO = "todo";
export const HEARTBEAT_LABEL = "ai:in-progress";
export const AGENT_LABEL_PREFIX = "agent:";
export const AGENT_READY_LABEL = "ai:agent-ready";
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
            const val = trimmed
              .slice(idx + 1)
              .trim()
              .replace(/^['"]|['"]$/g, "");
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
    console.error(
      "Linear API error: LINEAR_API_KEY not found in env or ~/Develop/hdkiller/.env",
    );
    process.exit(1);
  }
  return key;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Linear request aborted");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function retryDelay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(abortReason(signal));
    function done(error) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function rateLimitError(message, response) {
  // Linear's reset header is a raw unix epoch; downstream consumers
  // (Date.parse in the planner cache, budget.json) expect ISO-8601.
  const resetAt = parseRateLimitReset(
    response?.headers?.get("x-ratelimit-requests-reset"),
  );
  const error = new Error(
    `linear_rate_limited: resetAt=${resetAt ?? "unknown"}${message ? `: ${message}` : ""}`,
  );
  error.rateLimited = true;
  error.resetAt = resetAt;
  return error;
}

/**
 * Send a Linear GraphQL request, retrying transient responses unless cancelled.
 *
 * A failed or timed-out mutation has an unknown server outcome: Linear may have
 * committed a non-idempotent create/comment before this client observes the
 * failure. Callers must inspect the resulting resource instead of replaying it.
 */
export async function gql(
  query,
  variables = {},
  retriesOrOptions = 5,
  legacySignal,
) {
  const options =
    typeof retriesOrOptions === "number"
      ? { retries: retriesOrOptions, signal: legacySignal }
      : retriesOrOptions instanceof AbortSignal
        ? { retries: 5, signal: retriesOrOptions }
        : (retriesOrOptions ?? {});
  const { retries = 5, signal } = options;
  // This must precede credential loading: offline/test invocations should
  // explain the deterministic network refusal, not report a missing key.
  assertLinearNetworkAllowed(LINEAR_API_URL);
  const apiKey = getApiKey();
  const headers = {
    "Content-Type": "application/json",
    Authorization: apiKey,
  };
  const body = JSON.stringify({ query, variables });
  let delay = 1000;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      throwIfAborted(signal);
      const res = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers,
        body,
        signal,
      });

      if (!res.ok) {
        if (res.status === 429) {
          throw rateLimitError((await res.text()).slice(0, 500), res);
        }
        if (
          [500, 502, 503, 504].includes(res.status) &&
          attempt < retries - 1
        ) {
          await retryDelay(delay, signal);
          delay *= 2;
          continue;
        }
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();
      if (data.errors && data.errors.length > 0) {
        const msg = JSON.stringify(data.errors);
        if (msg.toUpperCase().includes("RATELIMITED"))
          throw rateLimitError(msg, res);
        throw new Error(msg);
      }

      return data.data || {};
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal);
      if (err?.code === "linear_offline_guard") throw err;
      if (err?.rateLimited) throw err;
      if (
        attempt < retries - 1 &&
        !(err.message && err.message.startsWith("HTTP 4"))
      ) {
        await retryDelay(delay, signal);
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
  const labels = Array.isArray(issue.labels)
    ? issue.labels
    : issue.labels?.nodes || [];
  const names = labels.map((l) => (l.name || "").toLowerCase());
  return names.some(
    (n) => n === HEARTBEAT_LABEL || n.startsWith(AGENT_LABEL_PREFIX),
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

  const lastComment = parseTs(issue.lastCommentAt);
  if (lastComment) stamps.push(lastComment);

  if (stamps.length > 0) {
    return new Date(Math.max(...stamps.map((d) => d.getTime())));
  }

  return parseTs(issue.updatedAt);
}

export async function fetchAgentReadyLabelId() {
  const q = `query { issueLabels(first: 250) { nodes { id name } } }`;
  const data = await gql(q);
  const node = (data.issueLabels?.nodes || []).find(
    (l) => (l.name || "").toLowerCase() === AGENT_READY_LABEL,
  );
  return node?.id || null;
}

export function computeReclaimLabelIds(
  issue,
  isReturningToTodo,
  agentReadyLabelId = null,
) {
  const labels = issue.labels?.nodes || [];
  const keep = labels
    .filter((l) => {
      const name = (l.name || "").toLowerCase();
      return name !== HEARTBEAT_LABEL && !name.startsWith(AGENT_LABEL_PREFIX);
    })
    .map((l) => l.id);

  if (
    isReturningToTodo &&
    agentReadyLabelId &&
    !keep.includes(agentReadyLabelId)
  ) {
    keep.push(agentReadyLabelId);
  }
  return keep;
}

export async function reclaim(
  issue,
  todoStateId,
  minutes,
  apply,
  quiet = false,
  agentReadyLabelId = null,
) {
  if (todoStateId && !agentReadyLabelId && apply) {
    try {
      agentReadyLabelId = await fetchAgentReadyLabelId();
    } catch {
      /* intentionally ignored */
    }
  }

  const keep = computeReclaimLabelIds(
    issue,
    Boolean(todoStateId),
    agentReadyLabelId,
  );

  if (!apply)
    return {
      labelIds: keep,
      stateId: todoStateId,
      assigneeId: todoStateId ? null : undefined,
    };

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
  if (todoStateId) {
    input.stateId = todoStateId;
    input.assigneeId = null;
  }

  await gql(
    `
    mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
    `,
    { id: issue.id, input },
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
    `continuing — see the claim protocol in \`docs/protocol.md\`.`;

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
    },
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

function claimLabelsFor(issue) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels
    : issue.labels?.nodes || [];
  return labels
    .map((label) => label.name)
    .filter((name) => {
      const lower = String(name).toLowerCase();
      return lower === HEARTBEAT_LABEL || lower.startsWith(AGENT_LABEL_PREFIX);
    });
}

function auditComment(issue, minutes, returnsToTodo) {
  const who = issue.assignee?.name || "an agent";
  return (
    `**Reclaimed by the stale-claim reaper.**\n\n` +
    `This ticket was claimed by ${who} with no heartbeat for over ${minutes} ` +
    `minutes, so the claim was presumed abandoned. ` +
    (returnsToTodo
      ? `It has been unassigned and returned to \`Todo\`.`
      : `Its \`ai:in-progress\` marker was cleared; state and assignee are unchanged.`) +
    `\n\n` +
    `If the agent is still working, it must re-claim the ticket before ` +
    `continuing — see the claim protocol in \`docs/protocol.md\`.`
  );
}

function formatTicket(prefix, issue, seen, now) {
  const age = seen
    ? Math.floor((now.getTime() - seen.getTime()) / 60000).toString()
    : "?";
  const who = issue.assignee?.name || "unassigned";
  const id = (issue.identifier || "").padEnd(10);
  return `  ${prefix} ${id} ${age.padStart(4)}m  ${who.padEnd(16)} ${(issue.title || "").slice(0, 44)}`;
}

/**
 * Plane-neutral reaper engine. Dependencies are injectable so selection,
 * failure and mutation behaviour can be tested without live trackers.
 */
export async function runReaper(
  args,
  {
    repos = loadRepos(),
    loadPlane = ({ repoName }) => loadControlPlane({ repoName }),
    now = new Date(),
    emit = emitFactoryEvent,
    log = (...values) => console.log(...values),
  } = {},
) {
  const cutoff = new Date(now.getTime() - args.minutes * 60 * 1000);
  const configured = [...repos.values()].filter(
    (repo) => repo.team && (!args.team || repo.team === args.team),
  );
  const seenIdentifiers = new Set();
  const totals = { considered: 0, healthy: 0, reclaimed: 0, failed: 0 };

  for (const repo of configured) {
    let plane;
    let listed;
    try {
      plane = loadPlane({ repoName: repo.name });
      listed = await plane.listTickets({
        team: repo.team,
        project: repo.project ?? undefined,
        states: args.anyAssignee ? ["In Progress"] : undefined,
        includeFinished: !args.anyAssignee,
      });
    } catch (err) {
      totals.failed += 1;
      log(`  ! ${repo.name}: control plane failed: ${err.message || err}`);
      continue;
    }

    // The old Linear query was a union: In Progress OR a claim marker. Keep
    // that exact candidate set after the adapter's tracker-neutral read.
    let issues = listed.filter(
      (issue) =>
        (issue.state?.name || "").toLowerCase() === IN_PROGRESS ||
        isAgentClaim(issue),
    );
    issues = issues.filter((issue) => {
      if (seenIdentifiers.has(issue.identifier)) return false;
      seenIdentifiers.add(issue.identifier);
      return true;
    });

    if (!args.anyAssignee) {
      const claims = issues.filter(isAgentClaim);
      const skipped = issues.length - claims.length;
      if (skipped > 0)
        log(
          `  (${repo.name}: skipping ${skipped} In Progress ticket(s) with no agent claim labels -- not agent work)\n`,
        );
      issues = claims;
    }

    for (const issue of issues) {
      const seen = lastActivity(issue);
      if (!seen || seen >= cutoff) {
        totals.healthy += 1;
        log(formatTicket("ok   ", issue, seen, now));
        continue;
      }
      if (
        args.markersOnly &&
        (issue.state?.name || "").toLowerCase() === IN_PROGRESS
      ) {
        log(`  (markers-only: leaving ${issue.identifier} alone)`);
        continue;
      }

      // Defence in depth for --any-assignee: humans are visible, never reaped.
      if (!isAgentClaim(issue)) {
        log(formatTicket("skip ", issue, seen, now));
        log(`        (no agent claim label — a human's work, not touching it)`);
        continue;
      }

      try {
        // This lookup runs in dry-run too: a protected ticket must not be
        // advertised as reclaimable. Any adapter error fails closed.
        if (await plane.hasOpenPullRequest(issue.identifier)) {
          log(formatTicket("skip ", issue, seen, now));
          log(`        (open pull request — not touching it)`);
          continue;
        }
      } catch (err) {
        totals.failed += 1;
        log(formatTicket("skip ", issue, seen, now));
        log(
          `        ! pull-request lookup failed closed: ${err.message || err}`,
        );
        continue;
      }

      totals.considered += 1;
      log(formatTicket("STALE", issue, seen, now));

      const returnsToTodo =
        (issue.state?.name || "").toLowerCase() === IN_PROGRESS;
      const remove = claimLabelsFor(issue);
      try {
        if (args.apply) {
          if (returnsToTodo) {
            await plane.transition(issue.identifier, "Todo", {
              add: [AGENT_READY_LABEL],
              remove,
              unassign: true,
            });
          } else {
            await plane.setLabels(issue.identifier, { remove });
          }
          // Preserve the existing Linear lifecycle: finished/triage marker
          // cleanup is deliberately quiet. The implementation reclaim is the
          // state-changing recovery that receives the audit trail.
          if (returnsToTodo)
            await plane.comment(
              issue.identifier,
              auditComment(issue, args.minutes, returnsToTodo),
            );
        }
      } catch (err) {
        totals.failed += 1;
        log(`        ! failed: ${err.message || err}`);
        continue;
      }

      if (args.apply) {
        totals.reclaimed += 1;
        log(
          returnsToTodo
            ? `        -> unassigned, returned to Todo`
            : `        -> claim marker cleared; state and assignee preserved`,
        );
        await emit(
          "factory.ticket.reaped",
          {
            ticket: issue.identifier,
            reason: returnsToTodo ? "returned_to_todo" : "marker_cleared",
          },
          {
            eventId: `reap:${issue.identifier}:${seen?.getTime() ?? "unknown"}`,
            subject: issue.identifier,
          },
        );
      }
    }
  }

  log(
    `\n=== ${args.apply ? "Reclaimed" : "Would reclaim"}: ${args.apply ? totals.reclaimed : totals.considered} | Healthy: ${totals.healthy} | Failures: ${totals.failed} ===`,
  );
  if (!args.apply) log("Run again with --apply to reclaim these.");
  return totals;
}

/**
 * Selects dead dispatch runs whose per-ticket worktree is safe to reclaim: a
 * FAILED run that has spent its whole attempt budget (so it will never retry)
 * and whose workspace is a worktree. Exported so the selection stays testable
 * without a live runtime ledger.
 *
 * This is the runtime half of WM-1066. The planner already excludes such a run
 * from the `same_ticket_worktree_held` block so a fresh dispatch can proceed;
 * this reclaims the stale tree it left behind so provisioning finds no stale
 * checkout and no operator `retry --force` is needed.
 */
export const DEAD_DISPATCH_WORKTREE_SQL = `
  SELECT run_id AS runId,
         json_extract(spec_json, '$.input.repo')   AS repo,
         json_extract(spec_json, '$.input.ticket') AS ticket
    FROM runs
   WHERE state = 'FAILED'
     AND json_extract(spec_json, '$.workspace.type') = 'worktree'
     AND json_extract(spec_json, '$.maxAttempts') IS NOT NULL
     AND attempts >= json_extract(spec_json, '$.maxAttempts')
     AND json_extract(spec_json, '$.input.repo') IS NOT NULL
     AND json_extract(spec_json, '$.input.ticket') IS NOT NULL
   ORDER BY run_id ASC`;

/**
 * True when a repo/ticket still has a live run besides the dead one — someone
 * may be actively holding the worktree, so it must be left alone. A
 * still-retryable FAILED sibling counts as live; an attempts-exhausted one does
 * not (mirrors the planner's liveRunForInput exclusion exactly).
 */
export function ticketHasLiveRun(db, repo, ticket) {
  const row = db
    .query(
      `SELECT 1 FROM runs
        WHERE state NOT IN ('COMPLETED','REFUSED','TIMED_OUT','CANCELLED')
          AND (
            state <> 'FAILED'
            OR json_extract(spec_json, '$.maxAttempts') IS NULL
            OR attempts < json_extract(spec_json, '$.maxAttempts')
          )
          AND json_extract(spec_json, '$.input.repo') = ?
          AND json_extract(spec_json, '$.input.ticket') = ?
        LIMIT 1`,
    )
    .get(repo, ticket);
  return Boolean(row);
}

/**
 * Reclaim worktrees stranded by dead (attempts-exhausted FAILED) dispatch runs.
 *
 * Teardown is delegated to the repo's own `worktree_down`, NEVER with --force:
 * a dirty or unpushed tree refuses and stays visible to the janitor, exactly
 * like the runtime's own completion teardown (WM-108). A worktree whose ticket
 * still has an open pull request is left alone (mirrors janitor WM-17), and the
 * pull-request lookup fails closed — a lookup error keeps the tree, never tears
 * it down blind.
 *
 * Dependencies are injectable so selection and teardown can be tested without a
 * live runtime database, a real filesystem, or spawning bash.
 */
export async function reapDeadDispatchWorktrees(
  args,
  {
    repos = loadRepos(),
    databasePath = dbPath(),
    openDatabase = (file) => new Database(file, { readonly: true }),
    fileExists = existsSync,
    spawn = spawnSync,
    hasOpenPullRequest = null,
    log = (...values) => console.log(...values),
  } = {},
) {
  const totals = { considered: 0, cleaned: 0, held: 0, failed: 0 };
  if (!fileExists(databasePath)) return totals;

  let db;
  try {
    db = openDatabase(databasePath);
  } catch (err) {
    totals.failed += 1;
    log(
      `  ! dead-dispatch worktree reap: ledger unreadable: ${err.message || err}`,
    );
    return totals;
  }

  try {
    const seen = new Set();
    for (const { runId, repo: repoName, ticket } of db
      .query(DEAD_DISPATCH_WORKTREE_SQL)
      .all()) {
      const key = `${repoName} ${ticket}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const repo = repos.get(repoName);
      if (!repo?.worktreeRoot || !repo?.worktreeDown || !repo?.path) {
        // The repo declares no worktree lifecycle — never ours to reclaim.
        continue;
      }
      let slug;
      try {
        slug = ticketSlug(ticket);
      } catch {
        // An unsluggable ticket never had a deterministic worktree path.
        continue;
      }
      const worktreePath = path.join(repo.worktreeRoot, slug);
      if (!fileExists(worktreePath)) continue; // already clean

      if (ticketHasLiveRun(db, repoName, ticket)) {
        totals.held += 1;
        log(
          `  hold  ${repoName}/${ticket}: a live run still owns ${worktreePath}`,
        );
        continue;
      }

      totals.considered += 1;
      log(
        `  STALE ${repoName}/${ticket} worktree at ${worktreePath} (dead dispatch ${runId})`,
      );

      if (hasOpenPullRequest) {
        let open;
        try {
          open = await hasOpenPullRequest(repoName, ticket);
        } catch (err) {
          totals.failed += 1;
          log(
            `        ! pull-request lookup failed closed: ${err.message || err}`,
          );
          continue;
        }
        if (open) {
          totals.held += 1;
          log(`        (open pull request — not touching it)`);
          continue;
        }
      }

      if (!args.apply) continue;

      const downPath = path.isAbsolute(repo.worktreeDown)
        ? repo.worktreeDown
        : path.join(repo.path, repo.worktreeDown);
      const result = spawn("/bin/bash", [downPath, ticket], {
        cwd: repo.path,
        encoding: "utf8",
      });
      if (result.error || result.status !== 0) {
        totals.failed += 1;
        const detail = String(
          result.stderr ||
            result.stdout ||
            result.error?.message ||
            `exit ${result.status}`,
        )
          .trim()
          .slice(0, 200);
        log(`        ! worktree_down refused/failed: ${detail}`);
        continue;
      }
      totals.cleaned += 1;
      log(`        -> worktree reclaimed`);
    }
  } finally {
    db.close?.();
  }

  return totals;
}

/**
 * Is a local process still alive? `kill(pid, 0)` sends no signal — it only asks
 * the kernel whether the pid exists. ESRCH means gone; EPERM means it exists but
 * is owned by another user (still alive, so keep the row). Exported so the pid
 * probe can be stubbed in tests without spawning real processes.
 */
export function localPidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * True when a worker registry row is a dead husk safe to delete: its heartbeat
 * has expired past the threshold AND its process is not alive. The heartbeat
 * gate is what protects a live worker — one that checked in within the window,
 * or whose clock briefly lagged, is never prunable however its pid probes. Pure
 * and exported so the decision stays testable without a database.
 *
 * `alive` is the pid probe's verdict: true (running — keep), false (gone —
 * prune), or null (a worker on another host, whose pid this box cannot probe;
 * an expired heartbeat is then the only proof of death, so it prunes).
 */
export function workerIsPrunable(
  row,
  { now = Date.now(), staleMs = HEARTBEAT_STALE_MS, alive } = {},
) {
  const lastSeen = Date.parse(row.last_seen);
  const heartbeatExpired =
    !Number.isFinite(lastSeen) || now - lastSeen > staleMs;
  if (!heartbeatExpired) return false; // live or briefly-lagged — never touch it
  return alive !== true;
}

/**
 * Prune dead-pid / expired-heartbeat worker rows from the runtime registry
 * (WM-1125). The `workers` table is durable, so every stack restart and host
 * crash leaves the dead process's rows behind — they never claim work, but they
 * clutter `factory workers`, mislead idle/capacity views, and used to need a
 * manual DELETE after a reboot. This reclaims them on the reaper's cadence.
 *
 * A currently-heartbeating worker is never removed: the heartbeat gate in
 * workerIsPrunable() is measured against the same HEARTBEAT_STALE_MS the
 * registry itself uses to call a worker stale. A local row also gets a
 * definitive pid probe, so a hung-but-alive process is kept, not pruned.
 * Deleting a `busy!stale` row that pointed at a terminal run releases it as a
 * side effect — the row was the only thing still "holding" the finished run.
 *
 * Dependencies are injectable so selection and deletion can be tested without a
 * live runtime database, the local process table, or a real hostname.
 */
export function reapDeadWorkers(
  args,
  {
    databasePath = dbPath(),
    openDatabase = (file) => new Database(file),
    fileExists = existsSync,
    now = Date.now(),
    staleMs = HEARTBEAT_STALE_MS,
    localHost = hostname(),
    pidAlive = localPidAlive,
    log = (...values) => console.log(...values),
  } = {},
) {
  const totals = { considered: 0, pruned: 0, live: 0, failed: 0 };
  if (!fileExists(databasePath)) return totals;

  let db;
  try {
    db = openDatabase(databasePath);
  } catch (err) {
    totals.failed += 1;
    log(`  ! dead-worker reap: registry unreadable: ${err.message || err}`);
    return totals;
  }

  try {
    const rows = db
      .query(
        `SELECT worker_id, host, pid, state, last_seen, current_run FROM workers`,
      )
      .all();
    const remove = db.query(`DELETE FROM workers WHERE worker_id = ?`);

    for (const row of rows) {
      // A worker on another host cannot have its pid probed from here, so its
      // heartbeat is the only proof of life (alive = null). Local rows get the
      // definitive check, keeping a hung-but-alive local process off the list.
      const alive = row.host === localHost ? pidAlive(row.pid) : null;
      if (!workerIsPrunable(row, { now, staleMs, alive })) {
        totals.live += 1;
        continue;
      }

      totals.considered += 1;
      const label =
        `${row.worker_id} (host ${row.host} pid ${row.pid}, state ${row.state}` +
        `${row.current_run ? `, holding ${row.current_run}` : ""})`;
      if (!args.apply) {
        log(`  STALE worker ${label} — dead process, heartbeat expired`);
        continue;
      }
      remove.run(row.worker_id);
      totals.pruned += 1;
      log(`  pruned worker ${label}`);
    }
  } catch (err) {
    totals.failed += 1;
    log(`  ! dead-worker reap failed: ${err.message || err}`);
  } finally {
    db.close?.();
  }

  return totals;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`Reclaim stale agent claims through each repository's control plane.

Usage:
  bun orchestrator/reaper.mjs [options]

Options:
  --apply          Actually reclaim tickets (default is dry-run)
  --minutes <N>    Silence threshold before a claim is stale (default: 45)
  --team <KEY>     Limit reaping to repositories for one team key (e.g. CW)
  --any-assignee   Audit all In Progress tickets regardless of agent claim labels
  --markers-only   Only clear stale claim markers outside In Progress
  -h, --help       Show this help message
`);
    return;
  }
  teeToLogFile();
  const mode = args.apply ? "APPLY" : "DRY RUN";
  console.log(
    `=== Stale-claim reaper [${mode}] threshold=${args.minutes}min${args.team ? ` team=${args.team}` : ""} ===\n`,
  );
  const totals = await runReaper(args);

  // Runtime half of WM-1066: reclaim worktrees stranded by dead dispatch runs
  // so a fresh dispatch is not wedged behind a checkout no one will ever reuse.
  // Best-effort and isolated — a failure here must never mask the claim reap
  // above. The open-PR lookup reuses each repo's control plane and fails closed.
  const planeCache = new Map();
  const planeFor = (repoName) => {
    if (!planeCache.has(repoName))
      planeCache.set(repoName, loadControlPlane({ repoName }));
    return planeCache.get(repoName);
  };
  try {
    console.log(`\n=== Dead-dispatch worktree reap [${mode}] ===\n`);
    const worktreeTotals = await reapDeadDispatchWorktrees(args, {
      hasOpenPullRequest: (repoName, ticket) =>
        planeFor(repoName).hasOpenPullRequest(ticket),
    });
    console.log(
      `\n=== Worktrees ${args.apply ? "reclaimed" : "reclaimable"}: ${
        args.apply ? worktreeTotals.cleaned : worktreeTotals.considered
      } | Held: ${worktreeTotals.held} | Failures: ${worktreeTotals.failed} ===`,
    );
  } catch (err) {
    console.error(`Dead-dispatch worktree reap failed: ${err.message || err}`);
  }

  // WM-1125: prune dead-pid / expired-heartbeat worker registry rows so they
  // stop accumulating across restarts. Best-effort and isolated — a failure
  // here must never mask the reaps above.
  try {
    console.log(`\n=== Dead-worker registry prune [${mode}] ===\n`);
    const workerTotals = reapDeadWorkers(args);
    console.log(
      `\n=== Workers ${args.apply ? "pruned" : "prunable"}: ${
        args.apply ? workerTotals.pruned : workerTotals.considered
      } | Live: ${workerTotals.live} | Failures: ${workerTotals.failed} ===`,
    );
  } catch (err) {
    console.error(`Dead-worker registry prune failed: ${err.message || err}`);
  }

  return totals;
}

if (import.meta.main || process.argv[1]?.endsWith("reaper.mjs")) {
  main().catch((err) => {
    console.error(`Control-plane error: ${err.message || err}`);
    process.exit(1);
  });
}
