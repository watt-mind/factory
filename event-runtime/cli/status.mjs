import { readPool } from "./supervise.mjs";
import { pad, withClient } from "./shared.mjs";

function countLine(label, counts, order = Object.keys(counts)) {
  const parts = order.map((k) => `${k} ${counts[k] ?? 0}`);
  return `${pad(label, 11)}${parts.join("   ")}`;
}

export function spendLine(label, usage) {
  const cost = Number(usage?.costUSD ?? 0);
  return `${pad(label, 11)}${usage?.totalTokens ?? 0} tokens   input ${usage?.inputTokens ?? 0}   output ${usage?.outputTokens ?? 0}   cache-write ${usage?.cacheCreationInputTokens ?? 0}   cache-read ${usage?.cacheReadInputTokens ?? 0}   $${cost.toFixed(4)}`;
}

export function getAnomalyLines(s) {
  const a = s?.anomalies ?? {};
  const anomalyLines = [];
  for (const id of a.expiredOpenProposals ?? [])
    anomalyLines.push(`expired open proposal ${id}`);
  if (a.staleLeases > 0) anomalyLines.push(`stale leases: ${a.staleLeases}`);
  if (a.unpublishedOutbox > 0)
    anomalyLines.push(`unpublished outbox rows: ${a.unpublishedOutbox}`);
  for (const d of a.deadLettered ?? [])
    anomalyLines.push(
      `dead-lettered (${d.source}, ${d.eventId}): ${d.lastError}`,
    );
  for (const amb of a.ambiguousOpenProposals ?? []) {
    anomalyLines.push(
      `ambiguous open proposals for run ${amb.runId}: ${amb.count} open proposals exist for one run`,
    );
  }
  for (const w of a.stalledWorkers ?? []) {
    anomalyLines.push(
      `stalled worker ${w.workerId}${w.host ? ` on ${w.host}` : ""}${w.runId ? ` holding run ${w.runId}` : ""}${w.lastSeen ? ` (last seen ${w.lastSeen})` : ""}`,
    );
  }
  for (const sc of a.stoppedSchedules ?? []) {
    anomalyLines.push(
      `stopped schedule ${sc.loop}: ${sc.error ? `error: ${sc.error}` : `${sc.intervalsLate ?? "unknown"} intervals late`}`,
    );
  }
  for (const p of a.proposalsPilingUp ?? []) {
    anomalyLines.push(
      `proposals piling up for schedule ${p.loop}: ${p.count} open proposals exist (threshold ${p.threshold})`,
    );
  }
  if (a.noWorkers) anomalyLines.push("no live workers with queued runs");
  if (a.unreferencedArtifacts > 0) {
    anomalyLines.push(`unreferenced artifacts: ${a.unreferencedArtifacts}`);
  } else if (s?.artifacts?.orphans > 0) {
    anomalyLines.push(
      `unreferenced artifacts: ${s.artifacts.orphans} (${s.artifacts.orphanBytes ?? 0}B)`,
    );
  }
  if (Array.isArray(a.orphanedWorkspaces)) {
    for (const ws of a.orphanedWorkspaces)
      anomalyLines.push(`orphaned workspace: ${ws}`);
  } else if (a.orphanedWorkspaces > 0) {
    anomalyLines.push(`orphaned workspaces: ${a.orphanedWorkspaces}`);
  } else if (Array.isArray(a.orphanWorkspaces)) {
    for (const ws of a.orphanWorkspaces)
      anomalyLines.push(`orphaned workspace: ${ws}`);
  } else if (a.orphanWorkspaces > 0) {
    anomalyLines.push(`orphaned workspaces: ${a.orphanWorkspaces}`);
  }

  const handledKeys = new Set([
    "expiredOpenProposals",
    "staleLeases",
    "unpublishedOutbox",
    "deadLettered",
    "ambiguousOpenProposals",
    "stalledWorkers",
    "stoppedSchedules",
    "noWorkers",
    "unreferencedArtifacts",
    "orphanedWorkspaces",
    "orphanWorkspaces",
    "orphans",
    "orphanArtifacts",
    "proposalsPilingUp",
  ]);

  for (const [key, val] of Object.entries(a)) {
    if (handledKeys.has(key)) continue;
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        anomalyLines.push(
          `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`,
        );
      }
    } else if (typeof val === "number" && val > 0) {
      anomalyLines.push(`${key}: ${val}`);
    } else if (typeof val === "boolean" && val) {
      anomalyLines.push(`${key}`);
    } else if (typeof val === "string" && val.length > 0) {
      anomalyLines.push(`${key}: ${val}`);
    } else if (typeof val === "object" && Object.keys(val).length > 0) {
      anomalyLines.push(`${key}: ${JSON.stringify(val)}`);
    }
  }

  return anomalyLines;
}

