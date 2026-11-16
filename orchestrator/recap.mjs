#!/usr/bin/env bun
/**
 * factory recap — read-only operator delta catch-up and decision collector.
 *
 *   factory recap                       # infer repo from cwd (or all repos)
 *   factory recap --all                 # every configured repo
 *   factory recap --repo factory        # scope to one or more repos
 *   factory recap --since overnight     # 14h, <N><m|h|d|w>, or ISO-8601
 *   factory recap --json                # machine-readable recap document
 *
 * Strictly read-only: fetches `origin` refs without touching working trees,
 * queries GitHub PRs, opens `runtime.db` in `{ readonly: true }` mode, and
 * reads held tickets via `heldForRepo` without issuing any write mutations.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  artifactsRoot,
  dbPath,
  FACTORY_ROOT,
} from "../event-runtime/lib/config.mjs";
import { findRepoForPath, loadRepos } from "../event-runtime/lib/repos.mjs";
import { EVENTS_FILE, sessionsFromEvents } from "../lib/factory-state.mjs";
import { heldForRepo } from "./digest.mjs";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const OVERNIGHT_HOURS = 14;
const DEFAULT_HOURS = 24;
const LAST_SESSION_MAX_AGE_MS = 7 * DAY_MS;
const ACTIVE_SESSION_GRACE_MS = 5 * MINUTE_MS;
const EXEC_TIMEOUT_MS = 30_000;

const DURATION_UNITS_MS = Object.freeze({
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
});

const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

const HEX64_PATTERN = /^[0-9a-f]{64}$/i;
const ARTIFACT_URL_PATTERN = /\/api\/artifacts\/([0-9a-f]{64})/gi;
const FIXES_PATTERN =
  /\bfixes:?\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|[A-Z][A-Z0-9]{1,9}-\d+)\b/gi;
const UX_CRITIQUE_LINE_PATTERN = /^\s*-\s*UX critique:\s*(.+?)\s*$/im;
const RISKS_LINE_PATTERN = /^\s*-\s*Risks:\s*(.+?)\s*$/im;
const TRIVIAL_RISKS_PATTERN = /^none(\s+known)?\.?$/i;

const HIGH_SIGNAL_INBOX_KINDS = new Set([
  "ESCALATED",
  "CI RED",
  "SMOKE RED",
  "CIRCUIT BREAKER",
  "RC READY",
]);

const USAGE = `factory recap — read-only operator delta catch-up and decision collector

Usage:
  factory recap [options]

Options:
  --repo <name>     Scope to repo name (repeatable or comma-separated; defaults
                    to repo matching cwd, else all configured repos)
  --all             Collect across all configured repos regardless of cwd
  --since <window>  Time window: "overnight" (14h), <N><m|h|d|w> (e.g. 30m, 12h,
                    7d, 2w), or an ISO-8601 timestamp (defaults to last session
                    if within 7d, else 24h)
  --json            Emit JSON document
  -h, --help        Show this help message and exit
`;

function toValidDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  }
  return date;
}

function isStrictIsoTimestamp(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!ISO_DATE_PATTERN.test(trimmed)) return false;
  const datePart = trimmed.slice(0, 10);
  const [yearStr, monthStr, dayStr] = datePart.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const checkUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    checkUtc.getUTCFullYear() !== year ||
    checkUtc.getUTCMonth() + 1 !== month ||
    checkUtc.getUTCDate() !== day
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(trimmed));
}

/**
 * Resolve a human or ISO `--since` window into `{ sinceIso, label }`.
 */
