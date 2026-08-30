import { describe, expect, test } from "bun:test";
import { openDb, recordRunUsage } from "./db.mjs";
import {
  MAX_METRIC_BUCKETS,
  MetricsQueryError,
  VALID_METRIC_SERIES,
  metricsBreakdownView,
  metricsView,
} from "./metrics.mjs";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const at = (millisecondsAgo) => new Date(NOW - millisecondsAgo).toISOString();

function insertRun(
  db,
  id,
  {
    agent = "agent-a@1",
    adapter = "pi",
    model = "openai/test",
    modelTier,
    input = { repo: "factory" },
    state = "COMPLETED",
    attempts = 1,
    createdAt = at(30 * 60_000),
    updatedAt = createdAt,
  } = {},
) {
  db.query(
    `INSERT INTO runs
       (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'hash', ?, ?, ?, ?)`,
  ).run(
    id,
    `idem-${id}`,
    JSON.stringify({
      agent,
      adapter,
      model,
      ...(modelTier ? { modelTier } : {}),
      input,
    }),
    state,
    attempts,
    createdAt,
    updatedAt,
  );
}

let lifecycleSequence = 0;
function insertLifecycle(
  db,
  runId,
  to,
  when,
  { from = null, attempt = null } = {},
) {
  lifecycleSequence += 1;
  db.query(
    `INSERT INTO lifecycle_events
       (run_id, from_state, to_state, actor, attempt, at, record_hash)
     VALUES (?, ?, ?, 'test', ?, ?, ?)`,
  ).run(runId, from, to, attempt, when, `lifecycle-${lifecycleSequence}`);
}

