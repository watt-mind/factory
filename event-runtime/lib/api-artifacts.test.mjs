import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-artifacts-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { artifactReferenceIndex } from "./artifacts.mjs";
import { canonicalJson, sha256Hex } from "./canonical.mjs";
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

describe("artifact store and agent registry surfacing (OPS-212)", () => {
  test("GET /artifacts reuses its index until a new result arrives", async () => {
    const home = tmpDir("evrt-artifact-page-cache-");
    const store = path.join(home, "artifacts");
    mkdirSync(store, { recursive: true });
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
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

    let indexBuilds = 0;
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "test", home, adapter: "fake" },
      buildArtifactReferenceIndex(currentDb) {
        indexBuilds += 1;
        return artifactReferenceIndex(currentDb);
      },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fetch(`${base}/artifacts`);
      await fetch(`${base}/artifacts`);
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
      expect((await fetch(`${base}/artifacts?orphan=maybe`)).status).toBe(422);
      for (const limit of ["abc", "0", "501"]) {
        const response = await fetch(`${base}/artifacts?limit=${limit}`);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          error: "invalid_limit",
          message: "limit must be an integer between 1 and 500",
        });
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
    } finally {
      server.close();
      db.close();
    }
  });

  test("declared artifacts and the transcript survive the workspace and stream from the API", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
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
    const client = apiClient({ port });
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

      const corruptHash = sha256Hex("expected bytes");
      writeFileSync(path.join(home, "artifacts", corruptHash), "corrupt");
      expect(
        (await fetch(`http://127.0.0.1:${port}/artifacts/${corruptHash}`))
          .status,
      ).toBe(404);
      expect(existsSync(path.join(home, "artifacts", corruptHash))).toBe(false);
    } finally {
      server.close();
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
