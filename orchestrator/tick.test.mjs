import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireClaimLock, observeChildTermination } from "./tick.mjs";

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

describe("observeChildTermination", () => {
  test("handles an asynchronous spawn error and settles only once", async () => {
    const child = new EventEmitter();
    const spawnError = Object.assign(new Error("spawn agent ENOENT"), {
      code: "ENOENT",
    });
    const outcomes = [];

    observeChildTermination(child, async (outcome) => {
      outcomes.push(outcome);
    });

    expect(() => child.emit("error", spawnError)).not.toThrow();
    await Promise.resolve();
    child.emit("close", -2);
    await Promise.resolve();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({ error: spawnError, code: null });
  });

  test("handles a real failed spawn without an uncaught exception", async () => {
    const child = spawn("/definitely-not-a-factory-agent-binary", []);
    const outcome = await new Promise((resolve) => {
      observeChildTermination(child, resolve);
    });

    expect(outcome.code).toBeNull();
    expect(outcome.error?.code).toBe("ENOENT");
  });

  test("settles normal child closure without an error", async () => {
    const child = new EventEmitter();
    const outcomes = [];

    observeChildTermination(child, async (outcome) => {
      outcomes.push(outcome);
    });

    child.emit("close", 0);
    await Promise.resolve();

    expect(outcomes).toEqual([{ error: null, code: 0 }]);
  });
});

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
