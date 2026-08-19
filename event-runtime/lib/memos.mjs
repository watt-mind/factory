/**
 * Memo ledger — verified cross-run memory (docs/event-runtime-memos.md §2, §3).
 *
 * Memos are artifacts. Only an accepted result (or the runtime, for inbox
 * decisions) may register one. Reads are by exact subject; liveness is a fold
 * over the ledger, never a directory listing. There is no write API.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { loadRepos } from "./repos.mjs";
import { validate } from "./schema.mjs";

export const MEMO_SCHEMA_VERSION = "factory.memo/v1";
export const MEMO_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory.memo.v1.json"),
    "utf8",
  ),
);

export const MEMO_KINDS = Object.freeze([
  "repo-note",
  "postmortem",
  "decision",
  "flake",
  "handoff",
]);
export const CLAIM_KINDS = Object.freeze(["howto", "pitfall", "fact"]);
export const SUBJECT_TYPES = Object.freeze([
  "repo",
  "ticket",
  "pr",
  "workflow",
  "run",
]);
export const USE_VERDICTS = Object.freeze(["useful", "wrong", "stale"]);
export const LEARNINGS_MAX = 5;
export const BODY_MAX_BYTES = 4 * 1024;
export const EVIDENCE_MAX_BYTES = 1024;
export const LIST_MEMOS_DEFAULT_MAX = 20;

/** Kind-default expiry; a binding.expiresAt always wins (§6.2). */
export const KIND_DEFAULT_TTL_MS = Object.freeze({
  postmortem: 30 * 24 * 60 * 60 * 1000,
  decision: 90 * 24 * 60 * 60 * 1000,
  flake: 14 * 24 * 60 * 60 * 1000,
});

const HEX64 = /^[0-9a-f]{64}$/;
const SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/;

const hasOwn = (obj, key) =>
  obj !== null &&
  typeof obj === "object" &&
  Object.prototype.hasOwnProperty.call(obj, key);

/** Strip an optional `sha256:` prefix; return 64-hex or null. */
export function digestHex(value) {
  if (typeof value !== "string") return null;
  const match = SHA256.exec(value.trim());
  return match ? match[1] : null;
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function loadRepoIndex(repos) {
  if (repos && typeof repos.get === "function") return repos;
  return loadRepos();
}

/**
 * Collapse equivalent subject ids so `WM-313`/`wm-313` and
 * `watt-mind/factory`/`factory` index as one key (§3.1).
 */
export function normalizeSubjectId(type, id, { repos } = {}) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("subject.id must be a non-empty string");
  }
  const raw = id.trim();
  if (type === "ticket") return raw.toUpperCase();
  if (type === "run") return raw;
  if (type === "pr") {
    const hash = raw.lastIndexOf("#");
    if (hash > 0) {
      return `${normalizeSubjectId("repo", raw.slice(0, hash), { repos })}#${raw.slice(hash + 1)}`;
    }
    return raw;
  }
  if (type === "workflow") {
    const colon = raw.lastIndexOf(":");
    if (colon > 0) {
      return `${raw.slice(0, colon).toLowerCase()}:${raw.slice(colon + 1)}`;
    }
    return raw.toLowerCase();
  }
  if (type === "repo") {
    const loaded = loadRepoIndex(repos);
    const lower = raw.toLowerCase();
    for (const repo of loaded.values()) {
      if (repo.name.toLowerCase() === lower) return repo.name;
      const github = typeof repo.github === "string" ? repo.github : "";
      if (github && github.toLowerCase() === lower) return repo.name;
      const slug = github.includes("/")
        ? github.slice(github.lastIndexOf("/") + 1).toLowerCase()
        : "";
      if (slug && slug === lower) return repo.name;
    }
    return lower;
  }
  throw new Error(`unknown subject type ${type}`);
}

export function normalizeSubject(subject, options) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    throw new Error("subject must be { type, id }");
  }
  if (!SUBJECT_TYPES.includes(subject.type)) {
    throw new Error(`unknown subject type ${subject.type}`);
  }
  return {
    type: subject.type,
    id: normalizeSubjectId(subject.type, subject.id, options),
  };
}

function emittedKinds(def) {
  const listed = def?.emits?.memos;
  if (!Array.isArray(listed)) return [];
  return listed.filter((kind) => typeof kind === "string" && kind.length > 0);
}

