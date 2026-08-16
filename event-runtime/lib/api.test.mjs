import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as fake from "./adapters/fake.mjs";
import {
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  observedModelFromTranscript,
  repoNamesFromInput,
  startApi,
} from "./api.mjs";
import { apiClient } from "./client.mjs";
import { openDb } from "./db.mjs";
import { planAdmittedEvents } from "./planner.mjs";
import { loadRegistry } from "./registry.mjs";
import { loadRepos } from "./repos.mjs";
import { runOnce } from "./worker.mjs";
import { registerWorker, heartbeat, deregisterWorker } from "./workers.mjs";

const registry = loadRegistry();
const SECRET = "test-secret";
const GH_SECRET = "test-github-secret";
const PV = "git:test-pv";

let n = 0;
function envelope(overrides = {}) {
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
function rejection(promise) {
  return promise.then(
    () => { throw new Error("expected rejection"); },
    (err) => err,
  );
}

/** Exactly what verifyWebhook expects: HMAC-SHA256 hex of `${ts}.${rawBody}`. */
function sign(rawBody, timestamp, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

async function makeServer({ secret = SECRET, githubSecret = GH_SECRET, ...opts } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-api-"));
  const db = openDb(path.join(dir, "runtime.db"));
  const onEvents = [];
  const server = startApi({
    db, registry, secret, githubSecret, policyVersion: PV, port: 0,
    onEvent: (kind) => onEvents.push(kind),
    ...opts,
  });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  return {
    db, server, port, onEvents,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    client: apiClient({ port }),
    close: () => {
      server.close();
      db.close();
    },
  };
}

describe("repoNamesFromInput (OPS-356)", () => {
  test("unscoped is []; repoPin / repo / repos[] (string or {name}); dedupes", () => {
    expect(repoNamesFromInput(null)).toEqual([]);
    expect(repoNamesFromInput({})).toEqual([]);
    expect(repoNamesFromInput({ repoPin: { repo: "bj29" } })).toEqual(["bj29"]);
    expect(repoNamesFromInput({ repo: "coach-wattz" })).toEqual(["coach-wattz"]);
    expect(repoNamesFromInput({ repos: ["ok", { name: "bj29" }] })).toEqual(["ok", "bj29"]);
    expect(repoNamesFromInput({ repo: "bj29", repoPin: { repo: "bj29" }, repos: ["bj29"] })).toEqual(["bj29"]);
  });
});

describe("human inbox API (WM-285)", () => {
  test("POST writes before a failed delivery, rejects unknown kinds, and GET/ack/resolve filter rows", async () => {
    const delivered = [];
    const s = await makeServer({
      now: () => 1000,
      inboxWebUrl: "http://127.0.0.1:7382",
      inboxSend: async (_command, message) => {
        delivered.push(message);
        return { ok: false, exitCode: 9, error: "telegram unavailable" };
      },
    });
    try {
      const unknown = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "claimed", title: "routine" }),
      });
      expect(unknown.status).toBe(422);
      expect((await unknown.json()).error).toContain("unknown inbox kind");

      const created = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "BLOCKED",
          title: "BLOCKED WM-1: choose a policy",
          refs: { issue: "WM-1" },
          source: "agent:run_1",
        }),
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.delivery).toEqual({ ok: false, exitCode: 9, error: "telegram unavailable" });
      expect(body.item.refs).toEqual({ issue: "WM-1" });
      expect(body.item.delivery.telegram.error).toBe("telegram unavailable");
      expect(delivered[0]).toEndWith(`/#/inbox/${body.item.id}`);

      let listed = await (await fetch(s.url("/inbox?status=open"))).json();
      expect(listed.items.map((item) => item.id)).toEqual([body.item.id]);

      const acked = await fetch(s.url(`/inbox/${body.item.id}/ack`), { method: "POST", body: "{}" });
      expect(acked.status).toBe(200);
      listed = await (await fetch(s.url("/inbox?status=acked"))).json();
      expect(listed.items).toHaveLength(1);

      const resolved = await fetch(s.url(`/inbox/${body.item.id}/resolve`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "handled" }),
      });
      expect(resolved.status).toBe(200);
      expect((await resolved.json()).item.resolvedBy).toBe("operator");
      expect((await (await fetch(s.url("/inbox?status=resolved"))).json()).items).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  test("inbox routes inherit loopback Host and Origin confinement", async () => {
    const s = await makeServer({ inboxSend: async () => ({ ok: true, exitCode: 0, error: null }) });
    try {
      const res = await fetch(s.url("/inbox"), {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ kind: "BLOCKED", title: "BLOCKED WM-1: q" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("cross_origin_rejected");
      expect(s.db.query("SELECT COUNT(*) AS n FROM inbox_items").get().n).toBe(0);
    } finally {
      s.close();
    }
  });
});

