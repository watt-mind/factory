#!/usr/bin/env bun
/**
 * factory ask — ONE read-only surface for "what is the factory doing?" (#1069).
 *
 *   factory ask                       # human summary, every non-report_only repo
 *   factory ask --json                # the document the summary is rendered from
 *   factory ask --repo factory        # scope to one repo
 *   factory ask --section queue,held  # only those sections
 *
 * Why this exists: every consumer that wants factory state re-derives it from a
 * different place — queue.mjs knows what is dispatchable, economics.mjs parses
 * transcripts for spend, and the reason a planner declined to act lives only in
 * `proposals.reason` inside runtime.db. Three consumers are queued (the @factory
 * Buzz agent, the context graph, the web Overview) and building the read surface
 * once is strictly cheaper than three parsers over the same prose.
 *
 * Two invariants hold this together:
 *
 *   READ-ONLY BY CONSTRUCTION. This module imports no write verb and calls
 *   none. `orchestrator/ask.test.mjs` asserts both — statically over this
 *   source, and dynamically by running a whole `ask` against a fake control
 *   plane and checking that no claim/transition/setLabels/file/comment call
 *   ever reached it. `ask` is safe to run from anywhere, at any cadence.
 *
 *   EVERY SECTION IS INDEPENDENTLY FALLIBLE. A tracker that cannot be reached
 *   is not "no tickets" (docs/protocol.md, "GitHub Issues binding"): the
 *   failing section carries `{ error }` and the renderer prints "unavailable",
 *   never an empty list, while every other section still returns. The command
 *   exits 0 — a partial answer is the point.
 *
 * JSON consumers must check each section's `complete` field. It is true only
 * when `error` is null and `errors` is empty; `error === null` alone is not
 * enough because a section can contain a partial answer and still have rows.
 *
 * The JSON is the source; the text is rendered from it by `formatAsk`, so the
 * two cannot disagree.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dbPath } from "../event-runtime/lib/config.mjs";
import { usageSpend } from "../event-runtime/lib/db.mjs";
import { loadControlPlane } from "../lib/control-plane/index.mjs";
import { loadQueueConfig } from "../lib/queue-summary.mjs";
import {
  LOG_DIR,
  budgetExhausted,
  todaysSpendBreakdown,
} from "../lib/spend.mjs";
import { AI_BLOCKED } from "./reply-detection.mjs";

/** `ai:blocked` waits on an answer; `ai:escalated` waits on a decision. */
export const AI_ESCALATED = "ai:escalated";
export const HELD_LABELS = Object.freeze([AI_BLOCKED, AI_ESCALATED]);

/** Top-level keys of the document, in render order. */
export const SECTIONS = Object.freeze([
  "queue",
  "inflight",
  "held",
  "recent",
  "noop",
  "spend",
]);

/**
 * Control-plane verbs `ask` must never reach. Exported so the test asserts
 * against this list rather than a second copy of it that can drift.
 */
export const WRITE_OPS = Object.freeze([
  "claim",
  "transition",
  "setLabels",
  "file",
  "comment",
  "appendDetail",
]);

const DEFAULT_WINDOW_HOURS = 24;

/**
 * How many `listComments` reads for held tickets are in flight at once.
 *
 * Small on purpose: this is a read surface that may be polled, and the point
 * is to stop paying N round trips in series, not to burst a tracker's rate
 * limiter — which, when it trips, is exactly the failure this command is
 * supposed to survive.
 *
 * MEASURED CAVEAT: this buys real wall-clock only on the Linear adapter, whose
 * transport is `await fetch`. `lib/control-plane/github.mjs` shells out through
 * `spawnSync`, which blocks the event loop, so its reads serialize no matter
 * what is awaited around them — measured on the factory repo at 13.0s
 * concurrent vs 12.5s serial for five held tickets. The fan-out is correct and
 * bounded here; making it *pay* on GitHub is an adapter-level fix, filed
 * separately. Do not "fix" this by raising the limit.
 */
const HELD_COMMENT_CONCURRENCY = 5;

/** `Promise.all` over fixed-size chunks: bounded fan-out, input order kept. */
async function mapWithConcurrency(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit)
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

