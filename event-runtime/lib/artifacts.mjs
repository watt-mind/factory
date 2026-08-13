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
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEX64 = /^[0-9a-f]{64}$/;

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
 */
export function storeCollected({ entries, storeRoot }) {
  if (!entries?.length) return entries ?? [];
  mkdirSync(storeRoot, { recursive: true });
  return entries.map((entry) => {
    const dest = artifactPath(storeRoot, entry.sha256);
    if (!existsSync(dest)) copyFileSync(fileURLToPath(entry.uri), dest);
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
 */
export function materializeArtifact({ storeRoot, sha256hex, workspaceDir, as }) {
  const found = findArtifact(storeRoot, sha256hex);
  if (!found) throw new Error(`artifact ${sha256hex} is not in the store`);
  if (typeof as !== "string" || !as || path.isAbsolute(as)) {
    throw new Error(`artifact target "${as}" must be a relative filename`);
  }
  const root = path.resolve(workspaceDir);
  const dest = path.resolve(root, as);
  if (!dest.startsWith(root + path.sep)) throw new Error(`artifact target "${as}" escapes the workspace`);
  mkdirSync(path.dirname(dest), { recursive: true });
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
export function pruneArtifacts(db, storeRoot, { olderThanMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  if (!existsSync(storeRoot)) return { deleted: 0, freedBytes: 0 };
  const referenced = referencedHashes(db);
  let deleted = 0;
  let freedBytes = 0;
  for (const name of readdirSync(storeRoot)) {
    if (!HEX64.test(name) || referenced.has(name)) continue;
    const file = path.join(storeRoot, name);
    const stat = statSync(file);
    if (now - stat.mtimeMs < olderThanMs) continue;
    freedBytes += stat.size;
    rmSync(file, { force: true });
    deleted += 1;
  }
  return { deleted, freedBytes };
}
