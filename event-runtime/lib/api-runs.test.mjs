import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GH_SECRET,
  PV,
  SECRET,
  apiClient,
  deregisterWorker,
  envelope,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  makeServer,
  mkdirSync,
  mkdtempSync,
  observedModelFromTranscript,
  openDb,
  os,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  rejection,
  repoNamesFromInput,
  registry,
  runOnce,
  sign,
  startApi,
  utimesSync,
  writeFileSync,
} from "./api-test-helpers.mjs";

describe("repoNamesFromInput (OPS-356)", () => {
  test("unscoped is []; repoPin / repo / repos[] (string or {name}); dedupes", () => {
    expect(repoNamesFromInput(null)).toEqual([]);
    expect(repoNamesFromInput({})).toEqual([]);
    expect(repoNamesFromInput({ repoPin: { repo: "bj29" } })).toEqual(["bj29"]);
    expect(repoNamesFromInput({ repo: "coach-wattz" })).toEqual([
      "coach-wattz",
    ]);
    expect(repoNamesFromInput({ repos: ["ok", { name: "bj29" }] })).toEqual([
      "ok",
      "bj29",
    ]);
    expect(
      repoNamesFromInput({
        repo: "bj29",
        repoPin: { repo: "bj29" },
        repos: ["bj29"],
      }),
    ).toEqual(["bj29"]);
  });
});

describe("list views carry repos[] (OPS-356)", () => {
  test("GET /events exposes repos from payload; unscoped is []", async () => {
    const s = await makeServer();
    try {
      await s.client.replay(
        envelope({ eventId: "repos-ok", payload: { repos: ["ok"] } }),
      );
      await s.client.replay(
        envelope({
          eventId: "repos-pin",
          payload: { repoPin: { repo: "bj29", ref: "develop" } },
        }),
      );
      await s.client.replay(envelope({ eventId: "repos-none", payload: {} }));
      const { events } = await s.client.events();
      expect(events.find((e) => e.eventId === "repos-ok").repos).toEqual([
        "ok",
      ]);
      expect(events.find((e) => e.eventId === "repos-pin").repos).toEqual([
        "bj29",
      ]);
      expect(events.find((e) => e.eventId === "repos-none").repos).toEqual([]);
    } finally {
      s.close();
    }
  });
});

