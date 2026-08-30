/** Status/doctor projections and worker-capacity endpoints. */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { storeStats } from "./artifacts.mjs";
import { artifactsRoot } from "./config.mjs";
import { usageSpend } from "./db.mjs";
import { hookDecisionCounts } from "./hooks.mjs";
import { inboxCounts } from "./inbox.mjs";
import { githubIntakeView } from "./intake.mjs";
import { policyDispatchPaused } from "./planner.mjs";
import { ambiguousOpenProposalRuns, openProposals } from "./proposals.mjs";
import { proposalsPilingUp, scheduleView } from "./schedules.mjs";
import {
  listWorkers,
  loadWorkerPolicy,
  satisfiesPlacement,
  stalledWorkers,
} from "./workers.mjs";

function eventCounts(db) {
  const counts = {
    admitted: 0,
    planned: 0,
    noop: 0,
    human_needed: 0,
    dead_lettered: 0,
  };
  for (const row of db
    .query(`SELECT status, COUNT(*) AS n FROM events GROUP BY status`)
    .all()) {
    counts[row.status] = row.n;
  }
  return counts;
}

function runCounts(db) {
  const byState = {};
  for (const row of db
    .query(`SELECT state, COUNT(*) AS n FROM runs GROUP BY state`)
    .all()) {
    byState[row.state] = row.n;
  }
  return { byState };
}

/** Node-local pool state: pidfile liveness and workers carrying drain requests. */
function runtimePoolState(runDir) {
  const drainingIds = new Set();
  let names;
  try {
    names = readdirSync(runDir);
  } catch {
    return { drainingIds, supervisor: "absent" };
  }
  for (const name of names) {
    const match = /^(worker-\d+)\.drain$/.exec(name);
    if (!match) continue;
    try {
      const workerId = readFileSync(
        path.join(runDir, `${match[1]}.id`),
        "utf8",
      ).trim();
      if (workerId) drainingIds.add(workerId);
    } catch {
      // A slot can disappear between directory read and id read; next poll heals it.
    }
  }
  let supervisor = "absent";
  try {
    const pid = Number(
      readFileSync(path.join(runDir, "supervisor.pid"), "utf8").trim(),
    );
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        supervisor = "active";
      } catch (err) {
        supervisor = err?.code === "EPERM" ? "active" : "stopped";
      }
    }
  } catch {
    // No pidfile means the fixed-worker fallback, not an error.
  }
  return { drainingIds, supervisor };
}

/** One projection powers both API surfaces so Overview and Workers agree. */
export function workerCapacityView(
  db,
  nowMs,
  { workerPolicy = () => loadWorkerPolicy(), runDir } = {},
) {
  const pool = runtimePoolState(
    runDir ??
      process.env.FACTORY_RUN_DIR ??
      path.join(homedir(), ".factory", "run"),
  );
  const workers = listWorkers(db, { now: nowMs }).map((worker) => ({
    ...worker,
    draining:
      !worker.stale &&
      worker.state !== "stopped" &&
      pool.drainingIds.has(worker.workerId),
  }));
  const liveWorkers = workers.filter(
    (worker) => worker.state !== "stopped" && !worker.stale,
  );
  const running = liveWorkers.filter(
    (worker) => worker.state === "busy",
  ).length;
  const draining = liveWorkers.filter((worker) => worker.draining).length;
  const idle = liveWorkers.filter(
    (worker) => worker.state !== "busy" && !worker.draining,
  ).length;
  const queued = db
    .query(`SELECT COUNT(*) AS n FROM runs WHERE state = 'QUEUED'`)
    .get().n;

  let policy = null;
  let policyError = null;
  try {
    policy = workerPolicy?.() ?? null;
  } catch (err) {
    policyError = `worker policy unavailable: ${err.message}`;
  }
  const hasPolicy = Number.isInteger(policy?.max) && policy.max > 0;
  const supervised = pool.supervisor === "active" && hasPolicy;
  const capacity = supervised ? policy.max : liveWorkers.length;
  const target = Math.max(0, liveWorkers.length - draining);
  let limitingFactor = null;
  if (queued > 0 && idle === 0) {
    limitingFactor =
      supervised && liveWorkers.length >= capacity
        ? "at worker max"
        : "no idle worker";
  }

  const classes = [];
  if (
    policy?.classes &&
    typeof policy.classes === "object" &&
    !Array.isArray(policy.classes)
  ) {
    for (const [name, config] of Object.entries(policy.classes)) {
      const classCapacity = Number.isInteger(config) ? config : config?.max;
      if (!Number.isInteger(classCapacity) || classCapacity < 0) continue;
      classes.push({
        name,
        capacity: classCapacity,
        running: liveWorkers.filter(
          (worker) => worker.state === "busy" && worker.labels?.class === name,
        ).length,
      });
    }
  }

  return {
    workers,
    policyError,
    capacity: {
      running,
      capacity,
      queued,
      live: liveWorkers.length,
      idle,
      draining,
      target,
      min: hasPolicy && Number.isInteger(policy.min) ? policy.min : null,
      max: hasPolicy ? policy.max : null,
      supervisor: pool.supervisor,
      source: supervised ? "worker-policy" : "live-workers",
      limitingFactor,
      classes,
    },
  };
}

