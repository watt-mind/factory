const DURATIONS_MS = Object.freeze({
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
});

export const VALID_METRIC_SERIES = Object.freeze([
  "runs.outcomes",
  "runs.started",
  "latency.queue_wait",
  "latency.execution",
  "spend.cost",
  "spend.tokens",
  "proposals.decisions",
  "proposals.time_to_decision",
  "events.intake",
  "attempts.retries",
]);

export const VALID_BREAKDOWN_DIMENSIONS = Object.freeze([
  "agent",
  "adapter",
  "model",
  "repo",
  "source",
  "reason_code",
  "event_type",
  "edge",
]);

export const VALID_BREAKDOWN_METRICS = Object.freeze([
  "runs",
  "failures",
  "cost",
  "tokens",
  "p95_execution",
]);

export const MAX_METRIC_BUCKETS = 500;

export class MetricsQueryError extends Error {
  constructor(error, details = {}) {
    super(error);
    this.name = "MetricsQueryError";
    this.body = { error, ...details };
  }
}

function nowValue(now) {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

function duration(name, parameter) {
  const value = DURATIONS_MS[name];
  if (!value) {
    throw new MetricsQueryError(`invalid_${parameter}`, {
      [parameter]: name,
      valid: Object.keys(DURATIONS_MS),
    });
  }
  return value;
}

function timeRange({ now, window = "24h", bucket = "1h", withBuckets = true } = {}) {
  const nowMs = nowValue(now);
  const windowMs = duration(window, "window");
  const bucketMs = withBuckets ? duration(bucket, "bucket") : null;
  const bucketCount = withBuckets ? Math.ceil(windowMs / bucketMs) : null;
  if (withBuckets && bucketCount > MAX_METRIC_BUCKETS) {
    throw new MetricsQueryError("too_many_buckets", {
      window,
      bucket,
      buckets: bucketCount,
      maxBuckets: MAX_METRIC_BUCKETS,
    });
  }
  const startMs = nowMs - windowMs;
  return {
    window,
    bucket,
    nowMs,
    startMs,
    endMs: nowMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(nowMs).toISOString(),
    bucketMs,
    bucketCount,
    buckets: withBuckets
      ? Array.from({ length: bucketCount }, (_, index) => new Date(startMs + index * bucketMs).toISOString())
      : null,
  };
}

function bucketIndex(at, range) {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp) || timestamp < range.startMs || timestamp >= range.endMs) return -1;
  const index = Math.floor((timestamp - range.startMs) / range.bucketMs);
  return index >= 0 && index < range.bucketCount ? index : -1;
}

function zeroArray(range, value = 0) {
  return Array.from({ length: range.bucketCount }, () => value);
}

function countSeries(rows, range, fixedKeys = []) {
  const result = Object.fromEntries(fixedKeys.map((key) => [key, zeroArray(range)]));
  for (const row of rows) {
    const index = Number(row.bucket_index);
    if (!Number.isInteger(index) || index < 0 || index >= range.bucketCount) continue;
    const key = String(row.key ?? "unknown");
    if (!result[key]) result[key] = zeroArray(range);
    result[key][index] += Number(row.value ?? 0);
  }
  return result;
}

function sqliteMilliseconds(expression) {
  return `(CAST(strftime('%s', ${expression}) AS INTEGER) * 1000 + ` +
    `CAST(substr(strftime('%f', ${expression}), 4, 3) AS INTEGER))`;
}

