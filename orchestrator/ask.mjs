#!/usr/bin/env bun
/**
 * One read-only surface for "what is the factory doing right now?" (WM-1069).
 *
 *   factory ask                       # human summary, every non-report-only repo
 *   factory ask --json                # the stable document the summary renders
 *   factory ask --repo factory        # scope the tracker sections to one repo
 *   factory ask --section queue,held  # only the named sections
 *
 * Every other surface that answers this question re-derives it from a different
 * place: queue.mjs knows what is dispatchable, economics.mjs parses transcripts
 * for spend, the planner's decline reason lives only in `proposals.reason`. This
 * verb consolidates them into ONE document of typed rows so the @factory agent,
 * the context graph and the web Overview parse the nouns once instead of three
 * times over the same prose.
 *
 * READ-ONLY BY CONSTRUCTION. This module imports no write verb — no claim,
 * transition, setLabels, file or comment ever reaches the control plane. The
 * document is the source of truth; the human render is derived from it, so the
 * two cannot disagree.
 *
 * SECTIONS. `queue`, `inflight` and `held` are tracker-derived and scoped by
 * `--repo`; `recent`, `noop` and `spend` describe the runtime instance as a
 * whole (the transcript log and the event-runtime ledger are not repo-partitioned)
 * and stay global. Each section is INDEPENDENTLY FALLIBLE: a section that cannot
 * be read carries an error rather than pulling the rest of the document down, and
 * a tracker read that fails is never rendered as an empty queue — an unreachable
 * tracker must not read as "no tickets" (docs/protocol.md §"GitHub Issues binding").
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { loadConfigYaml } from "../lib/schedule.mjs";
import { loadControlPlane } from "../lib/control-plane/index.mjs";
import { liveWorkerLeases } from "../lib/worker-leases.mjs";
import { todaysSpendBreakdown } from "../lib/spend.mjs";
import { dbPath } from "../event-runtime/lib/config.mjs";
import { AI_BLOCKED } from "./reply-detection.mjs";

/** The `ai:escalated` hold label — its counterpart `ai:blocked` lives in reply-detection. */
export const AI_ESCALATED = "ai:escalated";

/** The two hold labels the `held` section reports on. */
export const HELD_LABELS = Object.freeze([AI_BLOCKED, AI_ESCALATED]);

/** Every valid section name, in render order. */
export const SECTIONS = Object.freeze([
  "queue",
  "inflight",
  "held",
  "recent",
  "noop",
  "spend",
]);

/** How far back `recent` and `spend` look. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const errorText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Parse argv into a normalised options object. Pure, so the CLI dispatch and
 * the tests agree on exactly what a flag means.
 *
 * @param {string[]} argv
 * @returns {{ json: boolean, help: boolean, repo: string|null,
 *   sections: string[], unknownSections: string[] }}
 */
export function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const raw = val("--section");
  const requested = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...SECTIONS];
  const unknownSections = requested.filter((s) => !SECTIONS.includes(s));
  // De-duplicate but keep canonical render order, not request order.
  const sections = SECTIONS.filter((s) => requested.includes(s));
  return {
    json: argv.includes("--json"),
    help: argv.includes("--help") || argv.includes("-h"),
    repo: val("--repo"),
    sections,
    unknownSections,
  };
}

/**
 * The repos a bare `factory ask` covers: every configured repo that is not
 * `report_only`. `--repo` narrows to one by name (report-only included, because
 * the operator named it explicitly).
 *
 * @returns {{ repos: object[], error: string|null }}
 */
export function resolveRepos(repo, cfg = loadConfigYaml("repos")) {
  const all = cfg.repos ?? [];
  if (repo) {
    const one = all.find((r) => r.name === repo);
    if (!one)
      return {
        repos: [],
        error: `no repo named "${repo}" in config/repos.yaml (known: ${
          all.map((r) => r.name).join(", ") || "none"
        })`,
      };
    return { repos: [one], error: null };
  }
  return { repos: all.filter((r) => !r.report_only), error: null };
}

const labelNames = (ticket) =>
  (Array.isArray(ticket.labels) ? ticket.labels : (ticket.labels?.nodes ?? []))
    .map((l) => l.name)
    .filter(Boolean);

const stateName = (ticket) => ticket.state?.name ?? null;

/**
 * Dispatchable tickets per repo, in the dispatcher's own queue order (the
 * adapter's `listDispatchable`, so this view cannot disagree with what dispatch
 * would start). Per-repo failures are isolated into `errors`, never swallowed
 * into an empty list.
 */