/**
 * Shape + kind-specific rules. JSON Schema cannot express the conditionals
 * (`claim` on repo-note, `precedentOnly` on decision); those live here, the
 * same way `lib/decision.mjs` owns rules the schema cannot say.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMemo(
  document,
  { allowProvenance = false, at = "$" } = {},
) {
  const errors = [];
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    return { valid: false, errors: [`${at}: expected object`] };
  }
  const shape = validate(MEMO_SCHEMA, document);
  errors.push(...shape.errors);
  if (!shape.valid) return { valid: false, errors };

  if (hasOwn(document, "provenance") && !allowProvenance) {
    errors.push(`${at}.provenance: agent-supplied provenance is rejected`);
  }
  const bodyBytes = byteLength(document.body);
  if (bodyBytes > BODY_MAX_BYTES) {
    errors.push(`${at}.body: ${bodyBytes} bytes > ${BODY_MAX_BYTES}`);
  }
  if (document.kind === "repo-note") {
    if (!hasOwn(document, "claim")) {
      errors.push(`${at}: repo-note requires claim`);
    }
    if (!hasOwn(document, "evidence")) {
      errors.push(`${at}: repo-note requires evidence`);
    } else if (byteLength(document.evidence) > EVIDENCE_MAX_BYTES) {
      errors.push(
        `${at}.evidence: ${byteLength(document.evidence)} bytes > ${EVIDENCE_MAX_BYTES}`,
      );
    }
  }
  if (document.kind === "decision" && document.precedentOnly !== true) {
    errors.push(`${at}: decision memos require precedentOnly: true`);
  }
  if (
    document.supersedes !== undefined &&
    document.supersedes !== null &&
    !digestHex(document.supersedes)
  ) {
    errors.push(`${at}.supersedes: not a sha256 digest`);
  }
  return { valid: errors.length === 0, errors };
}

export function memoDigest(document) {
  return sha256Hex(canonicalJson(document));
}

export function withProvenance(document, { runId, agent, createdAt }) {
  const provenance = {
    agent,
    createdAt,
    ...(runId === undefined || runId === null ? { runId: null } : { runId }),
  };
  return { ...document, provenance };
}

function expiresAtMs(document, createdAtMs) {
  const binding = document.bindings?.expiresAt;
  if (typeof binding === "string" && binding.trim()) {
    const parsed = Date.parse(binding);
    if (!Number.isFinite(parsed)) {
      throw new Error(`bindings.expiresAt is not a valid time: ${binding}`);
    }
    return parsed;
  }
  const ttl = KIND_DEFAULT_TTL_MS[document.kind];
  return ttl === undefined ? null : createdAtMs + ttl;
}

function inboxItemIdOf(document) {
  const id = document.refs?.inboxItemId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Register memos from an accepted result (or a runtime-authored document).
 * Idempotent on `sha256`. `runId` is the producer run; pass `null` for
 * runtime-authored decision memos.
 */
export function registerMemos(
  db,
  runId,
  result,
  { now = Date.now(), agent, runState = "COMPLETED" } = {},
) {
  const entries = collectRegisterEntries(result, { runId, agent, now });
  const registered = [];
  for (const entry of entries) {
    registered.push(insertMemoRow(db, entry, { now }));
  }
  recordMemoUses(db, runId, result, { now, runState });
  return registered;
}

function collectRegisterEntries(result, { runId, agent, now }) {
  const listed = [];
  const seen = new Set();
  const push = (sha256, document) => {
    if (!HEX64.test(sha256) || seen.has(sha256)) return;
    seen.add(sha256);
    listed.push({ sha256, document });
  };
  for (const entry of result?.memos ?? []) {
    if (typeof entry === "string") continue;
    if (entry && typeof entry === "object" && entry.document) {
      const sha = digestHex(entry.sha256) ?? memoDigest(entry.document);
      push(sha, entry.document);
      continue;
    }
    if (entry && typeof entry === "object" && entry.schemaVersion) {
      push(memoDigest(entry), entry);
    }
  }
  for (const artifact of result?.artifacts ?? []) {
    if (artifact?.kind !== "memo") continue;
    const sha = digestHex(artifact.sha256);
    if (!sha) continue;
    if (artifact.document) push(sha, artifact.document);
  }
  if (
    result &&
    typeof result === "object" &&
    result.schemaVersion === MEMO_SCHEMA_VERSION
  ) {
    const prepared =
      result.provenance !== undefined
        ? result
        : withProvenance(result, {
            runId,
            agent: agent ?? "runtime:inbox",
            createdAt: new Date(now).toISOString(),
          });
    push(memoDigest(prepared), prepared);
  }
  return listed;
}