function groupedCounts(db, range, { table, time, key, where = "1 = 1", value = "COUNT(*)", joins = "" }) {
  return db.query(
    `SELECT CAST((${sqliteMilliseconds(time)} - ?) / ? AS INTEGER) AS bucket_index,
            ${key} AS key,
            ${value} AS value
     FROM ${table} ${joins}
     WHERE ${time} >= ? AND ${time} < ? AND (${where})
     GROUP BY bucket_index, key
     ORDER BY bucket_index, key`,
  ).all(range.startMs, range.bucketMs, range.startIso, range.endIso);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function percentileSeries(rows, range) {
  const samples = Array.from({ length: range.bucketCount }, () => []);
  for (const row of rows) {
    const index = bucketIndex(row.bucket_at, range);
    const start = Date.parse(row.started_at);
    const finish = Date.parse(row.finished_at ?? row.bucket_at);
    if (index < 0 || !Number.isFinite(start) || !Number.isFinite(finish) || finish < start) continue;
    samples[index].push(finish - start);
  }
  const p50 = zeroArray(range, null);
  const p95 = zeroArray(range, null);
  for (let index = 0; index < samples.length; index += 1) {
    if (samples[index].length < 5) continue;
    samples[index].sort((a, b) => a - b);
    p50[index] = percentile(samples[index], 0.5);
    p95[index] = percentile(samples[index], 0.95);
  }
  return { p50, p95 };
}

function outcomes(db, range) {
  const rows = groupedCounts(db, range, {
    table: "lifecycle_events",
    time: "at",
    key: "to_state",
    where: "to_state IN ('COMPLETED', 'FAILED', 'REFUSED', 'TIMED_OUT', 'CANCELLED')",
  });
  return countSeries(rows, range, ["COMPLETED", "FAILED", "REFUSED", "TIMED_OUT", "CANCELLED"]);
}

function started(db, range) {
  const rows = groupedCounts(db, range, {
    table: "lifecycle_events",
    time: "at",
    key: "'total'",
    where: "to_state = 'RUNNING'",
  });
  return countSeries(rows, range, ["total"]);
}

function queueWait(db, range) {
  const rows = db.query(
    `SELECT leased.at AS bucket_at,
            (SELECT queued.at
             FROM lifecycle_events queued
             WHERE queued.run_id = leased.run_id
               AND queued.to_state = 'QUEUED'
               AND queued.seq < leased.seq
               AND (
                 queued.attempt = leased.attempt
                 OR queued.attempt = leased.attempt - 1
                 OR (leased.attempt = 1 AND queued.attempt IS NULL)
               )
             ORDER BY queued.seq DESC
             LIMIT 1) AS started_at,
            leased.at AS finished_at
     FROM lifecycle_events leased
     WHERE leased.to_state = 'LEASED' AND leased.at >= ? AND leased.at < ?`,
  ).all(range.startIso, range.endIso);
  return percentileSeries(rows, range);
}

function execution(db, range) {
  const rows = db.query(
    `SELECT finished_at AS bucket_at, started_at, finished_at
     FROM attempts
     WHERE started_at IS NOT NULL AND finished_at IS NOT NULL
       AND finished_at >= ? AND finished_at < ?`,
  ).all(range.startIso, range.endIso);
  return percentileSeries(rows, range);
}

function spend(db, range, column) {
  const rows = groupedCounts(db, range, {
    table: "run_usage u",
    joins: "JOIN runs r ON r.run_id = u.run_id",
    time: "u.recorded_at",
    key: "COALESCE(json_extract(r.spec_json, '$.agent'), 'unknown')",
    value: column,
  });
  return countSeries(rows, range);
}

function proposalDecisions(db, range) {
  const decidedMilliseconds = sqliteMilliseconds("decided_at");
  const createdMilliseconds = sqliteMilliseconds("created_at");
  const rows = db.query(
    `WITH decisions AS (
       SELECT status AS key, ${decidedMilliseconds} AS at_ms
       FROM proposals
       WHERE status IN ('approved', 'rejected', 'superseded', 'expired')
         AND decided_at IS NOT NULL
       UNION ALL
       SELECT 'expired' AS key, ${createdMilliseconds} + ttl_seconds * 1000 AS at_ms
       FROM proposals
       WHERE status = 'open'
         AND ${createdMilliseconds} + ttl_seconds * 1000 < ?
     )
     SELECT CAST((at_ms - ?) / ? AS INTEGER) AS bucket_index,
            key,
            COUNT(*) AS value
     FROM decisions
     WHERE at_ms >= ? AND at_ms < ?
     GROUP BY bucket_index, key
     ORDER BY bucket_index, key`,
  ).all(range.endMs, range.startMs, range.bucketMs, range.startMs, range.endMs);
  return countSeries(rows, range, ["approved", "rejected", "expired", "superseded"]);
}

function proposalDecisionTime(db, range) {
  const rows = db.query(
    `SELECT decided_at AS bucket_at, created_at AS started_at, decided_at AS finished_at
     FROM proposals
     WHERE decided_at IS NOT NULL AND decided_at >= ? AND decided_at < ?`,
  ).all(range.startIso, range.endIso);
  return percentileSeries(rows, range);
}

function intake(db, range) {
  const rows = groupedCounts(db, range, {
    table: "events",
    time: "admitted_at",
    key: "status",
  });
  return countSeries(rows, range, ["admitted", "planned", "noop", "human_needed", "dead_lettered"]);
}

function retries(db, range) {
  const rows = groupedCounts(db, range, {
    table: "attempts",
    time: "started_at",
    key: "'total'",
    where: "attempt > 1 AND started_at IS NOT NULL",
  });
  return countSeries(rows, range, ["total"]);
}

const SERIES_QUERIES = {
  "runs.outcomes": outcomes,
  "runs.started": started,
  "latency.queue_wait": queueWait,
  "latency.execution": execution,
  "spend.cost": (db, range) => spend(db, range, "COALESCE(SUM(u.cost_usd), 0)"),
  "spend.tokens": (db, range) => spend(
    db,
    range,
    "COALESCE(SUM(u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens), 0)",
  ),
  "proposals.decisions": proposalDecisions,
  "proposals.time_to_decision": proposalDecisionTime,
  "events.intake": intake,
  "attempts.retries": retries,
};

/** Aligned, zero-filled time-series query used by GET /metrics. */
export function metricsView(db, { now, window = "24h", bucket = "1h", series } = {}) {
  const names = series == null || series === ""
    ? [...VALID_METRIC_SERIES]
    : (Array.isArray(series) ? series : String(series).split(",")).map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !VALID_METRIC_SERIES.includes(name));
  if (unknown.length > 0) {
    throw new MetricsQueryError("unknown_series", { unknown, validSeries: VALID_METRIC_SERIES });
  }
  const range = timeRange({ now, window, bucket });
  const output = {};
  for (const name of [...new Set(names)]) output[name] = SERIES_QUERIES[name](db, range);
  return { window, bucket, buckets: range.buckets, series: output };
}

