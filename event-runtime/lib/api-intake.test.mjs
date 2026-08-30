import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-intake-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  registerTestProcessCleanup,
  spawnTracked,
} from "./test-helpers-process.mjs";
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

registerTestProcessCleanup(import.meta.url);

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

// WM-1162: planning now runs OFF the response path via setImmediate, so the
// `onEvent("admitted")` wake-up fires after the HTTP response returns. The
// server and these tests share one event loop, so a single setImmediate hop
// (scheduled after the server's, which is enqueued during request handling)
// drains any pending plan signal before we assert on `onEvents`.
const flushPlanning = () => new Promise((resolve) => setImmediate(resolve));

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
    expect(body.githubIntake).toMatchObject({
      configured: true,
      lastAdmittedAt: null,
      ageMs: null,
      stale: false,
      staleAfterMs: 12 * 60 * 60 * 1000,
    });
    expect(body.registry).toMatchObject({
      loadedAt: expect.any(String),
      stamp: null,
      lastReloadError: null,
    });
  });

  test("GET /health exposes the live registry ref state", async () => {
    const state = {
      loadedAt: "2026-08-28T10:00:00.000Z",
      stamp: "files:abc123",
      lastReloadError: { at: "2026-08-28T10:01:00.000Z", message: "bad edges" },
    };
    const current = loadRegistry();
    const live = await makeServer({
      registryRef: { current, state: () => state },
    });
    try {
      const body = await (await fetch(live.url("/health"))).json();
      expect(body.registry).toEqual(state);
    } finally {
      live.close();
    }
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
    await flushPlanning(); // planning is deferred off the response path (WM-1162)
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
    await flushPlanning();
    expect(s.onEvents).toEqual(["admitted"]); // no second wake-up for a duplicate
  });

  test("same event id with a different payload returns payload_mismatch", async () => {
    const isolated = await makeServer();
    try {
      const firstBody = JSON.stringify(
        envelope({ eventId: "hook-payload-mismatch" }),
      );
      const secondBody = JSON.stringify(
        envelope({
          eventId: "hook-payload-mismatch",
          payload: { repos: ["different"] },
        }),
      );
      const timestamp = String(Date.now());
      const headers = (body) => ({
        "content-type": "application/json",
        "x-factory-timestamp": timestamp,
        "x-factory-signature": sign(body, timestamp),
      });

      const first = await fetch(isolated.url("/events"), {
        method: "POST",
        headers: headers(firstBody),
        body: firstBody,
      });
      expect(first.status).toBe(200);

      const mismatch = await fetch(isolated.url("/events"), {
        method: "POST",
        headers: headers(secondBody),
        body: secondBody,
      });
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({
        error: "payload_mismatch",
        eventId: "hook-payload-mismatch",
      });

      const replay = await fetch(isolated.url("/replay"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          envelope({
            eventId: "replay-payload-mismatch",
            payload: { repos: ["first"] },
          }),
        ),
      });
      expect(replay.status).toBe(200);

      const replayMismatch = await fetch(isolated.url("/replay"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          envelope({
            eventId: "replay-payload-mismatch",
            payload: { repos: ["second"] },
          }),
        ),
      });
      expect(replayMismatch.status).toBe(409);
      expect(await replayMismatch.json()).toEqual({
        error: "payload_mismatch",
        eventId: "replay-payload-mismatch",
      });
    } finally {
      isolated.close();
    }
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

  test("signed webhook admits reserved handoff provenance while replay refuses it", async () => {
    const handoff = envelope({
      eventId: "handoff-api-1",
      type: "factory.dispatch.requested",
      source: "handoff",
      subject: "watt-mind/factory#1153",
      payload: { repo: "factory", ticket: "watt-mind/factory#1153" },
    });
    const body = JSON.stringify(handoff);
    const ts = String(Date.now());
    const signed = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": ts,
        "x-factory-signature": sign(body, ts),
      },
      body,
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({
      admitted: true,
      duplicate: false,
      eventId: "handoff-api-1",
    });

    const replay = await fetch(s.url("/replay"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...handoff, eventId: "handoff-api-forged" }),
    });
    expect(replay.status).toBe(422);
    expect((await replay.json()).errors).toContain(
      'source: reserved internal provenance "handoff"',
    );
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
    expect(s.db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(2);
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

describe("GitHub full event-set mapping (WM-1150)", () => {
  const ghSign = (body) =>
    `sha256=${createHmac("sha256", GH_SECRET).update(body).digest("hex")}`;

  async function postEvent(s, event, payload, deliveryId) {
    const body = JSON.stringify(payload);
    return fetch(s.url("/github"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": ghSign(body),
      },
      body,
    });
  }

  const githubEventRow = (s, deliveryId) =>
    s.db
      .query(
        `SELECT type, subject, correlation_id, envelope_json FROM events WHERE source = 'github' AND event_id = ?`,
      )
      .get(deliveryId);

  const openIssue = (overrides = {}) => ({
    action: "labeled",
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "ai:agent-ready" }],
      assignees: [],
      ...overrides.issue,
    },
    repository: { full_name: "watt-mind/factory" },
    ...overrides,
  });

  test("issues → factory.work.requested when the ticket is agent-ready; redelivery is a no-op", async () => {
    const s = await makeServer();
    try {
      const first = await postEvent(s, "issues", openIssue(), "d-issue-ready");
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        admitted: true,
        duplicate: false,
        eventId: "d-issue-ready",
      });
      const row = githubEventRow(s, "d-issue-ready");
      expect(row.type).toBe("factory.work.requested");
      expect(row.subject).toBe("factory");
      expect(JSON.parse(row.envelope_json).payload).toEqual({
        repo: "factory",
      });

      // Same delivery id again → duplicate, no second wake-up.
      await flushPlanning(); // drain the first admit's deferred plan (WM-1162)
      const before = s.onEvents.length;
      const again = await postEvent(s, "issues", openIssue(), "d-issue-ready");
      expect(await again.json()).toEqual({
        admitted: false,
        duplicate: true,
        eventId: "d-issue-ready",
      });
      await flushPlanning();
      expect(s.onEvents.length).toBe(before);
    } finally {
      s.close();
    }
  });

  test("issues irrelevant action (edited) is ignored without error", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "issues",
        openIssue({ action: "edited" }),
        "d-issue-edited",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        admitted: false,
        ignored: true,
        reason: "unhandled_action",
      });
      expect(githubEventRow(s, "d-issue-edited")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("issues that are assigned or unlabeled are not agent-ready → ignored", async () => {
    const s = await makeServer();
    try {
      const assigned = await postEvent(
        s,
        "issues",
        openIssue({
          action: "assigned",
          issue: {
            state: "open",
            labels: [{ name: "ai:agent-ready" }],
            assignees: [{ login: "someone" }],
          },
        }),
        "d-issue-assigned",
      );
      expect((await assigned.json()).reason).toBe("not_agent_ready");

      const unlabeled = await postEvent(
        s,
        "issues",
        openIssue({
          action: "unlabeled",
          issue: { state: "open", labels: [{ name: "bug" }], assignees: [] },
        }),
        "d-issue-unlabeled",
      );
      expect((await unlabeled.json()).reason).toBe("not_agent_ready");
      expect(githubEventRow(s, "d-issue-assigned")).toBeNull();
      expect(githubEventRow(s, "d-issue-unlabeled")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("pull_request reopened → factory.merge.requested scoped to the PR", async () => {
    const s = await makeServer();
    try {
      const payload = {
        action: "reopened",
        pull_request: { number: 314, base: { ref: "develop" }, draft: false },
        repository: { full_name: "watt-mind/factory" },
      };
      const res = await postEvent(s, "pull_request", payload, "d-pr-reopened");
      expect(res.status).toBe(200);
      expect((await res.json()).admitted).toBe(true);
      const row = githubEventRow(s, "d-pr-reopened");
      expect(row.type).toBe("factory.merge.requested");
      expect(JSON.parse(row.envelope_json).payload).toEqual({
        repo: "factory",
        prNumbers: [314],
      });
    } finally {
      s.close();
    }
  });

  test("pull_request opened still flows through the existing mapping (no regression)", async () => {
    const s = await makeServer();
    try {
      const payload = {
        action: "opened",
        pull_request: { number: 5, base: { ref: "develop" }, draft: false },
        repository: { full_name: "watt-mind/factory" },
      };
      const res = await postEvent(s, "pull_request", payload, "d-pr-opened");
      expect((await res.json()).admitted).toBe(true);
      expect(githubEventRow(s, "d-pr-opened").type).toBe(
        "factory.merge.requested",
      );
    } finally {
      s.close();
    }
  });

  test("a draft PR reopened is ignored as draft_pr", async () => {
    const s = await makeServer();
    try {
      const payload = {
        action: "reopened",
        pull_request: { number: 6, base: { ref: "develop" }, draft: true },
        repository: { full_name: "watt-mind/factory" },
      };
      const res = await postEvent(s, "pull_request", payload, "d-pr-draft");
      expect((await res.json()).reason).toBe("draft_pr");
      expect(githubEventRow(s, "d-pr-draft")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("pull_request_review submitted → merge-lane signal for the PR", async () => {
    const s = await makeServer();
    try {
      const payload = {
        action: "submitted",
        review: { state: "approved" },
        pull_request: { number: 271, base: { ref: "develop" } },
        repository: { full_name: "watt-mind/factory" },
      };
      const res = await postEvent(
        s,
        "pull_request_review",
        payload,
        "d-review",
      );
      expect((await res.json()).admitted).toBe(true);
      const row = githubEventRow(s, "d-review");
      expect(row.type).toBe("factory.merge.requested");
      expect(JSON.parse(row.envelope_json).payload).toEqual({
        repo: "factory",
        prNumbers: [271],
      });
    } finally {
      s.close();
    }
  });

  test("pull_request_review dismissed (not submitted) is ignored", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "pull_request_review",
        {
          action: "dismissed",
          pull_request: { number: 8, base: { ref: "develop" } },
          repository: { full_name: "watt-mind/factory" },
        },
        "d-review-dismissed",
      );
      expect((await res.json()).reason).toBe("unhandled_action");
    } finally {
      s.close();
    }
  });

  for (const kind of ["check_run", "check_suite"]) {
    test(`${kind} completed on a PR head → advance merge gating`, async () => {
      const s = await makeServer();
      try {
        const check = {
          status: "completed",
          conclusion: "success",
          pull_requests: [{ number: 99, base: { ref: "develop" } }],
        };
        const payload = {
          action: "completed",
          [kind]: check,
          repository: { full_name: "watt-mind/factory" },
        };
        const res = await postEvent(s, kind, payload, `d-${kind}`);
        expect((await res.json()).admitted).toBe(true);
        const row = githubEventRow(s, `d-${kind}`);
        expect(row.type).toBe("factory.merge.requested");
        expect(JSON.parse(row.envelope_json).payload).toEqual({
          repo: "factory",
          prNumbers: [99],
        });
      } finally {
        s.close();
      }
    });
  }

  test("check_run completed with no PR head on the base is ignored", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "check_run",
        {
          action: "completed",
          check_run: { status: "completed", pull_requests: [] },
          repository: { full_name: "watt-mind/factory" },
        },
        "d-check-nopr",
      );
      expect((await res.json()).reason).toBe("not_pull_request_head");
    } finally {
      s.close();
    }
  });

  test("issue_comment with a @watt-mind-factory mention is recognized as a command stub (handler is Stage 03)", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "issue_comment",
        {
          action: "created",
          comment: { body: "@watt-mind-factory retry ci" },
          issue: { number: 12 },
          repository: { full_name: "watt-mind/factory" },
        },
        "d-comment-cmd",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        admitted: false,
        ignored: true,
        reason: "command_recognized_stub",
      });
      // Nothing is admitted yet — the command handler is a later ticket.
      expect(githubEventRow(s, "d-comment-cmd")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("a comment without the bot mention is ignored as not_a_command", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "pull_request_review_comment",
        {
          action: "created",
          comment: { body: "looks good to me" },
          repository: { full_name: "watt-mind/factory" },
        },
        "d-comment-plain",
      );
      expect((await res.json()).reason).toBe("not_a_command");
    } finally {
      s.close();
    }
  });

  test("push to the base branch → a lightweight base-moved merge re-scan", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "push",
        {
          ref: "refs/heads/develop",
          deleted: false,
          repository: {
            full_name: "watt-mind/factory",
            default_branch: "main",
          },
        },
        "d-push-base",
      );
      expect((await res.json()).admitted).toBe(true);
      const row = githubEventRow(s, "d-push-base");
      expect(row.type).toBe("factory.merge.requested");
      expect(JSON.parse(row.envelope_json).payload).toEqual({
        repo: "factory",
      });
    } finally {
      s.close();
    }
  });

  test("push to a non-base branch is ignored", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "push",
        {
          ref: "refs/heads/feature/x",
          repository: {
            full_name: "watt-mind/factory",
            default_branch: "main",
          },
        },
        "d-push-feature",
      );
      expect((await res.json()).reason).toBe("not_base_branch");
      expect(githubEventRow(s, "d-push-feature")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("POST /webhooks/github is accepted exactly like POST /github (tunnel alias)", async () => {
    const s = await makeServer();
    try {
      const payload = {
        action: "reopened",
        pull_request: { number: 700, base: { ref: "develop" }, draft: false },
        repository: { full_name: "watt-mind/factory" },
      };
      const body = JSON.stringify(payload);
      const post = (path, signature) =>
        fetch(s.url(path), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "pull_request",
            "x-github-delivery": "d-tunnel-alias",
            "x-hub-signature-256": signature ?? ghSign(body),
          },
          body,
        });

      // Signature-verified delivery on the alias path admits the mapped event.
      const ok = await post("/webhooks/github");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        admitted: true,
        duplicate: false,
        eventId: "d-tunnel-alias",
      });
      const row = githubEventRow(s, "d-tunnel-alias");
      expect(row.type).toBe("factory.merge.requested");
      expect(JSON.parse(row.envelope_json).payload).toEqual({
        repo: "factory",
        prNumbers: [700],
      });

      // Same delivery id again → duplicate (shared idempotency with /github).
      const dup = await post("/webhooks/github");
      expect(await dup.json()).toEqual({
        admitted: false,
        duplicate: true,
        eventId: "d-tunnel-alias",
      });

      // A changed redelivery is a conflict, not a validation error. The
      // /github and tunnel-alias routes share this response behavior.
      const changedPayload = {
        ...payload,
        pull_request: { ...payload.pull_request, number: 701 },
      };
      const changedBody = JSON.stringify(changedPayload);
      const conflict = await fetch(s.url("/github"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "d-tunnel-alias",
          "x-hub-signature-256": ghSign(changedBody),
        },
        body: changedBody,
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        error: "payload_mismatch",
        eventId: "d-tunnel-alias",
      });

      // A bad signature still 401s before parsing on the alias path.
      const forged = await fetch(s.url("/webhooks/github"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "d-tunnel-forged",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body,
      });
      expect(forged.status).toBe(401);
      expect(githubEventRow(s, "d-tunnel-forged")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("the /webhooks/github alias stays bearer-exempt when a control token is set (WM-1152)", async () => {
    const s = await makeServer({ controlApiToken: "secret-token" });
    try {
      const payload = {
        action: "reopened",
        pull_request: { number: 701, base: { ref: "develop" }, draft: false },
        repository: { full_name: "watt-mind/factory" },
      };
      const body = JSON.stringify(payload);
      // No Authorization header — GitHub authenticates by HMAC, not a bearer.
      const res = await fetch(s.url("/webhooks/github"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "d-tunnel-token",
          "x-hub-signature-256": ghSign(body),
        },
        body,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).admitted).toBe(true);
    } finally {
      s.close();
    }
  });

  test("an unconfigured repo is a benign 2xx ignore, never a 4xx", async () => {
    const s = await makeServer();
    try {
      const res = await postEvent(
        s,
        "issues",
        openIssue({ repository: { full_name: "watt-mind/not-configured" } }),
        "d-issue-unconfigured",
      );
      expect(res.status).toBe(200);
      expect((await res.json()).reason).toBe("unconfigured_repo");
    } finally {
      s.close();
    }
  });

  test("a bad signature still 401s before any mapping (no regression)", async () => {
    const s = await makeServer();
    try {
      const body = JSON.stringify(openIssue());
      const res = await fetch(s.url("/github"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "d-issue-forged",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body,
      });
      expect(res.status).toBe(401);
      expect(githubEventRow(s, "d-issue-forged")).toBeNull();
    } finally {
      s.close();
    }
  });
});

