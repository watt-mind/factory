import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-tick-test-mjs";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PRUNE_INTERVAL_MS, TICK_SUBSYSTEMS, tick } from "../cli.mjs";
import { sha256Hex } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const tmp = (p) => tmpDir(p);

function harness() {
  const dir = tmp("evrt-tick-");
  const db = openDb(path.join(dir, "runtime.db"));
  const storeRoot = path.join(dir, "artifacts");
  mkdirSync(storeRoot, { recursive: true });
  return { db, storeRoot };
}

function storeFile(storeRoot, bytes) {
  const hash = sha256Hex(Buffer.from(bytes));
  const file = path.join(storeRoot, hash);
  writeFileSync(file, bytes);
  return { hash, file };
}

describe("tick (OPS-412)", () => {
  test("pruneArtifacts runs when the clock is past the prune window and deletes aged orphans", async () => {
    const { db, storeRoot } = harness();
    const orphan = storeFile(storeRoot, "orphan bytes");
    const kept = storeFile(storeRoot, "kept bytes");
    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:x', '{}', '{}', ?)`,
    ).run(
      "run_kept",
      JSON.stringify({
        artifacts: [{ kind: "ci-log", sha256: kept.hash, uri: "file:///x" }],
      }),
      new Date().toISOString(),
    );

    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(orphan.file, old, old);
    utimesSync(kept.file, old, old);

    const now = Date.now();
    const logs = [];
    const result = await tick({
      db,
      registry,
      now,
      lastPrune: now - PRUNE_INTERVAL_MS - 1,
      storeRoot,
      policyVersion: "git:test",
      log: (line) => logs.push(line),
    });

    expect(existsSync(orphan.file)).toBe(false);
    expect(existsSync(kept.file)).toBe(true);
    expect(result.lastPrune).toBe(now);
    expect(logs.some((l) => l.startsWith("artifacts: pruned 1 orphan"))).toBe(
      true,
    );
  });

  test("a thrown exception in the GC subsystem still advances result.lastPrune to now (OPS-468)", async () => {
    const { db, storeRoot } = harness();
    const now = Date.now();
    const initialPrune = now - PRUNE_INTERVAL_MS - 1;
    const logs = [];

    // Create a file at storeRoot/invalid so readdirSync fails with ENOTDIR or provide invalid storeRoot
    const invalidStoreRoot = path.join(storeRoot, "not_a_directory");
    writeFileSync(invalidStoreRoot, "not a directory");

    const result = await tick({
      db,
      registry,
      now,
      lastPrune: initialPrune,
      storeRoot: invalidStoreRoot,
      policyVersion: "git:test",
      log: (line) => logs.push(line),
    });

    expect(result.lastPrune).toBe(now);
    expect(logs.some((l) => l.startsWith("tick GC:"))).toBe(true);

    // On next 1s tick, GC interval is not elapsed, so pruneArtifacts is not retried
    const nextLogs = [];
    const nextTickResult = await tick({
      db,
      registry,
      now: now + 1000,
      lastPrune: result.lastPrune,
      storeRoot: invalidStoreRoot,
      policyVersion: "git:test",
      log: (line) => nextLogs.push(line),
    });

    expect(nextLogs.some((l) => l.startsWith("tick GC:"))).toBe(false);
    expect(nextTickResult.lastPrune).toBe(now);
  });

  for (const failing of TICK_SUBSYSTEMS) {
    test(`a throw in ${failing} does not prevent the others from running`, async () => {
      const { db } = harness();
      const ran = [];
      const logs = [];
      const subsystems = Object.fromEntries(
        TICK_SUBSYSTEMS.map((name) => [
          name,
          () => {
            ran.push(name);
            if (name === failing) throw new Error(`${name} boom`);
          },
        ]),
      );

      await tick({
        db,
        registry,
        now: Date.now(),
        lastPrune: Date.now(),
        policyVersion: "git:test",
        log: (line) => logs.push(line),
        subsystems,
      });

      expect(ran).toEqual(TICK_SUBSYSTEMS);
      expect(logs).toContain(`tick ${failing}: ${failing} boom`);
      for (const name of TICK_SUBSYSTEMS) {
        if (name === failing) continue;
        expect(logs.some((l) => l.startsWith(`tick ${name}:`))).toBe(false);
      }
    });
  }
});