function insertMemoRow(db, { sha256, document }, { now }) {
  const check = validateMemo(document, { allowProvenance: true });
  if (!check.valid) {
    throw new Error(
      `memo ${sha256} failed contract: ${check.errors.join("; ")}`,
    );
  }
  const subject = normalizeSubject(document.subject);
  const createdAt = Date.parse(document.provenance?.createdAt ?? "") || now;
  const expiresAt = expiresAtMs(document, createdAt);
  const descriptionHash = document.bindings?.descriptionHash ?? null;
  const headSha = document.bindings?.headSha ?? null;
  const supersedes = digestHex(document.supersedes);
  const existing = db
    .query(`SELECT sha256 FROM memos WHERE sha256 = ?`)
    .get(sha256);
  if (existing)
    return { sha256, inserted: false, subject, kind: document.kind };
  db.query(
    `INSERT INTO memos (
       sha256, subject_type, subject_id, kind, run_id, inbox_item_id,
       created_at, expires_at, description_hash, head_sha
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256,
    subject.type,
    subject.id,
    document.kind,
    document.provenance?.runId ?? null,
    inboxItemIdOf(document),
    createdAt,
    expiresAt,
    descriptionHash,
    headSha,
  );
  if (supersedes) {
    db.query(
      `UPDATE memos SET superseded_by = ?
       WHERE sha256 = ? AND superseded_by IS NULL`,
    ).run(sha256, supersedes);
  }
  return { sha256, inserted: true, subject, kind: document.kind };
}

/**
 * Write `memo_uses` for every pinned memo (verdict NULL) and overlay the
 * agent's `usedMemos` verdicts. Two distinct `wrong` verdicts retire the
 * memo as contradicted.
 */
export function recordMemoUses(
  db,
  runId,
  result,
  { now = Date.now(), runState = "COMPLETED" } = {},
) {
  if (!runId) return [];
  const pinEntries = result?.memoPin?.entries ?? [];
  const pinned = new Map();
  for (const entry of pinEntries) {
    const sha = digestHex(entry?.sha256 ?? entry);
    if (sha) pinned.set(sha, null);
  }
  const used = result?.usedMemos ?? [];
  if (!Array.isArray(used)) {
    throw new Error("usedMemos must be an array");
  }
  for (const entry of used) {
    const sha = digestHex(entry?.sha256);
    if (!sha) throw new Error("usedMemos entry is missing sha256");
    if (entry.verdict !== undefined && !USE_VERDICTS.includes(entry.verdict)) {
      throw new Error(`unknown usedMemos verdict ${entry.verdict}`);
    }
    pinned.set(sha, entry.verdict ?? null);
  }
  const rows = [];
  for (const [sha256, verdict] of pinned) {
    db.query(
      `INSERT INTO memo_uses (sha256, run_id, verdict, run_state, at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sha256, run_id) DO UPDATE SET
         verdict = COALESCE(excluded.verdict, memo_uses.verdict),
         run_state = excluded.run_state,
         at = excluded.at`,
    ).run(sha256, runId, verdict, runState, now);
    rows.push({ sha256, runId, verdict, runState });
    maybeRetireContradicted(db, sha256, now);
  }
  return rows;
}

function maybeRetireContradicted(db, sha256, now) {
  const count = db
    .query(
      `SELECT COUNT(DISTINCT run_id) AS n FROM memo_uses
       WHERE sha256 = ? AND verdict = 'wrong'`,
    )
    .get(sha256)?.n;
  if (Number(count) < 2) return;
  db.query(
    `UPDATE memos SET retired_at = ?, retired_reason = 'contradicted'
     WHERE sha256 = ? AND retired_at IS NULL`,
  ).run(now, sha256);
}

function usefulCounts(db, hashes) {
  const counts = new Map(hashes.map((sha) => [sha, { useful: 0, wrong: 0 }]));
  if (hashes.length === 0) return counts;
  const placeholders = hashes.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT sha256, verdict, COUNT(*) AS n FROM memo_uses
       WHERE sha256 IN (${placeholders}) AND verdict IS NOT NULL
       GROUP BY sha256, verdict`,
    )
    .all(...hashes);
  for (const row of rows) {
    const slot = counts.get(row.sha256);
    if (!slot) continue;
    if (row.verdict === "useful") slot.useful = Number(row.n);
    if (row.verdict === "wrong") slot.wrong = Number(row.n);
  }
  return counts;
}