describe("webhook ack-fast, plan-async (WM-1162)", () => {
  const ghSign = (body) =>
    `sha256=${createHmac("sha256", GH_SECRET).update(body).digest("hex")}`;

  const agentReadyIssue = () => ({
    action: "labeled",
    issue: {
      number: 1162,
      state: "open",
      labels: [{ name: "ai:agent-ready" }],
      assignees: [],
    },
    repository: { full_name: "watt-mind/factory" },
  });

  const postGitHub = (s, event, payload, deliveryId, sig) => {
    const body = JSON.stringify(payload);
    return fetch(s.url("/webhooks/github"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": sig ?? ghSign(body),
      },
      body,
    });
  };

  // A planner stub standing in for serve's blocking `loopTick`: it records when
  // planning starts and, after an async sleep, when it finishes. If the handler
  // (wrongly) awaited planning before responding, the response would be delayed
  // by SLEEP_MS; the assertions prove it is not.
  const SLEEP_MS = 500;
  function sleepingPlanner() {
    const marks = { startedAt: null, finishedAt: null, calls: 0 };
    return {
      marks,
      onEvent: (kind) => {
        marks.calls += 1;
        marks.startedAt = Date.now();
        setTimeout(() => {
          marks.finishedAt = Date.now();
        }, SLEEP_MS);
      },
    };
  }

  test("a signed webhook returns 2xx before the sleeping planner completes, then plans", async () => {
    const planner = sleepingPlanner();
    const s = await makeServer({ onEvent: planner.onEvent });
    try {
      const started = Date.now();
      const res = await postGitHub(
        s,
        "issues",
        agentReadyIssue(),
        "d-1162-ack",
      );
      const ackMs = Date.now() - started;

      // Ack is fast and the slow planner has NOT finished on the response path.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        admitted: true,
        duplicate: false,
        eventId: "d-1162-ack",
      });
      expect(planner.marks.finishedAt).toBeNull();
      expect(ackMs).toBeLessThan(SLEEP_MS);

      // The event is persisted (admitted) regardless of planning timing.
      const row = s.db
        .query(
          `SELECT type FROM events WHERE source = 'github' AND event_id = ?`,
        )
        .get("d-1162-ack");
      expect(row.type).toBe("factory.work.requested");

      // Planning runs after the response is sent (off the response path).
      await flushPlanning();
      expect(planner.marks.startedAt).not.toBeNull();
      expect(planner.marks.calls).toBe(1);
    } finally {
      s.close();
    }
  });

  test("/health stays responsive while a webhook is being processed", async () => {
    const planner = sleepingPlanner();
    const s = await makeServer({ onEvent: planner.onEvent });
    try {
      // Fire the webhook and a liveness probe without awaiting the webhook first.
      const webhook = postGitHub(s, "issues", agentReadyIssue(), "d-1162-live");
      const health = fetch(s.url("/health"));
      const [wres, hres] = await Promise.all([webhook, health]);
      expect(wres.status).toBe(200);
      expect(hres.status).toBe(200);
      expect((await hres.json()).ok).toBe(true);
      // Both responses came back before the slow planner could finish.
      expect(planner.marks.finishedAt).toBeNull();
    } finally {
      s.close();
    }
  });

  test("bad GitHub signature → 401 and planning is never scheduled (unchanged)", async () => {
    const planner = sleepingPlanner();
    const s = await makeServer({ onEvent: planner.onEvent });
    try {
      const res = await postGitHub(
        s,
        "issues",
        agentReadyIssue(),
        "d-1162-badsig",
        "sha256=deadbeef",
      );
      expect(res.status).toBe(401);
      await flushPlanning();
      expect(planner.marks.calls).toBe(0);
      const row = s.db
        .query(
          `SELECT type FROM events WHERE source = 'github' AND event_id = ?`,
        )
        .get("d-1162-badsig");
      expect(row).toBeNull();
    } finally {
      s.close();
    }
  });

  test("a duplicate delivery short-circuits to 2xx and schedules no second plan", async () => {
    const planner = sleepingPlanner();
    const s = await makeServer({ onEvent: planner.onEvent });
    try {
      const first = await postGitHub(
        s,
        "issues",
        agentReadyIssue(),
        "d-1162-dupe",
      );
      expect((await first.json()).admitted).toBe(true);
      await flushPlanning();
      expect(planner.marks.calls).toBe(1);

      const again = await postGitHub(
        s,
        "issues",
        agentReadyIssue(),
        "d-1162-dupe",
      );
      expect(await again.json()).toEqual({
        admitted: false,
        duplicate: true,
        eventId: "d-1162-dupe",
      });
      await flushPlanning();
      expect(planner.marks.calls).toBe(1); // no second wake-up for a duplicate
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
      expect(body.githubIntake.configured).toBe(true);
    } finally {
      sWithSecret.close();
    }

    const sNoSecret = await makeServer({ secret: null, githubSecret: null });
    try {
      const res = await fetch(sNoSecret.url("/health"));
      const body = await res.json();
      expect(body.webhookSecret).toBe("absent");
      expect(body.githubWebhookSecret).toBe("absent");
      expect(body.githubIntake).toMatchObject({
        configured: false,
        lastAdmittedAt: null,
        ageMs: null,
        stale: false,
      });
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

  test("GitHub admission refreshes health; refused signatures increment its counter", async () => {
    let nowMs = Date.parse("2026-08-30T08:00:00.000Z");
    const s = await makeServer({ now: () => nowMs });
    try {
      const payload = JSON.stringify({
        action: "labeled",
        issue: {
          labels: ["ai:agent-ready"],
          assignees: [],
          state: "open",
        },
        repository: { full_name: "watt-mind/factory" },
      });
      const admitted = await fetch(s.url("/github"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "freshness-delivery",
          "x-hub-signature-256": `sha256=${createHmac("sha256", GH_SECRET)
            .update(payload)
            .digest("hex")}`,
        },
        body: payload,
      });
      expect((await admitted.json()).admitted).toBe(true);

      nowMs += 90_000;
      const fresh = await (await fetch(s.url("/health"))).json();
      expect(fresh.githubIntake).toMatchObject({
        lastAdmittedAt: "2026-08-30T08:00:00.000Z",
        ageMs: 90_000,
        stale: false,
      });

      const before = fresh.githubIntake.rejected;
      const refused = await fetch(s.url("/github"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "refused-delivery",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body: payload,
      });
      expect(refused.status).toBe(401);
      const rejected = await (await fetch(s.url("/health"))).json();
      expect(rejected.githubIntake.rejected).toBe(before + 1);
      expect(rejected.githubIntake.lastAdmittedAt).toBe(
        "2026-08-30T08:00:00.000Z",
      );

      nowMs += 12 * 60 * 60 * 1000;
      const stale = await s.client.status();
      expect(stale.anomalies.configuration).toContain(
        "GitHub webhook intake is stale (last admission was 43290000ms ago; threshold 43200000ms)",
      );
    } finally {
      s.close();
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