function repoNames(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const names = [];
  const add = (value) => {
    if (typeof value === "string" && value !== "" && !names.includes(value)) names.push(value);
  };
  add(input.repoPin?.repo);
  add(input.repo);
  for (const entry of input.repos ?? []) add(typeof entry === "string" ? entry : entry?.name);
  return names;
}

const RUN_FACTS_SELECT = `
  SELECT r.run_id, r.spec_json, r.state, r.created_at, r.updated_at,
         a.reason_code, e.source AS event_source, e.type AS event_type,
         parent.spec_json AS parent_spec_json`;
const RUN_FACTS_JOINS = `
  LEFT JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
  LEFT JOIN proposals p ON p.rowid = (
    SELECT p2.rowid FROM proposals p2 WHERE p2.run_id = r.run_id
    ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1
  )
  LEFT JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
  LEFT JOIN runs parent ON parent.run_id = e.causation_id`;

function factKeys(row, dimension) {
  const spec = JSON.parse(row.spec_json || "{}");
  if (dimension === "agent") return [spec.agent ?? "unknown"];
  if (dimension === "adapter") return [spec.adapter ?? row.usage_adapter ?? "unknown"];
  if (dimension === "model") return [row.usage_model ?? spec.model ?? "unknown"];
  if (dimension === "repo") return repoNames(spec.input).length > 0 ? repoNames(spec.input) : ["unknown"];
  if (dimension === "source") return [row.event_source ?? "unknown"];
  if (dimension === "reason_code") return [row.reason_code ?? "unknown"];
  if (dimension === "event_type") return [row.event_type ?? "unknown"];
  if (dimension === "edge") {
    if (!row.parent_spec_json || !row.event_type) return [];
    const parent = JSON.parse(row.parent_spec_json);
    return [`${parent.agent ?? "unknown"}→${row.event_type}`];
  }
  return [];
}

