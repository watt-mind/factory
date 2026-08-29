import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../event-runtime/lib/db.mjs";
import { memoryControlPlane } from "../lib/control-plane/memory.mjs";
import {
  SECTIONS,
  WRITE_OPS,
  formatAsk,
  gatherAsk,
  parseSections,
} from "./ask.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASK = path.join(HERE, "ask.mjs");
const ROOT = path.resolve(HERE, "..");

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const REPO = {
  name: "factory",
  team: "WM",
  project: "Factory",
  github: "watt-mind/factory",
};

const temps = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A transcript directory lib/spend.mjs will read as today's spend. */
function seedLogDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "gh1069-logs-"));
  temps.push(dir);
  writeFileSync(
    path.join(dir, "dispatch-factory-20260829-120000.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        num_turns: 3,
        total_cost_usd: 1.25,
        duration_ms: 1000,
      }),
      "",
    ].join("\n"),
  );
  return dir;
}

/** Tickets covering every ticket-shaped section: queued, claimed, held. */
function seedPlane() {
  const project = { name: "Factory" };
  const team = { key: "WM" };
  return memoryControlPlane({
    labels: [
      { id: "l-ready", name: "ai:agent-ready" },
      { id: "l-blocked", name: "ai:blocked" },
      { id: "l-escalated", name: "ai:escalated" },
    ],
    tickets: [
      {
        id: "t1",
        identifier: "WM-1",
        title: "Dispatchable ticket",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        team,
        project,
        labels: [{ id: "l-ready", name: "ai:agent-ready" }],
        priority: 2,
        createdAt: ago(6 * HOUR),
      },
      {
        id: "t2",
        identifier: "WM-2",
        title: "Claimed ticket",
        state: { id: "s-progress", name: "In Progress", type: "started" },
        team,
        project,
        labels: [],
        assignee: { id: "u-1", name: "Ada" },
        createdAt: ago(5 * HOUR),
        startedAt: ago(3 * HOUR),
        comments: [
          { id: "c1", body: "claimed", createdAt: ago(3 * HOUR) },
          {
            id: "c2",
            body: "implemented, verifying",
            createdAt: ago(11 * MIN),
          },
        ],
      },
      {
        id: "t3",
        identifier: "WM-3",
        title: "Held ticket",
        state: { id: "s-blocked", name: "Blocked", type: "started" },
        team,
        project,
        labels: [{ id: "l-blocked", name: "ai:blocked" }],
        createdAt: ago(30 * HOUR),
        updatedAt: ago(2 * HOUR),
        comments: [
          { id: "c3", body: "starting", createdAt: ago(4 * HOUR) },
          {
            id: "c4",
            body: "Which base branch should this target?",
            createdAt: ago(2 * HOUR),
          },
        ],
      },
      {
        id: "t4",
        identifier: "WM-4",
        title: "Finished ticket",
        state: { id: "s-done", name: "Done", type: "completed" },
        team,
        project,
        labels: [],
        createdAt: ago(40 * HOUR),
      },
    ],
  });
}

