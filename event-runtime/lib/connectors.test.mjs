import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-connectors-test-mjs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAdapterRegistry } from "./adapters/index.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import {
  CONNECTOR_START_TIMEOUT_MS,
  connectorActor,
  connectorSource,
  connectorStatus,
  createConnectorClient,
  emitInboxChange,
  loadedConnectors,
  splitConfigSecrets,
  startConnectors,
  stopConnectors,
  validateConnectorModule,
} from "./connectors.mjs";
import { openDb } from "./db.mjs";
import { decisionRequestHash } from "./decision.mjs";
import { EXTENSION_MANIFEST, loadExtensions } from "./extensions.mjs";
import { createHookRegistry } from "./hooks.mjs";
import { createInboxItem, getInboxItem } from "./inbox.mjs";
import { createRun, transition } from "./lifecycle.mjs";
import { loadRegistry } from "./registry.mjs";

const SAMPLE_EXTENSION = path.join(
  RUNTIME_ROOT,
  "test-support",
  "extensions",
  "sample",
);

function tempExtension(mutate = () => {}) {
  const dir = tmpDir("event-connector-");
  cpSync(SAMPLE_EXTENSION, dir, { recursive: true });
  const manifestFile = path.join(dir, EXTENSION_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const next = mutate(manifest, dir) ?? manifest;
  writeFileSync(manifestFile, JSON.stringify(next, null, 2));
  return dir;
}

function policyFor(...dirs) {
  return { extensions: dirs.map((p) => ({ path: p })) };
}

async function load(policy) {
  return loadExtensions({
    policy,
    adapterRegistry: createAdapterRegistry(),
    hookRegistry: createHookRegistry(),
    packRoots: [],
  });
}

afterEach(async () => {
  await stopConnectors();
});

afterEach(() => {
  for (const key of ["token", "apiKey", "nested"]) {
    delete Object.prototype[key];
  }
});

describe("validateConnectorModule", () => {
  test("requires a default start function and a shaped id", () => {
    expect(() => validateConnectorModule(null)).toThrow(/ES module/);
    expect(() => validateConnectorModule({ id: "a/b:echo" })).toThrow(
      /default async function start/,
    );
    expect(() =>
      validateConnectorModule({ default: async () => {}, id: "Nope" }),
    ).toThrow(/string id matching/);
    expect(
      validateConnectorModule({
        id: "factory/sample:echo",
        default: async () => {},
      }).id,
    ).toBe("factory/sample:echo");
  });
});

describe("splitConfigSecrets", () => {
  test("moves format: secret fields and heuristic keys out of config", () => {
    const values = {
      greeting: "hi",
      apiToken: "sk-live",
      nsec: "nsec1abc",
      credentials: { value: "innocuous-secret-name" },
      nested: { signingKey: "k", retries: 1 },
    };
    const { config, secrets } = splitConfigSecrets(values, [
      { path: ["apiToken"] },
      { path: ["credentials", "value"] },
    ]);
    expect(config).toEqual({
      greeting: "hi",
      credentials: {},
      nested: { retries: 1 },
    });
    expect(secrets).toEqual({
      apiToken: "sk-live",
      nsec: "nsec1abc",
      credentials: { value: "innocuous-secret-name" },
      nested: { signingKey: "k" },
    });
    expect(values.apiToken).toBe("sk-live");
  });

  test("does not traverse a __proto__ config key", () => {
    for (const values of [
      { __proto__: { token: "x" } },
      JSON.parse('{"__proto__":{"token":"x"}}'),
    ]) {
      const { secrets } = splitConfigSecrets(values);
      expect(Object.prototype.token).toBeUndefined();
      expect(Object.hasOwn(secrets, "__proto__")).toBe(false);
    }
  });

  test("deletes forbidden heuristic subtrees from config", () => {
    const values = JSON.parse(
      '{"__proto__":{"token":"x"},"constructor":{"apiKey":"y"},"nested":{"prototype":{"secret":"z"}}}',
    );
    const { config, secrets } = splitConfigSecrets(values);

    expect(config).toEqual({ nested: {} });
    expect(Object.hasOwn(config, "__proto__")).toBe(false);
    expect(Object.hasOwn(config, "constructor")).toBe(false);
    expect(Object.hasOwn(secrets, "__proto__")).toBe(false);
    expect(Object.hasOwn(secrets, "constructor")).toBe(false);
    expect(secrets).toEqual({});
    expect({}.token).toBeUndefined();
  });

  test("does not traverse constructor.prototype config keys", () => {
    const { secrets } = splitConfigSecrets(
      JSON.parse('{"constructor":{"prototype":{"apiKey":"x"}}}'),
    );
    expect(Object.prototype.apiKey).toBeUndefined();
    expect(Object.hasOwn(secrets, "constructor")).toBe(false);
  });

  test("deletes forbidden nested heuristic subtrees from config", () => {
    const { config, secrets } = splitConfigSecrets(
      JSON.parse('{"nested":{"prototype":{"secret":"x"}}}'),
    );
    expect(config).toEqual({ nested: {} });
    expect(Object.hasOwn(config.nested, "prototype")).toBe(false);
    expect(secrets).toEqual({});
    expect({}.secret).toBeUndefined();
  });

  test("deletes explicit secret paths containing forbidden segments", () => {
    const values = JSON.parse(
      '{"nested":{"__proto__":{"value":"x"}},"constructor":{"apiKey":"y"}}',
    );
    const { config, secrets } = splitConfigSecrets(values, [
      { path: ["nested", "__proto__", "value"] },
      { path: ["constructor", "apiKey"] },
    ]);
    expect(config).toEqual({ nested: {} });
    expect(secrets).toEqual({});
    expect({}.value).toBeUndefined();
    expect({}.apiKey).toBeUndefined();
  });

  test("strips forbidden keys from objects inside arrays", () => {
    const { config, secrets } = splitConfigSecrets(
      JSON.parse('{"items":[{"__proto__":{"x":1},"name":"a"},"scalar",7]}'),
    );
    expect(config).toEqual({ items: [{ name: "a" }, "scalar", 7] });
    expect(Object.hasOwn(config.items[0], "__proto__")).toBe(false);
    expect(secrets).toEqual({});
    expect({}.x).toBeUndefined();
  });

  test("strips forbidden keys from objects inside nested arrays", () => {
    const { config } = splitConfigSecrets(
      JSON.parse(
        '{"rows":[[{"constructor":{"y":2},"id":1}],[[{"prototype":{"z":3}}]]]}',
      ),
    );
    expect(config).toEqual({ rows: [[{ id: 1 }], [[{}]]] });
    expect(Object.hasOwn(config.rows[0][0], "constructor")).toBe(false);
    expect(Object.hasOwn(config.rows[1][0][0], "prototype")).toBe(false);
  });

  test("deletes explicit secret paths that pass through an array element", () => {
    const values = JSON.parse(
      '{"items":[{"nested":{"__proto__":{"value":"x"}},"token":"t"}]}',
    );
    const { config, secrets } = splitConfigSecrets(values, [
      { path: ["items", "0", "nested", "__proto__", "value"] },
      { path: ["items", "0", "token"] },
    ]);
    expect(config).toEqual({ items: [{ nested: {} }] });
    expect(Object.hasOwn(config.items[0].nested, "__proto__")).toBe(false);
    expect(Object.hasOwn(secrets, "__proto__")).toBe(false);
    expect(secrets).toEqual({ items: { 0: { token: "t" } } });
    expect({}.value).toBeUndefined();
  });

  test("preserves legitimate arrays, including forbidden names as scalar elements", () => {
    const { config, secrets } = splitConfigSecrets({
      allowed: ["__proto__", "constructor", "prototype"],
      items: [{ name: "a", tags: ["x", "y"] }, { name: "b" }],
      matrix: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(config).toEqual({
      allowed: ["__proto__", "constructor", "prototype"],
      items: [{ name: "a", tags: ["x", "y"] }, { name: "b" }],
      matrix: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(secrets).toEqual({});
  });

  test("does not write through an inherited intermediate object", () => {
    Object.prototype.nested = {};
    const { secrets } = splitConfigSecrets({ nested: { token: "x" } }, [
      { path: ["nested", "token"] },
    ]);
    expect(Object.prototype.token).toBeUndefined();
    expect(Object.hasOwn(secrets, "nested")).toBe(true);
    expect(secrets.nested).not.toBe(Object.prototype.nested);
    expect(secrets.nested.token).toBe("x");
    expect(Object.prototype.nested.token).toBeUndefined();
  });
});

describe("connector attribution", () => {
  test("inject source and decide actor are connector:<ext>/<name>[:actor]", () => {
    expect(connectorSource("factory/sample", "echo")).toBe(
      "connector:factory/sample/echo",
    );
    expect(connectorActor("factory/sample", "echo", "alice")).toBe(
      "connector:factory/sample/echo:alice",
    );
    expect(connectorActor("factory/sample", "echo")).toBe(
      "connector:factory/sample/echo:unknown",
    );
  });
});

describe("startConnectors / stopConnectors", () => {
  // The gate in extensions.mjs (environmentGatedConnectorModule) only invokes
  // a connector's real start() in the "live" environment (WM-988); these
  // tests opt in explicitly so they still exercise real start/stop behavior.
  // See "connectors stay healthy but do not start outside the live
  // environment" below for the non-live regression coverage.
  beforeEach(() => {
    process.env.FACTORY_EVENT_ENV = "live";
  });
  afterEach(() => {
    delete process.env.FACTORY_EVENT_ENV;
  });

  test("loads the echo fixture, starts, reports health, stops", async () => {
    await load(policyFor(SAMPLE_EXTENSION));
    expect(loadedConnectors().map((c) => c.name)).toEqual(["echo"]);
    const db = openDb(":memory:");
    const registry = loadRegistry();
    const logs = [];
    const started = await startConnectors({
      db,
      registry,
      log: (line) => logs.push(line),
    });
    expect(started.anomalies).toEqual([]);
    expect(connectorStatus()).toEqual([
      expect.objectContaining({
        extension: "factory/sample",
        name: "echo",
        ok: true,
        detail: "echo subscribed (0 inbox events)",
        startedAt: expect.any(String),
      }),
    ]);
    emitInboxChange({
      type: "new-item",
      item: { id: "inbox_1" },
      at: "2026-08-20T00:00:00.000Z",
    });
    expect(connectorStatus()[0]).toMatchObject({
      ok: true,
      detail: "echo subscribed (1 inbox events)",
      lastEventAt: "2026-08-20T00:00:00.000Z",
    });
    expect(logs.some((line) => /inbox new-item inbox_1/.test(line))).toBe(true);
    await stopConnectors();
    expect(connectorStatus()).toEqual([]);
  });

  test("ctx.config never contains secrets; ctx.secrets holds env-resolved values", async () => {
    const seen = [];
    const dir = tempExtension((m, dirPath) => {
      m.name = "factory/secretprobe";
      m.contributes.config.namespace = "secretprobe";
      writeFileSync(
        path.join(dirPath, "connectors", "echo.mjs"),
        `export const id = "factory/secretprobe:echo";
export default async function start(ctx) {
  globalThis.__connectorCtx = { config: ctx.config, secrets: ctx.secrets };
  return { stop() {}, health() { return { ok: true }; } };
}
`,
      );
    });
    process.env.FACTORY_EXT_SECRETPROBE_API_TOKEN = "tok-from-env";
    try {
      await load({
        extensions: [{ path: dir, config: { greeting: "secret-hi" } }],
      });
      const db = openDb(":memory:");
      await startConnectors({ db, registry: loadRegistry() });
      seen.push(globalThis.__connectorCtx);
    } finally {
      delete process.env.FACTORY_EXT_SECRETPROBE_API_TOKEN;
      delete globalThis.__connectorCtx;
    }
    expect(seen[0].config.greeting).toBe("secret-hi");
    expect(seen[0].config.apiToken).toBeUndefined();
    expect(seen[0].secrets.apiToken).toBe("tok-from-env");
  });

  test("a start() that throws is a per-connector anomaly; other contributions stay loaded", async () => {
    const dir = tempExtension((m, dirPath) => {
      m.name = "factory/boom";
      writeFileSync(
        path.join(dirPath, "connectors", "echo.mjs"),
        `export const id = "factory/boom:echo";
export default async function start() {
  throw new Error("refused to connect");
}
`,
      );
    });
    const loaded = await load(policyFor(dir));
    expect(loaded.extensions).toHaveLength(1);
    expect(loaded.extensions[0].adapters).toEqual(["echo"]);
    expect(loaded.extensions[0].hooks).toHaveLength(1);
    const started = await startConnectors({
      db: openDb(":memory:"),
      registry: loadRegistry(),
    });
    expect(started.anomalies).toEqual([
      "connector factory/boom/echo failed to start: refused to connect",
    ]);
    expect(connectorStatus()).toEqual([
      expect.objectContaining({
        extension: "factory/boom",
        name: "echo",
        ok: false,
        detail:
          "connector factory/boom/echo failed to start: refused to connect",
        startedAt: null,
      }),
    ]);
  });

  test("a start() that overruns the timeout is a failed start and aborts the signal", async () => {
    const dir = tempExtension((m, dirPath) => {
      m.name = "factory/slow";
      writeFileSync(
        path.join(dirPath, "connectors", "echo.mjs"),
        `export const id = "factory/slow:echo";
export default async function start(ctx) {
  await new Promise((resolve) => {
    ctx.signal.addEventListener("abort", resolve, { once: true });
  });
  return { stop() {}, health() { return { ok: true }; } };
}
`,
      );
    });
    await load(policyFor(dir));
    const started = await startConnectors({
      db: openDb(":memory:"),
      registry: loadRegistry(),
      timeoutMs: 30,
    });
    expect(started.anomalies[0]).toMatch(
      /connector factory\/slow\/echo failed to start: timed out after 30ms/,
    );
    expect(CONNECTOR_START_TIMEOUT_MS).toBe(10_000);
  });

  test("one connector failing to start does not prevent another from starting", async () => {
    const dir = tempExtension((m, dirPath) => {
      m.name = "factory/pair";
      mkdirSync(path.join(dirPath, "connectors"), { recursive: true });
      writeFileSync(
        path.join(dirPath, "connectors", "ok.mjs"),
        `export const id = "factory/pair:ok";
export default async function start() {
  return { stop() {}, health() { return { ok: true, detail: "ok" }; } };
}
`,
      );
      writeFileSync(
        path.join(dirPath, "connectors", "bad.mjs"),
        `export const id = "factory/pair:bad";
export default async function start() {
  throw new Error("nope");
}
`,
      );
      m.contributes.connectors = {
        bad: "./connectors/bad.mjs",
        ok: "./connectors/ok.mjs",
      };
    });
    await load(policyFor(dir));
    const started = await startConnectors({
      db: openDb(":memory:"),
      registry: loadRegistry(),
    });
    expect(started.anomalies).toEqual([
      "connector factory/pair/bad failed to start: nope",
    ]);
    const status = connectorStatus();
    expect(status.find((row) => row.name === "bad").ok).toBe(false);
    expect(status.find((row) => row.name === "ok")).toMatchObject({
      ok: true,
      detail: "ok",
    });
  });
});

describe("narrow loopback client", () => {
  test("inject stamps source; inbox.decide records connector actor; no approve on the client", async () => {
    const db = openDb(":memory:");
    const registry = loadRegistry();
    const client = createConnectorClient({
      db,
      registry,
      extension: "factory/sample",
      name: "echo",
    });
    expect(client.approve).toBeUndefined();
    expect(client.inject).toBeTypeOf("function");
    expect(client.inbox).toBeDefined();
    expect(client.proposals.get).toBeTypeOf("function");
    expect(client.runs.get).toBeTypeOf("function");

    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId: "conn-1",
      type: "factory.status-report.requested",
      source: "forged",
      subject: "factory",
      occurredAt: new Date().toISOString(),
      correlationId: "conn-1",
      causationId: null,
      payload: { repos: ["bj29"] },
    };
    const admitted = await client.inject(envelope);
    expect(admitted.admitted).toBe(true);
    expect(admitted.event.source).toBe("connector:factory/sample/echo");

    const decision = {
      schemaVersion: "factory.decision-request/v1",
      question: "Dismiss?",
      options: [{ id: "dismiss", label: "Not now", effect: "dismiss" }],
    };
    const item = createInboxItem(
      db,
      {
        kind: "BLOCKED",
        title: "from connector test",
        decision,
      },
      { id: "inbox_conn" },
    );
    expect(client.inbox.get("inbox_conn").id).toBe(item.id);
    expect(client.inbox.list({ status: "open" }).map((row) => row.id)).toEqual([
      "inbox_conn",
    ]);
    const decided = await client.inbox.decide(
      "inbox_conn",
      {
        schemaVersion: "factory.decision-response/v1",
        requestHash: decisionRequestHash(decision),
        optionId: "dismiss",
        fields: {},
      },
      { actor: "alice" },
    );
    expect(decided.item.decidedBy).toBe("connector:factory/sample/echo:alice");
    expect(getInboxItem(db, "inbox_conn").decidedBy).toBe(
      "connector:factory/sample/echo:alice",
    );
    expect(client.proposals.get("missing")).toBeNull();
    expect(client.runs.get("missing")).toBeNull();
  });

  test("runs.get hands back only the artifact, never the whole result_json (WM-975)", () => {
    const db = openDb(":memory:");
    const client = createConnectorClient({
      db,
      registry: loadRegistry(),
      extension: "factory/sample",
      name: "echo",
    });
    createRun(db, {
      runId: "run_connector_artifact",
      idempotencyKey: "connector-artifact",
      spec: { agent: "factory-ticket" },
      specJson: JSON.stringify({ agent: "factory-ticket" }),
      specHash: "spec-hash",
      actor: "planner",
      now: 0,
    });
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:x', '{}', '{}', ?)`,
    ).run(
      "run_connector_artifact",
      JSON.stringify({
        artifact: { outcome: "PR_OPEN", ticket: "WM-975" },
        // Deliberately not exposed to a connector: prompts, receipts, and
        // other agent-internal detail that rides in result_json alongside
        // the artifact.
        promptTranscript: "should never leave this process",
      }),
      "2026-08-20T00:00:00.000Z",
    );

    const run = client.runs.get("run_connector_artifact");
    expect(run.result).toEqual({ outcome: "PR_OPEN", ticket: "WM-975" });
    expect(run.result.promptTranscript).toBeUndefined();
  });

  test("inbox.markDelivered merges delivery, rejects missing id, leaves decide independent", async () => {
    const db = openDb(":memory:");
    const client = createConnectorClient({
      db,
      registry: loadRegistry(),
      extension: "factory/sample",
      name: "echo",
    });
    const request = {
      schemaVersion: "factory.decision-request/v1",
      question: "Dismiss?",
      options: [{ id: "dismiss", label: "Not now", effect: "dismiss" }],
    };
    createInboxItem(
      db,
      {
        kind: "BLOCKED",
        title: "mark delivered",
        decision: request,
      },
      { id: "inbox_mark_conn" },
    );

    const events = [];
    const unsubscribe = client.inbox.subscribe((event) => events.push(event));
    const marked = client.inbox.markDelivered("inbox_mark_conn", {
      buzz: { eventId: "nevent1xyz", postedAt: "2026-08-20T00:00:00.000Z" },
    });
    expect(marked.delivery.buzz.eventId).toBe("nevent1xyz");
    expect(marked.response).toBeNull();
    expect(marked.decidedAt).toBeNull();
    expect(getInboxItem(db, "inbox_mark_conn").delivery.buzz).toEqual({
      eventId: "nevent1xyz",
      postedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(events.at(-1)).toMatchObject({
      type: "changed",
      item: expect.objectContaining({ id: "inbox_mark_conn" }),
    });
    unsubscribe();

    expect(() =>
      client.inbox.markDelivered("inbox_absent", { buzz: { eventId: "x" } }),
    ).toThrow("unknown inbox item inbox_absent");

    const decided = await client.inbox.decide("inbox_mark_conn", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "dismiss",
      fields: {},
    });
    expect(decided.item.decidedBy).toBe(
      "connector:factory/sample/echo:unknown",
    );
    expect(decided.item.delivery.buzz.eventId).toBe("nevent1xyz");
  });

  test("runs.subscribe receives lifecycle transitions and can unsubscribe", () => {
    const db = openDb(":memory:");
    const client = createConnectorClient({
      db,
      registry: loadRegistry(),
      extension: "factory/sample",
      name: "echo",
    });
    const events = [];
    const unsubscribe = client.runs.subscribe((event) => events.push(event));
    createRun(db, {
      runId: "run_connector_subscribe",
      idempotencyKey: "connector-subscribe",
      spec: {},
      specJson: "{}",
      specHash: "spec-hash",
      actor: "planner",
      now: 0,
    });
    transition(db, {
      runId: "run_connector_subscribe",
      to: "APPROVED",
      actor: "operator",
      now: 1,
    });
    unsubscribe();
    transition(db, {
      runId: "run_connector_subscribe",
      to: "QUEUED",
      actor: "operator",
      now: 2,
    });

    expect(events).toEqual([
      expect.objectContaining({
        runId: "run_connector_subscribe",
        from: null,
        to: "PROPOSED",
      }),
      expect.objectContaining({
        runId: "run_connector_subscribe",
        from: "PROPOSED",
        to: "APPROVED",
      }),
    ]);
  });

  test("runs.tail observes a transition committed by a separate DB connection (WM-975)", () => {
    // `writer` and `reader` are separate connections to the same on-disk
    // database — the same shape as the OPS-233 split, where the worker (its
    // own process, its own connection) executes the interesting
    // transitions and the API process (a different connection) hosts the
    // connectors. subscribeRunLifecycle's in-memory bus cannot bridge that
    // gap by construction; the durable-journal tail reads the row itself,
    // so it observes the transition regardless of which connection wrote it.
    const file = path.join(tmpDir("event-connector-tail-"), "runtime.db");
    const writer = openDb(file);
    const reader = openDb(file);
    const client = createConnectorClient({
      db: reader,
      registry: loadRegistry(),
      extension: "factory/sample",
      name: "echo",
    });

    const cursor = client.runs.cursor();
    createRun(writer, {
      runId: "run_connector_tail",
      idempotencyKey: "connector-tail",
      spec: {},
      specJson: "{}",
      specHash: "spec-hash",
      actor: "planner",
      now: 0,
    });
    transition(writer, {
      runId: "run_connector_tail",
      to: "APPROVED",
      actor: "operator",
      now: 1,
    });

    const tailed = client.runs.tail(cursor);
    expect(tailed.events).toEqual([
      expect.objectContaining({
        runId: "run_connector_tail",
        from: null,
        to: "PROPOSED",
      }),
      expect.objectContaining({
        runId: "run_connector_tail",
        from: "PROPOSED",
        to: "APPROVED",
      }),
    ]);
    expect(tailed.cursor).toBeGreaterThan(cursor);

    // Re-polling with the returned cursor yields nothing new until another
    // transition lands.
    expect(client.runs.tail(tailed.cursor).events).toEqual([]);
    transition(writer, {
      runId: "run_connector_tail",
      to: "QUEUED",
      actor: "operator",
      now: 2,
    });
    const next = client.runs.tail(tailed.cursor);
    expect(next.events).toEqual([
      expect.objectContaining({
        runId: "run_connector_tail",
        from: "APPROVED",
        to: "QUEUED",
      }),
    ]);
  });
});