export function parseSinceWindow(
  input,
  { now = new Date(), lastSessionIso = null } = {},
) {
  const nowDate = toValidDate(now, "now");
  const nowMs = nowDate.getTime();

  if (input === undefined || input === null || String(input).trim() === "") {
    if (
      typeof lastSessionIso === "string" &&
      isStrictIsoTimestamp(lastSessionIso)
    ) {
      const sessionMs = Date.parse(lastSessionIso.trim());
      const ageMs = nowMs - sessionMs;
      if (ageMs >= 0 && ageMs <= LAST_SESSION_MAX_AGE_MS) {
        const sinceIso = new Date(sessionMs).toISOString();
        return {
          sinceIso,
          label: `since last session (${sinceIso})`,
        };
      }
    }
    const sinceIso = new Date(nowMs - DEFAULT_HOURS * HOUR_MS).toISOString();
    return { sinceIso, label: `last ${DEFAULT_HOURS}h` };
  }

  const raw = String(input).trim();
  if (raw.toLowerCase() === "overnight") {
    const sinceIso = new Date(nowMs - OVERNIGHT_HOURS * HOUR_MS).toISOString();
    return { sinceIso, label: `overnight (${OVERNIGHT_HOURS}h)` };
  }

  const relMatch = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(raw);
  if (relMatch) {
    const amount = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const unitMs = DURATION_UNITS_MS[unit];
    if (!Number.isFinite(amount) || amount <= 0 || !unitMs) {
      throw new Error(`invalid relative duration: ${JSON.stringify(input)}`);
    }
    const sinceIso = new Date(nowMs - amount * unitMs).toISOString();
    return { sinceIso, label: `last ${relMatch[1]}${unit}` };
  }

  if (isStrictIsoTimestamp(raw)) {
    const sinceIso = new Date(Date.parse(raw)).toISOString();
    return { sinceIso, label: `since ${sinceIso}` };
  }

  throw new Error(
    `invalid --since window ${JSON.stringify(input)} (expected "overnight", <N><m|h|d|w>, or an ISO-8601 timestamp)`,
  );
}

/**
 * Parse PR body / `## Handoff` block for `Fixes`, `UX critique`, non-trivial
 * `Risks` engineering assumptions, and `/api/artifacts/<sha256>` hashes.
 */
export function parseHandoffSignals(text) {
  if (typeof text !== "string" || text.length === 0) {
    return {
      fixes: [],
      uxCritique: null,
      risks: null,
      hasAssumptions: false,
      artifactHashes: [],
    };
  }

  const fixesSet = new Set();
  for (const match of text.matchAll(FIXES_PATTERN)) {
    const token = match[1];
    if (!token) continue;
    if (token.startsWith("#") || token.includes("#")) {
      fixesSet.add(token);
    } else {
      fixesSet.add(token.toUpperCase());
    }
  }

  const uxMatch = UX_CRITIQUE_LINE_PATTERN.exec(text);
  const uxCritique = uxMatch?.[1]?.trim() || null;

  let risks = null;
  let hasAssumptions = false;
  const risksMatch = RISKS_LINE_PATTERN.exec(text);
  if (risksMatch?.[1]) {
    const trimmed = risksMatch[1].trim();
    const unquoted = trimmed.replace(/^`|`$/g, "").trim();
    if (unquoted.length > 0 && !TRIVIAL_RISKS_PATTERN.test(unquoted)) {
      risks = trimmed;
      hasAssumptions = true;
    }
  }

  const artifactSet = new Set();
  for (const match of text.matchAll(ARTIFACT_URL_PATTERN)) {
    if (match[1]) artifactSet.add(match[1].toLowerCase());
  }

  return {
    fixes: [...fixesSet],
    uxCritique,
    risks,
    hasAssumptions,
    artifactHashes: [...artifactSet],
  };
}

/**
 * Bucket repo-relative changed paths into operator mental-model categories.
 */
export function classifyMentalModelPaths(filePaths) {
  const buckets = {
    schema: [],
    api: [],
    config: [],
    decisions: [],
    harness: [],
  };

  if (!Array.isArray(filePaths)) return buckets;

  const seen = new Set();
  for (const rawPath of filePaths) {
    if (typeof rawPath !== "string") continue;
    const normalized = rawPath
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    if (
      /(^|\/)migrations?(\/|$)/i.test(normalized) ||
      /(^|\/)schema\.prisma$/i.test(normalized) ||
      /(^|\/)prisma\//i.test(normalized) ||
      /(^|\/)db\.mjs$/i.test(normalized) ||
      /\.sql$/i.test(normalized)
    ) {
      buckets.schema.push(normalized);
    }

    if (
      /(^|\/)server\/api\//i.test(normalized) ||
      /(^|\/)api\//i.test(normalized) ||
      /(^|\/)routes\//i.test(normalized) ||
      /(^|\/)graphql(\/|\.|-|_|$)/i.test(normalized) ||
      /\.graphqls?$/i.test(normalized) ||
      /openapi/i.test(normalized)
    ) {
      buckets.api.push(normalized);
    }

    if (
      /(^|\/)config\//i.test(normalized) ||
      /^\.github\/workflows\//i.test(normalized) ||
      /(^|\/)Dockerfile(\..+)?$/i.test(normalized) ||
      /(^|\/)docker-compose[^/]*$/i.test(normalized) ||
      /(^|\/)deploy\//i.test(normalized)
    ) {
      buckets.config.push(normalized);
    }

    if (
      /(^|\/)docs\/product-decisions\.md$/i.test(normalized) ||
      /(^|\/)docs\/adr(\/|$)/i.test(normalized) ||
      /(^|\/)adr(\/|-|_|\d)/i.test(normalized) ||
      /\bADR\b/.test(normalized)
    ) {
      buckets.decisions.push(normalized);
    }

    if (
      /^shared\//i.test(normalized) ||
      /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/.test(normalized) ||
      /^plugins\/core\//i.test(normalized)
    ) {
      buckets.harness.push(normalized);
    }
  }

  return buckets;
}

