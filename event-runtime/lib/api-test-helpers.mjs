import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import {
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  observedModelFromTranscript,
  repoNamesFromInput,
  startApi as startControlApi,
} from "./api.mjs";
import { apiClient } from "./client.mjs";
import { openDb } from "./db.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { loadRegistry } from "./registry.mjs";
import { loadRepos } from "./repos.mjs";
import { runOnce } from "./worker.mjs";
import { deregisterWorker, heartbeat, registerWorker } from "./workers.mjs";

export {
  apiClient,
  deregisterWorker,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  mkdirSync,
  mkdtempSync,
  observedModelFromTranscript,
  openDb,
  os,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  repoNamesFromInput,
  runOnce,
  utimesSync,
  writeFileSync,
};

export const registry = loadRegistry();
export const SECRET = "test-secret";
export const GH_SECRET = "test-github-secret";
export const PV = "git:test-pv";
export const CONTROL_TOKEN = "test-control-api-token";

/**
 * Compatibility seam for older API tests that intentionally focus on route
 * behavior rather than auth. Production code never imports this helper. The
 * prepended listener supplies the test credential before the real handler
 * runs, while explicit `controlApiToken: null` still exercises fail-closed.
 */
export function startApi(options = {}) {
  const controlApiToken = Object.hasOwn(options, "controlApiToken")
    ? options.controlApiToken
    : CONTROL_TOKEN;
  const server = startControlApi({ ...options, controlApiToken });
  server.prependListener("request", (req) => {
    if (!req.headers.authorization && controlApiToken) {
      req.headers.authorization = `Bearer ${controlApiToken}`;
    }
  });
  return server;
}

let n = 0;
export function envelope(overrides = {}) {
  const id = overrides.eventId ?? `evt-${++n}`;
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type: "factory.status-report.requested",
    source: "test",
    subject: "factory",
    occurredAt: new Date().toISOString(),
    correlationId: id,
    causationId: null,
    payload: { repos: ["ok"] },
    ...overrides,
  };
}

/** Await a promise that must reject; returns the error for assertions. */
export function rejection(promise) {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (err) => err,
  );
}

/** Exactly what verifyWebhook expects: HMAC-SHA256 hex of `${ts}.${rawBody}`. */
export function sign(rawBody, timestamp, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export async function makeServer({
  secret = SECRET,
  githubSecret = GH_SECRET,
  controlApiToken = CONTROL_TOKEN,
  autoAuthorize = true,
  ...opts
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-api-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const onEvents = [];
  const server = startControlApi({
    db,
    registry,
    secret,
    githubSecret,
    controlApiToken,
    policyVersion: PV,
    port: 0,
    onEvent: (kind) => onEvents.push(kind),
    ...opts,
  });
  if (autoAuthorize && controlApiToken) {
    server.prependListener("request", (req) => {
      if (!req.headers.authorization) {
        req.headers.authorization = `Bearer ${controlApiToken}`;
      }
    });
  }
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  return {
    db,
    server,
    port,
    onEvents,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    request: (p, init = {}) =>
      fetch(`http://127.0.0.1:${port}${p}`, {
        ...init,
        headers: {
          ...(controlApiToken
            ? { authorization: `Bearer ${controlApiToken}` }
            : {}),
          ...init.headers,
        },
      }),
    client: apiClient({ port, token: controlApiToken }),
    close: () => {
      server.close();
      db.close();
    },
  };
}