function bindingHolds(row, { descriptionHash, headSha } = {}) {
  if (
    row.description_hash &&
    descriptionHash !== undefined &&
    descriptionHash !== null &&
    row.description_hash !== descriptionHash
  ) {
    return { holds: false, reason: "description_hash_mismatch" };
  }
  if (
    row.head_sha &&
    headSha !== undefined &&
    headSha !== null &&
    row.head_sha !== headSha
  ) {
    return { holds: false, reason: "head_sha_mismatch" };
  }
  return { holds: true, reason: null };
}

/**
 * Fold memos on a subject. `live: true` (default) drops superseded, retired,
 * expired, and binding-broken rows. Bindings are compared only against
 * values the caller already holds — never a network call (§3.2).
 */
export function listMemos(
  db,
  subject,
  {
    kinds,
    live = true,
    max = LIST_MEMOS_DEFAULT_MAX,
    now = Date.now(),
    descriptionHash,
    headSha,
  } = {},
) {
  const normalized = normalizeSubject(subject);
  const params = [normalized.type, normalized.id];
  let sql = `SELECT * FROM memos WHERE subject_type = ? AND subject_id = ?`;
  if (Array.isArray(kinds) && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    params.push(...kinds);
  }
  const rows = db.query(sql).all(...params);
  const counts = usefulCounts(
    db,
    rows.map((row) => row.sha256),
  );
  const folded = [];
  for (const row of rows) {
    if (live) {
      if (row.superseded_by) continue;
      if (row.retired_at) continue;
      if (row.expires_at !== null && row.expires_at <= now) continue;
      const binding = bindingHolds(row, { descriptionHash, headSha });
      if (!binding.holds) {
        db.query(
          `UPDATE memos SET retired_at = ?, retired_reason = ?
           WHERE sha256 = ? AND retired_at IS NULL`,
        ).run(now, binding.reason, row.sha256);
        continue;
      }
    }
    const tally = counts.get(row.sha256) ?? { useful: 0, wrong: 0 };
    folded.push({
      sha256: row.sha256,
      subject: { type: row.subject_type, id: row.subject_id },
      kind: row.kind,
      runId: row.run_id,
      inboxItemId: row.inbox_item_id,
      createdAt: new Date(row.created_at).toISOString(),
      createdAtMs: row.created_at,
      expiresAt:
        row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      descriptionHash: row.description_hash,
      headSha: row.head_sha,
      supersededBy: row.superseded_by,
      retiredAt:
        row.retired_at === null ? null : new Date(row.retired_at).toISOString(),
      retiredReason: row.retired_reason,
      usefulCount: tally.useful,
      wrongCount: tally.wrong,
    });
  }
  folded.sort((a, b) => {
    if (b.usefulCount !== a.usefulCount) return b.usefulCount - a.usefulCount;
    return b.createdAtMs - a.createdAtMs;
  });
  const limit = Number.isInteger(max) && max > 0 ? max : LIST_MEMOS_DEFAULT_MAX;
  return folded.slice(0, limit);
}

function learningErrors(entry, index) {
  const errors = [];
  const at = `$.learnings[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${at}: expected object`];
  }
  const claim = entry.claim;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    errors.push(`${at}.claim: required`);
  } else {
    if (!CLAIM_KINDS.includes(claim.kind)) {
      errors.push(`${at}.claim.kind: must be howto|pitfall|fact`);
    }
    if (typeof claim.text !== "string" || claim.text.trim() === "") {
      errors.push(`${at}.claim.text: required`);
    } else if (claim.text.length > 280) {
      errors.push(`${at}.claim.text: longer than 280`);
    }
  }
  if (typeof entry.evidence !== "string" || entry.evidence.trim() === "") {
    errors.push(
      `${at}.evidence: required (a learning without evidence is rejected)`,
    );
  } else if (byteLength(entry.evidence) > EVIDENCE_MAX_BYTES) {
    errors.push(
      `${at}.evidence: ${byteLength(entry.evidence)} bytes > ${EVIDENCE_MAX_BYTES}`,
    );
  }
  return errors;
}

/**
 * Turn result `learnings` into `repo-note` memos on the run's repo subject
 * (and, when `def.emits.learningsOnTicket` is set, on its ticket).
 */