async function queueSection(repos, controlPlaneFor) {
  const rows = [];
  const errors = [];
  for (const repo of repos) {
    try {
      const cp = controlPlaneFor(repo);
      const tickets = await cp.listDispatchable({
        team: repo.team,
        project: repo.project,
      });
      for (const t of tickets)
        rows.push({
          repo: repo.name,
          identifier: t.identifier,
          title: t.title,
          url: t.url ?? null,
          priority: t.priority ?? null,
        });
    } catch (e) {
      errors.push({ repo: repo.name, error: errorText(e) });
    }
  }
  return { rows, errors };
}

/**
 * Claimed (In Progress) tickets with age since claim and the freshness of the
 * local worker lease — a claimed ticket with no live lease is a worker that
 * stopped heartbeating.
 */
async function inflightSection(repos, controlPlaneFor, leasesFor, now) {
  const rows = [];
  const errors = [];
  for (const repo of repos) {
    try {
      const cp = controlPlaneFor(repo);
      const tickets = await cp.listTickets({
        team: repo.team,
        project: repo.project,
        states: ["In Progress"],
      });
      const leases = new Map((leasesFor(repo) ?? []).map((l) => [l.ticket, l]));
      for (const t of tickets) {
        const startedAt = t.startedAt ?? t.createdAt ?? null;
        const startedMs = startedAt ? Date.parse(startedAt) : NaN;
        const lease = leases.get(t.identifier);
        rows.push({
          repo: repo.name,
          identifier: t.identifier,
          title: t.title,
          url: t.url ?? null,
          assignee: t.assignee?.name ?? null,
          ageMs: Number.isFinite(startedMs) ? now - startedMs : null,
          heartbeatAgeMs: lease ? now - lease.heartbeatAt : null,
          hasLiveLease: Boolean(lease),
        });
      }
    } catch (e) {
      errors.push({ repo: repo.name, error: errorText(e) });
    }
  }
  return { rows, errors };
}

/**
 * Held tickets (`ai:blocked` / `ai:escalated`) with the question the agent
 * asked. The question is the newest comment; a comment read that fails leaves
 * `question: null` rather than dropping the ticket, so a held ticket is always
 * visible even when its question cannot be fetched.
 */
async function heldSection(repos, controlPlaneFor) {
  const rows = [];
  const errors = [];
  for (const repo of repos) {
    try {
      const cp = controlPlaneFor(repo);
      const tickets = await cp.listTickets({
        team: repo.team,
        project: repo.project,
      });
      for (const t of tickets) {
        const held = labelNames(t).filter((n) => HELD_LABELS.includes(n));
        if (!held.length) continue;
        let question = null;
        try {
          const comments = await cp.listComments(t.identifier);
          question = comments.length
            ? (comments[comments.length - 1].body ?? null)
            : null;
        } catch {
          question = null;
        }
        rows.push({
          repo: repo.name,
          identifier: t.identifier,
          title: t.title,
          url: t.url ?? null,
          state: stateName(t),
          labels: held,
          question,
        });
      }
    } catch (e) {
      errors.push({ repo: repo.name, error: errorText(e) });
    }
  }
  return { rows, errors };
}

/**
 * Runs in the last `windowMs` from the event-runtime ledger: agent, adapter,
 * model, terminal (or in-flight) state, and cost. Cost is summed across
 * attempts; adapter/model prefer the recorded usage and fall back to the spec.
 *
 * @param {import("bun:sqlite").Database|null} db
 */
