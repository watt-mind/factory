import { trackTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-schedules-test-mjs";
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
  makeServer as makeApiServer,
  mkdirSync,
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

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

function isolatedScheduleRegistry() {
  const agents = new Map(registry.agents);
  const mergeScan = agents.get("merge-scan@2");
  agents.set("merge-scan@2", {
    ...mergeScan,
    workspace: { type: "ephemeral" },
  });
  return { ...registry, agents };
}

describe("POST /schedules/:loop/run (OPS-401)", () => {
  let s;
  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  test("unknown schedule loop returns 404 with registered schedule names", async () => {
    const res = await fetch(s.url("/schedules/nonexistent/run"), {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("unknown schedule");
    expect(Array.isArray(body.schedules)).toBe(true);
    expect(body.schedules).toContain("reaper");
  });

  test("trigger ad-hoc run on registered disabled loop creates open proposal", async () => {
    const res = await fetch(s.url("/schedules/reaper/run"), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admitted).toBe(true);
    expect(body.disabled).toBe(true);
    expect(body.loop).toBe("reaper");
    expect(body.decision).toBe("run");
    expect(typeof body.proposalId).toBe("string");
    expect(body.eventId).toMatch(/^manual:reaper:/);

    // Verify event in DB has source='operator' and correct payload
    const eventRow = s.db
      .query(`SELECT * FROM events WHERE source = 'operator' AND event_id = ?`)
      .get(body.eventId);
    expect(eventRow).toBeDefined();
    expect(eventRow.type).toBe("clock.tick.reaper");
    const payload = JSON.parse(eventRow.envelope_json).payload;
    expect(payload.loop).toBe("reaper");
    expect(payload.cadenceSeconds).toBe(3600);
    expect(payload.skippedSlots).toBe(0);

    // Verify proposal is open (watched approval)
    const proposal = s.db
      .query(`SELECT * FROM proposals WHERE id = ?`)
      .get(body.proposalId);
    expect(proposal.status).toBe("open");
    expect(proposal.decision).toBe("run");
  });

  test("supports /schedules/:loop/trigger path alias", async () => {
    const res = await fetch(s.url("/schedules/reaper/trigger"), {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admitted).toBe(true);
    expect(body.loop).toBe("reaper");
    expect(body.decision).toBe("run");
  });

  test("manual merge trigger propagates selected PR numbers into the immutable event and planned input", async () => {
    // Planning commits the run before the API sends its response, so a returned
    // runId guarantees read-after-write. Keep this schedule-input test isolated
    // from merge-scan's unrelated shared repository mirror fetch.
    const mergeServer = await makeServer({
      registry: isolatedScheduleRegistry(),
    });
    try {
      const res = await fetch(mergeServer.url("/schedules/merge-factory/run"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prNumbers: [411, 426] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.decision).toBe("run");
      expect(body.reason).toBeNull();
      expect(typeof body.runId).toBe("string");
      const event = mergeServer.db
        .query(
          `SELECT envelope_json FROM events WHERE source = 'operator' AND event_id = ?`,
        )
        .get(body.eventId);
      expect(JSON.parse(event.envelope_json).payload).toMatchObject({
        repo: "factory",
        loop: "merge-factory",
        prNumbers: [411, 426],
      });
      const run = mergeServer.db
        .query(`SELECT spec_json FROM runs WHERE run_id = ?`)
        .get(body.runId);
      expect(JSON.parse(run.spec_json).input.prNumbers).toEqual([411, 426]);
    } finally {
      mergeServer.close();
    }
  });

  test("omitted merge selection preserves all-open behavior", async () => {
    // This path still plans a merge-scan run before responding. Use the same
    // ephemeral workspace as the selected-PR case so no shared mirror is read.
    const mergeServer = await makeServer({
      registry: isolatedScheduleRegistry(),
    });
    try {
      const res = await fetch(mergeServer.url("/schedules/merge-factory/run"), {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const event = mergeServer.db
        .query(
          `SELECT envelope_json FROM events WHERE source = 'operator' AND event_id = ?`,
        )
        .get(body.eventId);
      const payload = JSON.parse(event.envelope_json).payload;
      expect(payload.repo).toBe("factory");
      expect(payload).not.toHaveProperty("prNumbers");
    } finally {
      mergeServer.close();
    }
  });

  test("merge selection rejects empty, invalid, duplicate, and arbitrary values before admission", async () => {
    const mergeServer = await makeServer();
    try {
      const invalidBodies = [
        { prNumbers: [] },
        { prNumbers: [0] },
        { prNumbers: [-1] },
        { prNumbers: [1.5] },
        { prNumbers: ["42"] },
        { prNumbers: [42, 42] },
        { prNumbers: 42 },
        { prNumbers: [42], payload: { forged: true } },
      ];
      for (const requestBody of invalidBodies) {
        const before = mergeServer.db
          .query(`SELECT COUNT(*) AS n FROM events`)
          .get().n;
        const res = await fetch(
          mergeServer.url("/schedules/merge-factory/run"),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requestBody),
          },
        );
        expect(res.status, JSON.stringify(requestBody)).toBe(422);
        expect(
          mergeServer.db.query(`SELECT COUNT(*) AS n FROM events`).get().n,
        ).toBe(before);
      }
    } finally {
      mergeServer.close();
    }
  });

  test("non-merge schedules reject payload overrides instead of forging an event", async () => {
    const overrideServer = await makeServer();
    try {
      const res = await fetch(overrideServer.url("/schedules/reaper/run"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prNumbers: [42] }),
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toContain(
        "does not accept trigger input",
      );
      expect(
        overrideServer.db.query(`SELECT COUNT(*) AS n FROM events`).get().n,
      ).toBe(0);
    } finally {
      overrideServer.close();
    }
  });

  test("two presses produce two distinct events and proposals (no dedup collapse)", async () => {
    const res1 = await fetch(s.url("/schedules/reaper/run"), {
      method: "POST",
    });
    const body1 = await res1.json();
    expect(res1.status).toBe(200);

    // Small delay ensures distinct ISO timestamp
    await new Promise((r) => setTimeout(r, 5));

    const res2 = await fetch(s.url("/schedules/reaper/run"), {
      method: "POST",
    });
    const body2 = await res2.json();
    expect(res2.status).toBe(200);

    expect(body1.eventId).not.toBe(body2.eventId);
    expect(body1.proposalId).not.toBe(body2.proposalId);
    expect(body2.duplicate).toBe(false);
  });

  test("ad-hoc trigger does not advance lastSlot or nextDue in GET /schedules", async () => {
    const schedRes = await fetch(s.url("/schedules"));
    expect(schedRes.status).toBe(200);
    const { schedules } = await schedRes.json();
    const reaper = schedules.find((sc) => sc.loop === "reaper");
    expect(reaper).toBeDefined();
    expect(reaper.repo).toBeNull();
    expect(schedules.find((sc) => sc.loop === "merge-factory").repo).toBe(
      "factory",
    );
    // lastSlot is still null because ad-hoc runs are source='operator', not 'schedule'
    expect(reaper.lastSlot).toBeNull();
  });

  test("singleton constraint: in-flight run yields typed NOOP (previous_run_in_flight)", async () => {
    // Insert an in-flight run for reaper's agent ('reaper@1')
    const runId = `test-run-${Date.now()}`;
    s.db
      .query(
        `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
       VALUES (?, ?, 'dummy', ?, 'RUNNING', 1, ?, ?)`,
      )
      .run(
        runId,
        `idempotency-${runId}`,
        JSON.stringify({ agent: "reaper@1", runId }),
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const res = await fetch(s.url("/schedules/reaper/run"), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admitted).toBe(true);
    expect(body.decision).toBe("noop");
    expect(body.reason).toBe("previous_run_in_flight");
  });
});