export function learningsToMemos(
  learnings,
  { spec, def, now = Date.now(), agent },
) {
  const errors = [];
  if (learnings === undefined || learnings === null) {
    return { errors, memos: [] };
  }
  if (!Array.isArray(learnings)) {
    return { errors: ["$.learnings: expected array"], memos: [] };
  }
  if (learnings.length > LEARNINGS_MAX) {
    return {
      errors: [
        `$.learnings: ${learnings.length} entries > max ${LEARNINGS_MAX}`,
      ],
      memos: [],
    };
  }
  const emitted = emittedKinds(def);
  if (!emitted.includes("repo-note")) {
    return {
      errors: [
        "learnings_not_emitted: definition must declare emits.memos including repo-note",
      ],
      memos: [],
    };
  }
  const repo = spec?.input?.repo;
  if (typeof repo !== "string" || !repo.trim()) {
    return {
      errors: ["learnings_repo_missing: run spec input.repo is required"],
      memos: [],
    };
  }
  for (const [index, entry] of learnings.entries()) {
    errors.push(...learningErrors(entry, index));
  }
  if (errors.length > 0) return { errors, memos: [] };

  const createdAt = new Date(now).toISOString();
  const headSha = spec?.input?.repoPin?.sha ?? spec?.input?.headSha ?? null;
  const subjects = [{ type: "repo", id: normalizeSubjectId("repo", repo) }];
  if (def?.emits?.learningsOnTicket === true && spec?.input?.ticket) {
    subjects.push({
      type: "ticket",
      id: normalizeSubjectId("ticket", spec.input.ticket),
    });
  }
  const memos = [];
  for (const entry of learnings) {
    for (const subject of subjects) {
      const document = withProvenance(
        {
          schemaVersion: MEMO_SCHEMA_VERSION,
          subject,
          kind: "repo-note",
          claim: { kind: entry.claim.kind, text: entry.claim.text },
          evidence: entry.evidence,
          body: entry.claim.text,
          ...(headSha ? { bindings: { headSha } } : {}),
        },
        {
          runId: spec.runId ?? null,
          agent: agent ?? spec.agent ?? "unknown",
          createdAt,
        },
      );
      memos.push({ sha256: memoDigest(document), document });
    }
  }
  return { errors, memos };
}

function inputValues(input, keys) {
  const found = [];
  if (!input || typeof input !== "object") return found;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) found.push(value);
  }
  return found;
}

/**
 * Subjects this run is allowed to write memory about. A ticket memo must
 * name the spec's ticket; a repo memo its repo; a run memo this run or its
 * pinned run; a pr/workflow memo a value present in the input.
 */
export function allowedMemoSubjects(spec, { repos } = {}) {
  const input = spec?.input ?? {};
  const allowed = [];
  const add = (type, id) => {
    try {
      allowed.push(normalizeSubject({ type, id }, { repos }));
    } catch {
      // Malformed optional input is not an extra allowed subject.
    }
  };
  if (typeof input.ticket === "string") add("ticket", input.ticket);
  if (typeof input.repo === "string") add("repo", input.repo);
  if (typeof spec?.runId === "string") add("run", spec.runId);
  if (typeof input.runPin?.runId === "string") add("run", input.runPin.runId);
  for (const pr of inputValues(input, ["pr", "pullRequest"])) add("pr", pr);
  for (const workflow of inputValues(input, ["workflow"]))
    add("workflow", workflow);
  return allowed;
}

export function subjectIsAllowed(subject, spec, options) {
  const got = normalizeSubject(subject, options);
  return allowedMemoSubjects(spec, options).some(
    (allowed) => allowed.type === got.type && allowed.id === got.id,
  );
}

function parseMemoBytes(bytes, origin) {
  try {
    return {
      document: JSON.parse(
        typeof bytes === "string" ? bytes : bytes.toString("utf8"),
      ),
      errors: [],
    };
  } catch (err) {
    return { errors: [`${origin}: invalid JSON — ${err.message}`] };
  }
}

function writeMemoFile(workspaceDir, relative, document) {
  const dest = path.join(workspaceDir, relative);
  mkdirSync(path.dirname(dest), { recursive: true });
  const bytes = canonicalJson(document);
  writeFileSync(dest, bytes);
  return { relative, sha256: sha256Hex(bytes) };
}

function fileUriPath(uri) {
  return typeof uri === "string" && uri.startsWith("file://")
    ? uri.slice("file://".length)
    : null;
}

/**
 * Verify-time collection: validate `kind: memo` artifacts, reject undeclared
 * kinds, check the subject against the run spec, convert `learnings`, and
 * validate `usedMemos` against `memoPin`. Rewrites memo files with runtime
 * provenance so the stored hash is of the complete document.
 */