const reasonOf = (error) =>
  error?.message ? String(error.message) : String(error);

const oneLine = (value, max = 300) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const labelNames = (ticket) =>
  (Array.isArray(ticket?.labels)
    ? ticket.labels
    : (ticket?.labels?.nodes ?? [])
  )
    .map((l) => l?.name)
    .filter(Boolean);

const stateName = (ticket) => ticket?.state?.name ?? null;

const msSince = (iso, now) => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
};

/**
 * When this ticket last showed a sign of life, and how confident that is.
 *
 * `lastCommentAt` is a real heartbeat — an agent posting its phase change.
 * `updatedAt` is a proxy: it advances on the claim mutation, on label swaps
 * and on comments, so it is an upper bound on silence rather than a heartbeat.
 * The GitHub adapter pins `lastCommentAt: null` (github.mjs), which is the
 * whole reason the distinction has to be carried rather than collapsed.
 *
 * Reporting a missing heartbeat as `never` would be the same mistake this
 * command exists to prevent, one level down: "we did not read it" rendered as
 * "it did not happen". Hence the explicit `unknown` source.
 */
export function heartbeatOf(ticket) {
  if (ticket?.lastCommentAt)
    return { at: ticket.lastCommentAt, source: "comment" };
  if (ticket?.updatedAt) return { at: ticket.updatedAt, source: "updatedAt" };
  return { at: null, source: "unknown" };
}

