import { trackTmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-metrics-test-mjs";
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

describe("metrics query API (WM-281)", () => {
  let s;
  const metricsNow = Date.parse("2026-08-15T12:00:00.000Z");
  beforeAll(async () => {
    s = await makeServer({ now: () => metricsNow });
    s.db
      .query(
        `INSERT INTO lifecycle_events
         (run_id, from_state, to_state, actor, attempt, at, record_hash)
       VALUES ('metrics-run', 'VERIFYING', 'COMPLETED', 'test', 1,
               '2026-08-15T11:30:00.000Z', 'metrics-hash')`,
      )
      .run();
  });
  afterAll(() => s.close());

  test("GET /metrics returns one shared aligned bucket axis", async () => {
    const res = await fetch(
      s.url("/metrics?window=24h&bucket=1h&series=runs.outcomes,runs.started"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buckets).toHaveLength(24);
    expect(body.series["runs.outcomes"].COMPLETED.at(-1)).toBe(1);
    expect(body.series["runs.started"].total).toHaveLength(body.buckets.length);
  });

  test("query validation returns 422 and advertises valid values", async () => {
    const unknown = await fetch(s.url("/metrics?series=not.real"));
    expect(unknown.status).toBe(422);
    const unknownBody = await unknown.json();
    expect(unknownBody.error).toBe("unknown_series");
    expect(unknownBody.validSeries).toContain("runs.outcomes");

    const oversized = await fetch(
      s.url("/metrics?window=30d&bucket=15m&series=runs.started"),
    );
    expect(oversized.status).toBe(422);
    expect((await oversized.json()).error).toBe("too_many_buckets");
  });

  test("GET /metrics/breakdown validates dimensions and returns rows", async () => {
    const invalid = await fetch(
      s.url("/metrics/breakdown?window=24h&by=nope&metric=runs"),
    );
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).validDimensions).toContain("edge");

    const valid = await fetch(
      s.url("/metrics/breakdown?window=24h&by=agent&metric=runs"),
    );
    expect(valid.status).toBe(200);
    expect((await valid.json()).rows).toEqual([]);
  });

  test("GET /metrics/breakdown exposes model-tier economics cohorts", async () => {
    const response = await fetch(
      s.url("/metrics/breakdown?window=24h&by=modelTier&metric=cost"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ by: "modelTier", metric: "cost", rows: [] });
  });
});
