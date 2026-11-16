import path from "node:path";
import { trackTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-chain-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chainKeyOf, chainView } from "./api-chain.mjs";
import {
  envelope,
  makeServer as makeApiServer,
  registry,
} from "./api-test-helpers.mjs";
import { admitChainEvent } from "./chain.mjs";

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

/**
 * Chain trace endpoint (WM-527). Fixture is a fan-out tree:
 *
 *   origin (test/origin-1, correlationId corr-1)
 *     └─ run-1 (work-scan)
 *          ├─ chain-run-1-A → run-2 (dispatch)
 *          │     └─ chain-run-2 → run-3 (merge-scan)
 *          └─ chain-run-1-B → (dead-lettered, no run)
 *
 * plus an unrelated event under another correlation that must not leak in.
 */
describe("GET /chain/:correlationId (WM-527)", () => {
  let s;
  const t = (n) => new Date(Date.UTC(2026, 7, 17, 12, n)).toISOString();

  function insertRun(db, runId, agent, state, at, { eventSource, eventId }) {
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      runId,
      `${runId}-key`,
      JSON.stringify({ agent, adapter: "fake", input: { repo: "factory" } }),
      `sha256:${runId}`,
      state,
      at,
      at,
    );
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, started_at, finished_at, terminal_state, reason_code)
       VALUES (?, 1, 1, ?, ?, ?, ?)`,
    ).run(
      runId,
      at,
      state === "RUNNING" ? null : at,
      state === "RUNNING" ? null : state,
      null,
    );
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', 'approved', ?, 600)`,
    ).run(`prop-${runId}`, eventSource, eventId, runId, at);
  }

  beforeAll(async () => {
    s = await makeServer();
    // `chain` is a reserved provenance at the public intake; derived events
    // enter through the emitter's admission path like the real chain does.
    const admit = (overrides) => {
      if (overrides.source !== "chain")
        return s.client.replay(envelope(overrides));
      const result = admitChainEvent(s.db, registry, envelope(overrides));
      expect(result.admitted).toBe(true);
      return result;
    };
    await admit({
      eventId: "origin-1",
      correlationId: "corr-1",
      occurredAt: t(0),
    });
    await admit({
      eventId: "elsewhere",
      correlationId: "corr-other",
      occurredAt: t(0),
    });
    insertRun(s.db, "run-1", "work-scan@1", "COMPLETED", t(1), {
      eventSource: "test",
      eventId: "origin-1",
    });
    await admit({
      eventId: "chain-run-1-A",
      source: "chain",
      type: "factory.work.requested",
      correlationId: "corr-1",
      causationId: "run-1",
      occurredAt: t(2),
    });
    await admit({
      eventId: "chain-run-1-B",
      source: "chain",
      type: "factory.work.requested",
      correlationId: "corr-1",
      causationId: "run-1",
      occurredAt: t(2),
    });
    insertRun(s.db, "run-2", "dispatch@1", "COMPLETED", t(3), {
      eventSource: "chain",
      eventId: "chain-run-1-A",
    });
    await admit({
      eventId: "chain-run-2",
      source: "chain",
      type: "factory.merge.scan.requested",
      correlationId: "corr-1",
      causationId: "run-2",
      occurredAt: t(4),
    });
    insertRun(s.db, "run-3", "merge-scan@1", "RUNNING", t(5), {
      eventSource: "chain",
      eventId: "chain-run-2",
    });
    s.db
      .query(
        `UPDATE events SET status = 'dead_lettered' WHERE event_id = 'chain-run-1-B'`,
      )
      .run();
  });
  afterAll(() => s.close());

  test("returns every event and run under the correlation, parent links intact", async () => {
    const res = await fetch(s.url("/chain/corr-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.correlationId).toBe("corr-1");
    expect(body.events.map((e) => e.eventId).sort()).toEqual([
      "chain-run-1-A",
      "chain-run-1-B",
      "chain-run-2",
      "origin-1",
    ]);
    expect(body.events.find((e) => e.eventId === "elsewhere")).toBeUndefined();

    const byId = Object.fromEntries(body.events.map((e) => [e.eventId, e]));
    expect(byId["origin-1"].causationId).toBeNull();
    expect(byId["origin-1"].runId).toBe("run-1");
    expect(byId["origin-1"].proposalId).toBe("prop-run-1");
    expect(byId["chain-run-1-A"].causationId).toBe("run-1");
    expect(byId["chain-run-1-A"].runId).toBe("run-2");
    expect(byId["chain-run-1-B"].causationId).toBe("run-1");
    expect(byId["chain-run-1-B"].runId).toBeNull();
    expect(byId["chain-run-1-B"].status).toBe("dead_lettered");
    expect(byId["chain-run-2"].causationId).toBe("run-2");
    expect(byId["chain-run-2"].runId).toBe("run-3");
    expect(byId["origin-1"].envelope).toMatchObject({
      schemaVersion: "factory.event/v1",
      eventId: "origin-1",
      payload: { repos: ["ok"] },
    });
    expect(byId["chain-run-1-A"].envelope).toMatchObject({
      schemaVersion: "factory.event/v1",
      eventId: "chain-run-1-A",
      type: "factory.work.requested",
    });

    expect(body.runs.map((r) => r.runId)).toEqual(["run-1", "run-2", "run-3"]);
    const run2 = body.runs.find((r) => r.runId === "run-2");
    expect(run2).toMatchObject({
      state: "COMPLETED",
      agent: "dispatch@1",
      adapter: "fake",
      eventSource: "chain",
      eventId: "chain-run-1-A",
      repos: ["factory"],
    });
    expect(run2.startedAt).toBeTruthy();
    const run3 = body.runs.find((r) => r.runId === "run-3");
    expect(run3.state).toBe("RUNNING");
    expect(run3.finishedAt).toBeNull();
  });

  test("marks a historic malformed envelope without overloading its payload", () => {
    const original = s.db
      .query("SELECT envelope_json FROM events WHERE event_id = ?")
      .get("chain-run-1-B").envelope_json;
    s.db
      .query("UPDATE events SET envelope_json = ? WHERE event_id = ?")
      .run("{historic malformed JSON", "chain-run-1-B");
    try {
      const event = chainView(s.db, "corr-1").events.find(
        (item) => item.eventId === "chain-run-1-B",
      );
      expect(event.envelope).toBeNull();
      expect(event.envelopeMalformed).toBe(true);
      expect(event.repos).toEqual([]);
    } finally {
      s.db
        .query("UPDATE events SET envelope_json = ? WHERE event_id = ?")
        .run(original, "chain-run-1-B");
    }
  });

  test("returns a completed event's full envelope", () => {
    const original = s.db
      .query("SELECT type, envelope_json FROM events WHERE event_id = ?")
      .get("chain-run-1-B");
    const completed = envelope({
      eventId: "chain-run-1-B",
      source: "chain",
      type: "factory.work.completed",
      correlationId: "corr-1",
      causationId: "run-1",
      payload: { repo: "factory", outcome: "completed" },
      malformed: true,
    });
    s.db
      .query("UPDATE events SET type = ?, envelope_json = ? WHERE event_id = ?")
      .run(completed.type, JSON.stringify(completed), "chain-run-1-B");
    try {
      const event = chainView(s.db, "corr-1").events.find(
        (item) => item.eventId === "chain-run-1-B",
      );
      expect(event.type).toBe("factory.work.completed");
      expect(event.envelope).toMatchObject({
        type: "factory.work.completed",
        payload: { repo: "factory", outcome: "completed" },
        malformed: true,
      });
      expect(event.envelopeMalformed).toBe(false);
    } finally {
      s.db
        .query(
          "UPDATE events SET type = ?, envelope_json = ? WHERE event_id = ?",
        )
        .run(original.type, original.envelope_json, "chain-run-1-B");
    }
  });

  test("falls back to the origin's own eventId when it carried no correlation id", async () => {
    await s.client.replay(
      envelope({
        eventId: "bare-origin",
        correlationId: null,
        occurredAt: t(6),
      }),
    );
    insertRun(s.db, "run-bare", "triage-scan@1", "COMPLETED", t(7), {
      eventSource: "test",
      eventId: "bare-origin",
    });
    expect(
      admitChainEvent(
        s.db,
        registry,
        envelope({
          eventId: "chain-run-bare",
          source: "chain",
          correlationId: "bare-origin",
          causationId: "run-bare",
          occurredAt: t(8),
        }),
      ).admitted,
    ).toBe(true);
    const body = await (await fetch(s.url("/chain/bare-origin"))).json();
    expect(body.events.map((e) => e.eventId).sort()).toEqual([
      "bare-origin",
      "chain-run-bare",
    ]);
    expect(body.runs.map((r) => r.runId)).toEqual(["run-bare"]);
    expect(chainKeyOf({ correlationId: null, eventId: "bare-origin" })).toBe(
      "bare-origin",
    );
    expect(chainKeyOf({ correlationId: "corr-1", eventId: "x" })).toBe(
      "corr-1",
    );
  });

  test("includes a causation parent run that lives outside the correlation, as a root", () => {
    s.db
      .query(
        `UPDATE events SET correlation_id = 'corr-split' WHERE event_id = 'chain-run-2'`,
      )
      .run();
    try {
      const view = chainView(s.db, "corr-split");
      expect(view.events.map((e) => e.eventId)).toEqual(["chain-run-2"]);
      // run-2 is the parent (via causationId), run-3 is the child run.
      expect(view.runs.map((r) => r.runId)).toEqual(["run-2", "run-3"]);
    } finally {
      s.db
        .query(
          `UPDATE events SET correlation_id = 'corr-1' WHERE event_id = 'chain-run-2'`,
        )
        .run();
    }
  });

  test("unknown correlation → 404; id is URL-decoded", async () => {
    expect((await fetch(s.url("/chain/nope"))).status).toBe(404);
    expect(
      (await fetch(s.url("/chain/" + encodeURIComponent("corr-1")))).status,
    ).toBe(200);
    expect((await fetch(s.url("/chain/"))).status).not.toBe(200);
  });
});

