import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chainKeyOf, chainView } from "./api-chain.mjs";
import { envelope, makeServer, registry } from "./api-test-helpers.mjs";
import { admitChainEvent } from "./chain.mjs";

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
    ).run(runId, at, state === "RUNNING" ? null : at, state === "RUNNING" ? null : state, null);
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
      if (overrides.source !== "chain") return s.client.replay(envelope(overrides));
      const result = admitChainEvent(s.db, registry, envelope(overrides));
      expect(result.admitted).toBe(true);
      return result;
    };
    await admit({ eventId: "origin-1", correlationId: "corr-1", occurredAt: t(0) });
    await admit({ eventId: "elsewhere", correlationId: "corr-other", occurredAt: t(0) });
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
      .query(`UPDATE events SET status = 'dead_lettered' WHERE event_id = 'chain-run-1-B'`)
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

  test("falls back to the origin's own eventId when it carried no correlation id", async () => {
    await s.client.replay(
      envelope({ eventId: "bare-origin", correlationId: null, occurredAt: t(6) }),
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
    expect(body.events.map((e) => e.eventId).sort()).toEqual(["bare-origin", "chain-run-bare"]);
    expect(body.runs.map((r) => r.runId)).toEqual(["run-bare"]);
    expect(chainKeyOf({ correlationId: null, eventId: "bare-origin" })).toBe("bare-origin");
    expect(chainKeyOf({ correlationId: "corr-1", eventId: "x" })).toBe("corr-1");
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
        .query(`UPDATE events SET correlation_id = 'corr-1' WHERE event_id = 'chain-run-2'`)
        .run();
    }
  });

  test("unknown correlation → 404; id is URL-decoded", async () => {
    expect((await fetch(s.url("/chain/nope"))).status).toBe(404);
    expect((await fetch(s.url("/chain/" + encodeURIComponent("corr-1")))).status).toBe(200);
    expect((await fetch(s.url("/chain/"))).status).not.toBe(200);
  });
});
