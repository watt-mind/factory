import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-worker-test-helpers-mjs";
import * as fake from "./adapters/fake.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { createRun, transition } from "./lifecycle.mjs";
import { loadRegistry } from "./registry.mjs";

export const registry = loadRegistry();
export const adapters = { fake };
export const T0 = Date.parse("2026-08-12T10:00:00Z");

let seq = 0;
export function makeSpec(overrides = {}) {
  const runId =
    overrides.runId ??
    `run_worker_${++seq}_${Math.random().toString(36).slice(2)}`;
  const input = overrides.input ?? { repos: ["ok"] };
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: "factory-status-report@1",
    input,
    inputHash: hashJson(input),
    workspace: { type: "ephemeral", retainOnFailure: true },
    adapter: "fake",
    promptVersion: "git:test",
    policyVersion: "git:test",
    outputContract: "factory.status-report/v1",
    capabilities: ["tracker:read"],
    timeoutSeconds: 5,
    maxAttempts: 1,
    idempotencyKey: `idem-${runId}`,
    ...overrides,
  };
}

export function queueRun(db, spec, now = T0) {
  createRun(db, {
    runId: spec.runId,
    idempotencyKey: spec.idempotencyKey,
    spec,
    specJson: canonicalJson(spec),
    specHash: hashJson(spec),
    actor: "test",
    policyVersion: "test",
    now,
  });
  transition(db, { runId: spec.runId, to: "APPROVED", actor: "test", now });
  transition(db, { runId: spec.runId, to: "QUEUED", actor: "test", now });
  return spec;
}

/** Link the run to an admitted event via a proposal, like the planner would. */
export function linkEvent(
  db,
  runId,
  {
    type = "factory.status-report.requested",
    correlationId = "corr-1",
    source = "test",
  } = {},
) {
  const at = new Date(T0).toISOString();
  db.query(
    `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, correlation_id, causation_id, envelope_json, payload_hash, admitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    source,
    `evt-${runId}`,
    type,
    "factory",
    at,
    at,
    correlationId,
    null,
    "{}",
    "sha256:x",
    at,
  );
  db.query(
    `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
     VALUES (?, ?, ?, ?, 'RUN_SPEC', ?, 1800)`,
  ).run(`prop-${runId}`, source, `evt-${runId}`, runId, at);
}

export function freshRoot() {
  return tmpDir("evrt-worker-");
}

/** A config-free checkout root for fail-closed policy tests. */
export const EMPTY_POLICY_ROOT = tmpDir("evrt-worker-empty-policy-");

export function opts(extra = {}) {
  return {
    owner: "w1",
    workspacesRoot: freshRoot(),
    now: T0,
    policyVersion: "test",
    policyRoot: EMPTY_POLICY_ROOT,
    ...extra,
  };
}

export function insertStalledWorker(db, workerId, runId, now) {
  const staleAt = now - 90_001;
  db.query(
    `INSERT INTO workers (worker_id, host, pid, labels_json, adapters, started_at, last_seen, state, current_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workerId,
    "test-host",
    1,
    "{}",
    "fake",
    new Date(now).toISOString(),
    new Date(staleAt).toISOString(),
    "busy",
    runId,
  );
}