/** An in-memory runtime.db with runs, usage, events and a noop proposal. */
function seedDb() {
  const db = openDb(":memory:");
  const insertRun = (runId, agent, adapter, model, state, createdAt, repo) =>
    db
      .query(
        `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'sha256:x', ?, 1, ?, ?)`,
      )
      .run(
        runId,
        `key-${runId}`,
        JSON.stringify({
          agent,
          adapter,
          model,
          modelTier: "standard",
          input: { repo },
        }),
        state,
        createdAt,
        createdAt,
      );

  insertRun(
    "run_recent",
    "dispatch@3",
    "claude",
    "sonnet-4.6",
    "SUCCEEDED",
    ago(2 * HOUR),
    "factory",
  );
  insertRun(
    "run_failed",
    "merge-scan@2",
    "cursor",
    "cursor-grok-4.6-high",
    "FAILED",
    ago(4 * HOUR),
    "factory",
  );
  // Outside the 24h window: must not appear in `recent`.
  insertRun(
    "run_old",
    "dispatch@3",
    "claude",
    "sonnet-4.6",
    "SUCCEEDED",
    ago(40 * HOUR),
    "factory",
  );
  // Another repo: must not appear when the scope is `factory` alone.
  insertRun(
    "run_other_repo",
    "dispatch@3",
    "claude",
    "sonnet-4.6",
    "SUCCEEDED",
    ago(3 * HOUR),
    "legalease",
  );

  db.query(
    `INSERT INTO run_usage (run_id, attempt, adapter, model, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, cost_usd, recorded_at)
     VALUES (?, 1, 'claude', 'sonnet-4.6', 100, 50, 0, 0, 0.75, ?)`,
  ).run("run_recent", ago(2 * HOUR));

  const insertEvent = (source, eventId, type, subject, at) =>
    db
      .query(
        `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at,
           envelope_json, payload_hash, admitted_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'sha256:y', ?)`,
      )
      .run(source, eventId, type, subject, at, at, at);
  const insertProposal = (id, eventId, decision, reason, at) =>
    db
      .query(
        `INSERT INTO proposals (id, event_source, event_id, decision, status, reason, created_at, ttl_seconds)
         VALUES (?, 'scheduler', ?, ?, 'open', ?, ?, 600)`,
      )
      .run(id, eventId, decision, reason, at);

  insertEvent(
    "scheduler",
    "e-dispatch-old",
    "factory.dispatch.requested",
    "factory",
    ago(5 * HOUR),
  );
  insertEvent(
    "scheduler",
    "e-dispatch-new",
    "factory.dispatch.requested",
    "factory",
    ago(20 * MIN),
  );
  insertEvent(
    "scheduler",
    "e-merge",
    "factory.merge.requested",
    "factory",
    ago(90 * MIN),
  );
  insertProposal(
    "prop-old",
    "e-dispatch-old",
    "noop",
    "capacity_full",
    ago(5 * HOUR),
  );
  insertProposal(
    "prop-new",
    "e-dispatch-new",
    "noop",
    "owned_paths_overlap",
    ago(20 * MIN),
  );
  insertProposal(
    "prop-merge",
    "e-merge",
    "noop",
    "previous_run_in_flight",
    ago(90 * MIN),
  );
  // An accepted proposal is not a decline and must not surface in `noop`.
  insertEvent(
    "scheduler",
    "e-accepted",
    "factory.triage.requested",
    "factory",
    ago(10 * MIN),
  );
  insertProposal("prop-ok", "e-accepted", "run", null, ago(10 * MIN));

  return db;
}

function askArgs(overrides = {}) {
  return {
    repos: [REPO],
    policy: { budget: { per_day_usd: 200 } },
    db: seedDb(),
    logDir: seedLogDir(),
    now: NOW,
    ...overrides,
  };
}

test("every section is present and typed on a seeded fixture", async () => {
  const plane = seedPlane();
  const doc = await gatherAsk(askArgs({ controlPlaneFor: () => plane }));

  expect(doc.sections).toEqual([...SECTIONS]);
  for (const name of SECTIONS) expect(doc[name]).toBeDefined();
  expect(doc.repos).toEqual(["factory"]);

  // queue — dispatchable only, as typed rows
  expect(doc.queue.error).toBeNull();
  expect(doc.queue.rows.map((r) => r.identifier)).toEqual(["WM-1"]);
  expect(doc.queue.rows[0]).toMatchObject({
    repo: "factory",
    priority: 2,
    labels: ["ai:agent-ready"],
  });
  expect(doc.queue.rows[0].ageMs).toBe(6 * HOUR);

  // inflight — claimed, with age and last heartbeat
  expect(doc.inflight.rows.map((r) => r.identifier)).toEqual(["WM-2"]);
  expect(doc.inflight.rows[0].ageMs).toBe(3 * HOUR);
  expect(doc.inflight.rows[0].heartbeatAgeMs).toBe(11 * MIN);
  expect(doc.inflight.rows[0].assignee).toBe("Ada");

  // held — with the question
  expect(doc.held.rows.map((r) => r.identifier)).toEqual(["WM-3"]);
  expect(doc.held.rows[0].holds).toEqual(["ai:blocked"]);
  expect(doc.held.rows[0].question).toBe(
    "Which base branch should this target?",
  );

  // recent — 24h window, scoped to the requested repos
  expect(doc.recent.rows.map((r) => r.runId)).toEqual([
    "run_recent",
    "run_failed",
  ]);
  expect(doc.recent.rows[0]).toMatchObject({
    agent: "dispatch@3",
    adapter: "claude",
    model: "sonnet-4.6",
    outcome: "SUCCEEDED",
    costUSD: 0.75,
  });
  expect(doc.recent.byOutcome).toEqual({ SUCCEEDED: 1, FAILED: 1 });

  // noop — the LATEST decline per event type, with its reason
  expect(doc.noop.rows.map((r) => r.eventType)).toEqual([
    "factory.dispatch.requested",
    "factory.merge.requested",
  ]);
  expect(doc.noop.rows[0]).toMatchObject({
    reason: "owned_paths_overlap",
    total: 2,
  });
  expect(doc.noop.rows.some((r) => r.reason === "capacity_full")).toBe(false);

  // spend — from lib/spend.mjs, not a second parser
  expect(doc.spend.error).toBeNull();
  expect(doc.spend.today).toMatchObject({ runs: 1, reported: 1.25 });
  expect(doc.spend.budget.perDayUSD).toBe(200);
  expect(doc.spend.runtime.rolling24h.costUSD).toBe(0.75);

  // The text view is rendered from this document, so it agrees by construction.
  const text = formatAsk(doc);
  expect(text).toContain("WM-1");
  expect(text).toContain("WM-2");
  expect(text).toContain("Which base branch should this target?");
  expect(text).toContain("owned_paths_overlap");
  expect(text).toContain("$1.25");
});

