import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  openRuntimeDb,
  parseSections,
} from "./ask.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASK = path.join(HERE, "ask.mjs");
const ROOT = path.resolve(HERE, "..");

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.identifier, r]));

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
        // The GITHUB shape. lib/control-plane/github.mjs pins `startedAt` and
        // `lastCommentAt` to null unconditionally, and config/repos.yaml puts
        // the factory repo on that adapter — so this, not WM-2, is the primary
        // in-flight path. Without it the suite only ever sees Linear's richer
        // ticket and cannot tell a real heartbeat from a missing one.
        id: "t5",
        identifier: "WM-5",
        title: "Claimed on a GitHub-shaped tracker",
        state: { id: "s-progress", name: "In Progress", type: "started" },
        team,
        project,
        labels: [],
        assignee: { id: "u-2", name: "Grace" },
        createdAt: ago(30 * DAY),
        startedAt: null,
        updatedAt: ago(12 * MIN),
        comments: [],
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
  expect(doc.inflight.rows.map((r) => r.identifier).sort()).toEqual([
    "WM-2",
    "WM-5",
  ]);
  const claimed = byId(doc.inflight.rows);
  expect(claimed["WM-2"]).toMatchObject({
    assignee: "Ada",
    ageMs: 3 * HOUR,
    claimedAtSource: "startedAt",
    heartbeatAgeMs: 11 * MIN,
    heartbeatSource: "comment",
  });

  // held — with the newest comment, explicitly marked as such
  expect(doc.held.rows.map((r) => r.identifier)).toEqual(["WM-3"]);
  expect(doc.held.rows[0].holds).toEqual(["ai:blocked"]);
  expect(doc.held.rows[0].question).toBe(
    "Which base branch should this target?",
  );
  expect(doc.held.rows[0].questionSource).toBe("newest-comment");

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

test("in-flight age and heartbeat survive a tracker with no startedAt or lastCommentAt", async () => {
  // github.mjs pins startedAt and lastCommentAt to null, so this is the shape
  // the factory repo's own tickets arrive in. The bug this guards: age falling
  // back to createdAt (a 12-minute-old claim reading as "30d old") and an
  // UNKNOWN heartbeat rendering as a definite "never".
  const plane = seedPlane();
  const doc = await gatherAsk(askArgs({ controlPlaneFor: () => plane }));
  const row = byId(doc.inflight.rows)["WM-5"];

  expect(row.claimedAtSource).toBe("updatedAt");
  expect(row.ageMs).toBe(12 * MIN);
  expect(row.ageMs).not.toBe(30 * DAY);
  expect(row.heartbeatSource).toBe("updatedAt");
  expect(row.heartbeatAgeMs).toBe(12 * MIN);
  expect(row.lastHeartbeatAt).toBe(ago(12 * MIN));

  // A heartbeat that was never read must not render as one that never happened.
  const text = formatAsk(doc);
  expect(text).toContain("updated 12m ago");
  expect(text).not.toContain("never");
  expect(text).not.toContain("30d old");
});

test("a heartbeat the tracker cannot answer reads unknown, not never", async () => {
  const silent = {
    kind: "memory",
    async listTickets() {
      return [
        {
          identifier: "WM-9",
          title: "No timestamps at all",
          state: { name: "In Progress" },
          labels: [],
          createdAt: null,
          startedAt: null,
          updatedAt: null,
          lastCommentAt: null,
        },
      ];
    },
    async listDispatchable() {
      return [];
    },
    async listComments() {
      return [];
    },
  };
  const doc = await gatherAsk(
    askArgs({ controlPlaneFor: () => silent, sections: ["inflight"] }),
  );

  expect(doc.inflight.rows[0]).toMatchObject({
    heartbeatSource: "unknown",
    lastHeartbeatAt: null,
    heartbeatAgeMs: null,
    claimedAtSource: "unknown",
    ageMs: null,
  });
  expect(formatAsk(doc)).toContain("heartbeat unknown");
  expect(formatAsk(doc)).not.toContain("never");
});

test("held rows never present a comment as the outstanding question", async () => {
  // The human has ALREADY answered; the newest comment is their reply. Calling
  // that "the question" is the specific way this view lies, because it is the
  // view that answers "what is waiting on me".
  const answered = {
    kind: "memory",
    async listTickets() {
      return [
        {
          identifier: "WM-8",
          title: "Held, and answered",
          state: { name: "Blocked" },
          labels: [{ name: "ai:blocked" }],
          createdAt: ago(6 * HOUR),
          updatedAt: ago(1 * HOUR),
        },
      ];
    },
    async listDispatchable() {
      return [];
    },
    async listComments() {
      return [
        {
          id: "q",
          body: "Which base branch should this target?",
          createdAt: ago(5 * HOUR),
        },
        { id: "a", body: "develop, always.", createdAt: ago(1 * HOUR) },
      ];
    },
  };
  const doc = await gatherAsk(
    askArgs({ controlPlaneFor: () => answered, sections: ["held"] }),
  );

  expect(doc.held.rows[0].question).toBe("develop, always.");
  expect(doc.held.rows[0].questionSource).toBe("newest-comment");

  const text = formatAsk(doc);
  expect(text).toContain("last comment: develop, always.");
  expect(text).toContain("may be the reply, not the ask");
});