describe("GET /chains (WM-537)", () => {
  let s;
  const now = Date.UTC(2026, 7, 17, 14, 0);
  const t = (hour, minute = 0) =>
    new Date(Date.UTC(2026, 7, 17, hour, minute)).toISOString();

  function insertRun(db, runId, state, at, eventId, repo) {
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      runId,
      `${runId}-key`,
      JSON.stringify({ agent: "test@1", adapter: "fake", input: { repo } }),
      `sha256:${runId}`,
      state,
      at,
      at,
    );
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, status, created_at, ttl_seconds)
       VALUES (?, 'test', ?, ?, 'run', 'approved', ?, 600)`,
    ).run(`prop-${runId}`, eventId, runId, at);
  }

  beforeAll(async () => {
    s = await makeServer({ now: () => now });
    await s.client.replay(
      envelope({
        eventId: "origin-alpha",
        correlationId: "corr-alpha",
        occurredAt: t(12),
        payload: { repo: "factory" },
      }),
    );
    insertRun(
      s.db,
      "run-alpha",
      "COMPLETED",
      t(12, 5),
      "origin-alpha",
      "factory",
    );
    expect(
      admitChainEvent(
        s.db,
        registry,
        envelope({
          eventId: "alpha-child",
          source: "chain",
          type: "factory.child.requested",
          correlationId: "corr-alpha",
          causationId: "run-alpha",
          occurredAt: t(12, 10),
          payload: { repo: "factory" },
        }),
      ).admitted,
    ).toBe(true);

    await s.client.replay(
      envelope({
        eventId: "origin-bravo",
        correlationId: null,
        type: "factory.bravo.requested",
        occurredAt: t(12, 20),
        payload: { repo: "bravo" },
      }),
    );
    insertRun(s.db, "run-bravo", "RUNNING", t(12, 25), "origin-bravo", "bravo");

    await s.client.replay(
      envelope({
        eventId: "single-charlie",
        correlationId: null,
        type: "factory.charlie.requested",
        occurredAt: t(12, 30),
        payload: { repo: "charlie" },
      }),
    );
    await s.client.replay(
      envelope({
        eventId: "outside-window",
        correlationId: null,
        occurredAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      }),
    );
    // Intake stamps admitted_at from the injected clock; make this fixture's
    // chronology explicit so the endpoint's window/order assertions are real.
    s.db.query(`UPDATE events SET admitted_at = occurred_at`).run();
  });
  afterAll(() => s.close());

  test("lists recent chains newest first with origins, depth, tallies, singles, and cutoff", async () => {
    const res = await fetch(s.url("/chains?window=2h&limit=100"));
    expect(res.status).toBe(200);
    const { chains } = await res.json();
    expect(chains.map((chain) => chain.correlationId)).toEqual([
      "single-charlie",
      "origin-bravo",
      "corr-alpha",
    ]);
    expect(
      chains.find((chain) => chain.correlationId === "outside-window"),
    ).toBeUndefined();
    expect(chains[0]).toMatchObject({
      correlationId: "single-charlie",
      origin: {
        source: "test",
        eventId: "single-charlie",
        type: "factory.charlie.requested",
      },
      eventCount: 1,
      runCount: 0,
      maxDepth: 0,
      states: {},
      repos: ["charlie"],
      single: true,
    });
    expect(chains[1]).toMatchObject({
      correlationId: "origin-bravo",
      runCount: 1,
      states: { RUNNING: 1 },
      repos: ["bravo"],
      single: false,
    });
    expect(chains[2]).toMatchObject({
      correlationId: "corr-alpha",
      eventCount: 2,
      runCount: 1,
      maxDepth: 1,
      states: { COMPLETED: 1 },
      repos: ["factory"],
    });
  });

  test("validates window and limit and applies the limit", async () => {
    for (const path of [
      "/chains?window=soon",
      "/chains?limit=abc",
      "/chains?limit=0",
      "/chains?limit=501",
    ]) {
      const response = await fetch(s.url(path));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: path.includes("window") ? "invalid_window" : "invalid_limit",
        message: expect.any(String),
      });
    }
    const body = await (await fetch(s.url("/chains?window=2h&limit=2"))).json();
    expect(body.chains).toHaveLength(2);
  });
});
