import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-intake-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { spawnTracked } from "./test-helpers-process.mjs";
import { freePort, loadAdjustedTimeout } from "./test-helpers-timing.mjs";
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

    const first = await fetch(s.url("/events"), {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      admitted: true,
      duplicate: false,
      eventId: "hook-1",
    });
    expect(s.onEvents).toEqual(["admitted"]);

    const again = await fetch(s.url("/events"), {
      method: "POST",
      headers,
      body,
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      admitted: false,
      duplicate: true,
      eventId: "hook-1",
    });
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
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": String(Date.now()),
      },
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

    const filtered = await (
      await fetch(s.url("/events?status=admitted"))
    ).json();
    expect(filtered.events).toHaveLength(1);
    const none = await (
      await fetch(s.url("/events?status=dead_lettered"))
    ).json();
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
      s.db
        .query(`SELECT COUNT(*) AS n FROM events WHERE event_id = ?`)
        .get(forged.eventId).n,
    ).toBe(0);
    expect(planAdmittedEvents(s.db, registry, { policyVersion: PV })).toEqual({
      planned: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(
      s.db
        .query(
          `SELECT COUNT(*) AS n FROM runs WHERE state IN ('APPROVED', 'QUEUED')`,
        )
        .get().n,
    ).toBe(0);
  });

  test("envelope schema failure → 422 with errors, no admission", async () => {
    const body = JSON.stringify({
      schemaVersion: "factory.event/v1",
      eventId: "bad",
    });
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

describe("GitHub workflow_run merge trigger (WM-576)", () => {
  const ghSign = (body) =>
    `sha256=${createHmac("sha256", GH_SECRET).update(body).digest("hex")}`;

  async function postWorkflow(s, payload, deliveryId) {
    const body = JSON.stringify(payload);
    return fetch(s.url("/github"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": ghSign(body),
      },
      body,
    });
  }

  test("successful pull-request workflow admits one scoped merge request per PR head SHA", async () => {
    const s = await makeServer();
    const headSha = "a".repeat(40);
    const payload = {
      action: "completed",
      workflow_run: {
        id: 57601,
        event: "pull_request",
        conclusion: "success",
        head_sha: headSha,
        pull_requests: [
          { number: 576, head: { sha: headSha }, base: { ref: "develop" } },
        ],
      },
      repository: { full_name: "watt-mind/factory" },
    };

    try {
      const first = await postWorkflow(s, payload, "delivery-green-1");
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        admitted: true,
        duplicate: false,
        eventId: `merge-pr:factory:576:${headSha}`,
      });

      const redelivery = await postWorkflow(s, payload, "delivery-green-2");
      expect(redelivery.status).toBe(200);
      expect(await redelivery.json()).toEqual({
        admitted: false,
        duplicate: true,
        eventId: `merge-pr:factory:576:${headSha}`,
      });

      const event = s.db
        .query(
          `SELECT type,correlation_id,envelope_json FROM events WHERE source = 'github'`,
        )
        .get();
      expect(event.type).toBe("factory.merge.requested");
      expect(event.correlation_id).toBe(`merge-pr:factory:576:${headSha}`);
      expect(JSON.parse(event.envelope_json).payload).toEqual({
        repo: "factory",
        prNumbers: [576],
      });
      expect(
        registry.eventTypes["factory.merge.requested"].idempotencyScope,
      ).toEqual(["correlationId", "inputHash"]);
    } finally {
      s.close();
    }
  });

  test("failed workflow runs retain the ci-log-capture event mapping", async () => {
    const s = await makeServer();
    try {
      const response = await postWorkflow(
        s,
        {
          action: "completed",
          workflow_run: { id: 57602, conclusion: "failure" },
          repository: { full_name: "watt-mind/factory" },
        },
        "delivery-failed-1",
      );
      expect(response.status).toBe(200);
      expect((await response.json()).admitted).toBe(true);
      const event = s.db
        .query(`SELECT type,envelope_json FROM events WHERE source = 'github'`)
        .get();
      expect(event.type).toBe("github.workflow-run.failed");
      expect(JSON.parse(event.envelope_json).payload).toEqual({
        repo: "watt-mind/factory",
        runId: 57602,
      });
    } finally {
      s.close();
    }
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

      const replayed = await s.client.replay(
        envelope({ eventId: "no-secret-2" }),
      );
      expect(replayed.admitted).toBe(true);
    } finally {
      s.close();
    }
  });
});