export function recentRuns(
  db,
  { now = Date.now(), windowMs = RECENT_WINDOW_MS } = {},
) {
  if (!db) return { error: "event-runtime ledger not found" };
  try {
    const since = new Date(now - windowMs).toISOString();
    const rows = db
      .query(
        `SELECT r.run_id AS runId,
              json_extract(r.spec_json, '$.agent')   AS agent,
              json_extract(r.spec_json, '$.repo')    AS repo,
              json_extract(r.spec_json, '$.adapter') AS specAdapter,
              json_extract(r.spec_json, '$.model')   AS specModel,
              r.state       AS state,
              r.created_at  AS createdAt,
              r.updated_at  AS updatedAt,
              COALESCE(SUM(u.cost_usd), 0) AS cost,
              MAX(u.adapter) AS usageAdapter,
              MAX(u.model)   AS usageModel
         FROM runs r
         LEFT JOIN run_usage u ON u.run_id = r.run_id
        WHERE r.created_at >= ?
        GROUP BY r.run_id
        ORDER BY r.created_at DESC`,
      )
      .all(since);
    return {
      rows: rows.map((row) => ({
        runId: row.runId,
        agent: row.agent ?? null,
        repo: row.repo ?? null,
        adapter: row.usageAdapter ?? row.specAdapter ?? null,
        model: row.usageModel ?? row.specModel ?? null,
        outcome: row.state,
        cost: Number(row.cost ?? 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  } catch (e) {
    return { error: errorText(e) };
  }
}

/**
 * The latest planner decline (`proposals.decision = 'noop'`) per event type,
 * with its `reason`. This reason lives nowhere else — it is why the planner
 * looked at an event and chose to do nothing.
 *
 * @param {import("bun:sqlite").Database|null} db
 */
export function noopReasons(db) {
  if (!db) return { error: "event-runtime ledger not found" };
  try {
    const rows = db
      .query(
        `SELECT e.type AS eventType, p.reason AS reason, p.created_at AS at
           FROM proposals p
           JOIN events e
             ON e.source = p.event_source AND e.event_id = p.event_id
          WHERE p.decision = 'noop'
          ORDER BY p.created_at DESC`,
      )
      .all();
    const latest = new Map();
    for (const row of rows) {
      if (latest.has(row.eventType)) continue; // rows are newest-first
      latest.set(row.eventType, {
        eventType: row.eventType,
        reason: row.reason ?? null,
        at: row.at,
      });
    }
    return { rows: [...latest.values()] };
  } catch (e) {
    return { error: errorText(e) };
  }
}

/** Spend over the window, reusing lib/spend.mjs (not a second transcript parser). */
function spendSection(spend) {
  try {
    const b = spend();
    return {
      window: "today",
      usd: b.usd,
      reported: b.reported,
      estimated: b.estimated,
      runs: b.runs,
    };
  } catch (e) {
    return { error: errorText(e) };
  }
}

/**
 * Build the read-only factory-state document. Every dependency is injected so
 * the whole surface can be exercised against a fake control plane and an
 * in-memory ledger — which is also how the read-only invariant is tested.
 *
 * @param {{
 *   repos: object[],
 *   sections?: string[],
 *   now?: number,
 *   windowMs?: number,
 *   controlPlaneFor?: (repo: object) => object,
 *   leasesFor?: (repo: object) => object[],
 *   db?: import("bun:sqlite").Database|null,
 *   spend?: () => { usd: number, reported: number, estimated: number, runs: number },
 * }} opts
 */
export async function buildAskDocument({
  repos,
  sections = [...SECTIONS],
  now = Date.now(),
  windowMs = RECENT_WINDOW_MS,
  controlPlaneFor = (repo) => loadControlPlane({ repoName: repo.name }),
  leasesFor = (repo) => liveWorkerLeases(repo.name),
  db = null,
  spend = todaysSpendBreakdown,
}) {
  const want = new Set(sections);
  const doc = {
    generatedAt: new Date(now).toISOString(),
    repos: repos.map((r) => r.name),
    sections: SECTIONS.filter((s) => want.has(s)),
  };
  if (want.has("queue")) doc.queue = await queueSection(repos, controlPlaneFor);
  if (want.has("inflight"))
    doc.inflight = await inflightSection(
      repos,
      controlPlaneFor,
      leasesFor,
      now,
    );
  if (want.has("held")) doc.held = await heldSection(repos, controlPlaneFor);
  if (want.has("recent")) doc.recent = recentRuns(db, { now, windowMs });
  if (want.has("noop")) doc.noop = noopReasons(db);
  if (want.has("spend")) doc.spend = spendSection(spend);
  return doc;
}

// ---------------------------------------------------------------- render ---

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Render the document as a human summary. Reads only from `doc`, never re-derives. */
export function renderHuman(doc) {
  const out = [];
  const P = (s = "") => out.push(s);
  const renderErrors = (errors) => {
    for (const e of errors ?? [])
      P(`  ${c.red(`error (${e.repo}): ${e.error}`)}`);
  };

  P(
    c.bold(`\nfactory ask`) +
      c.dim(`  ${doc.repos.join(", ") || "(no repos)"}`),
  );

  if (doc.queue) {
    P(c.bold(`\nQueue — dispatchable`));
    renderErrors(doc.queue.errors);
    if (!doc.queue.rows.length && !doc.queue.errors?.length) P(c.dim("  none"));
    for (const t of doc.queue.rows)
      P(
        `  ${c.green(t.identifier.padEnd(12))} ${c.dim(t.repo)}  ${(t.title ?? "").slice(0, 60)}`,
      );
  }

  if (doc.inflight) {
    P(c.bold(`\nIn flight — claimed`));
    renderErrors(doc.inflight.errors);
    if (!doc.inflight.rows.length && !doc.inflight.errors?.length)
      P(c.dim("  none"));
    for (const t of doc.inflight.rows) {
      const beat = t.hasLiveLease
        ? c.green(`beat ${fmtAge(t.heartbeatAgeMs)}`)
        : c.red("no live lease");
      P(
        `  ${t.identifier.padEnd(12)} ${c.dim(t.repo)}  age ${fmtAge(t.ageMs)}  ${beat}  ${(t.title ?? "").slice(0, 45)}`,
      );
    }
  }

  if (doc.held) {
    P(c.bold(`\nHeld — needs a human`));
    renderErrors(doc.held.errors);
    if (!doc.held.rows.length && !doc.held.errors?.length) P(c.dim("  none"));
    for (const t of doc.held.rows) {
      P(
        `  ${c.yellow(t.identifier.padEnd(12))} ${c.dim(t.repo)}  ${t.labels.join(",")}  ${(t.title ?? "").slice(0, 45)}`,
      );
      if (t.question)
        P(`    ${c.dim(t.question.replace(/\s+/g, " ").slice(0, 90))}`);
    }
  }

  if (doc.recent) {
    P(c.bold(`\nRecent runs — last 24h`));
    if (doc.recent.error) P(`  ${c.red(`error: ${doc.recent.error}`)}`);
    else if (!doc.recent.rows.length) P(c.dim("  none"));
    else
      for (const r of doc.recent.rows)
        P(
          `  ${(r.outcome ?? "?").padEnd(10)} ${(r.agent ?? "?").padEnd(14)} ${(r.adapter ?? "?").padEnd(8)} ${(r.model ?? "?").padEnd(16)} $${r.cost.toFixed(2)}  ${c.dim(r.repo ?? "")}`,
        );
  }

  if (doc.noop) {
    P(c.bold(`\nNoop — latest planner decline per event type`));
    if (doc.noop.error) P(`  ${c.red(`error: ${doc.noop.error}`)}`);
    else if (!doc.noop.rows.length) P(c.dim("  none"));
    else
      for (const n of doc.noop.rows)
        P(`  ${(n.eventType ?? "?").padEnd(24)} ${c.dim(n.reason ?? "")}`);
  }

  if (doc.spend) {
    P(c.bold(`\nSpend — ${doc.spend.window ?? "today"}`));
    if (doc.spend.error) P(`  ${c.red(`error: ${doc.spend.error}`)}`);
    else
      P(
        `  $${doc.spend.usd.toFixed(2)} notional  ${c.dim(
          `($${doc.spend.reported.toFixed(2)} reported + $${doc.spend.estimated.toFixed(2)} estimated, ${doc.spend.runs} run(s))`,
        )}`,
      );
  }

  P(
    c.dim(
      `\n\`factory ask --json\` is the machine-readable source of this view.`,
    ),
  );
  return out.join("\n");
}

const HELP = `factory ask — one read-only surface for factory state

  factory ask                       human summary of every non-report-only repo
  factory ask --json                the stable JSON document the summary renders
  factory ask --repo <name>         scope the tracker sections to one repo
  factory ask --section a,b         only the named sections

Sections: ${SECTIONS.join(", ")}
  queue/inflight/held  tracker-derived, scoped by --repo
  recent/noop/spend    runtime-instance wide

Read-only: no ticket is ever claimed, transitioned, labelled or commented on.`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (opts.unknownSections.length) {
    console.error(
      `unknown section(s): ${opts.unknownSections.join(", ")} — valid: ${SECTIONS.join(", ")}`,
    );
    process.exit(2);
  }

  const { repos, error } = resolveRepos(opts.repo);
  if (error) {
    console.error(error);
    process.exit(2);
  }

  // Open the ledger read-only. A missing or unreadable ledger is not fatal: the
  // recent/noop sections carry the error and the tracker sections still return.
  let db = null;
  const file = dbPath();
  if (existsSync(file)) {
    try {
      db = new Database(file, { readonly: true });
    } catch {
      db = null;
    }
  }

  try {
    const doc = await buildAskDocument({ repos, sections: opts.sections, db });
    if (opts.json) console.log(JSON.stringify(doc, null, 2));
    else console.log(renderHuman(doc));
  } finally {
    db?.close();
  }
  process.exit(0);
}