function safeJsonParse(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function defaultExec(cmd) {
  try {
    const proc = Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: EXEC_TIMEOUT_MS,
    });
    return {
      status: proc.exitCode ?? (proc.success ? 0 : 1),
      stdout: proc.stdout ? Buffer.from(proc.stdout).toString("utf8") : "",
      stderr: proc.stderr ? Buffer.from(proc.stderr).toString("utf8") : "",
    };
  } catch (err) {
    return {
      status: 1,
      stdout: "",
      stderr: err?.message ? String(err.message) : String(err),
    };
  }
}

function normalizeReposRegistry(reposMap, root) {
  const source = reposMap ?? loadRepos({ root });
  const out = new Map();
  const entries =
    source instanceof Map
      ? [...source.entries()]
      : Object.entries(source ?? {});
  for (const [name, cfg] of entries) {
    if (!cfg || typeof cfg !== "object") continue;
    out.set(name, {
      ...cfg,
      name: cfg.name ?? name,
      path: cfg.path ?? null,
      github: cfg.github ?? null,
      base: cfg.base ?? "main",
      deployBranch: cfg.deploy_branch ?? cfg.deployBranch ?? null,
    });
  }
  return out;
}

function resolveArtifact(sha256, artifactsDir) {
  if (typeof sha256 !== "string" || !HEX64_PATTERN.test(sha256)) {
    return { sha256: String(sha256 ?? ""), localPath: null };
  }
  const lower = sha256.toLowerCase();
  if (!artifactsDir) return { sha256: lower, localPath: null };
  const candidate = path.join(artifactsDir, lower);
  return {
    sha256: lower,
    localPath: existsSync(candidate) ? candidate : null,
  };
}

/**
 * Scan `~/.factory/state/events.jsonl` read-only for the most recent prior
 * session timestamp (`<= now`).
 */
export function readLastSessionIso({
  eventsFile = EVENTS_FILE,
  repoNames = null,
  now = new Date(),
} = {}) {
  try {
    if (!eventsFile || !existsSync(eventsFile)) return null;
    const nowMs = toValidDate(now, "now").getTime();
    const repoFilter =
      Array.isArray(repoNames) && repoNames.length > 0
        ? new Set(repoNames)
        : null;
    const events = readFileSync(eventsFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => safeJsonParse(line))
      .filter(
        (ev) =>
          ev &&
          typeof ev.ts === "string" &&
          Number.isFinite(Date.parse(ev.ts)) &&
          Date.parse(ev.ts) <= nowMs &&
          (!repoFilter || !ev.repo || repoFilter.has(ev.repo)),
      );
    if (!events.length) return null;

    const sessions = sessionsFromEvents(events).filter((s) =>
      Number.isFinite(s.lastAt),
    );
    if (sessions.length >= 2) {
      const newest = sessions[sessions.length - 1];
      if (nowMs - newest.startedAt < ACTIVE_SESSION_GRACE_MS) {
        const previous = sessions[sessions.length - 2];
        return new Date(previous.lastAt).toISOString();
      }
    }
    if (sessions.length >= 1) {
      return new Date(sessions[sessions.length - 1].lastAt).toISOString();
    }

    const latestTs = Math.max(...events.map((ev) => Date.parse(ev.ts)));
    return Number.isFinite(latestTs) ? new Date(latestTs).toISOString() : null;
  } catch {
    return null;
  }
}