export function processResultMemos({
  candidate,
  spec,
  def,
  workspaceDir,
  collected,
  now = Date.now(),
}) {
  const errors = [];
  const checks = [];
  const memos = [];
  const emitted = emittedKinds(def);
  const memoArtifacts = (collected ?? []).filter(
    (entry) => entry.kind === "memo",
  );
  const learnings = candidate?.learnings ?? candidate?.artifact?.learnings;
  const usedMemos = candidate?.usedMemos ?? candidate?.artifact?.usedMemos;

  if (memoArtifacts.length > 0 && emitted.length === 0) {
    errors.push(
      "memos_not_emitted: definition must declare emits.memos to produce memo artifacts",
    );
  }

  for (const [index, entry] of memoArtifacts.entries()) {
    const origin =
      fileUriPath(entry.uri) ??
      path.join(workspaceDir, entry.path ?? `memo-${index}`);
    let bytes;
    try {
      bytes = readFileSync(origin);
    } catch {
      errors.push(`artifact_missing: ${origin}`);
      continue;
    }
    const parsed = parseMemoBytes(bytes, `artifacts[${index}]`);
    if (parsed.errors.length) {
      errors.push(...parsed.errors);
      continue;
    }
    const check = validateMemo(parsed.document, { allowProvenance: false });
    if (!check.valid) {
      errors.push(...check.errors);
      continue;
    }
    if (!emitted.includes(parsed.document.kind)) {
      errors.push(
        `memo_kind_not_emitted: ${parsed.document.kind} is not in emits.memos ${JSON.stringify(emitted)}`,
      );
      continue;
    }
    if (!subjectIsAllowed(parsed.document.subject, spec)) {
      errors.push(
        `memo_subject_mismatch: ${parsed.document.subject.type}:${parsed.document.subject.id} is not a subject of this run`,
      );
      continue;
    }
    const document = withProvenance(parsed.document, {
      runId: spec.runId,
      agent: spec.agent ?? def?.ref ?? def?.id ?? "unknown",
      createdAt: new Date(now).toISOString(),
    });
    const relative =
      entry.path ??
      (fileUriPath(entry.uri)
        ? path.relative(workspaceDir, fileUriPath(entry.uri))
        : `memos/${index}.json`);
    const written = writeMemoFile(workspaceDir, relative, document);
    entry.sha256 = written.sha256;
    entry.uri = `file://${path.join(workspaceDir, relative)}`;
    memos.push({ sha256: written.sha256, document, path: relative });
  }

  if (learnings !== undefined) {
    const converted = learningsToMemos(learnings, { spec, def, now });
    if (converted.errors.length) errors.push(...converted.errors);
    for (const [index, memo] of converted.memos.entries()) {
      const relative = `memos/learnings/${index}.json`;
      const written = writeMemoFile(workspaceDir, relative, memo.document);
      collected.push({
        kind: "memo",
        uri: `file://${path.join(workspaceDir, relative)}`,
        sha256: written.sha256,
      });
      memos.push({
        sha256: written.sha256,
        document: memo.document,
        path: relative,
      });
    }
  }

  if (usedMemos !== undefined) {
    if (!Array.isArray(usedMemos)) {
      errors.push("$.usedMemos: expected array");
    } else {
      const pin = new Set(
        (spec.input?.memoPin?.entries ?? []).map((entry) =>
          digestHex(entry.sha256),
        ),
      );
      pin.delete(null);
      for (const [index, entry] of usedMemos.entries()) {
        const sha = digestHex(entry?.sha256);
        if (!sha) {
          errors.push(`$.usedMemos[${index}]: sha256 required`);
          continue;
        }
        if (!pin.has(sha)) {
          errors.push(
            `$.usedMemos[${index}]: ${sha} is not in this run's memoPin`,
          );
        }
        if (
          entry.verdict !== undefined &&
          !USE_VERDICTS.includes(entry.verdict)
        ) {
          errors.push(
            `$.usedMemos[${index}]: unknown verdict ${JSON.stringify(entry.verdict)}`,
          );
        }
      }
    }
  }

  if (memos.length > 0 && errors.length === 0) {
    checks.push("memos_valid", "memo_subject_confined");
  }
  if (learnings !== undefined && errors.length === 0) {
    checks.push("learnings_materialized");
  }
  if (usedMemos !== undefined && errors.length === 0) {
    checks.push("used_memos_pinned");
  }

  return {
    errors,
    memos,
    collected,
    usedMemos: Array.isArray(usedMemos) ? usedMemos : undefined,
    checks,
  };
}