describe("missing FACTORY_EVENT_SECRET and FACTORY_GITHUB_WEBHOOK_SECRET visibility (OPS-457, WM-124)", () => {
  test("GET /health reports webhookSecret and githubWebhookSecret set vs absent", async () => {
    const sWithSecret = await makeServer({
      secret: "test-secret",
      githubSecret: "test-gh-secret",
    });
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
    const sNoSecret = await makeServer({
      secret: null,
      githubSecret: "test-gh-secret",
      policyVersion: "git:abc1234",
    });
    try {
      const status = await sNoSecret.client.status();
      expect(status.anomalies.configuration).toContain(
        "FACTORY_EVENT_SECRET is unset (webhook intake disabled)",
      );
      expect(status.anomalies.configuration).not.toContain(
        "FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)",
      );
      expect(status.anomalies.configuration).not.toContain(
        "policyVersion is unknown",
      );
    } finally {
      sNoSecret.close();
    }

    const sNoGhSecret = await makeServer({
      secret: "test-secret",
      githubSecret: null,
      policyVersion: "git:abc1234",
    });
    try {
      const status = await sNoGhSecret.client.status();
      expect(status.anomalies.configuration).toContain(
        "FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)",
      );
      expect(status.anomalies.configuration).not.toContain(
        "FACTORY_EVENT_SECRET is unset (webhook intake disabled)",
      );
      expect(status.anomalies.configuration).not.toContain(
        "policyVersion is unknown",
      );
    } finally {
      sNoGhSecret.close();
    }

    const sUnknownPv = await makeServer({
      secret: "test-secret",
      githubSecret: "test-gh-secret",
      policyVersion: "unknown",
    });
    try {
      const status = await sUnknownPv.client.status();
      expect(status.anomalies.configuration).toContain(
        "policyVersion is unknown",
      );
      expect(status.anomalies.configuration).not.toContain(
        "FACTORY_EVENT_SECRET is unset (webhook intake disabled)",
      );
      expect(status.anomalies.configuration).not.toContain(
        "FACTORY_GITHUB_WEBHOOK_SECRET is unset (GitHub webhook intake disabled)",
      );
    } finally {
      sUnknownPv.close();
    }

    const sClean = await makeServer({
      secret: "test-secret",
      githubSecret: "test-gh-secret",
      policyVersion: "git:abc1234",
    });
    try {
      const status = await sClean.client.status();
      expect(status.anomalies.configuration).toEqual([]);
    } finally {
      sClean.close();
    }
  });

  test("GET /status reports proposalsPilingUp anomaly when open proposals exceed threshold (WM-124)", async () => {
    const dir = tmpDir("evrt-piling-test-");
    const db = openDb(path.join(dir, "runtime.db"));
    const at = new Date().toISOString();

    for (let i = 1; i <= 4; i++) {
      db.query(
        `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at, status, envelope_json, payload_hash, admitted_at)
         VALUES ('schedule', ?, 'factory.reconcile.requested', 'reconcile-bj29', ?, ?, 'admitted', ?, 'sha256:h', ?)`,
      ).run(
        `clock:reconcile-bj29:${i}`,
        at,
        at,
        JSON.stringify({ payload: { loop: "reconcile-bj29" } }),
        at,
      );
      db.query(
        `INSERT INTO proposals (id, event_source, event_id, decision, status, created_at, ttl_seconds)
         VALUES (?, 'schedule', ?, 'run', 'open', ?, 1800)`,
      ).run(`prop-piling-${i}`, `clock:reconcile-bj29:${i}`, at);
    }

    const s = await makeServer({
      db,
      secret: "test-secret",
      githubSecret: "test-gh-secret",
    });
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
    const home = tmpDir("evrt-port-err-");
    const CLI = path.resolve(import.meta.dir, "../cli.mjs");

    const child = spawnTracked("bun", [CLI, "serve"], {
      env: {
        ...process.env,
        FACTORY_EVENT_HOME: home,
        FACTORY_EVENT_PORT: "notanumber",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let errOut = "";
    child.stderr.on("data", (b) => {
      errOut += b;
    });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).not.toBe(0);
    expect(errOut).toContain('serve: invalid port "notanumber"');
  });

  test("serve startup banner warns when FACTORY_EVENT_SECRET is unset", async () => {
    const home = tmpDir("evrt-banner-");
    const port = freePort();
    const CLI = path.resolve(import.meta.dir, "../cli.mjs");

    const env = { ...process.env, FACTORY_EVENT_HOME: home };
    delete env.FACTORY_EVENT_SECRET;

    const child = spawnTracked("bun", [CLI, "serve", "--port", port], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });

    const deadline = Date.now() + loadAdjustedTimeout(8000);
    while (Date.now() < deadline && !out.includes("control API on")) {
      await Bun.sleep(100);
    }
    try {
      expect(out).toContain(
        "webhook intake: disabled (FACTORY_EVENT_SECRET is unset",
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