describe("webhook intake (§14)", () => {
  let s;
  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  test("GET /health", async () => {
    const res = await fetch(s.url("/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.policyVersion).toBe(PV);
    expect(typeof body.env.name).toBe("string"); // environment identity, always present
    expect(body.webhookSecret).toBe("set");
    expect(body.githubWebhookSecret).toBe("set");
  });

  test("unknown route → 404 with an error body", async () => {
    const res = await fetch(s.url("/nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("no route");
  });

  test("valid HMAC → admitted; same delivery again → duplicate", async () => {
    const body = JSON.stringify(envelope({ eventId: "hook-1" }));
    const ts = String(Date.now());
    const headers = {
      "content-type": "application/json",
      "x-factory-timestamp": ts,
      "x-factory-signature": sign(body, ts),
    };

    const first = await fetch(s.url("/events"), { method: "POST", headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ admitted: true, duplicate: false, eventId: "hook-1" });
    expect(s.onEvents).toEqual(["admitted"]);

    const again = await fetch(s.url("/events"), { method: "POST", headers, body });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ admitted: false, duplicate: true, eventId: "hook-1" });
    expect(s.onEvents).toEqual(["admitted"]); // no second wake-up for a duplicate
  });

  test("bad signature → 401 and nothing written", async () => {
    const before = await (await fetch(s.url("/status"))).json();

    const body = JSON.stringify(envelope({ eventId: "hook-forged" }));
    const ts = String(Date.now());
    const res = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": ts,
        "x-factory-signature": sign(body, ts, "wrong-secret"),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");

    const after = await (await fetch(s.url("/status"))).json();
    expect(after).toEqual(before); // nothing admitted beyond the earlier one
    expect(after.events.admitted).toBe(1);
  });

  test("missing signature → 401", async () => {
    const body = JSON.stringify(envelope({ eventId: "hook-unsigned" }));
    const res = await fetch(s.url("/events"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-timestamp": String(Date.now()) },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_signature");
  });

  test("GET /events returns the stored envelope; ?status= filters (webui spec §7)", async () => {
    const { events } = await (await fetch(s.url("/events"))).json();
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("hook-1");
    expect(events[0].status).toBe("admitted");
    expect(events[0].envelope.payload).toEqual({ repos: ["ok"] });
    expect(events[0].repos).toEqual(["ok"]);
    expect(events[0].envelope.eventId).toBe("hook-1");
    expect(events[0].proposalId).toBeNull();
    expect(events[0].runId).toBeNull();

    const filtered = await (await fetch(s.url("/events?status=admitted"))).json();
    expect(filtered.events).toHaveLength(1);
    const none = await (await fetch(s.url("/events?status=dead_lettered"))).json();
    expect(none.events).toEqual([]);
  });

  test("signed webhook and replay cannot forge reserved chain provenance", async () => {
    const forged = envelope({
      eventId: "forged-chain",
      type: "factory.triage-apply.requested",
      source: "chain",
      causationId: "forged-parent-run",
      payload: {
        repo: "factory",
        plan: [{ issueId: "WM-409", action: "label-agent-ready" }],
      },
    });
    const body = JSON.stringify(forged);
    const ts = String(Date.now());
    const webhook = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": ts,
        "x-factory-signature": sign(body, ts),
      },
      body,
    });
    expect(webhook.status).toBe(422);
    expect((await webhook.json()).errors).toContain(
      'source: reserved internal provenance "chain"',
    );

    const replay = await fetch(s.url("/replay"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(replay.status).toBe(422);
    expect((await replay.json()).errors).toContain(
      'source: reserved internal provenance "chain"',
    );

    expect(
      s.db.query(`SELECT COUNT(*) AS n FROM events WHERE event_id = ?`).get(
        forged.eventId,
      ).n,
    ).toBe(0);
    expect(planAdmittedEvents(s.db, registry, { policyVersion: PV })).toEqual({
      planned: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(
      s.db.query(`SELECT COUNT(*) AS n FROM runs WHERE state IN ('APPROVED', 'QUEUED')`).get().n,
    ).toBe(0);
  });

  test("envelope schema failure → 422 with errors, no admission", async () => {
    const body = JSON.stringify({ schemaVersion: "factory.event/v1", eventId: "bad" });
    const ts = String(Date.now());
    const res = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": ts,
        "x-factory-signature": sign(body, ts),
      },
      body,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors.length).toBeGreaterThan(0);
    expect(s.db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(1);
  });
});

describe("missing configured secret fails closed (§14)", () => {
  test("POST /events → 401 missing_secret; /replay still works", async () => {
    const s = await makeServer({ secret: null });
    try {
      const body = JSON.stringify(envelope({ eventId: "no-secret-1" }));
      const ts = String(Date.now());
      const res = await fetch(s.url("/events"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-factory-timestamp": ts,
          "x-factory-signature": sign(body, ts),
        },
        body,
      });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("missing_secret");

      const replayed = await s.client.replay(envelope({ eventId: "no-secret-2" }));
      expect(replayed.admitted).toBe(true);
    } finally {
      s.close();
    }
  });
});

describe("list views carry repos[] (OPS-356)", () => {
  test("GET /events exposes repos from payload; unscoped is []", async () => {
    const s = await makeServer();
    try {
      await s.client.replay(envelope({ eventId: "repos-ok", payload: { repos: ["ok"] } }));
      await s.client.replay(envelope({ eventId: "repos-pin", payload: { repoPin: { repo: "bj29", ref: "develop" } } }));
      await s.client.replay(envelope({ eventId: "repos-none", payload: {} }));
      const { events } = await s.client.events();
      expect(events.find((e) => e.eventId === "repos-ok").repos).toEqual(["ok"]);
      expect(events.find((e) => e.eventId === "repos-pin").repos).toEqual(["bj29"]);
      expect(events.find((e) => e.eventId === "repos-none").repos).toEqual([]);
    } finally {
      s.close();
    }
  });
});

describe("watched flow and operator verbs (§12, §13, §15)", () => {
  let s;
  let flowProposalId;
  let flowRunId;
  const workspaces = mkdtempSync(path.join(os.tmpdir(), "evrt-api-ws-"));
  // event-types.json maps to the "pi" adapter (WM-215); back it with the fake so
  // no real pi process ever spawns in tests.
  const adapters = { pi: fake };
  const workerOpts = () => ({ workspacesRoot: workspaces, owner: "w-test", policyVersion: PV });

  /** Replay + plan one envelope, then return its open proposal via the API. */
  async function planned(eventId) {
    const admitted = await s.client.replay(envelope({ eventId }));
    expect(admitted.admitted).toBe(true);
    planAdmittedEvents(s.db, registry, { policyVersion: PV });
    const { proposals } = await s.client.proposals();
    const mine = proposals.find((p) => p.spec?.idempotencyKey?.includes(eventId));
    expect(mine).toBeTruthy();
    return mine;
  }

  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  test("POST /replay without signature admits (§15 replay verb)", async () => {
    const outcome = await s.client.replay(envelope({ eventId: "flow-1" }));
    expect(outcome).toEqual({ admitted: true, duplicate: false, eventId: "flow-1" });
    expect(s.onEvents).toEqual(["admitted"]);
  });

  test("full watched flow: plan → proposal → approve → QUEUED → runOnce → COMPLETED", async () => {
    expect(planAdmittedEvents(s.db, registry, { policyVersion: PV })).toEqual({
      planned: 1, failed: 0, deadLettered: 0,
    });

    const { proposals } = await s.client.proposals();
    expect(proposals).toHaveLength(1);
    const prop = proposals[0];
    expect(prop.decision).toBe("run");
    expect(prop.expired).toBe(false);
    expect(prop.agent).toBe("factory-status-report@1");
    expect(prop.repos).toEqual(["ok"]);
    expect(prop.spec.adapter).toBe("pi");
    expect(prop.ttl_seconds).toBe(1800);
    flowProposalId = prop.id;

    const approved = await s.client.approve(prop.id);
    expect(approved).toEqual({ approved: true, runId: prop.runId });
    flowRunId = approved.runId;

    const queued = await s.client.run(flowRunId);
    expect(queued.run.state).toBe("QUEUED");

    const summary = await runOnce(s.db, registry, adapters, workerOpts());
    expect(summary.terminalState).toBe("COMPLETED");

    const done = await s.client.run(flowRunId);
    expect(done.run.state).toBe("COMPLETED");
    expect(done.run.spec.agent).toBe("factory-status-report@1");
    expect(done.result.terminalState).toBe("completed");
    expect(done.result.artifactHash).toMatch(/^sha256:/);
    expect(done.receipt.verificationStatus).toBe("passed");
    expect(done.receipt.artifactHash).toBe(done.result.artifactHash);
    expect(done.lifecycle.map((e) => e.to_state)).toEqual([
      "PROPOSED", "APPROVED", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED",
    ]);
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts[0].terminal_state).toBe("COMPLETED");

    const list = await s.client.runs();
    expect(list.runs.map((r) => r.runId)).toContain(flowRunId);
    expect(list.runs[0].agent).toBe("factory-status-report@1");
    expect(list.runs[0].repos).toEqual(["ok"]);
    expect((await s.client.runs("COMPLETED")).runs).toHaveLength(1);
    expect((await s.client.runs("QUEUED")).runs).toHaveLength(0);

    const { events } = await s.client.events("planned");
    expect(events.map((e) => e.eventId)).toContain("flow-1");
    expect(events[0].envelope.type).toBe("factory.status-report.requested");

    const status = await s.client.status();
    expect(status.events).toEqual({ admitted: 0, planned: 1, noop: 0, human_needed: 0, dead_lettered: 0 });
    expect(status.proposals).toEqual({ open: 0, expired: 0 });
    expect(status.runs.byState).toEqual({ COMPLETED: 1 });
    expect(status.anomalies.expiredOpenProposals).toEqual([]);
    expect(status.anomalies.staleLeases).toBe(0);
    expect(status.anomalies.deadLettered).toEqual([]);
    expect(status.anomalies.unpublishedOutbox).toBe(1); // completion event, not yet published
    expect(status.anomalies.ambiguousOpenProposals).toEqual([]);
  });

  test("approve unknown proposal → 404; approve twice → 409", async () => {
    const unknown = await rejection(s.client.approve("prop_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown proposal prop_nope");

    const again = await rejection(s.client.approve(flowProposalId));
    expect(again.status).toBe(409);
    expect(again.message).toContain("not open");
  });

  test("reject an open proposal → run CANCELLED", async () => {
    const prop = await planned("rej-1");
    const rejected = await s.client.reject(prop.id, "not today");
    expect(rejected.rejected).toBe(true);

    const run = await s.client.run(prop.runId);
    expect(run.run.state).toBe("CANCELLED");
    expect(run.lifecycle.at(-1).reason).toBe("proposal_rejected");
    expect(run.lifecycle.at(-1).actor).toBe("operator");

    const rejectAgain = await rejection(s.client.reject(prop.id, "again"));
    expect(rejectAgain.status).toBe(409);
    expect(rejectAgain.message).toContain("not open");
  });

  test("cancel a QUEUED run → 200; cancel again → 409; unknown run → 404", async () => {
    const prop = await planned("can-1");
    const { runId } = await s.client.approve(prop.id);
    expect((await s.client.run(runId)).run.state).toBe("QUEUED");

    expect(await s.client.cancel(runId, "changed my mind")).toEqual({ cancelled: true });
    const view = await s.client.run(runId);
    expect(view.run.state).toBe("CANCELLED");
    expect(view.lifecycle.at(-1).actor).toBe("operator");

    const again = await rejection(s.client.cancel(runId));
    expect(again.status).toBe(409);
    expect(again.message).toContain("illegal transition");

    const unknown = await rejection(s.client.cancel("run_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown run run_nope");
  });

  test("cancel a PROPOSED run closes its open proposal", async () => {
    const prop = await planned("can-proposed-1");
    expect((await s.client.run(prop.runId)).run.state).toBe("PROPOSED");
    expect((await s.client.proposals()).proposals.map((p) => p.id)).toContain(prop.id);

    expect(await s.client.cancel(prop.runId, "never mind")).toEqual({ cancelled: true });
    expect((await s.client.run(prop.runId)).run.state).toBe("CANCELLED");

    const open = await s.client.proposals();
    expect(open.proposals.map((p) => p.id)).not.toContain(prop.id);

    const history = await s.client.proposals("all");
    const decided = history.proposals.find((p) => p.id === prop.id);
    expect(decided.status).toBe("rejected");
    expect(decided.reason).toBe("run_cancelled");
    expect(decided.decided_by).toBe("operator");
  });

  test("cancel with two open proposals still cancels and signals the ambiguity", async () => {
    const prop = await planned("can-ambiguous-1");
    const at = new Date().toISOString();
    s.db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 'run', ?, 1800)`,
    ).run("prop_extra_ambiguous", prop.eventSource, prop.eventId, prop.runId, at);

    try {
      expect(await s.client.cancel(prop.runId, "never mind")).toEqual({
        cancelled: true,
        ambiguousOpenProposals: [{ runId: prop.runId, count: 2 }],
      });
      expect((await s.client.run(prop.runId)).run.state).toBe("CANCELLED");

      const open = await s.client.proposals();
      expect(open.proposals.map((p) => p.id)).toContain(prop.id);
      expect(open.proposals.map((p) => p.id)).toContain("prop_extra_ambiguous");

      const status = await s.client.status();
      expect(status.anomalies.ambiguousOpenProposals).toEqual([
        { runId: prop.runId, count: 2 },
      ]);
    } finally {
      s.db
        .query(`DELETE FROM proposals WHERE id IN (?, ?)`)
        .run(prop.id, "prop_extra_ambiguous");
    }
  });

  test("retry: 404 on unknown run, 409 when attempts are exhausted, queued with force", async () => {
    const prop = await planned("retry-1");
    const { runId } = await s.client.approve(prop.id);
    // Deterministic terminal FAILED: run with an empty adapters map so the
    // spec's "pi" adapter is unknown (no requeue, attempts consumed).
    const summary = await runOnce(s.db, registry, {}, workerOpts());
    expect(summary.runId).toBe(runId);
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("unknown_adapter");

    const exhausted = await rejection(s.client.retry(runId));
    expect(exhausted.status).toBe(409);
    expect(exhausted.message).toBe("attempts_exhausted");

    expect(await s.client.retry(runId, { force: true })).toEqual({ queued: true });
    expect((await s.client.run(runId)).run.state).toBe("QUEUED");
    await s.client.cancel(runId, "test cleanup");

    const unknown = await rejection(s.client.retry("run_nope"));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe("unknown run run_nope");
  });
});

describe("webui surface: proposal linkage, history, journal, outbox, requeue (OPS-212)", () => {
  test("proposals carry their originating event; history filter works; runs list is enriched", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "link-1" }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });

      const { proposals } = await client.proposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0].eventId).toBe("link-1");
      expect(proposals[0].eventSource).toBe("test");

      await client.approve(proposals[0].id);
      await runOnce(db, registry, { pi: fake, fake }, {
        workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
        owner: "test-worker", policyVersion: PV,
      });

      const history = await client.proposals("approved");
      expect(history.proposals).toHaveLength(1);
      expect(history.proposals[0].decided_by).toBe("operator");
      expect((await client.proposals("all")).proposals.length).toBeGreaterThanOrEqual(1);

      const { runs } = await client.runs();
      expect(runs[0].state).toBe("COMPLETED");
      expect(runs[0].reasonCode).toBe("ok");
      expect(runs[0].eventId).toBe("link-1");
      expect(runs[0].adapter).toBe("fake");
      expect(runs[0].maxAttempts).toBe(1);

      const { events } = await client.events();
      expect(events[0].eventId).toBe("link-1");
      expect(events[0].proposalId).toBe(proposals[0].id);
      expect(events[0].runId).toBe(runs[0].runId);
    } finally {
      server.close();
    }
  });

  test("journal feed pages by seq and outbox lists published result events", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "feed-1" }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      await runOnce(db, registry, { pi: fake, fake }, {
        workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
        owner: "test-worker", policyVersion: PV,
      });

      const journal = await client.journal();
      expect(journal.head).toBeGreaterThan(0);
      expect(journal.entries.map((e) => e.to)).toContain("COMPLETED");
      const after = await client.journal({ since: journal.head });
      expect(after.entries).toHaveLength(0);
      expect(after.head).toBe(journal.head);

      const { outbox } = await client.outbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event.type).toBe("factory.status-report.completed");
      expect(outbox[0].published_at).toBeNull(); // no serve loop in this test — sink not run
    } finally {
      server.close();
    }
  });

  test("requeue recovers a dead-lettered event and refuses everything else", async () => {
    const { db, server, port, onEvents } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "dead-1" }));
      db.query(`UPDATE events SET status = 'dead_lettered', plan_failures = 3, last_plan_error = 'boom' WHERE event_id = 'dead-1'`).run();

      expect((await client.requeue("test", "dead-1")).requeued).toBe(true);
      expect(onEvents).toContain("requeued");
      const { events } = await client.events("admitted");
      expect(events.map((e) => e.eventId)).toContain("dead-1");
      expect(events.find((e) => e.eventId === "dead-1").planFailures).toBe(0);

      const again = await rejection(client.requeue("test", "dead-1"));
      expect(again.status).toBe(409); // now admitted — not requeueable
      const missing = await rejection(client.requeue("test", "ghost"));
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("requeueing a human_needed event supersedes its open proposal", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "hn-1", type: "unregistered.event.type" }));
      planAdmittedEvents(db, registry, { policyVersion: PV });
      const before = await client.proposals();
      expect(before.proposals[0].decision).toBe("human_needed");

      await client.requeue("test", "hn-1");
      expect((await client.proposals()).proposals).toHaveLength(0); // superseded, inbox clean
      const superseded = await client.proposals("superseded");
      expect(superseded.proposals[0].eventId).toBe("hn-1");
    } finally {
      server.close();
    }
  });
});

describe("environment identity (webui chip)", () => {
  test("health and status expose the env the server was started with", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-env-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const server = startApi({
      db, registry, secret: SECRET, policyVersion: PV, port: 0,
      env: { name: "dev", home: dir, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const client = apiClient({ port: server.address().port });
    try {
      const health = await client.health();
      expect(health.env).toEqual({ name: "dev", home: dir, adapter: "fake" });
      expect((await client.status()).env.name).toBe("dev");
    } finally {
      server.close();
    }
  });
});

describe("artifact store and agent registry surfacing (OPS-212)", () => {
  test("GET /artifacts catalogues and filters metadata; POST /artifacts/prune dry-runs and applies", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-artifacts-api-"));
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
    ).run("run_catalogue", "idem_catalogue", JSON.stringify({ agent: "catalogue-agent@1" }), "spec-hash", createdAt, createdAt);
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:result', '{}', '{}', ?)`,
    ).run("run_catalogue", JSON.stringify({ artifacts: [
      { kind: "report", sha256: reportHash },
      { kind: "transcript", sha256: transcriptHash },
    ] }), createdAt);

    const server = startApi({
      db, registry, secret: SECRET, policyVersion: PV, port: 0,
      env: { name: "test", home, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const all = await (await fetch(`${base}/artifacts`)).json();
      expect(all.artifacts).toHaveLength(3);
      expect(all.artifacts.find((artifact) => artifact.sha256 === reportHash)).toEqual({
        sha256: reportHash,
        sizeBytes: 6,
        mtime: old.toISOString(),
        referenced: true,
        references: [{
          runId: "run_catalogue",
          kind: "report",
          agent: "catalogue-agent@1",
          state: "COMPLETED",
          createdAt,
        }],
      });
      expect((await (await fetch(`${base}/artifacts?orphan=true`)).json()).artifacts.map((a) => a.sha256)).toEqual([orphanHash]);
      expect((await (await fetch(`${base}/artifacts?orphan=false`)).json()).artifacts).toHaveLength(2);
      expect((await (await fetch(`${base}/artifacts?kind=report`)).json()).artifacts.map((a) => a.sha256)).toEqual([reportHash]);
      expect((await (await fetch(`${base}/artifacts?search=CATALOGUE-AGENT`)).json()).artifacts).toHaveLength(2);
      expect((await (await fetch(`${base}/artifacts?limit=1`)).json()).artifacts).toHaveLength(1);
      expect((await fetch(`${base}/artifacts?orphan=maybe`)).status).toBe(422);
      expect((await fetch(`${base}/artifacts?limit=0`)).status).toBe(422);

      const dry = await fetch(`${base}/artifacts/prune`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      expect(dry.status).toBe(200);
      expect(await dry.json()).toEqual({ deleted: 1, freedBytes: 6, remainingOrphans: 1 });
      expect(existsSync(path.join(store, orphanHash))).toBe(true);

      const apply = await fetch(`${base}/artifacts/prune`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      expect(apply.status).toBe(200);
      expect(await apply.json()).toEqual({ deleted: 1, freedBytes: 6, remainingOrphans: 0 });
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
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-home-"));
    try {
      await client.replay(envelope({ eventId: "art-1", payload: { repos: ["with-artifact"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      const summary = await runOnce(db, registry, { pi: fake, fake }, {
        workspacesRoot: path.join(home, "workspaces"),
        artifactStore: path.join(home, "artifacts"),
        owner: "test-worker", policyVersion: PV,
      });
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
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-home-"));
    const db = openDb(path.join(home, "runtime.db"));
    const server = startApi({
      db, registry, secret: SECRET, policyVersion: PV, port: 0,
      env: { name: "test", home, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const port = server.address().port;
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "art-2", payload: { repos: ["with-artifact"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      await client.approve((await client.proposals()).proposals[0].id);
      const summary = await runOnce(db, registry, { pi: fake, fake }, {
        workspacesRoot: path.join(home, "workspaces"),
        artifactStore: path.join(home, "artifacts"),
        owner: "test-worker", policyVersion: PV,
      });

      const view = await client.run(summary.runId);
      const report = view.result.artifacts.find((a) => a.kind === "report");
      const res = await fetch(`http://127.0.0.1:${port}/artifacts/${report.sha256}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("fake report for with-artifact\n");

      expect(res.headers.get("content-disposition")).toBeNull();

      const named = await fetch(`http://127.0.0.1:${port}/artifacts/${report.sha256}?name=report`);
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

      expect((await fetch(`http://127.0.0.1:${port}/artifacts/${"0".repeat(64)}`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/artifacts/not-a-hash`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  test("GET /runs/:id/trace pages incrementally; 404 unknown; empty for an untraced run (OPS-295)", async () => {
    const { db, server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "trace-1", payload: { repos: ["ok"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      await client.approve((await client.proposals()).proposals[0].id);
      const summary = await runOnce(db, registry, { pi: fake, fake }, {
        workspacesRoot: mkdtempSync(path.join(os.tmpdir(), "evrt-ws-")),
        owner: "test-worker", policyVersion: PV,
      });
      expect(summary.terminalState).toBe("COMPLETED");

      // Page 1: two entries; head already points at the last row for the run.
      const first = await client.trace(summary.runId, { limit: 2 });
      expect(first.entries.map((e) => e.kind)).toEqual(["assistant_text", "tool_use"]);
      expect(first.head).toBeGreaterThan(first.entries.at(-1).seq);

      // Page 2: resume from the last seen seq, get the rest.
      const rest = await client.trace(summary.runId, { since: first.entries.at(-1).seq });
      expect(rest.entries.map((e) => e.kind)).toEqual(["tool_result", "usage"]);
      expect(rest.head).toBe(rest.entries.at(-1).seq);
      expect(rest.entries[0].attempt).toBe(1);
      expect(typeof rest.entries[0].ts).toBe("string");

      // Caught up: since=head → no entries, head unchanged.
      const done = await client.trace(summary.runId, { since: rest.head });
      expect(done).toEqual({ head: rest.head, entries: [] });

      // Unknown run → 404, matching GET /runs/:id.
      const unknown = await rejection(client.trace("run_nope"));
      expect(unknown.status).toBe(404);
      expect(unknown.message).toBe("unknown run run_nope");

      // A run that exists but never traced → head 0, empty entries.
      await client.replay(envelope({ eventId: "trace-2", payload: { repos: ["ok"] } }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      const open = (await client.proposals()).proposals[0];
      const { runId: queuedRun } = await client.approve(open.id);
      expect(await client.trace(queuedRun)).toEqual({ head: 0, entries: [] });
    } finally {
      server.close();
    }
  });

  test("GET /agents exposes definitions, prompt text, schemas, pins, and routing", async () => {
    const { server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      const { agents: defs, contracts } = await client.agents();
      const def = defs.find((d) => d.ref === "factory-status-report@1");
      expect(def.prompt).toContain("factory-status-report@1");
      expect(def.outputSchema.required).toContain("recommendedAction");
      expect(Object.keys(def.pins)).toHaveLength(3);
      expect(def.eventTypes[0].type).toBe("factory.status-report.requested");
      expect(def.mutating).toBe(false);
      // Model-tier routing (WM-135): declared intent plus the per-route
      // resolved value, straight off the committed registry + policy map.
      expect(def.modelTier).toBe("standard");
      expect(def.model).toBeNull();
      expect(def.eventTypes[0].resolvedModel).toBe("openai-codex/gpt-5.6-terra");
      const commandDef = defs.find((d) => d.ref === "reconcile@1");
      expect(commandDef.modelTier).toBeNull();
      expect(commandDef.eventTypes[0].resolvedModel).toBeNull();
      expect(contracts["factory.agent-result/v1"].properties.terminalState.enum).toContain("refused");
    } finally {
      server.close();
    }
  });

  test("GET /repos serves the repos.yaml registry, dispatch mode included (OPS-299)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "evrt-api-repos-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: dispatchable\n    path: ~/Develop/dispatchable\n    github: watt-mind/dispatchable\n    team: CLNT\n    base: develop\n    deploy_branch: master\n    worktree_down: bin/worktree-down.sh\n    worktree_root: ~/Develop/.worktrees/dispatchable\n    max_in_flight: 20\n    merge_ci:\n      workflow: CI\n      required_checks:\n        - Shadow runner fleet available\n        - Verify\n    escalate_paths:\n      - src/auth/**\n  - name: watched\n    path: ~/Develop/watched\n    team: OPS\n    report_only: true\n`,
    );
    const { server, port, close } = await makeServer({ repos: () => loadRepos({ root }) });
    const client = apiClient({ port });
    try {
      const { repos: rows } = await client.repos();
      expect(rows.map((r) => r.name)).toEqual(["dispatchable", "watched"]);
      expect(rows[0]).toEqual({
        name: "dispatchable",
        path: path.join(process.env.HOME ?? "", "Develop/dispatchable"),
        github: "watt-mind/dispatchable",
        team: "CLNT",
        project: null,
        base: "develop",
        deployBranch: "master",
        reportOnly: false,
        maxInFlight: 20,
        smokeDeadlineSeconds: null,
        mergeCi: {
          workflow: "CI",
          requiredChecks: ["Shadow runner fleet available", "Verify"],
        },
        worktreeRoot: path.join(process.env.HOME ?? "", "Develop/.worktrees/dispatchable"),
        hasWorktreeUp: false,
        hasWorktreeDown: true,
        hasWorktreeWarm: false,
        verify: null,
      });
      expect(rows[1]).toMatchObject({ reportOnly: true, maxInFlight: null, mergeCi: null, hasWorktreeDown: false });
      // Merge-policy paths are config, not registry: the wire never carries them.
      expect(JSON.stringify(rows)).not.toContain("src/auth");
    } finally {
      close();
      server.close();
    }
  });

  test("GET /repos names a missing repos.yaml instead of a bare internal_error", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "evrt-api-norepos-"));
    const { server, port, close } = await makeServer({ repos: () => loadRepos({ root: empty }) });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("no repos config at");
      expect(body.error).not.toBe("internal_error");
    } finally {
      close();
      server.close();
    }
  });

  test("GET /repos surfaces malformed repos.yaml as RepoError instead of internal_error (OPS-346)", async () => {
    const malformed = mkdtempSync(path.join(os.tmpdir(), "evrt-api-badrepos-"));
    mkdirSync(path.join(malformed, "config"), { recursive: true });
    writeFileSync(path.join(malformed, "config", "repos.yaml"), "repos: [ invalid: {");
    const { server, port, close } = await makeServer({ repos: () => loadRepos({ root: malformed }) });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("invalid YAML:");
      expect(body.error).not.toBe("internal_error");
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor dry-runs by default and never calls apply (OPS-301)", async () => {
    const calls = [];
    const fixture = new Map([
      ["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }],
    ]);
    const { server, port, close } = await makeServer({
      repos: () => fixture,
      janitor: async (name, opts) => {
        calls.push({ name, apply: opts.apply });
        return { name, reclaimable: [{ id: "OPS-1", state: "Done" }], kept: [], named: [], unknown: [], removed: [], refused: [] };
      },
    });
    const client = apiClient({ port });
    try {
      const body = await client.janitor("dispatchable");
      expect(body.actor).toBe("operator");
      expect(body.apply).toBe(false);
      expect(body.reclaimable).toEqual([{ id: "OPS-1", state: "Done" }]);
      expect(calls).toEqual([{ name: "dispatchable", apply: false }]);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor apply true reaches the injected janitor (OPS-301)", async () => {
    const calls = [];
    const fixture = new Map([
      ["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }],
    ]);
    const { server, port, close } = await makeServer({
      repos: () => fixture,
      janitor: async (name, opts) => {
        calls.push({ name, apply: opts.apply });
        return { name, reclaimable: [{ id: "OPS-1", state: "Done" }], removed: ["OPS-1"], refused: [], kept: [], named: [], unknown: [] };
      },
    });
    const client = apiClient({ port });
    try {
      const body = await client.janitor("dispatchable", { apply: true });
      expect(body.apply).toBe(true);
      expect(body.removed).toEqual(["OPS-1"]);
      expect(calls).toEqual([{ name: "dispatchable", apply: true }]);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor 404s an unknown repo without spawning (OPS-301)", async () => {
    let spawned = false;
    const { server, port, close } = await makeServer({
      repos: () => new Map([["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }]]),
      janitor: async () => {
        spawned = true;
        return {};
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/nope/janitor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown repo nope" });
      expect(spawned).toBe(false);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor apply on report_only without worktree_down is 409 (OPS-301)", async () => {
    let spawned = false;
    const { server, port, close } = await makeServer({
      repos: () => new Map([["watched", { name: "watched", reportOnly: true, worktreeDown: null }]]),
      janitor: async () => {
        spawned = true;
        return {};
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/watched/janitor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/report-only repo "watched" has no worktree_down/);
      expect(spawned).toBe(false);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor rejects a non-boolean apply (OPS-301)", async () => {
    const { server, port, close } = await makeServer({
      repos: () => new Map([["dispatchable", { name: "dispatchable", reportOnly: false, worktreeDown: "bin/worktree-down.sh" }]]),
      janitor: async () => ({}),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/dispatchable/janitor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: "please" }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "apply must be a boolean" });
    } finally {
      close();
      server.close();
    }
  });

  test("janitorArgv never includes --force and adds --apply only when asked (OPS-301)", () => {
    const dry = janitorArgv("bj29");
    expect(dry).toContain("--json");
    expect(dry).toContain("bj29");
    expect(dry).not.toContain("--force");
    expect(dry).not.toContain("--apply");
    const apply = janitorArgv("bj29", { apply: true });
    expect(apply).toContain("--apply");
    expect(apply).not.toContain("--force");
    expect(apply.filter((a) => a === "--apply")).toHaveLength(1);
  });
});

describe("metrics query API (WM-281)", () => {
  let s;
  const metricsNow = Date.parse("2026-08-15T12:00:00.000Z");
  beforeAll(async () => {
    s = await makeServer({ now: () => metricsNow });
    s.db.query(
      `INSERT INTO lifecycle_events
         (run_id, from_state, to_state, actor, attempt, at, record_hash)
       VALUES ('metrics-run', 'VERIFYING', 'COMPLETED', 'test', 1,
               '2026-08-15T11:30:00.000Z', 'metrics-hash')`,
    ).run();
  });
  afterAll(() => s.close());

  test("GET /metrics returns one shared aligned bucket axis", async () => {
    const res = await fetch(s.url("/metrics?window=24h&bucket=1h&series=runs.outcomes,runs.started"));
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

    const oversized = await fetch(s.url("/metrics?window=30d&bucket=15m&series=runs.started"));
    expect(oversized.status).toBe(422);
    expect((await oversized.json()).error).toBe("too_many_buckets");
  });

  test("GET /metrics/breakdown validates dimensions and returns rows", async () => {
    const invalid = await fetch(s.url("/metrics/breakdown?window=24h&by=nope&metric=runs"));
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).validDimensions).toContain("edge");

    const valid = await fetch(s.url("/metrics/breakdown?window=24h&by=agent&metric=runs"));
    expect(valid.status).toBe(200);
    expect((await valid.json()).rows).toEqual([]);
  });
});

describe("Host and Origin header security confinement (OPS-408)", () => {
  let s;
  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  function rawRequest({ host = "127.0.0.1", path = "/", method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: s.port,
          path,
          method,
          headers: { host, ...headers },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode, json, text });
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  test("isLoopbackHost accepts loopback variants and rejects remote/malformed hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:7381")).toBe(true);
    expect(isLoopbackHost("127.0.0.2:7381")).toBe(true);
    expect(isLoopbackHost("0.0.0.0:7381")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost:7381")).toBe(true);
    expect(isLoopbackHost("app.localhost:7381")).toBe(true);
    expect(isLoopbackHost("my-mac.local:7381")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::1]:7381")).toBe(true);

    expect(isLoopbackHost("evil.com")).toBe(false);
    expect(isLoopbackHost("evil.com:7381")).toBe(false);
    expect(isLoopbackHost("192.168.1.100")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  test("isLoopbackOrigin accepts loopback origins and rejects foreign/malformed origins", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:7382")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.2:7382")).toBe(true);
    expect(isLoopbackOrigin("http://0.0.0.0:7382")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:7382")).toBe(true);
    expect(isLoopbackOrigin("http://localhost")).toBe(true);
    expect(isLoopbackOrigin("http://app.localhost:7382")).toBe(true);
    expect(isLoopbackOrigin("http://my-mac.local:7382")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:7382")).toBe(true);

    expect(isLoopbackOrigin("http://evil.com")).toBe(false);
    expect(isLoopbackOrigin("https://evil.com:7382")).toBe(false);
    expect(isLoopbackOrigin("http://192.168.1.100:7382")).toBe(false);
    expect(isLoopbackOrigin("")).toBe(false);
    expect(isLoopbackOrigin(null)).toBe(false);
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin("not-a-valid-url")).toBe(false);
  });

  test("rejects request with non-loopback Host header", async () => {
    const res = await rawRequest({ host: "attacker.com", path: "/health" });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("invalid_host");
  });

  test("new metrics routes inherit Host and Origin confinement", async () => {
    const badHost = await rawRequest({
      host: "attacker.com",
      path: "/metrics?window=24h&bucket=1h&series=runs.outcomes",
    });
    expect(badHost.status).toBe(403);
    expect(badHost.json?.error).toBe("invalid_host");

    const badOrigin = await rawRequest({
      path: "/metrics/breakdown?window=24h&by=agent&metric=runs",
      headers: { origin: "http://evil.com" },
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.json?.error).toBe("cross_origin_rejected");
  });

  test("rejects mutating request carrying a foreign Origin header", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/replay",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.com",
      },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("cross_origin_rejected");
  });

  test("rejects janitor apply carrying a foreign Origin header", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/repos/watched/janitor",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.com",
      },
      body: JSON.stringify({ apply: true }),
    });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("cross_origin_rejected");
  });

  test("allows loopback mutating requests from Web UI Origin header (WM-61)", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/replay",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:7382",
      },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(200);
    expect(res.json?.admitted).toBe(true);
  });

  test("allows normal loopback mutating requests without Origin header", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/replay",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope()),
    });
    expect(res.status).toBe(200);
    expect(res.json?.admitted).toBe(true);
  });
});

describe("serve PID lock (OPS-458)", () => {
  test("acquireServeLock acquires lock in empty runtime home and releaseServeLock removes it", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } = await import("../cli.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-"));
    const lock = acquireServeLock(home, 7381);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(7381);

    const lockFile = serveLockPath(home);
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(lockFile)).toBe(true);
    const data = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(7381);

    releaseServeLock(home);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("acquireServeLock fails when locked by a live process with clear PID and port", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } = await import("../cli.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-"));
    const lockFile = serveLockPath(home);
    const { writeFileSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");

    // Spawn a dummy process to be a live owner
    const sleeper = spawn("sleep", ["60"]);
    try {
      writeFileSync(
        lockFile,
        JSON.stringify({ pid: sleeper.pid, port: 7381, startedAt: new Date().toISOString() }),
        "utf8",
      );
      expect(() => acquireServeLock(home, 7382)).toThrow(/already locked by PID \d+ \(port 7381\)/);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  test("acquireServeLock reclaims a stale lock from a dead process", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } = await import("../cli.mjs");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-"));
    const lockFile = serveLockPath(home);
    const { writeFileSync, readFileSync } = await import("node:fs");

    // Use a PID that does not exist
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: 99999999, port: 7381, startedAt: new Date().toISOString() }),
      "utf8",
    );
    const lock = acquireServeLock(home, 7385);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(7385);
    const data = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(7385);
    releaseServeLock(home);
  });

  test("concurrent duplicate serve on same home fails second instance and releasing first allows next", async () => {
    const { spawn } = await import("node:child_process");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-lock-cli-"));
    const port1 = String(59500 + (process.pid % 200));
    const port2 = String(59700 + (process.pid % 200));
    const CLI = path.resolve(import.meta.dir, "../cli.mjs");

    const serve1 = spawn("bun", [CLI, "serve", "--port", port1], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out1 = "";
    serve1.stdout.on("data", (b) => { out1 += b; });
    serve1.stderr.on("data", (b) => { out1 += b; });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out1.includes("control API on")) {
      await Bun.sleep(100);
    }
    expect(out1).toContain("control API on");

    // Second serve targeting same home should fail immediately
    const serve2 = spawn("bun", [CLI, "serve", "--port", port2], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out2 = "";
    serve2.stdout.on("data", (b) => { out2 += b; });
    serve2.stderr.on("data", (b) => { out2 += b; });
    const exitCode2 = await new Promise((resolve) => serve2.on("exit", resolve));
    expect(exitCode2).not.toBe(0);
    expect(out2).toContain("already locked by PID");

    // Kill serve1
    serve1.kill("SIGTERM");
    await new Promise((resolve) => serve1.on("exit", resolve));

    // Now a third serve should succeed
    const serve3 = spawn("bun", [CLI, "serve", "--port", port2], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out3 = "";
    serve3.stdout.on("data", (b) => { out3 += b; });
    serve3.stderr.on("data", (b) => { out3 += b; });

    const deadline3 = Date.now() + 8000;
    while (Date.now() < deadline3 && !out3.includes("control API on")) {
      await Bun.sleep(100);
    }
    try {
      expect(out3).toContain("control API on");
    } finally {
      serve3.kill("SIGTERM");
      await new Promise((resolve) => serve3.on("exit", resolve));
    }
  });
});

describe("missing FACTORY_EVENT_SECRET and FACTORY_GITHUB_WEBHOOK_SECRET visibility (OPS-457, WM-124)", () => {
  test("GET /health reports webhookSecret and githubWebhookSecret set vs absent", async () => {
    const sWithSecret = await makeServer({ secret: "test-secret", githubSecret: "test-gh-secret" });
    try {
      const res = await fetch(sWithSecret.url("/health"));
      const body = await res.json();
      expect(body.webhookSecret).toBe("set");
      expect(body.githubWebhookSecret).toBe("set");
    } finally {
      sWithSecret.close();
    }

    const sNoSecret = await makeServer({ secret: null, githubSecret: null });
    try {
      const res = await fetch(sNoSecret.url("/health"));
      const body = await res.json();
      expect(body.webhookSecret).toBe("absent");
      expect(body.githubWebhookSecret).toBe("absent");
    } finally {
      sNoSecret.close();
    }
  });

  test("GET /status includes configuration anomaly when secret or githubSecret is absent or policyVersion is unknown", async () => {
    const sNoSecret = await makeServer({ secret: null, githubSecret: "test-gh-secret", policyVersion: "git:abc1234" });
    try {
      const status = await sNoSecret.client.status();
      expect(status.anomalies.configuration).toContain("FACTORY_EVENT_SECRET is unset (webhook intake disabled)");
      expect(status.anomalies.configuration).not.toContain("FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)");
      expect(status.anomalies.configuration).not.toContain("policyVersion is unknown");
    } finally {
      sNoSecret.close();
    }

    const sNoGhSecret = await makeServer({ secret: "test-secret", githubSecret: null, policyVersion: "git:abc1234" });
    try {
      const status = await sNoGhSecret.client.status();
      expect(status.anomalies.configuration).toContain("FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)");
      expect(status.anomalies.configuration).not.toContain("FACTORY_EVENT_SECRET is unset (webhook intake disabled)");
      expect(status.anomalies.configuration).not.toContain("policyVersion is unknown");
    } finally {
      sNoGhSecret.close();
    }

    const sUnknownPv = await makeServer({ secret: "test-secret", githubSecret: "test-gh-secret", policyVersion: "unknown" });
    try {
      const status = await sUnknownPv.client.status();
      expect(status.anomalies.configuration).toContain("policyVersion is unknown");
      expect(status.anomalies.configuration).not.toContain("FACTORY_EVENT_SECRET is unset (webhook intake disabled)");
      expect(status.anomalies.configuration).not.toContain("FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)");
    } finally {
      sUnknownPv.close();
    }

    const sClean = await makeServer({ secret: "test-secret", githubSecret: "test-gh-secret", policyVersion: "git:abc1234" });
    try {
      const status = await sClean.client.status();
      expect(status.anomalies.configuration).toEqual([]);
    } finally {
      sClean.close();
    }
  });

  test("GET /status reports proposalsPilingUp anomaly when open proposals exceed threshold (WM-124)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-piling-test-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const at = new Date().toISOString();

    for (let i = 1; i <= 4; i++) {
      db.query(
        `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, status, envelope_json, payload_hash, admitted_at)
         VALUES ('schedule', ?, 'factory.reconcile.requested', 'reconcile-bj29', ?, ?, 'admitted', ?, 'sha256:h', ?)`,
      ).run(`clock:reconcile-bj29:${i}`, at, at, JSON.stringify({ payload: { loop: "reconcile-bj29" } }), at);
      db.query(
        `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
         VALUES (?, 'schedule', ?, 'run', 'open', ?, 1800)`,
      ).run(`prop-piling-${i}`, `clock:reconcile-bj29:${i}`, at);
    }

    const s = await makeServer({ db, secret: "test-secret", githubSecret: "test-gh-secret" });
    try {
      const status = await s.client.status();
      expect(status.anomalies.proposalsPilingUp).toEqual([
        { loop: "reconcile-bj29", count: 4, threshold: 3 },
      ]);
    } finally {
      s.close();
    }
  });

  test("serve with invalid non-numeric FACTORY_EVENT_PORT fails loudly", async () => {
    const { spawn } = await import("node:child_process");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-port-err-"));
    const CLI = path.resolve(import.meta.dir, "../cli.mjs");

    const child = spawn("bun", [CLI, "serve"], {
      env: { ...process.env, FACTORY_EVENT_HOME: home, FACTORY_EVENT_PORT: "notanumber" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let errOut = "";
    child.stderr.on("data", (b) => { errOut += b; });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).not.toBe(0);
    expect(errOut).toContain('serve: invalid port "notanumber"');
  });

  test("serve startup banner warns when FACTORY_EVENT_SECRET is unset", async () => {
    const { spawn } = await import("node:child_process");
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-banner-"));
    const port = String(59600 + (process.pid % 200));
    const CLI = path.resolve(import.meta.dir, "../cli.mjs");

    const env = { ...process.env, FACTORY_EVENT_HOME: home };
    delete env.FACTORY_EVENT_SECRET;

    const child = spawn("bun", [CLI, "serve", "--port", port], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes("control API on")) {
      await Bun.sleep(100);
    }
    try {
      expect(out).toContain("webhook intake: disabled (FACTORY_EVENT_SECRET is unset");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

describe("status artifact store stats caching (OPS-456)", () => {
  test("GET /status caches storeStats across repeated calls within TTL", async () => {
    let nowMs = 1000000;
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-status-cache-"));
    const s = await makeServer({
      env: { name: "test-env", home, adapter: null },
      now: () => nowMs,
    });
    try {
      // Create an artifact file in the store
      const storeDir = path.join(home, "artifacts");
      mkdirSync(storeDir, { recursive: true });
      const hash1 = "a".repeat(64);
      writeFileSync(path.join(storeDir, hash1), "hello", "utf8");

      const res1 = await fetch(s.url("/status"));
      const body1 = await res1.json();
      expect(body1.artifacts.files).toBe(1);
      expect(body1.artifacts.at).toBe(new Date(nowMs).toISOString());

      // Add another file in the store while within TTL
      nowMs += 2000; // 2 seconds later (within 10s TTL)
      const hash2 = "b".repeat(64);
      writeFileSync(path.join(storeDir, hash2), "world", "utf8");

      const res2 = await fetch(s.url("/status"));
      const body2 = await res2.json();
      // Should still return cached stats from T=1000000 (files: 1, same timestamp)
      expect(body2.artifacts.files).toBe(1);
      expect(body2.artifacts.at).toBe(new Date(1000000).toISOString());

      // Advance time past 10s TTL
      nowMs += 11000;
      const res3 = await fetch(s.url("/status"));
      const body3 = await res3.json();
      // Should now refresh cache and see both files
      expect(body3.artifacts.files).toBe(2);
      expect(body3.artifacts.at).toBe(new Date(nowMs).toISOString());
    } finally {
      s.close();
    }
  });

  test("statusView resolves artifacts root from env.home", async () => {
    const customHome = mkdtempSync(path.join(os.tmpdir(), "evrt-custom-home-"));
    const storeDir = path.join(customHome, "artifacts");
    mkdirSync(storeDir, { recursive: true });
    const hash = "c".repeat(64);
    writeFileSync(path.join(storeDir, hash), "custom-home-content", "utf8");

    const s = await makeServer({
      env: { name: "custom-env", home: customHome, adapter: null },
    });
    try {
      const res = await fetch(s.url("/status"));
      const body = await res.json();
      expect(body.artifacts.files).toBe(1);
      expect(body.artifacts.bytes).toBe(19);
    } finally {
      s.close();
    }
  });
});

describe("POST /schedules/:loop/run (OPS-401)", () => {
  let s;
  beforeAll(async () => {
    s = await makeServer();
  });
  afterAll(() => s.close());

  test("unknown schedule loop returns 404 with registered schedule names", async () => {
    const res = await fetch(s.url("/schedules/nonexistent/run"), { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("unknown schedule");
    expect(Array.isArray(body.schedules)).toBe(true);
    expect(body.schedules).toContain("reaper");
  });

  test("trigger ad-hoc run on registered disabled loop creates open proposal", async () => {
    const res = await fetch(s.url("/schedules/reaper/run"), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admitted).toBe(true);
    expect(body.disabled).toBe(true);
    expect(body.loop).toBe("reaper");
    expect(body.decision).toBe("run");
    expect(typeof body.proposalId).toBe("string");
    expect(body.eventId).toMatch(/^manual:reaper:/);

    // Verify event in DB has source='operator' and correct payload
    const eventRow = s.db
      .query(`SELECT * FROM events WHERE source = 'operator' AND event_id = ?`)
      .get(body.eventId);
    expect(eventRow).toBeDefined();
    expect(eventRow.type).toBe("clock.tick.reaper");
    const payload = JSON.parse(eventRow.envelope_json).payload;
    expect(payload.loop).toBe("reaper");
    expect(payload.cadenceSeconds).toBe(3600);
    expect(payload.skippedSlots).toBe(0);

    // Verify proposal is open (watched approval)
    const proposal = s.db.query(`SELECT * FROM proposals WHERE id = ?`).get(body.proposalId);
    expect(proposal.status).toBe("open");
    expect(proposal.decision).toBe("run");
  });

  test("supports /schedules/:loop/trigger path alias", async () => {
    const res = await fetch(s.url("/schedules/reaper/trigger"), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admitted).toBe(true);
    expect(body.loop).toBe("reaper");
    expect(body.decision).toBe("run");
  });

  test("manual merge trigger propagates selected PR numbers into the immutable event and planned input", async () => {
    const mergeServer = await makeServer();
    try {
      const res = await fetch(mergeServer.url("/schedules/merge-factory/run"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prNumbers: [411, 426] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const event = mergeServer.db
        .query(`SELECT envelope_json FROM events WHERE source = 'operator' AND event_id = ?`)
        .get(body.eventId);
      expect(JSON.parse(event.envelope_json).payload).toMatchObject({
        repo: "factory",
        loop: "merge-factory",
        prNumbers: [411, 426],
      });
      const run = mergeServer.db
        .query(`SELECT spec_json FROM runs WHERE run_id = ?`)
        .get(body.runId);
      expect(JSON.parse(run.spec_json).input.prNumbers).toEqual([411, 426]);
    } finally {
      mergeServer.close();
    }
  });

  test("omitted merge selection preserves all-open behavior", async () => {
    const mergeServer = await makeServer();
    try {
      const res = await fetch(mergeServer.url("/schedules/merge-factory/run"), {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const event = mergeServer.db
        .query(`SELECT envelope_json FROM events WHERE source = 'operator' AND event_id = ?`)
        .get(body.eventId);
      const payload = JSON.parse(event.envelope_json).payload;
      expect(payload.repo).toBe("factory");
      expect(payload).not.toHaveProperty("prNumbers");
    } finally {
      mergeServer.close();
    }
  });

  test("merge selection rejects empty, invalid, duplicate, and arbitrary values before admission", async () => {
    const mergeServer = await makeServer();
    try {
      const invalidBodies = [
        { prNumbers: [] },
        { prNumbers: [0] },
        { prNumbers: [-1] },
        { prNumbers: [1.5] },
        { prNumbers: ["42"] },
        { prNumbers: [42, 42] },
        { prNumbers: 42 },
        { prNumbers: [42], payload: { forged: true } },
      ];
      for (const requestBody of invalidBodies) {
        const before = mergeServer.db.query(`SELECT COUNT(*) AS n FROM events`).get().n;
        const res = await fetch(mergeServer.url("/schedules/merge-factory/run"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        });
        expect(res.status, JSON.stringify(requestBody)).toBe(422);
        expect(mergeServer.db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(before);
      }
    } finally {
      mergeServer.close();
    }
  });

  test("non-merge schedules reject payload overrides instead of forging an event", async () => {
    const overrideServer = await makeServer();
    try {
      const res = await fetch(overrideServer.url("/schedules/reaper/run"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prNumbers: [42] }),
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toContain("does not accept trigger input");
      expect(overrideServer.db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
    } finally {
      overrideServer.close();
    }
  });

  test("two presses produce two distinct events and proposals (no dedup collapse)", async () => {
    const res1 = await fetch(s.url("/schedules/reaper/run"), { method: "POST" });
    const body1 = await res1.json();
    expect(res1.status).toBe(200);

    // Small delay ensures distinct ISO timestamp
    await new Promise((r) => setTimeout(r, 5));

    const res2 = await fetch(s.url("/schedules/reaper/run"), { method: "POST" });
    const body2 = await res2.json();
    expect(res2.status).toBe(200);

    expect(body1.eventId).not.toBe(body2.eventId);
    expect(body1.proposalId).not.toBe(body2.proposalId);
    expect(body2.duplicate).toBe(false);
  });

  test("ad-hoc trigger does not advance lastSlot or nextDue in GET /schedules", async () => {
    const schedRes = await fetch(s.url("/schedules"));
    expect(schedRes.status).toBe(200);
    const { schedules } = await schedRes.json();
    const reaper = schedules.find((sc) => sc.loop === "reaper");
    expect(reaper).toBeDefined();
    expect(reaper.repo).toBeNull();
    expect(schedules.find((sc) => sc.loop === "merge-factory").repo).toBe("factory");
    // lastSlot is still null because ad-hoc runs are source='operator', not 'schedule'
    expect(reaper.lastSlot).toBeNull();
  });

  test("singleton constraint: in-flight run yields typed NOOP (previous_run_in_flight)", async () => {
    // Insert an in-flight run for reaper's agent ('reaper@1')
    const runId = `test-run-${Date.now()}`;
    s.db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
       VALUES (?, ?, 'dummy', ?, 'RUNNING', 1, ?, ?)`,
    ).run(
      runId,
      `idempotency-${runId}`,
      JSON.stringify({ agent: "reaper@1", runId }),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const res = await fetch(s.url("/schedules/reaper/run"), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admitted).toBe(true);
    expect(body.decision).toBe("noop");
    expect(body.reason).toBe("previous_run_in_flight");
  });
});

describe("StatusView and Worker client types pinned to API response (OPS-284)", () => {
  const typesPath = path.resolve(import.meta.dir, "../web/src/types.ts");
  const typesSrc = readFileSync(typesPath, "utf8");

  function extractInterfaceBlock(src, interfaceName) {
    const match = src.match(new RegExp(`export\\s+interface\\s+${interfaceName}\\s*\\{`));
    if (!match) throw new Error(`Interface ${interfaceName} not found in types.ts`);
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (depth > 0 && endIdx < src.length) {
      if (src[endIdx] === "{" || src[endIdx] === "(") depth++;
      else if (src[endIdx] === "}" || src[endIdx] === ")") depth--;
      endIdx++;
    }
    return src.slice(startIdx, endIdx - 1);
  }

  function extractDirectProperties(block) {
    const clean = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const props = [];
    let depth = 0;
    let currentToken = "";
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === "{" || ch === "(" || ch === "<") {
        depth++;
      } else if (ch === "}" || ch === ")" || ch === ">") {
        depth--;
      } else if (ch === ";" && depth === 0) {
        const match = currentToken.trim().match(/^([a-zA-Z0-9_]+)\??\s*:/);
        if (match) props.push(match[1]);
        currentToken = "";
        continue;
      }
      if (depth === 0) currentToken += ch;
    }
    if (currentToken.trim()) {
      const match = currentToken.trim().match(/^([a-zA-Z0-9_]+)\??\s*:/);
      if (match) props.push(match[1]);
    }
    return props;
  }

  function extractNestedBlock(block, propertyName) {
    const match = block.match(new RegExp(`${propertyName}\\s*\\??\\s*:\\s*\\{`));
    if (!match) throw new Error(`Nested property block ${propertyName} not found`);
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (depth > 0 && endIdx < block.length) {
      if (block[endIdx] === "{" || block[endIdx] === "(") depth++;
      else if (block[endIdx] === "}" || block[endIdx] === ")") depth--;
      endIdx++;
    }
    return block.slice(startIdx, endIdx - 1);
  }

  test("GET /status keys and types strictly match StatusView and nested types", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-status-contract-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;

    // 1 live idle worker
    registerWorker(db, { workerId: "w-live-idle", labels: { role: "worker", zone: "a" }, adapters: ["claude"], now: nowMs });
    // 1 live busy worker
    registerWorker(db, { workerId: "w-live-busy", labels: { role: "worker", zone: "b" }, adapters: ["claude"], now: nowMs });
    heartbeat(db, "w-live-busy", { state: "busy", runId: "run-busy-1", now: nowMs });
    // 1 stale worker holding a run (stalled worker projection)
    registerWorker(db, { workerId: "w-stale-busy", labels: { role: "worker" }, adapters: ["claude"], now: nowMs - 120000 });
    heartbeat(db, "w-stale-busy", { state: "busy", runId: "run-stalled-1", now: nowMs - 120000 });
    // 1 stopped worker
    registerWorker(db, { workerId: "w-stopped", labels: { role: "worker" }, adapters: ["claude"], now: nowMs });
    deregisterWorker(db, "w-stopped", { now: nowMs });

    // Ambiguous open proposals on a run
    const atIso = new Date(nowMs).toISOString();
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
       VALUES (?, ?, "dummy", "{}", "QUEUED", 1, ?, ?)`
    ).run("run-ambig-1", "idem-ambig-1", atIso, atIso);
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds, status)
       VALUES (?, "test", "evt-1", "run-ambig-1", "run", ?, 1800, "open")`
    ).run("prop-ambig-1", atIso);
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds, status)
       VALUES (?, "test", "evt-2", "run-ambig-1", "run", ?, 1800, "open")`
    ).run("prop-ambig-2", atIso);

    // Expired open proposal
    db.query(
      `INSERT INTO proposals (id, event_source, event_id, run_id, decision, created_at, ttl_seconds, status)
       VALUES (?, "test", "evt-3", "run-expired-1", "run", ?, 10, "open")`
    ).run("prop-expired-1", new Date(nowMs - 20000).toISOString());

    // Dead lettered event
    db.query(
      `INSERT INTO events (source, event_id, type, subject, status, payload_hash, occurred_at, received_at, correlation_id, plan_failures, last_plan_error, admitted_at, envelope_json)
       VALUES ("test", "evt-dead-1", "test.type", "test", "dead_lettered", "dummy-hash", ?, ?, "corr-1", 3, "failed to plan", ?, "{}")`
    ).run(atIso, atIso, atIso);

    // Proposals piling up for a scheduled loop
    for (let i = 1; i <= 4; i++) {
      db.query(
        `INSERT INTO events (source, event_id, type, subject, status, payload_hash, occurred_at, received_at, admitted_at, envelope_json)
         VALUES ("schedule", ?, "clock.tick.reaper", "reaper", "admitted", "dummy-hash", ?, ?, ?, ?)`,
      ).run(`clock:reaper:${i}`, atIso, atIso, atIso, JSON.stringify({ payload: { loop: "reaper" } }));
      db.query(
        `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
         VALUES (?, "schedule", ?, "run", "open", ?, 1800)`,
      ).run(`prop-piling-reaper-${i}`, `clock:reaper:${i}`, atIso);
    }

    const s = await makeServer({
      db,
      secret: "sec",
      policyVersion: "git:test-pv",
      now: () => nowMs,
    });

    try {
      const res = await fetch(s.url("/status"));
      expect(res.status).toBe(200);
      const status = await res.json();

      // Top-level StatusView keys match. The inbox field is introduced by
      // WM-285; its web type/view lands separately with WM-286.
      const statusViewBlock = extractInterfaceBlock(typesSrc, "StatusView");
      const expectedStatusKeys = [...extractDirectProperties(statusViewBlock), "inbox"].sort();
      expect(Object.keys(status).sort()).toEqual(expectedStatusKeys);
      expect(status.inbox).toEqual({ open: 0, acked: 0, byKind: {} });

      // StatusView.env matches EnvIdentity
      const envIdentityBlock = extractInterfaceBlock(typesSrc, "EnvIdentity");
      const expectedEnvKeys = extractDirectProperties(envIdentityBlock).sort();
      expect(Object.keys(status.env).sort()).toEqual(expectedEnvKeys);
      expect(typeof status.env.name).toBe("string");
      expect(typeof status.env.home).toBe("string");
      expect(status.env.adapter === null || typeof status.env.adapter === "string").toBe(true);

      // StatusView.workers counts match
      const expectedWorkerCountKeys = extractDirectProperties(extractNestedBlock(statusViewBlock, "workers")).sort();
      expect(Object.keys(status.workers).sort()).toEqual(expectedWorkerCountKeys);
      expect(status.workers).toEqual({
        live: 2,
        busy: 1,
        stale: 1,
      });

      // StatusView.anomalies keys match
      const expectedAnomalyKeys = extractDirectProperties(extractNestedBlock(statusViewBlock, "anomalies")).sort();
      expect(Object.keys(status.anomalies).sort()).toEqual(expectedAnomalyKeys);

      // StalledWorker keys and types match
      const expectedStalledWorkerKeys = extractDirectProperties(extractInterfaceBlock(typesSrc, "StalledWorker")).sort();
      expect(status.anomalies.stalledWorkers.length).toBe(1);
      for (const sw of status.anomalies.stalledWorkers) {
        expect(Object.keys(sw).sort()).toEqual(expectedStalledWorkerKeys);
        expect(typeof sw.workerId).toBe("string");
        expect(typeof sw.host).toBe("string");
        expect(typeof sw.runId).toBe("string");
        expect(typeof sw.lastSeen).toBe("string");
      }
      expect(status.anomalies.stalledWorkers[0].workerId).toBe("w-stale-busy");
      expect(status.anomalies.stalledWorkers[0].runId).toBe("run-stalled-1");

      // ambiguousOpenProposals matches [{ runId, count }]
      expect(status.anomalies.ambiguousOpenProposals).toEqual([{ runId: "run-ambig-1", count: 2 }]);
      for (const item of status.anomalies.ambiguousOpenProposals) {
        expect(typeof item.runId).toBe("string");
        expect(typeof item.count).toBe("number");
      }

      // noWorkers is boolean false because live workers exist; the queued run
      // has no placement requirements, so it is not a placement anomaly.
      expect(typeof status.anomalies.noWorkers).toBe("boolean");
      expect(status.anomalies.noWorkers).toBe(false);
      expect(status.anomalies.unmatchedPlacementRuns).toEqual([]);

      // StoppedSchedule keys match if present
      const stoppedSchedBlock = extractInterfaceBlock(typesSrc, "StoppedSchedule");
      const expectedStoppedSchedKeys = extractDirectProperties(stoppedSchedBlock).sort();
      for (const ss of status.anomalies.stoppedSchedules) {
        expect(Object.keys(ss).sort()).toEqual(expectedStoppedSchedKeys);
      }

      // proposalsPilingUp matches ProposalPilingUp
      const pilingBlock = extractInterfaceBlock(typesSrc, "ProposalPilingUp");
      const expectedPilingKeys = extractDirectProperties(pilingBlock).sort();
      expect(status.anomalies.proposalsPilingUp.length).toBe(1);
      for (const p of status.anomalies.proposalsPilingUp) {
        expect(Object.keys(p).sort()).toEqual(expectedPilingKeys);
        expect(typeof p.loop).toBe("string");
        expect(typeof p.count).toBe("number");
        expect(typeof p.threshold).toBe("number");
      }
      expect(status.anomalies.proposalsPilingUp[0]).toEqual({
        loop: "reaper",
        count: 4,
        threshold: 3,
      });

      // Remaining anomaly primitives
      expect(Array.isArray(status.anomalies.configuration)).toBe(true);
      expect(status.anomalies.expiredOpenProposals).toEqual(["prop-expired-1"]);
      expect(typeof status.anomalies.staleLeases).toBe("number");
      expect(typeof status.anomalies.unpublishedOutbox).toBe("number");
      expect(status.anomalies.deadLettered).toEqual([{
        source: "test",
        eventId: "evt-dead-1",
        lastError: "failed to plan",
      }]);
    } finally {
      s.close();
    }
  });

  test("GET /workers keys and types strictly match Worker verbatim", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-workers-contract-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;

    registerWorker(db, { workerId: "w-idle-1", labels: { role: "worker", node: "lab-1" }, adapters: ["claude", "fake"], now: nowMs });
    registerWorker(db, { workerId: "w-busy-1", labels: { role: "worker" }, adapters: ["claude"], now: nowMs });
    heartbeat(db, "w-busy-1", { state: "busy", runId: "run-busy-1", now: nowMs });
    registerWorker(db, { workerId: "w-stale-1", labels: {}, adapters: [], now: nowMs - 120000 });
    registerWorker(db, { workerId: "w-stopped-1", labels: { role: "worker" }, adapters: ["claude"], now: nowMs });
    deregisterWorker(db, "w-stopped-1", { now: nowMs });

    const s = await makeServer({
      db,
      secret: "sec",
      now: () => nowMs,
    });

    try {
      const res = await fetch(s.url("/workers"));
      expect(res.status).toBe(200);
      const { workers } = await res.json();
      expect(workers.length).toBe(4);

      const workerBlock = extractInterfaceBlock(typesSrc, "Worker");
      const expectedWorkerKeys = extractDirectProperties(workerBlock).sort();

      for (const w of workers) {
        expect(Object.keys(w).sort()).toEqual(expectedWorkerKeys);
        expect(typeof w.workerId).toBe("string");
        expect(typeof w.host).toBe("string");
        expect(typeof w.pid).toBe("number");
        expect(typeof w.labels).toBe("object");
        expect(w.labels).not.toBeNull();
        expect(Array.isArray(w.adapters)).toBe(true);
        expect(["idle", "busy", "stopped"]).toContain(w.state);
        expect(w.currentRun === null || typeof w.currentRun === "string").toBe(true);
        expect(typeof w.lastSeen).toBe("string");
        expect(typeof w.stale).toBe("boolean");
        expect(typeof w.startedAt).toBe("string");
        expect(w.stoppedAt === null || typeof w.stoppedAt === "string").toBe(true);
      }

      const idle = workers.find((w) => w.workerId === "w-idle-1");
      expect(idle.labels).toEqual({ role: "worker", node: "lab-1" });
      expect(idle.adapters).toEqual(["claude", "fake"]);
      expect(idle.state).toBe("idle");
      expect(idle.currentRun).toBeNull();
      expect(idle.stale).toBe(false);
      expect(idle.stoppedAt).toBeNull();

      const busy = workers.find((w) => w.workerId === "w-busy-1");
      expect(busy.state).toBe("busy");
      expect(busy.currentRun).toBe("run-busy-1");
      expect(busy.stale).toBe(false);

      const stale = workers.find((w) => w.workerId === "w-stale-1");
      expect(stale.stale).toBe(true);

      const stopped = workers.find((w) => w.workerId === "w-stopped-1");
      expect(stopped.state).toBe("stopped");
      expect(stopped.stoppedAt).not.toBeNull();
    } finally {
      s.close();
    }
  });

  test("noWorkers anomaly transitions to true when QUEUED runs exist and live worker count is 0", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-noworkers-contract-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;
    const atIso = new Date(nowMs).toISOString();

    // 1 queued run
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
       VALUES (?, ?, "dummy", "{}", "QUEUED", 1, ?, ?)`
    ).run("run-queued-1", "idem-queued-1", atIso, atIso);

    // Only stopped or stale workers (live count = 0)
    registerWorker(db, { workerId: "w-stopped", labels: {}, adapters: ["claude"], now: nowMs });
    deregisterWorker(db, "w-stopped", { now: nowMs });
    registerWorker(db, { workerId: "w-stale", labels: {}, adapters: ["claude"], now: nowMs - 120000 });

    const s = await makeServer({
      db,
      secret: "sec",
      now: () => nowMs,
    });

    try {
      const status1 = await s.client.status();
      expect(status1.workers.live).toBe(0);
      expect(status1.runs.byState.QUEUED).toBe(1);
      expect(status1.anomalies.noWorkers).toBe(true);

      // Register a live worker -> noWorkers becomes false
      registerWorker(db, { workerId: "w-live", labels: {}, adapters: ["claude"], now: nowMs });
      const status2 = await s.client.status();
      expect(status2.workers.live).toBe(1);
      expect(status2.anomalies.noWorkers).toBe(false);
    } finally {
      s.close();
    }
  });

  test("GET /status identifies queued runs whose placement matches no active, non-stale worker", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "evrt-unmatched-placement-contract-"));
    const db = openDb(path.join(dir, "runtime.db"));
    const nowMs = 100000000;
    const atIso = new Date(nowMs).toISOString();
    const queue = (runId, placement) => {
      db.query(
        `INSERT INTO runs (run_id, idempotency_key, spec_hash, spec_json, state, attempts, created_at, updated_at)
         VALUES (?, ?, "dummy", ?, "QUEUED", 1, ?, ?)`,
      ).run(runId, `idem-${runId}`, JSON.stringify({ placement }), atIso, atIso);
    };

    queue("run-matched", { node: "lab" });
    queue("run-unmatched", { node: "gpu", class: "heavy" });
    queue("run-unconstrained", undefined);

    registerWorker(db, { workerId: "w-live-lab", labels: { node: "lab" }, adapters: ["claude"], now: nowMs });
    registerWorker(db, { workerId: "w-stale-gpu", labels: { node: "gpu", class: "heavy" }, adapters: ["claude"], now: nowMs - 120000 });
    registerWorker(db, { workerId: "w-stopped-gpu", labels: { node: "gpu", class: "heavy" }, adapters: ["claude"], now: nowMs });
    deregisterWorker(db, "w-stopped-gpu", { now: nowMs });

    const s = await makeServer({ db, secret: "sec", now: () => nowMs });
    try {
      const status1 = await s.client.status();
      expect(status1.workers.live).toBe(1);
      expect(status1.anomalies.noWorkers).toBe(false);
      expect(status1.anomalies.unmatchedPlacementRuns).toEqual([
        { runId: "run-unmatched", placement: { node: "gpu", class: "heavy" } },
      ]);

      registerWorker(db, {
        workerId: "w-live-gpu",
        labels: { node: "gpu", class: "heavy" },
        adapters: ["claude"],
        now: nowMs,
      });
      const status2 = await s.client.status();
      expect(status2.anomalies.unmatchedPlacementRuns).toEqual([]);
    } finally {
      s.close();
    }
  });

  test("a rename on either StatusView/Worker types or API response triggers contract failure", () => {
    // 1. Rename on API response side fails assertion
    const mockApiResponse = {
      stuckWorkers: [{ workerId: "w1", host: "h1", runId: "r1", lastSeen: "t1" }],
      hasNoWorkers: true,
    };
    const expectedKeys = ["noWorkers", "stalledWorkers"].sort();
    expect(() => {
      expect(Object.keys(mockApiResponse).sort()).toEqual(expectedKeys);
    }).toThrow();

    // 2. Rename on types.ts side fails assertion
    const mockRenamedTypesSrc = `
      export interface StatusView {
        anomalies: {
          stuckWorkers: StalledWorker[];
          hasNoWorkers: boolean;
        };
      }
    `;
    const extractedRenamedKeys = extractDirectProperties(
      extractNestedBlock(mockRenamedTypesSrc, "anomalies")
    ).sort();
    const actualApiAnomalies = {
      noWorkers: true,
      stalledWorkers: [],
    };
    expect(() => {
      expect(Object.keys(actualApiAnomalies).sort()).toEqual(extractedRenamedKeys);
    }).toThrow();
  });
});


describe("model surfacing on run views (WM-221)", () => {
  test("reads the claude harness's own init line", () => {
    const head = [
      `{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}`,
      `{"type":"system","subtype":"init","cwd":"/tmp/ws","model":"claude-opus-5[1m]","tools":["Read"]}`,
      `{"type":"assistant","message":{"content":[]}}`,
      ``,
    ].join("\n");
    expect(observedModelFromTranscript(head)).toBe("claude-opus-5[1m]");
  });

  test("rejoins pi's provider so the observed id compares to the pinned one", () => {
    const head = [
      `{"type":"session","version":3,"id":"01a0"}`,
      `{"type":"message_start","message":{"role":"assistant","provider":"openai-codex","model":"gpt-5.6-terra"}}`,
      ``,
    ].join("\n");
    expect(observedModelFromTranscript(head)).toBe("openai-codex/gpt-5.6-terra");
  });

  test("leaves an already-qualified id alone and tolerates a missing provider", () => {
    const qualified = `{"type":"message_start","message":{"provider":"openai-codex","model":"openai-codex/gpt-5.6-luna"}}\n\n`;
    expect(observedModelFromTranscript(qualified)).toBe("openai-codex/gpt-5.6-luna");
    const bare = `{"type":"message_start","message":{"model":"gpt-5.6-luna"}}\n\n`;
    expect(observedModelFromTranscript(bare)).toBe("gpt-5.6-luna");
  });

  test("a transcript that names no model is null, never a guess", () => {
    expect(observedModelFromTranscript("")).toBeNull();
    expect(observedModelFromTranscript(null)).toBeNull();
    // `model` appears, but as prose inside a prompt — not a harness field.
    expect(
      observedModelFromTranscript(`{"type":"user","message":{"content":[{"text":"pick a \\"model\\""}]}}\n\n`),
    ).toBeNull();
  });

  test("survives the partial last line a bounded read always ends on", () => {
    const truncated =
      `{"type":"system","subtype":"init","model":"claude-opus-5[1m]"}\n` +
      `{"type":"assistant","message":{"model":"claude-son`;
    expect(observedModelFromTranscript(truncated)).toBe("claude-opus-5[1m]");
    // The model only appears on the severed line: unparseable, so unknown.
    expect(observedModelFromTranscript(`{"type":"system","subtype":"init","model":"claude-op`)).toBeNull();
  });

  test("the run list carries the plan-time pins and the detail carries observedModel", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-home-"));
    const { db, server, port, close } = await makeServer({ env: { name: "test", home } });
    const client = apiClient({ port });
    try {
      await client.replay(envelope({ eventId: "model-1" }));
      planAdmittedEvents(db, registry, { policyVersion: PV, adapterOverride: "fake" });
      const { proposals } = await client.proposals();
      await client.approve(proposals[0].id);
      const summary = await runOnce(db, registry, { pi: fake, fake }, {
        workspacesRoot: path.join(home, "workspaces"),
        artifactStore: path.join(home, "artifacts"),
        owner: "test-worker", policyVersion: PV,
      });

      const row = (await client.runs()).runs.find((r) => r.runId === summary.runId);
      // Flattened out of the spec so the Model column never reads the run detail.
      expect(row).toHaveProperty("modelTier");
      expect(row).toHaveProperty("model");
      const spec = JSON.parse(db.query(`SELECT spec_json FROM runs WHERE run_id = ?`).get(summary.runId).spec_json);
      expect(row.modelTier).toBe(spec.modelTier ?? null);
      expect(row.model).toBe(spec.model ?? null);

      const view = await client.run(summary.runId);
      // Always present, so the panel distinguishes "not recorded" from an old
      // runtime; the fake adapter's transcript names no model, hence null.
      expect(view).toHaveProperty("observedModel");
      expect(view.observedModel).toBeNull();

      // And the value really comes off the stored bytes: rewrite that same
      // transcript with a harness init line and the next read reports it.
      const transcript = view.result.artifacts.find((a) => a.kind === "transcript");
      expect(transcript).toBeTruthy();
      writeFileSync(
        path.join(home, "artifacts", transcript.sha256),
        `{"type":"system","subtype":"init","model":"claude-opus-5[1m]"}\n`,
        "utf8",
      );
      expect((await client.run(summary.runId)).observedModel).toBe("claude-opus-5[1m]");
    } finally {
      close();
    }
  });
});
