/**
 * Read-only memo query (docs/event-runtime-memos.md §8, WM-814).
 *
 * `GET /memos?subjectType=&subjectId=&kind=&live=` folds the ledger for one
 * exact subject. There is no write verb — memos enter through accepted runs
 * and inbox decisions. Mount from `createApi` in `api.mjs`.
 */
import { readFileSync } from "node:fs";
import { findArtifact } from "./artifacts.mjs";
import { artifactsRoot } from "./config.mjs";
import {
  LIST_MEMOS_DEFAULT_MAX,
  MEMO_KINDS,
  SUBJECT_TYPES,
  listMemos,
} from "./memos.mjs";

const LIVE_TRUE = new Set(["true", "1"]);
const LIVE_FALSE = new Set(["false", "0"]);

export class MemosQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemosQueryError";
  }
}

function parseLive(raw) {
  if (raw === null || raw === "") return true;
  const value = String(raw).trim().toLowerCase();
  if (LIVE_TRUE.has(value)) return true;
  if (LIVE_FALSE.has(value)) return false;
  throw new MemosQueryError("live must be true or false");
}

function parseMax(raw) {
  if (raw === null || raw === "") return LIST_MEMOS_DEFAULT_MAX;
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1 || max > 500) {
    throw new MemosQueryError("max must be an integer between 1 and 500");
  }
  return max;
}

function parseKinds(raw) {
  if (raw === null || raw === "") return undefined;
  const kinds = String(raw)
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  if (kinds.length === 0) return undefined;
  const unknown = kinds.filter((kind) => !MEMO_KINDS.includes(kind));
  if (unknown.length > 0) {
    throw new MemosQueryError(
      `kind must be one of ${MEMO_KINDS.join(", ")} (got ${unknown.join(", ")})`,
    );
  }
  return kinds;
}

/**
 * Validate and normalise the query string. Throws MemosQueryError on 422.
 *
 * @returns {{ subject: { type: string, id: string }, kinds?: string[], live: boolean, max: number }}
 */
export function parseMemosQuery(searchParams) {
  const subjectType = searchParams.get("subjectType");
  const subjectId = searchParams.get("subjectId");
  if (typeof subjectType !== "string" || subjectType.trim() === "") {
    throw new MemosQueryError("subjectType is required");
  }
  if (typeof subjectId !== "string" || subjectId.trim() === "") {
    throw new MemosQueryError("subjectId is required");
  }
  if (!SUBJECT_TYPES.includes(subjectType)) {
    throw new MemosQueryError(
      `subjectType must be one of ${SUBJECT_TYPES.join(", ")}`,
    );
  }
  return {
    subject: { type: subjectType, id: subjectId.trim() },
    kinds: parseKinds(searchParams.get("kind")),
    live: parseLive(searchParams.get("live")),
    max: parseMax(searchParams.get("max")),
  };
}

function loadMemoDocument(artifactsDir, sha256) {
  const found = findArtifact(artifactsDir, sha256);
  if (!found) return null;
  try {
    const parsed = JSON.parse(readFileSync(found.file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function usesByHash(db, hashes) {
  const grouped = new Map(hashes.map((sha) => [sha, []]));
  if (hashes.length === 0) return grouped;
  const placeholders = hashes.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT sha256, run_id AS runId, verdict, run_state AS runState, at
       FROM memo_uses WHERE sha256 IN (${placeholders})
       ORDER BY at ASC`,
    )
    .all(...hashes);
  for (const row of rows) {
    const list = grouped.get(row.sha256);
    if (!list) continue;
    list.push({
      runId: row.runId,
      verdict: row.verdict,
      runState: row.runState,
      at: new Date(row.at).toISOString(),
    });
  }
  return grouped;
}

function isLiveRow(row, nowMs) {
  if (row.supersededBy) return false;
  if (row.retiredAt) return false;
  if (row.expiresAt !== null && Date.parse(row.expiresAt) <= nowMs)
    return false;
  return true;
}

function memoViewEntry(row, document, uses, nowMs) {
  const provenance = document?.provenance ?? {
    runId: row.runId,
    agent: row.inboxItemId ? "runtime:inbox" : null,
    createdAt: row.createdAt,
  };
  return {
    sha256: row.sha256,
    subject: row.subject,
    kind: row.kind,
    live: isLiveRow(row, nowMs),
    body: typeof document?.body === "string" ? document.body : null,
    claim: document?.claim ?? null,
    evidence: document?.evidence ?? null,
    precedentOnly: document?.precedentOnly === true,
    bindings: document?.bindings ?? {
      ...(row.descriptionHash ? { descriptionHash: row.descriptionHash } : {}),
      ...(row.headSha ? { headSha: row.headSha } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    },
    provenance,
    refs: document?.refs ?? {
      ...(row.inboxItemId ? { inboxItemId: row.inboxItemId } : {}),
      ...(row.runId ? { runId: row.runId } : {}),
    },
    runId: row.runId,
    inboxItemId: row.inboxItemId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    supersededBy: row.supersededBy,
    retiredAt: row.retiredAt,
    retiredReason: row.retiredReason,
    usefulCount: row.usefulCount,
    wrongCount: row.wrongCount,
    uses,
  };
}

/**
 * Fold memos for one subject and attach store bodies + use rows.
 *
 * @returns {{ memos: object[] }}
 */
export function memosView(
  db,
  {
    subject,
    kinds,
    live = true,
    max = LIST_MEMOS_DEFAULT_MAX,
    now,
    artifactsDir,
  },
) {
  const nowMs = now ?? Date.now();
  const rows = listMemos(db, subject, { kinds, live, max, now: nowMs });
  const uses = usesByHash(
    db,
    rows.map((row) => row.sha256),
  );
  return {
    memos: rows.map((row) =>
      memoViewEntry(
        row,
        loadMemoDocument(artifactsDir, row.sha256),
        uses.get(row.sha256) ?? [],
        nowMs,
      ),
    ),
  };
}

export function handleMemosApiRoute({
  route,
  url,
  send,
  db,
  env,
  nowMs,
  artifactsDir,
}) {
  if (route !== "GET /memos") return false;
  try {
    const query = parseMemosQuery(url.searchParams);
    const store = artifactsDir ?? artifactsRoot(env?.home);
    return send(
      200,
      memosView(db, { ...query, now: nowMs, artifactsDir: store }),
    );
  } catch (err) {
    if (err instanceof MemosQueryError)
      return send(422, { error: err.message });
    if (
      err instanceof Error &&
      /unknown subject type|subject\.id/.test(err.message)
    ) {
      return send(422, { error: err.message });
    }
    throw err;
  }
}