test("a failing section carries its error and never renders as empty", async () => {
  const unreachable = () => {
    throw new Error("control plane unreachable: HTTP 403 secondary rate limit");
  };
  const brokenPlane = {
    kind: "memory",
    async listTickets() {
      unreachable();
    },
    async listDispatchable() {
      unreachable();
    },
    async listComments() {
      unreachable();
    },
  };
  const doc = await gatherAsk(askArgs({ controlPlaneFor: () => brokenPlane }));

  for (const name of ["queue", "inflight", "held"]) {
    expect(doc[name].error).toContain("secondary rate limit");
    expect(doc[name].rows).toEqual([]);
  }
  // …and every other section still returns real data.
  expect(doc.recent.error).toBeNull();
  expect(doc.recent.rows.length).toBe(2);
  expect(doc.noop.error).toBeNull();
  expect(doc.noop.rows.length).toBe(2);
  expect(doc.spend.error).toBeNull();

  const text = formatAsk(doc);
  expect(text).toContain("unavailable — factory: control plane unreachable");
  expect(text).not.toContain("no dispatchable tickets");
  expect(text).not.toContain("nothing claimed");
  expect(text).not.toContain("nothing held");
});

test("runtime-database sections fail independently of the tracker", async () => {
  const plane = seedPlane();
  const doc = await gatherAsk(
    askArgs({ controlPlaneFor: () => plane, db: null }),
  );

  expect(doc.recent.error).toContain("runtime database not available");
  expect(doc.recent.rows).toEqual([]);
  expect(doc.noop.error).toContain("runtime database not available");
  // Tracker sections are untouched by a missing runtime database.
  expect(doc.queue.error).toBeNull();
  expect(doc.queue.rows.length).toBe(1);
  // Spend still reports transcript totals, and names the part it lost.
  expect(doc.spend.error).toBeNull();
  expect(doc.spend.today.runs).toBe(1);
  expect(doc.spend.errors[0]).toMatchObject({ source: "runtime.db" });
  expect(formatAsk(doc)).toContain("partial — runtime.db");
});

test("--section returns only the named sections", async () => {
  const plane = seedPlane();
  const doc = await gatherAsk(
    askArgs({
      controlPlaneFor: () => plane,
      sections: parseSections("held,queue"),
    }),
  );

  expect(doc.sections).toEqual(["queue", "held"]);
  expect(Object.keys(doc).filter((k) => SECTIONS.includes(k))).toEqual([
    "queue",
    "held",
  ]);
  for (const absent of ["inflight", "recent", "noop", "spend"])
    expect(doc[absent]).toBeUndefined();
  const text = formatAsk(doc);
  expect(text).toContain("QUEUE");
  expect(text).not.toContain("RECENT RUNS");
});

test("an unknown section name exits non-zero naming the valid set", () => {
  expect(() => parseSections("queue,bogus")).toThrow(/"bogus"/);
  expect(() => parseSections("queue,bogus")).toThrow(
    /valid sections: queue, inflight, held, recent, noop, spend/,
  );

  const proc = Bun.spawnSync({
    cmd: ["bun", ASK, "--section", "bogus"],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(2);
  expect(proc.stderr.toString()).toContain(
    "valid sections: queue, inflight, held, recent, noop, spend",
  );
});

test("a full ask reaches the control plane with read verbs only", async () => {
  const plane = seedPlane();
  await gatherAsk(askArgs({ controlPlaneFor: () => plane }));

  expect(plane.calls.length).toBeGreaterThan(0);
  const used = [...new Set(plane.calls.map((c) => c.op))].sort();
  expect(used).toEqual(["listComments", "listDispatchable", "listTickets"]);
  for (const write of WRITE_OPS)
    expect(plane.calls.some((c) => c.op === write)).toBe(false);

  // Read-only by CONSTRUCTION, not only by this run's luck: the module must
  // not contain a call to a write verb on any path, reached or not.
  const source = readFileSync(ASK, "utf8");
  for (const write of WRITE_OPS)
    expect(source).not.toMatch(new RegExp(`\\.${write}\\s*\\(`));
});
