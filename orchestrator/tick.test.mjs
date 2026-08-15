import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireClaimLock } from "./tick.mjs";

const NOW = 1_750_000_000_000;

function withLock(content, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-tick-lock-"));
  const lock = path.join(dir, "repo.dispatch.lock");
  writeFileSync(lock, content);
  try {
    return run(lock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("acquireClaimLock", () => {
  test.each([
    ["empty", ""],
    ["corrupted", "not a lock"],
    ["non-numeric PID", `abc ${NOW}`],
    ["zero PID", `0 ${NOW}`],
    ["negative PID", `-10 ${NOW}`],
    ["fractional PID", `1.5 ${NOW}`],
    ["non-finite timestamp", "123 Infinity"],
  ])("replaces a %s lock without probing its PID", (_name, content) => {
    withLock(content, (lock) => {
      const probed = [];
      const acquired = acquireClaimLock(lock, {
        currentPid: 43210,
        now: () => NOW,
        isProcessAlive: (pid) => {
          probed.push(pid);
          return true;
        },
      });

      expect(acquired).toBe(true);
      expect(probed).toEqual([]);
      expect(readFileSync(lock, "utf8")).toBe(`43210 ${NOW}\n`);
    });
  });

  test("preserves a recent lock held by a live positive integer PID", () => {
    withLock(`123 ${NOW}\n`, (lock) => {
      const probed = [];
      const acquired = acquireClaimLock(lock, {
        currentPid: 43210,
        now: () => NOW + 1_000,
        isProcessAlive: (pid) => {
          probed.push(pid);
          return true;
        },
      });

      expect(acquired).toBe(false);
      expect(probed).toEqual([123]);
      expect(readFileSync(lock, "utf8")).toBe(`123 ${NOW}\n`);
    });
  });
});
