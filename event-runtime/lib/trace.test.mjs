import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-trace-test-mjs";
import { describe, expect, test } from "bun:test";

import * as fake from "./adapters/fake.mjs";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import { createRun, transition } from "./lifecycle.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  TRACE_EVENTS_CAP,
  TRACE_KINDS,
  TRACE_PAYLOAD_MAX_BYTES,
  traceOf,
  traceRecorder,
} from "./trace.mjs";
import { runOnce } from "./worker.mjs";

const registry = loadRegistry();
const T0 = Date.parse("2026-08-13T10:00:00Z");

function traceRows(db, runId) {
  return db
    .query(`SELECT * FROM attempt_trace WHERE run_id = ? ORDER BY seq`)
    .all(runId);
}

describe("traceRecorder", () => {
  test("records every allowed kind with attribution and timestamp", () => {
    const db = openDb(":memory:");
    const record = traceRecorder(db, {
      runId: "run_a",
      attempt: 1,
      now: () => T0,
    });
    for (const kind of TRACE_KINDS) record(kind, { kind });

    const rows = traceRows(db, "run_a");
    expect(rows.map((r) => r.kind)).toEqual(TRACE_KINDS);
    expect(rows.every((r) => r.attempt === 1)).toBe(true);
    expect(rows[0].ts).toBe(new Date(T0).toISOString());
    expect(JSON.parse(rows[0].payload_json)).toEqual({
      kind: "assistant_text",
    });
    expect(record.stats()).toEqual({
      recorded: TRACE_KINDS.length,
      dropped: 0,
    });
  });

  test("unknown kinds are dropped and counted, never thrown", () => {
    const db = openDb(":memory:");
    const record = traceRecorder(db, { runId: "run_b", attempt: 1 });
    expect(() => record("surprise_kind", { x: 1 })).not.toThrow();
    record("thinking", {});
    record("assistant_text", { text: "kept" });

    expect(traceRows(db, "run_b")).toHaveLength(1);
    expect(record.stats()).toEqual({ recorded: 1, dropped: 2 });
  });

  test("unserializable payload is dropped, not thrown", () => {
    const db = openDb(":memory:");
    const record = traceRecorder(db, { runId: "run_c", attempt: 1 });
    const circular = {};
    circular.self = circular;
    expect(() => record("assistant_text", circular)).not.toThrow();
    expect(traceRows(db, "run_c")).toHaveLength(0);
    expect(record.stats()).toEqual({ recorded: 0, dropped: 1 });
  });

  test("oversize payload is truncated in place with a marker, not dropped", () => {
    const db = openDb(":memory:");
    const record = traceRecorder(db, { runId: "run_d", attempt: 1 });
    const big = { text: "x".repeat(TRACE_PAYLOAD_MAX_BYTES + 1024) };
    record("assistant_text", big);

    const rows = traceRows(db, "run_d");
    expect(rows).toHaveLength(1);
    expect(Buffer.byteLength(rows[0].payload_json, "utf8")).toBeLessThanOrEqual(
      TRACE_PAYLOAD_MAX_BYTES,
    );
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.truncated).toBe(true);
    expect(payload.originalBytes).toBeGreaterThan(TRACE_PAYLOAD_MAX_BYTES);
    expect(payload.preview).toContain("xxx");
    expect(record.stats()).toEqual({ recorded: 1, dropped: 0 });
  });

  test("cap: TRACE_EVENTS_CAP rows plus exactly one truncation marker", () => {
    const db = openDb(":memory:");
    const record = traceRecorder(db, {
      runId: "run_e",
      attempt: 1,
      now: () => T0,
    });
    for (let i = 0; i < TRACE_EVENTS_CAP + 50; i += 1)
      record("assistant_text", { i });

    const rows = traceRows(db, "run_e");
    expect(rows).toHaveLength(TRACE_EVENTS_CAP + 1);
    const markers = rows.filter(
      (r) =>
        r.kind === "lifecycle" &&
        JSON.parse(r.payload_json).note === "trace_truncated",
    );
    expect(markers).toHaveLength(1);
    expect(rows.at(-1).kind).toBe("lifecycle"); // the marker is the final row
    expect(JSON.parse(rows.at(-1).payload_json).dropped).toBe(1); // dropped so far at cap time
    expect(record.stats()).toEqual({ recorded: TRACE_EVENTS_CAP, dropped: 50 });
  });
});

