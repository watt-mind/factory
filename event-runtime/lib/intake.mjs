/**
 * Authenticated event intake (docs/event-runtime.md §5.1, §14).
 *
 * The webhook boundary is the runtime's outermost trust surface, so every
 * function here fails closed: a missing secret, missing header, stale
 * timestamp, or malformed anything is a typed refusal, never an exception and
 * never an admission. Verification runs over the raw body bytes before
 * parsing, and admission dedupes on (source, eventId) so an at-least-once
 * delivery can only ever produce one admitted row — a retry gets the original
 * record back. GitHub deliveries are verified with GitHub's own signature
 * scheme and translated into `factory.event/v1` envelopes at this same
 * boundary (WM-112); the factory-envelope path is untouched by that seam.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, hashJson } from "./canonical.mjs";
import { TIMESTAMP_TOLERANCE_MS } from "./config.mjs";
import { tx, txImmediate } from "./db.mjs";
import { validate } from "./schema.mjs";

/** ISO-8601 or epoch-millis string → epoch millis, or null when unparseable. */
function parseTimestamp(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Verify `signature` = "sha256=<hex>" where <hex> is
 * HMAC-SHA256(secret, `${timestamp}.${rawBody}`). Fail closed on anything
 * missing or malformed; never throws on bad input.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyWebhook({
  rawBody,
  signature,
  timestamp,
  secret,
  now = Date.now(),
  toleranceMs = TIMESTAMP_TOLERANCE_MS,
}) {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!signature || typeof signature !== "string")
    return { ok: false, reason: "missing_signature" };
  if (timestamp === undefined || timestamp === null || timestamp === "") {
    return { ok: false, reason: "missing_timestamp" };
  }
  const timestampString = String(timestamp);
  const ts = parseTimestamp(timestampString);
  if (ts === null || Math.abs(now - ts) > toleranceMs)
    return { ok: false, reason: "stale_timestamp" };
  if (!signature.startsWith("sha256="))
    return { ok: false, reason: "bad_signature" };
  try {
    const presented = Buffer.from(
      signature.slice("sha256=".length).toLowerCase(),
      "utf8",
    );
    const expected = Buffer.from(
      createHmac("sha256", secret)
        .update(`${timestampString}.`)
        .update(rawBody ?? "")
        .digest("hex"),
      "utf8",
    );
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * Dedicated secret for GitHub webhook deliveries (WM-112). Deliberately not
 * FACTORY_EVENT_SECRET: GitHub signs raw-body-only with its own scheme, and
 * sharing one secret across two signature schemes would let a capture from
 * the weaker scheme (no signed timestamp) be replayed against the stronger
 * one. Absent secret means GitHub intake is disabled, like the factory path.
 */
export function githubWebhookSecret() {
  return process.env.FACTORY_GITHUB_WEBHOOK_SECRET || null;
}

/**
 * Verify GitHub's `X-Hub-Signature-256: sha256=<hex>` where <hex> is
 * HMAC-SHA256(secret, rawBody) — GitHub's scheme, which signs no timestamp.
 * Replay is bounded by delivery-ID dedup at admission instead (WM-112).
 * Fail closed on anything missing or malformed; never throws on bad input.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyGitHubWebhook({ rawBody, signature, secret }) {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!signature || typeof signature !== "string")
    return { ok: false, reason: "missing_signature" };
  if (!signature.startsWith("sha256="))
    return { ok: false, reason: "bad_signature" };
  try {
    const presented = Buffer.from(
      signature.slice("sha256=".length).toLowerCase(),
      "utf8",
    );
    const expected = Buffer.from(
      createHmac("sha256", secret)
        .update(rawBody ?? "")
        .digest("hex"),
      "utf8",
    );
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/** PR lifecycle moments that mean "the merge queue may have changed" (WM-112). */
const PR_ACTIONS = ["opened", "synchronize", "ready_for_review"];

/** The repos.yaml entry whose `github` slug matches, or null when unconfigured. */
function repoForSlug(repos, slug) {
  if (typeof slug !== "string" || slug === "") return null;
  for (const repo of repos.values()) {
    if (repo.github === slug) return repo;
  }
  return null;
}

/**
 * Translate a verified GitHub webhook delivery into a `factory.event/v1`
 * envelope (WM-112). Minimal and typed, on purpose:
 *
 *   pull_request  opened|synchronize|ready_for_review against a configured
 *                 repo's base branch → `factory.merge.requested {repo}`
 *                 (short name); `report_only` repos never yield it.
 *   workflow_run  completed + failure on a configured repo → the EXISTING
 *                 `github.workflow-run.failed` shape ci-log-capture consumes
 *                 ({repo: owner/name slug, runId}); report_only repos included.
 *
 * eventId is GitHub's delivery GUID, so at-least-once delivery dedupes on the
 * (source, eventId) key like every other admission. Anything else is a typed
 * refusal: `ignored: true` for benign non-events (the route answers 2xx so
 * GitHub does not mark the hook failing), `ignored: false` for malformed
 * deliveries that deserve a 4xx.
 *
 * @returns {{ ok: true, envelope: object }
 *         | { ok: false, ignored: boolean, reason: string }}
 */
export function translateGitHubEvent({
  event,
  deliveryId,
  payload,
  repos,
  now = Date.now(),
}) {
  if (!deliveryId || typeof deliveryId !== "string") {
    return { ok: false, ignored: false, reason: "missing_delivery_id" };
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { ok: false, ignored: false, reason: "malformed_payload" };
  }
  const occurredAt = new Date(
    typeof now === "number" ? now : Date.now(),
  ).toISOString();
  const base = {
    schemaVersion: "factory.event/v1",
    eventId: deliveryId,
    source: "github",
    occurredAt,
    correlationId: deliveryId,
    causationId: null,
  };

  if (event === "pull_request") {
    if (!PR_ACTIONS.includes(payload.action))
      return { ok: false, ignored: true, reason: "unhandled_action" };
    const pr = payload.pull_request;
    if (!pr || typeof pr !== "object")
      return { ok: false, ignored: false, reason: "malformed_payload" };
    if (payload.action !== "ready_for_review" && pr.draft === true) {
      return { ok: false, ignored: true, reason: "draft_pr" };
    }
    const repo = repoForSlug(repos, payload.repository?.full_name);
    if (!repo) return { ok: false, ignored: true, reason: "unconfigured_repo" };
    if (pr.base?.ref !== repo.base)
      return { ok: false, ignored: true, reason: "not_base_branch" };
    // A repo without industrialized worktrees has a safe concurrency of one
    // human (dispatch doc §5) — CI facts still flow, merge requests never do.
    if (repo.reportOnly)
      return { ok: false, ignored: true, reason: "repo_report_only" };
    return {
      ok: true,
      envelope: {
        ...base,
        type: "factory.merge.requested",
        subject: repo.name,
        payload: { repo: repo.name },
      },
    };
  }

  if (event === "workflow_run") {
    const run = payload.workflow_run;
    if (payload.action !== "completed" || run?.conclusion !== "failure") {
      return { ok: false, ignored: true, reason: "unhandled_action" };
    }
    const slug = payload.repository?.full_name;
    const repo = repoForSlug(repos, slug);
    if (!repo) return { ok: false, ignored: true, reason: "unconfigured_repo" };
    if (run.id === undefined || run.id === null)
      return { ok: false, ignored: false, reason: "malformed_payload" };
    return {
      ok: true,
      // The existing shape ci-log-capture@1 consumes: the GitHub slug, not the
      // short name — see schemas/ci-log-capture.input.json.
      envelope: {
        ...base,
        type: "github.workflow-run.failed",
        subject: "ci",
        payload: { repo: slug, runId: run.id },
      },
    };
  }

  return { ok: false, ignored: true, reason: "unhandled_event" };
}

/**
 * Persist an already-authenticated envelope. Validates against the registered
 * envelope schema (fail closed), overwrites `receivedAt` with the server
 * clock — the sender's claim is never trusted — and dedupes on the
 * (source, eventId) primary key inside one transaction.
 *
 * @returns {{ admitted: true, duplicate: false, event: object }
 *         | { admitted: false, duplicate: true, event: object }
 *         | { admitted: false, duplicate: false, errors: string[] }}
 */
/**
 * Provenance a caller may never select. `chain` is durable proof the chain
 * resolver created the event; `handoff` proof the handoff boundary did; and
 * `schedule` proof the in-process tick loop did — the fact
 * `autoApproveScheduled` reads as authority to approve a run nobody watched
 * (#960). Each is written only by a trusted in-process producer that calls
 * `admitEvent` (or a narrow wrapper) directly.
 */
export const RESERVED_INTERNAL_SOURCES = new Set([
  "chain",
  "handoff",
  "schedule",
]);

function reservedSourceRefusal(envelope, allowed = new Set()) {
  if (
    envelope &&
    typeof envelope === "object" &&
    !Array.isArray(envelope) &&
    RESERVED_INTERNAL_SOURCES.has(envelope.source) &&
    !allowed.has(envelope.source)
  ) {
    return {
      admitted: false,
      duplicate: false,
      errors: [`source: reserved internal provenance "${envelope.source}"`],
    };
  }
  return null;
}

/**
 * Persist an envelope supplied by a public/operator boundary. Reserved runtime
 * provenance is never caller-selectable: rejecting it before persistence keeps
 * `events.source = "chain"` as durable proof that the chain resolver created
 * the event, rather than untrusted envelope text.
 */
export function admitExternalEvent(db, registry, envelope, options = {}) {
  const refusal = reservedSourceRefusal(envelope);
  return refusal ?? admitEvent(db, registry, envelope, options);
}

/**
 * Persist an envelope after the existing factory HMAC boundary authenticated
 * its exact bytes. Handoff is the one reserved provenance that boundary may
 * admit; chain and schedule remain in-process-only, so a holder of the shared
 * event secret cannot forge scheduler provenance and inherit auto-approval.
 */
export function admitSignedEvent(db, registry, envelope, options = {}) {
  const refusal = reservedSourceRefusal(envelope, new Set(["handoff"]));
  return refusal ?? admitEvent(db, registry, envelope, options);
}

/**
 * Trusted in-process persistence primitive. Public HTTP/replay boundaries must
 * call admitExternalEvent; internal producers use narrow wrappers such as
 * admitChainEvent instead of accepting a caller-selected source.
 */
export function admitEvent(db, registry, envelope, { now = Date.now() } = {}) {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope)
  ) {
    return {
      admitted: false,
      duplicate: false,
      errors: ["$: envelope must be an object"],
    };
  }
  const nowMs =
    typeof now === "number"
      ? now
      : typeof now === "string"
        ? Date.parse(now)
        : Date.now();
  const receivedAt = new Date(nowMs).toISOString();
  const stored = { ...envelope, receivedAt };
  const { valid, errors } = validate(registry.schemas.envelope, stored);
  if (!valid) return { admitted: false, duplicate: false, errors };

  // Refuse clock tick events whose slot is in the future relative to now (OPS-437).
  if (
    stored.source === "schedule" ||
    (typeof stored.type === "string" && stored.type.startsWith("clock.tick."))
  ) {
    const occurredMs = Date.parse(stored.occurredAt);
    if (!Number.isNaN(occurredMs) && occurredMs > nowMs) {
      return {
        admitted: false,
        duplicate: false,
        errors: ["occurredAt: clock tick slot cannot be in the future"],
      };
    }
  }

  return txImmediate(db, () => {
    const existing = db
      .query(`SELECT * FROM events WHERE source = ? AND event_id = ?`)
      .get(stored.source, stored.eventId);
    if (existing) return { admitted: false, duplicate: true, event: existing };
    db.query(
      `INSERT INTO events
         (source, event_id, type, subject, occurred_at, received_at,
          correlation_id, causation_id, envelope_json, payload_hash, status, admitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?)`,
    ).run(
      stored.source,
      stored.eventId,
      stored.type,
      stored.subject ?? null,
      stored.occurredAt,
      receivedAt,
      stored.correlationId ?? null,
      stored.causationId ?? null,
      canonicalJson(stored),
      hashJson(stored.payload),
      receivedAt,
    );
    const event = db
      .query(`SELECT * FROM events WHERE source = ? AND event_id = ?`)
      .get(stored.source, stored.eventId);
    return { admitted: true, duplicate: false, event };
  });
}
