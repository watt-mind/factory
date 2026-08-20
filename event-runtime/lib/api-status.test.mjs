import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-status-test-mjs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { attachConnectorStatus, connectorsStatus } from "./api-status.mjs";
import { createAdapterRegistry } from "./adapters/index.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import {
  emitInboxChange,
  startConnectors,
  stopConnectors,
} from "./connectors.mjs";
import { openDb } from "./db.mjs";
import { EXTENSION_MANIFEST, loadExtensions } from "./extensions.mjs";
import { createHookRegistry } from "./hooks.mjs";
import { loadRegistry } from "./registry.mjs";

const SAMPLE_EXTENSION = path.join(
  RUNTIME_ROOT,
  "test-support",
  "extensions",
  "sample",
);

afterEach(async () => {
  await stopConnectors();
});

async function loadSample() {
  await loadExtensions({
    policy: { extensions: [{ path: SAMPLE_EXTENSION }] },
    adapterRegistry: createAdapterRegistry(),
    hookRegistry: createHookRegistry(),
    packRoots: [],
  });
}

describe("GET /status.connectors projection (WM-919)", () => {
  // Connectors only run their real start() in the "live" environment
  // (WM-988's environmentGatedConnectorModule gate) — opt in explicitly so
  // these tests still see real start/stop behavior.
  beforeEach(() => {
    process.env.FACTORY_EVENT_ENV = "live";
  });
  afterEach(() => {
    delete process.env.FACTORY_EVENT_ENV;
  });

  test("attachConnectorStatus adds connectors: [{ extension, name, ok, detail, lastEventAt, startedAt }]", async () => {
    await loadSample();
    await startConnectors({
      db: openDb(":memory:"),
      registry: loadRegistry(),
    });
    emitInboxChange({
      type: "new-item",
      item: { id: "inbox_status" },
      at: "2026-08-20T01:00:00.000Z",
    });
    const payload = attachConnectorStatus({
      events: { admitted: 0 },
      anomalies: { configuration: [] },
    });
    expect(payload.connectors).toEqual([
      {
        extension: "factory/sample",
        name: "echo",
        ok: true,
        detail: "echo subscribed (1 inbox events)",
        lastEventAt: "2026-08-20T01:00:00.000Z",
        startedAt: expect.any(String),
      },
    ]);
    expect(connectorsStatus()).toEqual(payload.connectors);
  });

  test("a failed start is listed with ok: false and the anomaly detail", async () => {
    const dir = tmpDir("event-status-conn-");
    cpSync(SAMPLE_EXTENSION, dir, { recursive: true });
    writeFileSync(
      path.join(dir, "connectors", "echo.mjs"),
      `export const id = "factory/sample:echo";
export default async function start() { throw new Error("down"); }
`,
    );
    const manifestFile = path.join(dir, EXTENSION_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.name = "factory/down";
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    await loadExtensions({
      policy: { extensions: [{ path: dir }] },
      adapterRegistry: createAdapterRegistry(),
      hookRegistry: createHookRegistry(),
      packRoots: [],
    });
    const started = await startConnectors({
      db: openDb(":memory:"),
      registry: loadRegistry(),
    });
    const payload = attachConnectorStatus({
      anomalies: { configuration: started.anomalies },
    });
    expect(payload.anomalies.configuration).toEqual([
      "connector factory/down/echo failed to start: down",
    ]);
    expect(payload.connectors).toEqual([
      expect.objectContaining({
        extension: "factory/down",
        name: "echo",
        ok: false,
        detail: "connector factory/down/echo failed to start: down",
        startedAt: null,
      }),
    ]);
  });
});
