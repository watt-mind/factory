import { describe, expect, test } from "bun:test";
import { DETACHED_SPAWN_OPTIONS, killProcessGroup } from "./child-process.mjs";

describe("child process helpers", () => {
  test("keeps spawned children in their own process group", () => {
    expect(DETACHED_SPAWN_OPTIONS).toEqual({ detached: true });
  });

  test("signals the process group when it exists", () => {
    const groupSignals = [];
    const childSignals = [];
    const child = {
      pid: 42,
      kill: (signal) => childSignals.push(signal),
    };

    killProcessGroup(child, {
      signal: "SIGTERM",
      kill: (pid, signal) => groupSignals.push([pid, signal]),
    });

    expect(groupSignals).toEqual([[-42, "SIGTERM"]]);
    expect(childSignals).toEqual([]);
  });

  test("falls back to the direct child when the group is already gone", () => {
    const childSignals = [];
    const child = {
      pid: 42,
      kill: (signal) => childSignals.push(signal),
    };

    killProcessGroup(child, {
      kill: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });

    expect(childSignals).toEqual(["SIGTERM"]);
  });

  test("escalates to SIGKILL after the configured grace period", () => {
    const signals = [];
    const timers = [];
    const child = { pid: 42, kill: () => {} };

    killProcessGroup(child, {
      killGraceMs: 25,
      kill: (pid, signal) => signals.push([pid, signal]),
      setTimeoutFn: (callback, delay) => {
        timers.push({ callback, delay });
        return { unref: () => {} };
      },
    });

    expect(signals).toEqual([[-42, "SIGTERM"]]);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(25);
    timers[0].callback();
    expect(signals).toEqual([
      [-42, "SIGTERM"],
      [-42, "SIGKILL"],
    ]);
  });

  test("does not arm duplicate termination sequences", () => {
    const signals = [];
    const timers = [];
    const child = { pid: 42, kill: () => {} };
    const options = {
      killGraceMs: 25,
      kill: (pid, signal) => signals.push([pid, signal]),
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return { unref: () => {} };
      },
    };

    killProcessGroup(child, options);
    killProcessGroup(child, options);

    expect(signals).toEqual([[-42, "SIGTERM"]]);
    expect(timers).toHaveLength(1);
  });
});
