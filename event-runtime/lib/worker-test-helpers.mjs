import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-worker-test-helpers-mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as fake from "./adapters/fake.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { createRun, transition } from "./lifecycle.mjs";
import { policySnapshot } from "./planner.mjs";
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

/**
 * A dispatch config snapshot whose `factory` entry points at THIS checkout.
 *
 * `config/repos.example.yaml` is the live registry fallback for a checkout
 * without `config/repos.yaml`, and it pins `factory` to `~/Develop/factory`.
 * The dispatch gate's owned-path closure check reads that directory, so every
 * test that drives a real dispatch gate for repo `factory` silently depended
 * on the operator's own checkout existing at that path. repo-verify runs this
 * suite inside the handoff sandbox, where only the worktree is mounted and
 * `HOME` is `/tmp/home`: the gate refused with `owned_paths_not_closed:
 * owned-path closure check failed: repo path does not exist`, and those tests
 * failed there while passing on a developer box (#2031). Pinning the entry to
 * the checkout under test keeps the closure check running against a real
 * factory tree in both environments instead of disabling it.
 */
let dispatchConfigSnapshotCache = null;
export function dispatchConfigSnapshot() {
  if (dispatchConfigSnapshotCache) return dispatchConfigSnapshotCache;
  const checkout = path.resolve(new URL("../..", import.meta.url).pathname);
  const registryConfig = Bun.YAML.parse(
    readFileSync(path.join(checkout, "config/repos.example.yaml"), "utf8"),
  );
  for (const entry of registryConfig?.repos ?? []) {
    if (entry?.name === "factory") entry.path = checkout;
  }
  const root = tmpDir("evrt-worker-dispatch-config-");
  mkdirSync(path.join(root, "config"), { recursive: true });
  // JSON is valid YAML, and the registry loader parses this file with the same
  // YAML parser, so no serializer is needed to round-trip the example.
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `${JSON.stringify(registryConfig, null, 2)}\n`,
  );
  dispatchConfigSnapshotCache = policySnapshot(root);
  return dispatchConfigSnapshotCache;
}

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
