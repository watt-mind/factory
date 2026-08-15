/**
 * Content-addressed artifact store (docs/event-runtime.md §7).
 *
 * The workspace is scratch state and dies with the run; a declared artifact
 * whose bytes died with it would be a hash that can never be re-read — the
 * same disease OPS-206 cured for evidence. At publish time the worker copies
 * every collected artifact into `<home>/artifacts/<sha256>`, keyed by content,
 * so identical bytes are stored once and a result row never references a file
 * that no longer exists.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEX64 = /^[0-9a-f]{64}$/;

/** Compute sha256 hex digest of a file on disk. */
export function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Resolve a store path from a content hash; malformed hashes fail closed. */
export function artifactPath(storeRoot, sha256hex) {
  if (!HEX64.test(sha256hex ?? "")) throw new Error(`invalid artifact hash: ${sha256hex}`);
  return path.join(storeRoot, sha256hex);
}

/**
 * Copy verified artifact entries out of the workspace into the store and
 * return the entries rewritten to their durable location (plus size). Must
 * run BEFORE the workspace is destroyed and before the result row commits —
 * an orphaned store file from a failed transaction is harmless (content-
 * addressed, re-usable); a committed row pointing at a dead file is not.
 *
 * Writes are atomic via a temporary file in the store directory and subsequent
 * rename, and source/destination hashes are verified to prevent corrupted or
 * truncated artifacts from landing in the store (OPS-439).
 */
export function storeCollected({ entries, storeRoot }) {
  if (!entries?.length) return entries ?? [];
  mkdirSync(storeRoot, { recursive: true });
  return entries.map((entry) => {
    const dest = artifactPath(storeRoot, entry.sha256);
    const src = fileURLToPath(entry.uri);
    if (!existsSync(src)) {
      throw new Error(`artifact source does not exist: ${src}`);
    }
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) {
      throw new Error(`cannot store symlinked artifact: ${src}`);
    }
    const srcHash = hashFile(src);
    if (srcHash !== entry.sha256) {
      throw new Error(`artifact source hash mismatch: expected ${entry.sha256}, got ${srcHash}`);
    }
    if (existsSync(dest)) {
      const destHash = hashFile(dest);
      if (destHash === entry.sha256) {
        return { ...entry, uri: `file://${dest}`, sizeBytes: statSync(dest).size };
      }
      rmSync(dest, { force: true });
    }

    const tmpName = `${entry.sha256}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
    const tmpPath = path.join(storeRoot, tmpName);
    try {
      copyFileSync(src, tmpPath);
      const tmpHash = hashFile(tmpPath);
      if (tmpHash !== entry.sha256) {
        throw new Error(`artifact store hash mismatch: expected ${entry.sha256}, got ${tmpHash}`);
      }
      renameSync(tmpPath, dest);
    } finally {
      if (existsSync(tmpPath)) {
        rmSync(tmpPath, { force: true });
      }
    }
    return { ...entry, uri: `file://${dest}`, sizeBytes: statSync(dest).size };
  });
}

/** Locate a stored artifact for serving; null when absent. */
export function findArtifact(storeRoot, sha256hex) {
  if (!HEX64.test(sha256hex ?? "")) return null;
  const file = path.join(storeRoot, sha256hex);
  if (!existsSync(file)) return null;
  return { file, sizeBytes: statSync(file).size };
}

/**
 * Materialize a stored artifact into a run workspace (OPS-372).
 *
 * Declared inputs only: the spec names hashes, the provider writes bytes,
 * and the agent reads a file. There is deliberately no way for an agent to
 * ask the store for something it did not declare — that would make the run's
 * inputHash a lie about what it actually read.
 *
 * Stored bytes are re-verified against the declared hash upon materialization;
 * corrupt entries fail loudly and are purged from the store (OPS-439).
 */
export function materializeArtifact({ storeRoot, sha256hex, workspaceDir, as }) {
  const found = findArtifact(storeRoot, sha256hex);
  if (!found) throw new Error(`artifact ${sha256hex} is not in the store`);
  const actualHash = hashFile(found.file);
  if (actualHash !== sha256hex) {
    rmSync(found.file, { force: true });
    throw new Error(`corrupt artifact ${sha256hex} in store (actual hash was ${actualHash}): removed corrupt entry`);
  }
  if (typeof as !== "string" || !as || path.isAbsolute(as)) {
    throw new Error(`artifact target "${as}" must be a relative filename`);
  }
  const root = path.resolve(workspaceDir);
  const dest = path.resolve(root, as);
  if (!dest.startsWith(root + path.sep)) throw new Error(`artifact target "${as}" escapes the workspace`);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  mkdirSync(path.dirname(dest), { recursive: true });
  const realDir = realpathSync(path.dirname(dest));
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`artifact target "${as}" escapes the workspace`);
  }
  if (existsSync(dest)) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink()) throw new Error(`artifact target "${as}" is a symlink`);
    const realDest = realpathSync(dest);
    if (!realDest.startsWith(realRoot + path.sep)) throw new Error(`artifact target "${as}" escapes the workspace`);
  }
  copyFileSync(found.file, dest);
  return { path: dest, sha256: sha256hex, sizeBytes: found.sizeBytes };
}

/** Every artifact hash any accepted result still points at. */
export function referencedHashes(db) {
  const hashes = new Set();
  for (const row of db.query(`SELECT result_json FROM results`).all()) {
    for (const entry of JSON.parse(row.result_json).artifacts ?? []) {
      if (entry.sha256) hashes.add(entry.sha256);
    }
  }
  return hashes;
}