test("a held comment read that failed does not render like a ticket with no comments", async () => {
  // Rate limits hit these reads one ticket at a time, so a per-row failure is
  // the common case. Falling back to the title in both cases would repeat the
  // section-level "unavailable vs empty" mistake once per row.
  const flaky = {
    kind: "memory",
    async listTickets() {
      return ["WM-6", "WM-7"].map((identifier) => ({
        identifier,
        title: `Held ${identifier}`,
        state: { name: "Blocked" },
        labels: [{ name: "ai:blocked" }],
        createdAt: ago(6 * HOUR),
        updatedAt: ago(1 * HOUR),
      }));
    },
    async listDispatchable() {
      return [];
    },
    async listComments(identifier) {
      if (identifier === "WM-6") throw new Error("HTTP 403 rate limited");
      return [];
    },
  };
  const doc = await gatherAsk(
    askArgs({ controlPlaneFor: () => flaky, sections: ["held"] }),
  );

  // The section survives: both rows are present, neither is dropped.
  expect(doc.held.error).toBeNull();
  expect(doc.held.rows.length).toBe(2);
  const held = byId(doc.held.rows);
  expect(held["WM-6"].questionError).toContain("rate limited");
  expect(held["WM-6"].question).toBeNull();
  expect(held["WM-7"].questionError).toBeNull();
  expect(held["WM-7"].question).toBeNull();

  const text = formatAsk(doc);
  expect(text).toContain("comment unreadable — HTTP 403 rate limited");
  expect(text).toContain("(no comments)");
});

test("held comment reads are bounded-concurrent, not serialized", async () => {
  const HELD = 12;
  let inFlight = 0;
  let peak = 0;
  const plane = {
    kind: "memory",
    async listTickets() {
      return Array.from({ length: HELD }, (_, i) => ({
        identifier: `WM-${100 + i}`,
        title: `Held ${i}`,
        state: { name: "Blocked" },
        labels: [{ name: "ai:blocked" }],
        createdAt: ago(6 * HOUR),
        updatedAt: ago(1 * HOUR),
      }));
    },
    async listDispatchable() {
      return [];
    },
    async listComments(identifier) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
      return [{ id: "c", body: `note for ${identifier}`, createdAt: ago(MIN) }];
    },
  };

  const doc = await gatherAsk(
    askArgs({ controlPlaneFor: () => plane, sections: ["held"] }),
  );

  expect(doc.held.rows.length).toBe(HELD);
  // Serialized would peak at 1; unbounded would peak at HELD. Neither is right.
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(5);
  // Input order is preserved despite the fan-out.
  expect(doc.held.rows.map((r) => r.identifier)).toEqual(
    Array.from({ length: HELD }, (_, i) => `WM-${100 + i}`),
  );
  expect(doc.held.rows.every((r) => r.question?.includes("note for"))).toBe(
    true,
  );
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

/**
 * An on-disk runtime.db left with a `-wal` but no `-shm` — the state after an
 * unclean shutdown. A read-only connection cannot build the missing WAL index,
 * so `openRuntimeDb` must classify this before opening SQLite rather than fail
 * with a bare "unable to open database file".
 */
function seedUncleanDbHome() {
  const home = mkdtempSync(path.join(tmpdir(), "gh1114-home-"));
  temps.push(home);
  const file = path.join(home, "runtime.db");
  // A real, valid main database; close it so no live handle holds sidecars.
  openDb(file).close();
  rmSync(`${file}-shm`, { force: true });
  rmSync(`${file}-wal`, { force: true });
  // Recreate only the WAL sidecar: WAL present, index absent.
  writeFileSync(`${file}-wal`, Buffer.alloc(32));
  return { home, file };
}

test("openRuntimeDb reports an unclean WAL shutdown without touching the db", () => {
  const { file } = seedUncleanDbHome();

  expect(() => openRuntimeDb(file)).toThrow(/not shut down cleanly/);
  expect(() => openRuntimeDb(file)).toThrow(
    /start the event runtime or run any runtime writer once/,
  );
  // The guard must not create the index it refused to build.
  expect(existsSync(`${file}-shm`)).toBe(false);
  expect(existsSync(`${file}-wal`)).toBe(true);
});

test("gatherAsk carries the unclean-shutdown reason into runtime sections", async () => {
  const plane = seedPlane();
  const { home, file } = seedUncleanDbHome();
  const savedHome = process.env.FACTORY_EVENT_HOME;
  process.env.FACTORY_EVENT_HOME = home;
  try {
    // db: undefined → gatherAsk opens the runtime db itself, hitting the guard.
    const doc = await gatherAsk(
      askArgs({ controlPlaneFor: () => plane, db: undefined }),
    );

    for (const name of ["recent", "noop"]) {
      expect(doc[name].error).toContain("not shut down cleanly");
      expect(doc[name].rows).toEqual([]);
    }
    const runtimeSpend = doc.spend.errors.find(
      (e) => e.source === "runtime.db",
    );
    expect(runtimeSpend?.error).toContain("not shut down cleanly");

    // Unaffected sections still return real data, and spend keeps transcripts.
    expect(doc.queue.error).toBeNull();
    expect(doc.queue.rows.length).toBe(1);
    expect(doc.spend.error).toBeNull();
    expect(doc.spend.today.runs).toBe(1);

    const text = formatAsk(doc);
    expect(text).toContain("unavailable — runtime database was not shut down");
    expect(text).toContain("partial — runtime.db");

    // Reading it must never fabricate the WAL index (no immutable fallback).
    expect(existsSync(`${file}-shm`)).toBe(false);
  } finally {
    if (savedHome === undefined) delete process.env.FACTORY_EVENT_HOME;
    else process.env.FACTORY_EVENT_HOME = savedHome;
  }
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
