import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-status-view-test-mjs";
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
import { createHookRegistry } from "./hooks.mjs";
import { GITHUB_INTAKE_STALE_AFTER_MS } from "./intake.mjs";

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

describe("StatusView and Worker client types pinned to API response (OPS-284)", () => {
  const typesPath = path.resolve(import.meta.dir, "../web/src/types.ts");
  const typesSrc = readFileSync(typesPath, "utf8");

  function extractInterfaceBlock(src, interfaceName) {
    const match = src.match(
      new RegExp(`export\\s+interface\\s+${interfaceName}\\s*\\{`),
    );
    if (!match)
      throw new Error(`Interface ${interfaceName} not found in types.ts`);
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (depth > 0 && endIdx < src.length) {
      if (src[endIdx] === "{" || src[endIdx] === "(") depth++;
      else if (src[endIdx] === "}" || src[endIdx] === ")") depth--;
      endIdx++;
    }
    return src.slice(startIdx, endIdx - 1);
  }

  function extractDirectProperties(block) {
    const clean = block
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const props = [];
    let depth = 0;
    let currentToken = "";
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === "{" || ch === "(" || ch === "<") {
        depth++;
      } else if (ch === "}" || ch === ")" || ch === ">") {
        depth--;
      } else if (ch === ";" && depth === 0) {
        const match = currentToken.trim().match(/^([a-zA-Z0-9_]+)\??\s*:/);
        if (match) props.push(match[1]);
        currentToken = "";
        continue;
      }
      if (depth === 0) currentToken += ch;
    }
    if (currentToken.trim()) {
      const match = currentToken.trim().match(/^([a-zA-Z0-9_]+)\??\s*:/);
      if (match) props.push(match[1]);
    }
    return props;
  }

  function extractNestedBlock(block, propertyName) {
    const match = block.match(
      new RegExp(`${propertyName}\\s*\\??\\s*:\\s*\\{`),
    );
    if (!match)
      throw new Error(`Nested property block ${propertyName} not found`);
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (depth > 0 && endIdx < block.length) {
      if (block[endIdx] === "{" || block[endIdx] === "(") depth++;
      else if (block[endIdx] === "}" || block[endIdx] === ")") depth--;
      endIdx++;
    }
    return block.slice(startIdx, endIdx - 1);
  }

  test("GET /status keys and types strictly match StatusView and nested types", async () => {
    const dir = tmpDir("evrt-status-contract-");
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;

    // 1 live idle worker
    registerWorker(db, {
      workerId: "w-live-idle",
      labels: { role: "worker", zone: "a" },
      adapters: ["claude"],
      now: nowMs,
    });
    // 1 live busy worker
    registerWorker(db, {
      workerId: "w-live-busy",
      labels: { role: "worker", zone: "b" },
      adapters: ["claude"],
      now: nowMs,
    });
    heartbeat(db, "w-live-busy", {
      state: "busy",
      runId: "run-busy-1",
      now: nowMs,
    });
    // 1 stale worker holding a run (stalled worker projection)
    registerWorker(db, {
      workerId: "w-stale-busy",
      labels: { role: "worker" },
      adapters: ["claude"],
      now: nowMs - 120000,
    });
    heartbeat(db, "w-stale-busy", {
      state: "busy",
      runId: "run-stalled-1",
      now: nowMs - 120000,
    });
    // 1 stopped worker
    registerWorker(db, {
      workerId: "w-stopped",
      labels: { role: "worker" },
      adapters: ["claude"],
      now: nowMs,
    });
    deregisterWorker(db, "w-stopped", { now: nowMs });

    // Ambiguous open proposals on a run
    const atIso = new Date(nowMs).toISOString();
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
       VALUES (?, ?, "dummy", "{}", "QUEUED", 1, ?, ?)`,
    ).run("run-ambig-1", "idem-ambig-1", atIso, atIso);
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds, status)
       VALUES (?, "test", "evt-1", "run-ambig-1", "run", ?, 1800, "open")`,
    ).run("prop-ambig-1", atIso);
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds, status)
       VALUES (?, "test", "evt-2", "run-ambig-1", "run", ?, 1800, "open")`,
    ).run("prop-ambig-2", atIso);

    // Expired open proposal
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds, status)
       VALUES (?, "test", "evt-3", "run-expired-1", "run", ?, 10, "open")`,
    ).run("prop-expired-1", new Date(nowMs - 20000).toISOString());

    // Dead lettered event
    db.query(
      `INSERT INTO events (source, event_id, type, subject, status, payload_hash, occurred_at, received_at, correlation_id, plan_failures, last_plan_error, admitted_at, envelope_json)
       VALUES ("test", "evt-dead-1", "test.type", "test", "dead_lettered", "dummy-hash", ?, ?, "corr-1", 3, "failed to plan", ?, "{}")`,
    ).run(atIso, atIso, atIso);

    // Proposals piling up for a scheduled loop
    for (let i = 1; i <= 4; i++) {
      db.query(
        `INSERT INTO events (source, event_id, type, subject, status, payload_hash, occurred_at, received_at, admitted_at, envelope_json)
         VALUES ("schedule", ?, "clock.tick.reaper", "reaper", "admitted", "dummy-hash", ?, ?, ?, ?)`,
      ).run(
        `clock:reaper:${i}`,
        atIso,
        atIso,
        atIso,
        JSON.stringify({ payload: { loop: "reaper" } }),
      );
      db.query(
        `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
         VALUES (?, "schedule", ?, "run", "open", ?, 1800)`,
      ).run(`prop-piling-reaper-${i}`, `clock:reaper:${i}`, atIso);
    }

    // A GitHub delivery admitted 90 seconds ago supplies the intake freshness
    // projection without changing the numeric event-status counts.
    const githubAdmittedAt = new Date(nowMs - 90_000).toISOString();
    db.query(
      `INSERT INTO events (source, event_id, type, subject, status, payload_hash, occurred_at, received_at, admitted_at, envelope_json)
       VALUES ("github", "delivery-status-1", "github.pull_request", "watt-mind/factory", "admitted", "dummy-hash", ?, ?, ?, "{}")`,
    ).run(githubAdmittedAt, githubAdmittedAt, githubAdmittedAt);

    const s = await makeServer({
      db,
      secret: "sec",
      policyVersion: "git:test-pv",
      now: () => nowMs,
    });

    try {
      const res = await fetch(s.url("/status"));
      expect(res.status).toBe(200);
      const status = await res.json();

      // Top-level StatusView keys match (inbox declared on the web type since WM-286).
      const statusViewBlock = extractInterfaceBlock(typesSrc, "StatusView");
      const expectedStatusKeys =
        extractDirectProperties(statusViewBlock).sort();
      expect(Object.keys(status).sort()).toEqual(expectedStatusKeys);
      expect(status.inbox).toEqual({ open: 0, acked: 0, byKind: {} });
      expect(status.githubIntake).toEqual({
        configured: true,
        lastAdmittedAt: githubAdmittedAt,
        ageMs: 90_000,
        rejected: expect.any(Number),
        stale: false,
        staleAfterMs: GITHUB_INTAKE_STALE_AFTER_MS,
      });
      expect(Object.keys(status.githubIntake).sort()).toEqual(
        extractDirectProperties(
          extractInterfaceBlock(typesSrc, "GithubIntakeStatus"),
        ).sort(),
      );

      // StatusView.env matches EnvIdentity
      const envIdentityBlock = extractInterfaceBlock(typesSrc, "EnvIdentity");
      const expectedEnvKeys = extractDirectProperties(envIdentityBlock).sort();
      expect(Object.keys(status.env).sort()).toEqual(expectedEnvKeys);
      expect(typeof status.env.name).toBe("string");
      expect(typeof status.env.home).toBe("string");
      expect(
        status.env.adapter === null || typeof status.env.adapter === "string",
      ).toBe(true);

      // StatusView.workers counts match
      const expectedWorkerCountKeys = extractDirectProperties(
        extractNestedBlock(statusViewBlock, "workers"),
      ).sort();
      expect(Object.keys(status.workers).sort()).toEqual(
        expectedWorkerCountKeys,
      );
      expect(status.workers).toEqual({
        live: 2,
        busy: 1,
        stale: 1,
      });

      // StatusView.anomalies keys match
      const expectedAnomalyKeys = extractDirectProperties(
        extractNestedBlock(statusViewBlock, "anomalies"),
      ).sort();
      expect(Object.keys(status.anomalies).sort()).toEqual(expectedAnomalyKeys);

      // StalledWorker keys and types match
      const expectedStalledWorkerKeys = extractDirectProperties(
        extractInterfaceBlock(typesSrc, "StalledWorker"),
      ).sort();
      expect(status.anomalies.stalledWorkers.length).toBe(1);
      for (const sw of status.anomalies.stalledWorkers) {
        expect(Object.keys(sw).sort()).toEqual(expectedStalledWorkerKeys);
        expect(typeof sw.workerId).toBe("string");
        expect(typeof sw.host).toBe("string");
        expect(typeof sw.runId).toBe("string");
        expect(typeof sw.lastSeen).toBe("string");
      }
      expect(status.anomalies.stalledWorkers[0].workerId).toBe("w-stale-busy");
      expect(status.anomalies.stalledWorkers[0].runId).toBe("run-stalled-1");

      // ambiguousOpenProposals matches [{ runId, count }]
      expect(status.anomalies.ambiguousOpenProposals).toEqual([
        { runId: "run-ambig-1", count: 2 },
      ]);
      for (const item of status.anomalies.ambiguousOpenProposals) {
        expect(typeof item.runId).toBe("string");
        expect(typeof item.count).toBe("number");
      }

      // noWorkers is boolean false because live workers exist; the queued run
      // has no placement requirements, so it is not a placement anomaly.
      expect(typeof status.anomalies.noWorkers).toBe("boolean");
      expect(status.anomalies.noWorkers).toBe(false);
      expect(status.anomalies.unmatchedPlacementRuns).toEqual([]);

      // StoppedSchedule keys match if present
      const stoppedSchedBlock = extractInterfaceBlock(
        typesSrc,
        "StoppedSchedule",
      );
      const expectedStoppedSchedKeys =
        extractDirectProperties(stoppedSchedBlock).sort();
      for (const ss of status.anomalies.stoppedSchedules) {
        expect(Object.keys(ss).sort()).toEqual(expectedStoppedSchedKeys);
      }

      // proposalsPilingUp matches ProposalPilingUp
      const pilingBlock = extractInterfaceBlock(typesSrc, "ProposalPilingUp");
      const expectedPilingKeys = extractDirectProperties(pilingBlock).sort();
      expect(status.anomalies.proposalsPilingUp.length).toBe(1);
      for (const p of status.anomalies.proposalsPilingUp) {
        expect(Object.keys(p).sort()).toEqual(expectedPilingKeys);
        expect(typeof p.loop).toBe("string");
        expect(typeof p.count).toBe("number");
        expect(typeof p.threshold).toBe("number");
      }
      expect(status.anomalies.proposalsPilingUp[0]).toEqual({
        loop: "reaper",
        count: 4,
        threshold: 3,
      });

      // Remaining anomaly primitives
      expect(Array.isArray(status.anomalies.configuration)).toBe(true);
      expect(status.anomalies.expiredOpenProposals).toEqual(["prop-expired-1"]);
      expect(typeof status.anomalies.staleLeases).toBe("number");
      expect(typeof status.anomalies.unpublishedOutbox).toBe("number");
      expect(status.anomalies.deadLettered).toEqual([
        {
          source: "test",
          eventId: "evt-dead-1",
          lastError: "failed to plan",
        },
      ]);
    } finally {
      s.close();
    }
  });

  test("GET /status reports GitHub intake as unconfigured without a webhook secret", async () => {
    const s = await makeServer({ githubSecret: null });
    try {
      const status = await (await fetch(s.url("/status"))).json();
      expect(status.githubIntake).toMatchObject({
        configured: false,
        ageMs: null,
        stale: false,
      });
    } finally {
      s.close();
    }
  });

  test("GET /workers keys and types strictly match Worker verbatim", async () => {
    const dir = tmpDir("evrt-workers-contract-");
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;

    registerWorker(db, {
      workerId: "w-idle-1",
      labels: { role: "worker", node: "lab-1" },
      adapters: ["claude", "fake"],
      now: nowMs,
    });
    registerWorker(db, {
      workerId: "w-busy-1",
      labels: { role: "worker" },
      adapters: ["claude"],
      now: nowMs,
    });
    heartbeat(db, "w-busy-1", {
      state: "busy",
      runId: "run-busy-1",
      now: nowMs,
    });
    registerWorker(db, {
      workerId: "w-stale-1",
      labels: {},
      adapters: [],
      now: nowMs - 120000,
    });
    registerWorker(db, {
      workerId: "w-stopped-1",
      labels: { role: "worker" },
      adapters: ["claude"],
      now: nowMs,
    });
    deregisterWorker(db, "w-stopped-1", { now: nowMs });

    const s = await makeServer({
      db,
      secret: "sec",
      now: () => nowMs,
    });

    try {
      const res = await fetch(s.url("/workers"));
      expect(res.status).toBe(200);
      const { workers } = await res.json();
      expect(workers.length).toBe(4);

      const workerBlock = extractInterfaceBlock(typesSrc, "Worker");
      const expectedWorkerKeys = extractDirectProperties(workerBlock).sort();

      for (const w of workers) {
        expect(Object.keys(w).sort()).toEqual(expectedWorkerKeys);
        expect(typeof w.workerId).toBe("string");
        expect(typeof w.host).toBe("string");
        expect(typeof w.pid).toBe("number");
        expect(typeof w.labels).toBe("object");
        expect(w.labels).not.toBeNull();
        expect(Array.isArray(w.adapters)).toBe(true);
        expect(["idle", "busy", "stopped"]).toContain(w.state);
        expect(w.currentRun === null || typeof w.currentRun === "string").toBe(
          true,
        );
        expect(typeof w.lastSeen).toBe("string");
        expect(typeof w.stale).toBe("boolean");
        expect(typeof w.startedAt).toBe("string");
        expect(w.stoppedAt === null || typeof w.stoppedAt === "string").toBe(
          true,
        );
      }

      const idle = workers.find((w) => w.workerId === "w-idle-1");
      expect(idle.labels).toEqual({ role: "worker", node: "lab-1" });
      expect(idle.adapters).toEqual(["claude", "fake"]);
      expect(idle.state).toBe("idle");
      expect(idle.currentRun).toBeNull();
      expect(idle.stale).toBe(false);
      expect(idle.stoppedAt).toBeNull();

      const busy = workers.find((w) => w.workerId === "w-busy-1");
      expect(busy.state).toBe("busy");
      expect(busy.currentRun).toBe("run-busy-1");
      expect(busy.stale).toBe(false);

      const stale = workers.find((w) => w.workerId === "w-stale-1");
      expect(stale.stale).toBe(true);

      const stopped = workers.find((w) => w.workerId === "w-stopped-1");
      expect(stopped.state).toBe("stopped");
      expect(stopped.stoppedAt).not.toBeNull();
    } finally {
      s.close();
    }
  });

  test("noWorkers anomaly transitions to true when QUEUED runs exist and live worker count is 0", async () => {
    const dir = tmpDir("evrt-noworkers-contract-");
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;
    const atIso = new Date(nowMs).toISOString();

    // 1 queued run
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
       VALUES (?, ?, "dummy", "{}", "QUEUED", 1, ?, ?)`,
    ).run("run-queued-1", "idem-queued-1", atIso, atIso);

    // Only stopped or stale workers (live count = 0)
    registerWorker(db, {
      workerId: "w-stopped",
      labels: {},
      adapters: ["claude"],
      now: nowMs,
    });
    deregisterWorker(db, "w-stopped", { now: nowMs });
    registerWorker(db, {
      workerId: "w-stale",
      labels: {},
      adapters: ["claude"],
      now: nowMs - 120000,
    });

    const s = await makeServer({
      db,
      secret: "sec",
      now: () => nowMs,
    });

    try {
      const status1 = await s.client.status();
      expect(status1.workers.live).toBe(0);
      expect(status1.runs.byState.QUEUED).toBe(1);
      expect(status1.anomalies.noWorkers).toBe(true);

      // Register a live worker -> noWorkers becomes false
      registerWorker(db, {
        workerId: "w-live",
        labels: {},
        adapters: ["claude"],
        now: nowMs,
      });
      const status2 = await s.client.status();
      expect(status2.workers.live).toBe(1);
      expect(status2.anomalies.noWorkers).toBe(false);
    } finally {
      s.close();
    }
  });

  test("GET /status identifies queued runs whose placement matches no active, non-stale worker", async () => {
    const dir = tmpDir("evrt-unmatched-placement-contract-");
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;
    const atIso = new Date(nowMs).toISOString();
    const queue = (runId, placement) => {
      db.query(
        `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
         VALUES (?, ?, "dummy", ?, "QUEUED", 1, ?, ?)`,
      ).run(
        runId,
        `idem-${runId}`,
        JSON.stringify({ placement }),
        atIso,
        atIso,
      );
    };

    queue("run-matched", { node: "lab" });
    queue("run-unmatched", { node: "gpu", class: "heavy" });
    queue("run-unconstrained", undefined);

    registerWorker(db, {
      workerId: "w-live-lab",
      labels: { node: "lab" },
      adapters: ["claude"],
      now: nowMs,
    });
    registerWorker(db, {
      workerId: "w-stale-gpu",
      labels: { node: "gpu", class: "heavy" },
      adapters: ["claude"],
      now: nowMs - 120000,
    });
    registerWorker(db, {
      workerId: "w-stopped-gpu",
      labels: { node: "gpu", class: "heavy" },
      adapters: ["claude"],
      now: nowMs,
    });
    deregisterWorker(db, "w-stopped-gpu", { now: nowMs });

    const s = await makeServer({ db, secret: "sec", now: () => nowMs });
    try {
      const status1 = await s.client.status();
      expect(status1.workers.live).toBe(1);
      expect(status1.anomalies.noWorkers).toBe(false);
      expect(status1.anomalies.unmatchedPlacementRuns).toEqual([
        { runId: "run-unmatched", placement: { node: "gpu", class: "heavy" } },
      ]);

      registerWorker(db, {
        workerId: "w-live-gpu",
        labels: { node: "gpu", class: "heavy" },
        adapters: ["claude"],
        now: nowMs,
      });
      const status2 = await s.client.status();
      expect(status2.anomalies.unmatchedPlacementRuns).toEqual([]);
    } finally {
      s.close();
    }
  });

  test("a rename on either StatusView/Worker types or API response triggers contract failure", () => {
    // 1. Rename on API response side fails assertion
    const mockApiResponse = {
      stuckWorkers: [
        { workerId: "w1", host: "h1", runId: "r1", lastSeen: "t1" },
      ],
      hasNoWorkers: true,
    };
    const expectedKeys = ["noWorkers", "stalledWorkers"].sort();
    expect(() => {
      expect(Object.keys(mockApiResponse).sort()).toEqual(expectedKeys);
    }).toThrow();

    // 2. Rename on types.ts side fails assertion
    const mockRenamedTypesSrc = `
      export interface StatusView {
        anomalies: {
          stuckWorkers: StalledWorker[];
          hasNoWorkers: boolean;
        };
      }
    `;
    const extractedRenamedKeys = extractDirectProperties(
      extractNestedBlock(mockRenamedTypesSrc, "anomalies"),
    ).sort();
    const actualApiAnomalies = {
      noWorkers: true,
      stalledWorkers: [],
    };
    expect(() => {
      expect(Object.keys(actualApiAnomalies).sort()).toEqual(
        extractedRenamedKeys,
      );
    }).toThrow();
  });
});

describe("GET /status hook decisions (WM-842)", () => {
  test("hooks.decisions24h counts allow/deny per hook id, only within the trailing 24h", async () => {
    const dir = tmpDir("evrt-status-hooks-");
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = Date.parse("2026-08-19T12:00:00.000Z");
    const hooks = createHookRegistry();
    hooks.register(
      "approve.before",
      {
        id: "acme/x:gate",
        default: () => ({ decision: "deny", reason: "no" }),
      },
      { source: "extension:acme/x" },
    );
    const ctx = (labels) => ({
      proposal: { id: "p1", runId: "r1" },
      evidence: { ticket: { labels }, escalatePathIntersections: [] },
    });
    hooks.run("approve.before", ctx(["ai:escalated"]), { db, now: nowMs });
    hooks.run("approve.before", ctx([]), { db, now: nowMs - 3600_000 });
    hooks.run("approve.before", ctx([]), { db, now: nowMs - 25 * 3600_000 });

    const s = await makeServer({ db, secret: "sec", now: () => nowMs });
    try {
      const res = await fetch(s.url("/status"));
      expect(res.status).toBe(200);
      const status = await res.json();
      expect(status.hooks).toEqual({
        decisions24h: {
          "factory:escalation-labels": {
            source: "builtin",
            point: "approve.before",
            allow: 1,
            deny: 1,
          },
          "acme/x:gate": {
            source: "extension:acme/x",
            point: "approve.before",
            allow: 0,
            deny: 1,
          },
        },
      });
    } finally {
      s.close();
    }
  });

  test("hooks.decisions24h is empty before any hook ever ran (no table yet)", async () => {
    const dir = tmpDir("evrt-status-hooks-empty-");
    const db = openDb(path.join(dir, "runtime.db"));
    const s = await makeServer({ db, secret: "sec", now: () => 100000000 });
    try {
      const status = await (await fetch(s.url("/status"))).json();
      expect(status.hooks).toEqual({ decisions24h: {} });
    } finally {
      s.close();
    }
  });
});