/**
 * Catalogue every stored artifact and attach the accepted results that refer
 * to it. The store remains the source of truth for which bytes exist; stale
 * result references to missing files therefore do not produce phantom rows.
 */
export function listArtifacts(db, storeRoot, { orphan, kind, search, limit } = {}) {
  if (!existsSync(storeRoot)) return [];

  const references = new Map();
  const rows = db.query(
    `SELECT results.run_id, results.result_json, runs.spec_json, runs.state, runs.created_at
     FROM results
     LEFT JOIN runs ON runs.run_id = results.run_id`,
  ).all();
  for (const row of rows) {
    let agent = null;
    try {
      agent = row.spec_json ? JSON.parse(row.spec_json).agent ?? null : null;
    } catch {
      // A catalogue read should still expose the bytes if an old spec is bad.
    }
    for (const entry of JSON.parse(row.result_json).artifacts ?? []) {
      if (!HEX64.test(entry.sha256 ?? "")) continue;
      const refs = references.get(entry.sha256) ?? [];
      refs.push({
        runId: row.run_id,
        kind: entry.kind ?? null,
        agent,
        state: row.state ?? null,
        createdAt: row.created_at ?? null,
      });
      references.set(entry.sha256, refs);
    }
  }

  const term = typeof search === "string" ? search.toLowerCase() : null;
  const inventory = [];
  for (const sha256 of readdirSync(storeRoot).filter((name) => HEX64.test(name)).sort()) {
    const stat = statSync(path.join(storeRoot, sha256));
    if (!stat.isFile()) continue;
    const refs = references.get(sha256) ?? [];
    const referenced = refs.length > 0;
    if (orphan !== undefined && orphan === referenced) continue;
    if (kind !== undefined && !refs.some((ref) => ref.kind === kind)) continue;
    if (term && ![sha256, ...refs.flatMap((ref) => [ref.runId, ref.kind, ref.agent, ref.state])]
      .some((value) => String(value ?? "").toLowerCase().includes(term))) continue;
    inventory.push({
      sha256,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      referenced,
      references: refs,
    });
    if (limit !== undefined && inventory.length >= limit) break;
  }
  return inventory;
}

/**
 * Store inventory: total bytes, and the orphans — files no accepted result
 * references. Orphans are normal (a failed attempt stores nothing, but a
 * superseded one can leave bytes behind); they are only a problem unattended.
 */
export function storeStats(db, storeRoot, { now = Date.now() } = {}) {
  if (!existsSync(storeRoot)) return { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 };
  const referenced = referencedHashes(db);
  let files = 0;
  let bytes = 0;
  let orphans = 0;
  let orphanBytes = 0;
  for (const name of readdirSync(storeRoot)) {
    if (!HEX64.test(name)) continue;
    const size = statSync(path.join(storeRoot, name)).size;
    files += 1;
    bytes += size;
    if (!referenced.has(name)) {
      orphans += 1;
      orphanBytes += size;
    }
  }
  return { files, bytes, orphans, orphanBytes, at: new Date(now).toISOString() };
}

/**
 * Delete unreferenced artifacts older than `olderThanMs`. Referenced bytes are
 * never touched: a receipt that points at a deleted file is worse than a full
 * disk, because it turns the audit trail into a lie.
 */
export function pruneArtifacts(
  db,
  storeRoot,
  { olderThanMs = 7 * 24 * 60 * 60 * 1000, now = Date.now(), dryRun = false } = {},
) {
  if (!existsSync(storeRoot)) return { deleted: 0, freedBytes: 0, remainingOrphans: 0 };
  const referenced = referencedHashes(db);
  let deleted = 0;
  let freedBytes = 0;
  let remainingOrphans = 0;
  for (const name of readdirSync(storeRoot)) {
    if (!HEX64.test(name) || referenced.has(name)) continue;
    const file = path.join(storeRoot, name);
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs < olderThanMs) {
      remainingOrphans += 1;
      continue;
    }
    freedBytes += stat.size;
    deleted += 1;
    if (dryRun) {
      remainingOrphans += 1;
    } else {
      rmSync(file, { force: true });
    }
  }
  return { deleted, freedBytes, remainingOrphans };
}

/**
 * Resolve a prior run's stored artifact of a given kind (OPS-373).
 *
 * The cross-run case: a postmortem consumes a transcript produced by a run it
 * has no chain relationship with. Resolved at PLAN time so the hash lands in
 * the spec input, the inputHash, and the receipt — the operator approves a run
 * pinned to specific bytes, not "whatever that run's transcript happens to be
 * by the time it executes".
 */
export function pinRunArtifact(db, runId, { kind = "transcript" } = {}) {
  const run = db.query(`SELECT run_id, state, spec_json FROM runs WHERE run_id = ?`).get(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const row = db
    .query(`SELECT result_json FROM results WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`)
    .get(runId);
  if (!row) throw new Error(`run ${runId} has no accepted result — nothing was captured`);
  const entry = (JSON.parse(row.result_json).artifacts ?? []).find((a) => a.kind === kind);
  if (!entry?.sha256) throw new Error(`run ${runId} stored no "${kind}" artifact`);
  return {
    runId,
    transcript: entry.sha256,
    state: run.state,
    agent: JSON.parse(run.spec_json).agent,
  };
}
