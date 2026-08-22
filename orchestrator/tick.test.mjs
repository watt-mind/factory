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

// ------------------------------------------- control-plane selection (#880) ---
// The dispatcher read its queue from the repo's control plane and then claimed
// on the WORKSPACE DEFAULT, because the --apply block created a second, bare
// `loadControlPlane()`. After the WM-1006 cutover that meant reading GitHub and
// claiming against Linear with a GitHub identifier:
//   Entity not found: Issue — Could not find referenced Issue.
// It failed safe, but no ticket on a non-default plane could ever dispatch.
describe("tick resolves its control plane from the repo (#880)", () => {
  const SRC = readFileSync(new URL("./tick.mjs", import.meta.url), "utf8");

  test("there is no bare loadControlPlane() call", () => {
    // A bare call silently resolves to the workspace default. Two handles in
    // one file is the defect; one handle, built from the repo, is the fix.
    const calls = SRC.split("\n").filter(
      (l) =>
        /loadControlPlane\(\s*\)/.test(l) &&
        !l.trim().startsWith("*") &&
        !l.trim().startsWith("//"),
    );
    expect(calls).toEqual([]);
  });

  test("every loadControlPlane call passes repoName", () => {
    const calls = [...SRC.matchAll(/loadControlPlane\(\{([^}]*)\}/g)].map(
      (m) => m[1],
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toContain("repoName");
  });

  test("the apply path issues no tracker-native GraphQL", () => {
    // viewer / team.states / issueLabels / issueUpdate are Linear-shaped and
    // unanswerable by any other adapter. unclaim() is the rollback that stops a
    // dead run holding a cap slot, so it has to work on every plane.
    for (const shape of [
      "issueLabels(",
      "issueUpdate(",
      "team(id:",
      "query{ viewer{",
    ]) {
      expect(SRC).not.toContain(shape);
    }
  });
});
