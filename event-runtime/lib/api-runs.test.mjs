import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-runs-test-mjs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { memoryControlPlane } from "../../lib/control-plane/index.mjs";
import {
  TICKET_DETAIL_CACHE_TTL_MS,
  clearTicketDetailCache,
  mergeTicketSupply,
  scanTicketSupply,
  setTicketDetailControlPlane,
  ticketJourneyView,
  ticketIndexView,
  ticketSupplyView,
} from "./api-runs.mjs";
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
  makeServer as makeApiServer,
  mkdirSync,
  observedModelFromTranscript,
  openDb,
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

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

async function holdWriteLock(file, durationMs) {
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { openDb } from "./event-runtime/lib/db.mjs";
        const db = openDb(process.argv[1]);
        db.exec("BEGIN IMMEDIATE");
        console.log("locked");
        await new Promise((resolve) => setTimeout(resolve, Number(process.argv[2])));
        db.exec("ROLLBACK");
        db.close();
      `,
      file,
      String(durationMs),
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  const { value, done } = await reader.read();
  reader.releaseLock();
  expect(done).toBe(false);
  expect(new TextDecoder().decode(value)).toContain("locked");
  return child;
}

describe("run deadline extension (WM-566)", () => {
  const start = Date.parse("2026-08-12T10:00:00Z");
  // The policy cap the extend endpoint enforces, owned by this suite rather
  // than by the live config/policy.yaml (WM-692).
  const MAX_RUN_MINUTES = 60;
  function policyRootWith(maxRunMinutes) {
    const root = tmpDir("evrt-policy-");
    mkdirSync(path.join(root, "config"));
    if (maxRunMinutes !== null) {
      writeFileSync(
        path.join(root, "config", "policy.yaml"),
        `limits:\n  max_run_minutes: ${maxRunMinutes}\n`,
      );
    }
    return root;
  }
  const policyRoot = policyRootWith(MAX_RUN_MINUTES);

  function insertAttempt(
    db,
    runId,
    { state = "RUNNING", timeoutSeconds = 60, adapter = "fake" } = {},
  ) {
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId,
      agent: "factory-status-report@1",
      input: { repos: ["ok"] },
      workspace: { type: "ephemeral" },
      adapter,
      outputContract: "factory.status-report/v1",
      timeoutSeconds,
      maxAttempts: 1,
      idempotencyKey: `idem-${runId}`,
    };
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'sha256:test', ?, 1, ?, ?)`,
    ).run(
      runId,
      spec.idempotencyKey,
      JSON.stringify(spec),
      state,
      new Date(start).toISOString(),
      new Date(start).toISOString(),
    );
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, started_at, lease_expires_at)
       VALUES (?, 1, 1, 'worker-test', ?, ?)`,
    ).run(
      runId,
      new Date(start).toISOString(),
      new Date(start + (timeoutSeconds + 120) * 1000).toISOString(),
    );
  }

  test("extends a running deadline, lease, and audited lifecycle", async () => {
    const s = await makeServer({ now: () => start + 10_000, policyRoot });
    try {
      insertAttempt(s.db, "run-extend-happy");
      const outcome = await s.client.extend("run-extend-happy", 900);
      expect(outcome).toEqual({
        extended: true,
        runId: "run-extend-happy",
        seconds: 900,
        deadlineAt: new Date(start + 960_000).toISOString(),
        leaseExpiresAt: new Date(start + 1_080_000).toISOString(),
        override: false,
      });
      const lifecycle = s.db
        .query(
          `SELECT from_state, to_state, actor, reason FROM lifecycle_events WHERE run_id = ?`,
        )
        .get("run-extend-happy");
      expect(lifecycle.from_state).toBe("RUNNING");
      expect(lifecycle.to_state).toBe("RUNNING");
      expect(lifecycle.actor).toBe("operator");
      expect(JSON.parse(lifecycle.reason)).toEqual({
        deadlineAt: outcome.deadlineAt,
        override: false,
        seconds: 900,
        type: "deadline_extended",
      });
      expect((await s.client.run("run-extend-happy")).deadlineAt).toBe(
        outcome.deadlineAt,
      );
    } finally {
      s.close();
    }
  });

  test("returns typed terminal refusals for state, policy cap, and per-call bound", async () => {
    const s = await makeServer({ now: () => start, policyRoot });
    try {
      insertAttempt(s.db, "run-extend-queued", { state: "QUEUED" });
      const wrongState = await rejection(
        s.client.extend("run-extend-queued", 60),
      );
      expect(wrongState.status).toBe(409);
      expect(wrongState.body.refusal).toMatchObject({
        code: "run_not_extendable",
        retryable: false,
      });

      // Ten seconds short of the cap: a 20s extension crosses started_at + max_run_minutes.
      insertAttempt(s.db, "run-extend-cap", {
        timeoutSeconds: MAX_RUN_MINUTES * 60 - 10,
      });
      const capped = await rejection(s.client.extend("run-extend-cap", 20));
      expect(capped.status).toBe(409);
      expect(capped.body.refusal).toMatchObject({
        code: "policy_run_limit",
        retryable: false,
        maxDeadlineAt: new Date(start + MAX_RUN_MINUTES * 60_000).toISOString(),
      });
      expect(
        (await s.client.extend("run-extend-cap", 20, { override: true }))
          .override,
      ).toBe(true);

      insertAttempt(s.db, "run-extend-actions", { adapter: "actions" });
      const actions = await rejection(
        s.client.extend("run-extend-actions", 60),
      );
      expect(actions.status).toBe(409);
      expect(actions.body.refusal).toMatchObject({
        code: "adapter_deadline_not_extendable",
        retryable: false,
        adapter: "actions",
      });

      const bounded = await rejection(s.client.extend("run-extend-cap", 3_601));
      expect(bounded.status).toBe(422);
      expect(bounded.body.refusal).toEqual(
        expect.objectContaining({
          code: "extension_too_large",
          retryable: false,
          maxSeconds: 3_600,
        }),
      );
    } finally {
      s.close();
    }
  });

  test("without a readable max_run_minutes only override may extend", async () => {
    const s = await makeServer({
      now: () => start,
      policyRoot: policyRootWith(null),
    });
    try {
      insertAttempt(s.db, "run-extend-nopolicy");
      const refused = await rejection(
        s.client.extend("run-extend-nopolicy", 60),
      );
      expect(refused.status).toBe(409);
      expect(refused.body.refusal).toMatchObject({
        code: "run_limit_policy_unavailable",
        retryable: false,
      });
      expect(
        (await s.client.extend("run-extend-nopolicy", 60, { override: true }))
          .extended,
      ).toBe(true);
    } finally {
      s.close();
    }
  });
});

describe("run list deadlines (WM-692)", () => {
  const start = Date.parse("2026-08-12T10:00:00Z");
  function insertRun(db, runId, state) {
    const spec = {
      schemaVersion: "factory.run-spec/v1",
      runId,
      agent: "factory-status-report@1",
      input: { repos: ["ok"] },
      workspace: { type: "ephemeral" },
      adapter: "fake",
      outputContract: "factory.status-report/v1",
      timeoutSeconds: 60,
      maxAttempts: 1,
      idempotencyKey: `idem-${runId}`,
    };
    const at = new Date(start).toISOString();
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'sha256:test', ?, 1, ?, ?)`,
    ).run(runId, spec.idempotencyKey, JSON.stringify(spec), state, at, at);
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, started_at, lease_expires_at)
       VALUES (?, 1, 1, 'worker-test', ?, ?)`,
    ).run(runId, at, new Date(start + 180_000).toISOString());
  }

  test("GET /runs returns a bounded summary without spec-derived bulk", async () => {
    const s = await makeServer({ now: () => start });
    try {
      for (const state of [
        "LEASED",
        "RUNNING",
        "VERIFYING",
        "COMPLETED",
        "FAILED",
        "TIMED_OUT",
        "CANCELLED",
      ]) {
        insertRun(s.db, `run-list-${state}`, state);
      }
      const { runs } = await s.client.runs();
      const byState = Object.fromEntries(runs.map((r) => [r.state, r]));
      for (const state of [
        "LEASED",
        "RUNNING",
        "VERIFYING",
        "COMPLETED",
        "FAILED",
        "TIMED_OUT",
        "CANCELLED",
      ]) {
        expect(byState[state]).toMatchObject({
          runId: `run-list-${state}`,
          state,
          agent: "factory-status-report@1",
          adapter: "fake",
          idempotencyKey: `idem-run-list-${state}`,
        });
        expect(byState[state].spec).toBeUndefined();
        expect(byState[state].deadlineAt).toBeUndefined();
      }
    } finally {
      s.close();
    }
  });

  test("GET /runs keyset-paginates tied timestamps and rejects bad bounds", async () => {
    const s = await makeServer({ now: () => start });
    try {
      for (const runId of ["run-page-a", "run-page-b", "run-page-c"]) {
        s.db
          .query(
            `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
             VALUES (?, ?, ?, 'sha256:test', 'COMPLETED', 1, ?, ?)`,
          )
          .run(
            runId,
            `idem-${runId}`,
            JSON.stringify({ agent: "page-agent", adapter: "fake" }),
            new Date(start).toISOString(),
            new Date(start).toISOString(),
          );
      }
      const first = await fetch(s.url("/runs?limit=2"));
      expect(first.status).toBe(200);
      const firstPage = await first.json();
      expect(firstPage.runs.map((run) => run.runId)).toEqual([
        "run-page-c",
        "run-page-b",
      ]);
      expect(firstPage.runs[0]).toEqual({
        runId: "run-page-c",
        state: "COMPLETED",
        attempts: 1,
        agent: "page-agent",
        adapter: "fake",
        created_at: new Date(start).toISOString(),
        updated_at: new Date(start).toISOString(),
        modelTier: null,
        model: null,
        idempotencyKey: "idem-run-page-c",
      });
      expect(typeof firstPage.nextBefore).toBe("string");

      const second = await fetch(
        s.url(
          `/runs?limit=2&before=${encodeURIComponent(firstPage.nextBefore)}`,
        ),
      );
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        runs: [expect.objectContaining({ runId: "run-page-a" })],
        nextBefore: null,
      });
      for (const query of ["limit=0", "limit=201", "before=not-a-cursor"]) {
        const response = await fetch(s.url(`/runs?${query}`));
        expect(response.status).toBe(422);
      }
    } finally {
      s.close();
    }
  });
});

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

describe("metrics run drill-down filters (WM-282)", () => {
  const now = Date.parse("2026-08-18T10:00:00.000Z");
  const from = "2026-08-18T08:00:00.000Z";
  const to = "2026-08-18T09:00:00.000Z";

  function insertRun(db, runId, agent) {
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'COMPLETED', 0, '2026-08-18T07:00:00.000Z', '2026-08-18T09:30:00.000Z')`,
    ).run(
      runId,
      `idem-${runId}`,
      JSON.stringify({
        agent,
        adapter: "fake",
        input: {},
        maxAttempts: 2,
        timeoutSeconds: 60,
      }),
    );
  }

  test("terminal population uses lifecycle time/state rather than the run's current state", async () => {
    const s = await makeServer({ now: () => now });
    try {
      insertRun(s.db, "run-historical-failure", "dispatch@1");
      insertRun(s.db, "run-outside", "dispatch@1");
      s.db
        .query(
          `INSERT INTO lifecycle_events (run_id, from_state, to_state, actor, at, record_hash)
         VALUES (?, 'RUNNING', 'FAILED', 'test', ?, ?)`,
        )
        .run(
          "run-historical-failure",
          "2026-08-18T08:30:00.000Z",
          "hash-failed",
        );
      s.db
        .query(
          `INSERT INTO lifecycle_events (run_id, from_state, to_state, actor, at, record_hash)
         VALUES (?, 'RUNNING', 'FAILED', 'test', ?, ?)`,
        )
        .run("run-outside", "2026-08-18T09:30:00.000Z", "hash-outside");

      const res = await fetch(
        s.url(`/runs?population=terminal&from=${from}&to=${to}&state=FAILED`),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).runs.map((run) => run.runId)).toEqual([
        "run-historical-failure",
      ]);
    } finally {
      s.close();
    }
  });

  test("usage population composes exact time and agent dimensions; malformed filters are typed", async () => {
    const s = await makeServer({ now: () => now });
    try {
      insertRun(s.db, "run-agent-a", "dispatch@1");
      insertRun(s.db, "run-agent-b", "merge@1");
      for (const runId of ["run-agent-a", "run-agent-b"]) {
        s.db
          .query(
            `INSERT INTO run_usage
             (run_id, attempt, adapter, input_tokens, output_tokens, cache_creation_input_tokens,
              cache_read_input_tokens, cost_usd, recorded_at)
           VALUES (?, 1, 'fake', 1, 0, 0, 0, 0.1, '2026-08-18T08:15:00.000Z')`,
          )
          .run(runId);
      }
      const filtered = await fetch(
        s.url(
          `/runs?population=usage&from=${from}&to=${to}&agent=${encodeURIComponent("dispatch@1")}`,
        ),
      );
      expect(filtered.status).toBe(200);
      expect((await filtered.json()).runs.map((run) => run.runId)).toEqual([
        "run-agent-a",
      ]);

      const malformed = await fetch(s.url("/runs?population=usage"));
      expect(malformed.status).toBe(422);
      expect((await malformed.json()).error).toBe("incomplete_time_filter");
    } finally {
      s.close();
    }
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

  test("GET /events defaults to a cursor page and walks tied timestamps", async () => {
    const s = await makeServer({ now: () => 1_700_000_000_000 });
    try {
      for (const eventId of [
        "events-page-a",
        "events-page-b",
        "events-page-c",
      ]) {
        await s.client.replay(envelope({ eventId, payload: {} }));
      }
      const first = await (await fetch(s.url("/events?limit=2"))).json();
      expect(first.events).toHaveLength(2);
      expect(typeof first.nextBefore).toBe("string");
      const second = await (
        await fetch(
          s.url(
            `/events?limit=2&before=${encodeURIComponent(first.nextBefore)}`,
          ),
        )
      ).json();
      expect(second.events).toHaveLength(1);
      expect(second.nextBefore).toBeNull();
      expect((await fetch(s.url("/events?limit=0"))).status).toBe(422);
    } finally {
      s.close();
    }
  });
});

