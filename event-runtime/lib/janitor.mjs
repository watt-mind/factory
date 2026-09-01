import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  artifactsRoot,
  DEFAULT_PROPOSAL_TTL_SECONDS,
  runtimeHome,
} from "./config.mjs";
import { openDb, txImmediate } from "./db.mjs";
import { ALL_TERMINAL_STATES, transition } from "./lifecycle.mjs";
import { isProposalExpired } from "./proposals.mjs";
import { reposRoot } from "./repos.mjs";

/** Bound so a hung Linear call cannot freeze serve forever (OPS-301 review). */
export const JANITOR_TIMEOUT_MS = 120_000;
export const JANITOR_MAX_BUFFER = 1_000_000;
export const DEFAULT_TRACE_RETENTION_DAYS = 14;
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
export const DEFAULT_ROW_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Run states that are terminal for retention purposes (#1065). FAILED is
 * re-queueable while attempts remain, so it is NOT in lifecycle's
 * TERMINAL_STATES — but a FAILED run untouched since before the retention
 * cutoff is never mid-retry, so the `updated_at < cutoff` gate makes it safe
 * to sweep here. Active/in-flight states (PROPOSED, APPROVED, QUEUED, LEASED,
 * RUNNING, VERIFYING) are deliberately absent so they can never be removed.
 */
const TERMINAL_RUN_STATES = [...ALL_TERMINAL_STATES];

/** Per-run child tables keyed by run_id, cleared alongside a swept run. */
const RUN_CHILD_TABLES = [
  "results",
  "attempts",
  "lifecycle_events",
  "run_usage",
  "attempt_trace",
];

/**
 * Delete terminal proposal/run/event rows past the retention window, keeping
 * all active/in-flight state (#1065). Dry-by-default: with `apply: false` it
 * only counts. Returns per-table counts.
 */
function sweepTerminalRows(db, { rowCutoff, nowIso, apply }) {
  const terminalList = TERMINAL_RUN_STATES.map((s) => `'${s}'`).join(", ");
  const runFilter = `state IN (${terminalList}) AND updated_at < ?`;

  const runsDeleted = db
    .query(`SELECT COUNT(*) AS count FROM runs WHERE ${runFilter}`)
    .get(rowCutoff).count;

  // Terminal proposals: decided (rejected/superseded) or open-but-expired past
  // their per-row TTL. Active 'open' proposals still within TTL and 'approved'
  // decisions are never removed.
  const proposalFilter = `created_at < ?
      AND (status IN ('rejected', 'superseded')
           OR (status = 'open'
               AND (strftime('%s', ?) - strftime('%s', created_at)) > ttl_seconds))`;
  const proposalsDeleted = db
    .query(`SELECT COUNT(*) AS count FROM proposals WHERE ${proposalFilter}`)
    .get(rowCutoff, nowIso).count;

  // Archived (dead-lettered) events past the window.
  const eventFilter = `archived_at IS NOT NULL AND archived_at < ?`;
  const eventsDeleted = db
    .query(`SELECT COUNT(*) AS count FROM events WHERE ${eventFilter}`)
    .get(rowCutoff).count;

  if (apply) {
    txImmediate(db, () => {
      // Subquery predicates (not an id list) so a large sweep can never trip
      // SQLite's bound-variable limit. Children first, then the runs.
      const runSubquery = `run_id IN (SELECT run_id FROM runs WHERE ${runFilter})`;
      for (const table of RUN_CHILD_TABLES) {
        db.query(`DELETE FROM ${table} WHERE ${runSubquery}`).run(rowCutoff);
      }
      db.query(`DELETE FROM runs WHERE ${runFilter}`).run(rowCutoff);
      db.query(`DELETE FROM proposals WHERE ${proposalFilter}`).run(
        rowCutoff,
        nowIso,
      );
      db.query(`DELETE FROM events WHERE ${eventFilter}`).run(rowCutoff);
    });
  }

  return {
    runs: { deleted: runsDeleted, dryRun: !apply },
    proposals: { deleted: proposalsDeleted, dryRun: !apply },
    events: { deleted: eventsDeleted, dryRun: !apply },
  };
}

/**
 * Find proposal runs that no longer have a possible admission path. A run
 * without any proposal is only dead after the proposal TTL: a just-created
 * run may still be between its creation and proposal insert statements.
 */
function expiredProposedRunIds(db, now) {
  const proposalsByRun = new Map();
  for (const row of db
    .query(
      `SELECT runs.run_id AS proposed_run_id,
              runs.created_at AS run_created_at,
              proposals.*
         FROM runs
         LEFT JOIN proposals ON proposals.run_id = runs.run_id
        WHERE runs.state = 'PROPOSED'
        ORDER BY runs.run_id, proposals.rowid`,
    )
    .all()) {
    const entry = proposalsByRun.get(row.proposed_run_id) ?? {
      createdAt: row.run_created_at,
      proposals: [],
    };
    if (row.id !== null) entry.proposals.push(row);
    proposalsByRun.set(row.proposed_run_id, entry);
  }
  return [...proposalsByRun].flatMap(([runId, { createdAt, proposals }]) =>
    proposals.some(
      (proposal) =>
        proposal.status === "open" && !isProposalExpired(proposal, now),
    )
      ? []
      : proposals.length === 0 && !isProposalLessRunExpired(createdAt, now)
        ? []
        : [runId],
  );
}

function isProposalLessRunExpired(createdAt, now) {
  const createdAtMs = Date.parse(createdAt);
  return (
    Number.isFinite(createdAtMs) &&
    createdAtMs + DEFAULT_PROPOSAL_TTL_SECONDS * 1000 < now
  );
}

/**
 * Cancel PROPOSED runs after every proposal is expired or terminally decided.
 * The candidate query and legal transitions share an immediate transaction so
 * a concurrent replan cannot insert a fresh proposal between the two.
 */
function terminalizeExpiredProposedRuns(db, { now, apply }) {
  const cancel = () => {
    const runIds = expiredProposedRunIds(db, now);
    if (apply) {
      for (const runId of runIds) {
        transition(db, {
          runId,
          to: "CANCELLED",
          expectFrom: "PROPOSED",
          actor: "janitor",
          reason: "proposal_expired",
          now,
        });
      }
    }
    return runIds.length;
  };
  const cancelled = apply ? txImmediate(db, cancel) : cancel();
  return { cancelled, dryRun: !apply };
}

function retentionMs(days, name) {
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(`${name} must be a positive number of days`);
  return days * DAY_MS;
}

function resultArtifactHashes(result, fallbackHash) {
  const hashes = new Set();
  for (const entry of result?.artifacts ?? []) {
    if (typeof entry?.sha256 === "string" && SHA256.test(entry.sha256))
      hashes.add(entry.sha256);
  }
  const value = result?.artifactHash ?? fallbackHash;
  const match = /^sha256:([a-f0-9]{64})$/.exec(value ?? "");
  if (match && result?.artifact !== undefined) hashes.add(match[1]);
  return hashes;
}

/**
 * Retain recent trace audit rows and artifacts referenced by recently-created
 * runs. This is deliberately a standalone maintenance operation: dry-run is
 * the default and callers must pass `apply: true` to mutate either store.
 */
export function sweepRuntimeRetention(
  db,
  storeRoot,
  {
    traceRetentionDays = DEFAULT_TRACE_RETENTION_DAYS,
    artifactRetentionDays = DEFAULT_ARTIFACT_RETENTION_DAYS,
    rowRetentionDays = DEFAULT_ROW_RETENTION_DAYS,
    now = Date.now(),
    apply = false,
    log = () => {},
  } = {},
) {
  const traceCutoff = new Date(
    now - retentionMs(traceRetentionDays, "traceRetentionDays"),
  ).toISOString();
  const artifactCutoffMs =
    now - retentionMs(artifactRetentionDays, "artifactRetentionDays");
  const rowCutoff = new Date(
    now - retentionMs(rowRetentionDays, "rowRetentionDays"),
  ).toISOString();
  const nowIso = new Date(now).toISOString();
  const proposed = terminalizeExpiredProposedRuns(db, { now, apply });
  const trace = db
    .query(`SELECT COUNT(*) AS count FROM attempt_trace WHERE ts < ?`)
    .get(traceCutoff).count;
  if (apply && trace > 0)
    db.query(`DELETE FROM attempt_trace WHERE ts < ?`).run(traceCutoff);

  const referenced = new Set();
  for (const row of db
    .query(
      `SELECT results.result_json, results.artifact_hash
       FROM results JOIN runs ON runs.run_id = results.run_id
       WHERE runs.created_at >= ?`,
    )
    .all(new Date(artifactCutoffMs).toISOString())) {
    try {
      for (const hash of resultArtifactHashes(
        JSON.parse(row.result_json),
        row.artifact_hash,
      ))
        referenced.add(hash);
    } catch {
      // A corrupt historical result is not permission to remove its bytes.
      return {
        trace: { deleted: trace, dryRun: !apply },
        artifacts: { deleted: 0, freedBytes: 0, retained: 0, dryRun: !apply },
        error: "unreadable result artifact reference",
      };
    }
  }

  let deleted = 0;
  let freedBytes = 0;
  let retained = 0;
  if (existsSync(storeRoot)) {
    for (const name of readdirSync(storeRoot)) {
      if (!SHA256.test(name)) continue;
      const file = path.join(storeRoot, name);
      const stat = statSync(file);
      if (
        !stat.isFile() ||
        referenced.has(name) ||
        stat.mtimeMs >= artifactCutoffMs
      ) {
        retained += 1;
        continue;
      }
      deleted += 1;
      freedBytes += stat.size;
      if (apply) rmSync(file, { force: true });
    }
  }
  const rows = sweepTerminalRows(db, { rowCutoff, nowIso, apply });

  // VACUUM reclaims the file space freed by the row deletions (#1065). It must
  // run outside any transaction, so it follows the sweep's own commit.
  if (apply) db.exec("VACUUM");

  const result = {
    trace: { deleted: trace, dryRun: !apply },
    artifacts: { deleted, freedBytes, retained, dryRun: !apply },
    proposed,
    runs: rows.runs,
    proposals: rows.proposals,
    events: rows.events,
    vacuum: { ran: apply },
  };
  log(
    `retention: ${trace} trace rows and ${deleted} artifacts (${freedBytes} bytes)` +
      `, ${proposed.cancelled} proposed runs ${apply ? "cancelled" : "would be cancelled"}` +
      `, ${rows.runs.deleted} runs, ${rows.proposals.deleted} proposals, ${rows.events.deleted} events ` +
      `${apply ? "deleted (VACUUMed)" : "would be deleted"}`,
  );
  return result;
}

/** Run the retention sweep as an explicit, dry-by-default maintenance command. */
export function runtimeRetentionCommand(args = [], options = {}) {
  let apply = false;
  let traceRetentionDays = DEFAULT_TRACE_RETENTION_DAYS;
  let artifactRetentionDays = DEFAULT_ARTIFACT_RETENTION_DAYS;
  let rowRetentionDays = DEFAULT_ROW_RETENTION_DAYS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--trace-days") traceRetentionDays = Number(args[++i]);
    else if (args[i] === "--artifact-days")
      artifactRetentionDays = Number(args[++i]);
    else if (args[i] === "--row-days") rowRetentionDays = Number(args[++i]);
    else
      throw new Error(
        "usage: janitor.mjs retention [--apply] [--trace-days N] [--artifact-days N] [--row-days N]",
      );
  }
  const db = options.db ?? openDb();
  try {
    return sweepRuntimeRetention(
      db,
      options.storeRoot ?? artifactsRoot(runtimeHome()),
      {
        traceRetentionDays,
        artifactRetentionDays,
        rowRetentionDays,
        apply,
        now: options.now,
        log: options.log ?? console.log,
      },
    );
  } finally {
    if (!options.db) db.close();
  }
}