describe("traceOf", () => {
  function seeded(db) {
    const r1 = traceRecorder(db, {
      runId: "run_page",
      attempt: 1,
      now: () => T0,
    });
    r1("assistant_text", { text: "one" });
    r1("tool_use", { name: "Bash", input: {} });
    // Interleave another run to prove head and entries are per-run.
    const other = traceRecorder(db, {
      runId: "run_other",
      attempt: 1,
      now: () => T0,
    });
    other("assistant_text", { text: "noise" });
    const r2 = traceRecorder(db, {
      runId: "run_page",
      attempt: 2,
      now: () => T0,
    });
    r2("tool_result", { content: "done" });
    r2("usage", { durationMs: 5 });
  }

  test("pages by since/limit; head is the run's own max seq", () => {
    const db = openDb(":memory:");
    seeded(db);

    const first = traceOf(db, "run_page", { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.entries.map((e) => e.kind)).toEqual([
      "assistant_text",
      "tool_use",
    ]);
    expect(first.entries[0].payload).toEqual({ text: "one" });

    const rest = traceOf(db, "run_page", { since: first.entries.at(-1).seq });
    expect(rest.entries.map((e) => e.kind)).toEqual(["tool_result", "usage"]);
    expect(rest.head).toBe(rest.entries.at(-1).seq); // per-run head, not global
    expect(rest.head).toBe(first.head);

    const empty = traceOf(db, "run_page", { since: rest.head });
    expect(empty.entries).toEqual([]);
    expect(empty.head).toBe(rest.head);
  });

  test("attributes entries to their attempt", () => {
    const db = openDb(":memory:");
    seeded(db);
    const { entries } = traceOf(db, "run_page");
    expect(entries.map((e) => e.attempt)).toEqual([1, 1, 2, 2]);
  });

  test("no trace → head 0, empty entries; limit is capped at 500", () => {
    const db = openDb(":memory:");
    expect(traceOf(db, "run_none")).toEqual({ head: 0, entries: [] });

    const record = traceRecorder(db, {
      runId: "run_big",
      attempt: 1,
      now: () => T0,
    });
    for (let i = 0; i < 600; i += 1) record("assistant_text", { i });
    expect(traceOf(db, "run_big", { limit: 9999 }).entries).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------
// Worker path: the recorder is built per attempt and handed to the adapter as
// onTrace (same run-spec/queue helpers as worker.test.mjs).
// ---------------------------------------------------------------------------

let seq = 0;
function makeSpec(overrides = {}) {
  const runId =
    overrides.runId ??
    `run_trace_${++seq}_${Math.random().toString(36).slice(2)}`;
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
    capabilities: ["linear:read"],
    timeoutSeconds: 5,
    maxAttempts: 1,
    idempotencyKey: `idem-${runId}`,
    ...overrides,
  };
}

function queueRun(db, spec, now = T0) {
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

function opts(extra = {}) {
  return {
    owner: "w1",
    workspacesRoot: tmpDir("evrt-trace-"),
    now: T0,
    policyVersion: "test",
    ...extra,
  };
}

describe("worker trace plumbing", () => {
  test('fake "ok" run records the four deterministic kinds, in order, on attempt 1', async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec());

    const summary = await runOnce(db, registry, { fake }, opts());
    expect(summary.terminalState).toBe("COMPLETED");

    const rows = traceRows(db, spec.runId);
    expect(rows.map((r) => r.kind)).toEqual([
      "assistant_text",
      "tool_use",
      "tool_result",
      "usage",
    ]);
    expect(rows.every((r) => r.attempt === 1)).toBe(true);
    expect(JSON.parse(rows[1].payload_json).name).toBe("Bash");

    const view = traceOf(db, spec.runId);
    expect(view.head).toBe(rows.at(-1).seq);
    expect(view.entries).toHaveLength(4);
  });

  test('"trace-flood" run stops at the cap plus one truncation marker', async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["trace-flood"] } }));

    const summary = await runOnce(db, registry, { fake }, opts());
    expect(summary.terminalState).toBe("COMPLETED"); // flooding never fails the run

    const rows = traceRows(db, spec.runId);
    expect(rows).toHaveLength(TRACE_EVENTS_CAP + 1);
    expect(rows.at(-1).kind).toBe("lifecycle");
    expect(JSON.parse(rows.at(-1).payload_json).note).toBe("trace_truncated");
    expect(rows.filter((r) => r.kind === "lifecycle")).toHaveLength(1);
  });

  test("adapters that ignore onTrace stay conformant: refuse mode records nothing", async () => {
    const db = openDb(":memory:");
    const spec = queueRun(db, makeSpec({ input: { repos: ["refuse"] } }));
    const summary = await runOnce(db, registry, { fake }, opts());
    expect(summary.terminalState).toBe("REFUSED");
    expect(traceRows(db, spec.runId)).toEqual([]);
  });
});
