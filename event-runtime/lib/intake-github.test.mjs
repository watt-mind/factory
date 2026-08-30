import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-intake-github-test-mjs";
/**
 * GitHub webhook intake (WM-112): GitHub's raw-body HMAC verified with a
 * dedicated secret, deliveries translated into `factory.event/v1` envelopes
 * at the intake boundary, deduped on the delivery GUID — and the existing
 * factory-envelope path on POST /events byte-for-byte unchanged beside it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import path from "node:path";
import { startApi } from "./api.mjs";
import { openDb } from "./db.mjs";
import {
  githubWebhookSecret,
  translateGitHubEvent,
  verifyGitHubWebhook,
} from "./intake.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const SECRET = "test-factory-secret";
const GH_SECRET = "test-github-secret";
const NOW = Date.parse("2026-08-14T10:30:00Z");
const PV = "git:test-pv";

/** Exactly GitHub's scheme: HMAC-SHA256 hex of the raw body, no timestamp. */
const ghSign = (rawBody, secret = GH_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

/** The factory scheme, for the unchanged-path assertions. */
const factorySign = (rawBody, timestamp, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;

/** Repos as lib/repos.mjs loads them — only the fields translation reads. */
const REPOS = new Map([
  [
    "wt29",
    {
      name: "wt29",
      github: "watt-mind/wt29",
      base: "develop",
      reportOnly: false,
    },
  ],
  [
    "watched",
    {
      name: "watched",
      github: "watt-mind/watched",
      base: "develop",
      reportOnly: true,
    },
  ],
]);

const prPayload = (overrides = {}) => ({
  action: "opened",
  pull_request: {
    number: 7,
    base: { ref: "develop" },
    ...overrides.pull_request,
  },
  repository: { full_name: "watt-mind/wt29" },
  ...overrides,
});

const workflowRunPayload = (overrides = {}) => ({
  action: "completed",
  workflow_run: { id: 12345, conclusion: "failure", ...overrides.workflow_run },
  repository: { full_name: "watt-mind/watched" },
  ...overrides,
});

const translate = (event, payload, overrides = {}) =>
  translateGitHubEvent({
    event,
    deliveryId: "gh-delivery-1",
    payload,
    repos: REPOS,
    now: NOW,
    ...overrides,
  });

describe("verifyGitHubWebhook (WM-112)", () => {
  const rawBody = JSON.stringify(prPayload());

  test("valid signature over the raw body passes", () => {
    expect(
      verifyGitHubWebhook({
        rawBody,
        signature: ghSign(rawBody),
        secret: GH_SECRET,
      }),
    ).toEqual({ ok: true });
  });

  test("wrong secret and tampered body each fail as bad_signature", () => {
    expect(
      verifyGitHubWebhook({
        rawBody,
        signature: ghSign(rawBody, "other"),
        secret: GH_SECRET,
      }),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      verifyGitHubWebhook({
        rawBody: rawBody.replace("wt29", "evil"),
        signature: ghSign(rawBody),
        secret: GH_SECRET,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("missing secret and missing signature fail closed", () => {
    expect(
      verifyGitHubWebhook({
        rawBody,
        signature: ghSign(rawBody),
        secret: null,
      }),
    ).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(verifyGitHubWebhook({ rawBody, secret: GH_SECRET })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  test("malformed signature never throws", () => {
    for (const signature of [
      "nonsense",
      "sha256=",
      "sha256=zzzz",
      "sha1=abc",
    ]) {
      expect(
        verifyGitHubWebhook({ rawBody, signature, secret: GH_SECRET }),
      ).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });

  test("the dedicated secret env is read, never FACTORY_EVENT_SECRET", () => {
    const previous = process.env.FACTORY_GITHUB_WEBHOOK_SECRET;
    delete process.env.FACTORY_GITHUB_WEBHOOK_SECRET;
    expect(githubWebhookSecret()).toBeNull();
    process.env.FACTORY_GITHUB_WEBHOOK_SECRET = "gh-s";
    expect(githubWebhookSecret()).toBe("gh-s");
    if (previous === undefined)
      delete process.env.FACTORY_GITHUB_WEBHOOK_SECRET;
    else process.env.FACTORY_GITHUB_WEBHOOK_SECRET = previous;
  });
});

describe("translateGitHubEvent (WM-112)", () => {
  test("pull_request opened|synchronize|ready_for_review against base → factory.merge.requested {repo}", () => {
    for (const action of ["opened", "synchronize", "ready_for_review"]) {
      const outcome = translate("pull_request", prPayload({ action }));
      expect(outcome.ok).toBe(true);
      expect(outcome.envelope).toEqual({
        schemaVersion: "factory.event/v1",
        eventId: "gh-delivery-1",
        type: "factory.merge.requested",
        source: "github",
        subject: "wt29",
        occurredAt: new Date(NOW).toISOString(),
        correlationId: "gh-delivery-1",
        causationId: null,
        payload: { repo: "wt29" },
      });
    }
  });

  test("other pull_request actions are typed benign refusals", () => {
    for (const action of ["closed", "labeled", "converted_to_draft"]) {
      expect(translate("pull_request", prPayload({ action }))).toEqual({
        ok: false,
        ignored: true,
        reason: "unhandled_action",
      });
    }
  });

  test("draft PR opened or synchronized is ignored as draft_pr; ready_for_review continues (WM-124)", () => {
    expect(
      translate(
        "pull_request",
        prPayload({
          action: "opened",
          pull_request: { base: { ref: "develop" }, draft: true },
        }),
      ),
    ).toEqual({
      ok: false,
      ignored: true,
      reason: "draft_pr",
    });
    expect(
      translate(
        "pull_request",
        prPayload({
          action: "synchronize",
          pull_request: { base: { ref: "develop" }, draft: true },
        }),
      ),
    ).toEqual({
      ok: false,
      ignored: true,
      reason: "draft_pr",
    });
    const ready = translate(
      "pull_request",
      prPayload({
        action: "ready_for_review",
        pull_request: { base: { ref: "develop" }, draft: false },
      }),
    );
    expect(ready.ok).toBe(true);
    expect(ready.envelope.type).toBe("factory.merge.requested");

    const readyEvenIfDraftTrue = translate(
      "pull_request",
      prPayload({
        action: "ready_for_review",
        pull_request: { base: { ref: "develop" }, draft: true },
      }),
    );
    expect(readyEvenIfDraftTrue.ok).toBe(true);
    expect(readyEvenIfDraftTrue.envelope.type).toBe("factory.merge.requested");
  });

  test("a PR not targeting the configured base branch is ignored", () => {
    const payload = prPayload({
      pull_request: { number: 7, base: { ref: "feature/x" } },
    });
    expect(translate("pull_request", payload)).toEqual({
      ok: false,
      ignored: true,
      reason: "not_base_branch",
    });
  });

  test("a report_only repo never yields factory.merge.requested", () => {
    const payload = prPayload({
      repository: { full_name: "watt-mind/watched" },
    });
    expect(translate("pull_request", payload)).toEqual({
      ok: false,
      ignored: true,
      reason: "repo_report_only",
    });
  });

  test("an unconfigured repo is a typed benign refusal on both kinds", () => {
    expect(
      translate(
        "pull_request",
        prPayload({ repository: { full_name: "someone/else" } }),
      ),
    ).toEqual({
      ok: false,
      ignored: true,
      reason: "unconfigured_repo",
    });
    expect(
      translate(
        "workflow_run",
        workflowRunPayload({ repository: { full_name: "someone/else" } }),
      ),
    ).toEqual({
      ok: false,
      ignored: true,
      reason: "unconfigured_repo",
    });
  });

  test("workflow_run completed+failure → the EXISTING github.workflow-run.failed shape, slug not short name", () => {
    const outcome = translate("workflow_run", workflowRunPayload());
    expect(outcome.ok).toBe(true);
    expect(outcome.envelope).toEqual({
      schemaVersion: "factory.event/v1",
      eventId: "gh-delivery-1",
      type: "github.workflow-run.failed",
      source: "github",
      subject: "ci",
      occurredAt: new Date(NOW).toISOString(),
      correlationId: "gh-delivery-1",
      causationId: null,
      // ci-log-capture consumes the owner/name slug (schemas/ci-log-capture.input.json).
      payload: { repo: "watt-mind/watched", runId: 12345 },
    });
    // report_only repos DO get CI-failure events — only merge.requested is withheld.
  });

  test("a successful or in-progress workflow_run is ignored", () => {
    expect(
      translate(
        "workflow_run",
        workflowRunPayload({ workflow_run: { id: 1, conclusion: "success" } }),
      ),
    ).toEqual({
      ok: false,
      ignored: true,
      reason: "unhandled_action",
    });
    expect(
      translate("workflow_run", workflowRunPayload({ action: "requested" })),
    ).toEqual({
      ok: false,
      ignored: true,
      reason: "unhandled_action",
    });
  });

  test("unknown event kinds (ping and friends) are typed benign refusals", () => {
    expect(translate("ping", { zen: "Design for failure." })).toEqual({
      ok: false,
      ignored: true,
      reason: "unhandled_event",
    });
    expect(translate(undefined, prPayload())).toEqual({
      ok: false,
      ignored: true,
      reason: "unhandled_event",
    });
  });

  test("missing delivery id and malformed payloads fail closed, not ignored", () => {
    expect(
      translate("pull_request", prPayload(), { deliveryId: undefined }),
    ).toEqual({
      ok: false,
      ignored: false,
      reason: "missing_delivery_id",
    });
    for (const junk of [null, "string", ["array"]]) {
      expect(translate("pull_request", junk)).toEqual({
        ok: false,
        ignored: false,
        reason: "malformed_payload",
      });
    }
    expect(
      translate("pull_request", {
        action: "opened",
        repository: { full_name: "watt-mind/wt29" },
      }),
    ).toEqual({
      ok: false,
      ignored: false,
      reason: "malformed_payload",
    });
    expect(
      translate(
        "workflow_run",
        workflowRunPayload({ workflow_run: { conclusion: "failure" } }),
      ),
    ).toEqual({ ok: false, ignored: false, reason: "malformed_payload" });
  });
});

describe("POST /github route (WM-112)", () => {
  let s;
  beforeAll(async () => {
    const dir = tmpDir("evrt-gh-api-");
    const db = openDb(path.join(dir, "runtime.db"));
    const onEvents = [];
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      githubSecret: GH_SECRET,
      policyVersion: PV,
      port: 0,
      onEvent: (kind) => onEvents.push(kind),
      repos: () => REPOS,
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const port = server.address().port;
    s = {
      db,
      server,
      onEvents,
      url: (p) => `http://127.0.0.1:${port}${p}`,
      close: () => {
        server.close();
        db.close();
      },
    };
  });
  afterAll(() => s.close());

  const deliver = (
    payload,
    { deliveryId = "d-1", event = "pull_request", signature } = {},
  ) => {
    const body = JSON.stringify(payload);
    return fetch(s.url("/github"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature ?? ghSign(body),
      },
      body,
    });
  };

  test("a valid delivery admits and the SAME delivery id again is a duplicate", async () => {
    const first = await deliver(prPayload(), { deliveryId: "d-admit-1" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      admitted: true,
      duplicate: false,
      eventId: "d-admit-1",
    });
    // Planning runs off the response path (WM-1162), so drain the deferred
    // setImmediate before asserting the wake-up.
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.onEvents).toEqual(["admitted"]);

    const again = await deliver(prPayload(), { deliveryId: "d-admit-1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      admitted: false,
      duplicate: true,
      eventId: "d-admit-1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.onEvents).toEqual(["admitted"]); // dedup planned nothing new

    const row = s.db
      .query(
        `SELECT * FROM events WHERE source = 'github' AND event_id = 'd-admit-1'`,
      )
      .get();
    expect(row.type).toBe("factory.merge.requested");
    expect(JSON.parse(row.envelope_json).payload).toEqual({ repo: "wt29" });
  });

  test("a bad signature is refused before anything is parsed or written", async () => {
    const body = JSON.stringify(prPayload());
    const res = await deliver(prPayload(), {
      deliveryId: "d-bad-sig",
      signature: ghSign(body, "wrong"),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");
    expect(
      s.db
        .query(`SELECT COUNT(*) AS n FROM events WHERE event_id = 'd-bad-sig'`)
        .get().n,
    ).toBe(0);
  });

  test("ignored kinds answer 2xx so GitHub keeps the hook healthy; nothing is written", async () => {
    const res = await deliver(
      { zen: "Keep it logically awesome." },
      { deliveryId: "d-ping", event: "ping" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      admitted: false,
      ignored: true,
      reason: "unhandled_event",
    });
    expect(
      s.db
        .query(`SELECT COUNT(*) AS n FROM events WHERE event_id = 'd-ping'`)
        .get().n,
    ).toBe(0);
  });

  test("a draft PR is 2xx-ignored with reason draft_pr; nothing is admitted (WM-124)", async () => {
    const res = await deliver(prPayload({ pull_request: { draft: true } }), {
      deliveryId: "d-draft",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      admitted: false,
      ignored: true,
      reason: "draft_pr",
    });
    expect(
      s.db
        .query(`SELECT COUNT(*) AS n FROM events WHERE event_id = 'd-draft'`)
        .get().n,
    ).toBe(0);
  });

  test("a report_only repo's PR is 2xx-ignored — merge.requested never admitted", async () => {
    const res = await deliver(
      prPayload({ repository: { full_name: "watt-mind/watched" } }),
      { deliveryId: "d-ro" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      admitted: false,
      ignored: true,
      reason: "repo_report_only",
    });
    expect(
      s.db
        .query(
          `SELECT COUNT(*) AS n FROM events WHERE type = 'factory.merge.requested' AND event_id = 'd-ro'`,
        )
        .get().n,
    ).toBe(0);
  });

  test("a missing delivery id is a 422, per intake's fail-closed convention", async () => {
    const body = JSON.stringify(prPayload());
    const res = await fetch(s.url("/github"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": ghSign(body),
      },
      body,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(["missing_delivery_id"]);
  });

  test("the factory-envelope path is unchanged: /events still wants the factory scheme, not GitHub's", async () => {
    const envelope = {
      schemaVersion: "factory.event/v1",
      eventId: "factory-evt-1",
      type: "factory.status-report.requested",
      source: "operator-webhook",
      subject: "factory",
      occurredAt: new Date().toISOString(),
      correlationId: "factory-evt-1",
      causationId: null,
      payload: { repos: ["wt29"] },
    };
    const body = JSON.stringify(envelope);
    const ts = String(Date.now());

    // The existing fixture behaves exactly as before the GitHub seam landed.
    const ok = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": ts,
        "x-factory-signature": factorySign(body, ts),
      },
      body,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      admitted: true,
      duplicate: false,
      eventId: "factory-evt-1",
    });

    // A GitHub-signed request to /events is refused: two schemes, two paths.
    const cross = await fetch(s.url("/events"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": ghSign(body),
      },
      body,
    });
    expect(cross.status).toBe(401);
    expect((await cross.json()).error).toBe("missing_signature");
  });
});