/** §13 status + doctor view: aggregates plus anomalies, all read-only SQL. */
export function statusView(
  db,
  registry,
  nowMs,
  {
    secret,
    githubSecret,
    policyVersion,
    env,
    getStoreStats,
    workerPolicy,
    workerRunDir,
    dispatchPaused = policyDispatchPaused,
  } = {},
) {
  const open = openProposals(db, { now: nowMs });
  const expiredOpen = open.filter((p) => p.expired);
  const staleLeases = db
    .query(
      `SELECT COUNT(*) AS n FROM runs r
       JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
       WHERE r.state IN ('LEASED', 'RUNNING') AND a.lease_expires_at < ?`,
    )
    .get(new Date(nowMs).toISOString()).n;
  const unpublishedOutbox = db
    .query(`SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL`)
    .get().n;
  const parkedOutbox = db
    .query(
      `SELECT COUNT(*) AS n FROM outbox
       WHERE published_at IS NOT NULL AND delivery_error IS NOT NULL`,
    )
    .get().n;
  const deadLettered = db
    .query(
      `SELECT source, event_id, last_plan_error FROM events WHERE status = 'dead_lettered' AND archived_at IS NULL`,
    )
    .all()
    .map((row) => ({
      source: row.source,
      eventId: row.event_id,
      lastError: row.last_plan_error,
    }));

  const fleet = workerCapacityView(db, nowMs, {
    workerPolicy,
    runDir: workerRunDir,
  });
  const workers = fleet.workers;
  const liveWorkers = workers.filter(
    (worker) => worker.state !== "stopped" && !worker.stale,
  );
  const unmatchedPlacementRuns = db
    .query(
      `SELECT run_id, spec_json FROM runs WHERE state = 'QUEUED' ORDER BY created_at, rowid`,
    )
    .all()
    .flatMap((row) => {
      const placement = JSON.parse(row.spec_json).placement;
      if (!placement || Object.keys(placement).length === 0) return [];
      if (
        liveWorkers.some((worker) =>
          satisfiesPlacement(worker.labels, placement),
        )
      )
        return [];
      return [{ runId: row.run_id, placement }];
    });
  const schedules = scheduleView(db, registry, { now: nowMs });
  const store = getStoreStats
    ? getStoreStats(nowMs)
    : storeStats(db, artifactsRoot(env?.home), { now: nowMs });
  const stalled = stalledWorkers(db, { now: nowMs });
  const runs = { ...runCounts(db), spend: usageSpend(db, { now: nowMs }) };
  const policy = { dispatchPaused: dispatchPaused() };

  const configAnomalies = [];
  const githubIntake = githubIntakeView(db, {
    nowMs,
    configured: Boolean(githubSecret),
  });
  if (!secret)
    configAnomalies.push(
      "FACTORY_EVENT_SECRET is unset (webhook intake disabled)",
    );
  if (!githubSecret) {
    configAnomalies.push(
      "FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)",
    );
  }
  if (githubIntake.stale) {
    const age =
      githubIntake.ageMs === null
        ? "no GitHub delivery has been admitted"
        : `last admission was ${githubIntake.ageMs}ms ago`;
    configAnomalies.push(
      `GitHub webhook intake is stale (${age}; threshold ${githubIntake.staleAfterMs}ms)`,
    );
  }
  if (policyVersion === "unknown")
    configAnomalies.push("policyVersion is unknown");
  if (fleet.policyError) configAnomalies.push(fleet.policyError);
  // Registry-load anomalies that are deliberately not load errors — today
  // only artifact-view sidecars that do not fit their schema (WM-454).
  configAnomalies.push(...(registry?.anomalies ?? []));

  return {
    events: eventCounts(db),
    githubIntake,
    policy,
    proposals: { open: open.length, expired: expiredOpen.length },
    inbox: inboxCounts(db),
    runs,
    workers: {
      live: fleet.capacity.live,
      busy: fleet.capacity.running,
      stale: workers.filter((w) => w.stale).length,
    },
    capacity: fleet.capacity,
    artifacts: {
      files: store.files,
      bytes: store.bytes,
      orphans: store.orphans,
      orphanBytes: store.orphanBytes,
      ...(store.at ? { at: store.at } : {}),
    },
    // `approve.before` hook decisions in the trailing 24h, by hook id
    // (lib/hooks.mjs, WM-842) — allow/deny counts, so an operator can see a
    // gate that is firing (or a broken extension hook denying everything).
    hooks: { decisions24h: hookDecisionCounts(db, { now: nowMs }) },
    anomalies: {
      configuration: configAnomalies,
      expiredOpenProposals: expiredOpen.map((p) => p.id),
      staleLeases,
      unpublishedOutbox,
      parkedOutbox,
      deadLettered,
      stalledWorkers: stalled.map((w) => ({
        workerId: w.workerId,
        host: w.host,
        runId: w.currentRun,
        lastSeen: w.lastSeen,
      })),
      stoppedSchedules: schedules
        .filter((s) => s.stopped || s.error)
        .map((s) => ({
          loop: s.loop,
          every: s.every,
          lastSlot: s.lastSlot,
          intervalsLate: s.intervalsLate,
          error: s.error,
        })),
      unmatchedPlacementRuns,
      noWorkers: liveWorkers.length === 0 && (runs.byState.QUEUED ?? 0) > 0,
      ambiguousOpenProposals: ambiguousOpenProposalRuns(db),
      proposalsPilingUp: proposalsPilingUp(db, registry),
    },
  };
}

export function handleStatusApiRoute({
  route,
  db,
  registry,
  send,
  nowMs,
  secret,
  githubSecret,
  policyVersion,
  env,
  getStoreStats,
  workerPolicy,
  workerRunDir,
}) {
  if (route === "GET /status") {
    return send(200, {
      env,
      ...statusView(db, registry, nowMs, {
        secret,
        githubSecret,
        policyVersion,
        env,
        getStoreStats,
        workerPolicy,
        workerRunDir,
      }),
    });
  }
  if (route === "GET /workers") {
    const fleet = workerCapacityView(db, nowMs, {
      workerPolicy,
      runDir: workerRunDir,
    });
    return send(200, { workers: fleet.workers, capacity: fleet.capacity });
  }
  return false;
}