function parseGitLogCommits(stdout) {
  const commits = [];
  const changedFiles = [];
  let current = null;

  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    if (rawLine.startsWith("COMMIT\t")) {
      const parts = rawLine.split("\t");
      current = {
        sha: parts[1] ?? "",
        subject: parts[2] ?? "",
        committedAt: parts[3] ?? "",
        files: [],
      };
      commits.push(current);
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    changedFiles.push(trimmed);
    if (current) current.files.push(trimmed);
  }

  return { commits, changedFiles };
}

function enrichPr(pr, artifactsDir) {
  const handoff = parseHandoffSignals(pr?.body ?? "");
  const resolvedArtifacts = handoff.artifactHashes.map((sha256) =>
    resolveArtifact(sha256, artifactsDir),
  );
  return {
    ...pr,
    handoff,
    resolvedArtifacts,
  };
}

function extractQuestionText(question) {
  if (!question) return null;
  if (typeof question === "string") return question.trim() || null;
  if (typeof question === "object" && typeof question.body === "string") {
    return question.body.trim() || null;
  }
  return null;
}

function readRuntimeSnapshot({
  dbFile,
  artifactsDir,
  sinceIso,
  repoFilterSet,
}) {
  if (!dbFile || !existsSync(dbFile)) {
    return {
      status: "unavailable",
      runs: [],
      uxScreenshots: [],
      inboxItems: [],
      olderOpenInboxCount: 0,
    };
  }
  if (existsSync(`${dbFile}-wal`) && !existsSync(`${dbFile}-shm`)) {
    return {
      status: "unavailable",
      error: "WAL present without -shm index",
      runs: [],
      uxScreenshots: [],
      inboxItems: [],
      olderOpenInboxCount: 0,
    };
  }

  let db = null;
  try {
    db = new Database(dbFile, { readonly: true });
    const tables = new Set(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const colsOf = (table) => {
      if (!tables.has(table)) return new Set();
      return new Set(
        db
          .query(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name),
      );
    };

    const runs = [];
    const excludedRunIds = new Set();
    try {
      const runCols = colsOf("runs");
      if (runCols.size > 0) {
        const tsCol = runCols.has("updated_at")
          ? "updated_at"
          : runCols.has("created_at")
            ? "created_at"
            : null;
        const rows = tsCol
          ? db
              .query(
                `SELECT * FROM runs WHERE ${tsCol} >= ? ORDER BY ${tsCol} DESC LIMIT 200`,
              )
              .all(sinceIso)
          : db.query("SELECT * FROM runs LIMIT 200").all();
        for (const row of rows) {
          const spec = row.spec_json ? safeJsonParse(row.spec_json) : null;
          const runId = row.id ?? row.run_id ?? null;
          const projectTag =
            row.project_tag ??
            spec?.repo ??
            spec?.project ??
            spec?.input?.repo ??
            null;
          if (repoFilterSet && projectTag && !repoFilterSet.has(projectTag)) {
            if (runId) excludedRunIds.add(runId);
            continue;
          }
          runs.push({
            id: runId,
            agentId: row.agent_id ?? spec?.agent ?? spec?.agentId ?? null,
            status: row.status ?? row.state ?? null,
            projectTag,
            createdAt: row.created_at ?? null,
            updatedAt: row.updated_at ?? row.created_at ?? null,
          });
        }
      }
    } catch {
      /* independent table resilience */
    }

    const uxScreenshots = [];
    try {
      const resCols = colsOf("results");
      if (resCols.size > 0 && resCols.has("result_json")) {
        const tsCol = resCols.has("created_at")
          ? "created_at"
          : resCols.has("accepted_at")
            ? "accepted_at"
            : null;
        const rows = tsCol
          ? db
              .query(
                `SELECT * FROM results WHERE ${tsCol} >= ? ORDER BY ${tsCol} DESC LIMIT 200`,
              )
              .all(sinceIso)
          : db.query("SELECT * FROM results LIMIT 200").all();
        const seenShots = new Set();
        for (const row of rows) {
          if (row.run_id && excludedRunIds.has(row.run_id)) continue;
          const parsed = safeJsonParse(row.result_json);
          const artifacts = Array.isArray(parsed?.artifacts)
            ? parsed.artifacts
            : [];
          for (const art of artifacts) {
            if (art?.kind !== "ux-screenshot" || !art?.sha256) continue;
            const resolved = resolveArtifact(art.sha256, artifactsDir);
            const dedupeKey = `${row.run_id ?? ""}:${resolved.sha256}`;
            if (seenShots.has(dedupeKey)) continue;
            seenShots.add(dedupeKey);
            uxScreenshots.push({
              runId: row.run_id ?? null,
              sha256: resolved.sha256,
              localPath: resolved.localPath,
              mediaType: art.mediaType ?? null,
              label: art.label ?? null,
              createdAt: tsCol ? (row[tsCol] ?? null) : null,
            });
          }
        }
      }
    } catch {
      /* independent table resilience */
    }

    const inboxItems = [];
    let olderOpenInboxCount = 0;
    try {
      const inboxCols = colsOf("inbox_items");
      if (inboxCols.size > 0) {
        let sql = "SELECT * FROM inbox_items";
        if (inboxCols.has("status")) {
          sql += " WHERE status = 'open'";
        } else if (inboxCols.has("resolved_at")) {
          sql += " WHERE resolved_at IS NULL";
        }
        if (inboxCols.has("created_at")) {
          sql += " ORDER BY created_at DESC";
        }
        sql += " LIMIT 200";
        const rows = db.query(sql).all();
        for (const row of rows) {
          const refs = row.refs_json ? safeJsonParse(row.refs_json) : null;
          const projectTag =
            row.project_tag ?? refs?.repo ?? refs?.project ?? null;
          if (repoFilterSet && projectTag && !repoFilterSet.has(projectTag)) {
            continue;
          }
          if (
            row.created_at &&
            Number.isFinite(Date.parse(row.created_at)) &&
            Date.parse(row.created_at) < Date.parse(sinceIso)
          ) {
            olderOpenInboxCount += 1;
            continue;
          }
          inboxItems.push({
            id: row.id ?? null,
            kind: row.kind ?? "UNKNOWN",
            status: row.status ?? (row.resolved_at ? "resolved" : "open"),
            title: row.title ?? "",
            summary: row.summary ?? row.body ?? null,
            projectTag,
            createdAt: row.created_at ?? null,
          });
        }
      }
    } catch {
      /* independent table resilience */
    }

    return {
      status: "ok",
      runs,
      uxScreenshots,
      inboxItems,
      olderOpenInboxCount,
    };
  } catch (err) {
    return {
      status: "unavailable",
      error: err?.message ? String(err.message) : String(err),
      runs: [],
      uxScreenshots: [],
      inboxItems: [],
      olderOpenInboxCount: 0,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

function normalizeInboxKind(kind) {
  return String(kind ?? "")
    .trim()
    .replace(/_/g, " ")
    .toUpperCase();
}

function buildAttentionNeeded({ repos, inboxItems }) {
  const entries = [];

  for (const repo of repos) {
    for (const pr of repo.escalatedPrs) {
      entries.push({
        priority: 1,
        category: "escalated_pr",
        kind: "ESCALATED",
        repo: repo.repo,
        ref: `#${pr.number}`,
        title: pr.title,
        url: pr.url ?? null,
        detail: pr.handoff?.risks ?? null,
      });
    }
  }

  for (const item of inboxItems) {
    const normalizedKind = normalizeInboxKind(item.kind);
    const priority = HIGH_SIGNAL_INBOX_KINDS.has(normalizedKind) ? 2 : 2.5;
    entries.push({
      priority,
      category: "inbox",
      kind: item.kind,
      repo: item.projectTag ?? null,
      ref: item.id,
      title: item.title,
      url: null,
      detail: item.summary ?? null,
    });
  }

  for (const repo of repos) {
    for (const hold of repo.holds) {
      entries.push({
        priority: 3,
        category: "blocked_hold",
        kind: hold.kind ?? "blocked",
        repo: repo.repo,
        ref: hold.identifier ?? null,
        title: hold.title ?? "",
        url: hold.url ?? null,
        detail: extractQuestionText(hold.question),
      });
    }
  }

  entries.sort((a, b) => a.priority - b.priority);
  return entries.map(({ priority: _priority, ...rest }) => rest);
}

function safeDefaultDbFile() {
  try {
    return dbPath();
  } catch {
    return null;
  }
}

function safeDefaultArtifactsDir() {
  try {
    return artifactsRoot();
  } catch {
    return null;
  }
}

/**
 * Collect the read-only operator recap across git `origin/<base>`, GitHub PRs,
 * local content-addressed artifacts, `event-runtime` SQLite, and tracker holds.
 */
export async function collectRecap({
  repoNames,
  since,
  now = new Date(),
  root = FACTORY_ROOT,
  reposMap,
  exec = defaultExec,
  dbFile,
  artifactsDir,
  lastSessionIso,
  loadHolds,
  eventsFile = EVENTS_FILE,
} = {}) {
  const nowDate = toValidDate(now, "now");
  const registry = normalizeReposRegistry(reposMap, root);

  const selectedNames =
    Array.isArray(repoNames) && repoNames.length > 0
      ? repoNames
      : [...registry.keys()];

  for (const name of selectedNames) {
    if (!registry.has(name)) {
      throw new Error(
        `unknown repo "${name}" (configured: ${[...registry.keys()].join(", ") || "none"})`,
      );
    }
  }

  const resolvedLastSessionIso =
    lastSessionIso !== undefined
      ? lastSessionIso
      : readLastSessionIso({
          eventsFile,
          repoNames:
            Array.isArray(repoNames) && repoNames.length > 0 ? repoNames : null,
          now: nowDate,
        });

  const window = parseSinceWindow(since, {
    now: nowDate,
    lastSessionIso: resolvedLastSessionIso,
  });
  const { sinceIso } = window;

  const resolvedDbFile = dbFile !== undefined ? dbFile : safeDefaultDbFile();
  const resolvedArtifactsDir =
    artifactsDir !== undefined ? artifactsDir : safeDefaultArtifactsDir();

  const holdsLoader =
    loadHolds ??
    (async (_name, cfg) => {
      const items = await heldForRepo(cfg);
      return { status: "ok", items };
    });

  const repos = [];
  for (const name of selectedNames) {
    const cfg = registry.get(name);
    const base = cfg.base ?? "main";
    const deployBranch = cfg.deployBranch;

    let freshness = "unknown";
    let baseSha = null;
    let baseRef = `origin/${base}`;
    let unshippedCommits = null;
    let commits = [];
    let mentalModelSignals = classifyMentalModelPaths([]);

    if (cfg.path) {
      const fetchRes = exec([
        "git",
        "-C",
        cfg.path,
        "fetch",
        "--quiet",
        "origin",
      ]);
      if (fetchRes && fetchRes.status === 0) {
        const revRes = exec([
          "git",
          "-C",
          cfg.path,
          "rev-parse",
          `origin/${base}`,
        ]);
        if (revRes && revRes.status === 0) {
          freshness = "clean";
          baseSha = revRes.stdout.trim() || null;
          baseRef = baseSha
            ? `origin/${base}@${baseSha.slice(0, 8)}`
            : `origin/${base}`;

          if (deployBranch && deployBranch !== base) {
            const countRes = exec([
              "git",
              "-C",
              cfg.path,
              "rev-list",
              "--count",
              `origin/${deployBranch}..origin/${base}`,
            ]);
            if (countRes && countRes.status === 0) {
              const parsedCount = Number.parseInt(countRes.stdout.trim(), 10);
              unshippedCommits = Number.isFinite(parsedCount)
                ? parsedCount
                : null;
            }
          } else if (deployBranch && deployBranch === base) {
            unshippedCommits = 0;
          }

          const logRes = exec([
            "git",
            "-C",
            cfg.path,
            "log",
            `origin/${base}`,
            `--since=${sinceIso}`,
            "--name-only",
            "--pretty=format:COMMIT%x09%h%x09%s%x09%cI",
          ]);
          if (logRes && logRes.status === 0) {
            const parsedLog = parseGitLogCommits(logRes.stdout);
            commits = parsedLog.commits;
            mentalModelSignals = classifyMentalModelPaths(
              parsedLog.changedFiles,
            );
          }
        }
      }
    }

    let prsStatus = "unavailable";
    let mergedPrs = [];
    let escalatedPrs = [];
    if (cfg.github) {
      const mergedRes = exec([
        "gh",
        "pr",
        "list",
        "--repo",
        cfg.github,
        "--base",
        base,
        "--state",
        "merged",
        "--search",
        `merged:>=${sinceIso}`,
        "--limit",
        "50",
        "--json",
        "number,title,url,mergedAt,body",
      ]);
      const escalatedRes = exec([
        "gh",
        "pr",
        "list",
        "--repo",
        cfg.github,
        "--base",
        base,
        "--state",
        "open",
        "--label",
        "escalated",
        "--limit",
        "30",
        "--json",
        "number,title,url,body,labels",
      ]);

      const mergedParsed =
        mergedRes?.status === 0 ? safeJsonParse(mergedRes.stdout) : null;
      const escalatedParsed =
        escalatedRes?.status === 0 ? safeJsonParse(escalatedRes.stdout) : null;

      if (Array.isArray(mergedParsed) && Array.isArray(escalatedParsed)) {
        prsStatus = "ok";
        mergedPrs = mergedParsed.map((pr) =>
          enrichPr(pr, resolvedArtifactsDir),
        );
        escalatedPrs = escalatedParsed.map((pr) =>
          enrichPr(pr, resolvedArtifactsDir),
        );
      } else {
        prsStatus = "unknown";
        if (Array.isArray(mergedParsed)) {
          mergedPrs = mergedParsed.map((pr) =>
            enrichPr(pr, resolvedArtifactsDir),
          );
        }
        if (Array.isArray(escalatedParsed)) {
          escalatedPrs = escalatedParsed.map((pr) =>
            enrichPr(pr, resolvedArtifactsDir),
          );
        }
      }
    }

    let holdsStatus = "ok";
    let holds = [];
    try {
      const rawHolds = await holdsLoader(name, cfg);
      if (Array.isArray(rawHolds)) {
        holds = rawHolds;
      } else if (rawHolds && typeof rawHolds === "object") {
        holdsStatus = rawHolds.status ?? "ok";
        holds = Array.isArray(rawHolds.items) ? rawHolds.items : [];
      }
    } catch {
      holdsStatus = "unknown";
      holds = [];
    }

    repos.push({
      repo: name,
      github: cfg.github,
      base,
      deployBranch,
      freshness,
      baseRef,
      baseSha,
      unshippedCommits,
      commits,
      mentalModelSignals,
      prsStatus,
      mergedPrs,
      escalatedPrs,
      holdsStatus,
      holds,
    });
  }

  const repoFilterSet =
    Array.isArray(repoNames) && repoNames.length > 0
      ? new Set(selectedNames)
      : null;

  const runtime = readRuntimeSnapshot({
    dbFile: resolvedDbFile,
    artifactsDir: resolvedArtifactsDir,
    sinceIso,
    repoFilterSet,
  });

  const attentionNeeded = buildAttentionNeeded({
    repos,
    inboxItems: runtime.inboxItems,
  });

  return {
    generatedAt: nowDate.toISOString(),
    window,
    repos,
    runtime,
    attentionNeeded,
  };
}

/**
 * Infer a configured repo name from `cwd` (matching either its checkout path
 * or its configured `worktreeRoot`), returning `null` when outside all repos.
 */
export function inferRepoFromCwd(reposMap, cwd = process.cwd()) {
  let canonicalCwd = path.resolve(cwd);
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {
    /* keep resolved path */
  }

  if (reposMap instanceof Map) {
    const matched = findRepoForPath(reposMap, canonicalCwd);
    if (matched?.name) return matched.name;
  }

  const entries =
    reposMap instanceof Map
      ? [...reposMap.entries()]
      : Object.entries(reposMap ?? {});

  for (const [name, cfg] of entries) {
    for (const candidateRoot of [
      cfg?.path,
      cfg?.worktreeRoot,
      cfg?.worktree_root,
    ]) {
      if (!candidateRoot) continue;
      let resolvedRoot = path.resolve(candidateRoot);
      try {
        resolvedRoot = realpathSync(candidateRoot);
      } catch {
        /* keep resolved path */
      }
      if (
        canonicalCwd === resolvedRoot ||
        canonicalCwd.startsWith(resolvedRoot + path.sep)
      ) {
        return cfg?.name ?? name;
      }
    }
  }
  return null;
}

/**
 * Parse CLI flags for `factory recap`.
 */
export function parseCliArgs(argv = []) {
  const repoNames = [];
  let all = false;
  let since;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--repo" || arg.startsWith("--repo=")) {
      const value = arg === "--repo" ? argv[++i] : arg.slice("--repo=".length);
      if (!value || value.startsWith("-")) {
        throw new Error("--repo requires a repository name");
      }
      for (const part of value.split(",")) {
        const trimmed = part.trim();
        if (trimmed && !repoNames.includes(trimmed)) repoNames.push(trimmed);
      }
      continue;
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const value =
        arg === "--since" ? argv[++i] : arg.slice("--since=".length);
      if (!value) {
        throw new Error("--since requires a window value");
      }
      since = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { repoNames, all, since, json, help };
}

/**
 * Format a human-readable operator recap from the JSON document.
 */
export function formatRecap(recap) {
  const lines = [];
  lines.push(
    `factory recap — ${recap.window.label} (since ${recap.window.sinceIso})`,
  );

  if (recap.attentionNeeded.length === 0) {
    lines.push("Nothing is waiting on you.");
  } else {
    lines.push(
      `${recap.attentionNeeded.length} call(s) waiting on you right now.`,
    );
  }

  for (const repo of recap.repos) {
    lines.push("");
    const shipNote =
      typeof repo.unshippedCommits === "number" && repo.unshippedCommits > 0
        ? `, ${repo.unshippedCommits} unshipped ahead of ${repo.deployBranch}`
        : "";
    lines.push(
      `[${repo.repo}] freshness=${repo.freshness} (${repo.baseRef}${shipNote}) | prs=${repo.prsStatus}`,
    );

    if (repo.mergedPrs.length > 0) {
      for (const pr of repo.mergedPrs) {
        lines.push(`  merged #${pr.number}: ${pr.title}`);
        if (pr.handoff?.hasAssumptions && pr.handoff.risks) {
          lines.push(`    assumption/risk: ${pr.handoff.risks}`);
        }
        for (const art of pr.resolvedArtifacts ?? []) {
          lines.push(
            `    artifact: ${art.localPath ?? `/api/artifacts/${art.sha256}`}`,
          );
        }
      }
    } else if (repo.commits.length > 0) {
      lines.push(`  ${repo.commits.length} commit(s) on origin/${repo.base}`);
    } else if (repo.freshness === "clean" && repo.prsStatus !== "unknown") {
      lines.push("  no merged changes in window");
    }

    const touchedCategories = Object.entries(repo.mentalModelSignals ?? {})
      .filter(([, paths]) => paths.length > 0)
      .map(([cat, paths]) => `${cat}(${paths.length})`);
    if (touchedCategories.length > 0) {
      lines.push(`  mental-model touchpoints: ${touchedCategories.join(", ")}`);
    }
  }

  if (recap.runtime) {
    lines.push("");
    const olderSuffix =
      recap.runtime.olderOpenInboxCount > 0
        ? ` (${recap.runtime.olderOpenInboxCount} older un-dismissed)`
        : "";
    lines.push(
      `[runtime] status=${recap.runtime.status} | runs=${recap.runtime.runs.length} | screenshots=${recap.runtime.uxScreenshots.length} | open_inbox=${recap.runtime.inboxItems.length}${olderSuffix}`,
    );
    for (const shot of recap.runtime.uxScreenshots) {
      const loc = shot.localPath ?? `/api/artifacts/${shot.sha256}`;
      lines.push(
        `  ux-screenshot${shot.label ? ` (${shot.label})` : ""}: ${loc}`,
      );
    }
  }

  if (recap.attentionNeeded.length > 0) {
    lines.push("");
    lines.push("Calls waiting on you:");
    for (const item of recap.attentionNeeded) {
      const scope = item.repo ? `${item.repo} ` : "";
      const ref = item.ref ? `${item.ref} ` : "";
      lines.push(`  - [${item.kind}] ${scope}${ref}${item.title}`);
      if (item.detail) lines.push(`    ${item.detail}`);
      if (item.url) lines.push(`    ${item.url}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`factory recap: ${err.message}`);
    process.exit(2);
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  try {
    const repos = loadRepos({ root: FACTORY_ROOT });
    let repoNames = parsed.repoNames;
    if (!parsed.all && repoNames.length === 0) {
      const inferred = inferRepoFromCwd(repos, process.cwd());
      if (inferred) repoNames = [inferred];
    }

    const payload = await collectRecap({
      repoNames: repoNames.length > 0 ? repoNames : undefined,
      since: parsed.since,
      reposMap: repos,
    });

    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(formatRecap(payload));
    }
  } catch (err) {
    console.error(`factory recap: ${err?.message ?? err}`);
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
