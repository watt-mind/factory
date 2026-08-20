import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-connectors-test-mjs";
import { afterEach, describe, expect, test } from "bun:test";
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
      nested: { signingKey: "k", retries: 1 },
    };
    const { config, secrets } = splitConfigSecrets(values, [
      { path: ["apiToken"] },
    ]);
    expect(config).toEqual({ greeting: "hi", nested: { retries: 1 } });
    expect(secrets).toEqual({
      apiToken: "sk-live",
      nsec: "nsec1abc",
      nested: { signingKey: "k" },
    });
    expect(values.apiToken).toBe("sk-live");
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
    const decided = client.inbox.decide(
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
});
