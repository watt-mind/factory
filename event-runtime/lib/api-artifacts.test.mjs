import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-artifacts-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { streamArtifact } from "./api-artifacts.mjs";
import { artifactReferenceIndex } from "./artifacts.mjs";
import { canonicalJson, sha256Hex } from "./canonical.mjs";
import {
  CONTROL_TOKEN,
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

describe("artifact store and agent registry surfacing (OPS-212)", () => {
  test("GET /artifacts ignores an entry that vanishes during inventory", async () => {
    const home = tmpDir("evrt-artifact-page-race-");
    const store = path.join(home, "artifacts");
    mkdirSync(store, { recursive: true });
    const survivingHash = "a".repeat(64);
    const vanishedHash = "b".repeat(64);
    writeFileSync(path.join(store, survivingHash), "survives", "utf8");
    // statSync follows this dangling link and observes it as absent, matching
    // a blob deleted by a concurrent prune after readdirSync.
    symlinkSync(
      path.join(store, "no-longer-present"),
      path.join(store, vanishedHash),
    );

    const db = openDb(path.join(home, "runtime.db"));
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "test", home, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/artifacts`);
      expect(response.status).toBe(200);
      expect(
        (await response.json()).artifacts.map(({ sha256 }) => sha256),
      ).toEqual([survivingHash]);
    } finally {
      server.close();
    }
  });

  test("GET /artifacts reuses its index until a new result arrives", async () => {
    const home = tmpDir("evrt-artifact-page-cache-");
    const store = path.join(home, "artifacts");
    mkdirSync(store, { recursive: true });
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    const missingHash = "c".repeat(64);
    writeFileSync(path.join(store, firstHash), "first", "utf8");

    const db = openDb(path.join(home, "runtime.db"));
    const createdAt = "2026-01-02T03:04:05.000Z";
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`,
    ).run(
      "run_first",
      "idem-first",
      JSON.stringify({ agent: "cache-agent@1" }),
      "spec-hash",
      createdAt,
      createdAt,
    );
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:result', '{}', '{}', ?)`,
    ).run(
      "run_first",
      JSON.stringify({ artifacts: [{ kind: "report", sha256: firstHash }] }),
      createdAt,
    );
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`,
    ).run(
      "run_missing",
      "idem-missing",
      JSON.stringify({ agent: "cache-agent@1" }),
      "spec-hash",
      createdAt,
      createdAt,
    );
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:result', '{}', '{}', ?)`,
    ).run(
      "run_missing",
      JSON.stringify({ artifacts: [{ kind: "report", sha256: missingHash }] }),
      createdAt,
    );

    let indexBuilds = 0;
    const indexedHashes = [];
    // Frozen clock: the 10 s inventory TTL must not lapse mid-test on a
    // loaded runner, or the rebuild count below would drift.
    const frozenNowMs = Date.parse("2026-01-02T03:04:05.000Z");
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "test", home, adapter: "fake" },
      now: () => frozenNowMs,
      buildArtifactReferenceIndex(currentDb, inventory) {
        indexBuilds += 1;
        const index = artifactReferenceIndex(currentDb, inventory);
        indexedHashes.push([...index.keys()]);
        return index;
      },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fetch(`${base}/artifacts`);
      await fetch(`${base}/artifacts`);
      expect(indexBuilds).toBe(1);
      expect(indexedHashes[0]).not.toContain(missingHash);

      // Lease bookkeeping must not invalidate the result-derived cache.
      db.query(`UPDATE runs SET updated_at = ? WHERE run_id = ?`).run(
        "2026-01-02T03:05:05.000Z",
        "run_first",
      );
      await fetch(`${base}/artifacts`);
      expect(indexBuilds).toBe(1);

      // State is not result-derived: it must be fresh without rebuilding.
      db.query(`UPDATE runs SET state = ? WHERE run_id = ?`).run(
        "CANCELLED",
        "run_first",
      );
      const cancelled = await (
        await fetch(`${base}/artifacts?search=CANCELLED`)
      ).json();
      expect(cancelled.artifacts.map((artifact) => artifact.sha256)).toEqual([
        firstHash,
      ]);
      expect(cancelled.artifacts[0].references[0].state).toBe("CANCELLED");
      expect(
        (await (await fetch(`${base}/artifacts?search=COMPLETED`)).json())
          .artifacts,
      ).toEqual([]);
      expect(indexBuilds).toBe(1);

      writeFileSync(path.join(store, secondHash), "second", "utf8");
      db.query(
        `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`,
      ).run(
        "run_second",
        "idem-second",
        JSON.stringify({ agent: "cache-agent@1" }),
        "spec-hash",
        createdAt,
        createdAt,
      );
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, 1, ?, 'sha256:result', '{}', '{}', ?)`,
      ).run(
        "run_second",
        JSON.stringify({ artifacts: [{ kind: "report", sha256: secondHash }] }),
        createdAt,
      );

      const refreshed = await (await fetch(`${base}/artifacts`)).json();
      expect(indexBuilds).toBe(2);
      expect(refreshed.artifacts.map((artifact) => artifact.sha256)).toContain(
        secondHash,
      );
      expect(
        refreshed.artifacts.find((artifact) => artifact.sha256 === firstHash),
      ).toEqual(expect.objectContaining({ referenced: true }));
    } finally {
      server.close();
      db.close();
    }
  });

  test("GET /artifacts catalogues and filters metadata; POST /artifacts/prune dry-runs and applies", async () => {
    const home = tmpDir("evrt-artifacts-api-");
    const store = path.join(home, "artifacts");
    mkdirSync(store, { recursive: true });
    const reportHash = "a".repeat(64);
    const transcriptHash = "b".repeat(64);
    const orphanHash = "c".repeat(64);
    writeFileSync(path.join(store, reportHash), "report", "utf8");
    writeFileSync(path.join(store, transcriptHash), "transcript", "utf8");
    writeFileSync(path.join(store, orphanHash), "orphan", "utf8");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const hash of [reportHash, transcriptHash, orphanHash]) {
      utimesSync(path.join(store, hash), old, old);
    }

    const db = openDb(path.join(home, "runtime.db"));
    const createdAt = "2026-01-02T03:04:05.000Z";
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`,
    ).run(
      "run_catalogue",
      "idem_catalogue",
      JSON.stringify({ agent: "catalogue-agent@1" }),
      "spec-hash",
      createdAt,
      createdAt,
    );
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:result', '{}', '{}', ?)`,
    ).run(
      "run_catalogue",
      JSON.stringify({
        artifacts: [
          { kind: "report", sha256: reportHash },
          { kind: "transcript", sha256: transcriptHash },
        ],
      }),
      createdAt,
    );

    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "test", home, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const all = await (await fetch(`${base}/artifacts`)).json();
      expect(all.artifacts).toHaveLength(3);
      expect(
        all.artifacts.find((artifact) => artifact.sha256 === reportHash),
      ).toEqual({
        sha256: reportHash,
        sizeBytes: 6,
        mtime: old.toISOString(),
        referenced: true,
        references: [
          {
            runId: "run_catalogue",
            kind: "report",
            agent: "catalogue-agent@1",
            state: "COMPLETED",
            createdAt,
          },
        ],
      });
      expect(
        (
          await (await fetch(`${base}/artifacts?orphan=true`)).json()
        ).artifacts.map((a) => a.sha256),
      ).toEqual([orphanHash]);
      expect(
        (await (await fetch(`${base}/artifacts?orphan=false`)).json())
          .artifacts,
      ).toHaveLength(2);
      expect(
        (
          await (await fetch(`${base}/artifacts?kind=report`)).json()
        ).artifacts.map((a) => a.sha256),
      ).toEqual([reportHash]);
      expect(
        (await (await fetch(`${base}/artifacts?search=CATALOGUE-AGENT`)).json())
          .artifacts,
      ).toHaveLength(2);
      expect(
        (await (await fetch(`${base}/artifacts?limit=1`)).json()).artifacts,
      ).toHaveLength(1);
      const firstPage = await (await fetch(`${base}/artifacts?limit=2`)).json();
      expect(typeof firstPage.nextBefore).toBe("string");
      const secondPage = await (
        await fetch(
          `${base}/artifacts?limit=2&before=${encodeURIComponent(firstPage.nextBefore)}`,
        )
      ).json();
      expect(secondPage.artifacts).toHaveLength(1);
      expect(secondPage.nextBefore).toBeNull();
      for (const before of [
        "%",
        Buffer.from("not JSON").toString("base64url"),
        Buffer.from(
          JSON.stringify({
            mtime: old.toISOString(),
            sha256: "not-a-sha256",
          }),
        ).toString("base64url"),
        Buffer.from(
          JSON.stringify({
            mtime: "January 1, 2026",
            sha256: reportHash,
          }),
        ).toString("base64url"),
      ]) {
        const response = await fetch(
          `${base}/artifacts?before=${encodeURIComponent(before)}`,
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          error: "invalid_before",
          message: "before must be a valid cursor",
        });
      }
      const invalidOrphan = await fetch(`${base}/artifacts?orphan=maybe`);
      expect(invalidOrphan.status).toBe(422);
      expect(await invalidOrphan.json()).toEqual({
        error: "invalid_orphan",
        message: "orphan must be true or false",
      });
      for (const limit of ["abc", "0", "501"]) {
        const response = await fetch(`${base}/artifacts?limit=${limit}`);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_limit",
          message: "limit must be an integer between 1 and 500",
        });
      }

      for (const { body, error, message } of [
        {
          body: null,
          error: "invalid_body",
          message: "body must be an object",
        },
        {
          body: { dryRun: "true" },
          error: "invalid_dry_run",
          message: "dryRun must be a boolean",
        },
        {
          body: { apply: "true" },
          error: "invalid_apply",
          message: "apply must be a boolean",
        },
        {
          body: { apply: true, dryRun: true },
          error: "conflicting_flags",
          message: "apply and dryRun cannot both be true",
        },
      ]) {
        const response = await fetch(`${base}/artifacts/prune`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ error, message });
      }

      const dry = await fetch(`${base}/artifacts/prune`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      expect(dry.status).toBe(200);
      expect(await dry.json()).toEqual({
        deleted: 1,
        freedBytes: 6,
        remainingOrphans: 1,
      });
      expect(existsSync(path.join(store, orphanHash))).toBe(true);

      const apply = await fetch(`${base}/artifacts/prune`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      expect(apply.status).toBe(200);
      expect(await apply.json()).toEqual({
        deleted: 1,
        freedBytes: 6,
        remainingOrphans: 0,
      });
      expect(existsSync(path.join(store, orphanHash))).toBe(false);
      expect(existsSync(path.join(store, reportHash))).toBe(true);
      expect(
        (await (await fetch(`${base}/artifacts`)).json()).artifacts.map(
          (artifact) => artifact.sha256,
        ),
      ).not.toContain(orphanHash);
    } finally {
      server.close();
      db.close();
    }
  });

  test("declared artifacts and the transcript survive the workspace and stream from the API", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port, token: CONTROL_TOKEN });
    const home = tmpDir("evrt-home-");
    try {
      await client.replay(
        envelope({ eventId: "art-1", payload: { repos: ["with-artifact"] } }),
      );
      planAdmittedEvents(db, registry, {
        policyVersion: PV,
        adapterOverride: "fake",
      });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      const summary = await runOnce(
        db,
        registry,
        { pi: fake, fake },
        {
          workspacesRoot: path.join(home, "workspaces"),
          artifactStore: path.join(home, "artifacts"),
          owner: "test-worker",
          policyVersion: PV,
        },
      );
      expect(summary.terminalState).toBe("COMPLETED");

      const view = await client.run(summary.runId);
      const kinds = view.result.artifacts.map((a) => a.kind).sort();
      expect(kinds).toEqual(["report", "transcript"]);
      // Workspace is gone; every artifact URI must point into the store and exist.
      for (const a of view.result.artifacts) {
        expect(a.uri).toContain("/artifacts/");
        expect(a.sizeBytes).toBeGreaterThan(0);
      }
    } finally {
      server.close();
    }
  });

  test("GET /artifacts/:hash streams stored bytes; unknown and malformed hashes 404", async () => {
    const home = tmpDir("evrt-home-");
    const db = openDb(path.join(home, "runtime.db"));
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "test", home, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const port = server.address().port;
    const client = apiClient({ port, token: CONTROL_TOKEN });
    try {
      await client.replay(
        envelope({ eventId: "art-2", payload: { repos: ["with-artifact"] } }),
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
          workspacesRoot: path.join(home, "workspaces"),
          artifactStore: path.join(home, "artifacts"),
          owner: "test-worker",
          policyVersion: PV,
        },
      );

      const view = await client.run(summary.runId);
      const report = view.result.artifacts.find((a) => a.kind === "report");
      const resultDigest = view.result.artifactHash.slice("sha256:".length);
      const typedResult = await fetch(
        `http://127.0.0.1:${port}/artifacts/${resultDigest}`,
      );
      expect(typedResult.status).toBe(200);
      expect(await typedResult.text()).toBe(
        canonicalJson(view.result.artifact),
      );

      const corruptHash = sha256Hex("expected bytes");
      writeFileSync(path.join(home, "artifacts", corruptHash), "corrupt");
      const inventory = await (
        await fetch(`http://127.0.0.1:${port}/artifacts`)
      ).json();
      expect(
        inventory.artifacts.find(
          (artifact) => artifact.sha256 === resultDigest,
        ),
      ).toEqual(
        expect.objectContaining({
          referenced: true,
          references: [
            expect.objectContaining({
              runId: summary.runId,
              attempt: 1,
              kind: "result",
            }),
          ],
        }),
      );

      const res = await fetch(
        `http://127.0.0.1:${port}/artifacts/${report.sha256}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("fake report for with-artifact\n");

      expect(res.headers.get("content-disposition")).toBeNull();

      const named = await fetch(
        `http://127.0.0.1:${port}/artifacts/${report.sha256}?name=report`,
      );
      expect(named.status).toBe(200);
      expect(named.headers.get("content-disposition")).toBe(
        `inline; filename="report-${report.sha256.slice(0, 12)}"`,
      );

      const hostile = await fetch(
        `http://127.0.0.1:${port}/artifacts/${report.sha256}?name=${encodeURIComponent('a/b\\"c\r\nx')}`,
      );
      expect(hostile.headers.get("content-disposition")).toBe(
        `inline; filename="a_b__c__x-${report.sha256.slice(0, 12)}"`,
      );

      expect(
        (await fetch(`http://127.0.0.1:${port}/artifacts/${"0".repeat(64)}`))
          .status,
      ).toBe(404);
      expect(
        (await fetch(`http://127.0.0.1:${port}/artifacts/not-a-hash`)).status,
      ).toBe(404);

      expect(
        (await fetch(`http://127.0.0.1:${port}/artifacts/${corruptHash}`))
          .status,
      ).toBe(404);
      expect(existsSync(path.join(home, "artifacts", corruptHash))).toBe(false);
      expect(
        (
          await (await fetch(`http://127.0.0.1:${port}/artifacts`)).json()
        ).artifacts.map((artifact) => artifact.sha256),
      ).not.toContain(corruptHash);
    } finally {
      server.close();
    }
  });

  test("artifact stream failures destroy the response without leaking an error", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("simulated read failure"));
      },
    });
    const response = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await expect(streamArtifact(source, response)).resolves.toBeUndefined();
    } finally {
      console.warn = warn;
    }
    expect(response.destroyed).toBe(true);
  });

  test("artifact stream client aborts log debug while source failures warn", async () => {
    const warnings = [];
    const debugLogs = [];
    const warn = console.warn;
    const debug = console.debug;
    console.warn = (message) => warnings.push(message);
    console.debug = (message) => debugLogs.push(message);
    try {
      const clientAbort = async (
        error,
        response = new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      ) => {
        const source = new Readable({
          read() {
            this.destroy(error);
          },
        });
        await streamArtifact(source, response);
        expect(response.destroyed).toBe(true);
      };

      for (const code of [
        "ERR_STREAM_PREMATURE_CLOSE",
        "ECONNRESET",
        "EPIPE",
        "ERR_STREAM_DESTROYED",
      ]) {
        const error = new Error("client closed download");
        error.code = code;
        await clientAbort(error);
      }
      await clientAbort(new Error("aborted"));
      expect(warnings).toEqual([]);
      expect(debugLogs).toEqual([
        "artifact download client aborted",
        "artifact download client aborted",
        "artifact download client aborted",
        "artifact download client aborted",
        "artifact download client aborted",
      ]);

      const alreadyClosedSource = new Readable({
        read() {
          this.destroy(new Error("client closed download"));
        },
      });
      const alreadyClosedResponse = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      alreadyClosedResponse.destroy();
      await streamArtifact(alreadyClosedSource, alreadyClosedResponse);
      expect(warnings).toEqual([]);
      expect(debugLogs).toHaveLength(6);

      const failedSource = new Readable({
        read() {
          this.destroy(new Error("artifact blob was pruned"));
        },
      });
      const failedResponse = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      await streamArtifact(failedSource, failedResponse);
      expect(failedResponse.destroyed).toBe(true);
      expect(warnings).toEqual([
        "artifact download stream failed: artifact blob was pruned",
      ]);
      expect(debugLogs).toHaveLength(6);
    } finally {
      console.warn = warn;
      console.debug = debug;
    }
  });

  test("GET /artifacts/:hash streams large text and binary artifacts with bounded sniffing", async () => {
    const home = tmpDir("evrt-large-artifacts-api-");
    const store = path.join(home, "artifacts");
    const db = openDb(path.join(home, "runtime.db"));
    mkdirSync(store, { recursive: true });
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "test", home, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const port = server.address().port;
    const text = Buffer.alloc(1024 * 1024 + 1, "t");
    const binary = Buffer.concat([Buffer.from([0]), text]);
    const artifacts = [
      { bytes: text, contentType: "text/plain; charset=utf-8" },
      { bytes: binary, contentType: "application/octet-stream" },
    ];

    try {
      for (const { bytes, contentType } of artifacts) {
        const sha256 = sha256Hex(bytes);
        writeFileSync(path.join(store, sha256), bytes);

        const res = await fetch(`http://127.0.0.1:${port}/artifacts/${sha256}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(contentType);
        expect(res.headers.get("content-length")).toBe(String(bytes.length));
        expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
      }
    } finally {
      server.close();
      db.close();
    }
  });
});