/**
 * Argv for one repos.yaml name. `--force` is not a flag and must never become
 * one — the worktree_down refusal on dirty trees is the safety property.
 * Spawn runs against `reposRoot()` so FACTORY_REPOS_ROOT cannot survey one
 * yaml and tear down another.
 */
export function janitorArgv(name, { apply = false } = {}) {
  const args = [
    path.join(reposRoot(), "orchestrator", "janitor.mjs"),
    "--repo",
    name,
    "--json",
  ];
  if (apply === true) args.push("--apply");
  return args;
}

/**
 * Spawn `orchestrator/janitor.mjs --json` for one repos.yaml name asynchronously (OPS-301, OPS-364).
 * Never passes `--force`. Injectable on createApi so tests never hit Linear
 * or real worktrees. Actor is the loopback operator — this is a host-side
 * spawn, the same trust as typing `factory janitor` on the machine.
 */
export async function spawnFactoryJanitor(
  name,
  {
    apply = false,
    timeoutMs = JANITOR_TIMEOUT_MS,
    maxBuffer = JANITOR_MAX_BUFFER,
  } = {},
) {
  const args = janitorArgv(name, { apply });
  const root = reposRoot();

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;

    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* intentionally ignored */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentionally ignored */
        }
      }, 2000);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentionally ignored */
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentionally ignored */
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);

      if (timedOut) {
        const err = new Error("janitor timed out");
        err.status = 504;
        return reject(err);
      }

      if (code === 2) {
        const err = new Error(`unknown repo ${name}`);
        err.status = 404;
        return reject(err);
      }

      if (code !== 0) {
        const err = new Error(stderr.trim() || `janitor exit ${code}`);
        err.status = 500;
        return reject(err);
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (e) {
        const err = new Error(
          stderr.trim() || stdout.trim() || `invalid json: ${e.message}`,
        );
        err.status = 500;
        return reject(err);
      }

      if (parsed && Array.isArray(parsed.results)) {
        const err = new Error("janitor returned multiple repos; expected one");
        err.status = 500;
        return reject(err);
      }

      resolve(parsed);
    });
  });
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "retention") {
    throw new Error(
      "usage: janitor.mjs retention [--apply] [--trace-days N] [--artifact-days N] [--row-days N]",
    );
  }
  runtimeRetentionCommand(args);
}