describe("watched flow and operator verbs (§12, §13, §15)", () => {
  let s;
  let flowProposalId;
  let flowRunId;
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-api-ws-"));
  // event-types.json maps to the "pi" adapter (WM-215); back it with the fake so
  // no real pi process ever spawns in tests.
  const adapters = { pi: fake };
  const workerOpts = () => ({
    workspacesRoot: workspaces,
    owner: "w-test",
    policyVersion: PV,
  });

  /** Replay + plan one envelope, then return its open proposal via the API. */
  async function planned(eventId) {
    const admitted = await s.client.replay(envelope({ eventId }));
    expect(admitted.admitted).toBe(true);
    planAdmittedEvents(s.db, registry, { policyVersion: PV });
    const { proposals } = await s.client.proposals();
    const mine = proposals.find((p) =>
      p.spec?.idempotencyKey?.includes(eventId),
    );
    expect(mine).toBeTruthy();
    return mine;
  }

  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  test("POST /replay without signature admits (§15 replay verb)", async () => {
    const outcome = await s.client.replay(envelope({ eventId: "flow-1" }));
    expect(outcome).toEqual({
      admitted: true,
      duplicate: false,
      eventId: "flow-1",
    });
    expect(s.onEvents).toEqual(["admitted"]);
  });

  test("full watched flow: plan → proposal → approve → QUEUED → runOnce → COMPLETED", async () => {
    expect(planAdmittedEvents(s.db, registry, { policyVersion: PV })).toEqual({
      planned: 1,
      failed: 0,
      deadLettered: 0,
    });

    const { proposals } = await s.client.proposals();
    expect(proposals).toHaveLength(1);
    const prop = proposals[0];
    expect(prop.decision).toBe("run");
    expect(prop.expired).toBe(false);
    expect(prop.agent).toBe("factory-status-report@1");
    expect(prop.repos).toEqual(["ok"]);
    expect(prop.spec.adapter).toBe("pi");
    expect(prop.ttl_seconds).toBe(1800);
    flowProposalId = prop.id;

    const approved = await s.client.approve(prop.id);
    expect(approved).toEqual({ approved: true, runId: prop.runId });
    flowRunId = approved.runId;

    const queued = await s.client.run(flowRunId);
    expect(queued.run.state).toBe("QUEUED");

    const summary = await runOnce(s.db, registry, adapters, workerOpts());
    expect(summary.terminalState).toBe("COMPLETED");

    const done = await s.client.run(flowRunId);
    expect(done.run.state).toBe("COMPLETED");
    expect(done.run.spec.agent).toBe("factory-status-report@1");
    expect(done.result.terminalState).toBe("completed");
    expect(done.result.artifactHash).toMatch(/^sha256:/);
    expect(done.receipt.verificationStatus).toBe("passed");
    expect(done.receipt.artifactHash).toBe(done.result.artifactHash);
    expect(done.lifecycle.map((e) => e.to_state)).toEqual([
      "PROPOSED",
      "APPROVED",
      "QUEUED",
      "LEASED",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]);
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts[0].terminal_state).toBe("COMPLETED");

    const list = await s.client.runs();
    expect(list.runs.map((r) => r.runId)).toContain(flowRunId);
    expect(list.runs[0].agent).toBe("factory-status-report@1");
    expect(list.runs[0].repos).toEqual(["ok"]);
    expect((await s.client.runs("COMPLETED")).runs).toHaveLength(1);
    expect((await s.client.runs("QUEUED")).runs).toHaveLength(0);

    const { events } = await s.client.events("planned");
    expect(events.map((e) => e.eventId)).toContain("flow-1");
    expect(events[0].envelope.type).toBe("factory.status-report.requested");

    const status = await s.client.status();
    expect(status.events).toEqual({
      admitted: 0,
      planned: 1,
      noop: 0,
      human_needed: 0,
      dead_lettered: 0,
    });
    expect(status.proposals).toEqual({ open: 0, expired: 0 });
    expect(status.runs.byState).toEqual({ COMPLETED: 1 });
    expect(status.anomalies.expiredOpenProposals).toEqual([]);
    expect(status.anomalies.staleLeases).toBe(0);
    expect(status.anomalies.deadLettered).toEqual([]);
    expect(status.anomalies.unpublishedOutbox).toBe(1); // completion event, not yet published
    expect(status.anomalies.ambiguousOpenProposals).toEqual([]);
  });

  test("approve unknown proposal → 404; approve twice → 409", async () => {
    const unknown = await rejection(s.client.approve("prop_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown proposal prop_nope");

    const again = await rejection(s.client.approve(flowProposalId));
    expect(again.status).toBe(409);
    expect(again.message).toContain("not open");
  });

  test("reject an open proposal → run CANCELLED", async () => {
    const prop = await planned("rej-1");
    const rejected = await s.client.reject(prop.id, "not today");
    expect(rejected.rejected).toBe(true);

    const run = await s.client.run(prop.runId);
    expect(run.run.state).toBe("CANCELLED");
    expect(run.lifecycle.at(-1).reason).toBe("proposal_rejected");
    expect(run.lifecycle.at(-1).actor).toBe("operator");

    const rejectAgain = await rejection(s.client.reject(prop.id, "again"));
    expect(rejectAgain.status).toBe(409);
    expect(rejectAgain.message).toContain("not open");
  });

  test("cancel a QUEUED run → 200; cancel again → 409; unknown run → 404", async () => {
    const prop = await planned("can-1");
    const { runId } = await s.client.approve(prop.id);
    expect((await s.client.run(runId)).run.state).toBe("QUEUED");

    expect(await s.client.cancel(runId, "changed my mind")).toEqual({
      cancelled: true,
    });
    const view = await s.client.run(runId);
    expect(view.run.state).toBe("CANCELLED");
    expect(view.lifecycle.at(-1).actor).toBe("operator");

    const again = await rejection(s.client.cancel(runId));
    expect(again.status).toBe(409);
    expect(again.message).toContain("illegal transition");

    const unknown = await rejection(s.client.cancel("run_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown run run_nope");
  });

  test("cancel a PROPOSED run closes its open proposal", async () => {
    const prop = await planned("can-proposed-1");
    expect((await s.client.run(prop.runId)).run.state).toBe("PROPOSED");
    expect((await s.client.proposals()).proposals.map((p) => p.id)).toContain(
      prop.id,
    );

    expect(await s.client.cancel(prop.runId, "never mind")).toEqual({
      cancelled: true,
    });
    expect((await s.client.run(prop.runId)).run.state).toBe("CANCELLED");

    const open = await s.client.proposals();
    expect(open.proposals.map((p) => p.id)).not.toContain(prop.id);

    const history = await s.client.proposals("all");
    const decided = history.proposals.find((p) => p.id === prop.id);
    expect(decided.status).toBe("rejected");
    expect(decided.reason).toBe("run_cancelled");
    expect(decided.decided_by).toBe("operator");
  });

  test("cancel with two open proposals still cancels and signals the ambiguity", async () => {
    const prop = await planned("can-ambiguous-1");
    const at = new Date().toISOString();
    s.db
      .query(
        `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', ?, 1800)`,
      )
      .run(
        "prop_extra_ambiguous",
        prop.eventSource,
        prop.eventId,
        prop.runId,
        at,
      );

    try {
      expect(await s.client.cancel(prop.runId, "never mind")).toEqual({
        cancelled: true,
        ambiguousOpenProposals: [{ runId: prop.runId, count: 2 }],
      });
      expect((await s.client.run(prop.runId)).run.state).toBe("CANCELLED");

      const open = await s.client.proposals();
      expect(open.proposals.map((p) => p.id)).toContain(prop.id);
      expect(open.proposals.map((p) => p.id)).toContain("prop_extra_ambiguous");

      const status = await s.client.status();
      expect(status.anomalies.ambiguousOpenProposals).toEqual([
        { runId: prop.runId, count: 2 },
      ]);
    } finally {
      s.db
        .query(`DELETE FROM proposals WHERE id IN (?, ?)`)
        .run(prop.id, "prop_extra_ambiguous");
    }
  });

  test("retry: 404 on unknown run, 409 when attempts are exhausted, queued with force", async () => {
    const prop = await planned("retry-1");
    const { runId } = await s.client.approve(prop.id);
    // Deterministic terminal FAILED: run with an empty adapters map so the
    // spec's "pi" adapter is unknown (no requeue, attempts consumed).
    const summary = await runOnce(s.db, registry, {}, workerOpts());
    expect(summary.runId).toBe(runId);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("unknown_adapter");

    const exhausted = await rejection(s.client.retry(runId));
    expect(exhausted.status).toBe(409);
    expect(exhausted.message).toBe("attempts_exhausted");

    expect(await s.client.retry(runId, { force: true })).toEqual({
      queued: true,
    });
    expect((await s.client.run(runId)).run.state).toBe("QUEUED");
    await s.client.cancel(runId, "test cleanup");

    const unknown = await rejection(s.client.retry("run_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown run run_nope");
  });
});

describe("webui surface: proposal linkage, history, journal, outbox, requeue (OPS-212)", () => {
  test("proposals carry their originating event; history filter works; runs list is enriched", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "link-1" }));
      planAdmittedEvents(db, registry, {
        policyVersion: PV,
        adapterOverride: "fake",
      });

      const { proposals } = await client.proposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0].eventId).toBe("link-1");
      expect(proposals[0].eventSource).toBe("test");

      await client.approve(proposals[0].id);
      await runOnce(
        db,
        registry,
        { pi: fake, fake },
        {
          workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
          owner: "test-worker",
          policyVersion: PV,
        },
      );

      const history = await client.proposals("approved");
      expect(history.proposals).toHaveLength(1);
      expect(history.proposals[0].decided_by).toBe("operator");
      expect(
        (await client.proposals("all")).proposals.length,
      ).toBeGreaterThanOrEqual(1);

      const { runs } = await client.runs();
      expect(runs[0].state).toBe("COMPLETED");
      expect(runs[0].reasonCode).toBe("ok");
      expect(runs[0].eventId).toBe("link-1");
      expect(runs[0].adapter).toBe("fake");
      expect(runs[0].maxAttempts).toBe(1);

      const { events } = await client.events();
      expect(events[0].eventId).toBe("link-1");
      expect(events[0].proposalId).toBe(proposals[0].id);
      expect(events[0].runId).toBe(runs[0].runId);
    } finally {
      server.close();
    }
  });

  test("journal feed pages by seq and outbox lists published result events", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "feed-1" }));
      planAdmittedEvents(db, registry, {
        policyVersion: PV,
        adapterOverride: "fake",
      });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      await runOnce(
        db,
        registry,
        { pi: fake, fake },
        {
          workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
          owner: "test-worker",
          policyVersion: PV,
        },
      );

      const journal = await client.journal();
      expect(journal.head).toBeGreaterThan(0);
      expect(journal.entries.map((e) => e.to)).toContain("COMPLETED");
      const after = await client.journal({ since: journal.head });
      expect(after.entries).toHaveLength(0);
      expect(after.head).toBe(journal.head);

      const { outbox } = await client.outbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event.type).toBe("factory.status-report.completed");
      expect(outbox[0].published_at).toBeNull(); // no serve loop in this test — sink not run
    } finally {
      server.close();
    }
  });

  test("requeue recovers a dead-lettered event and refuses everything else", async () => {
    const { db, server, port, onEvents } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "dead-1" }));
      db.query(
        `UPDATE events SET status = 'dead_lettered', plan_failures = 3, last_plan_error = 'boom' WHERE event_id = 'dead-1'`,
      ).run();

      expect((await client.requeue("test", "dead-1")).requeued).toBe(true);
      expect(onEvents).toContain("requeued");
      const { events } = await client.events("admitted");
      expect(events.map((e) => e.eventId)).toContain("dead-1");
      expect(events.find((e) => e.eventId === "dead-1").planFailures).toBe(0);

      const again = await rejection(client.requeue("test", "dead-1"));
      expect(again.status).toBe(409); // now admitted — not requeueable
      const missing = await rejection(client.requeue("test", "ghost"));
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("archives dead-lettered events and releases stalled worker leases from status anomalies (WM-326)", async () => {
    const nowMs = 300_000;
    const { db, server, port } = await makeServer({ now: () => nowMs });
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "dead-archive" }));
      db.query(
        `UPDATE events SET status = 'dead_lettered', plan_failures = 3, last_plan_error = 'historical failure'
         WHERE source = 'test' AND event_id = 'dead-archive'`,
      ).run();

      const spec = { timeoutSeconds: 60, maxAttempts: 2 };
      db.query(
        `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
         VALUES ('run-stalled', 'stalled-key', ?, 'sha256:stalled', 'LEASED', 1, ?, ?)`,
      ).run(
        JSON.stringify(spec),
        new Date(0).toISOString(),
        new Date(0).toISOString(),
      );
      db.query(
        `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, lease_expires_at)
         VALUES ('run-stalled', 1, 1, 'worker-stalled', ?)`,
      ).run(new Date(nowMs + 60_000).toISOString());
      registerWorker(db, { workerId: "worker-stalled", now: 0 });
      heartbeat(db, "worker-stalled", {
        state: "busy",
        runId: "run-stalled",
        now: 0,
      });

      const before = await client.status();
      expect(
        before.anomalies.deadLettered.map((event) => event.eventId),
      ).toEqual(["dead-archive"]);
      expect(
        before.anomalies.stalledWorkers.map((worker) => worker.workerId),
      ).toEqual(["worker-stalled"]);

      expect(await client.archive("test", "dead-archive")).toEqual({
        archived: true,
      });
      expect(
        await client.releaseWorker("worker-stalled", "run-stalled"),
      ).toEqual({
        released: true,
        runId: "run-stalled",
      });

      const after = await client.status();
      expect(after.anomalies.deadLettered).toEqual([]);
      expect(after.anomalies.stalledWorkers).toEqual([]);
      expect(
        db
          .query(
            `SELECT status, archived_at FROM events WHERE event_id = 'dead-archive'`,
          )
          .get(),
      ).toEqual({
        status: "dead_lettered",
        archived_at: new Date(nowMs).toISOString(),
      });
      expect(
        db.query(`SELECT state FROM runs WHERE run_id = 'run-stalled'`).get()
          .state,
      ).toBe("QUEUED");
      expect(
        db
          .query(
            `SELECT state, current_run FROM workers WHERE worker_id = 'worker-stalled'`,
          )
          .get(),
      ).toEqual({
        state: "stopped",
        current_run: null,
      });

      // Archiving is retry-safe, while invalid targets fail closed.
      expect(await client.archive("test", "dead-archive")).toEqual({
        archived: true,
      });
      expect((await rejection(client.archive("test", "ghost"))).status).toBe(
        404,
      );
      await client.replay(envelope({ eventId: "active-event" }));
      expect(
        (await rejection(client.archive("test", "active-event"))).status,
      ).toBe(409);
      expect(
        (await rejection(client.releaseWorker("ghost", "run-stalled"))).status,
      ).toBe(404);
    } finally {
      server.close();
    }
  });

  test("requeueing a human_needed event supersedes its open proposal", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(
        envelope({ eventId: "hn-1", type: "unregistered.event.type" }),
      );
      planAdmittedEvents(db, registry, { policyVersion: PV });
      const before = await client.proposals();
      expect(before.proposals[0].decision).toBe("human_needed");

      await client.requeue("test", "hn-1");
      expect((await client.proposals()).proposals).toHaveLength(0); // superseded, inbox clean
      const superseded = await client.proposals("superseded");
      expect(superseded.proposals[0].eventId).toBe("hn-1");
    } finally {
      server.close();
    }
  });
});