/**
 * The pool, as this machine's run dir reports it (WM-226). Read locally rather
 * than through the control API on purpose: pidfile liveness is node-local state
 * the API has no way to see, and the supervisor is deliberately not part of
 * `serve`. Nothing is printed when no pool was ever started, so a plain
 * single-worker stack looks exactly as it did before.
 */
export function getPoolLines(pool, s) {
  const started = pool?.supervisor !== null && pool?.supervisor !== undefined;
  // A leftover `fastExits: 0` crash-loop file (kept across restarts as the
  // durable backoff counter) is not a slot worth a pool line on its own.
  const liveSlots = (pool?.slots ?? []).filter(
    (sl) => sl.hasPidFile || sl.crashLoops > 0,
  );
  if (!started && liveSlots.length === 0) return { line: null, anomalies: [] };

  const sup = pool.supervisor;
  const supText = !sup
    ? "absent"
    : sup.alive
      ? `live (pid ${sup.pid})`
      : `DEAD (stale pid ${sup.pid})`;
  const draining = pool.slots.filter((sl) => sl.alive && sl.draining).length;
  const crashLoops = pool.slots.filter((sl) => sl.crashLoops > 0);
  const crashText = crashLoops.length
    ? `   crashLoops ${crashLoops
        .map((sl) => `slot ${sl.n}: ${sl.crashLoops}`)
        .join(", ")}`
    : "";
  const line = `${pad("pool", 11)}supervisor ${supText}   workers ${pool.size}${draining > 0 ? ` (${draining} draining)` : ""}${crashText}`;

  // §13's shape of anomaly: work waiting with nothing left that can grow the
  // pool. The queue is not stuck yet — the live workers may still drain it —
  // but nothing will scale up behind them, and that is what an operator wants
  // told rather than discovered.
  const queued = s?.runs?.byState?.QUEUED ?? 0;
  const anomalies = [];
  if (sup && !sup.alive && queued > 0) {
    anomalies.push(
      `worker pool supervisor is dead (stale pid ${sup.pid}) with ${queued} queued run(s)`,
    );
  }
  return { line, anomalies };
}

export async function status(client) {
  const s = await client.status();
  if (s.env) {
    console.log(
      `${pad("env", 11)}${s.env.name}${s.env.adapter ? `   (adapter override: ${s.env.adapter})` : ""}   ${s.env.home}`,
    );
  }
  console.log(
    countLine("events", s.events, [
      "admitted",
      "planned",
      "noop",
      "human_needed",
      "dead_lettered",
    ]),
  );
  console.log(countLine("proposals", s.proposals, ["open", "expired"]));
  if (s.inbox) console.log(countLine("inbox", s.inbox, ["open", "acked"]));
  const states = Object.keys(s.runs.byState);
  console.log(
    states.length
      ? countLine("runs", s.runs.byState, states)
      : `${pad("runs", 11)}none`,
  );
  const spend = s.runs?.spend;
  if (spend) {
    console.log(spendLine("spend 1h", spend.rolling1h));
    console.log(spendLine("spend 24h", spend.rolling24h));
    for (const row of spend.byAgent24h ?? []) {
      console.log(spendLine(`  ${row.agent}`, row));
    }
  }
  const pool = getPoolLines(readPool(), s);
  if (pool.line) console.log(pool.line);
  const anomalyLines = [...getAnomalyLines(s), ...pool.anomalies];
  if (anomalyLines.length === 0) console.log(`${pad("anomalies", 11)}none`);
  else
    for (const line of anomalyLines)
      console.log(`${pad("anomalies", 11)}${line}`);
  return anomalyLines;
}

export default function statusCommand() {
  return withClient(status);
}