/** Compact duration for the human view: 5s / 12m / 3h / 2d. */
export function humanAge(ms) {
  if (ms == null) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * `--section` -> the requested subset, in SECTIONS order.
 *
 * Throws (rather than silently dropping) on an unknown name: a typo that
 * returns fewer sections looks exactly like a quiet factory, which is the one
 * failure mode this whole command exists to prevent.
 */
export function parseSections(raw) {
  if (raw == null || raw === "") return [...SECTIONS];
  const wanted = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((s) => !SECTIONS.includes(s));
  if (unknown.length) {
    const error = new Error(
      `unknown section ${unknown.map((s) => JSON.stringify(s)).join(", ")} — valid sections: ${SECTIONS.join(", ")}`,
    );
    error.code = "UNKNOWN_SECTION";
    throw error;
  }
  if (!wanted.length) return [...SECTIONS];
  return SECTIONS.filter((s) => wanted.includes(s));
}

/**
 * runtime.db opened READ-ONLY on purpose. `openDb()` would migrate and set
 * pragmas — writes, from a command whose whole contract is that it does none.
 *
 * A read-only connection cannot build the WAL index (`-shm`). After an unclean
 * shutdown the database can be left with a `-wal` but no `-shm`; a strict
 * read-only open of that state fails with a bare `unable to open database file`.
 * We detect it up front and report an actionable reason instead — never falling
 * back to an immutable snapshot, which could silently omit committed WAL frames
 * and so return a stale read as if it were current (see #1114). We do not create
 * the `-shm` ourselves: this verb writes nothing to the runtime directory.
 */
export function openRuntimeDb(file = dbPath()) {
  if (!existsSync(file)) throw new Error(`no runtime database at ${file}`);
  if (existsSync(`${file}-wal`) && !existsSync(`${file}-shm`))
    throw new Error(
      "runtime database was not shut down cleanly (WAL present without its index); " +
        "start the event runtime or run any runtime writer once, then retry",
    );
  return new Database(file, { readonly: true });
}

const emptySection = (extra = {}) => ({ error: null, errors: [], ...extra });

/** Add the final JSON completeness signal after every section has been built. */
const finalizeSections = (doc) => {
  for (const name of doc.sections) {
    const section = doc[name];
    if (section)
      section.complete =
        section.error === null && (section.errors?.length ?? 0) === 0;
  }
  return doc;
};

/**
 * Run `fn` for each repo, collecting rows and per-repo failures.
 *
 * `error` is set only when NO repo produced a trustworthy answer — that is the
 * "this section is unavailable" signal. A partial failure keeps its rows and
 * still names the repos it could not read in `errors`, because dropping them
 * silently is how an unreachable tracker starts reading as an empty queue.
 */
async function perRepo(repos, fn) {
  if (!repos.length) {
    return {
      rows: [],
      error: "no repositories configured (config/repos.yaml)",
      errors: [],
    };
  }
  const rows = [];
  const errors = [];
  for (const repo of repos) {
    try {
      rows.push(...(await fn(repo)));
    } catch (error) {
      errors.push({ repo: repo.name, error: reasonOf(error) });
    }
  }
  return {
    rows,
    error:
      errors.length === repos.length
        ? errors.map((e) => `${e.repo}: ${e.error}`).join("; ")
        : null,
    errors,
  };
}

/** Runs started inside the window, with their last attempt's usage. */
function recentRuns(db, { sinceIso }) {
  return db
    .query(
      `SELECT r.run_id                                   AS runId,
              r.state                                    AS outcome,
              r.attempts                                 AS attempts,
              r.created_at                               AS createdAt,
              r.updated_at                               AS updatedAt,
              json_extract(r.spec_json, '$.agent')       AS agent,
              json_extract(r.spec_json, '$.adapter')     AS adapter,
              json_extract(r.spec_json, '$.modelTier')   AS modelTier,
              json_extract(r.spec_json, '$.input.repo')  AS repo,
              COALESCE(u.model, json_extract(r.spec_json, '$.model')) AS model,
              COALESCE(u.cost_usd, 0)                    AS costUSD,
              COALESCE(u.input_tokens, 0)                AS inputTokens,
              COALESCE(u.output_tokens, 0)               AS outputTokens
         FROM runs r
         LEFT JOIN run_usage u
           ON u.run_id = r.run_id
          AND u.attempt = (SELECT MAX(attempt) FROM run_usage WHERE run_id = r.run_id)
        WHERE r.created_at >= ?
        ORDER BY r.created_at DESC`,
    )
    .all(sinceIso);
}

/**
 * The latest planner decline per event type, with its reason.
 *
 * Deliberately NOT windowed: "nothing has dispatched since Tuesday" is
 * answered by a decline that is itself days old, and hiding it behind a 24h
 * cutoff would leave the question unanswerable. `ageMs` carries the staleness
 * instead.
 */
function noopReasons(db, { now }) {
  return db
    .query(
      `SELECT event_type AS eventType, reason, created_at AS at,
              proposal_id AS proposalId, subject, total
         FROM (
           SELECT e.type       AS event_type,
                  p.reason     AS reason,
                  p.created_at AS created_at,
                  p.id         AS proposal_id,
                  e.subject    AS subject,
                  COUNT(*)   OVER (PARTITION BY e.type) AS total,
                  ROW_NUMBER() OVER (PARTITION BY e.type ORDER BY p.created_at DESC) AS rn
             FROM proposals p
             JOIN events e
               ON e.source = p.event_source AND e.event_id = p.event_id
            WHERE p.decision = 'noop'
         )
        WHERE rn = 1
        ORDER BY created_at DESC`,
    )
    .all()
    .map((row) => ({ ...row, ageMs: msSince(row.at, now) }));
}

/**
 * Build the whole document.
 *
 * Every dependency is injectable so the test drives a fake control plane, an
 * in-memory runtime.db and a temp log dir — and so no test ever touches the
 * operator's live state.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.sections]        subset of SECTIONS to produce
 * @param {object[]} [opts.repos]           config/repos.yaml entries
 * @param {object}   [opts.policy]          config/policy.yaml (budget)
 * @param {Function} [opts.controlPlaneFor] repo -> ControlPlane
 * @param {object|null} [opts.db]           open runtime.db handle; null skips it
 * @param {string}   [opts.logDir]          transcript directory for spend
 * @param {number}   [opts.now]             clock, epoch ms
 * @param {number}   [opts.windowHours]     `recent` window
 */
export async function gatherAsk({
  sections = SECTIONS,
  repos,
  policy,
  controlPlaneFor,
  db,
  logDir = LOG_DIR,
  now = Date.now(),
  windowHours = DEFAULT_WINDOW_HOURS,
} = {}) {
  const want = new Set(sections);
  const order = SECTIONS.filter((s) => want.has(s));

  let repoList = repos;
  let policyConfig = policy;
  if (!repoList) {
    const config = loadQueueConfig();
    repoList = (config.repos ?? []).filter((r) => !r.report_only);
    policyConfig ??= config.policy;
  }

  const makePlane =
    controlPlaneFor ?? ((repo) => loadControlPlane({ repoName: repo.name }));
  const planes = new Map();
  const planeFor = (repo) => {
    if (!planes.has(repo.name)) planes.set(repo.name, makePlane(repo));
    return planes.get(repo.name);
  };

  // One listTickets per repo feeds both `inflight` and `held`. Memoised as a
  // promise, awaited inside each section's own try/catch, so a rejection is
  // reported per section rather than taking the document down.
  const ticketReads = new Map();
  const allTickets = (repo) => {
    if (!ticketReads.has(repo.name)) {
      ticketReads.set(
        repo.name,
        (async () =>
          planeFor(repo).listTickets({
            team: repo.team,
            project: repo.project,
          }))(),
      );
    }
    return ticketReads.get(repo.name);
  };

  const needsDb = want.has("recent") || want.has("noop") || want.has("spend");
  let handle = db;
  let dbError = null;
  let ownsDb = false;
  if (handle === undefined) {
    if (!needsDb) handle = null;
    else {
      try {
        handle = openRuntimeDb();
        ownsDb = true;
      } catch (error) {
        dbError = reasonOf(error);
        handle = null;
      }
    }
  }
  const noDbReason = () =>
    dbError ?? "runtime database not available to this process";

  const sinceMs = now - windowHours * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const repoNames = new Set(repoList.map((r) => r.name));

  const doc = {
    generatedAt: new Date(now).toISOString(),
    window: {
      hours: windowHours,
      since: sinceIso,
      until: new Date(now).toISOString(),
    },
    repos: repoList.map((r) => r.name),
    sections: order,
  };

  try {
    if (want.has("queue")) {
      doc.queue = await perRepo(repoList, async (repo) => {
        const tickets = await planeFor(repo).listDispatchable({
          team: repo.team,
          project: repo.project,
        });
        return tickets.map((t, index) => ({
          repo: repo.name,
          position: index + 1,
          identifier: t.identifier,
          title: t.title ?? null,
          url: t.url ?? null,
          priority: t.priority ?? null,
          labels: labelNames(t),
          createdAt: t.createdAt ?? null,
          ageMs: msSince(t.createdAt, now),
        }));
      });
    }

    if (want.has("inflight")) {
      doc.inflight = await perRepo(repoList, async (repo) => {
        const tickets = await allTickets(repo);
        return tickets
          .filter((t) => stateName(t) === "In Progress")
          .map((t) => {
            const heartbeat = heartbeatOf(t);
            // `startedAt` before `updatedAt` before `createdAt`, the same
            // precedence reaper.mjs `lastActivity()` uses. GitHub has no
            // workflow-state startedAt (github.mjs pins it null), so without
            // the `updatedAt` step a ticket claimed 12 minutes ago reads as
            // "30d old" — issue-creation time wearing a claim's label.
            const claimedAt = t.startedAt ?? t.updatedAt ?? t.createdAt ?? null;
            return {
              repo: repo.name,
              identifier: t.identifier,
              title: t.title ?? null,
              url: t.url ?? null,
              assignee: t.assignee?.name ?? null,
              labels: labelNames(t),
              claimedAt,
              claimedAtSource: t.startedAt
                ? "startedAt"
                : t.updatedAt
                  ? "updatedAt"
                  : t.createdAt
                    ? "createdAt"
                    : "unknown",
              ageMs: msSince(claimedAt, now),
              lastHeartbeatAt: heartbeat.at,
              heartbeatAgeMs: msSince(heartbeat.at, now),
              heartbeatSource: heartbeat.source,
            };
          });
      });
    }

    if (want.has("held")) {
      doc.held = await perRepo(repoList, async (repo) => {
        const tickets = (await allTickets(repo)).filter((t) =>
          labelNames(t).some((name) => HELD_LABELS.includes(name)),
        );
        // One listComments per held ticket, fully serialized, was the bulk of
        // the wall-clock — and it got slowest exactly when the factory was
        // unhealthy and the answer mattered most. Bounded concurrency keeps
        // the per-ticket try/catch (a failure still costs one question, not
        // the section) without paying for the round trips in series.
        return mapWithConcurrency(
          tickets,
          HELD_COMMENT_CONCURRENCY,
          async (t) => {
            let question = null;
            let questionAt = null;
            let questionError = null;
            try {
              const comments = await planeFor(repo).listComments(t.identifier);
              const newest = [...comments].sort(
                (a, b) =>
                  Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0),
              )[comments.length - 1];
              if (newest) {
                question = oneLine(newest.body, 400);
                questionAt = newest.createdAt ?? null;
              }
            } catch (error) {
              questionError = reasonOf(error);
            }
            return {
              repo: repo.name,
              identifier: t.identifier,
              title: t.title ?? null,
              url: t.url ?? null,
              state: stateName(t),
              holds: labelNames(t).filter((n) => HELD_LABELS.includes(n)),
              labels: labelNames(t),
              question,
              questionAt,
              // NOT necessarily the question. reply-detection anchors on the
              // ai:blocked label-add and only falls back to newest-comment when
              // there is no add event; the neutral contract exposes no label
              // history (GitHub has none), so this is always the fallback. Once
              // a human answers a held ticket, the newest comment is their
              // ANSWER. Consumers must read this discriminator before calling
              // the text a question, and the renderer labels it accordingly.
              questionSource: "newest-comment",
              questionError,
              ageMs: msSince(t.updatedAt ?? t.createdAt, now),
            };
          },
        );
      });
    }

    if (want.has("recent")) {
      doc.recent = emptySection({ rows: [], byOutcome: {}, totalCostUSD: 0 });
      if (!handle) doc.recent.error = noDbReason();
      else {
        try {
          // A run whose spec names no repo (maintenance, scans) belongs to
          // every scope; one that names a repo outside the scope does not.
          const rows = recentRuns(handle, { sinceIso }).filter(
            (row) => !row.repo || repoNames.has(row.repo),
          );
          doc.recent.rows = rows.map((row) => ({
            ...row,
            ageMs: msSince(row.createdAt, now),
          }));
          doc.recent.byOutcome = rows.reduce((acc, row) => {
            const key = row.outcome ?? "UNKNOWN";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {});
          doc.recent.totalCostUSD = rows.reduce(
            (sum, row) => sum + (row.costUSD ?? 0),
            0,
          );
        } catch (error) {
          doc.recent.error = reasonOf(error);
        }
      }
    }

    if (want.has("noop")) {
      doc.noop = emptySection({ rows: [] });
      if (!handle) doc.noop.error = noDbReason();
      else {
        try {
          doc.noop.rows = noopReasons(handle, { now });
        } catch (error) {
          doc.noop.error = reasonOf(error);
        }
      }
    }

    if (want.has("spend")) {
      // lib/spend.mjs is the shared parser the budget gate uses. Reusing it is
      // the point: a second parser here would let `ask` and the gate disagree
      // about whether the day is spent.
      doc.spend = emptySection({
        today: null,
        budget: {
          perDayUSD: policyConfig?.budget?.per_day_usd ?? null,
          exhausted: null,
        },
        runtime: null,
      });
      try {
        doc.spend.today = todaysSpendBreakdown(logDir);
        doc.spend.budget.exhausted = budgetExhausted(policyConfig, logDir);
      } catch (error) {
        doc.spend.error = reasonOf(error);
      }
      if (!handle) {
        doc.spend.errors.push({ source: "runtime.db", error: noDbReason() });
      } else {
        try {
          doc.spend.runtime = usageSpend(handle, { now });
        } catch (error) {
          doc.spend.errors.push({
            source: "runtime.db",
            error: reasonOf(error),
          });
        }
      }
    }
  } finally {
    if (ownsDb && handle) handle.close();
  }

  return finalizeSections(doc);
}

// ---------------------------------------------------------------- render ----

const pad = (value, width) => String(value ?? "").padEnd(width);

/**
 * Column width from the rows themselves, clamped.
 *
 * Identifiers are `WM-1060` on Linear and `watt-mind/factory#1060` on GitHub —
 * a hardcoded width lines up for exactly one of them.
 */
const columnWidth = (rows, key, min, max) =>
  Math.min(
    max,
    Math.max(min, ...(rows ?? []).map((r) => String(r?.[key] ?? "").length)),
  );

function renderRows(lines, section, emptyText, render, limit = 12) {
  if (!section) return;
  if (section.error) {
    lines.push(`  unavailable — ${section.error}`);
    return;
  }
  if (!section.rows?.length) {
    lines.push(`  ${emptyText}`);
  } else {
    for (const row of section.rows.slice(0, limit)) lines.push(render(row));
    if (section.rows.length > limit)
      lines.push(`  … and ${section.rows.length - limit} more`);
  }
  for (const e of section.errors ?? [])
    lines.push(`  partial — ${e.repo ?? e.source}: ${e.error}`);
}

const count = (section) =>
  section?.error ? "unavailable" : (section?.rows?.length ?? 0);

/**
 * A heartbeat we never read is `unknown`, not `never` — and a timestamp that
 * is only `updatedAt` says so, because "silent for 40m" and "last touched 40m
 * ago" are different claims about whether an agent is alive.
 */
/**
 * A comment read that FAILED must not render like a ticket that simply has no
 * comments — falling back to the title in both cases is the section-level
 * "unavailable vs empty" mistake repeated per row. Rate limits hit these reads
 * one ticket at a time, so this is the common case, not the exotic one.
 */
const heldRowText = (r, repoW, idW) => {
  const head = `  ${pad(r.repo, repoW)}  ${pad(r.identifier, idW)}  ${pad(r.holds.join(","), 22)}  `;
  if (r.questionError)
    return `${head}comment unreadable — ${oneLine(r.questionError, 60)}`;
  if (r.question) return `${head}last comment: ${oneLine(r.question, 60)}`;
  return `${head}${oneLine(r.title, 70)} (no comments)`;
};

const heartbeatText = (row) => {
  if (row.heartbeatSource === "comment")
    return `heartbeat ${humanAge(row.heartbeatAgeMs)} ago`;
  if (row.heartbeatSource === "updatedAt")
    return `updated ${humanAge(row.heartbeatAgeMs)} ago`;
  return "heartbeat unknown";
};

/**
 * The human view, rendered from the document `gatherAsk` returned — never from
 * a second read. If a number here disagrees with `--json`, that is a bug in
 * this function, not a different answer.
 */
export function formatAsk(doc) {
  const lines = [];
  lines.push(
    `factory ask — ${doc.generatedAt}  ·  repos: ${doc.repos?.join(", ") || "(none)"}`,
  );

  if (doc.queue) {
    const repoW = columnWidth(doc.queue.rows, "repo", 6, 16);
    const idW = columnWidth(doc.queue.rows, "identifier", 8, 26);
    lines.push(`\nQUEUE — eligible (${count(doc.queue)})`);
    renderRows(
      lines,
      doc.queue,
      "no eligible tickets",
      (r) =>
        `  ${pad(r.repo, repoW)}  ${pad(r.identifier, idW)}  ${pad(r.priority == null ? "p-" : `p${r.priority}`, 3)}  ${oneLine(r.title, 60)}`,
    );
  }

  if (doc.inflight) {
    const repoW = columnWidth(doc.inflight.rows, "repo", 6, 16);
    const idW = columnWidth(doc.inflight.rows, "identifier", 8, 26);
    lines.push(`\nIN FLIGHT — claimed (${count(doc.inflight)})`);
    renderRows(
      lines,
      doc.inflight,
      "nothing claimed",
      (r) =>
        `  ${pad(r.repo, repoW)}  ${pad(r.identifier, idW)}  ${pad(`${humanAge(r.ageMs)} old`, 9)}  ${pad(heartbeatText(r), 24)}  ${oneLine(r.title, 45)}`,
    );
  }

  if (doc.held) {
    const repoW = columnWidth(doc.held.rows, "repo", 6, 16);
    const idW = columnWidth(doc.held.rows, "identifier", 8, 26);
    lines.push(`\nHELD — waiting on a human (${count(doc.held)})`);
    // "last comment", never "question": once a human answers, the newest
    // comment IS the answer, and this is the view where mislabelling it turns
    // "what is waiting on me" into a lie.
    if (doc.held.rows?.length)
      lines.push("  (newest comment shown — may be the reply, not the ask)");
    renderRows(lines, doc.held, "nothing held", (r) =>
      heldRowText(r, repoW, idW),
    );
  }

  if (doc.recent) {
    const outcomes = Object.entries(doc.recent.byOutcome ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    lines.push(
      `\nRECENT RUNS — last ${doc.window?.hours ?? DEFAULT_WINDOW_HOURS}h (${count(doc.recent)})${outcomes ? `  ${outcomes}` : ""}`,
    );
    renderRows(
      lines,
      doc.recent,
      "no runs in the window",
      (r) =>
        `  ${pad(humanAge(r.ageMs), 6)} ${pad(r.agent ?? "?", 22)} ${pad(r.adapter ?? "?", 10)} ${pad(r.model ?? "?", 24)} ${pad(r.outcome, 12)} $${(r.costUSD ?? 0).toFixed(2)}`,
      10,
    );
  }

  if (doc.noop) {
    lines.push(
      `\nPLANNER DECLINES — latest per event type (${count(doc.noop)})`,
    );
    renderRows(
      lines,
      doc.noop,
      "no recorded declines",
      (r) =>
        `  ${pad(humanAge(r.ageMs), 6)} ${pad(r.eventType, 34)} ${pad(r.reason ?? "(no reason recorded)", 28)} ×${r.total}`,
    );
  }

  if (doc.spend) {
    lines.push("\nSPEND");
    if (doc.spend.error) {
      lines.push(`  unavailable — ${doc.spend.error}`);
    } else {
      const t = doc.spend.today ?? {};
      const budget = doc.spend.budget?.perDayUSD;
      lines.push(
        `  today  ~$${(t.usd ?? 0).toFixed(2)}${budget ? ` of $${budget}` : ""}  (reported $${(t.reported ?? 0).toFixed(2)} + estimated $${(t.estimated ?? 0).toFixed(2)}, ${t.runs ?? 0} run(s))`,
      );
      if (doc.spend.budget?.exhausted)
        lines.push(`  BUDGET — ${doc.spend.budget.exhausted}`);
      const rolling = doc.spend.runtime?.rolling24h;
      if (rolling)
        lines.push(
          `  runtime 24h  $${(rolling.costUSD ?? 0).toFixed(2)}  ${rolling.totalTokens ?? 0} tokens`,
        );
    }
    for (const e of doc.spend.errors ?? [])
      lines.push(`  partial — ${e.source ?? e.repo}: ${e.error}`);
  }

  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------- cli ----

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };

  // Section validation first: it needs no config and no network, so a typo
  // fails immediately rather than after a minute of tracker reads.
  let sections;
  try {
    sections = parseSections(val("--section"));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const { repos: configured, policy } = loadQueueConfig();
  const only = (val("--repo") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let repos;
  if (only.length) {
    const missing = only.filter((n) => !configured.some((r) => r.name === n));
    if (missing.length) {
      console.error(
        `no repo named ${missing.map((n) => JSON.stringify(n)).join(", ")} in config/repos.yaml — known: ${configured.map((r) => r.name).join(", ") || "(none)"}`,
      );
      process.exit(2);
    }
    repos = configured.filter((r) => only.includes(r.name));
  } else {
    repos = configured.filter((r) => !r.report_only);
  }
  if (!repos.length) {
    console.error("no repos configured in config/repos.yaml");
    process.exit(2);
  }

  const doc = await gatherAsk({ sections, repos, policy });
  console.log(
    argv.includes("--json") ? JSON.stringify(doc, null, 2) : formatAsk(doc),
  );
}
