import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { openDb } from "./db.mjs";
import {
  admitEvent,
  admitExternalEvent,
  admitSignedEvent,
  githubIntakeView,
  translateGitHubEvent,
  verifyWebhook,
} from "./intake.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const NOW = Date.parse("2026-08-12T10:30:02Z");
const SECRET = "test-secret";

function sign(secret, timestamp, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

function envelope(overrides = {}) {
  return {
    schemaVersion: "factory.event/v1",
    eventId: "delivery-1",
    type: "factory.status-report.requested",
    source: "operator-webhook",
    subject: "factory",
    occurredAt: "2026-08-12T10:30:00Z",
    correlationId: "workflow-01",
    causationId: null,
    payload: { repos: ["bj29"] },
    ...overrides,
  };
}

describe("verifyWebhook", () => {
  const rawBody = JSON.stringify(envelope());

  test("valid signature over epoch-millis timestamp passes", () => {
    const timestamp = String(NOW - 1000);
    const signature = sign(SECRET, timestamp, rawBody);
    expect(
      verifyWebhook({
        rawBody,
        signature,
        timestamp,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  test("valid signature over ISO-8601 timestamp passes", () => {
    const timestamp = new Date(NOW - 1000).toISOString();
    const signature = sign(SECRET, timestamp, rawBody);
    expect(
      verifyWebhook({
        rawBody,
        signature,
        timestamp,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  test("wrong secret fails as bad_signature", () => {
    const timestamp = String(NOW);
    const signature = sign("some-other-secret", timestamp, rawBody);
    expect(
      verifyWebhook({
        rawBody,
        signature,
        timestamp,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("tampered body fails as bad_signature", () => {
    const timestamp = String(NOW);
    const signature = sign(SECRET, timestamp, rawBody);
    const tampered = rawBody.replace("bj29", "evil");
    expect(
      verifyWebhook({
        rawBody: tampered,
        signature,
        timestamp,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("stale timestamp fails, in both directions", () => {
    for (const skewMs of [-10 * 60 * 1000, 10 * 60 * 1000]) {
      const timestamp = String(NOW + skewMs);
      const signature = sign(SECRET, timestamp, rawBody);
      expect(
        verifyWebhook({
          rawBody,
          signature,
          timestamp,
          secret: SECRET,
          now: NOW,
        }),
      ).toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    }
  });

  test("unparseable timestamp fails closed as stale_timestamp", () => {
    const timestamp = "not-a-time";
    const signature = sign(SECRET, timestamp, rawBody);
    expect(
      verifyWebhook({
        rawBody,
        signature,
        timestamp,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  test("missing secret, signature, and timestamp each fail closed", () => {
    const timestamp = String(NOW);
    const signature = sign(SECRET, timestamp, rawBody);
    expect(
      verifyWebhook({ rawBody, signature, timestamp, secret: null, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(
      verifyWebhook({ rawBody, timestamp, secret: SECRET, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "missing_signature",
    });
    expect(
      verifyWebhook({ rawBody, signature, secret: SECRET, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "missing_timestamp",
    });
  });

  test("malformed signature never throws", () => {
    const timestamp = String(NOW);
    for (const signature of ["nonsense", "sha256=", "sha256=zzzz", "md5=abc"]) {
      expect(
        verifyWebhook({
          rawBody,
          signature,
          timestamp,
          secret: SECRET,
          now: NOW,
        }),
      ).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });
});

describe("admitEvent", () => {
  test("valid envelope is admitted once with server-set receivedAt", () => {
    const db = openDb(":memory:");
    const result = admitEvent(
      db,
      registry,
      envelope({ receivedAt: "1999-01-01T00:00:00Z" }),
      { now: NOW },
    );
    expect(result.admitted).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.event.status).toBe("admitted");
    expect(result.event.received_at).toBe(new Date(NOW).toISOString());
    expect(JSON.parse(result.event.envelope_json).receivedAt).toBe(
      new Date(NOW).toISOString(),
    );
    expect(result.event.payload_hash.startsWith("sha256:")).toBe(true);
  });

  test("identical same (source, eventId) retry yields one row and duplicate: true", () => {
    const db = openDb(":memory:");
    const first = admitEvent(db, registry, envelope(), { now: NOW });
    const second = admitEvent(db, registry, envelope(), { now: NOW + 5000 });
    expect(first.admitted).toBe(true);
    expect(second).toEqual({
      admitted: false,
      duplicate: true,
      event: first.event,
    });
    const rows = db.query(`SELECT COUNT(*) AS n FROM events`).get();
    expect(rows.n).toBe(1);
  });

  test("same (source, eventId) with a different payload is a conflict without a write", () => {
    const db = openDb(":memory:");
    const first = admitEvent(db, registry, envelope(), { now: NOW });
    const second = admitEvent(
      db,
      registry,
      envelope({ payload: { repos: ["different"] } }),
      { now: NOW + 5000 },
    );

    expect(first.admitted).toBe(true);
    expect(second).toEqual({
      admitted: false,
      duplicate: false,
      conflict: true,
      errors: ["eventId: already admitted with a different payload"],
    });
    const rows = db.query(`SELECT COUNT(*) AS n FROM events`).get();
    expect(rows.n).toBe(1);
  });

  test("external admission rejects all reserved provenance before persistence", () => {
    for (const source of ["chain", "handoff", "schedule"]) {
      const db = openDb(":memory:");
      const result = admitExternalEvent(
        db,
        registry,
        envelope({ source, causationId: "forged-parent" }),
        { now: NOW },
      );

      expect(result).toEqual({
        admitted: false,
        duplicate: false,
        errors: [`source: reserved internal provenance "${source}"`],
      });
      expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
    }
  });

  test("authenticated signed admission may admit handoff but still rejects chain", () => {
    const db = openDb(":memory:");
    const handoff = admitSignedEvent(
      db,
      registry,
      envelope({ source: "handoff", eventId: "handoff-1" }),
      { now: NOW },
    );
    expect(handoff.admitted).toBe(true);

    const chain = admitSignedEvent(
      db,
      registry,
      envelope({
        source: "chain",
        eventId: "chain-1",
        causationId: "forged-parent",
      }),
      { now: NOW },
    );
    expect(chain).toEqual({
      admitted: false,
      duplicate: false,
      errors: ['source: reserved internal provenance "chain"'],
    });
  });

  test("a signed caller cannot forge schedule provenance to inherit auto-approval (#960)", () => {
    const db = openDb(":memory:");
    // The concrete attack from #960: a holder of the shared event secret posts
    // a merge request wearing the enabled auto-approved loop's provenance.
    const forged = envelope({
      source: "schedule",
      eventId: "clock:merge-factory:2026-08-12T10:30:00.000Z",
      type: "factory.merge.requested",
      payload: { loop: "merge-factory", repo: "factory" },
    });
    expect(admitSignedEvent(db, registry, forged, { now: NOW })).toEqual({
      admitted: false,
      duplicate: false,
      errors: ['source: reserved internal provenance "schedule"'],
    });
    expect(admitExternalEvent(db, registry, forged, { now: NOW })).toEqual({
      admitted: false,
      duplicate: false,
      errors: ['source: reserved internal provenance "schedule"'],
    });
    expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);

    // The in-process scheduler still owns the provenance it writes.
    expect(admitEvent(db, registry, forged, { now: NOW }).admitted).toBe(true);
  });

  test("schema-invalid envelope returns errors and writes no row", () => {
    const db = openDb(":memory:");
    const bad = envelope();
    delete bad.payload;
    const result = admitEvent(db, registry, bad, { now: NOW });
    expect(result.admitted).toBe(false);
    expect(result.duplicate).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
  });

  test("non-object input fails closed without throwing", () => {
    const db = openDb(":memory:");
    for (const junk of [null, "string", 42, ["array"]]) {
      const result = admitEvent(db, registry, junk, { now: NOW });
      expect(result.admitted).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
  });

  test("direct admission refuses clock tick events whose slot is in the future relative to now (OPS-437)", () => {
    const db = openDb(":memory:");
    const futureTick = {
      schemaVersion: "factory.event/v1",
      eventId: "clock:reaper:9999-01-01T00:00:00.000Z",
      type: "clock.tick.reaper",
      source: "schedule",
      subject: "reaper",
      occurredAt: "9999-01-01T00:00:00.000Z",
      correlationId: "clock:reaper:9999-01-01T00:00:00.000Z",
      causationId: null,
      payload: {
        loop: "reaper",
        slot: "9999-01-01T00:00:00.000Z",
        cadenceSeconds: 3600,
        skippedSlots: 0,
      },
    };
    const result = admitEvent(db, registry, futureTick, { now: NOW });
    expect(result.admitted).toBe(false);
    expect(result.duplicate).toBe(false);
    expect(result.errors).toContain(
      "occurredAt: clock tick slot cannot be in the future",
    );
    expect(db.query(`SELECT COUNT(*) AS n FROM events`).get().n).toBe(0);
  });
});

describe("githubIntakeView", () => {
  const STALE_AFTER = 1000;
  function seed(db, admittedAt) {
    db.query(
      `INSERT INTO events (source, event_id, type, subject, occurred_at, received_at,
         correlation_id, causation_id, envelope_json, payload_hash, admitted_at)
       VALUES ('github', 'd-1', 'github.issues.labeled', 'watt-mind/factory',
         ?1, ?1, 'd-1', NULL, '{}', 'hash', ?1)`,
    ).run(admittedAt);
  }

  test("configured intake with no admission is not stale", () => {
    const db = openDb(":memory:");
    expect(
      githubIntakeView(db, {
        nowMs: NOW,
        configured: true,
        staleAfterMs: STALE_AFTER,
      }),
    ).toMatchObject({
      configured: true,
      lastAdmittedAt: null,
      ageMs: null,
      stale: false,
      staleAfterMs: STALE_AFTER,
    });
  });

  test("unconfigured intake is never stale, even with an old admission", () => {
    const db = openDb(":memory:");
    seed(db, new Date(NOW - 10 * STALE_AFTER).toISOString());
    expect(
      githubIntakeView(db, {
        nowMs: NOW,
        configured: false,
        staleAfterMs: STALE_AFTER,
      }),
    ).toMatchObject({ configured: false, stale: false });
  });

  test("stale flips exactly at the >= boundary", () => {
    const db = openDb(":memory:");
    seed(db, new Date(NOW - STALE_AFTER).toISOString());
    const at = githubIntakeView(db, {
      nowMs: NOW,
      configured: true,
      staleAfterMs: STALE_AFTER,
    });
    expect(at).toMatchObject({ ageMs: STALE_AFTER, stale: true });
    const under = githubIntakeView(db, {
      nowMs: NOW - 1,
      configured: true,
      staleAfterMs: STALE_AFTER,
    });
    expect(under).toMatchObject({ ageMs: STALE_AFTER - 1, stale: false });
  });

  test("malformed admitted_at yields a null age and is not stale", () => {
    const db = openDb(":memory:");
    seed(db, "not-a-timestamp");
    expect(
      githubIntakeView(db, {
        nowMs: NOW,
        configured: true,
        staleAfterMs: STALE_AFTER,
      }),
    ).toMatchObject({
      lastAdmittedAt: "not-a-timestamp",
      ageMs: null,
      stale: false,
    });
  });
});

describe("translateGitHubEvent repository slug matching (WM-1803)", () => {
  const repos = new Map([
    [
      "factory",
      {
        name: "factory",
        github: "Watt-Mind/Factory",
        base: "develop",
        reportOnly: false,
      },
    ],
  ]);
  const translate = (event, payload) =>
    translateGitHubEvent({
      event,
      deliveryId: "case-insensitive-delivery",
      payload,
      repos,
      now: NOW,
    });

  test("admits a pull request when the delivered repository slug differs only by case", () => {
    expect(
      translate("pull_request", {
        action: "opened",
        pull_request: { base: { ref: "develop" } },
        repository: { full_name: "watt-mind/factory" },
      }),
    ).toMatchObject({
      ok: true,
      envelope: {
        type: "factory.merge.requested",
        payload: { repo: "factory" },
      },
    });
  });

  test("emits workflow failures with their attempt for mixed-case repository slugs", () => {
    expect(
      translate("workflow_run", {
        action: "completed",
        workflow_run: { id: 1803, run_attempt: 2, conclusion: "failure" },
        repository: { full_name: "wATT-mIND/fACTORY" },
      }),
    ).toMatchObject({
      ok: true,
      envelope: {
        type: "github.workflow-run.failed",
        payload: { repo: "wATT-mIND/fACTORY", runId: 1803, runAttempt: 2 },
      },
    });
  });

  // The run id is what the capture needs; a junk attempt only costs the pin,
  // so the event still admits and ci-log-capture takes its fallback (#2076).
  test("degrades an unusable run_attempt to the no-attempt fallback instead of rejecting", () => {
    for (const run_attempt of [0, -1, 1.5, "2", null, {}]) {
      const outcome = translate("workflow_run", {
        action: "completed",
        workflow_run: { id: 2076, run_attempt, conclusion: "failure" },
        repository: { full_name: "watt-mind/factory" },
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.envelope.payload).toEqual({
        repo: "watt-mind/factory",
        runId: 2076,
      });
    }
  });

  test("keeps empty and non-string repository slugs unconfigured", () => {
    for (const full_name of ["", "   ", null, 1803]) {
      expect(
        translate("pull_request", {
          action: "opened",
          pull_request: { base: { ref: "develop" } },
          repository: { full_name },
        }),
      ).toEqual({
        ok: false,
        ignored: true,
        reason: "unconfigured_repo",
      });
    }
  });
});
