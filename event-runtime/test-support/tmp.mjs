import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Bun caches modules across test files, but afterAll is file-scoped. Tests use
// a stable `?file=...` import query so each file gets its own tracker and hook;
// otherwise the first file's hook can remove another file's top-level fixture.
const tracked = new Set();

function removeTmpDir(dir) {
  tracked.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/** Track a temp directory created by a legacy test fixture. */
export function trackTmpDir(dir) {
  tracked.add(dir);
  return dir;
}

export function cleanupTmpDirs() {
  for (const dir of [...tracked].reverse()) removeTmpDir(dir);
}

/** Create a tracked temporary directory beneath the system temp directory. */
export function tmpDir(prefix, baseDir = os.tmpdir()) {
  const dir = mkdtempSync(path.join(baseDir, prefix));
  return trackTmpDir(dir);
}

/** Run a callback with a temporary directory and remove it when it settles. */
export function withTmpDir(prefix, fn) {
  const dir = tmpDir(prefix);
  let result;
  try {
    result = fn(dir);
  } catch (error) {
    removeTmpDir(dir);
    throw error;
  }

  if (result && typeof result.then === "function") {
    return Promise.resolve(result).finally(() => removeTmpDir(dir));
  }

  removeTmpDir(dir);
  return result;
}

afterAll(cleanupTmpDirs);