describe("run trace surfacing (OPS-295)", () => {
  test("GET /runs/:id/trace pages incrementally; 404 unknown; empty for an untraced run (OPS-295)", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(
        envelope({ eventId: "trace-1", payload: { repos: ["ok"] } }),
      );
      planAdmittedEvents(db, registry, {
        policyVersion: PV,
        adapterOverride: "fake",
      });
      await client.approve((await client.proposals()).proposals[0].id);
      const summary = await runOnce(
        db,
        registry,
        { pi: fake, fake },
        {
          workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
          owner: "test-worker",
          policyVersion: PV,
        },
      );
      expect(summary.terminalState).toBe("COMPLETED");

      // Page 1: two entries; head already points at the last row for the run.
      const first = await client.trace(summary.runId, { limit: 2 });
      expect(first.entries.map((e) => e.kind)).toEqual([
        "assistant_text",
        "tool_use",
      ]);
      expect(first.head).toBeGreaterThan(first.entries.at(-1).seq);

      // Page 2: resume from the last seen seq, get the rest.
      const rest = await client.trace(summary.runId, {
        since: first.entries.at(-1).seq,
      });
      expect(rest.entries.map((e) => e.kind)).toEqual(["tool_result", "usage"]);
      expect(rest.head).toBe(rest.entries.at(-1).seq);
      expect(rest.entries[0].attempt).toBe(1);
      expect(typeof rest.entries[0].ts).toBe("string");

      // Caught up: since=head → no entries, head unchanged.
      const done = await client.trace(summary.runId, { since: rest.head });
      expect(done).toEqual({ head: rest.head, entries: [] });

      // Unknown run → 404, matching GET /runs/:id.
      const unknown = await rejection(client.trace("run_nope"));
      expect(unknown.status).toBe(404);
      expect(unknown.message).toBe("unknown run run_nope");

      // A run that exists but never traced → head 0, empty entries.
      await client.replay(
        envelope({ eventId: "trace-2", payload: { repos: ["ok"] } }),
      );
      planAdmittedEvents(db, registry, {
        policyVersion: PV,
        adapterOverride: "fake",
      });
      const open = (await client.proposals()).proposals[0];
      const { runId: queuedRun } = await client.approve(open.id);
      expect(await client.trace(queuedRun)).toEqual({ head: 0, entries: [] });
    } finally {
      server.close();
    }
  });

});
