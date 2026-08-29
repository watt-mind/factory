import { describe, expect, test } from "bun:test";
import { memoryControlPlane } from "../lib/control-plane/memory.mjs";
import { openDb } from "../event-runtime/lib/db.mjs";
import {
  parseArgs,
  resolveRepos,
  buildAskDocument,
  recentRuns,
  noopReasons,
  renderHuman,
  SECTIONS,
  RECENT_WINDOW_MS,
} from "./ask.mjs";

// A memory control plane seeded with one dispatchable, one in-flight, and one
// held ticket. The workspace label set has to contain every label a ticket
// carries, because the fake validates that on write — and `claim` writes.
function seedPlane() {
  const labels = [
    { id: "l-ready", name: "ai:agent-ready" },
    { id: "l-blocked", name: "ai:blocked" },
    { id: "l-escalated", name: "ai:escalated" },
  ];
  return memoryControlPlane({
    team: { id: "team-wm", key: "WM" },
    labels,
    tickets: [
      {
        id: "t-ready",
        identifier: "WM-1",
        title: "dispatch me",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        team: { key: "WM" },
        project: { name: "Factory" },
        labels: [{ id: "l-ready", name: "ai:agent-ready" }],
        priority: 2,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "t-flight",
        identifier: "WM-2",
        title: "in progress work",
        state: { id: "s-progress", name: "In Progress", type: "started" },
        team: { key: "WM" },
        project: { name: "Factory" },
        assignee: { id: "user-me", name: "Ada" },
        labels: [],
        startedAt: "2026-08-28T00:00:00.000Z",
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      {
        id: "t-held",
        identifier: "WM-3",
        title: "waiting on a human",
        state: { id: "s-blocked", name: "Blocked", type: "started" },
        team: { key: "WM" },
        project: { name: "Factory" },
        labels: [{ id: "l-blocked", name: "ai:blocked" }],
        createdAt: "2026-08-26T00:00:00.000Z",
        comments: [{ id: "c-1", body: "Should I bump the major version?" }],
      },
    ],
  });
}

const REPO = {
  name: "factory",
  team: "WM",
  project: "Factory",
  github: "watt-mind/factory",
};

/** An in-memory ledger seeded with one recent run and one noop proposal. */
function seedLedger({ now = Date.now() } = {}) {
  const db = openDb(":memory:");
  const iso = (ms) => new Date(ms).toISOString();
  const runId = "run-1";
  db.query(
    `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    "idem-1",
    JSON.stringify({ agent: "factory-ticket", repo: "factory", model: "opus" }),
    "hash-1",
    "COMPLETED",
    1,
    iso(now - 60_000),
    iso(now - 30_000),
  );
  db.query(
    `INSERT INTO run_usage (run_id, attempt, adapter, model, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, cost_usd, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    1,
    "claude",
    "claude-opus",
    100,
    50,
    0,
    0,
    1.25,
    iso(now - 30_000),
  );

  // A run older than the 24h window must not appear in `recent`.
  db.query(
    `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "run-old",
    "idem-old",
    JSON.stringify({ agent: "factory-ticket", repo: "factory" }),
    "hash-old",
    "COMPLETED",
    1,
    iso(now - 2 * RECENT_WINDOW_MS),
    iso(now - 2 * RECENT_WINDOW_MS),
  );

  db.query(
    `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at,
        envelope_json, payload_hash, status, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "github",
    "evt-1",
    "pull_request.opened",
    "PR#7",
    iso(now - 120_000),
    iso(now - 120_000),
    "{}",
    "ph-1",
    "admitted",
    iso(now - 120_000),
  );
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, decision, status, reason, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "prop-1",
    "github",
    "evt-1",
    "noop",
    "closed",
    "capacity_full",
    iso(now - 110_000),
    300,
  );
  return db;
}

const noSpend = () => ({ usd: 0, reported: 0, estimated: 0, runs: 0 });

describe("parseArgs", () => {
  test("defaults to every section, no repo, human output", () => {
    const o = parseArgs([]);
    expect(o.json).toBe(false);
    expect(o.repo).toBeNull();
    expect(o.sections).toEqual([...SECTIONS]);
    expect(o.unknownSections).toEqual([]);
  });

  test("--section filters to the named sections in canonical order", () => {
    const o = parseArgs(["--section", "held,queue"]);
    expect(o.sections).toEqual(["queue", "held"]);
    expect(o.unknownSections).toEqual([]);
  });

  test("unknown section names are surfaced", () => {
    const o = parseArgs(["--section", "queue,bogus"]);
    expect(o.sections).toEqual(["queue"]);
    expect(o.unknownSections).toEqual(["bogus"]);
  });

  test("--json and --repo are parsed", () => {
    const o = parseArgs(["--json", "--repo", "factory"]);
    expect(o.json).toBe(true);
    expect(o.repo).toBe("factory");
  });
});

describe("resolveRepos", () => {
  const cfg = {
    repos: [
      { name: "factory", team: "WM" },
      { name: "site", team: "ST", report_only: true },
    ],
  };

  test("bare invocation excludes report_only repos", () => {
    const { repos, error } = resolveRepos(null, cfg);
    expect(error).toBeNull();
    expect(repos.map((r) => r.name)).toEqual(["factory"]);
  });

  test("--repo selects one by name, report_only included", () => {
    const { repos } = resolveRepos("site", cfg);
    expect(repos.map((r) => r.name)).toEqual(["site"]);
  });

  test("an unknown --repo is a named error", () => {
    const { repos, error } = resolveRepos("nope", cfg);
    expect(repos).toEqual([]);
    expect(error).toContain("nope");
  });
});

describe("buildAskDocument", () => {
  test("all sections present on a seeded fixture", async () => {
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    const plane = seedPlane();
    const db = seedLedger({ now });
    const doc = await buildAskDocument({
      repos: [REPO],
      now,
      controlPlaneFor: () => plane,
      leasesFor: () => [{ ticket: "WM-2", heartbeatAt: now - 5_000 }],
      db,
      spend: () => ({ usd: 3.5, reported: 3, estimated: 0.5, runs: 4 }),
    });

    expect(doc.sections).toEqual([...SECTIONS]);
    expect(doc.repos).toEqual(["factory"]);

    // queue — the one dispatchable ticket
    expect(doc.queue.errors).toEqual([]);
    expect(doc.queue.rows.map((r) => r.identifier)).toEqual(["WM-1"]);

    // inflight — the claimed ticket, with age and live heartbeat
    expect(doc.inflight.rows).toHaveLength(1);
    const flight = doc.inflight.rows[0];
    expect(flight.identifier).toBe("WM-2");
    expect(flight.hasLiveLease).toBe(true);
    expect(flight.heartbeatAgeMs).toBe(5_000);
    expect(flight.ageMs).toBeGreaterThan(0);

    // held — the blocked ticket, with its question
    expect(doc.held.rows).toHaveLength(1);
    expect(doc.held.rows[0].identifier).toBe("WM-3");
    expect(doc.held.rows[0].labels).toEqual(["ai:blocked"]);
    expect(doc.held.rows[0].question).toContain("major version");

    // recent — the run inside the window, not the old one
    expect(doc.recent.rows.map((r) => r.runId)).toEqual(["run-1"]);
    expect(doc.recent.rows[0].adapter).toBe("claude");
    expect(doc.recent.rows[0].model).toBe("claude-opus");
    expect(doc.recent.rows[0].outcome).toBe("COMPLETED");
    expect(doc.recent.rows[0].cost).toBeCloseTo(1.25);

    // noop — the latest decline per event type
    expect(doc.noop.rows).toEqual([
      {
        eventType: "pull_request.opened",
        reason: "capacity_full",
        at: expect.any(String),
      },
    ]);

    // spend — the injected breakdown
    expect(doc.spend).toMatchObject({ usd: 3.5, reported: 3, runs: 4 });

    db.close();
  });

  test("--section filtering returns only the named sections", async () => {
    const plane = seedPlane();
    const doc = await buildAskDocument({
      repos: [REPO],
      sections: ["queue", "held"],
      controlPlaneFor: () => plane,
      leasesFor: () => [],
      db: null,
      spend: noSpend,
    });
    expect(doc.sections).toEqual(["queue", "held"]);
    expect(doc.queue).toBeDefined();
    expect(doc.held).toBeDefined();
    expect(doc.inflight).toBeUndefined();
    expect(doc.recent).toBeUndefined();
    expect(doc.noop).toBeUndefined();
    expect(doc.spend).toBeUndefined();
  });

  test("per-section error isolation: a failing tracker never reads as empty", async () => {
    const throwingPlane = {
      calls: [],
      listDispatchable() {
        throw new Error("control plane unreachable");
      },
      listTickets() {
        throw new Error("control plane unreachable");
      },
      listComments() {
        throw new Error("control plane unreachable");
      },
    };
    const db = seedLedger();
    const doc = await buildAskDocument({
      repos: [REPO],
      controlPlaneFor: () => throwingPlane,
      leasesFor: () => [],
      db,
      spend: noSpend,
    });

    // The tracker sections carry an error keyed by repo — never an empty list
    // that would read as "no tickets".
    expect(doc.queue.rows).toEqual([]);
    expect(doc.queue.errors).toEqual([
      { repo: "factory", error: "control plane unreachable" },
    ]);
    expect(doc.held.errors[0].error).toContain("unreachable");
    expect(doc.inflight.errors[0].error).toContain("unreachable");

    // Ledger-backed sections are independent and still return.
    expect(doc.recent.rows.length).toBeGreaterThan(0);
    expect(doc.noop.rows.length).toBeGreaterThan(0);
    expect(doc.spend.error).toBeUndefined();

    db.close();
  });

  test("a missing ledger isolates to recent/noop, tracker sections still return", async () => {
    const plane = seedPlane();
    const doc = await buildAskDocument({
      repos: [REPO],
      controlPlaneFor: () => plane,
      leasesFor: () => [],
      db: null,
      spend: noSpend,
    });
    expect(doc.recent).toEqual({ error: "event-runtime ledger not found" });
    expect(doc.noop).toEqual({ error: "event-runtime ledger not found" });
    expect(doc.queue.rows.map((r) => r.identifier)).toEqual(["WM-1"]);
  });

  test("read-only by construction: a full ask reaches no write verb", async () => {
    const plane = seedPlane();
    const db = seedLedger();
    await buildAskDocument({
      repos: [REPO],
      controlPlaneFor: () => plane,
      leasesFor: () => [],
      db,
      spend: noSpend,
    });
    const writeVerbs = new Set([
      "claim",
      "transition",
      "setLabels",
      "file",
      "comment",
    ]);
    const writes = plane.calls.filter((call) => writeVerbs.has(call.op));
    expect(writes).toEqual([]);
    // And it did in fact read — otherwise the assertion above is vacuous.
    expect(plane.calls.some((call) => call.op === "listDispatchable")).toBe(
      true,
    );
    db.close();
  });
});

describe("recentRuns / noopReasons", () => {
  test("recentRuns errors cleanly without a ledger", () => {
    expect(recentRuns(null)).toEqual({
      error: "event-runtime ledger not found",
    });
  });

  test("noopReasons keeps only the latest decline per event type", () => {
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    const db = openDb(":memory:");
    const iso = (ms) => new Date(ms).toISOString();
    const event = (id, type, at) =>
      db
        .query(
          `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at,
              envelope_json, payload_hash, status, admitted_at)
           VALUES ('github', ?, ?, '', ?, ?, '{}', ?, 'admitted', ?)`,
        )
        .run(id, type, iso(at), iso(at), `ph-${id}`, iso(at));
    const proposal = (id, eventId, reason, at) =>
      db
        .query(
          `INSERT INTO proposals (id, event_source, event_id, decision, status, reason, created_at, ttl_seconds)
           VALUES (?, 'github', ?, 'noop', 'closed', ?, ?, 300)`,
        )
        .run(id, eventId, reason, iso(at));

    event("e1", "pull_request.opened", now - 200_000);
    event("e2", "pull_request.opened", now - 100_000);
    proposal("p1", "e1", "older_reason", now - 200_000);
    proposal("p2", "e2", "newer_reason", now - 100_000);

    const result = noopReasons(db);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      eventType: "pull_request.opened",
      reason: "newer_reason",
    });
    db.close();
  });
});

describe("renderHuman", () => {
  test("renders the document without re-deriving, showing section errors", async () => {
    const plane = seedPlane();
    const doc = await buildAskDocument({
      repos: [REPO],
      controlPlaneFor: () => plane,
      leasesFor: () => [],
      db: null,
      spend: () => ({ usd: 1, reported: 1, estimated: 0, runs: 1 }),
    });
    const text = renderHuman(doc);
    expect(text).toContain("factory ask");
    expect(text).toContain("WM-1"); // dispatchable ticket
    expect(text).toContain("WM-3"); // held ticket
    expect(text).toContain("event-runtime ledger not found"); // recent error surfaced
  });
});