function breakdownFacts(db, metric, range) {
  if (metric === "runs" || metric === "failures") {
    const failures = metric === "failures"
      ? "AND r.state IN ('FAILED', 'REFUSED', 'TIMED_OUT', 'CANCELLED')"
      : "";
    const time = metric === "failures" ? "r.updated_at" : "r.created_at";
    return db.query(
      `${RUN_FACTS_SELECT}, 1 AS value
       FROM runs r ${RUN_FACTS_JOINS}
       WHERE ${time} >= ? AND ${time} < ? ${failures}`,
    ).all(range.startIso, range.endIso);
  }
  if (metric === "cost" || metric === "tokens") {
    const value = metric === "cost"
      ? "u.cost_usd"
      : "u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens";
    return db.query(
      `${RUN_FACTS_SELECT}, u.adapter AS usage_adapter, u.model AS usage_model, ${value} AS value
       FROM run_usage u
       JOIN runs r ON r.run_id = u.run_id
       LEFT JOIN attempts a ON a.run_id = u.run_id AND a.attempt = u.attempt
       LEFT JOIN proposals p ON p.rowid = (
         SELECT p2.rowid FROM proposals p2 WHERE p2.run_id = r.run_id
         ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1
       )
       LEFT JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       LEFT JOIN runs parent ON parent.run_id = e.causation_id
       WHERE u.recorded_at >= ? AND u.recorded_at < ?`,
    ).all(range.startIso, range.endIso);
  }
  return db.query(
    `${RUN_FACTS_SELECT}, a.started_at, a.finished_at
     FROM attempts a
     JOIN runs r ON r.run_id = a.run_id
     LEFT JOIN proposals p ON p.rowid = (
       SELECT p2.rowid FROM proposals p2 WHERE p2.run_id = r.run_id
       ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1
     )
     LEFT JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
     LEFT JOIN runs parent ON parent.run_id = e.causation_id
     WHERE a.started_at IS NOT NULL AND a.finished_at IS NOT NULL
       AND a.finished_at >= ? AND a.finished_at < ?`,
  ).all(range.startIso, range.endIso);
}

/** Top-N operational dimensions used by GET /metrics/breakdown. */
export function metricsBreakdownView(db, {
  now,
  window = "24h",
  by,
  metric,
  limit,
} = {}) {
  if (!VALID_BREAKDOWN_DIMENSIONS.includes(by)) {
    throw new MetricsQueryError("invalid_dimension", { by, validDimensions: VALID_BREAKDOWN_DIMENSIONS });
  }
  if (!VALID_BREAKDOWN_METRICS.includes(metric)) {
    throw new MetricsQueryError("invalid_metric", { metric, validMetrics: VALID_BREAKDOWN_METRICS });
  }
  let actualLimit;
  if (limit == null || limit === "") actualLimit = by === "event_type" || by === "edge" ? null : 10;
  else {
    actualLimit = Number(limit);
    if (!Number.isInteger(actualLimit) || actualLimit < 1 || actualLimit > 500) {
      throw new MetricsQueryError("invalid_limit", { limit, min: 1, max: 500 });
    }
  }
  const range = timeRange({ now, window, withBuckets: false });
  const facts = breakdownFacts(db, metric, range);
  const grouped = new Map();
  for (const fact of facts) {
    for (const key of factKeys(fact, by)) {
      if (metric === "p95_execution") {
        const durationMs = Date.parse(fact.finished_at) - Date.parse(fact.started_at);
        if (!Number.isFinite(durationMs) || durationMs < 0) continue;
        const samples = grouped.get(key) ?? [];
        samples.push(durationMs);
        grouped.set(key, samples);
      } else {
        grouped.set(key, (grouped.get(key) ?? 0) + Number(fact.value ?? 0));
      }
    }
  }
  let rows = [...grouped.entries()].map(([key, value]) => {
    if (metric !== "p95_execution") return { key, value };
    value.sort((a, b) => a - b);
    return { key, value: percentile(value, 0.95) };
  });
  rows.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  if (actualLimit != null) rows = rows.slice(0, actualLimit);
  return { window, by, metric, limit: actualLimit, rows };
}