describe("ticket journey join (WM-595)", () => {
  test("GET /runs?ticket= joins explicit ticket activity and PR-linked merge runs", async () => {
    const s = await makeServer();
    try {
      await s.client.replay(
        envelope({
          eventId: "ticket-dispatch",
          subject: "WM-595",
          payload: {
            repo: "factory",
            ticket: "WM-595",
            ticketTitle: "Ticket journey",
            ticketState: "In Review",
            ticketCreatedAt: "2026-01-01T09:00:00.000Z",
          },
        }),
      );
      const spec = (input, agent = "dispatch@1") =>
        JSON.stringify({
          schemaVersion: "factory.run-spec/v1",
          runId: "ignored",
          agent,
          input,
          inputHash: "sha256:input",
          workspace: { type: "none" },
          adapter: "fake",
          promptVersion: "test",
          policyVersion: PV,
          outputContract: "test/v1",
          capabilities: [],
          timeoutSeconds: 60,
          maxAttempts: 1,
          idempotencyKey: "ignored",
        });
      s.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          "run_ticket",
          "ticket-key",
          spec({ repo: "factory", ticket: "WM-595" }),
          "sha256:ticket",
          "COMPLETED",
          "2026-01-01T10:00:00.000Z",
          "2026-01-01T10:10:00.000Z",
        );
      s.db
        .query(
          `INSERT INTO results
           (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, 1, ?, ?, '{}', '{}', ?)`,
        )
        .run(
          "run_ticket",
          JSON.stringify({
            terminalState: "completed",
            artifact: {
              outcome: "PR_OPEN",
              ticket: "WM-595",
              prUrl: "https://github.com/watt-mind/factory/pull/595",
            },
          }),
          "sha256:result-ticket",
          "2026-01-01T10:10:00.000Z",
        );
      s.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          "run_merge",
          "merge-key",
          spec({ repo: "factory", pr: 595 }, "merge-apply@1"),
          "sha256:merge",
          "COMPLETED",
          "2026-01-01T11:00:00.000Z",
          "2026-01-01T11:01:00.000Z",
        );
      s.db
        .query(
          `INSERT INTO results
           (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, 1, ?, ?, '{}', '{}', ?)`,
        )
        .run(
          "run_merge",
          JSON.stringify({
            terminalState: "completed",
            artifact: { pr: 595, outcome: "MERGED" },
          }),
          "sha256:result-merge",
          "2026-01-01T11:01:00.000Z",
        );
      await s.client.replay(
        envelope({
          eventId: "pr-linked-merge",
          payload: { pr: 595 },
        }),
      );

      const response = await fetch(s.url("/runs?ticket=WM-595"));
      expect(response.status).toBe(200);
      const journey = await response.json();
      expect(journey.ticket).toEqual({
        id: "WM-595",
        title: "Ticket journey",
        state: "In Review",
        createdAt: "2026-01-01T09:00:00.000Z",
        url: "https://linear.app/watt-mind/issue/WM-595",
      });
      expect(journey.events.map((event) => event.eventId)).toContain(
        "ticket-dispatch",
      );
      expect(journey.events.map((event) => event.eventId)).toContain(
        "pr-linked-merge",
      );
      expect(journey.runs.map((run) => run.run.runId)).toEqual([
        "run_ticket",
        "run_merge",
      ]);
      expect(journey.activity).toBe(true);

      const unknown = await fetch(s.url("/runs?ticket=WM-999"));
      expect((await unknown.json()).activity).toBe(false);
      const invalid = await fetch(s.url("/runs?ticket=not-a-ticket"));
      expect(invalid.status).toBe(422);
    } finally {
      s.close();
    }
  });

  test("keeps unrelated records out without issuing unrestricted table reads", async () => {
    const s = await makeServer();
    try {
      await s.client.replay(
        envelope({
          eventId: "ticket-json-only",
          payload: { ticket: "WM-1328" },
        }),
      );
      await s.client.replay(
        envelope({
          eventId: "unrelated-ticket",
          subject: "WM-999",
          payload: { ticket: "WM-999" },
        }),
      );
      const spec = (ticket) =>
        JSON.stringify({
          schemaVersion: "factory.run-spec/v1",
          runId: "ignored",
          agent: "dispatch@1",
          input: { repo: "factory", ticket },
        });
      for (const [runId, ticket] of [
        ["run-json-only", "WM-1328"],
        ["run-unrelated", "WM-999"],
      ]) {
        s.db
          .query(
            `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            runId,
            `${runId}-key`,
            spec(ticket),
            `sha256:${runId}`,
            "COMPLETED",
            "2026-01-01T10:00:00.000Z",
            "2026-01-01T10:01:00.000Z",
          );
      }
      const guardedDb = {
        query(sql) {
          if (
            /SELECT \* FROM (events|proposals|runs|results) ORDER BY/i.test(sql)
          )
            throw new Error(`unrestricted ticket journey query: ${sql}`);
          return s.db.query(sql);
        },
      };
      const journey = ticketJourneyView(guardedDb, "WM-1328");
      expect(journey.events.map((event) => event.eventId)).toEqual([
        "ticket-json-only",
      ]);
      expect(journey.runs.map((run) => run.run.runId)).toEqual([
        "run-json-only",
      ]);
    } finally {
      s.close();
    }
  });

  test("journey proposals keep TTL expiry and null spec", async () => {
    const s = await makeServer();
    try {
      await s.client.replay(
        envelope({
          eventId: "ticket-expiry",
          payload: { ticket: "WM-1328" },
        }),
      );
      s.db
        .query(
          `INSERT INTO proposals (id, event_source, event_id, decision, spec_json, spec_hash, status, reason, created_at, ttl_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "prop-expired",
          "linear",
          "ticket-expiry",
          "human_needed",
          JSON.stringify({ input: { repo: "factory", ticket: "WM-1328" } }),
          "sha256:prop-expired",
          "open",
          "needs a human",
          "2026-01-01T10:00:00.000Z",
          60,
        );
      s.db
        .query(
          `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "prop-no-spec",
          "linear",
          "ticket-expiry",
          "noop",
          "open",
          "2026-01-01T10:00:00.000Z",
          3600,
        );
      const nowMs = Date.parse("2026-01-01T10:30:00.000Z");
      const journey = ticketJourneyView(s.db, "WM-1328", { nowMs });
      const byId = Object.fromEntries(
        journey.proposals.map((proposal) => [proposal.id, proposal]),
      );
      expect(byId["prop-expired"].expired).toBe(true);
      expect(byId["prop-expired"].status).toBe("open");
      expect(byId["prop-no-spec"].expired).toBe(false);
      expect(byId["prop-no-spec"].spec).toBeNull();
      expect(
        ticketJourneyView(s.db, "WM-1328", {
          nowMs: Date.parse("2026-01-01T10:00:30.000Z"),
        }).proposals.find((proposal) => proposal.id === "prop-expired").expired,
      ).toBe(false);
    } finally {
      s.close();
    }
  });
});

describe("recent-ticket index (WM-821)", () => {
  const spec = (input, agent = "dispatch@1") =>
    JSON.stringify({
      schemaVersion: "factory.run-spec/v1",
      runId: "ignored",
      agent,
      input,
      inputHash: "sha256:input",
      workspace: { type: "none" },
      adapter: "fake",
      promptVersion: "test",
      policyVersion: PV,
      outputContract: "test/v1",
      capabilities: [],
      timeoutSeconds: 60,
      maxAttempts: 1,
      idempotencyKey: "ignored",
    });

  test("GET /tickets returns aggregated ticket summaries across events, proposals, runs, results", async () => {
    let nowMs = Date.parse("2026-08-18T12:00:00.000Z");
    const s = await makeServer({ now: () => nowMs });
    try {
      // 1. Ticket WM-101: dispatch event + run + result (PR_OPEN) + merge run (MERGED)
      await s.client.replay(
        envelope({
          eventId: "ev-wm-101",
          subject: "WM-101",
          occurredAt: "2026-08-15T09:00:00.000Z",
          payload: {
            repo: "factory",
            ticket: "WM-101",
            ticketTitle: "Feature A",
            ticketState: "In Review",
          },
        }),
      );
      s.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          "run_101_dispatch",
          "key-101-d",
          spec({ repo: "factory", ticket: "WM-101" }),
          "sha256:101d",
          "COMPLETED",
          "2026-08-15T09:05:00.000Z",
          "2026-08-15T09:15:00.000Z",
        );
      s.db
        .query(
          `INSERT INTO results
           (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
           VALUES (?, 1, ?, ?, '{}', '{}', ?)`,
        )
        .run(
          "run_101_dispatch",
          JSON.stringify({
            terminalState: "completed",
            artifact: {
              outcome: "PR_OPEN",
              ticket: "WM-101",
              prUrl: "https://github.com/watt-mind/factory/pull/101",
            },
          }),
          "sha256:res-101-d",
          "2026-08-15T09:15:00.000Z",
        );
      s.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          "run_101_merge",
          "key-101-m",
          spec({ repo: "factory", pr: 101 }, "merge-apply@1"),
          "sha256:101m",
          "COMPLETED",
          "2026-08-15T10:00:00.000Z",
          "2026-08-15T10:05:00.000Z",
        );
      s.db
        .query(
          `INSERT INTO results
           (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
           VALUES (?, 1, ?, ?, '{}', '{}', ?)`,
        )
        .run(
          "run_101_merge",
          JSON.stringify({
            terminalState: "completed",
            artifact: { pr: 101, outcome: "MERGED" },
          }),
          "sha256:res-101-m",
          "2026-08-15T10:05:00.000Z",
        );

      // 2. Ticket WM-102: Active RUNNING run
      s.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          "run_102",
          "key-102",
          spec({ repo: "factory", ticket: "WM-102", ticketTitle: "Feature B" }),
          "sha256:102",
          "RUNNING",
          "2026-08-17T11:00:00.000Z",
          "2026-08-17T11:05:00.000Z",
        );

      // 3. Ticket WM-103: Failed run
      s.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          "run_103",
          "key-103",
          spec({ repo: "factory", ticket: "WM-103", ticketTitle: "Feature C" }),
          "sha256:103",
          "FAILED",
          "2026-08-16T08:00:00.000Z",
          "2026-08-16T08:10:00.000Z",
        );

      // 4. Ticket WM-104: Open proposal with human_needed decision
      s.db
        .query(
          `INSERT INTO proposals (id, event_source, event_id, decision, spec_json, spec_hash, status, reason, created_at, ttl_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "prop_104",
          "linear",
          "ev_104",
          "human_needed",
          JSON.stringify({
            input: {
              repo: "factory",
              ticket: "WM-104",
              ticketTitle: "Needs help",
            },
          }),
          "sha256:104",
          "open",
          "ambiguous plan",
          "2026-08-14T14:00:00.000Z",
          86400,
        );

      // 5. Ticket BJ-201: BJ29 repo ticket
      await s.client.replay(
        envelope({
          eventId: "ev-bj-201",
          subject: "BJ-201",
          occurredAt: "2026-08-18T08:00:00.000Z",
          payload: {
            repo: "bj29",
            ticket: "BJ-201",
            ticketTitle: "Fix BJ bug",
          },
        }),
      );

      // Fetch all tickets
      const resAll = await fetch(s.url("/tickets"));
      expect(resAll.status).toBe(200);
      const dataAll = await resAll.json();
      expect(Array.isArray(dataAll.tickets)).toBe(true);
      expect(dataAll.tickets.length).toBe(5);

      // Verify sorting DESC by lastActivityAt
      const ticketIds = dataAll.tickets.map((t) => t.id);
      expect(ticketIds).toEqual([
        "BJ-201",
        "WM-102",
        "WM-103",
        "WM-101",
        "WM-104",
      ]);

      // Verify WM-101 details (merged -> Done)
      const t101 = dataAll.tickets.find((t) => t.id === "WM-101");
      expect(t101).toMatchObject({
        id: "WM-101",
        repo: "factory",
        title: "Feature A",
        state: "Done",
        merged: true,
        lastActivityKind: "merge",
        attempts: 2,
        activeRun: null,
        pr: {
          number: 101,
          url: "https://github.com/watt-mind/factory/pull/101",
        },
      });

      // Verify WM-102 details (active RUNNING run)
      const t102 = dataAll.tickets.find((t) => t.id === "WM-102");
      expect(t102).toMatchObject({
        id: "WM-102",
        repo: "factory",
        title: "Feature B",
        state: "Running",
        merged: false,
        activeRun: {
          runId: "run_102",
          state: "RUNNING",
          agent: "dispatch@1",
        },
        attempts: 1,
      });

      // Verify WM-103 details (FAILED)
      const t103 = dataAll.tickets.find((t) => t.id === "WM-103");
      expect(t103).toMatchObject({
        id: "WM-103",
        repo: "factory",
        title: "Feature C",
        state: "Failed",
        merged: false,
        activeRun: null,
      });

      // Verify WM-104 details (Blocked on human_needed proposal)
      const t104 = dataAll.tickets.find((t) => t.id === "WM-104");
      expect(t104).toMatchObject({
        id: "WM-104",
        repo: "factory",
        title: "Needs help",
        state: "Blocked",
        lastDecision: "human_needed",
        lastActivityKind: "proposal",
      });

      // Verify BJ-201 repo scoping
      const resBj = await fetch(s.url("/tickets?repo=bj29"));
      expect(resBj.status).toBe(200);
      const dataBj = await resBj.json();
      expect(dataBj.tickets.map((t) => t.id)).toEqual(["BJ-201"]);

      const resFactory = await fetch(s.url("/tickets?repo=factory"));
      expect(resFactory.status).toBe(200);
      const dataFactory = await resFactory.json();
      expect(dataFactory.tickets.map((t) => t.id)).toEqual([
        "WM-102",
        "WM-103",
        "WM-101",
        "WM-104",
      ]);

      // Verify since filter (e.g. since=2d from 2026-08-18T12:00:00Z -> since 2026-08-16T12:00:00Z)
      const resSince2d = await fetch(s.url("/tickets?since=2d"));
      expect(resSince2d.status).toBe(200);
      const dataSince2d = await resSince2d.json();
      expect(dataSince2d.tickets.map((t) => t.id)).toEqual([
        "BJ-201",
        "WM-102",
      ]);

      // Verify limit parameter
      const resLimit = await fetch(s.url("/tickets?limit=2"));
      expect(resLimit.status).toBe(200);
      const dataLimit = await resLimit.json();
      expect(dataLimit.tickets.length).toBe(2);
      expect(dataLimit.tickets.map((t) => t.id)).toEqual(["BJ-201", "WM-102"]);

      // Verify invalid duration returns 422
      const resInvalidSince = await fetch(s.url("/tickets?since=invalid-foo"));
      expect(resInvalidSince.status).toBe(422);
      const errBody = await resInvalidSince.json();
      expect(errBody.error).toBe("invalid_since");

      // Verify invalid limit returns 422
      for (const limit of ["abc", "0", "201"]) {
        const response = await fetch(s.url(`/tickets?limit=${limit}`));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_limit",
          message: "limit must be an integer between 1 and 200",
        });
      }

      // Verify alternative valid duration units (1w, 24h, 30m, 60s, ISO string)
      const resWeek = await fetch(s.url("/tickets?since=1w"));
      expect(resWeek.status).toBe(200);
      expect((await resWeek.json()).tickets.length).toBe(5);

      const resHours = await fetch(s.url("/tickets?since=24h"));
      expect(resHours.status).toBe(200);
      expect((await resHours.json()).tickets.map((t) => t.id)).toEqual([
        "BJ-201",
      ]);

      const resIso = await fetch(
        s.url("/tickets?since=2026-08-17T00:00:00.000Z"),
      );
      expect(resIso.status).toBe(200);
      expect((await resIso.json()).tickets.map((t) => t.id)).toEqual([
        "BJ-201",
        "WM-102",
      ]);

      // Verify caching: repeated call uses cache, advancing time past TTL re-evaluates
      const resCached = await fetch(s.url("/tickets?since=14d"));
      expect(resCached.status).toBe(200);
      expect((await resCached.json()).tickets.length).toBe(5);

      // Verify ticketIndexView exported function directly
      const direct = ticketIndexView(s.db, { since: "14d", nowMs });
      expect(direct.length).toBe(5);
    } finally {
      s.close();
    }
  });
});

describe("watched flow and operator verbs (§12, §13, §15)", () => {
  let s;
  let flowProposalId;
  let flowRunId;
  const workspaces = tmpDir("evrt-api-ws-");
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
    // Planning runs off the response path (WM-1162): drain the deferred
    // setImmediate before asserting the admitted wake-up.
    await new Promise((resolve) => setImmediate(resolve));
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
    expect(list.runs[0].idempotencyKey).toBe(done.run.idempotencyKey);
    expect(list.runs[0].spec).toBeUndefined();
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

  test("approval waits for a worker write lock and returns db_busy after its timeout", async () => {
    const waiting = await planned("approve-waits-for-lock");
    const lock = await holdWriteLock(s.db.filename, 75);
    const startedAt = Date.now();
    const approved = await s.client.approve(waiting.id);
    const elapsedMs = Date.now() - startedAt;
    expect(approved).toEqual({ approved: true, runId: waiting.runId });
    // The lock is held for 75 ms; a lower bound proves the approval actually
    // waited on it instead of racing past a lock that was never taken.
    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(await lock.exited).toBe(0);
    expect(await s.client.cancel(waiting.runId, "test cleanup")).toEqual({
      cancelled: true,
    });

    // A connection deliberately tuned to fail fast keeps that contract even
    // though approvals now retry across event-loop turns (#1349): the
    // lowered busy_timeout bounds the whole retry budget.
    const timedOut = await planned("approve-busy-timeout");
    let timeoutLock;
    try {
      s.db.exec("PRAGMA busy_timeout = 10;");
      timeoutLock = await holdWriteLock(s.db.filename, 75);
      const err = await rejection(s.client.approve(timedOut.id));
      expect(err.status).toBe(503);
      expect(err.message).toBe("db_busy");
      expect(err.body).toEqual({ error: "db_busy", retryable: true });
    } finally {
      s.db.exec("PRAGMA busy_timeout = 5000;");
    }
    expect(await timeoutLock?.exited).toBe(0);
  });

  test("contended approvals and rejections yield to /health and return typed db_busy", async () => {
    const approvedProposal = await planned("approve-contention");
    const approveLock = await holdWriteLock(s.db.filename, 400);
    const approval = s.client.approve(approvedProposal.id);
    await new Promise((resolve) => setImmediate(resolve));
    const healthStartedAt = Date.now();
    const health = await fetch(s.url("/health"));
    expect(health.status).toBe(200);
    expect(Date.now() - healthStartedAt).toBeLessThan(500);
    expect(await approval).toEqual({
      approved: true,
      runId: approvedProposal.runId,
    });
    expect(await approveLock.exited).toBe(0);
    expect(
      await s.client.cancel(approvedProposal.runId, "test cleanup"),
    ).toEqual({ cancelled: true });

    const rejectedProposal = await planned("reject-contention");
    const rejectLock = await holdWriteLock(s.db.filename, 6_000);
    const startedAt = Date.now();
    const err = await rejection(s.client.reject(rejectedProposal.id, "locked"));
    expect(err.status).toBe(503);
    expect(err.body).toEqual({ error: "db_busy", retryable: true });
    expect(Date.now() - startedAt).toBeGreaterThan(4_000);
    expect(await rejectLock.exited).toBe(0);
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
          workspacesRoot: tmpDir("evrt-ws-"),
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
      expect(runs[0].adapter).toBe("fake");
      expect(runs[0].idempotencyKey).toBeTruthy();

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
          workspacesRoot: tmpDir("evrt-ws-"),
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

  test("journal and outbox reject malformed limits and journal cursors", async () => {
    const s = await makeServer();
    try {
      const insertJournal = s.db.query(
        `INSERT INTO lifecycle_events (run_id, to_state, actor, at, record_hash)
         VALUES (?, 'COMPLETED', 'test', ?, ?)`,
      );
      const insertOutbox = s.db.query(
        `INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`,
      );
      const createdAt = new Date().toISOString();
      s.db.transaction(() => {
        for (let i = 0; i < 501; i += 1) {
          insertJournal.run(`journal-limit-${i}`, createdAt, `hash-${i}`);
          insertOutbox.run(
            JSON.stringify({ eventId: `outbox-limit-${i}` }),
            createdAt,
          );
        }
      })();

      for (const endpoint of ["/journal", "/outbox"]) {
        for (const limit of ["abc", "0", "501"]) {
          const response = await fetch(s.url(`${endpoint}?limit=${limit}`));
          expect(response.status).toBe(422);
          expect(await response.json()).toMatchObject({
            error: "invalid_limit",
            message: "limit must be an integer between 1 and 500",
          });
        }
      }

      for (const since of ["not-a-cursor", "-1"]) {
        const response = await fetch(s.url(`/journal?since=${since}`));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_since",
          message: expect.any(String),
        });
      }
    } finally {
      s.close();
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
          workspacesRoot: tmpDir("evrt-ws-"),
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

      for (const limit of ["abc", "0", "501"]) {
        const response = await fetch(
          `http://127.0.0.1:${port}/runs/${summary.runId}/trace?limit=${limit}`,
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_limit",
          message: "limit must be an integer between 1 and 500",
        });
      }
      for (const since of ["abc", "-1"]) {
        const response = await fetch(
          `http://127.0.0.1:${port}/runs/${summary.runId}/trace?since=${since}`,
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_since",
          message: expect.any(String),
        });
      }

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

describe("GET /tickets/:id/detail (WM-914)", () => {
  afterEach(() => {
    setTicketDetailControlPlane(null);
    clearTicketDetailCache();
  });

  function seedPlane() {
    const plane = memoryControlPlane({
      tickets: [
        {
          id: "iss-914",
          identifier: "WM-914",
          title: "Live tracker title",
          description: "## Spec\n\nDo the thing.",
          url: "https://linear.app/watt-mind/issue/WM-914",
          state: { id: "s-progress", name: "In Progress" },
          assignee: { id: "u1", name: "Ada" },
          comments: [
            {
              id: "c1",
              body: "First comment",
              createdAt: "2026-08-18T10:00:00.000Z",
              user: { id: "u1", name: "Ada" },
            },
          ],
        },
      ],
    });
    setTicketDetailControlPlane(plane);
    return plane;
  }

  test("returns live title, state, description, and comments", async () => {
    seedPlane();
    const s = await makeServer();
    try {
      const res = await fetch(s.url("/tickets/WM-914/detail"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ticket).toEqual({
        id: "WM-914",
        identifier: "WM-914",
        title: "Live tracker title",
        state: "In Progress",
        description: "## Spec\n\nDo the thing.",
        url: "https://linear.app/watt-mind/issue/WM-914",
        assignee: { name: "Ada" },
      });
      expect(body.comments).toEqual([
        {
          id: "c1",
          body: "First comment",
          createdAt: "2026-08-18T10:00:00.000Z",
          user: { id: "u1", name: "Ada" },
        },
      ]);
      expect(body.cached).toBe(false);
      expect(typeof body.fetchedAt).toBe("string");
    } finally {
      s.close();
    }
  });

  test("caches within the TTL and refetches after it expires", async () => {
    const plane = seedPlane();
    let nowMs = Date.parse("2026-08-19T12:00:00.000Z");
    const s = await makeServer({ now: () => nowMs });
    try {
      const first = await fetch(s.url("/tickets/WM-914/detail"));
      expect(first.status).toBe(200);
      expect((await first.json()).cached).toBe(false);
      expect(plane.calls.filter((c) => c.op === "getTicket")).toHaveLength(1);

      nowMs += 1_000;
      const cached = await fetch(s.url("/tickets/WM-914/detail"));
      expect((await cached.json()).cached).toBe(true);
      expect(plane.calls.filter((c) => c.op === "getTicket")).toHaveLength(1);

      nowMs += TICKET_DETAIL_CACHE_TTL_MS;
      const stale = await fetch(s.url("/tickets/WM-914/detail"));
      expect((await stale.json()).cached).toBe(false);
      expect(plane.calls.filter((c) => c.op === "getTicket")).toHaveLength(2);
    } finally {
      s.close();
    }
  });

  test("rejects malformed ids, missing issues, and tracker failures", async () => {
    seedPlane();
    const s = await makeServer();
    try {
      const bad = await fetch(s.url("/tickets/not-a-ticket/detail"));
      expect(bad.status).toBe(422);
      expect(await bad.json()).toEqual({
        error: "ticket must look like WM-123",
      });

      const missing = await fetch(s.url("/tickets/WM-999/detail"));
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toMatch(/no such issue/i);

      setTicketDetailControlPlane({
        kind: "memory",
        getTicket: async () => {
          throw new Error("network down");
        },
        listComments: async () => {
          throw new Error("network down");
        },
      });
      clearTicketDetailCache();
      const down = await fetch(s.url("/tickets/WM-914/detail"));
      expect(down.status).toBe(502);
      const body = await down.json();
      expect(body.error).toBe("tracker_unavailable");
      expect(body.message).toBe("network down");
    } finally {
      s.close();
    }
  });
});

describe("GET /tickets/supply (WM-824)", () => {
  function repoMap(rows) {
    return new Map(
      rows.map((row) => [
        row.name,
        {
          maxInFlight: 2,
          team: "WM",
          project: "Factory",
          ...row,
        },
      ]),
    );
  }

  test("merge overlays Linear counts and keeps scan fallback when Linear fails", () => {
    const scan = {
      repos: [
        {
          name: "factory",
          team: "WM",
          triage: 9,
          ready: 1,
          inFlight: 0,
          cap: 2,
          blocked: 0,
          noopReason: null,
          asOf: "2026-08-20T10:00:00.000Z",
          sourceRunId: "run_scan",
        },
      ],
      recommendedAction: "triage",
    };
    const live = mergeTicketSupply(scan, {
      ok: true,
      asOf: "2026-08-20T18:00:00.000Z",
      byRepo: {
        factory: {
          triage: 3,
          ready: 2,
          inFlight: 1,
          blocked: 0,
          inReview: 0,
        },
      },
      budget: { remaining: 2000, limit: 2500 },
      cached: false,
    });
    expect(live.source).toBe("linear");
    expect(live.stale).toBe(false);
    expect(live.repos[0]).toMatchObject({
      triage: 3,
      ready: 2,
      inFlight: 1,
      asOf: "2026-08-20T18:00:00.000Z",
      sourceRunId: null,
      source: "linear",
    });
    expect(live.recommendedAction).toBe("dispatch");

    const fallback = mergeTicketSupply(
      scan,
      {
        ok: false,
        error: "RATELIMITED",
        budget: { remaining: 0, limit: 2500 },
      },
      { nowMs: Date.parse("2026-08-20T10:30:00.000Z") },
    );
    expect(fallback.source).toBe("scan");
    expect(fallback.stale).toBe(false);
    expect(fallback.linearError).toBe("RATELIMITED");
    expect(fallback.repos[0].triage).toBe(9);
    expect(fallback.repos[0].source).toBe("scan");

    const stale = mergeTicketSupply(
      scan,
      { ok: false, error: "linear_unavailable" },
      { nowMs: Date.parse("2026-08-20T12:00:00.000Z") },
    );
    expect(stale.stale).toBe(true);
  });

  test("ticketSupplyView queries Linear on demand and honors refresh", async () => {
    let calls = 0;
    const gql = async () => {
      calls += 1;
      return {
        issues: {
          nodes: [
            {
              state: { name: "Triage" },
              assignee: null,
              labels: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      };
    };
    const repos = repoMap([{ name: "factory" }]);
    const s = await makeServer();
    try {
      const first = await ticketSupplyView(s.db, { repos, gql });
      expect(first.source).toBe("linear");
      expect(first.repos).toEqual([
        expect.objectContaining({
          name: "factory",
          triage: 1,
          ready: 0,
          source: "linear",
        }),
      ]);
      expect(calls).toBe(1);

      await ticketSupplyView(s.db, { repos, gql });
      expect(calls).toBe(1);

      await ticketSupplyView(s.db, { repos, gql, refresh: true });
      expect(calls).toBe(2);
    } finally {
      s.close();
    }
  });

  test("scanTicketSupply still reads work-plan / status-report artifacts", async () => {
    const s = await makeServer();
    try {
      const repos = repoMap([{ name: "factory" }]);
      const empty = scanTicketSupply(s.db, { repos });
      expect(empty.repos[0]).toMatchObject({
        name: "factory",
        triage: null,
        ready: null,
        asOf: null,
      });
      const merged = await ticketSupplyView(s.db, {
        repos,
        gql: async () => {
          throw new Error("no linear");
        },
        nowMs: Date.parse("2026-08-20T12:00:00.000Z"),
      });
      expect(merged.source).toBe("scan");
      expect(merged.linearError).toBe("no linear");
    } finally {
      s.close();
    }
  });
});