function insertAttempt(
  db,
  runId,
  attempt,
  {
    startedAt,
    finishedAt,
    terminalState = "COMPLETED",
    reasonCode = null,
  } = {},
) {
  db.query(
    `INSERT INTO attempts
       (run_id, attempt, fencing_token, started_at, finished_at, terminal_state, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    attempt,
    attempt,
    startedAt ?? null,
    finishedAt ?? null,
    terminalState,
    reasonCode,
  );
}

function insertEvent(
  db,
  id,
  {
    type = "factory.test.requested",
    source = "test",
    status = "planned",
    admittedAt = at(30 * 60_000),
    causationId = null,
  } = {},
) {
  db.query(
    `INSERT INTO events
       (source, event_id, type, occurred_at, received_at, causation_id,
        envelope_json, payload_hash, status, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).run(
    source,
    id,
    type,
    admittedAt,
    admittedAt,
    causationId,
    `hash-${source}-${id}`,
    status,
    admittedAt,
  );
}

function insertMergeLandedEvent(db, tickets, admittedAt = at(20 * 60_000)) {
  insertEvent(db, `merge-landed-${tickets.join("-")}`, {
    type: "factory.merge-landed",
    source: "chain",
    admittedAt,
  });
  db.query(
    `UPDATE events SET envelope_json = ?
      WHERE source = 'chain' AND event_id = ?`,
  ).run(
    JSON.stringify({
      payload: { landed: tickets.map((ticket) => ({ ticket })) },
    }),
    `merge-landed-${tickets.join("-")}`,
  );
}

function insertProposal(
  db,
  id,
  eventId,
  {
    runId = null,
    status = "approved",
    source = "test",
    createdAt = at(31 * 60_000),
    decidedAt = at(30 * 60_000),
    ttlSeconds = 3600,
  } = {},
) {
  db.query(
    `INSERT INTO proposals
       (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
        idempotency_key, status, created_at, ttl_seconds, decided_at)
     VALUES (?, ?, ?, ?, 'run', '{}', 'hash', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    source,
    eventId,
    runId,
    `idem-proposal-${id}`,
    status,
    createdAt,
    ttlSeconds,
    decidedAt,
  );
}

function seededSeriesDb() {
  const db = openDb(":memory:");
  insertLifecycle(db, "run-outcome", "RUNNING", at(40 * 60_000), {
    from: "LEASED",
    attempt: 1,
  });
  insertLifecycle(db, "run-outcome", "COMPLETED", at(30 * 60_000), {
    from: "VERIFYING",
    attempt: 1,
  });

  const executionDurations = [1000, 2000, 3000, 100_000, 200_000];
  const queueDurations = [10_000, 20_000, 30_000, 40_000, 50_000];
  executionDurations.forEach((duration, index) => {
    const runId = index < 3 ? "multi-attempt" : `single-${index}`;
    const attempt = index < 3 ? index + 1 : 1;
    const finishedAt = at(20 * 60_000 + index * 1000);
    insertAttempt(db, runId, attempt, {
      startedAt: new Date(Date.parse(finishedAt) - duration).toISOString(),
      finishedAt,
    });
    const leasedAt = at(10 * 60_000 + index * 1000);
    insertLifecycle(
      db,
      runId,
      "QUEUED",
      new Date(Date.parse(leasedAt) - queueDurations[index]).toISOString(),
      {
        from: index < 3 && index > 0 ? "FAILED" : "APPROVED",
        attempt: index < 3 && index > 0 ? index : null,
      },
    );
    insertLifecycle(db, runId, "LEASED", leasedAt, { from: "QUEUED", attempt });
  });

  insertRun(db, "spend-a", { agent: "agent-a@1" });
  recordRunUsage(db, {
    runId: "spend-a",
    attempt: 1,
    adapter: "pi",
    model: "openai/test",
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 40,
    costUSD: 1.25,
    recordedAt: at(15 * 60_000),
  });

  const decisions = [
    "approved",
    "rejected",
    "superseded",
    "approved",
    "rejected",
  ];
  decisions.forEach((status, index) => {
    const decidedAt = at(25 * 60_000 + index * 1000);
    insertProposal(db, `decision-${index}`, `decision-event-${index}`, {
      status,
      createdAt: new Date(
        Date.parse(decidedAt) - (index + 1) * 1000,
      ).toISOString(),
      decidedAt,
    });
  });
  insertProposal(db, "expired", "expired-event", {
    status: "open",
    createdAt: at(2 * 60 * 60_000),
    decidedAt: null,
    ttlSeconds: 3600,
  });

  for (const status of [
    "admitted",
    "planned",
    "noop",
    "human_needed",
    "dead_lettered",
  ]) {
    insertEvent(db, `event-${status}`, { status });
  }
  return db;
}

describe("metrics time series (WM-281)", () => {
  test("all allowlisted series share aligned buckets and preserve empty buckets", () => {
    const db = seededSeriesDb();
    const view = metricsView(db, {
      now: NOW,
      window: "24h",
      bucket: "1h",
      series: VALID_METRIC_SERIES.join(","),
    });

    expect(view.buckets).toHaveLength(24);
    expect(Object.keys(view.series)).toEqual(VALID_METRIC_SERIES);
    for (const values of Object.values(view.series)) {
      for (const points of Object.values(values))
        expect(points).toHaveLength(view.buckets.length);
    }
    expect(view.series["runs.outcomes"].COMPLETED.at(-1)).toBe(1);
    expect(view.series["runs.outcomes"].COMPLETED[0]).toBe(0);
    expect(view.series["runs.started"].total.at(-1)).toBe(1);
    expect(view.series["latency.queue_wait"].p50.at(-1)).toBe(30_000);
    expect(view.series["latency.queue_wait"].p95.at(-1)).toBe(50_000);
    // Three samples belong to one run. Per-run first→last timing would leave
    // fewer than five samples (and include retry queue gaps), so these values
    // prove execution is measured independently per completed attempt.
    expect(view.series["latency.execution"].p50.at(-1)).toBe(3000);
    expect(view.series["latency.execution"].p95.at(-1)).toBe(200_000);
    expect(view.series["spend.cost"]["agent-a@1"].at(-1)).toBe(1.25);
    expect(view.series["spend.tokens"]["agent-a@1"].at(-1)).toBe(100);
    expect(view.series["proposals.decisions"].approved.at(-1)).toBe(2);
    expect(view.series["proposals.decisions"].expired.at(-1)).toBe(1);
    expect(view.series["proposals.time_to_decision"].p50.at(-1)).toBe(3000);
    expect(view.series["proposals.time_to_decision"].p95.at(-1)).toBe(5000);
    expect(view.series["events.intake"].dead_lettered.at(-1)).toBe(1);
    expect(view.series["attempts.retries"].total.at(-1)).toBe(2);
    db.close();
  });

  test("in-flight intervals are excluded and sparse percentile buckets are null", () => {
    const db = openDb(":memory:");
    insertAttempt(db, "flight", 1, { startedAt: at(10_000), finishedAt: null });
    insertAttempt(db, "finished", 1, {
      startedAt: at(20_000),
      finishedAt: at(10_000),
    });
    const view = metricsView(db, { now: NOW, series: "latency.execution" });
    expect(
      view.series["latency.execution"].p50.every((value) => value === null),
    ).toBe(true);
    expect(
      view.series["latency.execution"].p95.every((value) => value === null),
    ).toBe(true);
    db.close();
  });

  test("invalid series and oversized bucket combinations are typed 422 errors", () => {
    const db = openDb(":memory:");
    try {
      metricsView(db, { now: NOW, series: "runs.nope" });
      throw new Error("expected unknown series error");
    } catch (err) {
      expect(err).toBeInstanceOf(MetricsQueryError);
      expect(err.body.error).toBe("unknown_series");
      expect(err.body.validSeries).toEqual(VALID_METRIC_SERIES);
    }
    try {
      metricsView(db, {
        now: NOW,
        window: "30d",
        bucket: "15m",
        series: "runs.started",
      });
      throw new Error("expected bucket cap error");
    } catch (err) {
      expect(err.body).toMatchObject({
        error: "too_many_buckets",
        maxBuckets: MAX_METRIC_BUCKETS,
      });
    }
    db.close();
  });
});

function seededBreakdownDb() {
  const db = openDb(":memory:");
  insertRun(db, "parent", {
    agent: "recommender@1",
    adapter: "pi",
    input: { repo: "factory" },
  });
  insertAttempt(db, "parent", 1, {
    startedAt: at(35 * 60_000),
    finishedAt: at(34 * 60_000),
  });

  for (let index = 0; index < 12; index += 1) {
    const runId = `child-${index}`;
    const eventId = `caused-${index}`;
    const type = `factory.caused-${index}.requested`;
    insertEvent(db, eventId, { source: "result", type, causationId: "parent" });
    insertRun(db, runId, {
      agent: "worker@1",
      adapter: "claude",
      model: "claude/test",
      input: { repos: ["factory", { name: "bj29" }] },
      state: index === 0 ? "FAILED" : "COMPLETED",
      updatedAt: at(20 * 60_000),
    });
    insertProposal(db, `proposal-${index}`, eventId, {
      runId,
      source: "result",
    });
    insertAttempt(db, runId, 1, {
      startedAt: at(25 * 60_000),
      finishedAt: at(24 * 60_000 - index * 1000),
      terminalState: index === 0 ? "FAILED" : "COMPLETED",
      reasonCode: index === 0 ? "adapter_error" : null,
    });
    recordRunUsage(db, {
      runId,
      attempt: 1,
      adapter: "claude",
      model: "claude/test",
      inputTokens: index + 1,
      costUSD: 0.1,
      recordedAt: at(15 * 60_000),
    });
  }
  // Multiple proposal-history rows for a run must not multiply an edge.
  insertProposal(db, "proposal-0-history", "caused-0", {
    runId: "child-0",
    source: "result",
    status: "superseded",
    createdAt: at(29 * 60_000),
  });
  return db;
}

describe("metrics breakdowns (WM-281)", () => {
  test("top-N dimensions and unbounded graph dimensions are computed server-side", () => {
    const db = seededBreakdownDb();
    expect(
      metricsBreakdownView(db, { now: NOW, by: "agent", metric: "runs" })
        .rows[0],
    ).toEqual({
      key: "worker@1",
      value: 12,
    });
    expect(
      metricsBreakdownView(db, { now: NOW, by: "adapter", metric: "runs" })
        .rows[0],
    ).toEqual({
      key: "claude",
      value: 12,
    });
    expect(
      metricsBreakdownView(db, {
        now: NOW,
        by: "reason_code",
        metric: "failures",
      }).rows,
    ).toEqual([{ key: "adapter_error", value: 1 }]);

    const eventTypes = metricsBreakdownView(db, {
      now: NOW,
      by: "event_type",
      metric: "runs",
    });
    expect(eventTypes.limit).toBeNull();
    expect(eventTypes.rows).toHaveLength(13); // twelve event types plus the uncaused parent
    const edges = metricsBreakdownView(db, {
      now: NOW,
      by: "edge",
      metric: "runs",
    });
    expect(edges.limit).toBeNull();
    expect(edges.rows).toHaveLength(12);
    expect(
      edges.rows.find(
        (row) => row.key === "recommender@1→factory.caused-0.requested",
      ),
    ).toEqual({
      key: "recommender@1→factory.caused-0.requested",
      value: 1,
    });

    expect(
      metricsBreakdownView(db, { now: NOW, by: "model", metric: "tokens" })
        .rows[0],
    ).toEqual({
      key: "claude/test",
      value: 78,
    });
    expect(
      metricsBreakdownView(db, { now: NOW, by: "repo", metric: "runs" }).rows,
    ).toContainEqual({
      key: "bj29",
      value: 12,
    });
    expect(
      metricsBreakdownView(db, { now: NOW, by: "source", metric: "cost" })
        .rows[0].key,
    ).toBe("result");
    expect(
      metricsBreakdownView(db, {
        now: NOW,
        by: "agent",
        metric: "p95_execution",
      }).rows[0].value,
    ).toBe(71_000);
    db.close();
  });

  test("agent terminal outcomes and newest run timestamps share breakdown facts", () => {
    const db = openDb(":memory:");
    insertRun(db, "refused", {
      agent: "alpha@1",
      state: "REFUSED",
      createdAt: at(15 * 60_000),
      updatedAt: at(12 * 60_000),
    });
    insertRun(db, "timed-out", {
      agent: "beta@1",
      state: "TIMED_OUT",
      createdAt: at(25 * 60_000),
      updatedAt: at(11 * 60_000),
    });
    insertRun(db, "failed", {
      agent: "gamma@1",
      state: "FAILED",
      createdAt: at(40 * 60_000),
      updatedAt: at(10 * 60_000),
    });
    insertRun(db, "gamma-newest", {
      agent: "gamma@1",
      createdAt: at(5 * 60_000),
    });
    insertRun(db, "outside-window", {
      agent: "outside@1",
      state: "REFUSED",
      createdAt: at(25 * 60 * 60_000),
      updatedAt: at(25 * 60 * 60_000),
    });
    // Seen first for delta@1: sorts inside the SQL window but Date.parse()
    // returns NaN, which must not pin the key ahead of the parsable run.
    insertRun(db, "delta-unparsable", {
      agent: "delta@1",
      createdAt: "2026-08-15T11:3x:00.000Z",
      updatedAt: at(1 * 60_000),
    });
    insertRun(db, "delta-parsable", {
      agent: "delta@1",
      createdAt: at(20 * 60_000),
    });

    const options = { now: NOW, window: "24h", by: "agent" };
    expect(
      metricsBreakdownView(db, { ...options, metric: "failures" }).rows,
    ).toEqual([
      { key: "alpha@1", value: 1 },
      { key: "beta@1", value: 1 },
      { key: "gamma@1", value: 1 },
    ]);
    expect(
      metricsBreakdownView(db, { ...options, metric: "refusals" }).rows,
    ).toEqual([{ key: "alpha@1", value: 1 }]);
    expect(
      metricsBreakdownView(db, { ...options, metric: "timeouts" }).rows,
    ).toEqual([{ key: "beta@1", value: 1 }]);
    expect(
      metricsBreakdownView(db, { ...options, metric: "last_run_at" }).rows,
    ).toEqual([
      { key: "gamma@1", value: NOW - 5 * 60_000, at: at(5 * 60_000) },
      { key: "alpha@1", value: NOW - 15 * 60_000, at: at(15 * 60_000) },
      { key: "delta@1", value: NOW - 20 * 60_000, at: at(20 * 60_000) },
      { key: "beta@1", value: NOW - 25 * 60_000, at: at(25 * 60_000) },
    ]);

    try {
      metricsBreakdownView(db, { ...options, metric: "unknown" });
      throw new Error("expected invalid metric error");
    } catch (err) {
      expect(err).toBeInstanceOf(MetricsQueryError);
      expect(err.body).toMatchObject({
        error: "invalid_metric",
        validMetrics: expect.arrayContaining([
          "refusals",
          "timeouts",
          "last_run_at",
        ]),
      });
    }
    db.close();
  });

  test("modelTier cohorts use dispatch pins, merged events, and every ticket run cost", () => {
    const db = openDb(":memory:");
    insertRun(db, "standard-dispatch", {
      agent: "dispatch@1",
      modelTier: "standard",
      input: { repo: "factory", ticket: "WM-697" },
    });
    insertRun(db, "standard-escalation", {
      agent: "merge-fix@1",
      modelTier: "strong",
      input: { repo: "factory", ticket: "WM-697" },
    });
    insertRun(db, "standard-unpinned-retry", {
      agent: "merge-fix@1",
      model: "a-model-named-strong",
      input: { repo: "factory", ticket: "WM-697" },
    });
    insertRun(db, "strong-dispatch", {
      agent: "dispatch@1",
      modelTier: "strong",
      input: { repo: "factory", ticket: "WM-698" },
    });
    insertRun(db, "unmerged-dispatch", {
      agent: "dispatch@1",
      modelTier: "standard",
      input: { repo: "factory", ticket: "WM-699" },
    });
    for (const [runId, costUSD] of [
      ["standard-dispatch", 1.25],
      ["standard-escalation", 2.75],
      ["standard-unpinned-retry", 0.5],
      ["strong-dispatch", 8],
      ["unmerged-dispatch", 3],
    ]) {
      recordRunUsage(db, {
        runId,
        attempt: 1,
        adapter: "pi",
        costUSD,
        recordedAt: at(10 * 60_000),
      });
    }
    insertMergeLandedEvent(db, ["WM-697", "WM-698"]);

    expect(
      metricsBreakdownView(db, {
        now: NOW,
        by: "modelTier",
        metric: "cost",
      }),
    ).toMatchObject({
      by: "modelTier",
      limit: null,
      rows: [
        {
          key: "standard",
          ticketsDispatched: 2,
          ticketsMerged: 1,
          medianCostPerMergedTicketUSD: 4.5,
          totalCostUSD: 4.5,
          standardTierEscalationRate: 1,
        },
        {
          key: "strong",
          ticketsDispatched: 1,
          ticketsMerged: 1,
          medianCostPerMergedTicketUSD: 8,
          totalCostUSD: 8,
          standardTierEscalationRate: null,
        },
      ],
    });
    db.close();
  });
});
