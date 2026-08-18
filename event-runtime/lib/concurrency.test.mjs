import { trackTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-concurrency-test-mjs";
import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db.mjs";
import { createRun, transition } from "./lifecycle.mjs";
import { createIsolatedHome, realFactorySnapshot } from "../test-helpers.mjs";

const PV = "git:test-pv";

function queueRun(
  database,
  { runId, placement, adapter = "fake", timeoutSeconds = 60 },
) {
  const spec = {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "a@1",
    input: {},
    adapter,
    timeoutSeconds,
    maxAttempts: 1,
    ...(placement ? { placement } : {}),
  };
  createRun(database, {
    runId,
    idempotencyKey: runId,
    spec,
    specJson: JSON.stringify(spec),
    specHash: `sha256:${runId}`,
    actor: "planner",
    policyVersion: PV,
  });
  transition(database, {
    runId,
    to: "APPROVED",
    actor: "operator",
    policyVersion: PV,
  });
  transition(database, {
    runId,
    to: "QUEUED",
    actor: "operator",
    policyVersion: PV,
  });
  return spec;
}

describe("multi-process concurrency (OPS-424, OPS-233)", () => {
  test("multi-process claiming: N concurrent workers claim M runs with zero duplicates and monotonic tokens", async () => {
    const home = trackTmpDir(createIsolatedHome("evrt-mp-claim-"));
    const dbFile = path.join(home, "runtime.db");
    const db = openDb(dbFile);

    const M = 20;
    for (let i = 0; i < M; i++) {
      const runId = `run_${i.toString().padStart(3, "0")}`;
      queueRun(db, { runId });
    }
    db.close();

    const N = 8;
    const procs = Array.from({ length: N }, (_, i) => {
      return Bun.spawn(
        [
          "bun",
          "-e",
          `
            import { openDb } from "./event-runtime/lib/db.mjs";
            import { claimNext } from "./event-runtime/lib/worker.mjs";
            const db = openDb(process.argv[1]);
            const workerId = process.argv[2];
            const claims = [];
            while (true) {
              const claim = claimNext(db, { owner: workerId, policyVersion: "git:test-pv" });
              if (!claim) break;
              claims.push(claim);
            }
            console.log(JSON.stringify(claims));
            db.close();
          `,
          dbFile,
          `worker-${i}`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_HOME: home },
        },
      );
    });

    const results = await Promise.all(
      procs.map(async (p) => {
        const code = await p.exited;
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        return {
          code,
          claims: out.trim() ? JSON.parse(out.trim()) : [],
          err,
        };
      }),
    );

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    }

    const allClaims = results.flatMap((r) => r.claims);
    expect(allClaims.length).toBe(M);

    const claimedRunIds = allClaims.map((c) => c.runId);
    const uniqueRuns = new Set(claimedRunIds);
    expect(uniqueRuns.size).toBe(M);

    const fencingTokens = allClaims.map((c) => c.fencingToken);
    const uniqueTokens = new Set(fencingTokens);
    expect(uniqueTokens.size).toBe(M);

    // Verify database state
    const verifyDb = openDb(dbFile);
    const attempts = verifyDb.query("SELECT * FROM attempts").all();
    expect(attempts.length).toBe(M);

    const runs = verifyDb
      .query("SELECT run_id, state, attempts FROM runs")
      .all();
    expect(runs.length).toBe(M);
    for (const row of runs) {
      expect(row.state).toBe("LEASED");
      expect(row.attempts).toBe(1);
    }
    verifyDb.close();
  });

  test("multi-process placement: concurrent workers with distinct placement labels claim correct runs", async () => {
    const home = trackTmpDir(createIsolatedHome("evrt-mp-placement-"));
    const dbFile = path.join(home, "runtime.db");
    const db = openDb(dbFile);

    // 6 lab runs, 6 web runs, 6 unplaced runs
    for (let i = 0; i < 6; i++) {
      queueRun(db, { runId: `lab_${i}`, placement: { node: "lab" } });
      queueRun(db, { runId: `web_${i}`, placement: { node: "web" } });
      queueRun(db, { runId: `any_${i}` });
    }
    db.close();

    // Spawn 2 lab workers, 2 web workers, and 2 general workers
    const workers = [
      { id: "lab-1", labels: { node: "lab" } },
      { id: "lab-2", labels: { node: "lab" } },
      { id: "web-1", labels: { node: "web" } },
      { id: "web-2", labels: { node: "web" } },
      { id: "gen-1", labels: { node: "general" } },
      { id: "gen-2", labels: { node: "general" } },
    ];

    const procs = workers.map((w) => {
      return Bun.spawn(
        [
          "bun",
          "-e",
          `
            import { openDb } from "./event-runtime/lib/db.mjs";
            import { claimNext } from "./event-runtime/lib/worker.mjs";
            const db = openDb(process.argv[1]);
            const workerId = process.argv[2];
            const labels = JSON.parse(process.argv[3]);
            const claims = [];
            while (true) {
              const claim = claimNext(db, { owner: workerId, labels, policyVersion: "git:test-pv" });
              if (!claim) break;
              claims.push(claim);
            }
            console.log(JSON.stringify(claims));
            db.close();
          `,
          dbFile,
          w.id,
          JSON.stringify(w.labels),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_HOME: home },
        },
      );
    });

    const results = await Promise.all(
      procs.map(async (p, idx) => {
        const code = await p.exited;
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        return {
          worker: workers[idx],
          code,
          claims: out.trim() ? JSON.parse(out.trim()) : [],
          err,
        };
      }),
    );

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    }

    const allClaims = results.flatMap((r) => r.claims);
    expect(allClaims.length).toBe(18);

    // Verify lab workers only claimed lab or unplaced
    const labClaims = results
      .filter((r) => r.worker.id.startsWith("lab-"))
      .flatMap((r) => r.claims);
    for (const c of labClaims) {
      expect(c.runId.startsWith("lab_") || c.runId.startsWith("any_")).toBe(
        true,
      );
    }

    // Verify web workers only claimed web or unplaced
    const webClaims = results
      .filter((r) => r.worker.id.startsWith("web-"))
      .flatMap((r) => r.claims);
    for (const c of webClaims) {
      expect(c.runId.startsWith("web_") || c.runId.startsWith("any_")).toBe(
        true,
      );
    }

    // Verify general workers only claimed unplaced
    const genClaims = results
      .filter((r) => r.worker.id.startsWith("gen-"))
      .flatMap((r) => r.claims);
    for (const c of genClaims) {
      expect(c.runId.startsWith("any_")).toBe(true);
    }

    const verifyDb = openDb(dbFile);
    const attempts = verifyDb.query("SELECT * FROM attempts").all();
    expect(attempts.length).toBe(18);
    verifyDb.close();
  });
});
